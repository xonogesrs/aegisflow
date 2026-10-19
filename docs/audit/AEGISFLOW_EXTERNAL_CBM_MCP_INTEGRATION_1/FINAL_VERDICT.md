# FINAL_VERDICT

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Type:** targeted integration + minimal acceptance
**Agent:** OMP
**Date:** 2026-10-19
**Verdict:** **PASS**

## 1. Closing criteria (card §11)

| Criterion | Result | Evidence |
|---|---|---|
| A1 formal deployment verified | **PASS** | `MCP_INTEGRATION_REPORT.md` §2; deployed sha `03c08f43…b75e` = source; fresh session: `ekm_query` present, `cbm_query` absent by default, legacy alias callable only when named; 11/11 EKM contract tests pass |
| CBM usable through the existing MCP interface | **PASS** | stdio registration in OMP `mcp.json`; handshake `2025-06-18`, `serverInfo codebase-memory-mcp/0.12.1`; 17 tools discovered as `codebase_memory_*` |
| Code-location function passes | **PASS** | `search_graph` located `resolveMemoryStateRoot` (`src/memory/local-store.mjs:74-78`); `get_file_outline` returned symbol/line structure; `trace_path` returned 17 outbound calls of `retrieveMemory` across 6 modules, matching the source imports; an unnamed transitive-call-graph prompt was answered from CBM's graph alone (70 test callers across 15 files, 3 hops) |
| No EKM ↔ CBM conflict | **PASS** | disjoint tool names (`ekm_query` vs `codebase_memory_*`); disjoint stores; both callable in one session |
| CBM independently disablable | **PASS** | isolated `PI_CODING_AGENT_DIR` without the server: no CBM tools, `ekm_query` still AVAILABLE and executable, kicad still present, bash still works, zero AegisFlow source changes |
| OMP本体 zero modification | **PASS** | binary sha `fa41b27d…4bac5` unchanged, `omp/18.12.1`, `config.yml` sha unchanged, no reinstall, no dispatcher/prompt edit |
| All necessary changes landed safely | **PASS** | full mutation list in `INSTALLATION_CHANGE_MANIFEST.md` (15 entries); everything else verified unchanged |

## 2. What was built

Exactly one integration seam:

- one MCP server entry (`codebase-memory`, stdio) in `~/.omp/agent/mcp.json`,
- one binary installed under `~/.local/opt/codebase-memory-mcp/0.12.1/`,
- one index cache root `/Volumes/NVM2T/cbm/cache` outside every repository,
- two repository indexes (the canonical AegisFlow worktree and this card's landing worktree).

No adapter, bridge, router, prompt injection, hook, skill, agent definition or OMP patch.

## 3. Notable findings an operator must carry forward

1. **`CBM_CACHE_DIR` cannot live under `$HOME` here.** `$HOME` carries an allow-ACL
   (`auracore-broker allow search`); CBM refuses the ancestry and reports a misleading
   `could not load saved runtime settings`. Cache root must be `/Volumes/NVM2T/cbm/cache` (APFS local).
   Documented in `INSTALLATION_CHANGE_MANIFEST.md` §5.
2. **Upstream `install --clients=omp` exceeds this card's scope** — it writes a skill plus three agent
   definitions, and `--skip-config` does not suppress the `~/.profile` PATH edit in this build. The
   official binary + manual stdio registration path was used instead.
3. **The upstream binary is ad-hoc signed** and `spctl` rejects it (upstream documents this posture and
   an antivirus false positive for the family). Integrity was established by matching the archive to
   upstream's published `checksums.txt` byte-for-byte.
4. **Background indexing is deliberately off** (`watcher_enabled=false`, `auto_index=false`,
   `auto_watch=false`). Indexes are snapshots from 2026-10-19T11:08Z; refresh with
   `index_repository` or opt into the watcher explicitly.
5. **Tool selection is not forced, and it works.** For known-symbol lookups the agent prefers
   `grep`/`read` (correct, fast); for a transitive call-graph question with no tool named it discovered
   and drove `codebase_memory_query_graph`/`trace_path` autonomously (76 MCP calls, zero prompt
   mention). Both outcomes are recorded in `AGENT_AUTONOMOUS_TOOL_SELECTION.md`. Forcing one preference
   would require the router/prompt machinery this card forbids.

## 4. Security posture

| Check | Result |
|---|---|
| Source contents sent to an external service | no — MCP is stdio to a local process; zero outbound sockets observed during a CBM call (`lsof -a -p <pid> -i` → none) |
| Credentials in the launch command | none; `env` carries only `CBM_CACHE_DIR` and `CBM_LOG_LEVEL` |
| Secret material in the index | `.env` not indexed (`get_file_outline` → `total: 0`; `check_index_coverage` → `missing`); the live gateway key string does not appear in any index DB |
| CBM modifies project files | no — both worktrees `git status --porcelain` empty; no `.codebase-memory/` created (`persistence` stays default `false`) |
| Background processes | daemon is session-scoped and stops on last client disconnect (`daemon status` → not running); watcher and UI disabled |
| Rollback defined | yes — `PLUGGABILITY_AND_ROLLBACK.md`, with exact files and hashes |

## 5. Boundary honored

Evolution, automatic write-back, and any additional MCP component were **not** enabled or configured.
EKM's internal filenames and data contract were **not** touched. The two systems remain separable by
construction: removing one config key removes CBM entirely, and removing the extension file removes EKM
entirely, with no cross-dependency in either direction.
