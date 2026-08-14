import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import * as fs from "fs/promises"
import * as path from "path"

// =============================================================================
// baker plugin — orchestrates parallel file-writing from a graph.json spec.
//
// Flow:
//   1. baker (primary) reads .opencode/baker/graph.json once into its context
//   2. baker calls baker_dispatch(graph_path)
//   3. Plugin validates graph, builds DAG → waves
//   4. For each wave: spawn up to `concurrency` child sessions (parent = baker)
//      Each child uses agent "baker-apprentice" with a minimal prompt
//      (file path, node spec, upstream interface dump). One write call, then done.
//   5. Provider cache hits: all apprentices share identical system prompt prefix.
// =============================================================================

// --- Graph schema (graphify-compatible minimum) ---
const GraphSchema = tool.schema.object({
  nodes: tool.schema.array(
    tool.schema.object({
      id: tool.schema.string(),
      type: tool.schema.string(),
      label: tool.schema.string(),
      file: tool.schema.string(),
      signature: tool.schema.string().optional(),
      props: tool.schema.any().optional(),
    }),
  ),
  edges: tool.schema.array(
    tool.schema.object({
      source: tool.schema.string(),
      target: tool.schema.string(),
      type: tool.schema.string(),
      confidence: tool.schema.string().optional(),
    }),
  ),
})

type Node = {
  id: string
  type: string
  label: string
  file: string
  signature?: string
  props?: Record<string, any>
}

type Edge = {
  source: string
  target: string
  type: string
  confidence?: string
}

type Graph = { nodes: Node[]; edges: Edge[] }

type FileStatus = "pending" | "running" | "done" | "error"

type DispatchState = {
  graph_path: string
  waves: string[][]
  files: Record<string, FileStatus>
  sessions: Record<string, string> // file → sessionID
  errors: Record<string, string>
  started_at: string
  finished_at?: string
  base_session_id?: string
  // Persisted copy of the graph so baker_graph_query works even after the
  // source graph.json has been edited or deleted, and so resume doesn't have
  // to re-read graph.json to know what to dispatch.
  graph?: Graph
}

// --- DAG → waves (Kahn's algorithm, grouped by file) ---
function buildWaves(graph: Graph): string[][] {
  const fileToNodes = new Map<string, Node[]>()
  for (const n of graph.nodes) {
    if (n.type !== "file" && n.type !== "module") continue
    if (!fileToNodes.has(n.file)) fileToNodes.set(n.file, [])
    fileToNodes.get(n.file)!.push(n)
  }
  const files = [...fileToNodes.keys()]
  if (files.length === 0) throw new Error("Graph has no file/module nodes")

  const nodeToFile = new Map<string, string>()
  for (const n of graph.nodes) nodeToFile.set(n.id, n.file)

  const deps = new Map<string, Set<string>>()
  for (const f of files) deps.set(f, new Set())
  for (const e of graph.edges) {
    if (e.type !== "imports") continue
    const src = nodeToFile.get(e.source)
    const tgt = nodeToFile.get(e.target)
    if (src && tgt && src !== tgt) deps.get(src)!.add(tgt)
  }

  const inDegree = new Map<string, number>()
  for (const f of files) inDegree.set(f, deps.get(f)!.size)

  const waves: string[][] = []
  let current = files.filter((f) => inDegree.get(f) === 0)
  const seen = new Set<string>()

  while (current.length > 0) {
    waves.push(current)
    for (const f of current) seen.add(f)
    const next: string[] = []
    for (const f of current) {
      for (const [other, otherDeps] of deps) {
        if (otherDeps.has(f)) {
          const d = inDegree.get(other)! - 1
          inDegree.set(other, d)
          if (d === 0 && !seen.has(other)) next.push(other)
        }
      }
    }
    current = next
  }

  if (seen.size !== files.length) {
    throw new Error(
      `Cycle detected: ${files.filter((f) => !seen.has(f)).join(", ")}`,
    )
  }

  return waves
}

// --- Direct-dependency lookup: which files does `file` directly import from? ---
// Returns the set of files that appear as targets of an `imports` edge from any
// node in `file`. Used to bound each worker's upstream dump to its actual
// surface area, instead of handing it the entire cumulative past (which by
// wave N grows O(N²) and bloats the per-worker prompt).
function directDeps(file: string, graph: Graph): string[] {
  const nodeToFile = new Map<string, string>()
  for (const n of graph.nodes) nodeToFile.set(n.id, n.file)
  const out = new Set<string>()
  for (const e of graph.edges) {
    if (e.type !== "imports") continue
    const srcFile = nodeToFile.get(e.source)
    if (srcFile !== file) continue
    const tgtFile = nodeToFile.get(e.target)
    if (tgtFile && tgtFile !== file) out.add(tgtFile)
  }
  return [...out]
}

// --- Extract tiny interface dump from upstream files (already written) ---
async function dumpUpstreamInterfaces(
  files: string[],
  projectDir: string,
): Promise<string> {
  const lines: string[] = []
  for (const f of files) {
    try {
      const content = await fs.readFile(path.join(projectDir, f), "utf-8")
      const sigs = content
        .split("\n")
        .filter((l) =>
          /^\s*(export\s+(default\s+)?(class|function|interface|type|const|let|var|enum|async)|export\s*\{)/.test(
            l,
          ),
        )
        .slice(0, 25)
        .map((l) => l.trim())
      lines.push(
        sigs.length > 0
          ? `// ${f}\n${sigs.join("\n")}`
          : `// ${f}\n// (no exports detected yet)`,
      )
    } catch {
      lines.push(`// ${f}\n// (not yet written — trust the graph signature)`)
    }
  }
  return lines.join("\n\n")
}

// --- Write a per-apprentice slice file (.opencode/baker/slices/<file>.json).
// Contains exactly what one apprentice needs: its node specs, the file list of
// direct upstream deps, and the interface dump (already extracted). This lets
// the apprentice prompt stay short and stable across iterations — only the
// slice file content changes when the spec changes, which keeps the prompt
// prefix cacheable while the spec stays out of it.
type SliceFile = {
  target: string
  nodes: Node[]
  direct_deps: string[]
  upstream_dump: string
  wave_siblings: string[]
  written_at: string
}

async function writeSlice(
  sliceDir: string,
  slice: SliceFile,
): Promise<string> {
  await fs.mkdir(sliceDir, { recursive: true })
  const safe = slice.target.replace(/[\\/]/g, "__")
  const slicePath = path.join(sliceDir, `${safe}.json`)
  await fs.writeFile(slicePath, JSON.stringify(slice, null, 2))
  return slicePath
}

// --- Verify a file actually contains the exports its slice promised. Cheap
// signature diff: parse the slice's expected signatures, check each is present
// as an `export ...` line in the written file. Returns a list of missing
// signatures. Empty list = verified.
async function verifySlice(
  slicePath: string,
  targetFile: string,
  projectDir: string,
): Promise<string[]> {
  let slice: SliceFile
  try {
    slice = JSON.parse(await fs.readFile(slicePath, "utf-8"))
  } catch {
    return ["(could not read slice)"]
  }
  const expected: string[] = []
  for (const n of slice.nodes) {
    if (n.signature) expected.push(n.signature)
  }
  if (expected.length === 0) return []

  let content: string
  try {
    content = await fs.readFile(path.join(projectDir, targetFile), "utf-8")
  } catch {
    return [`(target file missing: ${targetFile})`]
  }

  const missing: string[] = []
  for (const sig of expected) {
    // Normalize: signature may include leading "export " or not; either way we
    // just want the *body* to appear in the file. Strip "export " prefix and
    // surrounding whitespace for matching.
    const needle = sig.replace(/^\s*export\s+/, "").trim()
    if (needle.length === 0) continue
    // Match the body as a substring on a single line. Good enough for the
    // vast majority of class/function/interface signatures.
    if (!content.split("\n").some((line) => line.includes(needle))) {
      missing.push(sig)
    }
  }
  return missing
}

// --- Wait for a session to reach a terminal status ---
// Exponential backoff: 1.5s → 3s → 6s, then settle at 10s. Distinguishes
// "no status yet" (network/initialization) from "session in busy state"
// (keep polling) — both continue, but the cadence relaxes to bound load.
async function waitForTerminal(
  client: any,
  sessionID: string,
  timeoutMs = 600_000,
): Promise<{ status: "done" | "error" | "timeout"; error?: string }> {
  const start = Date.now()
  let poll = 0
  const nextDelay = () => {
    // 1.5s, 3s, 6s, 10s, 10s, ...
    if (poll === 0) return 1_500
    if (poll === 1) return 3_000
    if (poll === 2) return 6_000
    return 10_000
  }
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await client.session.status()
      const statuses = result?.data ?? result
      const s = statuses?.[sessionID]
      if (s?.type === "idle") return { status: "done" }
      if (s?.type === "error")
        return { status: "error", error: s.error?.message ?? "unknown" }
      // s?.type === "busy" or undefined → keep polling
    } catch {
      // polling error — keep trying
    }
    await new Promise((r) => setTimeout(r, nextDelay()))
    poll++
  }
  return { status: "timeout" }
}

// =============================================================================
// Plugin
// =============================================================================

export const BakerPlugin: Plugin = async ({ project, client, directory }) => {
  const STATE_DIR = path.join(directory, ".opencode/baker")
  const STATE_FILE = path.join(STATE_DIR, "state.json")

  // Tracks write/edit calls per session for the single-write guard. Hoisted
  // out of the returned object literal so it survives across hook invocations
  // for the lifetime of this plugin instance.
  const writeCounts = new Map<string, number>()

  const ensureStateDir = async () => {
    await fs.mkdir(STATE_DIR, { recursive: true })
  }

  const loadState = async (): Promise<DispatchState | null> => {
    try {
      const txt = await fs.readFile(STATE_FILE, "utf-8")
      return JSON.parse(txt)
    } catch {
      return null
    }
  }

  const saveState = async (s: DispatchState) => {
    await ensureStateDir()
    await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2))
  }

  return {
    // ---------------------------------------------------------------
    // Custom tools
    // ---------------------------------------------------------------
    tool: {
      baker_dispatch: tool({
        description:
          "Dispatch parallel baker-apprentice workers to write files from a graph.json. Spawns child sessions forked from the calling baker session (cache reuse). Waits for all waves to complete.",
        args: {
          graph_path: tool.schema
            .string()
            .describe(
              "Path to graph.json (relative to project root or absolute). Default: .opencode/baker/graph.json",
            ),
          concurrency: tool.schema
            .number()
            .default(4)
            .describe("Max parallel workers per wave (default 4)"),
          dry_run: tool.schema
            .boolean()
            .default(false)
            .describe("If true, only compute and print the wave plan"),
          resume: tool.schema
            .boolean()
            .default(true)
            .describe(
              "If true and an unfinished state.json exists, skip files already marked 'done' and re-dispatch pending/running/error files.",
            ),
        },
        async execute(args, ctx) {
          const graphRel = args.graph_path || ".opencode/baker/graph.json"
          const graphAbs = path.isAbsolute(graphRel)
            ? graphRel
            : path.join(directory, graphRel)

          // Load + validate graph
          let graph: Graph
          try {
            const txt = await fs.readFile(graphAbs, "utf-8")
            graph = GraphSchema.parse(JSON.parse(txt))
          } catch (err) {
            return `❌ Failed to load/validate graph: ${(err as Error).message}`
          }

          let waves: string[][]
          try {
            waves = buildWaves(graph)
          } catch (err) {
            return `❌ Failed to build waves: ${(err as Error).message}`
          }

          const totalFiles = waves.flat().length
          const summary = waves
            .map((w, i) => `  wave ${i} (${w.length} files): ${w.join(", ")}`)
            .join("\n")

          if (args.dry_run) {
            return `📋 Wave plan (${waves.length} waves, ${totalFiles} files):\n${summary}`
          }

          // --- Resume detection ---
          // If a state.json from a prior interrupted dispatch exists and has
          // no finished_at, treat the call as a resume: re-use its waves/files
          // skeleton and skip anything already marked "done". We never touch a
          // state.json that already has finished_at — that's a finished dispatch.
          const existing = args.resume ? await loadState() : null
          const isResumable =
            !!existing &&
            existing.graph_path === graphRel &&
            !existing.finished_at &&
            existing.waves.length === waves.length &&
            existing.waves.every(
              (w, i) =>
                w.length === waves[i].length &&
                w.every((f, j) => f === waves[i][j]),
            )

          let state: DispatchState
          let resumeSkipped = 0
          if (isResumable && existing) {
            state = existing
            // Reset non-done files so the dispatch loop picks them up again.
            for (const f of Object.keys(state.files)) {
              if (state.files[f] !== "done") {
                state.files[f] = "pending"
                delete state.errors[f]
              } else {
                resumeSkipped++
              }
            }
            // Keep the persisted graph fresh even on resume so subsequent
            // graph queries reflect what was actually dispatched.
            state.graph = graph
            await saveState(state)
          } else {
            state = {
              graph_path: graphRel,
              waves,
              files: {},
              sessions: {},
              errors: {},
              started_at: new Date().toISOString(),
              base_session_id: ctx.sessionID,
              graph,
            }
            for (const w of waves) for (const f of w) state.files[f] = "pending"
            await saveState(state)
          }

          // Index nodes by file
          const fileToNodes = new Map<string, Node[]>()
          for (const n of graph.nodes) {
            if (n.type !== "file" && n.type !== "module") continue
            if (!fileToNodes.has(n.file)) fileToNodes.set(n.file, [])
            fileToNodes.get(n.file)!.push(n)
          }

          const log = (msg: string) =>
            client.app.log({
              body: {
                service: "baker",
                level: "info",
                message: msg,
                extra: { sessionID: ctx.sessionID },
              },
            })

          await log(
            `🥖 Starting bake: ${totalFiles} files across ${waves.length} waves (concurrency=${args.concurrency}, resume=${isResumable}, skipped=${resumeSkipped})`,
          )

          // Process each wave
          for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
            const wave = waves[waveIdx]

            // Skip the entire wave if every file is already done (resume case).
            const todo = wave.filter((f) => state.files[f] !== "done")
            if (todo.length === 0) continue

            await log(`wave ${waveIdx}: ${todo.length} files (${wave.length - todo.length} already done)`)

            // Within a wave, dispatch in batches of `concurrency`
            for (let i = 0; i < todo.length; i += args.concurrency) {
              const batch = todo.slice(i, i + args.concurrency)

              const dispatchOne = async (file: string) => {
                // Re-entrancy guard: if another worker somehow already finished
                // this file between the snapshot above and now, skip.
                if (state.files[file] === "done") return

                state.files[file] = "running"
                await saveState(state)

                const nodes = fileToNodes.get(file) ?? []
                // Direct deps only — not the cumulative past. Keeps each
                // worker's upstream dump O(direct-imports) instead of O(waves
                // so far × files per wave).
                const upstreamFiles = directDeps(file, graph)
                const upstreamDump = await dumpUpstreamInterfaces(
                  upstreamFiles,
                  directory,
                )

                // Write per-apprentice slice file BEFORE sending the prompt so
                // the apprentice can `read` it instead of receiving the spec
                // inline. Prompt stays short; only the slice file changes
                // when the spec changes.
                const slicePath = await writeSlice(
                  path.join(STATE_DIR, "slices"),
                  {
                    target: file,
                    nodes,
                    direct_deps: upstreamFiles,
                    upstream_dump: upstreamDump,
                    wave_siblings: wave.filter((f) => f !== file),
                    written_at: new Date().toISOString(),
                  },
                )

                const prompt =
                  `Write file: ${file}\n\n` +
                  `Your spec is in: ${path.relative(directory, slicePath)}\n` +
                  `Read it once with the \`read\` tool. It contains your node spec, ` +
                  `direct upstream dependencies, and the upstream interface dump.\n\n` +
                  `Siblings in same wave (exports must compose):\n` +
                  (wave.length > 1
                    ? wave.filter((f) => f !== file).map((f) => `- ${f}`).join("\n")
                    : "(none)") +
                  `\n\nRules:\n` +
                  `- One \`write\` call for ${file}. Nothing else.\n` +
                  `- No bash. No edits to other files. No further reads beyond your slice.\n` +
                  `- After write succeeds, end your turn.\n`

                try {
                  // Create child session — parentID is the baker (base) session
                  const createRes = await client.session.create({
                    body: {
                      parentID: ctx.sessionID,
                      title: `baker-apprentice: ${file}`,
                    },
                  })
                  const childID = createRes?.data?.id ?? createRes?.id
                  if (!childID) throw new Error("no session id returned")
                  state.sessions[file] = childID
                  await saveState(state)

                  // Send prompt (awaits assistant response → write call → done)
                  await client.session
                    .prompt({
                      path: { id: childID },
                      body: {
                        agent: "baker-apprentice",
                        parts: [{ type: "text", text: prompt }],
                      },
                    })
                    .catch(async (err: Error) => {
                      throw err
                    })

                  // Confirm session is idle
                  const term = await waitForTerminal(client, childID)
                  if (term.status === "done") {
                    state.files[file] = "done"
                  } else {
                    state.files[file] = "error"
                    state.errors[file] = term.error ?? term.status
                  }
                } catch (err) {
                  state.files[file] = "error"
                  state.errors[file] = (err as Error).message
                }
                await saveState(state)
              }

              // Run batch in parallel
              await Promise.all(batch.map(dispatchOne))
            }
          }

          state.finished_at = new Date().toISOString()
          await saveState(state)

          // --- Post-dispatch signature verification ---
          // Walk every file marked "done" and check the actual written content
          // against the slice's expected signatures. Files where signatures
          // are missing are downgraded to "error" with the missing sigs listed,
          // so the next dispatch can retry just those.
          const sliceDir = path.join(STATE_DIR, "slices")
          const verifiedFailures: { file: string; missing: string[] }[] = []
          for (const f of Object.keys(state.files)) {
            if (state.files[f] !== "done") continue
            const safe = f.replace(/[\\/]/g, "__")
            const slicePath = path.join(sliceDir, `${safe}.json`)
            const missing = await verifySlice(slicePath, f, directory)
            if (missing.length > 0) {
              state.files[f] = "error"
              state.errors[f] = `signature mismatch: missing ${JSON.stringify(missing)}`
              verifiedFailures.push({ file: f, missing })
            }
          }
          if (verifiedFailures.length > 0) {
            await saveState(state)
            await log(
              `⚠ ${verifiedFailures.length} files failed signature verification: ` +
                verifiedFailures.map((v) => v.file).join(", "),
            )
          }

          // Final summary
          const done = Object.values(state.files).filter(
            (s) => s === "done",
          ).length
          const errors = Object.values(state.files).filter(
            (s) => s === "error",
          ).length
          const errorList = Object.entries(state.errors)
            .map(([f, e]) => `  - ${f}: ${e}`)
            .join("\n")

          await log(
            `✅ Bake complete: ${done}/${totalFiles} done, ${errors} failed`,
          )

          return (
            `✅ Bake complete.\n` +
            `Total files: ${totalFiles}\n` +
            `Successful: ${done}\n` +
            `Failed: ${errors}\n` +
            `Waves: ${waves.length}\n` +
            (isResumable ? `Resumed: skipped ${resumeSkipped} already-done files\n` : "") +
            (errors > 0 ? `\nErrors:\n${errorList}\n` : "") +
            `\nState: ${path.relative(directory, STATE_FILE)}`
          )
        },
      }),

      baker_status: tool({
        description:
          "Show current dispatch state from .opencode/baker/state.json",
        args: {},
        async execute() {
          const s = await loadState()
          if (!s) return "No active dispatch (no state file)"
          const lines = Object.entries(s.files).map(
            ([f, st]) => `  ${st === "done" ? "✓" : st === "error" ? "✗" : st === "running" ? "…" : "·"} ${f}: ${st}`,
          )
          return (
            `Dispatch state (started ${s.started_at}` +
            (s.finished_at ? `, finished ${s.finished_at}` : "") +
            `):\n` +
            `Graph: ${s.graph_path}\n` +
            `Waves: ${s.waves.length}\n` +
            lines.join("\n")
          )
        },
      }),

      baker_resume: tool({
        description:
          "Re-read state.json and print per-file status (done / pending / error). Useful as a standalone query after an interrupted dispatch.",
        args: {},
        async execute() {
          const s = await loadState()
          if (!s) return "No state file at " + path.relative(directory, STATE_FILE)
          const grouped: Record<FileStatus, string[]> = {
            done: [],
            pending: [],
            running: [],
            error: [],
          }
          for (const [f, st] of Object.entries(s.files)) grouped[st].push(f)
          const fmt = (label: string, files: string[]) =>
            files.length > 0 ? `  ${label} (${files.length}):\n` + files.map((f) => `    - ${f}`).join("\n") : `  ${label} (0)`
          return (
            `Resume snapshot (started ${s.started_at}` +
            (s.finished_at ? `, finished ${s.finished_at}` : ", unfinished") +
            `):\n` +
            `Graph: ${s.graph_path}\n` +
            `Waves: ${s.waves.length}\n` +
            fmt("done", grouped.done) + "\n" +
            fmt("pending", grouped.pending) + "\n" +
            fmt("running", grouped.running) + "\n" +
            fmt("error", grouped.error) +
            (Object.keys(s.errors).length > 0
              ? "\n  error messages:\n" +
                Object.entries(s.errors)
                  .map(([f, e]) => `    - ${f}: ${e}`)
                  .join("\n")
              : "")
          )
        },
      }),

      baker_plan: tool({
        description:
          "Validate a graph.json and return its wave plan without dispatching workers.",
        args: {
          graph_path: tool.schema
            .string()
            .default(".opencode/baker/graph.json")
            .describe("Path to graph.json"),
        },
        async execute(args) {
          const graphAbs = path.isAbsolute(args.graph_path)
            ? args.graph_path
            : path.join(directory, args.graph_path)
          try {
            const txt = await fs.readFile(graphAbs, "utf-8")
            const graph = GraphSchema.parse(JSON.parse(txt))
            const waves = buildWaves(graph)
            const total = waves.flat().length
            const plan = waves
              .map((w, i) => `  wave ${i} (${w.length}): ${w.join(", ")}`)
              .join("\n")
            return `✓ Valid graph.\nNodes: ${graph.nodes.length}, Edges: ${graph.edges.length}\nWaves: ${waves.length}, Files: ${total}\n${plan}`
          } catch (err) {
            return `❌ ${(err as Error).message}`
          }
        },
      }),

      baker_graph_query: tool({
        description:
          "Query the persisted baker graph without reading the full graph.json. Use this instead of `read`-ing graph.json to keep context lean. `query=files` lists files with current dispatch status. `query=imports` returns the adjacency list (who imports whom). `query=spec` returns the node specs for a specific file. `query=wave` returns the wave plan (which files run in which wave).",
        args: {
          query: tool.schema
            .enum(["files", "imports", "spec", "wave"])
            .describe("Type of query"),
          file: tool.schema
            .string()
            .optional()
            .describe(
              "Required for 'spec'. Optional filter for 'files'/'imports'/'wave' to narrow to one file.",
            ),
        },
        async execute(args) {
          // Prefer the persisted copy in state.json so we answer correctly
          // even if graph.json has been edited since the last dispatch. Fall
          // back to reading graph.json if no state exists yet.
          const s = await loadState()
          let graph: Graph | null = s?.graph ?? null
          if (!graph) {
            const statePath = s?.graph_path ?? ".opencode/baker/graph.json"
            const graphAbs = path.isAbsolute(statePath)
              ? statePath
              : path.join(directory, statePath)
            try {
              const txt = await fs.readFile(graphAbs, "utf-8")
              graph = GraphSchema.parse(JSON.parse(txt))
            } catch (err) {
              return `❌ No persisted graph in state and could not read graph.json: ${(err as Error).message}`
            }
          }

          const statusByFile = s?.files ?? {}

          switch (args.query) {
            case "files": {
              const fileToNodes = new Map<string, Node[]>()
              for (const n of graph.nodes) {
                if (!fileToNodes.has(n.file)) fileToNodes.set(n.file, [])
                fileToNodes.get(n.file)!.push(n)
              }
              const lines = [...fileToNodes.entries()]
                .filter(([f]) => !args.file || f === args.file)
                .map(([f, nodes]) => {
                  const st = statusByFile[f] ?? "—"
                  return `  ${st.padEnd(8)} ${f}  (${nodes.length} nodes)`
                })
              return (
                `Files (${lines.length}):\n` + lines.join("\n")
              )
            }
            case "imports": {
              const nodeToFile = new Map<string, string>()
              for (const n of graph.nodes) nodeToFile.set(n.id, n.file)
              const adj = new Map<string, Set<string>>()
              for (const e of graph.edges) {
                if (e.type !== "imports") continue
                const src = nodeToFile.get(e.source)
                const tgt = nodeToFile.get(e.target)
                if (!src || !tgt || src === tgt) continue
                if (!adj.has(src)) adj.set(src, new Set())
                adj.get(src)!.add(tgt)
              }
              const lines = [...adj.entries()]
                .filter(([f]) => !args.file || f === args.file)
                .map(([f, deps]) =>
                  deps.size > 0 ? `  ${f} → ${[...deps].join(", ")}` : `  ${f} → (no imports)`,
                )
              return `Imports (${lines.length}):\n` + lines.join("\n")
            }
            case "spec": {
              if (!args.file) return `❌ 'spec' query requires the 'file' arg.`
              const nodes = graph.nodes.filter((n) => n.file === args.file)
              if (nodes.length === 0) {
                return `❌ No nodes for file: ${args.file}`
              }
              const nodeDescs = nodes
                .map(
                  (n) =>
                    `- [${n.type}] ${n.label}${n.signature ? ` :: ${n.signature}` : ""}` +
                    (n.props ? `\n  props: ${JSON.stringify(n.props)}` : ""),
                )
                .join("\n")
              return `Spec for ${args.file} (${nodes.length} nodes):\n${nodeDescs}`
            }
            case "wave": {
              const waves = buildWaves(graph)
              const total = waves.flat().length
              const lines = waves
                .map((w, i) => {
                  const files = args.file ? w.filter((f) => f === args.file) : w
                  return `  wave ${i} (${files.length}): ${files.join(", ") || "(no match)"}`
                })
                .join("\n")
              return `Wave plan (${waves.length} waves, ${total} files):\n${lines}`
            }
          }
        },
      }),
    },

    // ---------------------------------------------------------------
    // Hooks
    // ---------------------------------------------------------------

    // Enforce single-write constraint on baker-apprentice sessions.
    // Track write/edit calls per session and block any tool calls after the
    // first write so the apprentice ends its turn immediately.
    //
    // NOTE: `apply_patch` was previously in the matcher but is not a real
    // tool id in v1.18.18 — dropped. `write` and `edit` are the real ones.
    "tool.execute.before": async (input, _output) => {
      const sid = (input as any).sessionID as string | undefined
      if (!sid) return
      const count = writeCounts.get(sid) ?? 0

      if (input.tool === "write" || input.tool === "edit") {
        if (count >= 1) {
          throw new Error(
            `baker: single-write constraint violated in session ${sid}. ` +
              `baker-apprentice must end after its first write call.`,
          )
        }
        writeCounts.set(sid, count + 1)
      }
    },

    event: async ({ event }) => {
      // Lightweight logging hook — useful when debugging dispatch.
      // Intentionally a no-op by default to avoid log spam.
      if (event.type === "session.error") {
        try {
          await client.app.log({
            body: {
              service: "baker",
              level: "warn",
              message: "session error",
              extra: { event: event.properties },
            },
          })
        } catch {
          /* logging is best-effort */
        }
      }
    },
  }
}