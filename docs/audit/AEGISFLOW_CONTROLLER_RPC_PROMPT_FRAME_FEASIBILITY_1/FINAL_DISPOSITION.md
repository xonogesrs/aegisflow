# Final disposition

**Card:** `AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1`
**Verdict:** `HOLD`
**Date:** 2026-10-20

```
CARD = AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1

VERDICT = HOLD

PREVIOUS_LANDING            = PASS
RPC_PROMPT_COMMAND_DISPATCH = PASS
ALTERNATIVE_HOST_CHANNEL    = NOT_FOUND

SESSION_BINDING    = PASS
GENERATION_BINDING = HOLD
AUTHORITY_GATE     = PASS

EXTENSION_COMMIT_OBSERVED = true
RESULT_OBSERVABILITY      = HOLD

PRODUCTION_MUTATION          = NONE
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false

INDEPENDENT_REVIEW = PASS
DURABLE_LANDING    = PASS

NEXT_ACTION = Authorize a minimal repair card covering R1 (durable generation
              identity), R2 (machine-readable commit result) and R5 (request-id
              frame correlation), then R3 (a controller client for `omp`).
              Only after those: Controller Provisioning. Do not open a closeout
              card.
```

---

## 1. The question, answered

> Can an OMP RPC prompt frame dispatch `/fence-generation` in the correct live
> session and yield a verifiable result?

**Dispatch: yes, proven.** A `{"type":"prompt","message":"/fence-generation PASS …"}`
frame reaches the extension's registered handler in the live session, and the
authority gate denies it without the controller marker. This is not an inference
from "RPC can send text" — it is a frame-level record of `commandAccepted`,
`commandDispatched`, `handlerExecuted` and `commitExecuted` as four separate
facts, plus a log record bearing the same session id the runtime reported.

**Verifiable result: no.** The commit result is not in the RPC response and not
correlated to the request anywhere else.

**Correct generation: no.** Generation is module memory keyed by session id;
a resumed process restarts at 1 under the same session id.

## 2. Why HOLD rather than PASS or FAIL

Not PASS: §12 requires result observability and session/generation binding.
Generation binding is refuted by measurement, and the result is off-wire.

Not FAIL: nothing in §12's FAIL list occurred. No authority was forged (the
agent's export was measured to have no effect on the running runtime); no tool
was used as a host controller; no commit landed on a wrong session; no receipt
was fabricated; no Hardening history was altered; no production mutation happened.

One measured fact is a **transport** risk rather than a card violation: code
running in-process can write a frame to fd 1 that a host parses as runtime
output (§2.5 T2 of [DIAGNOSIS](DIAGNOSIS.md)). It is recorded here, and as R5 in
[CONTROLLER_PATH_DECISION](CONTROLLER_PATH_DECISION.md), because it constrains
the controller client that the next card would build. It is not a path the
governed agent's own bash tool was measured to reach: with all three fd writes
confirmed, it injected neither a request nor a response frame. That is a measured
negative for one tool in one configuration, not a proof that no agent-reachable
path exists.

## 3. Evidence index

| Artifact | Contents |
|---|---|
| [DIAGNOSIS.md](DIAGNOSIS.md) | full static trace, all seven dispatch questions, isolated test results, observability matrix |
| [CONTROLLER_PATH_DECISION.md](CONTROLLER_PATH_DECISION.md) | path selection and the minimal repair boundary R1–R4 |
| [INDEPENDENT_REVIEW.md](INDEPENDENT_REVIEW.md) | fresh-session review of this record |
| `scripts/omp-rpc-fence-feasibility-probe.mjs` | reproducible harness; six cases, each writing a raw JSON record |

Reproduce:

```
node scripts/omp-rpc-fence-feasibility-probe.mjs dispatch --json
node scripts/omp-rpc-fence-feasibility-probe.mjs authority --json
node scripts/omp-rpc-fence-feasibility-probe.mjs binding --json
node scripts/omp-rpc-fence-feasibility-probe.mjs observability --json
node scripts/omp-rpc-fence-feasibility-probe.mjs trust --json
node scripts/omp-rpc-fence-feasibility-probe.mjs adapter --json
```

Each case spawns and terminates its own `omp --mode rpc` child in
`$TMPDIR/aegis-rpc-feasibility/<case>`, never touches the AegisFlow worktree or a
production session, and deletes its scratch tree first.

## 4. Scope discipline

- No change to `src/`, `test/`, `integrations/` or any launcher.
- No change to the extension under test — it was measured as shipped.
- No N1–N3 re-run; nothing in this card modifies what they cover.
- No Evolution, adversarial or E2 suite re-run, for the same reason.
- The only additions are one harness under `scripts/` and this audit directory.
- `OMP_TERMINAL_FENCE_AUTHORITY` was set only on processes this harness spawned,
  always labelled synthetic, never on a production or governed session.

## 5. Historical state preserved

```
ORIGINAL_GENERATION  = 1
ORIGINAL_COMMITTED   = false
GDR_1                = PROPOSED_NOT_APPROVED
CONTROLLER_AUTHORITY = NOT_PROVISIONED
NEW_CLOSEOUT_RECEIPT = NOT_ISSUED
HARDENING_BRANCH_CLOSED = false
```

This card does not approve GDR-1, does not close the branch, and does not issue
a receipt. A diagnosis landing PASS is not a controller feasibility PASS.
