# AUTOLOOP-P4 — Canonical PASS Oracle Contract

Status: **PASS / AUTOLOOP_P4_VERIFICATION_PASS_ORACLE_CLOSED**（this document is the
normative record of the P4 implementation; see the closeout bundle for evidence）

## 1. Requirement source

Reconstructed from current canonical repository authority（the task-card-named
`docs/governance/AUTOLOOP-MASTER-PLAN-AUTHORITY-V1.md` does not exist in the
repository — current authority wins）:

- `docs/governance/autoloop-rr1-post-fr4-release-and-roadmap-reconciliation.md`
  （roadmap authority determination; P1 verdict/evidence cluster）
- `docs/pi-graph-output/checkpoint-20260809/roadmap-revalidation.md`
  （"Acceptance Oracle Governance" — oracle authority not yet specified → this card）
- `AGENTS.md`（AUTHORITATIVE_SOURCE_FIRST; verification scope; storage policy）
- Existing code: `src/governance/review-bundle.mjs`（INTERNAL_REVIEW_PASS !=
  FINAL_CLOSEOUT_PASS doctrine）, `closeout-state.mjs`, `external-review.mjs`,
  `admission/admission-record.mjs`（freeze/drift）, `evidence/run-evidence-store.mjs`.

## 2. The oracle

Module: `src/governance/pass-oracle.mjs` — PURE, dependency-free.

```
declared success contract（frozen verification plan）
+ attributable verification evidence（producer identity + role）
+ freshness binding（repo head/treeSha | content sha256）
+ generation / lineage fencing
+ applicable global invariant results
+ authority state
↓ evaluatePassOracle()
PASS | NOT_PASS（+ machine-readable failure taxonomy）
```

Decisions: `PASS | NOT_PASS`. Failure codes（`ORACLE_REJECTIONS`）:
`ORACLE_CONTRACT_INVALID`, `ORACLE_AUTHORITY_REVOKED`,
`ORACLE_EVIDENCE_MALFORMED`, `ORACLE_EVIDENCE_UNATTRIBUTABLE`,
`ORACLE_EVIDENCE_LINEAGE_MISMATCH`, `ORACLE_EVIDENCE_GENERATION_FENCED`,
`ORACLE_EVIDENCE_UNDECLARED_CHECK`, `ORACLE_EVIDENCE_STALE`,
`ORACLE_REQUIRED_EVIDENCE_SELF_CERTIFIED`, `ORACLE_REQUIRED_EVIDENCE_MISSING`,
`ORACLE_REQUIRED_CHECK_FAILED`, `ORACLE_REQUIRED_EVIDENCE_CONTRADICTORY`,
`ORACLE_INVARIANT_VIOLATED`.

These map onto the EXISTING terminal semantics at the call sites（HOLD /
AWAITING_EXTERNAL_REVIEW / bounded repair）— no new outcome vocabulary.

## 3. Enforcement seam（BYPASSABLE_PASS_PATHS = 0）

All card-level formal PASS decisions converge on the oracle:

1. `runCloseoutGate`（review-bundle.mjs §6）— the single closeout gate
   （CLI / backfill / Graph / state-driven all call it）evaluates the oracle
   before any `final: "PASS"`; NOT_PASS → `HOLD / PASS_ORACLE_REJECTED:<codes>`.
2. `assertFinalCardCloseout`（RB2R2 final acceptance bar）— REVIEW_ACCEPTED is
   granted only after an oracle PASS over the verified bundle/verdict facts.
3. `runStateDrivenCloseout` alreadyApplied replay — replays a previously
   oracle-gated PASS disposition only through `assertFinalCardCloseout`.

Implicit required checks（cannot be removed or weakened by any contract）:
`review-bundle-valid`（independent, repo-fresh）and `independent-review`
（independent, repo-fresh）.

## 4. Task-contract binding（CLAIM ≠ PROOF）

The success contract is declared in the closeout-state record
（`state.successContract`）BEFORE closeout and reaches the oracle through
`materializeCloseoutContract` → `runMandatoryGraphCloseout` → gate — the
executor cannot weaken it at gate time. Task-specific check kinds:
`regression-suite`（matches structured §16 `{suite, tests, pass, fail}` counts;
PASS requires tests > 0, fail = 0, pass = tests）and `verifier`（structured
verifier flag）. Evidence for undeclared checks is rejected
（`ORACLE_EVIDENCE_UNDECLARED_CHECK`）— it can never silently satisfy anything.

## 5. Evidence model

Attributable record（`autoloop.oracle-evidence/v1`）: `evidenceId`, `cardId`
（lineage）, `generation`（fencing）, `checkId`, `kind`
（deterministic|semantic）, `producer{identity, role: executor|independent}`,
`result`, `at`, `command`（check identity）, `binding{head, treeSha,
artifactSha256}`（freshness）. Malformed/unattributable records are REJECTED,
never counted; a required check with only rejected candidates is MISSING.

- Freshness `repo`: binding must equal the contract's current head/treeSha
  whenever the contract declares one; missing binding = stale（fail-closed）.
  A contract with NO repo identity holds only the weaker non-terminal
  REVIEW_ACCEPTED authority（never CLOSEOUT_ELIGIBLE）.
- Freshness `content`: `binding.artifactSha256` must equal the declared
  expected digest.
- Contradiction（required PASS + FAIL）fails closed.
- `requiresIndependent` checks are satisfied ONLY by producer role
  `independent`（anti-self-certification）; deterministic proofs stay
  mechanical — no LLM is required for digest/exit/lineage checks.
- Optional checks are counted and reported but never block.

## 6. Legacy PASS path audit（Part 21 classification）

| Path | Classification |
|---|---|
| `review-bundle.mjs` `runCloseoutGate` final PASS | CANONICAL（oracle-gated） |
| `review-bundle.mjs` `runStateDrivenCloseout` replay PASS | CANONICAL（replay of oracle-gated disposition via assertFinalCardCloseout） |
| `review-bundle.mjs` `assertFinalCardCloseout` / `deriveAuthoritativeCloseoutStage` | CANONICAL（oracle-gated） |
| `external-review.mjs` `isExternalReviewPassed` | CANONICAL（recomputed digests; external verdict authority） |
| `promotion-authority.mjs` PASS binding | CANONICAL（digest-bound delivery record） |
| `c2d/*` commit/materialization `review_verdict !== "PASS"` checks | CANONICAL（durable digest-bound reviewer artifacts） |
| `operator-tick.mjs` PASS review artifact checks | CANONICAL（durable artifact + authorization existence） |
| `normalize-reviewer-json.mjs` PASS guard | CANONICAL（schema-level fail-closed guard） |
| `lifecycle-runner.mjs` reviewer-verdict `final: "PASS"` | NON_TERMINAL（INTERNAL_REVIEW_PASS ≠ card closeout PASS; card terminalization still requires the mandatory closeout gate） |
| `colima-reviewer-adapter.mjs` deterministic PASS verdict | CANONICAL（mechanical marker/status check; internal surface only） |

ACTIVE PASS BYPASSES AFTER = 0（card level）.

## 7. Known boundaries（deliberate, documented）

- Internal gate PASS trusts the structured `source.review` shape; the
  AUTHORITATIVE card acceptance remains the external reviewer verdict bound to
  the current bundle（unchanged RB-1G/RB2R2 doctrine）. A fabricated internal
  review cannot terminalize a card.
- Global invariants are consumed as evaluated results
  (`successContract.invariantResults`); the deterministic evaluation engine
  for each registered invariant remains with its owning subsystem（Stage E
  machinery). The oracle fails closed on malformed/violated records.
- Restart/reconcile and duplicate-completion fencing reuse the Stage E
  durable state machine（deterministic bundle identity + idempotent
  alreadyApplied + O_EXCL surface lock）; no new durable engine was created.

## 8. Verification evidence

- `test/governance/test-pass-oracle.mjs` — 30 tests: adversarial matrix
  T1–T14/T19–T20, property table P1（8 evidence states × 2 authority ×
  2 invariant = 32 combinations）, gate integration G1–G7（including
  frozen-contract-via-persisted-state and revoked authority）.
- Full-suite regression: identical pass/fail set to pristine `d446c0f`
  baseline（41 pre-existing environment-dependent failures unchanged;
  zero regressions introduced）.
