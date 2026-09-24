# AUTOLOOP AUTONOMOUS EVOLUTION LOOP COMPLETION — IMPLEMENTATION RECORD

Card: `AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1`
Date: 2026-09-24
Branch: `governance/rsl2-universal-execution-review-surface`
Baseline HEAD: `dfe7d53` (BACKGROUND_WAITER_COALESCING_AND_PROFILE_SINGLEFLIGHT_LANDING_1)
Method: implement the policy-preauthorized autonomous evolution loop over the
existing authority machinery (C3B mutation, evidence journal, governance
gates); prove the closed loop in an isolated controlled environment. This
record is additive; it rewrites no historical document.

---

## Phase A — Architectural target landed

```
NORMAL_OPERATION (runAdmittedGraph — UNTOUCHED)
  → telemetry/evidence          (durable journal — UNTOUCHED)
  → improvement trigger         src/evolution/trigger.mjs   [WIRED, gated]
  → candidate derivation        src/evolution/candidate.mjs [WIRED, deterministic]
  → risk classification         src/evolution/policy.mjs    [WIRED, LOW/MEDIUM/HIGH]
  → policy preauthorization     src/evolution/policy.mjs    [WIRED, durable artifact]
  → isolated mutation           src/evolution/mutation.mjs → C3B runMutation [WIRED]
  → validation                  C3B runValidationPlan (inherited unchanged)
  → fitness comparison          src/evolution/fitness.mjs   [WIRED, baseline-relative]
  → accept/reject               fitness decision (REJECT ⇒ worktree discard)
  → independent review          src/evolution/promotion.mjs [WIRED, durable PASS artifact]
  → autonomous commit           src/evolution/promotion.mjs [WIRED, evolution/<id> branch only]
  → autonomous promotion        src/evolution/promotion.mjs [WIRED, LOW + all gates]
  → canary                      src/evolution/canary.mjs    [WIRED, bounded window]
  → accept OR rollback          src/evolution/canary.mjs    [WIRED, automatic, ref-only]
  → NEW_NORMAL_OPERATION
```

Orchestration: `src/evolution/loop.mjs::runEvolutionCycle` — one entry, every
stage fail-closed, NORMAL_OPERATION never touched by any stage.

## Phase B — Section-by-section landing

| § | Requirement | Landing |
|---|---|---|
| A | improvement trigger | `trigger.mjs`: 7 closed signal classes (repeated equivalent failure, repeated repair, recurring HOLD, abnormal retry frequency, latency regression, token inefficiency, qualified pattern evidence). MINIMUM EVIDENCE COUNTS with a hard floor (never a single failure); observation window; dedup + cooldown + per-window frequency cap + same-signature suppression + circuit breaker in the durable trigger state. Every trigger event pins `evidence_refs` (journal event ids) + `observed_at` + `source`. |
| B | candidate derivation | `candidate.mjs`: completes the not-yet-wired `candidate_derivation` seam (`generation-manifest.mjs` pattern now points at `evolution/candidate.mjs`). Deterministic `candidate_id` (sha256 over trigger+baseline+plan); same problem_signature at the SAME baseline is a no-op (derivation index); carries candidate_id / problem_signature / evidence_refs / baseline_revision / affected_scope / expected_improvement / measurement_plan / risk_class / rollback_plan. No strategy ⇒ `DERIVATION_UNSUPPORTED` (recorded, never improvised). |
| C | risk classification | `policy.mjs::classifyCandidateRisk`: LOW (bounded single-concern, no authority surface) / MEDIUM (breadth, schema/migration-like) / HIGH (unconditional: governance/admission/evolution/budget/c2d/writeback-trust surfaces, declared HIGH markers). HIGH is absolute — never autonomous. |
| D | policy preauthorization | `policy.mjs::createEvolutionPolicy/readEvolutionPolicy/authorizeUnderPolicy`: durable, exclusive-create, digest-bound artifact (`autoloop.evolution-policy/v1`, schema `src/schema/evolution-policy.schema.json`) binding scope patterns, forbidden patterns (HIGH surfaces unforgable), allowed commands, validation plan, resource budget, expiry/generation. The policy authority REPLACES the per-attempt operator mutation authorization for LOW risk only; the C3B artifact contract (durable, expiry, baseline binding, scope fencing, validation-plan identity) is inherited unchanged — authority substitution at the issuer, never a bypass. |
| E | mutation | `mutation.mjs`: composes C3B `runMutation`/`createIsolatedWorktree`/`runValidationPlan`/`runBoundedCommand` verbatim. Patch delivery via caller-owned temp file + `scripts/evolution-apply-patch.mjs` (dry-run check → apply → reversibility proof; secret scan; control-char rejection). Production checkout never touched. Bounded repair: max 1 retry with a fresh execution identity; SCOPE_VIOLATION is never repaired. |
| F | fitness | `fitness.mjs::evaluateFitness`: REGRESSION gate (mutation terminal + all required validation commands exit 0) AND target-metric comparison (baseline vs candidate; IMPROVED required). UNCHANGED / REGRESSED / INCONCLUSIVE ⇒ REJECT. Missing measurement ⇒ INCONCLUSIVE ⇒ REJECT (never fabricated). Deterministic fitness_digest. |
| G | autonomous commit | `promotion.mjs::commitCandidateToEvolutionBranch`: LOW + fitness ACCEPT only; dedicated `refs/heads/evolution/<candidate-id>` branch (never main/master — hard refusal); commit binds candidate id/digest, baseline, trigger, evidence refs, fitness digest, validation count. |
| H | review | `promotion.mjs::bindEvolutionReview`: durable digest-bound review artifact (`autoloop.evolution-review/v1`) bound to candidate_digest + fitness_digest; reviewer identity must be independent (`agent:`-prefixed and `autoloop-evolution` refused — self-approval fence). The reviewer never holds mutation authority (it receives the handoff; it cannot issue authorizations). |
| I | promotion | `promotion.mjs::evaluateAutonomousPromotion`: ALL of policy preauthorization (re-read, re-verified) + fitness PASS + regression PASS + independent review PASS + candidate digest re-derivation + live HEAD == frozen baseline + semantic drift gate PASS (canonical digest comparison, same conventions as the closeout gate). Any mismatch ⇒ HOLD with a specific code. MEDIUM ⇒ `MEDIUM_REQUIRES_OPERATOR` (existing operator boundary). |
| J | canary | `canary.mjs::openCanaryWindow/evaluateCanary/rollbackCandidate`: bounded window (floor 30 min); monitors regression, new repeated failure (same hold reason ≥2), crash/resume anomaly, semantic drift, target-metric deterioration; REGRESSED ⇒ AUTOMATIC rollback (ref-only reset of the evolution branch to the pre-promotion baseline; idempotent; never main/master; never a history rewrite). |
| K | loop prevention | `canary.mjs::recordCandidateOutcome` + `trigger.mjs` gates: cooldown, max autonomous evolutions/window, max consecutive failed candidates (3), same-signature suppression, global circuit breaker (`AUTO_EVOLUTION = SUSPENDED`; the trigger gate returns EMPTY — NORMAL_OPERATION continues unaffected). |
| L | observability | `src/evolution/operator-view.mjs` + `scripts/evolution-operator.mjs`: read-only/advisory report (policy, circuit breaker, triggers, candidates, reviews, canary, rollbacks, derivations). Zero writes; no production authority consumes it (same fence as the R-07 operator surface). |
| M | governance | No bypass: admission/budget/review/promotion/semantic-drift gates all still apply; the policy artifact extends the EXISTING C3B authority model (same durable-artifact conventions, new `authority_type`), never a second parallel authority system. `merge_main`/`release`/`seal` remain const-false in the lifecycle authorization schema — untouched. |
| N | acceptance | `test/evolution/test-evolution-loop.mjs` (N1–N9) + `test/evolution/test-evolution-operator-view.mjs` (O1–O4) — all PASS. |

## Phase C — Acceptance evidence (card §N)

All through REAL machinery (real git fixtures, real C3B worktree mutation,
real durable artifacts, real evidence journals):

1. **N1** qualified synthetic signal (3× equivalent HOLD, evidence-bound)
   auto-derives a provenance-bound candidate; same trigger re-derives the
   SAME candidate (identity dedup). PASS.
2. **N2** LOW candidate: derive → policy authorization (authorized_by =
   `evolution-policy:<id>`) → isolated C3B worktree mutation (patch applied,
   production checkout byte-untouched) → validation PASS → fitness IMPROVED
   → independent review PASS (self-approval fenced) → autonomous commit to
   `evolution/<id>` (master untouched) → promotion gate ALL-PASS → canary
   window opens and evaluates HEALTHY. NO per-step human approval anywhere.
   PASS.
3. **N3** regression candidate (validation failure) ⇒ REJECT; "tests pass but
   no metric improvement" ⇒ UNCHANGED ⇒ REJECT; inconclusive measurement ⇒
   REJECT. PASS.
4. **N4** HIGH-risk candidate (authority-surface scope or declared marker)
   ⇒ `EVOLUTION_RISK_CLASS_REFUSED`, never mutates; the policy artifact
   cannot allow HIGH (schema + validation refuse; HIGH forbidden classes are
   structural). PASS.
5. **N5** canary regression (same failure signature re-appears ≥2
   post-promotion) ⇒ automatic rollback; branch ref restored to the exact
   pre-promotion baseline; idempotent. PASS.
6. **N6** repeated triggers deduped (one signature ⇒ one trigger despite 6
   events), cooldown suppresses immediate re-fire, window cap suppresses
   beyond-cap signatures, circuit breaker suppresses everything. PASS.
7. **N7** evolution failure (circuit breaker tripped) ⇒ the loop reports
   `HOLD / EVOLUTION_LOOP_TRIGGER_GATED` and returns — the production repo is
   untouched and NORMAL_OPERATION continues (the gate returns empty, never
   throws into runs). PASS.
8. **N8** the autonomous path issues the C3B authorization under the POLICY
   identity (`evolution-policy:…`) — no operator invocation in the chain;
   repair budget ≤1. PASS.
9. **N9** policy digest, candidate digest, review digest all re-derive from
   their own durable bytes; review binds candidate+fitness digests. PASS.

Operator view: **O1–O4** PASS (complete report, truthful UNKNOWN, read-only
proof, CLI forms).

## Phase D — Regression floors (risk/change-based)

| Floor | Result |
|---|---|
| governance ≥ 564 | **573/573 PASS** (baseline unchanged) |
| admission ≥ 188 | **188/188 PASS** |
| budget ≥ 86 | **86/86 PASS** |
| telemetry ≥ 129 | **129/129 PASS** |
| lifecycle-runner + standalone-paths | 27/27 PASS |
| writeback gate/candidate/trust | 43/43 PASS |
| rollover production-wiring | 19/19 PASS |
| v2 core (durable-execution/orchestrator/entrypoint) | 58/58 PASS |
| memory graph-context/retrieval | 31/31 PASS |
| learning lifecycle | 167/167 PASS |
| review-job/candidate-domain | 17/17 PASS |
| **evolution (new)** | **9/9 + 4/4 PASS** |
| v2 full (661) | 657 pass + 4 environment-only (COLIMA_HOME unset + default concurrency; all 4 PASS with canonical COLIMA_HOME and `--test-concurrency=1` — identical to the pre-existing baseline recorded in `docs/pi-graph-output/autoloop-background-dedup-audit-1.md`) |

`npm run check` (node --check over all src): PASS.

## Phase E — Authority boundaries (unchanged invariants)

- The evolution loop NEVER touches main/master: autonomous commit targets
  `refs/heads/evolution/<candidate-id>` only; main/master integration stays
  with the human PGMA1 / push-gate / integration-commit-gate chain.
- MEDIUM candidates: autonomous mutation/evaluation, operator promotion.
- HIGH candidates: refused before any mutation.
- The policy artifact cannot authorize HIGH (structural forbidden list) and
  cannot amend itself (EVOLUTION_POLICY_SELF is a HIGH class).
- The trigger/candidate/fitness layers mint NO authority: authorization is
  the durable policy artifact consumed through the EXISTING C3B
  `authorizeMutation` live-binding verification (execution/repository/
  common-dir/target-ref/baseline — unchanged).
- Semantic drift gate: the promotion gate reuses THE canonical digest
  conventions; a drifted declared contract fails promotion closed.
- Circuit breaker: suspends EVOLUTION only; never blocks a run.

## Phase F — Deliberate non-goals (card IMPORTANT)

- NO production self-modification was performed: the loop was proven in
  isolated controlled environments (temp git fixtures + C3B isolated
  worktrees). Production activation is a SEPARATE card
  (`AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1`) that must issue
  a real operator policy and wire the trigger observation point into the
  production runAdmittedGraph terminal path.
- No second scheduler / durable-state system / rollover mechanism / authority
  registry was created (Phase C inventory invariants preserved).

## Final verdict

```
VERDICT = PASS / AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETED_IN_ISOLATION

TRIGGER                 = WIRED (7 closed signal classes; gated; provenance-bound)
CANDIDATE_DERIVATION    = WIRED (deterministic; seam completed in generation-manifest)
RISK_CLASSIFIER         = WIRED (LOW/MEDIUM/HIGH; HIGH absolute)
POLICY_PREAUTHORIZATION = WIRED (durable digest-bound artifact; LOW only)
MUTATION                = WIRED (C3B composition; isolated worktree; bounded repair)
FITNESS_EVALUATION      = WIRED (regression gate + baseline-relative metric)
AUTONOMOUS_COMMIT       = WIRED (evolution/<id> branch only)
INDEPENDENT_REVIEW      = WIRED (durable PASS artifact; self-approval fenced)
AUTONOMOUS_PROMOTION    = WIRED (LOW + all gates fail-closed)
CANARY                  = WIRED (bounded window; 5 regression families)
AUTO_ROLLBACK           = WIRED (ref-only; idempotent)
CIRCUIT_BREAKER         = WIRED (evolution-only suspension)
OPERATOR_VISIBILITY     = WIRED (read-only CLI + report; O1–O4 PASS)
GOVERNANCE_COMPATIBILITY= PRESERVED (no gate bypassed; no parallel authority)

AUTONOMOUS_LOW_RISK_LOOP  = CLOSED (N2 end-to-end in isolated environment)
MEDIUM_RISK_BOUNDARY      = operator promotion (unchanged machinery)
HIGH_RISK_BOUNDARY        = no mutation (structural)

SOURCE_MUTATION = production repo untouched by the loop itself (test
                  fixtures + isolated worktrees only; the implementation
                  commit is the card's own governed change)
COMMIT = NO (local implementation only; commit/push per operator gate)
PUSH   = NO

NEXT_CANONICAL_TASK = AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1
```
