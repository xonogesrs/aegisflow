# Minimum repair plan

**Card:** `AEGISFLOW_EVOLUTION_PRODUCTION_ADMISSION_1`
**Status:** PROPOSAL ONLY — **not authorized, not implemented.**
**Baseline:** `da3a251`

This plan covers exactly the three gaps that block *Proposal-Only Evolution*.
It deliberately excludes everything else the audit noticed. No router, no
adapter, no scheduler, no new persistent service, no change to OMP, EKM, CBM,
Jev, admission, or governance.

---

## Scope decision

| Gap | In scope | Why |
|---|---|---|
| G1 synthetic evidence reaches derivation | yes | Evidence Gate fails without it |
| G2 strategy proposal is not persisted | yes | There is nothing to review without it |
| G3 no proposal-only stop | yes | The mode cannot be expressed without it |
| W1 review independence is a string check | **no** | Only matters if autonomous mutation is admitted; proposal-only never reaches promotion |
| W2 policy budget counters unbound | **no** | Not required for proposal-only; recorded as a limitation for any future mutation admission |
| P1 deployment does not invoke `runAdmittedGraph` | **no** | Deployment decision, not code |
| Breaker reset, policy `window_ms`, three null trigger baselines | **no** | Historical audit findings; none blocks proposal-only |

---

## R1 — Exclude synthetic evidence before trigger evaluation

**Where:** `src/evolution/production-observer.mjs` (`observeRunForEvolutionTriggers`, line 137)
and the call site `src/admission/admission-gate.mjs:420`.

**Change:** the observer already receives `journal` and can read
`thresholds`/`storeRoot`. Add one guard at the top of the signal-evaluation
block: if `syntheticEvidenceReason({ config, events })`
(`attribution-feed.mjs:240`, already exported) returns a reason, return the
observation with `fired: []` and a new field `synthetic_excluded: <reason>`.
Thread the resolved `evolutionConfig` (which carries `synthetic`) into the
observer call from `admission-gate.mjs:420`, mirroring the feed at `:408-417`.

**Why this shape:** reuses the existing declared-provenance detector. No new
heuristic, no content sniffing; a record that declares nothing is still
production evidence.

**Acceptance:**
- the fixture in §3.1 of `EVOLUTION_PRODUCTION_PATH_AUDIT.md` (3 synthetic
  repairs + declared test-only payload) yields `fired: []`,
  `disposition: NO_QUALIFIED_TRIGGER`, zero store writes;
- the same evidence without the synthetic declaration still fires;
- `R1` and `R8` of the existing suite still pass.

---

## R2 — Persist a derived strategy candidate

**Where:** `src/evolution/loop.mjs:231-242` (after `deriveStrategyCandidate`),
using the existing store helpers in `src/evolution/candidate.mjs`
(`candidateFilePath` line 71, exclusive-create at line 294). Note that
`writeDerivationIndex` (`candidate.mjs:89`) is module-private today, so the
repair must either export one small `persistCandidate(storeRoot, candidate)`
helper from `candidate.mjs` or export the index writer. Reuse the existing
directory, schema and index — no second store.

**Change:** write the strategy candidate with exclusive-create under the same
`evolution-candidates/` directory the source family uses, and record the
derivation in the same index. On `EEXIST`, read it back and treat as existing —
the identical semantics `deriveImprovementCandidate` already has.

**Constraints:**
- no new file format: the candidate is already
  `autoloop.evolution-candidate/v1` with `candidate_kind: "AGENT_STRATEGY"`;
- no schema change;
- the write happens **before** authorization, so a proposal survives a
  rejected cycle;
- failure to persist is a HOLD (`CANDIDATE_UNSUPPORTED` is wrong; use a new
  `CANDIDATE_NOT_PERSISTED` hold code) rather than a silent continue.

**Acceptance:**
- after a cycle that ends at fitness rejection, `<store>/evolution-candidates/`
  contains exactly one file whose digest re-derives from its content;
- `node scripts/evolution-operator.mjs --store <dir>` lists it;
- two runs with the same trigger produce one file (dedup), matching `R5`;
- `reconcileEvolutionState` iterates it without error.

---

## R3 — A proposal-only ceiling

**Where:** `src/evolution/loop.mjs` — a new parameter
`proposalOnly: true` on `runEvolutionCycle`, honoured after Stage 3
(authorization) and before Stage 4.

**Change:**
1. After the candidate is persisted (R2), if `proposalOnly` is set, return
   `{ loop_verdict: "PROPOSAL_RECORDED", candidate_id, proposal_path }` before
   `issueCandidateMutationAuthorization` (line 346) and before any mutation.
2. Add `PROPOSAL_RECORDED` to `EVOLUTION_LOOP_VERDICTS` (`loop.mjs:54`) — the
   verdict set is declared closed and the operator/consumer code validates
   against it.
3. Thread the flag from `resolveEvolutionProductionConfig` →
   `production-consumer.mjs:496` → `runEvolutionCycle`, defaulting to
   **false** so no existing behaviour changes.
4. Document it in `docs/autonomous-evolution.md`.

**Why after authorization rather than before:** authorization is a read-only
policy check that proves the proposal would be in scope. Running it means a
recorded proposal carries `risk_class` and the policy verdict, which is what a
reviewer needs. It performs no mutation.

**Explicitly out of R3:**
- no change to what a non-proposal-only cycle does;
- no new store, no scheduler, no daemon;
- no automatic expiry/GC of proposals.

**Acceptance:**
- a strategy plan with `proposalOnly: true` produces `PROPOSAL_RECORDED`, a
  persisted candidate, and **no** worktree, branch, strategy-policy,
  review or canary artifact;
- the same plan without the flag still reaches its current verdict;
- the kill switch still blocks the cycle entirely before Stage 0.

---

## R4 — Surface proposals (follows from R2)

**Where:** `src/evolution/operator-view.mjs:79,169`.

**Change:** none required if R2 writes into `evolution-candidates/`; the
existing `listCandidatesSafe` already returns any
`autoloop.evolution-candidate/v1` record. The operator view's per-candidate
block reads `mutation_plan.edits` (`:186`) which is empty for a strategy
candidate — display `mutation_plan.strategy_activation` alongside it so the
proposal is legible.

**Acceptance:** the operator report shows the proposal with its dimension,
from/to value, rationale, and `promotion.promoted: false`.

---

## Verification plan for the repair card

| Check | Method |
|---|---|
| Existing suite unaffected | `node --test test/evolution/*.mjs` → 69/69 (before) and 69/69 + new cases |
| Synthetic exclusion | fixture from §3.1, asserted `fired: []` and empty store |
| Proposal persistence | fixture cycle with `proposalOnly`, assert one candidate file and no other artifact |
| Disable path | kill switch SUSPENDED → no proposal, normal run still PASS |
| No runtime coupling | `grep -rn 'strategy-store|resolveProductionRoute' src --include='*.mjs'` outside `src/evolution` still empty |
| No EKM/CBM/OMP writes | sha256 of EKM db/journal, CBM cache, OMP binary/config before and after |

Estimated change surface: 2 files touched for R1, 1–2 for R2, 1 for R3, 1 for
R4, plus one test file. No new modules.

---

## What the repair does **not** buy

Passing this plan makes proposal-only *expressible and reviewable*. It does not
authorize enabling it, does not make the review gate independent, and does not
bind the policy budget. Any future request to admit autonomous mutation must
address W1 and W2 separately.
