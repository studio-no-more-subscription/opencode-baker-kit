import { configFromOpencode, resolveConfig } from "./config";
import { bakerOptimizedStrip, splitEmbeddedThink, stripReasoning } from "./stripper";
import * as fs from "node:fs";
let cached = null;
function touchMarker(label, extra) {
    const file = "/tmp/opencode-stripper-events.jsonl";
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), label, ...extra }) + "\n";
        fs.appendFileSync(file, line);
    }
    catch { }
}
const ReasoningStripper = async ({ client, directory }) => {
    touchMarker("plugin-instantiated", { directory });
    return {
        config: async (config) => {
            const fromCfg = configFromOpencode(config);
            const fromPluginProvider = (() => {
                if (!config || typeof config !== "object")
                    return undefined;
                const provider = config.provider;
                if (!provider || typeof provider !== "object")
                    return undefined;
                const entry = provider["opencode-reasoning-stripper"];
                if (entry && typeof entry === "object") {
                    const opts = entry.options;
                    if (opts && typeof opts === "object")
                        return opts;
                    return entry;
                }
                return undefined;
            })();
            cached = resolveConfig(fromCfg ?? fromPluginProvider);
        },
        "experimental.chat.messages.transform": async (_input, output) => {
            const cfg = cached ?? resolveConfig(undefined);
            if (!output || !Array.isArray(output.messages))
                return;
            touchMarker("transform-called", { messages: output.messages.length });
            try {
                const before = output.messages.reduce((sum, m) => sum + (m.parts ?? []).reduce((s, p) => s + (p.type === "reasoning" ? (p.text?.length ?? 0) : 0), 0), 0);
                const result = bakerOptimizedStrip(output.messages, cfg);
                output.messages = result.messages;
                touchMarker("transform-applied", { savedChars: result.savedChars, keptChars: result.keptReasoningChars });
                if (cfg.logSavings)
                    touchMarker("log-savings", { savedChars: result.savedChars, mode: cfg.mode });
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
                                after: before - result.savedChars,
                            },
                        },
                    });
                }
            }
            catch (err) {
                await client.app
                    .log({
                    body: {
                        service: "reasoning-stripper",
                        level: "warn",
                        message: `transform failed: ${err.message ?? String(err)}`,
                    },
                })
                    .catch(() => { });
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
            touchMarker("text-complete-stripped", {
                beforeLen: before.length,
                afterLen: split.text.length,
                thinkingLen: split.thinking.length,
                mode: cfg.mode,
            });
        },
    };
};
export default ReasoningStripper;
export { stripReasoning };
