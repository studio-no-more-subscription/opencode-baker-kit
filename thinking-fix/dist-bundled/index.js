// @bun
// src/config.ts
var DEFAULTS = {
  mode: "keep-signature",
  providers: [],
  logSavings: false,
  bakerOptimized: false
};
function resolveConfig(input) {
  if (!input || typeof input !== "object")
    return DEFAULTS;
  const c = input;
  const mode = c.mode === "full-strip" ? "full-strip" : "keep-signature";
  const providers = Array.isArray(c.providers) ? c.providers.filter((p) => typeof p === "string") : [];
  const logSavings = Boolean(c.logSavings);
  const bakerOptimized = Boolean(c.bakerOptimized);
  return { mode, providers, logSavings, bakerOptimized };
}
function configFromOpencode(raw) {
  if (!raw || typeof raw !== "object")
    return;
  const obj = raw;
  if (obj["opencode-reasoning-stripper"] && typeof obj["opencode-reasoning-stripper"] === "object") {
    return obj["opencode-reasoning-stripper"];
  }
  if (obj.plugin && typeof obj.plugin === "object") {
    const p = obj.plugin;
    if (p["opencode-reasoning-stripper"] && typeof p["opencode-reasoning-stripper"] === "object") {
      return p["opencode-reasoning-stripper"];
    }
  }
  const provider = obj.provider;
  if (provider && typeof provider === "object") {
    const entry = provider["opencode-reasoning-stripper"];
    if (entry && typeof entry === "object") {
      const opts = entry.options;
      if (opts && typeof opts === "object")
        return opts;
      return entry;
    }
  }
  return;
}

// src/providers.ts
var SIGNATURE_AWARE_PROVIDERS = new Set([
  "anthropic",
  "amazon-bedrock",
  "google-vertex-anthropic"
]);
var FULLY_STRIP_SAFE_PROVIDERS = new Set([
  "deepseek",
  "minimax",
  "minimax-coding-plan",
  "minimax-cn",
  "minimax-cn-coding-plan",
  "openai",
  "azure",
  "xai",
  "groq",
  "cerebras"
]);
function normalize(id) {
  return id.toLowerCase().replace(/[^a-z0-9-]/g, "");
}
function isFullySafeProvider(providerID) {
  if (FULLY_STRIP_SAFE_PROVIDERS.has(providerID))
    return true;
  const norm = normalize(providerID);
  for (const safe of FULLY_STRIP_SAFE_PROVIDERS) {
    if (normalize(safe) === norm)
      return true;
  }
  return /^minimax(-coding-plan)?$/.test(norm);
}
function isWhitelisted(providerID, whitelist) {
  if (whitelist.length === 0)
    return true;
  return whitelist.includes(providerID);
}

// src/stripper.ts
function reasoningTextSize(parts) {
  let total = 0;
  for (const p of parts) {
    if (p.type === "reasoning")
      total += p.text?.length ?? 0;
  }
  return total;
}
var THINK_TAG_RE = /<think>([\s\S]*?)<\/think>/g;
function splitEmbeddedThink(text) {
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
    stripped: thinking.length > 0
  };
}
function lastAssistantIndex(msgs) {
  let idx = -1;
  for (let i = 0;i < msgs.length; i++) {
    if (msgs[i]?.info?.role === "assistant")
      idx = i;
  }
  return idx;
}
function stripReasoning(messages, cfg) {
  const lastIdx = lastAssistantIndex(messages);
  let saved = 0;
  let kept = 0;
  const out = [];
  for (let i = 0;i < messages.length; i++) {
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
var DEFAULT_BAKER_PROFILE = {
  maxAssistantKeep: 1,
  stripToolOutputIfOversize: 8192,
  collapseIdenticalToolResults: true
};
function bakerOptimizedStrip(messages, cfg, profile = DEFAULT_BAKER_PROFILE) {
  const base = stripReasoning(messages, cfg);
  if (!cfg.bakerOptimized)
    return base;
  const assistantIdxs = [];
  for (let i = 0;i < base.messages.length; i++) {
    if (base.messages[i]?.info?.role === "assistant")
      assistantIdxs.push(i);
  }
  if (assistantIdxs.length <= profile.maxAssistantKeep) {
    return { ...base, messages: applyBakerToolTweaks(base.messages, profile) };
  }
  const keepSet = new Set(assistantIdxs.slice(-profile.maxAssistantKeep));
  const collapsed = [];
  for (let i = 0;i < base.messages.length; i++) {
    const m = base.messages[i];
    if (m.info?.role === "assistant" && !keepSet.has(i)) {
      collapsed.push({
        ...m,
        parts: m.parts.filter((p) => p.type !== "reasoning")
      });
      continue;
    }
    collapsed.push(m);
  }
  return {
    messages: applyBakerToolTweaks(collapsed, profile),
    savedChars: base.savedChars,
    keptReasoningChars: base.keptReasoningChars
  };
}
function applyBakerToolTweaks(messages, profile) {
  if (!profile.collapseIdenticalToolResults && profile.stripToolOutputIfOversize <= 0) {
    return messages;
  }
  const seenResults = new Map;
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
        nextOutput = `${head}
\u2026[${output.length - 1536} chars elided]\u2026
${tail}`;
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

// src/index.ts
import * as fs from "fs";
var cached = null;
function touchMarker(label, cfg, fields) {
  if (!cfg?.logSavings)
    return;
  const file = "/tmp/opencode-stripper-events.jsonl";
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), label, ...fields }) + `
`;
    fs.appendFileSync(file, line);
  } catch {}
}
var ReasoningStripper = async ({ client, directory }) => {
  return {
    config: async (config) => {
      cached = resolveConfig(configFromOpencode(config));
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const cfg = cached ?? resolveConfig(undefined);
      if (!output || !Array.isArray(output.messages))
        return;
      touchMarker("transform-called", cfg, { count: output.messages.length });
      try {
        const before = output.messages.reduce((sum, m) => sum + (m.parts ?? []).reduce((s, p) => s + (p.type === "reasoning" ? p.text?.length ?? 0 : 0), 0), 0);
        const result = bakerOptimizedStrip(output.messages, cfg);
        output.messages = result.messages;
        touchMarker("transform-applied", cfg, { chars: result.savedChars });
        if (cfg.logSavings && result.savedChars > 0) {
          await client.app.log({
            body: {
              service: "reasoning-stripper",
              level: "debug",
              message: `stripped ${result.savedChars} chars of reasoning (kept last ${result.keptReasoningChars})`,
              extra: {
                savedChars: result.savedChars,
                keptChars: result.keptReasoningChars,
                mode: cfg.mode,
                bakerOptimized: cfg.bakerOptimized,
                before,
                after: before - result.savedChars
              }
            }
          });
        }
      } catch (err) {
        await client.app.log({
          body: {
            service: "reasoning-stripper",
            level: "warn",
            message: `transform failed: ${err.message ?? String(err)}`
          }
        });
      }
    },
    "experimental.text.complete": async (_input, output) => {
      const cfg = cached ?? resolveConfig(undefined);
      const before = output?.text;
      if (typeof before !== "string" || before.indexOf("<think>") === -1)
        return;
      const split = splitEmbeddedThink(before);
      if (!split.stripped)
        return;
      output.text = split.text;
      touchMarker("text-complete-stripped", cfg, { chars: before.length - split.text.length, mode: cfg.mode });
    }
  };
};
var src_default = ReasoningStripper;
export {
  stripReasoning,
  src_default as default
};
