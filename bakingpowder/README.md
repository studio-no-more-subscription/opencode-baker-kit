# bakingpowder

Orchestrates **parallel file-writing** from a `graph.json` spec by spawning
baker-apprentice sub-sessions, one per file, with bounded per-worker prompts.

## Install

Requires [opencode](https://opencode.ai) v1.18+ and the
[`thinking-fix`](https://github.com/studio-no-more-subscription/opencode-baker-kit/tree/main/thinking-fix)
sibling plugin (optional — only needed if you want reasoning stripping).

```bash
# 1. Clone the kit
git clone https://github.com/studio-no-more-subscription/opencode-baker-kit.git
cd opencode-baker-kit

# 2. Symlink (or copy) the plugin + agents + command into your opencode config
mkdir -p ~/.config/opencode/{plugins,agents,commands}

ln -sfn "$(pwd)/bakingpowder/.opencode/plugins/baker.ts" \
         ~/.config/opencode/plugins/baker.ts
ln -sfn "$(pwd)/bakingpowder/.opencode/agents/baker.md" \
         ~/.config/opencode/agents/baker.md
ln -sfn "$(pwd)/bakingpowder/.opencode/agents/baker-apprentice.md" \
         ~/.config/opencode/agents/baker-apprentice.md
ln -sfn "$(pwd)/bakingpowder/.opencode/commands/bake.md" \
         ~/.config/opencode/commands/bake.md

# 3. (Optional) install the thinking-fix sibling plugin
cd thinking-fix
bun install
bun build ./src/index.ts --target=bun --format=esm \
        --outfile=./dist-bundled/index.js
ln -sfn "$(pwd)/dist-bundled/index.js" \
         ~/.config/opencode/plugins/stripper.ts

# 4. Restart opencode. The /bake command and baker agent should appear.
```

**Updating after a `git pull`**: just restart opencode. The plugin is loaded
as a `.ts` file (no build step) and the agents are markdown (no compile), so
symlinks pick up changes immediately. The only exception is `thinking-fix`,
which needs the bundle rebuild in step 3.

**Uninstall**:

```bash
rm ~/.config/opencode/plugins/baker.ts
rm ~/.config/opencode/agents/baker.md
rm ~/.config/opencode/agents/baker-apprentice.md
rm ~/.config/opencode/commands/bake.md
```

The kit stays on disk; only the symlinks are removed.

### Permissions

The `baker` primary agent needs `edit` permission for `.opencode/baker/*` so it
can write `graph.json` and `state.json`. The default `baker.md` declares:

```yaml
permission:
  edit:
    ".opencode/baker/*": allow
    "*": ask
```

Adjust to taste. The `baker-apprentice` agent is locked down (no bash, edit
only, no other agents).

## What it does

`bakingpowder` is an [opencode](https://opencode.ai) plugin. The primary
**baker** agent loads a `graph.json` once into its context, then calls
`baker_dispatch`. The plugin:

1. Validates the graph and builds a DAG (grouped by file).
2. Runs Kahn's algorithm to partition files into **waves** — all files in
   one wave can execute in parallel.
3. Spawns up to `concurrency` child sessions per wave, each using the
   `baker-apprentice` agent and forked from the baker (parent) session so
   they share the prompt-cache prefix.
4. Each apprentice receives a minimal prompt — file path, node spec, and
   a dump of *direct* upstream interfaces — and is allowed exactly one
   `write` call before being terminated by the single-write hook.

If `baker_dispatch` is interrupted (Ctrl-C, network drop, server restart),
re-running it on the same graph **resumes** from `state.json` and skips
files already marked `done`.

## Tools provided

| Tool             | Purpose                                                              |
| ---------------- | -------------------------------------------------------------------- |
| `baker_dispatch` | Run the full wave-based parallel bake. Optional `resume: true`.      |
| `baker_plan`     | Validate a `graph.json` and print the wave plan without dispatching. |
| `baker_status`   | Print the current `state.json` snapshot (per-file status).           |
| `baker_resume`   | Re-read `state.json` and group files into done/pending/running/error. Useful as a standalone query after an interrupted dispatch. |

State lives at `<project>/.opencode/baker/state.json`.

## Graph schema

Minimum graphify-compatible schema — `nodes` + `edges`, with
`file` / `class` / `function` / `interface` node types and
`imports` / `contains` edges. Only `file`/`module` nodes and `imports`
edges participate in wave computation; everything else is opaque.

```ts
{
  nodes: Array<{
    id: string              // unique, e.g. "src/foo.ts::Bar"
    type: string            // "file" | "module" | "class" | "function" | "interface" | ...
    label: string
    file: string            // relative path from project root
    signature?: string      // optional export signature for the apprentice prompt
    props?: Record<string, any>
  }>,
  edges: Array<{
    source: string          // node id
    target: string          // node id
    type: string            // "imports" | "contains" | ...
    confidence?: string
  }>
}
```

## Sample `graph.json`

Three nodes: `types.ts` (no deps), `a.ts` + `b.ts` (both import from
`types.ts`, run in parallel), and `c.ts` (depends on `a.ts` + `b.ts`).

```json
{
  "nodes": [
    { "id": "src/types.ts",     "type": "file",      "label": "types.ts", "file": "src/types.ts" },
    { "id": "src/types.ts::User", "type": "interface","label": "User",   "file": "src/types.ts", "signature": "export interface User { id: string; name: string }" },

    { "id": "src/a.ts",         "type": "file",      "label": "a.ts",   "file": "src/a.ts" },
    { "id": "src/a.ts::A",      "type": "class",     "label": "A",      "file": "src/a.ts", "signature": "export class A { constructor(u: User); greet(): string }" },

    { "id": "src/b.ts",         "type": "file",      "label": "b.ts",   "file": "src/b.ts" },
    { "id": "src/b.ts::B",      "type": "class",     "label": "B",      "file": "src/b.ts", "signature": "export class B { constructor(u: User); greet(): string }" },

    { "id": "src/c.ts",         "type": "file",      "label": "c.ts",   "file": "src/c.ts" },
    { "id": "src/c.ts::C",      "type": "function",  "label": "C",      "file": "src/c.ts", "signature": "export function C(a: A, b: B): string" }
  ],
  "edges": [
    { "source": "src/a.ts::A",  "target": "src/types.ts::User", "type": "imports" },
    { "source": "src/b.ts::B",  "target": "src/types.ts::User", "type": "imports" },
    { "source": "src/c.ts::C",  "target": "src/a.ts::A",        "type": "imports" },
    { "source": "src/c.ts::C",  "target": "src/b.ts::B",        "type": "imports" }
  ]
}
```

This graph produces three waves:

```
wave 0 (1): src/types.ts
wave 1 (2): src/a.ts, src/b.ts
wave 2 (1): src/c.ts
```

## Wave semantics

- **Algorithm**: Kahn's topological sort, grouped by `file`.
- **Granularity**: waves contain *files*, not nodes — every node in
  `src/foo.ts` shares one apprentice session.
- **Parallelism**: all files in a wave run in parallel, bounded by the
  `concurrency` argument (default 4).
- **Dependency**: file X depends on file Y if any node in X has an
  `imports` edge to any node in Y. Self-imports are ignored.
- **Cycles**: detected and rejected with the offending file list.

## Resume semantics

`baker_dispatch` defaults to `resume: true`. On start:

1. Load `state.json`.
2. If it exists, has no `finished_at`, and matches the current graph's
   wave structure, treat it as a resume.
3. Reset every file that is **not** `done` back to `pending` and clear
   its error.
4. Re-dispatch only the non-`done` files. `done` files are skipped
   entirely — their wave is still walked but each file short-circuits
   inside `dispatchOne`.

A *finished* dispatch (`finished_at` set) is **never** overwritten by a
new `baker_dispatch` call against the same `state.json`. Pass
`resume: false` to force a fresh state.

## Caveats

- **Single-write guard**: the `tool.execute.before` hook counts `write`
  and `edit` calls per session and rejects any call after the first.
  (`apply_patch` is not a real tool id in opencode v1.18.18, so it is
  not in the matcher.)
- **Prompt-cache reuse**: every apprentice in a wave is forked from the
  same baker parent session, so the system prompt prefix is identical.
  The worker prompt suffix is intentionally minimal — file path, node
  spec, and upstream dump.
- **Upstream dump bounded to direct deps**: each worker receives only
  the interface dump of the files it *directly* imports
  (`directDeps(file, graph)`), not the cumulative past. This keeps
  per-worker token cost O(direct-imports) instead of O(waves so far ×
  files per wave). This is a graph-walk fallback — a hard cap of N
  lines per dump was considered but the direct-deps approach is both
  cheaper and more correct.
- **Concurrency model**: all workers in a wave are spawned with
  `Promise.all`; one slow worker blocks wave completion. Tune
  `concurrency` accordingly.