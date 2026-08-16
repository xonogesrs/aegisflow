# AUTOLOOP-PGMA1 — Push/Draft Promotion Gate Authority Migration (Card Spec)

Canonical contract for the PGMA1 foundation repair. This is the WHAT; implementation
is the HOW and is reviewed against this contract.

## Background (recorded condition, 2026-08-16)

AUTH1 external review completed PASS; the promotion surfaced a pre-existing
control-plane defect (registered as R-11, P1, 2026-08-09 checkpoint):

```
PASS / AUTH1_CANDIDATE_AND_REMOTE_PROMOTION_IDENTITY_VERIFIED
GOVERNANCE_DEBT / PUSH_GATE_RETIRED_ARTIFACT_DEPENDENCY_DISCOVERED
```

`scripts/gov-push-gate.mjs` and `scripts/gov-draft-pr.mjs` still read the
RC1A-retired `external-review-result.json` (via
`src/governance/external-review.mjs:166-195`), which the closeout flow never
writes and which RC1A §7.2 declares "any read for production acceptance is a
violation". The gates' mechanical checks (remote reachable, fast-forward,
exact reviewed head) pass when verified directly; only the stale authority
artifact blocks them.

## Goal

Migrate `gov-push-gate` / `gov-draft-pr` to consume the **canonical
review/promotion authority chain** defined by RC1A. Both gates MUST share one
promotion-authority identity — they MUST NOT each judge a different authority
set. No replacement contract may be invented ad hoc: the inputs below are
frozen by RC1A and proven against live artifacts.

## Frozen Authority Inputs (inventory + proof)

All inputs are read fail-closed and **recomputed/verified**, never caller-fed.

### 1. Review-job ACCEPTED (RC1A §7, §7.1, T8)

- Record: `docs/pi-graph-output/<card>/review-job.json`
  (`autoloop.review-job/v1`).
- Proven requirement: `state == "ACCEPTED"`, minted only by the acceptance
  authority (controller), exclusive-create (RC1A §5, T7).
- Carries candidate identity: `repository`, `branch`, `currentHead`,
  `baseHead`, `changedTreeIdentity`, `patchSha256`; plus `jobId`,
  `generation`, `findingsDigest`, `verdictDigest`, `acceptedAt`,
  `acceptanceAuthority`.
- Live proof (AUTH1): `docs/pi-graph-output/autoloop-auth1/review-job.json`
  — state `ACCEPTED`, `jobId autoloop-auth1.g0002`, candidate identity
  `83480174…` / patch `d2dd7700…` / head `e1ecb45f…` / base `a06124c8…`,
  verdict digest `b4435406…`, `acceptanceAuthority: controller`.

### 2. External delivery verdict PASS (RC1A §7, §17)

- Record: `Current/delivery.json` (`autoloop.external-review-delivery/v2`).
- Proven requirement: `externalReviewStatus == "PASS"` with verdict bound to
  the CURRENT bundle identity + sha256 (verdict is the receipt
  acknowledgment; RB-1G). Stale delivery (job/generation/candidate identity
  mismatch vs the review-job) → HOLD (RC1A §17).
- Live proof (AUTH1): `externalReviewStatus: PASS`, verdict
  `{PASS, aab376bb…, 93f0002b…, reviewedAt 2026-08-16T09:24:07Z}`.

### 3. Recomputed candidate identity from the live tree (RC1A §8)

- Recomputed by the existing `buildChangeInventory` /
  `computeReviewContext` machinery: `changedTreeIdentity`, `patchSha256`,
  `currentHead`, `baseHead`, `branch`, `repository`.
- Proven requirement: recomputed == review-job candidate identity; any
  mismatch → HOLD. Never trusted from a caller-supplied SHA.

### 4. Live branch/remote HEAD exact match (RC1A §7, exact-head contract)

- Reviewed `currentHead` == local HEAD == remote `refs/heads/<branch>` head.
- Remote probe via read-only `git ls-remote`; diverged/unknown → HOLD.
- Live proof (AUTH1): local HEAD == remote == `e1ecb45fb69778a4d85f0b968ed6847008d029ce`.

### 5. Retired artifact is NOT authority (RC1A §7.2)

- `external-review-result.json` MUST NOT be read by either gate. Its
  presence MUST NOT grant anything (fail-closed negative test).

## Single Promotion Authority Identity

Both gates verify the SAME recomputed canonical set:

```
promotion_identity = sha256(cardId | jobId | generation |
  changedTreeIdentity | patchSha256 | currentHead | baseHead |
  repository | branch | verdict | bundleIdentity | bundleSha256)
```

A gate passes only when: review-job ACCEPTED + delivery PASS + recomputed
candidate identity match + live branch/remote HEAD exact match + the
promotion identity is consistent between the two gates.

## Outcomes (fail-closed)

| # | Condition | Outcome |
|---|---|---|
| 1 | retired artifact present (or absent) | never authority; not read |
| 2 | review-job missing / not ACCEPTED / stale generation | `HOLD` |
| 3 | delivery missing / verdict not PASS / verdict unbound | `HOLD` |
| 4 | recomputed candidate identity != review-job identity | `HOLD` |
| 5 | reviewed HEAD != local HEAD | `HOLD` |
| 6 | reviewed HEAD != remote HEAD / remote diverged / unknown | `HOLD` |
| 7 | stale delivery identity (card/branch/candidate drift) | `HOLD` |
| 8 | full canonical chain exact | `PASS` |
| 9 | push gate, remote already exact → idempotent, read-only | `PASS / PROMOTION_ALREADY_SATISFIED` |
| 10 | draft gate, existing PR with all bindings matching → idempotent, no re-create | `PASS / DRAFT_PR_ALREADY_SATISFIED` |

## Known limitation (delivery jobId/generation binding)

RC1A §17 states `Current/delivery.json` references the review-job identity
(`jobId`/`generation`). The current delivery schema
(`autoloop.external-review-delivery/v2`) does not carry `jobId`/`generation`,
so that specific staleness leg cannot be mechanically enforced today; the
gates enforce delivery staleness via cardId + branch + candidate identity
binding instead (row 7). A delivery-schema extension adding `jobId`/
`generation` (verified against the review-job record at read time) is a
documented follow-on — out of scope for this card.

## Scope

Authorized paths (implementation + tests + card artifacts):

- `scripts/gov-push-gate.mjs`
- `scripts/gov-draft-pr.mjs`
- `src/governance/promotion-authority.mjs` (new shared module)
- `test/governance/test-promotion-gate-authority.mjs` (new)
- `test/governance/test-review-unit-e2e.mjs` (push/draft gate segments migrated to the canonical flow)
- `docs/pi-graph-output/pgma1/autoloop-pgma1-card-spec.md`
- `docs/pi-graph-output/pgma1/autoloop-pgma1-authority.json`

## Explicitly Out of Scope

- AUTH1 implementation / HEAD mutation / repair generation.
- `gov-commit-integration.mjs` + `integration-commit-gate.mjs` migration
  (same R-11 defect class; separate follow-on — documented, not fixed here).
- Review-job / acceptance-record machinery itself (already canonical).
- Any new review/promotion surface.

## Verification

- Negative tests for every HOLD row above + row 1 (retired artifact never
  authority) + rows 9/10 (already-satisfied idempotent).
- Existing governance suite green.
- Independent review of the migration diff.
- Post-review run against AUTH1 live state:
  - push gate → `PASS / PROMOTION_ALREADY_SATISFIED`
  - draft gate → `PASS / DRAFT_PR_ALREADY_SATISFIED`
