# Review Bundle Contract Reconstruction — Reconciliation Map (R-R3-RB1)

**Card:** `AUTOLOOP-V1-PHASE-R-R3-RB1` — structural repair / capability restoration.

This file records the Phase-A reconciliation of the review-bundle mechanism
against the current canonical AutoLoop source, plus the root-cause verdict and
the frozen canonical path.

> **Update（REVIEW-BUNDLE-REVIEW-SECTION-CONVERGENCE-1）**: the canonical
> reviewer-facing bundle is now the **24-section** layout with the consolidated
> **10.5 External Review Decision** section（see §5 below）. The legacy
> 25-section layout（generated before the convergence card）remains fully
> valid（the validator accepts both layouts; schema stays
> `autoloop.review-bundle/v1`）. Older line counts in this document predate
> the convergence changes.

---

## 1. What survived the refactor (READ-ONLY findings)

### Generator — present and complete

`src/governance/review-bundle.mjs` implements the **24-section**
`autoloop.review-bundle/v1` mechanism:

- `REVIEW_BUNDLE_SECTIONS` — the fixed 24-section set（§5）;
- `REVIEW_BUNDLE_SECTIONS_LEGACY` — the historical 25-section set（still
  validated for backward compatibility）;
- `reviewBundleIdentity()` — deterministic identity via `recursiveCanonical`
  (never includes the bundle's own hash → no circularity);
- `renderReviewBundle()` → deterministic text + `sha256` footer;
- `writeReviewBundle()` → atomic write; `validateReviewBundle()` →
  fail-closed section/identity/terminator/secret/inventory validation;
- external review state machine: `PENDING/PASS/REPAIR/HOLD`, delivery
  records, `applyExternalReviewVerdict` (verdict bound to bundle
  identity + sha256), REPAIR supersede (`buildSupersedeRecord`),
  `assertAuthoritativeBundle` (single authoritative generation).

CLI wrapper: `scripts/gov-closeout-bundle.mjs` — the "official CLI for the
RB-1 card-closeout review bundle gate" (`--generate / --validate /
--record-delivery-attempt / --apply-verdict / --state-driven-closeout`).

Tests: `test/governance/test-review-bundle.mjs`（generation, validation,
identity, truncation, secret, placeholder, symlink, path escape,
authoritative single generation, stale-verdict rejection, supersede）plus
`test/governance/test-review-bundle-decision-section.mjs`（Q1–Q17: the
External Review Decision section, internal/external separation, WHAT_CHANGED /
WHAT_WAS_PROVEN, PENDING + authoritative verdicts, next actions, lineage,
empty-list determinism, backward compatibility, LatestHuman publication,
Current/Queue authority, generation + secret-scan regressions）.

### Validator — present

`validateReviewBundle` checks required sections（version-adaptive: canonical
24-section layout OR the legacy 25-section layout）, identity, SHA,
terminator, secret patterns, placeholders, inventory consistency, stale
generation, external-verdict/status agreement and internal-review result
validity.

### Closeout wiring — present

`runStateDrivenCloseout` → `runCloseoutGate` → `renderReviewBundle` →
`writeReviewBundle` → `validateReviewBundle` → external-review surface
delivery. Reached via `gov-closeout-bundle.mjs --state-driven-closeout`.

### State model — present

`external-review.mjs` / `review-bundle.mjs`: PENDING / PASS / REPAIR / HOLD,
delivery records, verdict binding, supersede, authoritative generation.

---

## 2. Root cause

The 25-section `autoloop.review-bundle/v1` mechanism is **intact, complete and
tested**. The regression is **duplication + documentation divergence**:

- A second, **11-section** generator exists: `scripts/gov-review-bundle.mjs`
  ("review-unit finalization" flow, output `READY_FOR_REVIEW.txt`), built on
  `src/governance/external-review.mjs` and documented by
  `docs/governance/review-bundle-format.md` and
  `docs/governance/reversible-lifecycle.md`.
- The two generators emit **different schemas** (25 sections vs 11 sections),
  so "the one authoritative reviewer-facing file" is ambiguous.
- The canonical lifecycle docs point to the 11-section CLI, while the
  "official RB-1 card-closeout gate" is the 25-section CLI — the wiring and
  the documentation disagree.

Operational symptom: because the single-file handoff contract is ambiguous,
execution again degrades to manually gathering many artifacts.

---

## 3. Frozen canonical path (repair decision)

- **External review handoff (the ONE reviewer-facing file) =
  `autoloop.review-bundle/v1`** via `scripts/gov-closeout-bundle.mjs`
  (`--generate` / `--state-driven-closeout`). This satisfies RB-I1–RB-I10:
  one file, 24-section standalone coverage, deterministic identity, exact
  SHA, fail-closed validation, verdict binding, REPAIR supersede, single
  authoritative generation.
- `scripts/gov-review-bundle.mjs` (11-section) is the **review-unit
  finalization** bundle — a distinct internal flow, NOT the external
  reviewer handoff. The two must not be conflated.

## 5. REVIEW-BUNDLE-REVIEW-SECTION-CONVERGENCE-1 — reviewer decision surface

**Canonical layout（reviewer-first order; numbering keeps the existing
sections stable, decimal numbering per the 1.5 / 5.5 precedent）:**

```text
 1. Review Request                    （identity）
 2. Executive Status                  （summary; EXTERNAL_REVIEW_STATUS mirror,
                                        annotated as summary — canonical: §10.5）
 3. Task Identity
 4. Repository and Worktree Identity
 5. Objective
 6. Authorized Scope
 7. Explicitly Unauthorized Scope
 8. Architecture and Design Decisions
 9. Files Added / Modified / Deleted
10. Diff Summary
10.5 External Review Decision         （THE reviewer decision section, new）
11. Execution Results
12. Verification Results
13. Internal Independent Review        （renamed; INTERNAL_* fields +
                                        AUTHORITY_NOTE + legacy REVIEW_* aliases）
14. Repair and Supersession Lineage   （renamed; + REPAIR_ITERATIONS /
                                        SURFACE_RESEALS / CURRENT_BUNDLE_IDENTITY /
                                        LINEAGE_SUMMARY + legacy aliases）
15. Negative and Fail-Closed Cases
16. Regression Results
17. Evidence Inventory
18. Evidence Hashes
19. Security and Secret Scan
20. Repository Integrity
21. Known Risks and Limitations       （full technical inventory; RISKS/LIMITATIONS
                                        blocks — reviewer-facing subset lives in
                                        §10.5 KNOWN_LIMITATIONS, same source array）
22. Rollback Procedure
23. Open Questions
（REMOVED: 24 Recommended Next Step → NEXT_ACTION in §10.5;
           25 External Reviewer Verdict Template → EXTERNAL_VERDICT in §10.5）
```

**Section 10.5 — External Review Decision（E1–E9）:** `EXTERNAL_REVIEW_STATUS`;
`REVIEW_TARGET`（CARD_ID / GENERATION_JOB_ID / GRAPH_RUN_ID / BUNDLE_IDENTITY /
BUNDLE_SHA256 — the content sha is self-referential, so the authoritative
value is declared as the footer `REVIEW_BUNDLE_SHA256` line）;
`DECISION_SNAPSHOT`（EXECUTION / VERIFIER / INTERNAL_REVIEW / REGRESSION /
SECURITY_SCAN / REPOSITORY_INTEGRITY — summary reference, never a second
authority）; `WHAT_CHANGED`（structured delta attribution / governed contract;
no-source cards render `- No source implementation changes.`）;
`WHAT_WAS_PROVEN`（governed evidence-backed claims; absent → `NOT_RECORDED` —
implemented ≠ proven）; `KNOWN_LIMITATIONS`（reviewer-facing subset）;
`REVIEWER_CHECKS`（fixed 6-item navigation checklist）;
`EXTERNAL_VERDICT`（`VERDICT: PENDING` unless an authoritative external verdict
exists — internal review can never mint it）+ `ALLOWED_VERDICTS`;
`NEXT_ACTION`（IF_PASS / IF_REPAIR / IF_HOLD; `NOT_SPECIFIED` when the
lifecycle does not know）.

**Authority model:** internal independent review（§13）is supporting evidence,
NOT the external verdict. The external verdict is minted ONLY from the
authoritative external-review status（E8）; the validator rejects a
non-PENDING verdict that disagrees with `EXTERNAL_REVIEW_STATUS`, and rejects
invalid `INTERNAL_REVIEW_RESULT` values.

**Machine compatibility（H）:** schema stays `autoloop.review-bundle/v1` —
additive + compatibility preserved:
- the validator accepts BOTH the canonical 24-section layout and the legacy
  25-section layout（selected deterministically by the presence of the
  decision-section header）; historical evidence bundles keep validating;
- all machine fields stay column-0 with unchanged names
  （REVIEW_PASS / REVIEW_RESULT / REVIEW_RESULT_IDENTITY / BLOCKING_FINDINGS /
  GENERATION_TYPE / REPAIR_BUDGET_* / SUPERSEDES_BUNDLE_* / legacy
  REPAIR_LINEAGE_* aliases）;
- §9 / §17 / §18 keep their numbers（validator splits + external consumers
  unchanged）.

**Empty-list semantics（J）:** every empty list renders the single canonical
`  - none` marker（never repeated `(none)` placeholders）; parsers skip the
literal `none` entry.

**Process telemetry（P）:**

```text
REVIEW_SECTION_COUNT_BEFORE          = 25
REVIEW_SECTION_COUNT_AFTER           = 24（+ decimal 1.5 / 5.5 / 10.5 extensions）
DUPLICATE_REVIEW_FIELDS_BEFORE       = 1（internal review result in §2 mirror +
                                        §13 canonical — the only pre-existing pair）
DUPLICATE_REVIEW_FIELDS_AFTER        = 1（the sanctioned §2 summary mirror;
                                        verdict/next-step/limitations centralized
                                        in §10.5）
REVIEW_DECISION_LOOKUP_HOPS_BEFORE   = 6（§2 status → §13 internal → §14 lineage
                                        → §21 limitations → §24 next → §25 verdict）
REVIEW_DECISION_LOOKUP_HOPS_AFTER    = 1（§10.5 alone）
LEGACY_TEMPLATE_SECTION_REMOVED      = YES（§25 External Reviewer Verdict
                                        Template → §10.5 EXTERNAL_VERDICT）
RECOMMENDED_NEXT_STEP_DUPLICATION_REMOVED = YES（§24 → §10.5 NEXT_ACTION）
```

## 4. Unrelated pre-existing failures (classified, out of scope)

- `test/governance/test-git-status-parsing.mjs` — live-repo package.json
  truncation regression (git-status parsing).
- `test/governance/test-verification-timing.mjs` — `runSuiteSync` measured
  wallMs assertion (verification-timing instrumentation).

Neither touches the review-bundle path; both are pre-existing and are
classified here rather than silently absorbed or fixed by this card.
