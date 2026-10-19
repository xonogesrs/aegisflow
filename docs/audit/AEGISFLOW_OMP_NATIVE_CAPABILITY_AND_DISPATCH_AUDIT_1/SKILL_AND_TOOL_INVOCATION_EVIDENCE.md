# Skill and tool invocation evidence

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1` · READ-ONLY
**Corpus:** `~/.omp/agent/sessions/**/*.jsonl` — 1,735 files, 2026-08-16 → 2026-10-19. Logs: `~/.omp/logs/*.log`.

All tables are reproducible by counting `message.content[].type == "toolCall"` (`name`, `arguments.path`) and `message.role == "toolResult"` (`toolName`). The card's prior audit used a text-grep method that counted names appearing inside *any* message text — including system prompts, quoted documentation and tool results. That method over-counts (`jev_*` appeared 35× that way with **0** executions). This document uses call/result structures only.

---

## 1. Whole-corpus call census (top 19)

| Tool | Calls | Results | Note |
|---|---:|---:|---|
| `bash` | 104,226 | 104,200 | 26 calls ended without a result (abort/compaction) |
| `read` | 41,822 | 41,821 | |
| `edit` | 12,395 | 12,395 | |
| `grep` | 9,978 | 9,978 | |
| `write` | 6,499 | 6,496 | |
| `todo` | 4,724 | 4,724 | |
| `glob` | 3,659 | 3,659 | |
| `hub` | 1,894 | 1,894 | all before 2026-09-13 |
| `eval` | 1,817 | 1,817 | |
| `mcp__node_repl_js` | 887 | 887 | retired server |
| `request_terminal_fence` | 605 | 605 | **AegisFlow** |
| `yield` | 479 | 479 | |
| `wait` | 292 | 292 | |
| `task` | 252 | 252 | |
| `lsp` | 219 | 219 | |
| `web_search` | 88 | 88 | |
| `find` | 66 | 66 | |
| `mcp__node_repl_js_reset` | 40 | 40 | retired server |
| `fence_background_waiters` | 12 | 12 | legacy fence surface, 2026-09-25 only |

**Zero top-level calls:** `jev_find_tools`, `jev_find_skill`, `jev_evaluate`, `memory_retain`, `memory_recall`, `memory_reflect`, `memory_edit`, `learn`, `manage_skill`, `ast_grep`, `ast_edit`, `computer`, `browser`, `github`, `debug`, `read_text`, and every top-level `mcp__kicad_*`.

"Zero top-level" is not "zero use" for the discoverable tools: `browser` was invoked 11 times and `read_text` 14 times through `xd://`, which is the intended transport for discoverable tools. `cbm_query` has **1** call; it is not in the zero list.

---

## 2. Skill loads (814 total)

| Skill | Loads | Last observed era |
|---|---:|---|
| `code-review` | 200 | 2026-10-18 |
| `diagnosing-bugs` | 166 | 2026-10-18 |
| `codebase-design` | 96 | 2026-10-16 |
| `research` | 91 | 2026-10-16 |
| `tdd` | 66 | 2026-10-17 |
| `dac-engineering-workflow` | 63 | 2026-10-15 |
| `omp-computer-use` | 63 | 2026-10-17 |
| `cavecrew` | 27 | 2026-08-31 |
| `domain-modeling` | 19 | 2026-10-02 |
| `caveman-commit` | 7 | 2026-08-31 |
| `rust` | 6 | 2026-10-18 |
| `triage` | 2 | 2026-10-17 |
| `resolving-merge-conflicts` | 1 | 2026-10-09 |
| `wayfinder` | 1 | 2026-10-17 |
| `caveman-review`, `design-taste-frontend` | 1 each | 2026-08-23 |
| **errors**: empty name (2), `does-not-exist-xyz` (1), `code-review:1-220` (1 — range syntax, not a skill) | 4 | 2026-10-17 |
| `kicad-design`, `software-ios-native` | **0** | — |
| `implement`, `improve-codebase-architecture` | **0** | hidden from prompt (`disable-model-invocation`) |

### 2.1 What the corpus proves about autonomous selection

- The model loads skills **without being told**, in ordinary sessions, on name+description alone: 814 loads over 19 distinct skills, with the expected domain concentration (`code-review` before review tasks, `diagnosing-bugs` on failures, `tdd` on test-first tasks).
- The one skill with a hardware domain (`kicad-design`) has **0** loads even though KiCad work occurred on this host (KiCad MCP dispatched 92 times). That is a genuine selection gap, not a wiring gap — the skill is rendered (cache row exists) and `skill://kicad-design` resolves.
- Skills that are currently unrendered (`implement`, `improve-codebase-architecture`) have 0 loads, consistent with the documented `disable-model-invocation` contract.

### 2.2 Prior card's four verification cases

Not re-run (the card forbids repeating them). The corpus is consistent with those results: `rust` loads appear on 2026-10-17/18, `code-review` loads continue into 2026-10-18, and the post-repair description cache contains all 11 compressed rows. `CONFIRMED` consistency; the card's own live acceptance remains the primary evidence for that repair.

---

## 3. AegisFlow extension evidence

### 3.1 `request_terminal_fence`

- 605 calls, 605 results; every result contains `committed: false` and the recorded disposition.
- Monthly: Sep 2026 — 64; Oct 2026 — 541.
- The tool is `loadMode: "essential"`, approval tier `read`, so it is present top-level rather than behind `xd://`. `CONFIRMED` (`no-poll-waits.js:762-805`).
- 12 calls appear as `xd://request_terminal_fence` in a *device* listing context; this reflects the same tool being discoverable when xdev enumerates the registry, not a second implementation.

### 3.2 Legacy `fence_background_waiters` — the authority repair, in outcomes

| Timestamp (UTC) | Outcome |
|---|---|
| 2026-09-25T09:36:10 | FENCED |
| 2026-09-25T09:39:01 | FENCED |
| 2026-09-25T12:10:49 | FENCED |
| 2026-09-25T13:22:02 | FENCED |
| 2026-09-25T13:28:05 | FENCED |
| **2026-09-25T14:12:22** | **DENIED** — `"fence_background_waiters" is not Agent-reachable` |
| 2026-09-25T14:12:31 | DENIED |
| 2026-09-25T14:12:51 | DENIED |
| 2026-09-25T16:48:16 | FENCED (controller path, not agent) |
| 2026-09-25T17:32:23 | FENCED (controller path) |
| 2026-09-25T17:33:36 | FENCED (controller path) |
| 2026-09-25T17:34:45 | FENCED (controller path) |

The 14:12 boundary is the authority cut-over: the same tool name flips from committing to refused, and no agent-origin fence succeeds afterwards. `CONFIRMED` for the observable outcome. `INFERRED` for attributing the later FENCED results specifically to the controller path (the results identify a generation and pending-delivery count, and the extension no longer exposes an agent-commit primitive).

### 3.3 `cbm_query`

Single invocation, 2026-10-18T13:56:36Z:

```
1 codebase-memory record(s).
{ "state": "AVAILABLE", "kind": "MEMORY_CONTEXT_DATA",
  "repository": { "repositoryIdentity": "677b045d…", "worktreeIdentity": "ea57eece…" }, … }
```

The store itself is healthy: `memory_records` 8, `memory_fts` 8, `memory_lifecycle_events` 8, `memory_evidence` 0, `memory_conflicts` 0, 2 migrations applied. `CONFIRMED`.

Disposition: mechanism `KEEP`, benefit `UNPROVEN` — one call in a corpus of 1,735 sessions is not evidence of value, and it is not evidence of failure either.

### 3.4 Deployed-vs-published integrity

`node scripts/install-omp-integration.mjs check --json`: 6 `MATCH`, 1 `EQUIVALENT` (`no-poll-waits.js`, one redacted session identifier), 0 `DRIFT`, 0 `MISSING`. `CONFIRMED`.

---

## 4. Third-party evidence

### 4.1 `pi-jev`

| Aspect | Evidence | Label |
|---|---|---|
| Installed / enabled | `omp-plugins.lock.json` `pi-jev 0.7.0 enabled:true`; package under `~/.omp/plugins/node_modules` | CONFIRMED |
| Loads under OMP 18.12.1 | offline `import()` + stub `pi` registers `jev_find_tools`, `jev_find_skill`, `jev_evaluate` and 7 handler names (`tool_call`, `tool_result`, `session_start`, `session_before_compact`, `after_provider_response`, `thinking_level_select`, `before_agent_start`) | CONFIRMED |
| Exposed to the agent | device listings in transcripts contain `xd://jev_find_tools`, `xd://jev_find_skill`, `xd://jev_evaluate` | CONFIRMED |
| Executed | **0** tool calls in 1,735 sessions | CONFIRMED |
| Auto-routing channel | 4 `jev-auto` custom messages since install (2026-10-17T12:29) out of 82 user prompts in 66 sessions ⇒ ~5 % of prompts | CONFIRMED |
| Auto-routing content | all 4 name `/skill:skill:<name>` — a doubled prefix | CONFIRMED |
| Effect of the suggestion | in all 4 sessions the model did **not** invoke the suggested command; 1 session loaded the skill by `skill://` anyway | CONFIRMED |
| Root of the doubled prefix | `getAvailableSkills()` accepts names from `getCommands()`, where OMP already returns `skill:<name>` (`get-commands-handler.ts:58`), then the message template writes `/skill:${name}` ⇒ `/skill:skill:<name>` (`extensions/index.ts:171-176`). The fallback path that produces it is the command-source path, not the system-prompt path. | CONFIRMED in source; matches all 4 observed messages |
| Consequence | `parseSkillInvocation` reads the name after `/skill:` as `skill:<name>`; lookup uses `getSkillSlashCommandName({name})` ⇒ `skill:skill:<name>`, which is not registered ⇒ `undefined` (`skill-command.ts:56-68`) | CONFIRMED mechanism |

### 4.2 `omp-computer-use`

63 skill loads and heavy tool use through `xd://` (`find_roots` 134, `observe_ui` 121, `act_ui` 94, `evaluate_browser` 90, `search_ui` 58, `launch_browser` 29, `wait_for` 28, `inspect_ui` 23, `navigate_browser` 23, `expand_ui` 20, `read_text` 14). `CONFIRMED`.

### 4.3 Other plugins

`omp-grok-build` and `zmarketplace` both register only commands/provider metadata and load cleanly offline; **no transcript hit** for either command. `UNUSED_UNPROVEN`.

---

## 5. MCP evidence

| Server | Exposure | Top-level calls | `xd://` calls | Label |
|---|---|---:|---:|---|
| `kicad` | `xd://mcp__kicad_*` | 0 | **92 device-path calls, 17 distinct devices** (`run_erc` 28, `get_schematic_view` 19, `get_schematic_view_region` 12, `digikey_search_parts` 8, `get_backend_state` 7, `digikey_test_connection` 5, `export_netlist` 2, `get_project_info` 2, and 1 each of `get_pads`, `launch_kicad_ui`, `list_tool_categories`, `check_freerouting`, `check_kicad_ui`, `list_symbol_libraries`, `get_jlcpcb_database_stats`, `list_libraries`, `get_category_tools`) | CONFIRMED |
| `node_repl_js` (retired) | absent today | 887 | 0 | CONFIRMED |
| `glm_review` (transient probe) | absent | 0 | 1 | CONFIRMED |

The KiCad server is running (6 matching processes) and the tool surface is discovered. Zero top-level calls is the **expected** consequence of `tools.xdev`, not a discovery failure: 92 invocations reached the same tools through `read`/`write xd://` (38 `read`, 54 `write`).

---

## 6. Failure observations worth recording

| Observation | Evidence | Label |
|---|---|---|
| Skill-description compression was failing on every session before the repair (1,877 failures across logs, last at 08:02:02 on 2026-10-19) and is now silent | log corpus | CONFIRMED |
| A late "unusable; keeping the preview" message (243 events, 06:40–08:02) shows a *different* path from the 404 failures: current OMP rejects a compression and degrades rather than retrying — this is a graceful path, not a defect | logs | CONFIRMED |
| A `read` of `skill://` with an empty name and with a non-existent name both produced explicit errors | transcripts | CONFIRMED |
| One session ran `--tools` with `cbm_query` in the list and OMP rejected it: `Unknown tool in --tools: cbm_query` — the allowlist validator knows only built-in names, so extension tools cannot be allowlisted at all | transcript 2026-10-18T14:03 | CONFIRMED |
| Pilot runs contain only `bash`/`read`/`edit`/`glob`/`lsp` calls — consistent with `--no-extensions` + the 7-name allowlist | pilot runtime JSONL | CONFIRMED |
