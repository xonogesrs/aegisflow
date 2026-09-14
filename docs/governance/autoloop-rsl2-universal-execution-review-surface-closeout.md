# AUTOLOOP — RSL2 UNIVERSAL EXECUTION REVIEW SURFACE CONVERGENCE + FINAL CLOSEOUT

Status: `PASS / RSL2_UNIVERSAL_EXECUTION_REVIEW_SURFACE_CLOSED`
Established: 2026-08-22
Branch: `governance/rsl2-universal-execution-review-surface`
HEAD before: `eb2fac147821569dcfbbd177f304eb794de831ea`
Method: 6 parallel read-only discovery tracks (canonical contract / implementation
surface / bypass-adversarial / authority fence / tests map / review-artifact
semantics) → primary-agent reconciliation → minimal repair → adversarial +
regression verification.
This record is additive; it rewrites no historical document.

## 1. Canonical lineage restated

`RR1 → P4 PASS Oracle → Post-P4 Convergence (Truth Revocation) → RevArt
RC1A/RC1B/IMPL1/RC2 → RSL1 (two-authority surface split) → RSL2 (universal
execution review publication)`.

RSL2 implementation landed on this branch at `583acb9` (feat(rsl2): universal
execution review surface (Latest) + admission-derived barrier) and `c9226bd`
(docs(rsl2): route execution-review handoff to fixed Latest surface); both are
ancestors of the closeout HEAD. Post-split realignment
(`autoloop-post-split-canonical-realignment.md`) is incorporated by reference:
Standalone AutoLoop = canonical; AuraCore shadow = non-canonical integration
lineage with zero successor obligation.

## 2. Requirements matrix (final)

`RSL2_REQUIREMENTS_TOTAL = 13` — all `PROVEN`, none PARTIAL/MISSING.

| ID | Requirement | Canonical source | Implementation seam | Direct proof | Status |
|---|---|---|---|---|---|
| R2-01 | Universal publication: every formal execution publishes Domain A review before terminal transition; atomic single-rename publish | execution-review.mjs:16-17,380-390 | publishExecutionReview :391 | T1/T2 + fence G2 | PROVEN |
| R2-02 | Rotation archive: previous Latest archived BYTE-IDENTICALLY before replace; archive immutable, collision-safe, crash-safe | execution-review.mjs:19-23 | archivePreviousLatest | T2/T13 | PROVEN |
| R2-03 | Re-read + re-hash fail-closed after publish | execution-review.mjs:26-27,470-476 | publishExecutionReview tail | T11 | PROVEN |
| R2-04 | Single-owner lock; never a mixed/partial Latest | execution-review.mjs:16-18,300-326 | acquireLatestReviewLock | T10/T13 | PROVEN |
| R2-05 | Review requiredness derived from frozen admission (authoritative projection), never caller declaration alone; schema pins authoritative_single_surface===true | execution-review.mjs:28-30,536-559; admission-record.mjs:115-117; policy-projection.mjs:154 | deriveExecutionReviewRequirement :547 | T7 + admission schema tests | PROVEN |
| R2-06 | Same-execution retry idempotent (no duplicate archive, no rewrite) | execution-review.mjs:24-25,427-434 | idempotency check | T12 | PROVEN |
| R2-07 | Terminal completion barrier fail-closed: failed publish blocks COMPLETE / downgrades PASS→HOLD | execution-review.mjs:611-648; colima-graph-runner.mjs:540-577 | applyExecutionReviewBarrier | T8/T9/T10 + bypass-fence B1/B2/C1 (entrypoint cannot skip or replace the seam) | PROVEN |
| R2-08 | Outcome coverage PASS/HOLD/REPAIR/REPLAN incl. failure semantics | execution-review.mjs:47 | EXECUTION_REVIEW_OUTCOMES | T1/T3/T4 | PROVEN |
| R2-09 | Task-specific review semantics carried (objective/mutations/tests/findings/design decisions/risks/limitations/next action/admission binding); structural completeness alone can never mint formal PASS (PASS authority remains oracle-owned) | execution-review.mjs:562-609 (sections 1-9) | buildGraphExecutionReviewSource | render coverage + A9 forged-surface test | PROVEN |
| R2-10 | Review surface ≠ PASS authority; single PASS oracle owner | pass-oracle.mjs; sole consumer review-bundle.mjs:2717,3654 | evaluatePassOracle | A9 forged-PASS surface → oracle NOT_PASS; authority audit (zero other consumers) | PROVEN |
| R2-11 | Admission boundary fence: review cannot mint/override admission or authorize unadmitted execution | src/admission/* sole mint/freeze owner; runAdmittedGraph mandatory gate | AUTHORITY_SEAM_RUNNER_KEYS rejection (this closeout) | B1/B2/C1 negative suite | PROVEN |
| R2-12 | Generation/freshness binding: identity binds executionId/cardId/outcome/head/treeSha/admissionId; stale/wrong-generation rejected; filename/directory never the freshness proof | execution-review.mjs:90-110,497-520 | executionReviewIdentity + verifyLatestExecutionReview expected-binding | fence G1/G2/G3b/G4/G5 | PROVEN |
| R2-13 | Revocation integration: revocation cascade single owner; revoked evidence can never satisfy PASS; review confers no independent authority so no parallel invalidation engine needed | truth-revocation.mjs/store; pass-oracle revocationFactsForOracle | oracle-integrated only | test-truth-revocation suite + authority audit | PROVEN |

## 3. Bypass audit result

`BYPASSABLE_REVIEW_PATHS = 0` (after repair).

Confirmed-and-repaired this closeout (the one genuine bypass window):

- **Governance DI-seam override through runnerOpts.** `runAdmittedGraph`
  forwarded unchecked `...runnerOpts` into the runner, so a caller could inject
  `executionReviewBarrier` (rubber-stamp barrier), `closeoutGate`,
  `closeoutSourceBuilder/EvidenceWriter`, or redirect the fixed surface via
  `executionReviewSurfaceDir/ArchiveDir`. Repaired fail-closed at BOTH levels:
  - `src/admission/admission-gate.mjs`: new
    `PRODUCTION_GATE_HOLDS.AUTHORITY_SEAM_OVERRIDE_REJECTED`; the six keys are
    rejected BEFORE any dispatch (`AUTHORITY_SEAM_RUNNER_KEYS`).
  - `src/control-plane/coordinator.mjs`: same six keys added to
    `AUTHORITATIVE_RUN_KEYS` (sink-time `AUTHORITY_OVERRIDE_REJECTED`).
  - Direct proofs: `test/governance/test-execution-review-bypass-fence.mjs`
    B1/B2/C1.

Verified non-bypasses (guarded, proven):

- Legacy entrypoints (`runAutoLoop`, legacy durable resume) are unconditional
  NON_PRODUCTION_ENTRYPOINT dead-ends (autoloop.mjs:84-86;
  durable-execution.mjs:601-603,921-927). The v2 in-memory path
  (`runAutoLoopInternal`) is reachable ONLY via the stack-a-internal test
  harness and can reach no formal gate.
- Unadmitted raw-runner calls produce no formal outcome: promotion requires
  ACCEPTED review artifacts + verified external review results bound to the
  candidate; console/in-memory PASS has zero authority
  (review-artifact-gate + promotion-authority + c2d gates).
- Manual CLI publication (`scripts/gov-execution-review.mjs --publish`) writes
  a human-facing projection only; a hand-forged `Latest/review.txt` claiming
  PASS cannot mint formal PASS (fence A9: oracle stays NOT_PASS; no formal
  consumer reads the surface).
- Durable resume re-enters `runColimaGraph`, so the barrier re-applies per
  attempt (durable-graph.mjs:770-783 fresh, :1355-1370 resume).

## 4. Authority fences (verified)

```
ADMISSION_SINGLE_OWNER          = YES   (src/admission/* sole mint/freeze; zero external freezeAdmission callers)
PASS_ORACLE_SINGLE_OWNER        = YES   (evaluatePassOracle; sole consumer = closeout gate)
REVOCATION_SINGLE_OWNER         = YES   (truth-revocation-store ledger; integrated through the oracle only)
REVIEW_CAN_MINT_FORMAL_PASS     = NO
REVIEW_CAN_AUTHORIZE_EXECUTION  = NO
STALE_REVIEW_REJECTED           = YES
WRONG_GENERATION_REJECTED       = YES
REVOKED_TRUTH_INVALIDATES_REVIEW_AUTHORITY = YES (via oracle evidence gating)
TASK_SPECIFIC_REVIEW_SEMANTICS  = PASS
PARENT_CHILD_ATTRIBUTION        = NOT_APPLICABLE (Domain A is a per-execution projection; child lineage preserved via durable artifacts + Domain B generation chain)
NEW_DURABLE_ENGINE              = NO
NEW_SCHEDULER_AUTHORITY         = NO
NEW_ADMISSION_AUTHORITY         = NO
NEW_PASS_AUTHORITY               = NO
NEW_REVOCATION_AUTHORITY        = NO
DUPLICATE_RUNTIME_TRUTH         = NO
DUPLICATE_REVIEW_TRUTH          = NO
SELF_EVOLUTION_IMPLEMENTED      = NO
```

## 5. Regression evidence (2026-08-22)

Focused:

- `test/governance` 519/519 (incl. new 7-test bypass-fence suite)
- `test/admission/test-admission-gate.mjs` + `test/budget/test-budget-wiring.mjs`
  + `test/control-plane/test-execution-sink.mjs` 29/29
- `test/control-plane` 58/58, `test/budget` 44/44

Broad (per-lane classification; every failure re-verified against baseline
`eb2fac1` with card changes stashed — `NEW_REGRESSIONS = 0`):

| Lane | Result | Classification |
|---|---|---|
| v2 | 466/469 | 3 PRE_EXISTING ENVIRONMENTAL: real-runtime durable-graph tests fail `ColimaRuntimeError` — profile `autoloop-graph` up but docker socket `~/.colima/autoloop-graph/docker.sock` missing. Machine environment, not repo code. |
| memory+telemetry | 265/266 | 1 PRE_EXISTING ENVIRONMENTAL (same colima socket class); telemetry perf benchmark passes isolated — load-sensitive only. |
| root-level | 389/420 | All 31 failures identical colima-socket class (~46s each), reproduced at baseline. |
| admission full dir | 181/183 | 2 VENDOR_INSTALL_DRIFT: FR4 Phase E installed-copy integrity vs stale machine-local `~/.pi` deployment; repo↔repo vendor pairs byte-identical. Deployment step, non-blocking. |

Repairs to pre-existing failures made in-card (stale fixtures, invariant kept):

- `test/v2/test-harness-owned-evidence.mjs` C4Q-12 and
  `test/v2/test-system-delta.mjs` C4S-9 used a sentinel matching NO secret
  pattern, so their fail-closed proofs never fired since authorship. Sentinels
  reshaped to a real credential pattern (`sk_key`); both now prove SECRET_RISK /
  SECRET_DETECTED fail-closed with no echo.
- `test/governance/test-git-status-parsing.mjs` test 12 asserted a transient
  live-repo state (`package.json` currently dirty) that could only hold during
  the original RB-1 repair session. Rewritten as a stable live-parser
  truncation guard; the modified-package.json behavior stays covered by
  fixture test 1. (This also un-breaks `test-verification-timing.mjs` S2/4,
  which subprocess-runs that file.)

## 6. Files changed by this card

- `src/admission/admission-gate.mjs` — authority-seam override fence (hold code + key list + pre-dispatch rejection)
- `src/control-plane/coordinator.mjs` — AUTHORITATIVE_RUN_KEYS extension
- `test/governance/test-execution-review-bypass-fence.mjs` — NEW: B1/B2/C1/G/A9 adversarial suite
- `test/governance/test-git-status-parsing.mjs` — test 12 stabilized
- `test/v2/test-harness-owned-evidence.mjs`, `test/v2/test-system-delta.mjs` — sentinel repairs
- `docs/governance/autoloop-rsl2-universal-execution-review-surface-closeout.md` — this record
- (carried from prior card, included in this governance drop:)
  `docs/governance/autoloop-post-split-canonical-realignment.md`

User dirty changes untouched: `docs/pi-graph-output/autoloop-auth1/review-job.json`,
`docs/pi-graph-output/checkpoint-20260809/risk-and-debt-register.md`, and all
untracked user files remain as-is.

## 7. Commit disposition

No standing auto-commit authority was found for this card
(`COMMIT = NO`). Worktree preserved with attributable changes listed above.

## 8. Verdict

`VERDICT = PASS / RSL2_UNIVERSAL_EXECUTION_REVIEW_SURFACE_CLOSED`
`RSL2 = CLOSED`
`NEXT_CANONICAL_TASK = RSL3 (surface rotation lifecycle) per RSL2 closeout NEXT_ACTION; open environmental items: colima autoloop-graph docker socket restoration, ~/.pi vendor redeployment (deployment steps, not code).`
