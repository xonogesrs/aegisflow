# Review Bundle Contract Reconstruction — Reconciliation Map (R-R3-RB1)

**Card:** `AUTOLOOP-V1-PHASE-R-R3-RB1` — structural repair / capability restoration.

This file records the Phase-A reconciliation of the review-bundle mechanism
against the current canonical AutoLoop source, plus the root-cause verdict and
the frozen canonical path.

---

## 1. What survived the refactor (READ-ONLY findings)

### Generator — present and complete

`src/governance/review-bundle.mjs` (3340 lines) implements the **25-section**
`autoloop.review-bundle/v1` mechanism:

- `REVIEW_BUNDLE_SECTIONS` — the fixed 25-section set;
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

Tests: `test/governance/test-review-bundle.mjs` **26/26 PASS** (generation,
validation, identity, truncation, secret, placeholder, symlink, path escape,
authoritative single generation, stale-verdict rejection, supersede).

### Validator — present

`validateReviewBundle` checks required sections, identity, SHA, terminator,
secret patterns, placeholders, inventory consistency, stale generation.

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
  one file, 25-section standalone coverage, deterministic identity, exact
  SHA, fail-closed validation, verdict binding, REPAIR supersede, single
  authoritative generation.
- `scripts/gov-review-bundle.mjs` (11-section) is the **review-unit
  finalization** bundle — a distinct internal flow, NOT the external
  reviewer handoff. The two must not be conflated.

## 4. Unrelated pre-existing failures (classified, out of scope)

- `test/governance/test-git-status-parsing.mjs` — live-repo package.json
  truncation regression (git-status parsing).
- `test/governance/test-verification-timing.mjs` — `runSuiteSync` measured
  wallMs assertion (verification-timing instrumentation).

Neither touches the review-bundle path; both are pre-existing and are
classified here rather than silently absorbed or fixed by this card.
