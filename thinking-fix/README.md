# opencode-reasoning-stripper

An [opencode](https://opencode.ai) plugin that strips past reasoning blocks
(and inline `<think>` tags in assistant text) from the prompt to maximize
LLM prompt-cache hit rate. Optionally runs in a "baker-optimized" mode that
also collapses duplicate tool results across a session for parallel
orchestration workloads.

## What it does

- Removes reasoning parts from every assistant message **except the most
  recent one** (whose reasoning is preserved so the model can continue the
  chain-of-thought it is currently in).
- Strips inline `<think>…</think>` tags from streamed assistant text at
  text-end.
- In `bakerOptimized` mode, additionally collapses repeated tool outputs
  to stubs (`"[dup of turn N] X chars"`) and elides tool outputs over
  8 KiB, so long parallel-agent sessions stay cache-friendly.

This is a Reasonix-style prompt-cache-maximization plugin. Cache hits on
the prefix above the most recent assistant turn are the whole point.

## Config schema

```jsonc
{
  // optional. Either drop this key entirely (defaults apply), or put it at
  // top-level / under `plugin` / under `provider["opencode-reasoning-stripper"].options`
  "opencode-reasoning-stripper": {
    "mode": "keep-signature",         // "keep-signature" | "full-strip"
    "providers": ["anthropic", "xai"], // whitelist; [] means all providers
    "logSavings": true,                // emit debug log + marker events
    "bakerOptimized": false            // enable baker profile tweaks
  }
}
```

| Field           | Default            | Notes |
|-----------------|--------------------|-------|
| `mode`          | `"keep-signature"` | `"keep-signature"` keeps reasoning with metadata (Anthropic-style signatures); `"full-strip"` drops all reasoning text from non-last turns. |
| `providers`     | `[]` (all)         | Provider ID whitelist; messages whose `providerID` is not in this list are left alone. |
| `logSavings`    | `false`            | Also gates the debug marker file at `/tmp/opencode-stripper-events.jsonl`. Leave off in production. |
| `bakerOptimized`| `false`            | Enables `applyBakerToolTweaks`: dedupe + elision for parallel sessions. |

### Where the config can live

The plugin reads its options from any of (highest priority first):

1. Top-level `opencode-reasoning-stripper` key in your opencode config.
2. `plugin["opencode-reasoning-stripper"]` key.
3. `provider["opencode-reasoning-stripper"]` or
   `provider["opencode-reasoning-stripper"].options`.

## Provider behavior reference

Reasoning is delivered to this plugin in two distinct shapes, and which
mode is safe depends on which provider you are talking to. This plugin
strips both shapes uniformly once the whitelist / mode check passes.

| Provider group | Reasoning shape | Safe mode | Why |
|---|---|---|---|
| `anthropic`, `amazon-bedrock` | Signed reasoning parts (signatures are part of the API contract). | `keep-signature` | Stripping signatures breaks follow-up tool-use turns on the Anthropic API; kept-with-metadata is the only safe choice here. |
| `openai`, `azure`, `xai`, `groq`, `cerebras`, `deepseek`, `kimi`, `qwen`, `minimax*` | Structured reasoning parts *and/or* inline `<think>…</think>` blocks inside text parts. | `full-strip` (also fine: `keep-signature`) | These providers do not consume reasoning metadata, so dropping it never breaks the next turn. This plugin collapses both shapes into the same strip path. |
| `openrouter`, `gateway` | Routed. Whatever the upstream provider uses. | Treat as `openai-compatible`. | Both relay through an OpenAI-compatible API and drop signatures, so a full strip is safe. |

If your provider is not listed, default to `keep-signature` — it is the
plugin's default and only loses cache hits, never correctness.

## Streaming-flicker caveat

The text-end hook (`experimental.text.complete`) fires **after** streaming
completes. During streaming the TUI will briefly render raw
`<think>…</think>` tags; opencode then re-renders the part via
`updatePart` with the cleaned text. This is a cosmetic flicker only —
the model never sees the stripped text. There is no per-delta hook in
opencode 1.18.18, so incremental stripping is not possible.

## Build

Two build paths are supported:

```sh
# TypeScript declaration build (for `import { … } from "opencode-reasoning-stripper"` consumers)
npm run build        # tsc -p .  →  ./dist/

# Single-file bundled build (for direct dist loaders / Bun runtimes)
bun build ./src/index.ts --target=bun --format=esm --outfile=./dist-bundled/index.js
```

Run typecheck without emitting:

```sh
npm run typecheck
```

## Known limitations

- **No per-delta hook.** We can only clean at text-end. See the
  streaming-flicker caveat above.
- **`experimental.text.complete` is experimental** in opencode and its
  signature may change between releases.
- **`bakerOptimized` dedupe is whole-session**, not per-message. An
  identical tool output from message A and message Z will collide; this is
  intentional (it maximizes cache reuse) but worth knowing if you debug
  unexpected stubs.
