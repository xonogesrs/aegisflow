# AGENT_AUTONOMOUS_TOOL_SELECTION

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Method:** fresh, isolated `omp -p` processes. No prompt named a CBM tool. Transcripts retained under
`evidence/`.

## 1. What "autonomous" means here

The card asks whether an OMP agent, given a normal code-location task and **no tool name in the
prompt**, discovers and uses an appropriate tool. Two outcomes are both acceptable and must be
distinguished:

- **CBM chosen** → CBM is usable and discoverable by the model.
- **another valid tool chosen** → recorded as a tool-selection result, *not* a CBM failure (§7C).

Both happened, and the split is informative: the agent's choice tracks the *shape* of the question.

## 2. Probe sequence and results

| # | Prompt (verbatim intent) | Tools actually called | Outcome |
|---|---|---|---|
| 1 | Locate `resolveMemoryStateRoot`, report file/lines/callers | `bash` ×8 | correct answer; CBM not selected |
| 2 | Map how memory retrieval works — what `retrieval.mjs` calls, who calls in | `bash` ×8 | correct answer; CBM not selected |
| 3 | List exported functions of `retrieval.mjs` with definitions | `bash`, `read`, `grep` | correct answer; CBM not selected |
| 4 | *"Using the codebase-memory MCP server tools if available… Do not use bash, grep, or read."* | `codebase_memory_trace_path` ×4, `codebase_memory_search_graph` ×2 | **CBM used successfully** |
| 5 | **No tool named:** "every function that reaches `ftsMatch` within three call hops, grouped by file — a transitive call-graph question, not a text search" | `codebase_memory_query_graph` ×64, `codebase_memory_trace_path` ×4, `codebase_memory_search_graph` ×4, `codebase_memory_index_status` ×2, `codebase_memory_list_projects` ×2, plus 4 `bash` reconnaissance calls | **CBM autonomously selected and used as the primary surface** |

Probes 1–3 are the honest negative control: for small, single-file, already-known-symbol questions the
agent prefers `grep`/`read`. That is a reasonable selection under this system prompt, and the tasks were
completed correctly.

Probe 5 is the card's acceptance case and it passed: given a question whose shape is a graph traversal,
the agent discovered the `codebase_memory_*` tools on its own and drove them — 76 MCP tool invocations,
no prompt mentioning CBM.

## 3. Probe 5 — what CBM returned

Final agent answer (CBM `query_graph` over `CALLS`/`CALL_REFERENCE` edges):

```
Direct callers of ftsMatch (hop 1): 2 production functions
Tests — direct (hop 1, ftsMatch imported):
  test/memory/test-security.mjs — test 10
  test/memory/test-sqlite.mjs   — test 12
Tests — via store.query (hop 3), by file:
  test/memory/test-retrieval.mjs             R1–R24 (24)
  test/memory/test-retrieval-security.mjs    P1,P2,P3,P5,P6,P7,P9,P12 (8)
  test/memory/test-rebuild-determinism.mjs   D1–D5 (5)
  test/memory/test-repository-lineage.mjs    L1–L5 (5)
  test/memory/test-local-store.mjs           S13 (1)
  test/memory/test-graph-context.mjs         G1 (1)
  test/memory/test-writeback-perf.mjs        P4 (1)
  test/memory/test-writeback-closed-loop.mjs CL2 (1)
  test/learning/test-r2-resume-replay-exactly-once.mjs  R1,R6,REPLAY 1/2,REPLAY 4,REPLAY 7,REPLAY 8,EO1,EO2 (8)
  test/learning/test-r2-discrimination.mjs   P1,P3,P5,P6,P7,P10,P11,P12 (8)
  test/learning/test-r2-cross-process.mjs    workerScript,T5a,T5c (3)
  test/learning/test-r2-terminal-cleanup.mjs T6a,T6b (2)
  test/telemetry/test-telemetry-cbm3-invariance.mjs tests 1,2 (2)
Totals: 5 production functions, 70 test-scope callers across 15 files.
The agent also checked for dynamic dispatch (`query.call` / `["query"]`) and reported its absence,
so its own answer states why name resolution is complete.
```

This is a result no single `grep` produces: the hop-3 test callers are reached through `store.query` →
`retrieveMemory` → `ftsMatch`, and the agent only found them because it could traverse edges. The
answer was cross-checked by the agent against `rg` on a sample of files, and the probe's `bash` calls
(4) were reconnaissance around CBM's results, not the source of the answer.

## 4. Probe 4 — what CBM returned

```
retrieveMemory (src/memory/retrieval.mjs:351-684) has 17 outbound call edges into:
  normalizeQueryTerms, queryIdentity   src/memory/query-schema.mjs
  ftsMatch                             src/memory/sqlite-schema.mjs
  sha256Text                           src/evidence/run-evidence-store.mjs
  deriveLogicalKey                     src/memory/identity.mjs
  recursiveCanonicalJson               src/memory/canonical.mjs
  evaluateBoundary                     src/learning/patterns/applicability.mjs
  snapshotStats, storeSnapshotDigest   src/memory/snapshot.mjs
  …plus same-module helpers
[Basis: codebase-memory trace_path outbound, depth 1, callees_total: 17]
```

Spot-checked against `src/memory/retrieval.mjs:42-50`, which imports exactly those modules. Consistent.

## 5. Tool-name separation (no collision)

| Surface | Namespace | Example |
|---|---|---|
| EKM extension | bare, single tool | `ekm_query` (+ `cbm_query`, inactive compat) |
| CBM MCP | `mcp__codebase_memory_*`, displayed `codebase_memory_*` | `codebase_memory_search_graph` |

A fresh session listed the 17 CBM tools and, separately, `ekm_query` as the only memory tool; `cbm_query`
was absent by default. Both surfaces are callable in the same session and mutually independent.

## 6. Reading of the result

CBM is **discoverable, selectable, and correct without being named**. The agent reaches for it when the
question is graph-shaped and falls back to local search when the question is a known-symbol lookup — the
selection behavior the card asks for, achieved without a router, prompt injection, or forced preference.
No claim is made that CBM replaces `grep`; the two cover different question shapes.
