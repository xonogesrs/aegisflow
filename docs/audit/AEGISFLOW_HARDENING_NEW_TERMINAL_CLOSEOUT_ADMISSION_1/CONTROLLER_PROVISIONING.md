# Controller authority provisioning — analysis and minimal proposal

**Card:** `AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1`
**Phase:** B (analysis only; no provisioning performed)
**Result:** `CONTROLLER_AUTHORITY = ABSENT` — no launcher in this repository
provisioning set sets the marker or supervises a commit, and the original
session's runtime carried neither. This is a statement about what the shipped
launchers do and about the sessions they produced, not a claim that no process
anywhere sets the variable.

This document is read-only analysis. It set no environment marker, started no
governed process, and dispatched no command.

---

## 1. The mechanism, from source

| Fact | Evidence |
|---|---|
| The capability is a process environment marker | `integrations/omp/extensions/no-poll-waits.js:169` `AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY"` |
| Presence test: non-empty string | `…:312-315` `controllerAuthorityPresent()` |
| Commit is denied without it, fail closed, generation stays active | `…:366-381` `commitTerminalFence()` → `denial:"CONTROLLER_AUTHORITY_ABSENT"` |
| Only `/fence-generation` reaches the commit | `…:807` `pi.registerCommand(COMMIT_COMMAND, …)`; handler resolves `ctx.sessionManager.getSessionId()` and commits the **current** generation |
| Agent tool cannot commit | `…:780-798` `request_terminal_fence` execute returns `details: { op:"request_terminal_fence", committed: false }` unconditionally; `…:330-341` `requestTerminal()` only appends to `state.terminalRequests` |
| Generation state is module memory | `…:173-215` `const sessions = new Map()`; `stateFor()` creates `generation:1` on first access |
| No persistence / no historical query | no serialization, no load hook, no receipt store in the module; `waiterStateSnapshot()` reads current process state only |
| Ordered transition is one synchronous body | `…:415-475` `commitOrderedTerminal()` — `TERMINAL_COMMITTED → GENERATION_FENCED → DELIVERIES_INVALIDATED → TERMINAL_GENERATION_STATE → FINAL_DELIVERY_ALLOWED` |

Consequences that matter for this card:

1. A commit is bound to the **live** session and its **current** generation. There
   is no target-session or expected-generation parameter, so it cannot address a
   past generation even in principle.
2. A resumed transcript creates fresh module state at generation 1. Committing
   there would attribute a new runtime event to an old generation — the exact
   forgery this card forbids.
3. The marker is not derivable from model output, is not a tool, and is not
   readable as one. Any agent-side `export` would be a self-grant, not
   provisioning.

## 2. Every launcher in scope, audited

| Launcher | Where | Provisions the marker? | Supervises a commit? |
|---|---|---|---|
| `scripts/pi-aegisflow.sh` | repo | **No** — resolves repo root, `cd`, `exec pi --approve "$@"` (32 lines total) | **No** |
| `scripts/pi-autoloop.sh` | repo | No — verbatim forwarder to the above | No |
| `al-omp` pilot | `…/autoloop-omp-pilot` | No by default. Its child env is an explicit allowlist (`PATH`, `TMPDIR`, `LANG`, `HOME`, `AUTOLOOP_OMP_ACTIVE`, optionally `MERGE_GATEWAY_API_KEY`) plus `opts.extraEnv` — `lib/launcher.js:131-138`, `:402-410` | **No** — it launches bounded one-shot runs and never submits a prompt command |
| `pi-rpc-adapter` | `src/adapter/pi-rpc-adapter.mjs` | **No by default**: `DEFAULT_ENV_ALLOWLIST = ["PATH","HOME","TMPDIR","LANG","LC_ALL","TERM"]` (`:31`), `buildChildEnv()` copies only allowlisted keys (`:41-47`). The allowlist is a caller-supplied option (`:199` `environmentAllowlist = DEFAULT_ENV_ALLOWLIST`), and one caller does widen it: `src/subagent/subagent-graph-runner.mjs:956-960` appends `providerBinding.value.requiredEnvKeys`. That widening is derived from the admitted provider binding, and no caller adds `OMP_TERMINAL_FENCE_AUTHORITY` | No |

A repository-wide search for the marker and for the command name finds only the
extension, its acceptance tests, and documentation:

```
integrations/omp/extensions/no-poll-waits.js
integrations/omp/extensions/test/{terminal-fence-authority,terminal-fence-ordering,waiter-fence}.acceptance.ts
docs/{agent-integration,operations,troubleshooting}.md
integrations/omp/README.md   SECURITY.md   README.md
```

No production entry point sets it, and no production entry point issues
`/fence-generation`.

Two qualifications, because they bound what this table proves:

- **Absence of provisioning, not absence of every environment.**
  `scripts/pi-aegisflow.sh:32` is `exec pi --approve "$@"`; it neither sets nor
  sanitizes the environment, so it inherits whatever launched it. The measured
  fact is that the sessions it produced carried no marker — the original
  session's env was empty of `OMP_TERMINAL_*` (recovery report §6, and re-checked
  for this card) — not that the shell can never contain one.
- **Out-of-repo launchers are cited, not audited here.** The `al-omp` pilot lives
  at `/Volumes/NVM2T/Development/autoloop-omp-pilot`; its child-env construction
  is read at `lib/launcher.js:131-138` and `:402-410`. That tree is outside this
  repository, so those two citations are the evidence, not a repository-wide
  proof.

## 3. What the operator contract already restricts

- `docs/operations.md:189-191`: grant the marker **only** in the environment
  that launches a governed process, and only when that orchestrator will actually
  issue `/fence-generation`.
- `SECURITY.md:181-200`: the commit is authority-relevant; the marker is
  launcher-supplied and "not a capability an agent can obtain".
- `integrations/omp/README.md:183-188` shows the intended shape:
  `OMP_TERMINAL_FENCE_AUTHORITY=1 omp --mode rpc …` then `/fence-generation PASS …`
  on the host channel.

So the contract is clear about the *shape* of a Controller. What is missing is an
*implementation*: nothing in this repository is that orchestrator, and the one
interactive launcher is explicitly documented as not being one
(`FINAL_DISPOSITION.md:19`).

## 4. What this card did not do

The following were considered and rejected as out of bounds:

| Rejected action | Why |
|---|---|
| `export OMP_TERMINAL_FENCE_AUTHORITY=1` in an agent shell | Self-grant. The docs classify any claim that an agent holds this as a defect, not a feature (`integrations/omp/README.md:172-176`). |
| Spawning a child `omp` with the marker injected, then calling it a Controller | The marker would come from agent-controlled input. The commit would prove nothing about trusted supervision. Forbidden by card §5. |
| Resuming the original session JSONL and committing | Fresh Map at generation 1 → misattributes a new fence to original generation 1. Recovery report §5 already rejected this (`PATH A`). |
| Driving `pi --mode rpc` from inside this session as a "controller" | Same defect with extra steps: the authority would still be agent-originated, and the new session would be agent-spawned rather than launcher-supervised. |
| Implementing a Controller now | Card §5/§11 limit this card to a **minimal repair proposal**, and Phase B is contingent on Governance Admission, which is HOLD. |

## 5. Minimal provisioning proposal (not implemented, not authorized)

Scope discipline: this is a proposal for a separately authorized card. It is
deliberately small — no OMP architecture change, no second policy authority, no
new daemon.

**P-1 — a single Controller entry point.** One script
(`scripts/omp-controller.mjs`) that owns the governed process end to end:

1. builds the child environment itself, including
   `OMP_TERMINAL_FENCE_AUTHORITY=1`, and passes no agent-supplied env through;
2. takes the expected identity as **required** inputs
   (`--closeout-id`, `--expected-session-id`, `--expected-generation`) and
   refuses to commit if the live runtime disagrees;
3. submits `/fence-generation <STATUS> "<reason>"` on the host channel — the RPC
   prompt frame, not a shell command — only after reading back the live
   session/generation from the same runtime;
4. writes the receipt (`committed`, `status`, `generation`, `sessionId`,
   `authority`, timestamps, ordered-step stamps) to a path outside the agent's
   writable scope, exclusive-create, never overwritten;
5. exits non-zero on `committed:false`, identity mismatch, or authority denial,
   without retrying.

**P-2 — expected-identity guard.** The missing piece the current command cannot
express: `/fence-generation` has no expected-generation argument, so a Controller
must verify identity **before** submitting and re-verify the receipt **after**.
P-1 item 2 does this at the launcher, which needs no extension change. Adding an
optional expected-generation argument to the command would be a second repair and
is not proposed here.

**P-3 — receipt durability.** The extension has no receipt store. P-1 writes the
receipt from the Controller side, which is where the authority lives. No
extension change is required for the card's purposes.

**P-4 — verification.** Acceptance must include: marker absent → denial; marker
present but wrong session → refusal; correct identity → `committed:true`; receipt
readable by an independent reviewer; original generation untouched.

**Scope of this proposal's evidence.** P-1…P-4 are a design sketch, not a
feasibility proof. They are derived from the extension's source and from the
documented RPC launch shape (`integrations/omp/README.md:183-188`); no Controller
was built, no prompt frame was submitted, and no receipt path was exercised. The
one open technical question a future card must answer first is whether the RPC
prompt frame can carry `/fence-generation` for a *live* session and return the
extension's own commit result — that is unverified here.

Explicitly **not** proposed: persisting generation state across processes,
recovering expired generations, or giving the extension a historical receipt
store. Those would change the runtime's authority model to solve a governance
problem.

## 6. Conclusion

```
CONTROLLER_AUTHORITY      = ABSENT
CONTROLLER_COMMIT         = NOT_EXECUTED
RECEIPT                   = NOT_ISSUED
PROVISIONING_PATH         = NOT_IMPLEMENTED (proposal P-1…P-4 only)
BLOCKING_CONDITIONS       = (1) GOVERNANCE_ADMISSION = HOLD
                            (2) no trusted Controller implementation exists
```

Both blockers are structural, not incidental. Neither can be cleared from inside
an agent session, and clearing either one is out of this card's scope.
