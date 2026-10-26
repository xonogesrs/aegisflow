# Deployment change plan

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Subject:** the minimal, reversible change set that installs the R3 controller
client into the environment described in
[`PRODUCTION_BASELINE_MANIFEST.md`](PRODUCTION_BASELINE_MANIFEST.md).
**Status:** PLAN ONLY. Nothing in this document was executed against production.

The plan is written as six independent change records. Each has its own
`CURRENT_STATE`, `PROPOSED_STATE`, `DEPENDENCIES`, `RISK`, `VALIDATION` and
`ROLLBACK`, because a deployment that must be reversible cannot be one blob: the
operator has to be able to stop after any record and still be in a defined state.

---

## 0. What the delta actually is

Two different questions get two different answers, and conflating them was a
defect in the first draft of this document (found in independent review):

**(a) What the repository changed between the deployed extension's revision and
R3.** `git diff --numstat fb8ce6a..2fa42d6` over the deployable surface:

| File | +/− | Deploys? |
|---|---|---|
| `integrations/omp/extensions/no-poll-waits.js` | +929 / −64 | **yes** (replaces the deployed copy) |
| `integrations/omp/extensions/cbm-query.js` | +107 / −53 | **yes**, but the live copy is already this revision |
| `integrations/omp/extensions/lib/controller-result.mjs` | +247 / −0 | **yes** (new file) |
| `integrations/omp/extensions/lib/runtime-identity.mjs` | +693 / −0 | **yes** (new file) |
| `integrations/omp/extensions/lib/ledger-lock.mjs` | +389 / −0 | **yes** (new file) |
| `integrations/omp/extensions/test/controller-contract.acceptance.ts` | +1714 / −0 | yes, test-only |
| `src/control-plane/controller-client.mjs` | new, 1280 lines | **no** — it is the *caller*, not the runtime |
| `scripts/*`, `test/*` | harness | no |

**(b) What an install actually writes into THIS deployment.** The live
`cbm-query.js` is already `03c08f43…`, which is the R3 revision
(`1ebb121 feat(ekm): name the first-party memory tool ekm_query`). The installer
therefore classifies it `unchanged`, not `replace`. Measured by `install --json`:

```
no-poll-waits.js           replace   (backup taken)
cbm-query.js               unchanged
lib/poll-wait-policy.js    unchanged
lib/controller-result.mjs  copy
lib/runtime-identity.mjs   copy
lib/ledger-lock.mjs        copy
test/poll-wait-policy.test.mjs                unchanged
test/waiter-fence.acceptance.ts               unchanged
test/terminal-fence-authority.acceptance.ts   unchanged
test/terminal-fence-ordering.acceptance.ts    unchanged
test/controller-contract.acceptance.ts        copy
```

So the **runtime** delta for this host is four files — one replacement and three
additions — plus one test file. `cbm-query.js` appears in the repository diff but
is not a live change; the EKM rename landed on this branch before R3 and was
already deployed. The `no-poll-waits.js` insertion count is **+929**, not the
+993 that a `main..HEAD` stat reports.

The installer's `KNOWN_FILES` is the authoritative deployment surface, and it
lists exactly these plus the pre-existing files. `src/control-plane/` is **not**
in it: the controller client is run by an orchestrator, not loaded by OMP.

**The production extension and config are not edited by hand at any point.**
`scripts/install-omp-integration.mjs` is the only writer, and it copies exactly
`KNOWN_FILES`, backs up every byte it replaces, and emits a machine-readable
record that the rollback consumes.

---

## CHG-1 — Controller client (orchestrator side)

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-1 |
| `CURRENT_STATE` | `src/control-plane/controller-client.mjs` exists in the repository at `2fa42d6`. No production process imports it; no orchestrator invokes it. |
| `PROPOSED_STATE` | The same file, run from the repository checkout by whatever orchestrator launches a governed task: `node --input-type=module -e 'import(...)'` or a small runner. **Not** installed into `~/.omp/agent/extensions`; it is not an extension. |
| `DEPENDENCIES` | CHG-3 (state dir) and CHG-4 (authority) must exist before a governed launch can succeed; the client refuses without them. |
| `RISK` | LOW for OMP itself: an unused file cannot change runtime behaviour. MEDIUM for the orchestrator, because a caller that passes a caller-supplied `env` with the marker is refused (`AUTHORITY_INHERITED`) — this is by design and will look like a launch failure to an unaware caller. |
| `VALIDATION` | `node --check src/control-plane/controller-client.mjs`; then an isolated launch exactly as the rehearsal does (private HOME, inert provider). The rehearsal's `CONTROLLER_VALID_COMMIT` fact is the acceptance. |
| `ROLLBACK` | Delete nothing from production — it was never installed there. On the orchestrator side, stop invoking it. |

**Explicit non-goal:** this card does not install an orchestrator. Nothing today
calls the client in production, and the admission does not require one.

## CHG-2 — Extension tree (the only production write)

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-2 |
| `CURRENT_STATE` | `~/.omp/agent/extensions/no-poll-waits.js` = `11d8628b…f8ef` (the `fb8ce6a` revision). `lib/` holds only `poll-wait-policy.js`. |
| `PROPOSED_STATE` | `no-poll-waits.js` = `30336801…687e`; `lib/controller-result.mjs` = `365df82c…d21c`; `lib/runtime-identity.mjs` = `170f02c0…5d3a`; `lib/ledger-lock.mjs` = `97e70547…5f72`; `test/controller-contract.acceptance.ts` added. `cbm-query.js`, `lib/poll-wait-policy.js` and the four existing test files are byte-identical and untouched. |
| `DEPENDENCIES` | None. The new extension imports its new siblings; all four files must land together or the module fails to load (measured: a missing sibling prints `Failed to load extension … Cannot find module './ledger-lock.mjs'` and OMP continues **without** the extension). |
| `RISK` | **MEDIUM.** This is the only change that touches a path the running OMP reads. Two concrete hazards, both measured in the rehearsal: (a) a partial copy silently disables the extension rather than failing the start; (b) discovery would load any `.js`/`.ts`/`index.js`/`package.json` dropped into the tree, so the directory must stay exactly as installed. |
| `VALIDATION` | `node scripts/install-omp-integration.mjs check --strict-bytes` must report `MATCH` for all 11 known files, and `install --json` must report `deployedSha256` equal to the four values above. |
| `ROLLBACK` | CHG-2 is reversed by `scripts/omp-rollback-integration.mjs <install-record.json>`, which restores the `replace` backup byte-for-byte, deletes the four `copy` files, leaves the `unchanged` files alone, and removes directories the install created. Measured in the rehearsal: `ROLLBACK:byte-identical-restore = true`. **`uninstall` is not a rollback** — it restores the backup and then deletes `lib/poll-wait-policy.js`, leaving a tree whose extension cannot import its own dependency. |

## CHG-3 — Ledger state directory

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-3 |
| `CURRENT_STATE` | No state directory exists. `OMP_TERMINAL_FENCE_STATE_DIR` is unset everywhere. |
| `PROPOSED_STATE` | One directory per **session**, outside `~/.omp`, mode `0700`, owned by the operator, on the same host as the runtime. The client's `prepareControllerRoot` creates it and refuses a root that is group/other-accessible. |
| `DEPENDENCIES` | CHG-4. Without the marker the directory is never written (measured: `statedir-no-authority` leaves it absent). |
| `RISK` | **MEDIUM, and the risk is topological, not cryptographic.** The ledger is per-session, so two controllers with two different state directories can each durably commit generation 1 of the *same* session. Measured: `C2:separate-state-dirs-cannot-double-commit = FAIL`, both `COMMITTED`, both generation 1. Exclusivity holds only when every controller of a session uses the **same** directory. |
| `VALIDATION` | `stat -f '%Sp' <dir>` is `drwx------`; a lock acquire/release round trip; the rehearsal's `LEDGER_EXCLUSIVITY` fact (6 processes × 3 rounds, exactly one winner and one record). |
| `ROLLBACK` | Remove the directory after preserving it as evidence. It is out-of-tree, so no OMP state depends on it. |

**Deployment restriction, stated as a requirement:** exactly one state directory
per session, and exactly one controller per session at a time. A deployment that
gives two orchestrators separate directories for one session has no
double-commit protection at all, because the protection is per ledger file.

## CHG-4 — Controller authority marker

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-4 |
| `CURRENT_STATE` | `OMP_TERMINAL_FENCE_AUTHORITY` is set by nothing. Every commit path is closed on every ordinary start. |
| `PROPOSED_STATE` | Set **only** in the environment of a process the controller launched, by the controller itself, together with `OMP_TERMINAL_FENCE_STATE_DIR`, `OMP_CONTROLLER_RESULT_KEY_FILE` and `OMP_CONTROLLER_RESULT_TRANSPORT=stdout`. Never in `~/.zshrc`, never exported globally, never in `config.yml`. |
| `DEPENDENCIES` | CHG-1, CHG-3. |
| `RISK` | **HIGH — see the C1 finding.** The marker is inherited by every child the governed agent spawns, including its `bash` tool. A child that re-invokes `omp` therefore inherits authority. Measured: a nested `omp` started from the agent's bash obtained controller authority and landed a durable commit record. |
| `VALIDATION` | The rehearsal's `CONTROLLER_AUTHORITY_DENIAL` fact on an ordinary start (signed denial, no ledger write), plus the C1 facts. |
| `ROLLBACK` | Unset the variable in the controller's launch environment; no file changes. |

## CHG-5 — Orchestrator / AutoLoop wiring

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-5 |
| `CURRENT_STATE` | `al-omp` dispatch is OFF; its interactive path runs discovery (no `--no-extensions`); it sets no marker and issues no fence command. |
| `PROPOSED_STATE` | **No change proposed by this card.** Turning AutoLoop ON, or teaching it to issue `/fence-generation`, is a separate decision with its own blast radius, and it is not required to install R3. |
| `DEPENDENCIES` | CHG-2…CHG-4 if it is ever attempted. |
| `RISK` | If AutoLoop were switched ON without CHG-3/CHG-4, its interactive sessions would load the R3 extension *ungoverned*: the new commands exist and deny, and nothing else changes. That is inert, and the rehearsal measures it (`C1:ordinary-start-loads-dropped-module` shows discovery is live; the inertness probe shows every new command denies). |
| `VALIDATION` | `al-omp is-on` must still exit non-zero after the deployment; `al-omp status` must still read `native`. |
| `ROLLBACK` | Not applicable — nothing changes. |

## CHG-6 — CBM and MCP

| Field | Value |
|---|---|
| `CHANGE_ID` | CHG-6 |
| `CURRENT_STATE` | `mcp.json` and the CBM daemon are as recorded in the baseline. |
| `PROPOSED_STATE` | **Unchanged.** The R3 delta does not touch `mcp.json`, the CBM binary, its cache or `cbm-query.js`. |
| `DEPENDENCIES` | none |
| `RISK` | none introduced. The rehearsal confirms `ekm_query` is still offered and the deprecated `cbm_query` alias stays inactive. |
| `VALIDATION` | `CBM_ROUTING` fact, plus `sha256` equality of `mcp.json` and `cbm-query.js` before/after. |
| `ROLLBACK` | not applicable |

---

## Ordering, and the atomic boundary

The only genuinely atomic unit is **CHG-2**: the four files must appear together,
because the extension imports them at load. The installer already does this file
by file with temp+rename per file; it is not atomic *across* files, so the
operator must run `install` and then `check --strict-bytes` before declaring the
step done. If `check` reports `MISSING` for any of the three new `lib/` modules,
the deployment is in the partial state the rehearsal reproduced: the extension
fails to load and OMP silently runs without it.

Correct order:

```
1. CHG-3  create the per-session state directory (0700, same host)
2. CHG-2  install the extension tree, then check --strict-bytes
3. CHG-1  wire the orchestrator to the controller client
4. CHG-4  let the orchestrator provision the marker per launch
```

CHG-4 last, deliberately: until the marker exists, the installed extension is
inert, so a mistake in CHG-1 or CHG-2 has no authority consequence.

## What this plan does not claim

- It does not claim the four accepted residual risks are acceptable for
  production. That is [`RESIDUAL_RISK_DISPOSITION.md`](RESIDUAL_RISK_DISPOSITION.md).
- It does not claim activation is approved. `PRODUCTION_ENABLEMENT = false`,
  `OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED`.
- It does not propose copying the rehearsal's private HOME or the test
  configuration into production. The production config hashes in the baseline
  are the ones to keep.
