import type { Plugin } from "@opencode-ai/plugin"
import { configFromOpencode, resolveConfig, type ResolvedConfig } from "./config"
import { bakerOptimizedStrip, splitEmbeddedThink, stripReasoning } from "./stripper"
import * as fs from "node:fs"

let cached: ResolvedConfig | null = null

type MarkerFields = { chars?: number; count?: number; mode?: string }

function touchMarker(label: string, cfg: ResolvedConfig | null, fields?: MarkerFields) {
  if (!cfg?.logSavings) return
  const file = "/tmp/opencode-stripper-events.jsonl"
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), label, ...fields }) + "\n"
    fs.appendFileSync(file, line)
  } catch {}
}

const ReasoningStripper: Plugin = async ({ client, directory }) => {
  return {
    config: async (config) => {
      cached = resolveConfig(configFromOpencode(config))
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const cfg = cached ?? resolveConfig(undefined)
      if (!output || !Array.isArray(output.messages)) return
      touchMarker("transform-called", cfg, { count: output.messages.length })

      try {
        const before = output.messages.reduce(
          (sum, m) =>
            sum + (m.parts ?? []).reduce((s: number, p: any) => s + (p.type === "reasoning" ? (p.text?.length ?? 0) : 0), 0),
          0,
        )

        const result = bakerOptimizedStrip(output.messages as any, cfg)
        output.messages = result.messages as any
        touchMarker("transform-applied", cfg, { chars: result.savedChars })

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
          })
        }
      } catch (err) {
        await client.app.log({
          body: {
            service: "reasoning-stripper",
            level: "warn",
            message: `transform failed: ${(err as Error).message ?? String(err)}`,
          },
        })
      }
    },

    "experimental.text.complete": async (_input, output) => {
      // Streaming-flicker caveat: this hook fires at text-end, so the TUI briefly
      // shows raw <think>...</think> during streaming before opencode's
      // updatePart re-renders with the cleaned text. There is no per-delta hook
      // in opencode 1.18.18, so we cannot strip incrementally.
      const cfg = cached ?? resolveConfig(undefined)
      const before = output?.text
      if (typeof before !== "string" || before.indexOf("<think>") === -1) return
      const split = splitEmbeddedThink(before)
      if (!split.stripped) return
      output.text = split.text
      touchMarker("text-complete-stripped", cfg, { chars: before.length - split.text.length, mode: cfg.mode })
    },
  }
}

export default ReasoningStripper
export { stripReasoning }
