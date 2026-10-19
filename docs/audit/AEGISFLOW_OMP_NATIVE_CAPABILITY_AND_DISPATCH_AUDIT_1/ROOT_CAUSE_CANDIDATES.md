# Root cause candidates

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1` · READ-ONLY
Every item below is a *candidate* diagnosis with evidence, not a repair. The card authorises no mutation.

Class definitions (from the card): `INTEGRATION_DEFECT` · `CONFIGURATION_DEFECT` · `UPSTREAM_OMP_LIMITATION` · `UNUSED_BUT_VALID` · `REDUNDANT_CAPABILITY` · `NO_DEFECT` · `INSUFFICIENT_EVIDENCE`.

---

## A. `pi-jev` recommends a non-invocable command (`/skill:skill:<name>`)

**Class:** `INTEGRATION_DEFECT` (third-party plugin ↔ OMP API contract) · **Confidence:** CONFIRMED

**Mechanism**

1. `SkillRouter.getAvailableSkills()` prefers `getSystemPromptOptions().skills` when available, and otherwise falls back to `pi.getCommands()` filtered by `source === "skill"` (`pi-jev/src/skills.ts:45-79`).
2. OMP's command surface names skills with the prefix **already applied**: `name: getSkillSlashCommandName(skill)` ⇒ `skill:<name>` (`@oh-my-pi/pi-coding-agent/src/extensibility/extensions/get-commands-handler.ts:58`, `src/extensibility/skills.ts:609`).
3. The auto message template prepends another `/skill:`: `/skill:${s.name}` (`pi-jev/extensions/index.ts:171-176`).
4. OMP parses the name after `/skill:` verbatim and looks it up as `skill:<parsed name>` (`src/modes/skill-command.ts:56-68`, `src/extensibility/skills.ts:639-645`). For `/skill:skill:rust` that lookup is `skill:skill:rust`, which is not registered ⇒ `undefined` ⇒ no skill is loaded.

**Observed**

All four `jev-auto` messages on this host carry the doubled prefix:

```
2026-10-17T15:47:35Z  • /skill:skill:rust (P=0.73)
2026-10-18T00:11:39Z  • /skill:skill:rust (P=0.82)   • /skill:skill:code-review (P=0.68)
2026-10-18T05:32:04Z  • /skill:skill:rust (P=0.80)
2026-10-18T13:10:12Z  • /skill:skill:diagnosing-bugs (P=0.70)  • /skill:skill:wayfinder (P=0.67)
```

In every case the model ignored the literal command (one session loaded the same skill via `skill://` anyway). So the defect **degrades** Jev's only output channel; it does not break the agent.

**Why it is not `UPSTREAM_OMP_LIMITATION`:** OMP's naming is documented and self-consistent; the plugin assumed a different convention. A fix belongs in the plugin or in its call to OMP, not in OMP.

**Why it is not `CONFIGURATION_DEFECT`:** no setting on this host changes command naming; `enableSkillCommands` is on by default.

**Blast radius:** 4 suggestions / 82 prompts since install. Low frequency is not a defence — when it fires, it fires wrong.

---

## B. Jev's three tools are registered, discoverable, and never used

**Class:** `UNUSED_BUT_VALID` · **Confidence:** CONFIRMED for registration and visibility; UNKNOWN for desirability

**Mechanism.** `registerJevTools()` registers `jev_find_tools`, `jev_find_skill`, `jev_evaluate` with no explicit `loadMode`, so `defaultLoadModeForToolName` returns `"discoverable"` (`essential-tools.ts:45-50`). With `tools.xdev` on by default they are mounted as devices and do not appear in the top-level schema. Device listings in real sessions show `xd://jev_find_tools`, `xd://jev_find_skill`, `xd://jev_evaluate`.

**Evidence.** 0 calls in 1,735 sessions. Offline import registers all three plus 7 handlers, so loading is not the failure. The `xd://` mount is confirmed in the agent's own device listing.

**Interpretation, with the limits stated:**

- The tools are *reachable* but *not salient*: they are one `read xd://` away, and nothing in the system prompt advertises them beyond the catalog line. That is the intended cost model of `xd://`.
- Against that, `xd://` mounting is not a general barrier on this host: path-addressed devices were dispatched 903 times, led by `report_issue` 150, `find_roots` 134, `observe_ui` 121, and `mcp__kicad_run_erc` 28. Agents do use mounted devices when they need them.
- Conclusion: the correct label is *unused*, not *unusable*. Whether Jev should exist at all is an operator decision, not an audit finding.

**Secondary observation (not a defect on this host):** `PI_JEV_AUTO=1` is exported from `~/.zshrc`, so the auto pass runs only for shells that source it. The four messages prove it does run under at least some launches; whether it runs under every launch is `UNKNOWN`.

---

## C. `kicad-design` skill has never been loaded despite KiCad work

**Class:** `INSUFFICIENT_EVIDENCE` → leaning `NO_DEFECT` · **Confidence:** CONFIRMED counts, UNKNOWN cause

**Facts**

- The skill is rendered: its compressed description is in `skill-descriptions.db` ("Use for KiCad schematics, PCB layouts, footprints, symbols, and ERC or DRC.").
- The naming is not broken: the skills provider scans `~/.agents/skills/kicad-design/SKILL.md`, and the name derives from the directory.
- KiCad work did occur: 92 `xd://mcp__kicad_*` invocations across 17 distinct devices.
- Loads: 0.

**Candidate explanations**

1. KiCad sessions were run by a different agent surface (the KiCad MCP is also used outside OMP). Not testable from OMP transcripts alone.
2. The description matches "ERC or DRC" but the sessions that used the MCP may have been API-driven (board queries, exports) rather than design-from-scratch; the description's trigger vocabulary may not match those tasks. `INFERRED`.
3. Model-side selection failure. `UNKNOWN`.

No evidence supports a wiring defect (`REPAIR_CANDIDATE` would be wrong here). The card's own prior test showed a synthetic KiCad task *does* select `kicad-design`, so the wiring is demonstrably capable. What is unproven is selection on the real tasks that occurred.

---

## D. Native memory tools are configured but never called

**Class:** `UNUSED_BUT_VALID` · **Confidence:** CONFIRMED

`memory_retain`, `memory_recall`, `memory_reflect`, `memory_edit`, `learn`, `manage_skill` are all built-ins with `loadMode: discoverable` or essential, gated by settings and backend. Corpus calls: 0 each. Nothing indicates they are broken; they are either disabled by settings, unnecessary for the tasks run, or shadowed by session-level memory (compaction + context files). Recorded so that a future "CBM is our memory layer" claim is not mistaken for "OMP has no memory".

---

## E. CBM's marginal role

**Class:** `UNUSED_BUT_VALID` (mechanism) / `INSUFFICIENT_EVIDENCE` (value) · **Confidence:** CONFIRMED counts

One call in the whole corpus, on 2026-10-18, returning one record. The store holds 8 records with a clean lifecycle table and 0 conflicts. Under the governed launcher the tool does not exist at all (§F), so its addressable population is *ungoverned* sessions. It stays in the inventory as a proven mechanism with unproven value; the card's prior finding ("`UNAVAILABLE` because the test path had no checkout") is consistent with the extension's fail-closed design and is not a defect.

---

## F. The one-shot governed path removes every extension, skill and MCP surface

**Class:** `CONFIGURATION_DEFECT` — **only if** a governed run is expected to use those capabilities · **Confidence:** CONFIRMED

**Mechanism.** Both launcher paths pass `--tools <7 built-ins>`, but that flag sets `options.toolNames` only (`main.ts:1637-1641`); it does **not** set `restrictToolNames`, and extension tools are force-included into the active set regardless (`sdk.ts:4028-4044`). What actually removes the extension modules is the one-shot path's `--no-extensions` (`main.ts:1685-1687`), together with `--no-skills`, `--no-rules` and `--no-pty`. The interactive path passes neither, so it keeps skills, rules, `request_terminal_fence` and `cbm_query`, with only MCP project config off via the overlay.

A separate limit is CLI validation: `--tools` rejects any name outside the built-in catalog (`cli/args.ts:414-434`), so `--tools cbm_query` fails with `Unknown tool in --tools` (observed 2026-10-18T14:03). Extension tools therefore cannot be *explicitly allowlisted*; they are included automatically when discovery is on.

**Consequence.** A one-shot governed run cannot request a terminal fence, cannot consult CBM, cannot call KiCad MCP, and has no skills. An interactive governed run can use all of the extension tools. Whether that asymmetry is correct is an architectural decision the card does not make; what the card can state is that **a one-shot run's non-use of extension components is evidence about the launcher, not about the component**, and that the 38 pilot session files (only built-in tool names) demonstrate non-use rather than absence.

**Why this is not an OMP limitation:** OMP offers the allowlist, the discovery switch and the extension APIs; the narrowing is AegisFlow's choice.

---

## G. OMP gives no startup warning for an unusable model role

**Class:** `UPSTREAM_OMP_LIMITATION` · **Confidence:** CONFIRMED

The pre-repair failure mode was silent: `resolveRoleSelection(["smol"])` resolved a retired model, every compression call failed at transport layer, and the prompt degraded to 100-char previews while the session ran normally. 1,877 log warnings between 2026-10-15 and 2026-10-19 were the only evidence. After the repair, a *different* degradation path appears — 243 "compression unusable; keeping the preview" events — which is also non-fatal and non-blocking.

There is no startup probe that validates the `smol` role, and no session-level summary that a background capability is degraded. This is upstream behaviour, not a defect AegisFlow can fix without patching OMP (which it must not do). Recorded as an OMP limitation; the mitigation available to AegisFlow is operational (a log-line check), not architectural.

---

## H. Two different `MERGE_GATEWAY_API_KEY` values on disk

**Class:** `CONFIGURATION_DEFECT` (hygiene) · **Confidence:** CONFIRMED by fingerprint only

- `~/.omp/agent/.env` `MERGE_GATEWAY_API_KEY`: length 46, sha256 prefix `e2962c68414e`.
- `~/.omp/agent/models.yml` `providers.merge-gateway.apiKey`: length 46, sha256 prefix `7eecf55e928b`.

No full key is reproduced anywhere in this audit. Both are 46 bytes, so this is not a truncation; they are different credentials (or the same key rotated in one place only). No observed failure is attributable to it: `models.yml` is authoritative for the provider and the `default` role worked all through the corpus (the model id appears in `model_change`/`title-generator` lines with successful completions). The `.env` copy may be read by launchers that forward the environment.

Do not "fix" by copying one over the other without the operator deciding which is canonical. That decision is outside this card.

---

## I. OMP binary version exceeds the readable source on this host

**Class:** `NO_DEFECT` for the audit; a standing evidence limitation · **Confidence:** CONFIRMED

Binary 18.12.1; readable source 18.8.9. Every file:line citation in this audit is 18.8.9 mechanism. Where 18.12.x behaviour could differ, this audit prefers runtime artefacts. The `xd://` device model and `tool_call` fail-closed semantics are corroborated by 18.11.x/18.12.x transcripts and by the deploy-time drift check, so the mechanism claims used for conclusions are not solely source-derived. The `--tools` vs `restrictToolNames` distinction was verified statically in 18.8.9 plus the 18.12.1 binary's `restrictToolNames` symbol; the interactive-vs-one-shot difference is a source-level claim about flags the launcher passes, not a behavioural claim about a session this card ran.

Recommendation for future cards: vendor or cache the matching source when auditing, or cite transcripts instead of source. Not a defect to repair now.

---

## J. Historical tool-name drift in the pilot deny list

**Class:** `NO_DEFECT` (harmless) · **Confidence:** CONFIRMED

`lib/overlay.js` denies `retain`, `recall`, `reflect` while the built-in names are `memory_retain`, `memory_recall`, `memory_reflect`. Because the allowlist already excludes everything outside 7 names, the stale entries have no effect. Cleaning them up is a cosmetic change, not a repair; filing it as a defect would overstate it.

---

## 11. Ranked candidates

| Rank | Item | Class | Action implied by the card |
|---|---|---|---|
| 1 | A — Jev double-prefix recommendation | `INTEGRATION_DEFECT` | Report only. No repair authorised. |
| 2 | F — governed runs exclude all extension/MCP capability | `CONFIGURATION_DEFECT` | Architectural decision for the controller; report only. |
| 3 | B — Jev tools unused | `UNUSED_BUT_VALID` | Decide keep/retire later; not a repair. |
| 4 | H — two Merge API keys | `CONFIGURATION_DEFECT` (hygiene) | Per-card instruction: no immediate fix card; verify provenance and scope first. |
| 5 | G — no startup warning for dead model role | `UPSTREAM_OMP_LIMITATION` | Propose only; never patch OMP. |
| 6 | C — `kicad-design` never selected on real tasks | `INSUFFICIENT_EVIDENCE` | Needs a task-class study, not a code change. |
| 7 | D, E — native memory / CBM low use | `UNUSED_BUT_VALID` | No action. |
| 8 | I, J | `NO_DEFECT` | No action. |
