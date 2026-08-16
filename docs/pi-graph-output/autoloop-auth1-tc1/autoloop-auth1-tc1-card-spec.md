# AUTOLOOP-AUTH1-TC1 — Terminal Review Ordering + Successor Generation Foundation

Canonical contract for the AUTH1-TC1 review unit. This is the WHAT; implementation
is the HOW and is reviewed against this contract.

## Overview

Repairs the acceptance→commit transition foundation gap discovered by AUTH1-TA1:
a pre-commit ACCEPTED review artifact becomes stale the moment the candidate is
committed (candidateIdentity.currentHead changes), yet the lifecycle has no
successor-generation mechanism to re-bind. Three related fixes, frozen together:

1. **Terminal review ordering contract** — terminal ACCEPTED review MUST bind the
   final local commit HEAD that will be pushed/PR'd. Pre-commit working-tree
   review may exist at earlier stages but MUST NOT serve as terminal promotion
   acceptance.
2. **Successor generation** — implement the missing lifecycle half:
   g0001 → drift → SUPERSEDED → create successor g0002 → current pointer → g0002
   → fresh findings → fresh verdict → fresh ACCEPTED.
3. **Authority grants freeze order** — minimal promotion grants are frozen into
   the authority record BEFORE the terminal review generation is created, so the
   reviewed content includes the final promotion authorization.

## R-TC1-01 — Terminal Review Ordering Contract

- Terminal ACCEPTED review MUST bind the final local commit HEAD (the HEAD that
  will be pushed / opened as a PR).
- Pre-commit working-tree review may exist earlier, but it MUST NOT be used as
  the terminal promotion acceptance.
- `candidateIdentity.currentHead` binding MUST NOT be removed or weakened. It is
  the protective mechanism that makes a stale pre-commit acceptance detectable.
- The mechanical enforcement already exists: `assertReviewArtifactEnforced`
  requires live currentHead == job currentHead (candidate drift → HOLD). This
  contract makes the ORDERING rule explicit: the review generation must be
  created against the final commit HEAD, i.e. after the exact scoped local
  commit.

## R-TC1-02 — Successor Generation

Required transition:

```text
g0001 (current)
→ drift detected
→ SUPERSEDED (supersededBy = g0002 jobId)
→ create successor g0002
→ current pointer converges atomically to g0002
→ fresh findings (review-findings.g0002.json)
→ fresh verdict (review-verdict.g0002.json)
→ fresh ACCEPTED (review-job.json state=ACCEPTED, generation=2)
```

Minimum invariants (all MUST hold):

1. g0001 artifacts (findings/verdict) are NOT deleted and NOT overwritten.
2. Generation increases monotonically (g0002 > g0001); generation is never
   reused.
3. Successor keeps the same lineage/card (lineageId == cardId).
4. A successor may be created ONLY from a legal predecessor: current job exists
   and is not terminal (not SUPERSEDED by another / not HOLD), or current is
   already SUPERSEDED with supersededBy == the exact successor jobId (crash
   resume).
5. The current pointer (review-job.json) converges to the new generation
   atomically (CAS), never via delete + recreate.
6. A stale/old ACCEPTED artifact MUST never re-satisfy live enforcement
   (`assertReviewArtifactEnforced` → HOLD for anything but the current accepted
   generation).
7. Concurrent successor creation MUST fail closed — never two g0002.
8. The successor MUST carry the lineage links: priorJobId, priorFindingsDigest,
   priorVerdictDigest, supersedes (= predecessor jobId).

Explicitly FORBIDDEN implementation shortcuts:
- deleting `review-job.json` to create the successor;
- overwriting the old job record in place;
- any AUTH1-specific bypass.

## R-TC1-03 — Authority Grants Freeze Order

- The minimal promotion grants for the card MUST be decided and frozen into the
  authority record BEFORE the terminal review generation is created.
- For AUTH1: `feature_branch_push.allowed=true`, `draft_pr.allowed=true` are
  authorized (target = push feature branch + open draft PR).
- `checkpoint_commit.allowed` MUST be classified by the first read-only gate:
  if it is a prerequisite of the integration attestation (it is — the
  integration gate composes the checkpoint gate local conditions), then it must
  also be granted before the terminal review / final commit.
- Grant amendments after ACCEPTED are forbidden for this card: the reviewed
  content must already include the final promotion authorization.

## Scope

- Modify `src/governance/review-job.mjs` (successor-generation creation).
- Add adversarial tests for successor generation + ordering contract.
- Update the ordering contract documentation (this card spec + gate header
  contract comment).
- Do NOT touch `docs/pi-graph-output/auth1/` or
  `docs/pi-graph-output/autoloop-auth1/` directory organization.
- Do NOT push / open PR in this card. AUTH1 recovery (g0002 against final HEAD
  → enforcement → push → PR) is the follow-on card.

## Success Criteria

- SC-01: `createSuccessorReviewJob` creates g0002 from an ACCEPTED g0001 via the
  formal lifecycle, preserving g0001 artifacts and lineage links.
- SC-02: concurrent successor creation fails closed (only one g0002).
- SC-03: after supersession, g0001 cannot re-satisfy `assertReviewArtifactEnforced`
  (HOLD).
- SC-04: g0002 can run the full lifecycle (findings → verdict → ACCEPTED) and
  satisfy `assertReviewArtifactEnforced` against its bound HEAD.
- SC-05: checkpoint_commit semantics classified and recorded; authority grants
  freeze order documented.
