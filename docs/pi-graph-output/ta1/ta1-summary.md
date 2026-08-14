# TA-1 — Task Admission + Risk Tier + Capability Usage Policy (Research & Design)

**Card**: AUTOLOOP-TA1 · **Type**: research · **Risk**: MEDIUM · **Date**: 2026-08-09
**Predecessor**: FM-3 PASS (d82c7010, formally closed 2026-08-09)

## Core Principle

Task Admission and Capability Usage Policy are **one decision system**. A single
machine-readable admission result — produced BEFORE Graph execution — answers
*Why / When / Who / Where / How / When-not* and decides size, risk, lifecycle
weight, capability grants, review/repair/evidence strength, isolation/durability,
human gates, and the one-card-one-review-surface policy. Never "capability
available → default use"; always "capability justified by admission policy → use".

## Deliverables (`docs/pi-graph-output/ta1/`)

| # | Deliverable | File | R |
|---|---|---|---|
| 1 | Current Capability Inventory (23 capabilities, full R1 attributes) | `ta1-capability-inventory.json` | R1 |
| 2 | Task Size Model (XS/S/M/L/XL, 10 dimensions, deterministic) | `ta1-task-size-model.json` | R2 |
| 3 | Risk Tier Model (LOW/MEDIUM/HIGH/CRITICAL, 15 signals, escalation) | `ta1-risk-tier-model.json` | R3 |
| 4 | Admission Decision Matrix (18 decision fields × 7 profiles) | `ta1-admission-decision-matrix.json` | R4 |
| 5 | Capability Usage Matrix (6-W contract per capability) | `ta1-capability-usage-matrix.json` | R5 |
| 6 | Small-Task Fast Path Design | `ta1-small-task-fast-path.json` | R6 |
| 7 | High-Risk Escalation Design | `ta1-high-risk-escalation.json` | R7 |
| 8 | One Card / One Review Surface Contract | `ta1-one-card-one-review-surface-contract.json` | R8 |
| 9 | Machine-Readable Admission Contract (schema `autoloop.task-admission/v1`) | `ta1-admission-schema.json`, `ta1-machine-readable-admission-contract.json` | R10 |
| 10 | Integration Map (insertion points + authority + anti-drift) | `ta1-integration-map.json` | R12 |
| 11 | Failure / Negative Case Matrix (NEG1–12) | `ta1-negative-case-matrix.json` | R11 |
| 12 | TA-2 Implementation Recommendation | `ta1-implementation-recommendation.json` | — |
| + | Sample admission records (machine-validated exemplars) | `ta1-sample-admissions.json` | R10 |
| + | Independent review evidence | `ta1-independent-review.json` | — |

## Key Design Decisions

1. **Size and risk are separate axes; risk dominates.** A 3-line database delete is
   XS size + CRITICAL risk → CRITICAL profile, never the fast path. Size only
   refines lifecycle weight within a risk tier (monotonic).
2. **Risk reuses the existing canonical authority** (`risk-normalization.mjs`,
   LOW/MEDIUM/HIGH/CRITICAL) — no second enum.
3. **Capability enforcement has an existing seam**: the sub-agent envelope already
   carries `toolPermissions` + `mutationScope`. TA-2 makes admission the AUTHORITY
   that fills those fields; no new parallel enforcement.
4. **Admission precedes decomposition** and is a SUBSET of the lifecycle authority
   record (conflict → `HOLD / AUTHORITY_CONFLICT`); the IR's `execution_policy`
   can only narrow it. Fast path = no decomposition at all.
5. **Admission is frozen and drift-proof**: `admission_id` (deterministic) is bound
   into the durable checkpoint fingerprint; resume mismatch → `HOLD / ADMISSION_DRIFT`.
6. **Pi Agent model policy untouched (R9)**: `deepseek-v4-flash` only, no fallback,
   no routing. Admission shapes envelope/capability, never models.
7. **One card, one review surface** is formalized as an admission-level contract
   (supersede + preserve + self-contained chain + no chat dependence), reusing the
   FM-3 fixed-surface mechanism — fast-path tasks simply carry
   `external_review_required=false` and generate no surface at all.
8. **No new machinery**: isolation (Colima/worktree), durability, review, evidence,
   telemetry all reused; only the classifier + record + projection are new (TA-2).

## Verification

`node scripts/ta1-verify.mjs` — **18/18 PASS** (deterministic, local-only):

- V1 deliverables parse · V2 schema well-formed · V3 samples validate against schema
- V4 admission_id deterministic · V5 profile↔matrix consistency · V6 fast-path guard
- V7 size/risk separation · V8 capability 6-W completeness · V9 inventory attributes
- V10 NEG1–12 complete · V11 size model structure · V12 risk model structure
- V13 R9 single-model · V14 one-card-one-review-surface · V15 exit criteria 1–11
- V16 scope guard (no production source touched) · V17 capability-id registry resolution
- V18 three-way delta consistency (CURRENT_CARD_DELTA_PATHS == ADDED ∪ MODIFIED ∪ DELETED; diff-summary counts match)

Independent review: PASS, 0 blocking findings; 3 non-blocking findings (JSON/registry
consistency defects) found and resolved during verification, now guarded by V1/V5/V17.

Regression: research card — no production source modified; existing suites re-verified
(governance 270/270 baseline, review-bundle 26/26, graph-closeout 25/25, lifecycle 43/43).

## Exit Criteria — all 11 satisfied (V15)

1. size/risk separated ✅ · 2. admission+capability unified ✅ · 3. capabilities 6-W ✅
4. small-task fast path ✅ · 5. high-risk escalation ✅ · 6. one-card-one-review-surface ✅
7. machine-readable schema implementable ✅ · 8. integration boundary confirmed ✅
9. negative cases complete ✅ · 10. no overkill mechanisms ✅ · 11. TA-2 scope derivable ✅

## Next Step

**TA-2 — Task Admission + Capability Policy Implementation and Graph Wiring**:
capability registry → pure classifier (size+risk+profile) → admission record +
admission_id → policy projection into sub-agent envelope → scheduler entry
consumption → durable freeze/anti-drift → review-bundle recording → telemetry
quality metrics → NEG1–12 test suite. Scope and non-goals in
`ta1-implementation-recommendation.json`.
