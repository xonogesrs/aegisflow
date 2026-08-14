# TA-2 — Task Admission + Capability Policy Implementation and Graph Wiring

**Card**: AUTOLOOP-TA2 · **Type**: implementation + integration · **Risk**: per-card
governance · **Date**: 2026-08-09
**Predecessor**: TA-1 PASS (e8b046cc, formally closed 2026-08-09 — Controller
verdict recorded; surface resolved)

## Core Principle

TA-1 confirmed the design; TA-2 makes it real: **ONE authoritative admission
decision before Graph execution**. A single machine-readable, deterministic,
fail-closed admission result decides size, risk, lifecycle weight, capability
grants, isolation/durability/memory/review/repair/evidence policy, human gates
and the review-surface contract — and every downstream component (scheduler,
sub-agent envelope, writer, durable layer, closeout, telemetry) **consumes** it.
Never "capability available → default use"; always "capability justified by
admission policy → use".

## Deliverables (`src/admission/`, `test/admission/`, `scripts/ta2-*`)

| # | Deliverable | Location |
|---|---|---|
| 1 | Capability registry (24 capabilities, deny-by-default, envelope parity) | `src/admission/registry.mjs` |
| 2 | Pure deterministic classifier (size × risk × profile) | `src/admission/classify.mjs` |
| 3 | Admission schema + validator (`autoloop.task-admission/v1`) | `src/admission/admission-record.mjs` |
| 4 | Canonicalizer + deterministic `admission_id` + freeze/drift | `src/admission/admission-record.mjs` |
| 5 | Profile projector (→ capability sets / envelope / policies) | `src/admission/policy-projection.mjs` |
| 6 | Graph entry wiring (`runColimaGraph` / `runSubagentGraph` / `runDurableGraph` consume admission) | `src/runtime/colima-graph-runner.mjs`, `src/subagent/subagent-graph-runner.mjs`, `src/v2/durable-graph.mjs` |
| 7 | Sub-agent envelope projection (toolPermissions + mutationScope FROM admission) | `src/subagent/*` + `subagent-contract.mjs` |
| 8 | Writer enforcement (writer capability + mutation-scope containment) | `src/admission/policy-projection.mjs`, `src/subagent/subagent-writer-executor-adapter.mjs` |
| 9 | Durable freeze / resume anti-drift (admission digest in checkpoint fingerprint) | `src/v2/durable-graph.mjs`, `src/v2/checkpoint-bridge.mjs` |
| 10 | Memory policy integration (write-back needs explicit admission authority) | `src/runtime/colima-graph-runner.mjs` |
| 11 | Review/repair/evidence/human-gate projection | `src/admission/policy-projection.mjs` |
| 12 | One-card-one-review-surface enforcement (bundle §1.5 records admission) | `src/governance/review-bundle.mjs` |
| 13 | Post-FM-3 closeout hardening (V1–V5: baseline gate / single truth / derived counts / structured accounting / stale-count regression) | `src/governance/review-bundle.mjs` |
| 14 | Admission telemetry (graph.run admission block + contract allowlist) | `src/telemetry/graph-observer.mjs`, `src/telemetry/contract.mjs` |
| 15 | NEG1–NEG16 fail-closed suite (60 tests) | `test/admission/*` |
| 16 | Machine verification (18/18) + structured accounting | `scripts/ta2-verify.mjs`, `docs/pi-graph-output/ta2/ta2-verification.json` |
| 17 | Independent review (6/6) | `docs/pi-graph-output/ta2/ta2-independent-review.json` |
| 18 | Single authoritative review bundle (delivered to Current/) | `docs/pi-graph-output/ta2/card-closeout-bundle-20260808-e66bd0dd.txt` |

## Key Design Decisions

1. **ONE admission authority (A1)**: `src/admission/*` is the only writer of
   admission records. Scheduler / sub-agents / writers / reviewers / durable
   layer consume the frozen record; none may amend it.
2. **Size and risk are separate axes; risk dominates (A2)**: a 3-line database
   delete classifies XS + CRITICAL → CRITICAL profile (NEG2/NEG7). Escalation is
   monotonic; insufficient evidence → minimum MEDIUM (NEG12).
3. **Fail-closed everywhere (A3)**: malformed admission → HOLD/ADMISSION_INVALID
   (before any Colima work); unknown capability → DENIED; writer under read-only
   admission cannot gain write (NEG3); resume drift → HOLD/ADMISSION_DRIFT
   (NEG11); memory write-back without authority → WRITEBACK_AUTHORITY_INSUFFICIENT
   (NEG5).
4. **Single enforcement seam**: the sub-agent envelope (toolPermissions +
   mutationScope) is filled FROM admission — never agent-selected, never
   scheduler-hardcoded. Writer scope containment is host-verified.
5. **Durable anti-drift (N/O)**: the admission is persisted with the run and its
   digest is bound into the configuration fingerprint; resume re-verifies the
   stored admission_id.
6. **Pi Agent model policy untouched (R9)**: deepseek-v4-flash only; the
   card-input.schema.json allowlist wording was reconciled WITHOUT enabling
   deepseek-v4-pro (documentation correction only).
7. **Post-FM-3 closeout hardening dogfooded by this card (V1–V5)**: the card
   captured its baseline at start, derived all delta views from ONE machine
   truth, rendered narrative counts from the machine inventory, rendered the
   verifier accounting from structured test results, and proved (V5 test) that a
   newly generated bundle does not stale its own counts.

## Verification

`node scripts/ta2-verify.mjs` — **18/18 PASS** (deterministic, local-only):

- V1 module parse + registry parity · V2 registry covers TA-1 inventory ·
  V3 deny-by-default · V4 classifier determinism + size/risk separation ·
  V5 risk monotonic + fast-path guard · V6 profile matrix parity · V7 schema
  parity + validation · V8 admission_id deterministic + drift · V9 envelope
  projection · V10 writer scope + write-back authority · V11 graph admission
  seams · V12 durable fingerprint binding · V13 one-card-one-review-surface ·
  V14 closeout hardening · V15 R9 single model · V16/V17 suite accounting ·
  V18 scope guard.

Independent review cross-check: **6/6 PASS** (registry ↔ TA-1, schema additive
parity, matrix parity, risk-signal parity, sample-id determinism, NEG suite).

Regression: **849/849** across admission (60), governance (270), review-bundle
(26), graph-closeout (25), external-review-delivery (16), scripted-lifecycle
(43), telemetry (37), v2 (372).

## Bundle

- identity `e66bd0dd5c9ece28e0cb726c0eab25a81e1f192b9d9c40b83a544f3e582a3757`
- sha256 `bf516d37e49bb348aee867a4d3993c1e453152a3125cbf5140bb8ad838dd62ed`
- delivered to `~/Desktop/AutoLoop-Review/Current/` (AWAITING_EXTERNAL_REVIEW)
- CURRENT_CARD_DELTA_PATHS 22 == ADDED 21 ∪ MODIFIED 1 ∪ DELETED 0 (single
  machine delta; diff summary matches); prefix SHA == tail; secret scan clean.
- TA-2 is a NEW card: this is its first authoritative generation (no supersede
  binding). The TA-1 occupant was resolved with the Controller PASS verdict
  (archived `20260809-AUTOLOOP-TA1-e8b046cc-PASS-*`).

## Next Step

TA-3 candidates per roadmap: admission-driven telemetry **budget enforcement**
(full, not simulated), Central AutoLoop Control Plane / cost optimizer, or any
follow-on integration the Controller authorizes. No commit / push / merge / seal
was performed (worktree dirty by design for the external review receipt).
