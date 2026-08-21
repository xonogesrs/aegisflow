# AutoLoop Review Artifact Lifecycle — As-Is Investigation

Scope: trace the full execution path from **implementation completion trigger** to **review artifact** (closeout bundle + delivery + review job), identify why review artifacts are not auto-generated, and define repair options. Investigation only — no production code changed.

Baseline: `governance/decomp-opt1-impl1` (AUTH1 lineage + I1 frozen @ cad7e6a).

## 1. The intended chain (from module contracts)

```
admission.review_policy.strength ∈ {independent, external}
  → task is review-required (review-artifact-gate.reviewRequired)
  → implementation completes (graph runner PASS)
  → closeout bundle generated + validated (runCloseoutGate / renderReviewBundle)
  → delivered to fixed reviewer surface ~/Desktop/AutoLoop-Review/Current/
     (review-bundle.txt + delivery.json + evidence.json, atomic; RB-1H)
  → external review verdict → rotate to Archive/
  → review job created ACCEPTED (review-job.mjs createReviewJob)
  → verdict consumption gated by assertReviewArtifactEnforced
     (REVIEW-ROUTING-R1/R1A: live candidate/spec binding, ACCEPTED job only)
```

## 2. Where each step actually fires (verified in source)

| Step | Runtime auto? | Actual trigger |
|---|---|---|
| closeout-state.json bootstrap (card start) | **NO** | written externally; `writeCloseoutState` is called only by `runStateDrivenCloseout` (consumer update), never by a bootstrap path. Historical states (docs/pi-graph-output/*/closeout-state.json) were created by card scripts/manual action |
| closeout gate run (completion) | **NO** | `src/runtime/colima-graph-runner.mjs` runs `runMandatoryGraphCloseout` / `runStateDrivenCloseout` ONLY when the caller passed `closeout.requiresReview === true` or `closeout.statePath`. `runAdmittedGraph` forwards runner opts unchanged — it does not inject closeout from admission. No admission-driven trigger exists |
| review bundle render + validate | gate-conditional | inside `runCloseoutGate` (review-bundle.mjs:2331) |
| surface delivery | gate-conditional | `deliverToExternalReviewSurface` (review-bundle.mjs:686), default deliverer when requiresReview |
| review job creation (ACCEPTED) | **NO** | `createReviewJob` (review-job.mjs:149) called only from `scripts/gov-review-job-orchestrator.mjs` and `scripts/gov-controller-ingest-result.mjs` — script layer |
| verdict consumption enforcement | **YES** | `assertReviewArtifactEnforced` (review-artifact-gate.mjs) — but this is a *consumer* gate (HOLDs on missing/invalid job); it never produces anything |

## 3. Root cause

The review-artifact lifecycle has authority at the edges but **no automatic trigger chain in the middle**:

1. **Gap 1 — no admission-driven closeout bootstrap**: `admission.review_policy.strength` is the review-required authority, but nothing at card start materializes it into a persisted `closeout-state.json` (the FM-1 "machine-readable state" contract). The state record is the documented authoritative trigger (`runStateDrivenCloseout`), yet only external callers create it.
2. **Gap 2 — no completion trigger**: on graph completion, `closeout.statePath` / `closeout.requiresReview` must be caller-supplied. `runAdmittedGraph` does not derive them from the frozen admission, so a review-required admitted task completes with no bundle, no delivery, no job — silently, until a downstream verdict-consumption gate HOLDs.
3. **Gap 3 — no review-job automation**: even with a delivered bundle + PASS verdict, the ACCEPTED review job (the artifact `assertReviewArtifactEnforced` requires) is created only by scripts; the runtime/closeout path never advances the job state machine.

Consequence (observed): a card executed and completed outside the script-driven flow produces **no review artifact at all** — the review bundle, surface delivery, and review job all require manual `scripts/gov-closeout-bundle.mjs --state-driven-closeout` / `scripts/gov-review-job-orchestrator.mjs` invocations. The 17 historical `scripts/*-self-closeout.mjs` files exist precisely because each card had to hand-roll this.

## 4. Fail-closed properties that must be preserved by any repair

- `assertReviewArtifactEnforced` (live candidate/spec binding, ACCEPTED job, supersede rejection) — consumer gate semantics unchanged.
- `runCloseoutGate` fail-closed gates (identity, scope, delivery as part of success, surface occupancy, no auto-verdict) unchanged.
- Reviewer independence: no runtime path may fabricate a verdict or mark review complete; bundle generation is system-observed only.
- RB2R1 stage machine: persisted fields never mint authority (REVIEW_ACCEPTED/CLOSEOUT_ELIGIBLE/CLOSED only from verified facts).
- No new artifact format, no second identity owner, no weakening of surface atomicity (RB-1H).

## 5. Repair options (for scoping; nothing implemented)

- **Option A — admission-driven bootstrap + completion trigger (minimal)**: in the admitted runner chain, when `admission.review_policy.strength ∈ {independent, external}`: (a) at card start, materialize + persist `closeout-state.json` (writeCloseoutState, secret-scanned) with task identity/scope from the admission; (b) at graph completion, automatically run `runStateDrivenCloseout` with that statePath. Closes Gaps 1+2. No review-job automation (Gap 3 stays script-side until a later step).
- **Option B — A + review-job automation**: additionally, when closeout reaches a bound PASS, create/advance the review job (createReviewJob → ACCEPTED only after verified external verdict) so the full consumer gate can pass without scripts. Closes all three gaps; largest surface, touches review-job.mjs call sites.
- **Option C — scaffold-free minimal wiring only**: keep Gap 3 as-is, add only a completion hook that produces the bundle + delivery when the admission demands review and no state exists yet (bridge of runMandatoryGraphCloseout with an admission-derived contract), documenting that job creation remains script-owned.

Recommendation direction (not yet decided): **A**, because it closes the observed break (completion → no artifact) with the smallest surface and keeps job automation (B) as a separate later step; C risks duplicating the state-driven path instead of using it.

## 6. Open questions for scoping

1. Should the bootstrap read `admission` at runAdmittedGraph time (single authority) or per-runner?
2. Where does the review-required signal for NON-admitted (legacy/scripted) runs come from — stay caller-opt-in (unchanged)?
3. Is `closeout-state.json` location fixed to the admission-bound outDir, and does the admission carry outDir?
4. Does Option A need a "review-required but closeout HOLD" terminal state (fail-closed evidence that a required review never happened) — or is the existing downstream consumer gate enough?

## 7. Evidence artifacts

- `src/runtime/colima-graph-runner.mjs` closeout branch (lines ~467–510): caller-opt-in only.
- `src/admission/admission-gate.mjs` runAdmittedGraph: forwards opts, no closeout injection.
- `src/governance/closeout-state.mjs` writeCloseoutState call sites: only review-bundle consumer.
- `src/governance/review-bundle.mjs` runStateDrivenCloseout (3492): consumes state, never bootstraps.
- `src/governance/review-artifact-gate.mjs` assertReviewArtifactEnforced: consumer gate only.
- `src/governance/review-job.mjs` createReviewJob call sites: scripts only.
- `docs/pi-graph-output/checkpoint-20260809/capability-health-inventory.md`, `risk-and-debt-register.md`: prior records of the same caller-opt-in wiring and 17 legacy self-closeout scripts.
