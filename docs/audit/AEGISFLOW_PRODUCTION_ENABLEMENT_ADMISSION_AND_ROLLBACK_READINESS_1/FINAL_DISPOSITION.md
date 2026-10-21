# Final disposition

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Branch:** `feat/omp-cbm-recovery`
**Canonical remote:** `origin` (the AegisFlow repository)
**Date:** 2026-10-21

```
CARD = AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1

VERDICT = HOLD

PREVIOUS_LANDING = PASS
MODEL_IDENTITY   = PASS

PRODUCTION_BASELINE     = PASS
DEPLOYMENT_CHANGE_PLAN  = PASS

IN_PROCESS_FORGERY_BOUNDARY  = FAIL
PER_SESSION_LEDGER_BOUNDARY  = PASS (with restriction)
REQUEST_ID_BOUNDARY          = PASS (with restriction)
NON_DURABLE_FENCE_BOUNDARY   = PASS (with restriction)

ISOLATED_DEPLOYMENT_REHEARSAL = PASS (36/40 facts; the 4 failures are the C1/C2 findings)
REGRESSION_READINESS          = PASS
ROLLBACK_REHEARSAL            = PASS

INDEPENDENT_REVIEW = HOLD   (8 findings: 3 HIGH, 5 MEDIUM — all resolved; see INDEPENDENT_REVIEW.md)
DURABLE_LANDING    = PENDING (this file is committed and pushed after the review)

PRODUCTION_MUTATION   = NONE
PRODUCTION_ENABLEMENT = false

GDR_1_APPROVED                = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false

OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED

NEXT_ACTION = Owner decides between (a) a C1 repair card — per-command
              authority instead of an inherited marker, plus an authenticated
              ledger — and re-admission, or (b) an explicit scope decision to
              deploy the extension with controller authority permanently
              unprovisioned. GDR-1 is a separate hardening-closeout decision
              and is not advanced here.
```

---

## 1. Phase 0 — predecessor landing gate

Run in `/private/tmp/aegis-repair-1` before any admission work. **What is and is not
retained:** no timestamped transcript of that first run was captured, so the
*timing* claim ("before any admission work") is a statement about this session's
own ordering, not an artifact a third party can audit. What IS independently
checkable now, and was re-verified at the end of the card, is that the refs hold
the values below. Independent review raised exactly this distinction and it is
kept rather than papered over.

```
git status --porcelain=v1            (empty)
git branch --show-current            feat/omp-cbm-recovery
git rev-parse HEAD                   2fa42d63da885700425b54bdf38134ddfadd5691
git rev-parse '@{upstream}'          2fa42d63da885700425b54bdf38134ddfadd5691
git ls-remote --heads origin feat/omp-cbm-recovery
                                     2fa42d63da885700425b54bdf38134ddfadd5691  refs/heads/feat/omp-cbm-recovery
git log '@{upstream}'..HEAD --oneline (empty)
git stash list                        (empty)
```

`LOCAL = UPSTREAM = CANONICAL_REMOTE`, worktree clean, zero unpushed commits,
zero stashes. Compared on the full SHA. Re-checked at the end of the card: HEAD
and upstream are still `2fa42d6`, and the only working-tree entry is the untracked
audit directory this card adds. No reset, clean, force-push or stash drop
was used at any point in this card.

## 2. Why `HOLD`

Card §12 says `HOLD` when "necessary evidence is insufficient, a deployment
restriction is unclear, rollback is unverified, or the Reviewer found a blocking
problem". Here the blocking problem is not an evidence gap — it is a measured
breach of the boundary the card asks about:

```
C1:forged-record-not-believed        FAIL  COMMITTED
C1:legit-commit-still-succeeds       FAIL  DENIED / GENERATION_ALREADY_COMMITTED
C1:agent-cannot-modify-loaded-module FAIL  module bytes changed by a same-uid write
C2:separate-state-dirs-cannot-double-commit FAIL  both COMMITTED, both generation 1
```

Under a governed launch the agent's own `bash` inherits
`OMP_TERMINAL_FENCE_AUTHORITY` and `OMP_TERMINAL_FENCE_STATE_DIR`. It can append a
commit record for its parent's generation; the durable probe believes it, and the
extension's commit gate — which matches on `(type, generation, session)` — refuses
the legitimate controller's commit as `GENERATION_ALREADY_COMMITTED`. The
signing key is *not* reachable (the extension unlinks it at load and the measured
`ls` fails), so frame forgery stays closed. The durable state does not.

This is not a defect the R3 card concealed: R3's stated boundary is "a module
inside the attested set is inside the TCB", and it says so plainly. The
deployment adds a party inside the attested set's uid, with a shell, and R3's
argument does not extend to that party's write access to the controller's ledger.

## 3. Why not `FAIL`

`FAIL` in this card means an unauthorized production change, an authority bypass
that reached production, a wrong commit, a forged result that was accepted, or
broken existing service. None occurred:

| Test | Result |
|---|---|
| production extension bytes before/after | identical (`11d8628b…f8ef`) |
| production `config.yml` / `mcp.json` before/after | identical (`108ca03c…8d66`, `032839c1…67d4`) |
| production OMP binary before/after | identical (`f2a657b3…6ec5`, `omp/18.12.3`) |
| production ledger created | none |
| production session used as a test subject | none |
| production OMP process stopped or restarted | none |
| authority marker set anywhere in production | none |
| AutoLoop dispatch state | `native`, unchanged |
| repository code changed | none — documents and read-only probes only |

The forged commit was accepted by an **isolated** controller in a scratch
directory, which is exactly the environment the card authorized for testing. That
is a finding, not a production incident.

## 4. What passed, with the evidence

| Claim | Where |
|---|---|
| production baseline, all observed values | `PRODUCTION_BASELINE_MANIFEST.md`, `evidence/production-baseline.txt` |
| the delta: six repo files, four runtime files plus one test on this host | `DEPLOYMENT_CHANGE_PLAN.md` §0 |
| install/rollback is reversible and measured | `ROLLBACK_RUNBOOK.md` §7 |
| ten ordinary OMP functions still work, with the extension loaded | `ISOLATED_REHEARSAL_EVIDENCE.md` §2.1 |
| the controller mechanism works in this environment | §2.2 |
| the four residual risks, adjudicated for deployment | `RESIDUAL_RISK_DISPOSITION.md` |
| day-of checks, with abort conditions | `ACTIVATION_SMOKE_CHECKLIST.md` |
| independent review: HOLD, eight findings, all resolved | `INDEPENDENT_REVIEW.md` |

## 5. Model identity

`MODEL_IDENTITY = PASS`. The executing model was
`merge-gateway/deepseek/deepseek-v4.1-flash-1017` throughout, as declared by the
session; no model substitution occurred mid-card, and the reviewer session is
declared separately in `INDEPENDENT_REVIEW.md`.

## 6. What this card did not decide

- It did not approve activation. `PRODUCTION_ENABLEMENT = false`,
  `OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED`.
- It did not implement any C1 repair. The repairs are proposals, named and
  bounded, for a separately authorized card.
- It did not touch GDR-1, the original generation, or the hardening branch
  closure. `GDR_1_APPROVED = false`, `ORIGINAL_GENERATION_COMMITTED = false`,
  `HARDENING_BRANCH_CLOSED = false`.
