---
description: Bake a codebase from a natural-language description via the baker orchestrator and parallel apprentices.
agent: baker
---

Bake the following codebase:

$ARGUMENTS

Process:
1. Design and write `.opencode/baker/graph.json` (graphify-compatible schema: nodes with type file/class/function/interface, edges with type imports/contains).
2. Optionally call `baker_plan` to validate the graph and preview the wave plan.
3. Call `baker_dispatch` with `graph_path: ".opencode/baker/graph.json"` and `concurrency: 4`.
4. Report results to the user (success count, errors, state file location).

Constraints:
- One node per file. Group multiple class/function nodes under their containing file.
- `imports` edges drive the DAG. `contains` edges group nodes within a file.
- If the description implies > 20 files, prefer a minimal viable slice first; ask before expanding.
- After dispatch, do not iterate further unless the user asks.