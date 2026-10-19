# OMP native dispatch architecture — findings

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1`
**Mode:** READ-ONLY (no OMP source, config, extension, skill, MCP or store was modified)
**Evidence labels:** `CONFIRMED` = source/settings/log/transcript call evidence on this host · `INFERRED` = consistent clue, not directly proven · `UNKNOWN` = insufficient data.

---

## 0. Method and its limits

Three evidence classes were used, and they are **not** interchangeable:

| Class | What it proves | What it does not prove |
|---|---|---|
| Installed **binary** (`omp` 18.12.1, run `--version`, hashed, string-inspected) | the version actually executing; the presence of some symbols | internal control flow |
| Readable **source tree** `@oh-my-pi/pi-coding-agent@18.8.9` (`~/node_modules/...`, 1,393 `.ts` files) | mechanism and file:line citations | behaviour added in 18.9.0–18.12.1 |
| **Runtime artefacts** (`~/.omp/agent/sessions/**/*.jsonl`, `~/.omp/logs/*.log`, `~/.omp/agent/*.db`) | what actually happened, when, and how often | why a model chose an action |

Consequence, stated once and applied throughout: a citation into 18.8.9 is a **mechanism** claim. A behaviour claim about the running agent is only made when a transcript, log line, database row or live probe supports it. Where the two disagree, the runtime artefact wins.

The dispatch path described below was **not** executed end-to-end by this card: no OMP session was started, no provider call was made, no skill was loaded, and no MCP tool was invoked. Live facts come from artefacts produced before the card opened, plus two offline import probes (`import()` of an extension module with a stub `pi`, which creates no session and performs no I/O outside the module load).

---

## 1. Baseline freeze

| Item | Value | Label |
|---|---|---|
| Installed executable | `/Users/zhengfengqing/.local/bin/omp` (via `~/.bun/bin/omp` symlink) | CONFIRMED |
| Executable type / size | Mach-O arm64 / 195,462,176 B | CONFIRMED |
| Executable sha256 | `fa41b27d434380e99b713e4f9ced0f73eb1fc0c409fdf23a57c119971d24bac5` | CONFIRMED |
| Executable mtime | 2026-10-18 12:52 (+08:00) | CONFIRMED |
| Reported version | `omp/18.12.1` | CONFIRMED |
| Other version markers | `~/.omp/agent/last-changelog-version` = `18.12.1`; `~/.omp/natives/18.12.1/` exists | CONFIRMED |
| Readable source | `@oh-my-pi/pi-coding-agent@18.8.9` at `~/node_modules/@oh-my-pi/pi-coding-agent` | CONFIRMED |
| Source relation to binary | same package line, **four minor versions lower**; mechanism evidence only | CONFIRMED |
| Other copies on host | `~/.omp/plugins/node_modules/@earendil-works/pi-coding-agent@1.3.0` (peer shim for `pi-jev`); npm-global `@earendil-works/pi-coding-agent@0.84.4` (the `pi` runtime AegisFlow's adapters pin) | CONFIRMED |
| Agent home | `~/.omp/agent` (`config.yml`, `models.yml`, `mcp.json`, `extensions/`, `sessions/`, `skill-descriptions.db`) | CONFIRMED |
| Plugin home | `~/.omp/plugins` (`package.json`, `omp-plugins.lock.json`, `node_modules/`) | CONFIRMED |
| Runtime versions observed in the 1,735 session files | 18.11.0, 18.11.1, 18.11.2, 18.11.3, 18.12.1 | CONFIRMED |

**Baseline drift since the previous audit is real and is not this card's doing.** `AUTOLOOP_OMP_NATIVE_CAPABILITY_RECONCILIATION_1` recorded 18.11.2 with sha256 `dfbf52e9…69cc`; the installed binary is now 18.12.1 with a different hash and a later mtime. Any statement below that depends on 18.11.x behaviour is treated as historical.

`modelRoles.smol` currently resolves to `google-antigravity/gemini-3.8-flash`; the pre-repair backup `~/.omp/agent/config.yml.bak-pre-skilldesc-20261019` differs from the live file in exactly that one line. The repair is still in force. `~/.omp/agent/skill-descriptions.db` holds 11 rows, and the log corpus has **zero** compression failures after 2026-10-19T08:03 (+08:00) — the last failure is 08:02:02. `CONFIRMED`.

---

## 2. Discovery: which providers contribute capabilities

Discovery is a capability registry, not a plugin list. Each provider registers items for a capability id (`skill`, `tool`, `extension-module`, `mcp`, `rule`, `prompt`, …) with a numeric priority; same-key collisions are resolved by that priority plus provider-specific override rules.

| Provider | Priority | Skill surface on this host | Label |
|---|---|---|---|
| `omp` (native) | 100 | project `.omp/skills` walking ancestors from cwd, plus `~/.omp/agent/skills` | CONFIRMED (`discovery/builtin.ts:296-320`) |
| `skillshare` | 95 | `~/.omp/skillshare/@scope/name/...` — **no installs present** | CONFIRMED |
| `omp-plugins` | 90 | sibling `skills/` of an installed extension package → `omp-computer-use` | CONFIRMED (`discovery/omp-plugins.ts:47,60-79`) |
| `claude` | 80 | `~/.claude/skills` — **user scope disabled by default** (`skills.enableClaudeUser = false`) | CONFIRMED (`extensibility/settings.ts:45`) |
| `agents` | 70 | `~/.agents/skills` and project `.agents/skills` — user scope **enabled by default** | CONFIRMED (`extensibility/settings.ts:57`) |
| `claude-plugins` | 70 | marketplace caches — this host's cache contributes no skill that survives dedupe | INFERRED |
| managed (`autolearn`) | 5 | `~/.omp/agent/managed-skills` — directory absent ⇒ no-op | CONFIRMED (`discovery/builtin.ts:326-356`) |

**Resolution for this host `CONFIRMED` from the filesystem plus the cache rows:**

- `~/.omp/agent/skills` **does not exist**; `~/.omp/skills` **does not exist**. The native provider therefore contributes **zero** skills.
- `~/.agents/skills` contains 14 skill directories.
- `~/.claude/skills` is a symlink farm pointing at the **same** `~/.agents/skills` targets, and the claude user provider is disabled by default — so it contributes nothing, and would be realpath-deduped anyway (`extensibility/skills.ts:441-449`).
- `omp-computer-use` (plugin) contributes 1 more.
- 4 of the 14 authored skills declare `disable-model-invocation: true` (`implement`, `triage`, `wayfinder`, `improve-codebase-architecture`) and are excluded from the prompt listing while remaining addressable via `skill://` (`capability/skill.ts:12-31`, `extensibility/skills.ts:459`).

Net: **15 discovered, 11 rendered** — exactly the 11 names in `skill-descriptions.db`. This is a consistency check, not an assumption: the cache is only written for skills the prompt renderer actually processed.

---

## 3. Skill invocation chain

```
user task
  → system prompt <skills> block (name: description)      system-prompt.ts:941-951, prompts/system/system-prompt.md:42-48
  → model decides                                         no code path; model-side
  → read skill://<name>[/<path>]                          internal-urls/skill-protocol.ts
  → SKILL.md body enters the transcript                   skill-protocol.ts:104-160
  → tools / workflow described by the skill run           ordinary tool dispatch
```

| Stage | Mechanism | Label |
|---|---|---|
| Prompt gating | The `<skills>` block renders only when `skills.length > 0` **and** an active tool declares `readsSkillUris` (`system-prompt.ts:445,938-951`). `read` is that tool; with `xd://` on it may be mounted, and the projection still counts it. | CONFIRMED mechanism; matches every observed session that listed skills |
| Description source | `SkillDescriptionCatalog.render()` reads `skill-descriptions.db`; on a miss it uses a 100-char preview **and schedules one background compression** through the `smol` role (`skill-descriptions.ts:23,43,259-330`). | CONFIRMED |
| Description cache key | `sha256(compress-prompt ‖ name ‖ description)`; rejection caches a model-scoped preview and never re-asks that model. | CONFIRMED (`skill-descriptions.ts:87-95`) |
| Prompt wording | `Matching skill → MUST read skill://<name> first.` — this is the only autonomous-selection instruction; there is no router, classifier or embedding step in the native path. | CONFIRMED (`prompts/system/system-prompt.md:43`) |
| Load | `skill://name` resolves against the session's loaded skills, supports `<namespace>/<name>` collisions and relative paths inside the skill's `baseDir`, and rejects traversal. | CONFIRMED (`skill-protocol.ts:44-104`) |
| Failure modes observable | Unknown skill → error listing available names; empty name → explicit error. One corpus call used a non-existent name and one used an empty name, and both produced errors rather than silent success. | CONFIRMED (transcripts) |
| Slash form | `/skill:<name>` is a registered command when `skills.enableSkillCommands` (default **true**); `getCommands()` exposes it as `source: "skill"` with the **already-prefixed** name `skill:<name>`. | CONFIRMED (`extensibility/settings.ts:32-34`, `get-commands-handler.ts:56-63`, `skills.ts:609`) |

**Jev's insertion point.** `pi-jev` is a regular extension. It does not touch skill discovery, does not observe `skill://` reads, and does not inject into the skill chain. It hooks `before_agent_start` and, when enabled, runs one extra evaluation per prompt: lexical shortlist over `name + description`, then per-candidate Noul probability at threshold 0.65, then a **display-only custom message** recommending `/skill:<name>` (`src/skills.ts:81-180`, `src/auto.ts:88-141`, `extensions/index.ts:145-178`). No skill is loaded by Jev, and no tool is called by Jev on the model's behalf beyond `activateTools()` for its own shortlist.

---

## 4. Tool registration and dispatch

| Surface | Registration | Exposure | Dispatch | Label |
|---|---|---|---|---|
| Built-in tools | `createTools()` per session, `loadMode` per class | `essential` names stay top-level | direct tool call | CONFIRMED (`tools/index.ts:860-960`, `tools/essential-tools.ts:45-50`) |
| `xd://` device transport | enabled by `tools.xdev` (**default true**) | non-essential tools are mounted as devices; `read xd://` lists, `write xd://<device>` executes | `read`/`write` acting as transport | CONFIRMED (`tools/settings.ts:912-924`, `tools/index.ts:873-916`, `internal-urls/xd-protocol.ts:55-120`) |
| Extension tools | `pi.registerTool()` → `extension.tools` map | merged into the registry at session assembly | `ExtensionToolWrapper` → `tool_call` hook → approval → execute | CONFIRMED (`extensions/loader.ts:216-224`, `extensions/wrapper.ts:186-280`, `sdk.ts:3343-3375`) |
| MCP tools | server declared in `mcp.json` / project config | `mcp__<server>_<tool>`; if discoverable, mounted under `xd://` | same wrapper path, MCP bridge underneath | CONFIRMED (`mcp.json`, observed `xd://mcp__kicad_*`) |
| Plugin extension packages | `package.json` `omp` **or** `pi` manifest key, `extensions` entry resolved (directory or file) | installed under `~/.omp/plugins/node_modules` | loaded as an ordinary extension | CONFIRMED (`plugins/loader.ts:194,346-410`) |
| Custom tools / commands | `pi.registerTool` / `pi.registerCommand` | registry / slash-command union | per dispatch | CONFIRMED |

Two consequences that matter to any AegisFlow claim:

1. **`--tools <list>` restricts built-ins; it does not remove extension tools.** The flag sets `options.toolNames` (`main.ts:1637-1641`), while `restrictToolNames` — the switch that zeroes `extensionRunner.getAllRegisteredTools()` (`sdk.ts:3343`) and skips `tools.xdev` (`tools/index.ts:873`) — is set only by internal callers (`commit/agentic/agent.ts:76`, `compress/session.ts:51`, `security/coordinator.ts:261`, `task/executor.ts:4328`). Under a bare `--tools`, extension tools are force-included into the active set (`sdk.ts:4028-4044`). Extension modules disappear only when discovery is disabled (`--no-extensions`, `main.ts:1685-1687`). So a one-shot governed run (which passes `--no-extensions`) has no `request_terminal_fence`, `cbm_query`, `jev_*` or MCP; an interactive governed run still has the extension tools, with MCP project config off. The CLI additionally rejects non-built-in names in `--tools` (`cli/args.ts:414-434`). `CONFIRMED`.
2. **A `tool_call` hook is a pre-execution gate, not a post-hoc observer.** Handlers run before execution, may return `{block:true}`, and a handler timeout fails closed (`extensions/runner.ts:1797-1862`). This is the seam `no-poll-waits.js` uses. `CONFIRMED`.

**Method note (recorded because an intermediate draft got this wrong).** The first pass cited `restrictToolNames` as if `--tools` set it. It does not. `--tools` → `options.toolNames` (`main.ts:1637-1641`); `restrictToolNames` is an internal-session switch (`commit/agentic/agent.ts:76`, `compress/session.ts:51`, `security/coordinator.ts:261`, `task/executor.ts:4328`). The distinction changes the answer to "can a governed run use the AegisFlow tools?" from *never* to *not in one-shot, yes in interactive*. The corrected text above reflects the source, and the correction is left visible rather than silently rewritten. `CONFIRMED`.

---

## 5. Extension lifecycle

```
discover  →  load/import  →  factory(pi)   →  registerTool/hook/command
(agentDir/extensions, settings.extensions, plugin manifests)
                                            ↓
session_start → (per turn) before_agent_start → tool_call → execute → tool_result
                                             → agent_end → session_stop → dispose
```

| Stage | Evidence | Label |
|---|---|---|
| Discovery roots | `<configDir>/extensions` top-level `*.js`/`*.ts`; `settings.json` `extensions`; plugin manifests | CONFIRMED (`discovery/builtin.ts:481-545`, `discovery/omp-extension-roots.ts`) |
| Deployed AegisFlow extensions | `no-poll-waits.js`, `cbm-query.js` in `~/.omp/agent/extensions`, with `lib/` and `test/` deliberately not loadable | CONFIRMED (directory listing; `lib/` has no index/package.json) |
| Load success | both register offline under a stub `pi` (`cbm_query`; and `request_terminal_fence` + 2 commands for the fence extension) | CONFIRMED (offline import probe) |
| Hook registration | `session_start` 588, `tool_call` 596, `tool_result` 660, `agent_end` 682, `session_stop` 711 | CONFIRMED (`no-poll-waits.js`, same offsets in repo copy) |
| Plugin lifecycle | `enabledPlugins` from `omp-plugins.lock.json`; per-plugin `enabled` flag honoured | CONFIRMED (`plugins/loader.ts:200-215`) |
| Failure visibility | an extension that throws during import is logged, not fatal; a handler that throws **blocks** the tool call it was gating (fail-closed) | CONFIRMED mechanism (`extensions/runner.ts:1828-1855`) |

---

## 6. MCP discovery and exposure

- Declared servers: **one**, `kicad` (stdio, node `dist/index.js`, KiCad Python venv, `KICAD_AUTO_LAUNCH=false`). `CONFIRMED` (`~/.omp/agent/mcp.json`).
- Server processes are alive (6 node/python processes matching `KiCAD-MCP-Server`). `CONFIRMED` (process listing).
- Exposure path actually used: **`xd://` devices**, not top-level schemas. Direct top-level `mcp__kicad_*` tool calls in 1,735 session files: **0**. `xd://mcp__kicad_*` device invocations: 92 across 17 distinct devices. `CONFIRMED`.
- This is the designed behaviour of `tools.xdev` for discoverable tools, not a defect: the schema cost is paid on demand rather than every request. `CONFIRMED` (`tools/settings.ts:912-924`).
- A second MCP-era tool family, `mcp__node_repl_js` (887 calls) plus `mcp__node_repl_js_reset` (40), appears in the corpus until 2026-09-06 and has **no** server in `mcp.json` today. Historical removal, not a live component. `CONFIRMED`.

---

## 7. System prompt / agent context capability description

| Block | Content | Label |
|---|---|---|
| `<skills>` | one line per visible skill: `- <name>: <compressed description>` | CONFIRMED (`prompts/system/system-prompt.md:42-48`) |
| Tool inventory | top-level tool names; `xd://` devices listed separately when xdev is on | CONFIRMED (prompt rendering; transcript device listings) |
| MCP/devices | device name + description; docs inlined or on demand per `tools.xdevDocs` (default `catalog`) | CONFIRMED (`tools/settings.ts:925-947`) |
| Jev | **nothing**. pi-jev injects no system-prompt text; its only channel is a `custom_message` after `before_agent_start`. | CONFIRMED (`extensions/index.ts:145-178`) |
| AegisFlow governance | **nothing**. No AegisFlow extension writes to the system prompt or context files. | CONFIRMED (no such call in either deployed extension) |

---

## 8. Where AegisFlow actually intervenes

| Intervention | File / mechanism | Reaches the model? | Label |
|---|---|---|---|
| Background-waiter policy | `no-poll-waits.js` `tool_call` hook; pure classifier in `lib/poll-wait-policy.js` | yes — it blocks `bash` calls | CONFIRMED (605 fence calls; block path in source) |
| Terminal-fence request tool | `request_terminal_fence` (`loadMode: essential`, approval `read`) | yes — top-level tool | CONFIRMED (tool observed in transcripts, 605 calls with results) |
| Controller commit / release | slash commands on the host channel, gated by `OMP_TERMINAL_FENCE_AUTHORITY` | no — not model-dispatchable | CONFIRMED by design and by 3 DENIED legacy attempts |
| Codebase memory tool | `cbm_query` (`loadMode: essential`) | yes when the extension is loaded | CONFIRMED (1 call, `AVAILABLE`) |
| Governed launch | `autoloop-omp-pilot` `al-omp` → `omp` with `--tools …`, `--no-extensions`, `--no-skills`, `--no-rules`, isolated HOME, overlay YAML | **no** — removes the extension, skill and rule surfaces entirely | CONFIRMED (`lib/launcher.js:110-118`) |
| Evidence / governance / evolution / review | AegisFlow `src/`, invoked by its own harness against its own pinned `pi` runtime | no | CONFIRMED (`docs/agent-integration.md`; adapters pin `@earendil-works/*`) |
| Skills themselves | **not AegisFlow** — `~/.agents/skills`, native discovery | yes | CONFIRMED |

So the integration has exactly two model-facing surfaces (`request_terminal_fence`, `cbm_query`), one policy gate (`tool_call`), and one deliberate containment (the governed launcher disables all three). Everything else AegisFlow ships is out-of-band of the OMP process.

---

## 9. Native vs added — one-line summary

**Native and working:** skill discovery/description/load, tool dispatch and `tool_call` gating, `xd://` device mounting, MCP bridging, subagents (`task`/`wait`), plugin loading, extension tools, slash commands.

**Added by AegisFlow:** waiter policy, terminal-fence authority split, read-only CBM tool, and the governed launcher that suppresses the native surfaces it re-implements.

**Added by third parties:** `pi-jev` (tool/skill routing + typed judgments), `omp-computer-use` (desktop tools + 1 skill), `omp-grok-build` and `zmarketplace` (commands, no tools).

**Not proven to be used by anyone in the corpus:** `jev_*` tools (0 calls), `kicad-design` skill (0 loads), `software-ios-native` (0 loads), `omp-grok-build` command (no transcript hit), `zmarketplace` command (no transcript hit).
