# New terminal receipt — NOT ISSUED

**Card:** `AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1`
**Closeout:** `AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1`
**Status:** `NOT_ISSUED`

```
RECEIPT                = NOT_ISSUED
CONTROLLER_COMMIT      = NOT_EXECUTED
committed              = n/a (no commit was attempted)
status                 = n/a
generation             = NOT_ASSIGNED
sessionId              = NOT_ASSIGNED
authority              = n/a
```

No `/fence-generation` command was dispatched. No governed process was started
with `OMP_TERMINAL_FENCE_AUTHORITY`. No agent-side `export` was performed, and no
child runtime was created to impersonate a Controller.

This file exists so that the absence of a receipt is itself a durable record
rather than an omission. It must not be pre-filled with a successful commit: a
fabricated or back-filled receipt is the FAIL condition named in card §10.

## Why nothing was issued

Both of the preconditions in card §7 are false:

| Precondition | Required | Actual | Evidence |
|---|---|---|---|
| `GOVERNANCE_ADMISSION` | `PASS` | `HOLD` | [`NEW_CLOSEOUT_ADMISSION.md`](NEW_CLOSEOUT_ADMISSION.md) §5 — existing contract binds closure to the original committed fence and requires explicit authorization to substitute |
| `CONTROLLER_AUTHORITY` | `VERIFIED` | `ABSENT` | [`CONTROLLER_PROVISIONING.md`](CONTROLLER_PROVISIONING.md) §2 — no shipped launcher sets the marker or supervises a commit |

A commit attempted under either condition would be exactly the outcome card §10
classifies as `FAIL` (unauthorized closeout declared, or authority self-granted).

## What a real receipt must contain, when one is legitimately issued

Recorded now as a schema, so a future card cannot weaken it:

```
committed          = true
status             = PASS
generation         = <NEW_GENERATION>
sessionId          = <NEW_SESSION_ID>
authority          = controller-command
closeoutId         = AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1
engineeringBaseline= d217383040b531dcefd01cc36ea2db14d6e66a1c
recoveryBaseline   = 4e41bb6412f2d795e0306318000428bce978369b
originalGeneration = 1
originalCommitted  = false
committedAt        = <ISO-8601, from the controller clock>
orderedSteps       = TERMINAL_COMMITTED → GENERATION_FENCED →
                     DELIVERIES_INVALIDATED → TERMINAL_GENERATION_STATE →
                     FINAL_DELIVERY_ALLOWED
logRef             = <controller log path + line for "terminal transition committed in order">
releaseResult      = <FINAL_DELIVERY_ALLOWED / release outcome, if applicable>
```

The receipt must name the original generation as uncommitted. It must never be
described as repairing or back-filling it.

## Current state of every relevant identity

```
ORIGINAL_SESSION_ID     = 01a15944-556f-7234-beed-b21fe74fd214   (runtime exited; PID 6407 gone)
ORIGINAL_GENERATION     = 1
ORIGINAL_COMMITTED      = false
NEW_SESSION_ID          = NOT_ASSIGNED
NEW_GENERATION          = NOT_ASSIGNED
HARDENING_BRANCH_CLOSED = false
```
