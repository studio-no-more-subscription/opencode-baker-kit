import { isFullySafeProvider, isWhitelisted } from "./providers";
function reasoningTextSize(parts) {
    let total = 0;
    for (const p of parts) {
        if (p.type === "reasoning")
            total += p.text?.length ?? 0;
    }
    return total;
}
const THINK_TAG_RE = /<think>([\s\S]*?)<\/think>/g;
export function splitEmbeddedThink(text) {
    if (!text || text.indexOf("<think>") === -1) {
        return { text, thinking: "", stripped: false };
    }
    let thinking = "";
    const stripped = text.replace(THINK_TAG_RE, (_match, inner) => {
        thinking += inner;
        return "";
    });
    return {
        text: stripped.replace(/^\s+/, "").replace(/\s+$/, ""),
        thinking: thinking.trim(),
        stripped: thinking.length > 0,
    };
}
export function stripEmbeddedThink(text) {
    return splitEmbeddedThink(text).text;
}
function lastAssistantIndex(msgs) {
    let idx = -1;
    for (let i = 0; i < msgs.length; i++) {
        if (msgs[i]?.info?.role === "assistant")
            idx = i;
    }
    return idx;
}
export function stripReasoning(messages, cfg) {
    const lastIdx = lastAssistantIndex(messages);
    let saved = 0;
    let kept = 0;
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (m.info?.role !== "assistant") {
            out.push(m);
            continue;
        }
        if (i === lastIdx) {
            let keepTotal = 0;
            for (const p of m.parts)
                if (p.type === "reasoning")
                    keepTotal += p.text?.length ?? 0;
            out.push(m);
            kept += keepTotal;
            continue;
        }
        const providerID = m.info.providerID;
        const apiNpm = m.info.apiNpm;
        const scopeOk = providerID ? isWhitelisted(providerID, cfg.providers) : true;
        if (!scopeOk) {
            out.push(m);
            continue;
        }
        const fullySafe = providerID ? isFullySafeProvider(providerID) : false;
        const effectiveMode = cfg.mode === "full-strip" || fullySafe ? "full-strip" : cfg.mode;
        saved += reasoningTextSize(m.parts);
        const filtered = m.parts.filter((p) => {
            if (p.type !== "reasoning")
                return true;
            if (effectiveMode === "full-strip")
                return false;
            if (!p.metadata || Object.keys(p.metadata).length === 0)
                return false;
            return true;
        });
        out.push({ ...m, parts: filtered });
    }
    return { messages: out, savedChars: saved, keptReasoningChars: kept };
}
export const DEFAULT_BAKER_PROFILE = {
    maxAssistantKeep: 1,
    stripToolOutputIfOversize: 8192,
    collapseIdenticalToolResults: true,
};
export function bakerOptimizedStrip(messages, cfg, profile = DEFAULT_BAKER_PROFILE) {
    const base = stripReasoning(messages, cfg);
    if (!cfg.bakerOptimized)
        return base;
    const assistantIdxs = [];
    for (let i = 0; i < base.messages.length; i++) {
        if (base.messages[i]?.info?.role === "assistant")
            assistantIdxs.push(i);
    }
    if (assistantIdxs.length <= profile.maxAssistantKeep) {
        return { ...base, messages: applyBakerToolTweaks(base.messages, profile) };
    }
    const keepSet = new Set(assistantIdxs.slice(-profile.maxAssistantKeep));
    const collapsed = [];
    for (let i = 0; i < base.messages.length; i++) {
        const m = base.messages[i];
        if (m.info?.role === "assistant" && !keepSet.has(i)) {
            collapsed.push({
                ...m,
                parts: m.parts.filter((p) => p.type !== "reasoning"),
            });
            continue;
        }
        collapsed.push(m);
    }
    return {
        messages: applyBakerToolTweaks(collapsed, profile),
        savedChars: base.savedChars,
        keptReasoningChars: base.keptReasoningChars,
    };
}
function applyBakerToolTweaks(messages, profile) {
    if (!profile.collapseIdenticalToolResults && profile.stripToolOutputIfOversize <= 0) {
        return messages;
    }
    const seenResults = new Map();
    return messages.map((m) => {
        if (!m.parts?.length)
            return m;
        let mutated = false;
        const newParts = m.parts.map((p) => {
            if (p.type !== "tool" && p.type !== "toolResult")
                return p;
            const anyP = p;
            const output = anyP.output ?? anyP.result ?? anyP.content;
            if (typeof output !== "string")
                return p;
            let nextOutput = output;
            if (profile.stripToolOutputIfOversize > 0 && output.length > profile.stripToolOutputIfOversize) {
                const head = output.slice(0, 1024);
                const tail = output.slice(-512);
                nextOutput = `${head}\n…[${output.length - 1536} chars elided]…\n${tail}`;
                mutated = true;
            }
            if (profile.collapseIdenticalToolResults) {
                const dup = seenResults.get(nextOutput);
                if (dup !== undefined) {
                    mutated = true;
                    return { ...anyP, output: `[dup of turn ${dup}] ${nextOutput.length} chars`, _collapsedFromDup: true };
                }
                seenResults.set(nextOutput, anyP.id ?? m.info?.id ?? "0");
            }
            if (nextOutput !== output) {
                mutated = true;
                return { ...anyP, output: nextOutput };
            }
            return p;
        });
        return mutated ? { ...m, parts: newParts } : m;
    });
}
