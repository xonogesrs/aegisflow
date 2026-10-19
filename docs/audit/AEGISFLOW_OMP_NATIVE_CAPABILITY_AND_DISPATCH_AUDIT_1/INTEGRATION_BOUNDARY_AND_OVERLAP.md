# Integration boundary and overlap

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1` · READ-ONLY
Read with `OMP_NATIVE_DISPATCH_ARCHITECTURE.md` §2–§8 (mechanisms) and `AEGISFLOW_COMPONENT_INVENTORY.md` (evidence counts).

---

## 1. Boundary table — one row per interaction surface

| AegisFlow surface | Integrates through | Official OMP interface? | Overrides a native capability? | Extra model calls / latency / cost | Version fragility | Security effect |
|---|---|---|---|---|---|---|
| `no-poll-waits.js` waiter classifier | `tool_call` hook | yes — documented extension hook | no; it narrows `bash` admission | none (local regex/AST-free parse) | low; hook signature is stable across 18.8→18.12 | **positive** — prevents poll-driven stale wakes |
| `request_terminal_fence` | `registerTool` (`essential`) | yes | no | none | low | **positive** — one tool, read-only, no commit capability |
| `/fence-generation`, `/release-final` | `registerCommand` | yes | no | none | medium — command dispatch is host-channel-specific | **positive** — commit requires `OMP_TERMINAL_FENCE_AUTHORITY` |
| `cbm_query` | `registerTool` (`essential`) | yes | conceptually duplicates native `memory_*`, but those are settings-gated and unused here | one call per use | medium — imports `src/memory` internals across a checkout boundary | neutral (read-only, DATA-only, repository-scoped) |
| Governed launcher (`al-omp`) | separate process wrapper: `--tools`, `--config`; one-shot adds `--no-extensions`, `--no-skills`, `--no-rules`; isolated HOME, session dir | yes — CLI surface | **yes** — narrows built-ins to 7; one-shot additionally suppresses skills, extensions, rules and MCP project config | none | medium — flag semantics, not internals | **positive** — bounded vocabulary, but see §4 |
| Pilot overlay | `--config` YAML (`tools.approval` denies, `task.maxRecursionDepth: 0`, `retry.maxRetries: 1`) | yes | narrows `task`/`hub` and web/network tools | none | low | **positive** |
| AegisFlow core (`src/`) | none — different runtime (`pi` 0.84.4 / 1.3.0 shim) | n/a | n/a | none | n/a | out of OMP scope |
| `pi-extensions/search-scope-governor` | none (not installed into OMP) | n/a | would duplicate native search tools | none | n/a | none today |

**Summary:** AegisFlow integrates exclusively through documented OMP seams (`tool_call`, `registerTool`, `registerCommand`, CLI flags, config overlays). It does **not** patch OMP source, does not add a provider or router layer inside OMP, and does not rewrite the system prompt. `CONFIRMED` from source and from the deployed-vs-published drift check (0 DRIFT).

---

## 2. Overlap matrix

Legend: ● = real overlap in purpose · ○ = conceptual only · — = none.

| Purpose | Native OMP | AegisFlow | `pi-jev` | `omp-computer-use` | Verdict |
|---|---|---|---|---|---|
| Skill discovery / description | ● provider registry + compressor | — | ○ reads the same list for suggestions | — | native owns it; Jev is a redundant reader |
| Skill selection | ● model reads `<skills>` | — | ○ Noul probability + message | — | Jev **adds** a second, weaker channel; it does not replace the native one |
| Tool routing / activation | ● `xd://` deferral + tool list | — | ○ `jev_find_tools` / `activateTools` | — | Jev duplicates a capability OMP already has; 0 uses |
| Pre-execution command gate | ● `tool_call` hook (empty by default) | ● waiter policy + legacy-name denial | ● `ToolGuard` (off by default) | — | three implementations of one seam; only AegisFlow's is in production |
| Terminal / run completion | ● `agent_end`, `session_stop`, `AsyncJobManager` | ● fence request + controller commit | — | — | AegisFlow extends a native lifecycle event; it does not replace it |
| Memory | ○ native `memory_*` / `learn` (settings-gated) | ● CBM store + `cbm_query` | — | — | different stores, different authority models; no conflict observed |
| Subagents | ● `task` / `wait` | ● AegisFlow engine (out-of-band) | ● `AgentOrchestrator` (off by default) | — | overlap is **between runtimes**, not inside OMP |
| Desktop / browser control | ○ native `browser` / `computer` | — | — | ● 11 tools + 1 skill | plugin extends; both unused natively together |
| Typed judgments | ● native Judge (`judge` role) | — | ● TypeSafe Noul | — | two judges; Jev unused |
| MCP exposure | ● `mcp.json` + `xd://` | — | — | — | native only |
| Search scope policing | ○ no native analogue (search tools accept any eligible path) | ○ `search-scope-governor` **not installed** | — | — | unimplemented on this host |

No overlap in this matrix is a *conflict* in the registry sense: no two components register the same tool name, and no provider collision is observable (the 11-row skill cache is consistent with the 11 rendered skills).

---

## 3. Double-routing assessment

The card asks specifically whether AegisFlow introduces unnecessary double routing. Findings:

1. **No AegisFlow component re-routes OMP tool calls.** The two deployed extensions gate (`tool_call` → allow/block) and add tools; neither redirects execution to another model, provider or adapter. `CONFIRMED`.
2. **`pi-jev` does introduce a second routing pass**, and it is the only double routing on the host: one Noul evaluation per prompt (`PI_JEV_AUTO=1` in `~/.zshrc` since 2026-10-17), layered on top of native skill selection. Observed effect: 4 messages in 82 prompts, all with a non-invocable command string. Cost: one extra paid inference per prompt when the client is configured. `CONFIRMED` for the mechanism and frequency; exact per-call cost not measured (`UNKNOWN`).
3. **AegisFlow's governed launcher prevents any routing at all** by removing skills and extensions. This is not double routing, it is zero routing — a deliberate containment with a capability cost (§4).
4. **AegisFlow's own engine has a routing layer**, but it runs in the `pi` harness, not inside OMP. Calling it "double routing inside OMP" would be a category error. `CONFIRMED` from `docs/agent-integration.md`.

---

## 4. The one structural inconsistency worth naming

The governed launcher is the only AegisFlow component that changes what OMP can do, and it changes it in the opposite direction from the integration extensions:

| Run mode | Built-in tool set | Skills | Extensions (`request_terminal_fence`, `cbm_query`) | MCP | Rules |
|---|---|---|---|---|---|
| Interactive native `omp` | default | 11 rendered | loaded | `kicad` via `xd://` | loaded |
| `al-omp` interactive | 7 named built-ins (`--tools`) | loaded | **loaded** — extension tools are force-included | project config off (overlay); no ambient servers configured | loaded |
| `al-omp run` (one-shot) | 7 named built-ins (`--tools`) | **disabled** (`--no-skills`) | **not loaded** (`--no-extensions`) | project config off | **disabled** (`--no-rules`) |

`--tools` sets `options.toolNames` and nothing else (`main.ts:1637-1641`). It is **not** `restrictToolNames`, which only internal callers set (`commit/agentic/agent.ts`, `compress/session.ts`, `security/coordinator.ts`, `task/executor.ts`). Under a plain `--tools` list, extension-registered tools are still force-included into the active set (`sdk.ts:4028-4044`), so the interactive governed path keeps `request_terminal_fence` and `cbm_query` callable while exposing only seven built-in tools. `--no-extensions` (`main.ts:1685-1687`) is what removes the extension modules, and only the one-shot path passes it. The 38 pilot session files contain only the seven built-in names (116 calls), which is therefore *non-use*, not absence — no conclusion about extension reachability can be drawn from them.

This also corrects the earlier, over-broad reading in this draft: `--tools` restricts built-ins, `restrictToolNames` restricts everything, and the pilot's one-shot path gets the latter effect only because `--no-extensions` removes the modules before tool assembly.

Consequences, stated as facts rather than recommendations:

- A **one-shot** governed run cannot use `request_terminal_fence`: `--no-extensions` removes the module. Only the controller's `/fence-generation` command and the automatic `agent_end` leg remain — a coherent authority model for one-shot work, and the reason the fence tool's 605 calls are a property of interactive and ungoverned sessions.
- A **one-shot** governed run cannot use `cbm_query` or any MCP server. An **interactive** governed run can use both. The card's predecessor observed `UNAVAILABLE` from CBM in one isolated test path; the same tool answered `AVAILABLE` on its single real call, so that result reflects the test path, not a CBM defect.
- The overlay's deny list (`task`, `hub`, `web_search`, `browser`, `computer`, `github`, `generate_image`, `security_scan`, `checkpoint`, `rewind`, `retain`, `recall`, `reflect`, `memory_edit`, `learn`, `manage_skill`) names several tools that are **not** in the 7-name allowlist anyway. They are belt-and-suspenders, and `retain`/`recall`/`reflect` are not even the native names (`memory_retain`, `memory_recall`, `memory_reflect`). `CONFIRMED` by comparing `lib/overlay.js` to `BUILTIN_TOOL_NAMES`. Effect: none (the allowlist already excludes them); value: none.

None of this is a defect this card should repair. It is a boundary fact that any future "the agent didn't use X" conclusion must account for.

---

## 5. Fragility and coupling

| Dependency | Where | Risk | Evidence |
|---|---|---|---|
| `tool_call` hook contract | both AegisFlow extensions | **low** — stable from 18.8.9 through 18.12.1 in source; the hook is fail-closed on timeout | `extensions/runner.ts:1797-1862` |
| `AsyncJobManager` internals (`acknowledgeDeliveries`, `isDeliverySuppressed`) | `no-poll-waits.js` fence | **medium** — undocumented internals; a rename breaks suppression silently unless acceptance harnesses run | repo README "Known limitations"; extension comments |
| `pi.zod` schema builder on extension API | `cbm-query.js` | **low** — present in 18.8.9 and works today (probe) | probe |
| `--tools` validator accepting only built-in names | pilot + anyone allowlisting extension tools | **medium** — a governed run cannot name `cbm_query`/`request_terminal_fence`; the CLI errors `Unknown tool in --tools` | transcript 2026-10-18T14:03 |
| `skill:<name>` command naming | `pi-jev` | **medium** — Jev assumes unprefixed names; OMP returns prefixed ones | `get-commands-handler.ts:58` vs `src/skills.ts:81-180` |
| OMP binary version | everything | **medium** — binary moved 18.11.2 → 18.12.1 with no source tree at that version on this host | baseline §1 |
| AegisFlow `src/memory` module path | `cbm-query.js` | **low** — resolved by evidence with `UNAVAILABLE` fallback | extension header |

---

## 6. Direct answers to the boundary questions

| Question | Answer | Basis |
|---|---|---|
| Does AegisFlow use OMP's official extension interfaces? | **Yes, exclusively.** Hooks, `registerTool`, `registerCommand`, CLI flags, config files. No source patch, no vendored fork, no adapter shim inside OMP. | CONFIRMED |
| Does it override native functionality? | Only the **launcher**, which narrows capability (skills/extensions/rules/tools). No extension overrides a native tool by name. | CONFIRMED |
| Is there unnecessary double routing? | In AegisFlow: **no**. On the host: **yes, one** — `pi-jev`'s auto pass. | CONFIRMED |
| Extra model calls/cost? | AegisFlow: **none**. Jev: one Noul evaluation per prompt when configured (4 observed suggestions from 82 prompts; the request itself is not logged by OMP). | CONFIRMED for count of suggestions; cost `UNKNOWN` |
| Fragile version dependency? | Two named: fence's use of `AsyncJobManager` internals, and Jev's assumption about skill command naming. | CONFIRMED |
| Does it affect existing safety mechanisms? | It **adds** gates (waiter policy, fence authority). It never removes a native gate. The launcher's `--no-rules` removes rule files — a capability reduction, not a safety regression, but it is a real suppression. | CONFIRMED |
| Does AegisFlow re-implement something OMP already provides? | Inside OMP: no (two tools, one hook). Outside OMP: yes, substantially — subagents, sessions, memory, routing — but in a different runtime, which is the product's existing architecture, not a new finding of this card. | CONFIRMED |
