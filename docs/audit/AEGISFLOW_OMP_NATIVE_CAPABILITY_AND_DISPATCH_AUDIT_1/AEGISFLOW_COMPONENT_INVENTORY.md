# AegisFlow component inventory

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1` · READ-ONLY
**Corpus:** 1,735 OMP session files under `~/.omp/agent/sessions/**/*.jsonl` (2026-08-16 → 2026-10-19), plus `~/.omp/logs/*.log`, `~/.omp/agent/*.db`.

Counting method: a **call** is a `toolCall` content block with that tool name; a **result** is a `toolResult` whose `toolName` matches. Skill use is a `read`/`write`/`glob` call whose `path` starts with `skill://`, counted by the first path segment. Device use is any `xd://<device>` occurrence in a tool call's arguments.

Dispositions: `KEEP` · `INVESTIGATE` · `REPAIR_CANDIDATE` · `UNUSED_UNPROVEN`.

---

## 1. Native OMP capabilities

| Component | Source | Version | Purpose | Registration | Visibility | Invocation | Execution | Value | Conflict | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|
| `read` | native | 18.12.1 | file/URI read incl. `skill://`, `xd://` | built-in, essential | top-level | 41,822 calls | 41,821 results | primary transport | none | KEEP |
| `bash` | native | 18.12.1 | shell | built-in, essential | top-level | 104,226 | 104,200 | primary work | none | KEEP |
| `edit` / `write` / `grep` / `glob` / `find` | native | 18.12.1 | mutations + search | built-in | top-level | 12,395 / 6,499 / 9,978 / 3,659 / 66 | matched | primary work | `find` overlaps `grep`/`glob` | KEEP |
| `eval` | native | 18.12.1 | JS/Python kernel | built-in, essential | top-level | 1,817 | 1,817 | used heavily | none | KEEP |
| `todo`, `wait`, `yield`, `ask` | native | 18.12.1 | workflow tools | built-in | top-level | 4,724 / 292 / 479 / 0 | matched | normal | none | KEEP |
| `task` (subagents) | native | 18.12.1 | delegation | built-in, essential | top-level | 252 | 252 | used, incl. `scout` | competes with AegisFlow's own subagent layer out-of-band | KEEP |
| `hub` | native (TUI overlay; string `name: "hub"` in binary) | 18.12.1 | Agent Hub | registered | top-level in that era | 1,894 calls, all 2026-08-16…09-12 | 1,894 | heavy during multi-agent work | absent from modern sessions | UNUSED_UNPROVEN (superseded) |
| `lsp`, `web_search`, `ast_grep`, `ast_edit` | native | 18.12.1 | code intelligence / web | built-in | top-level or `xd://` | 219 / 88 / 0 / 0 (top-level) | matched | normal | none | KEEP (ast tools available via `xd://`) |
| `memory_retain` / `recall` / `reflect` / `memory_edit` / `learn` / `manage_skill` | native | 18.12.1 | native memory & auto-learn | built-in, discoverable | gated by settings/backend | **0** each | n/a | nothing | duplicates CBM conceptually | UNUSED_UNPROVEN — settings-gated, not broken |
| Skills (native discovery + `skill://`) | native | 18.12.1 | procedural knowledge | providers as in architecture doc §2 | `<skills>` block, 11 entries | **814 skill loads** across 19 distinct skills | successful | high — dominant work mode | see overlap doc | KEEP |
| `xd://` device mounting | native | 18.12.1 | schema deferral | `tools.xdev` default true | device catalog | path-addressed dispatches: `report_issue` 150, `find_roots` 134, `observe_ui` 121, `act_ui` 94, `evaluate_browser` 90, `search_ui` 58, `launch_browser` 29, `wait_for` 28, `inspect_ui` 23, `navigate_browser` 23, `expand_ui` 20, `read_text` 14, `browser` 11 (903 total across 34 devices) | mixed | works | hides tools from top-level schema | KEEP |
| `skill:` slash commands | native | 18.12.1 | user-invoked skill | `enableSkillCommands` default true | command list | 1 `skill-prompt` message in corpus | successful | low (autonomous reads dominate) | none | KEEP |
| Judge (`judge` role, TypeSafe) | native | 18.12.1 | typed judgments | internal | not a tool | n/a | n/a | used by native features | overlaps `pi-jev` | KEEP native |

## 2. AegisFlow (published integration)

| Component | Source | Version | Purpose | Registration | Visibility | Invocation | Execution | Value | Conflict | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|
| `no-poll-waits.js` | AegisFlow `integrations/omp/extensions` | repo `1cf1e9f`; deployed 2026-10-18 23:47 | refuse poll-only `bash`; terminal fence | auto-discovered; hooks `session_start`, `tool_call`, `tool_result`, `agent_end`, `session_stop` | n/a (hook) | hook fires on every tool call in every session | blocks observed | high — closes the async-unbound bypass | none in OMP | KEEP |
| `request_terminal_fence` | same file, `loadMode: essential` | as above | agent-side fence **request** | `registerTool` | top-level | 605 calls, all with a result | 605/605 | high | none | KEEP |
| `/fence-generation`, `/release-final` | same file, `registerCommand` | as above | controller commit + release barrier | host prompt channel | not model-dispatchable | 0 transcript hits (by design) | n/a | the authority boundary | none | KEEP |
| legacy `fence_background_waiters` | removed tool name, refused at hook | as above | n/a | **not registered** | not exposed | 12 historical calls (2026-09-25 only) | 9 FENCED (pre-repair), 3 DENIED (post-repair) | proof the denial path works | none | KEEP (denial path) |
| `cbm_query` | AegisFlow `integrations/omp/extensions/cbm-query.js` | repo `1cf1e9f`; deployed byte-identical (`MATCH`) | read-only codebase memory | `registerTool`, `loadMode: essential`, approval `read` | top-level | **1 call** (2026-10-18T13:56Z) | `state: AVAILABLE`, 1 record | real but marginal | duplicates native memory tools conceptually | KEEP |
| CBM store (`~/.autoloop/memory`) | AegisFlow `src/memory` | repo `1cf1e9f` | durable memory | n/a | n/a | 8 records in `memory_records`, 8 in FTS | readable | thin dataset | none | KEEP |
| Governed launcher (`al-omp`) | `autoloop-omp-pilot` (untracked) | not versioned; 462 runtime directories, 38 session files | bounded OMP execution | separate binary | n/a | 25 sessions contain tool calls (116 total) | executed: `read` 63, `bash` 38, `edit` 10, `glob` 2, `lsp` 1, `grep` 1, `write` 1 — all inside the 7-name built-in allowlist | real containment | interactive path keeps extension tools; one-shot removes them | KEEP |
| Pilot overlay (`--tools` allowlist, deny list, recursion 0) | pilot `lib/overlay.js` | as above | freeze tool surface | config overlay | n/a | applied to every run (deny list); built-in allowlist via CLI | enforced | high | see INTEGRATION_BOUNDARY §4 | KEEP |
| AegisFlow core (`src/**`, 211 modules) | repo `1cf1e9f` | 0.0.0 | governance/review/evolution | **not an OMP extension** | invisible to OMP | driven by its own harness | not exercised by this card (read-only audit; no test run) | product | none — different runtime (`pi`) | KEEP |
| `pi-extensions/search-scope-governor` | repo `1cf1e9f` | — | search-scope admission | **not installed into OMP** | n/a | 0 | n/a | none in OMP | overlaps native search tools | UNUSED_UNPROVEN for OMP |

## 3. Third-party plugins

| Component | Source | Version | Purpose | Registration | Visibility | Invocation | Execution | Value | Conflict | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|
| `pi-jev` | `~/.omp/plugins`, GitHub TheoOliveira/pi-jev | 0.7.0 | tool routing, skill suggestions, judgments | manifest key `pi.extensions`; loads offline (3 tools registered) | `xd://jev_find_tools`, `xd://jev_find_skill`, `xd://jev_evaluate` (discoverable) | **0 calls** ever | 0 | 4 `jev-auto` messages (suggestion channel), 0 tool use | duplicates native skill selection and native Judge | REPAIR_CANDIDATE (see ROOT_CAUSE §A) |
| `@edlsh/omp-computer-use` | plugins registry | 0.1.0 | desktop/browser control | `omp.extensions` + `omp.skills` | 11 tools + `omp-computer-use` skill | skill 63 loads; tools via `xd://` (`observe_ui` 121, `act_ui` 94, `find_roots` 134, `search_ui` 58, `evaluate_browser` 90, …) | working | high | overlaps native `browser`/`computer` | KEEP |
| `omp-grok-build` | plugins registry | 0.1.0 | model/CLI proxy registration | `omp.extensions`; loads | registers a provider + `grok-build-help` command | 0 | n/a | unknown | none | UNUSED_UNPROVEN |
| `zmarketplace` | plugins registry | 0.7.8 | marketplace commands | `omp.extensions`; loads | `zmarketplace` / `zmarket` commands | 0 | n/a | unknown | none | UNUSED_UNPROVEN |
| `mcp__node_repl_js` (historical MCP) | not in current `mcp.json` | — | node REPL MCP | removed | absent | 887 calls (until 2026-09-06) | worked then | retired | none | NO_DEFECT (retired) |

## 4. MCP servers

| Component | Source | Version | Purpose | Registration | Visibility | Invocation | Execution | Value | Conflict | Disposition |
|---|---|---|---|---|---|---|---|---|---|---|
| `kicad` MCP (stdio) | `~/.omp/agent/mcp.json` | server files present; 6 processes alive | schematic/PCB automation | `mcpServers.kicad` | `xd://mcp__kicad_*` (92 calls, 17 distinct devices) | works | high for hardware work | none | KEEP |
| `mcp__glm_review_glm_review` | transient probe (2026-10-16) | — | third-party review | not in `mcp.json` | absent | 1 probe read | n/a | none | none | NO_DEFECT |

## 5. Other components named by the card

| Component | Why it is in the card | Finding | Label | Disposition |
|---|---|---|---|---|
| **Terminal Fence** | authority split | Tool + hooks present, 605 requests, all refused as commits by design; controller path gated by env marker | CONFIRMED | KEEP |
| **Evidence / Governance** | AegisFlow product | Not exposed to OMP at all; runs in AegisFlow's own harness | CONFIRMED | KEEP (out of scope for OMP dispatch) |
| **Pilot** | governed launcher | 462 runtime directories (38 session files, 25 with tool calls); interactive path restricts built-ins to 7 but keeps extension tools; one-shot path adds `--no-extensions --no-skills --no-rules` | CONFIRMED | KEEP, but see boundary §4 |
| **Colima** | sandbox runtime | `colima status` = running, docker socket redirected to `/Volumes/NVM2T/.../colima/default/docker.sock`; **no running containers** | CONFIRMED | KEEP (infrastructure, not an agent component) |
| **Jev** | third-party router | Installed, loads, 0 tool calls, 4 suggestion messages in 82 prompts since install, all carrying an uncallable `/skill:skill:<name>` | CONFIRMED | REPAIR_CANDIDATE (evidence only — no repair performed) |
| **CBM** | AegisFlow memory | 1 call / 1 success; 8 records; store healthy | CONFIRMED | KEEP (benefit unproven, mechanism proven) |
| **AuraCore / DAC** | adjacent products | Not OMP components | CONFIRMED | out of scope |

## 6. "Not called" vs "not working" — explicit split

| Tool/component | Calls | Working when called? | Correct classification |
|---|---|---|---|
| `jev_find_tools` / `jev_find_skill` / `jev_evaluate` | 0 | yes — offline import registers all three; `xd://` mount confirmed in device listings | **discoverable-but-unused**; visibility verified, usage not observed |
| `kicad-design` skill | 0 loads (9 `skill://kicad-design` string mentions, all inside prose/other sessions' text) | yes — cache row exists, meaning it rendered | **unused** |
| `software-ios-native` skill | 0 | yes — cache row exists | **unused** |
| `mcp__kicad_*` top-level | 0 | yes via `xd://` | **used through the device transport, not missing** |
| `skill://` unknown-name path | 2 deliberate error probes | produced a clean error | **correct behaviour** |
| `hub` | 1,894 (all ≤ 2026-09-12) | yes then | **superseded**, not broken |

The distinction is the one the card asked for: zero calls is evidence of *non-use*, never by itself evidence of *malfunction*. Only `pi-jev`'s recommendation text has a proven defect (see ROOT_CAUSE §A).
