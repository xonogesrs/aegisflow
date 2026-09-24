# AUTOLOOP AGENT STRATEGY EVOLUTION COMPLETION — IMPLEMENTATION RECORD

Card: `AUTOLOOP_AGENT_STRATEGY_EVOLUTION_COMPLETION_1`
Date: 2026-09-24
Baseline HEAD: `e56f894` (includes `3e827b5`)
Predecessors:
- `AUTOLOOP_CROSS_AGENT_EVOLUTION_APPLICATION_AUDIT_1` (READ_ONLY audit;
  measured that agent-level attribution did not exist)
- `AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_WIRING_REPAIR_1` (production
  consumer + durable trigger state + real production trace)

Method: extend THE EXISTING evolution loop. No second loop, no second
scheduler, no second fitness engine, no second promotion path.

---

## Section-by-section landing

| § | Requirement | Landing | Evidence |
|---|---|---|---|
| A | evidence attribution | `src/evolution/attribution.mjs` — 14 declared axes derived from durable journal rows + the ADMITTED provider binding; bounded identifiers/digests/enums/numbers only; deterministic digest | S1 |
| B | natural plan producer | `src/evolution/plan-producer.mjs` — deterministic rule table: qualified evidence → diagnosis → bounded proposal → scope → patch/strategy plan → measurement plan. No LLM in the path. `INCONCLUSIVE` / `NO_CANDIDATE` on thin or clean evidence | S4, S5, S14 |
| C | strategy candidate classes | 6 LOW classes (MODEL_ROUTING, DECOMPOSITION, CONTEXT_ALLOCATION, RETRY_REPAIR, FANOUT_PARALLELISM, TOOL_SELECTION) + `PROMPT_EVOLUTION` at a declared MEDIUM floor | S6, S13 |
| D | performance memory | `src/evolution/strategy-memory.mjs` — bounded, provenance-bound, idempotent by run identity; success/hold/repair/latency/token/sample-count/confidence per (task class × dimension × value). **Feed repaired by `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1`**: the write now runs in the every-run production post-result feed (`attribution-feed.mjs`), not behind a fired trigger — see that card's record | S2, S3 |
| E | adaptive model routing | `src/evolution/strategy-routing.mjs` + `resolveProductionRoute` — selection ONLY inside `SPAWN_RUNTIME_CAPABILITIES`; an admitted binding always wins | S7, S9, S11 |
| F | bounded decomposition | DECOMPOSITION / CONTEXT_ALLOCATION / FANOUT_PARALLELISM knobs are finite and validated; narrowing-only on stress evidence | S12 |
| G | tool / retry | TOOL_SELECTION values are constrained to the ACTIVE pi-builtin mapping rows (never `bash`); RETRY_REPAIR is a bounded INT. Admission tool authority unchanged | S6 |
| H | agent-strategy fitness | `src/evolution/fitness-strategy.mjs` — BASELINE arm vs CANDIDATE arm over disjoint attributed observations; ACCEPT requires regression PASS **and** target IMPROVED **and** evidence sufficient | S8 |
| I | cross-agent learning | Agent A evidence → candidate → fitness → activation → agent B/C route resolution changes; durable + inspectable | S9 |
| J | safety | LOW autonomous / MEDIUM operator / HIGH deny preserved; the 8 HIGH classes untouched; prompt/profile ≥ MEDIUM in v1 | S6, S13 |
| K | natural acceptance | real `runAdmittedGraph` → real journal → observer → consumer → producer → strategy candidate → **PROMOTED**; no plan, scope or patch passed to the entrypoint | S14 |
| L | the four cases | CASE 1..4 answered with real derivations | S10–S13 |
| M | production wiring | the SAME observer / consumer / loop / policy / fitness / review / promotion / canary / rollback / circuit breaker | S14, S15 |
| J | agent-strategy authority is OPT-IN | `strategy_dimensions_allowed` on the policy; ABSENT ⇒ refusal naming the dimension; the CLI lane issues LOW dimensions only | S16 |
| — | canary metric coherence | the metric-deterioration check applies only when the canary's baseline metric IS the occupancy proxy (a pre-existing category error that could roll back a healthy strategy promotion) | S17 |
| — | canary rollback for strategies | the canary now covers a strategy promotion: REGRESSED ⇒ automatic DEACTIVATION of the promoted value | S15 |

## What "cross-agent learning" means here, precisely

```
Agent A execution (route R_A, task class T)
  → durable journal
  → attribution (agent/provider/model/decomposition/tools/retry/context/latency/outcome/generation/fan-out)
  → bounded strategy memory observation (provenance-bound, dedup by identity)
  → diagnosis (deterministic thresholds over A's AND other agents' observations)
  → fitness-gated proposal (a bounded value from a declared finite knob space)
  → independent review + promotion gate
  → strategy value ACTIVE for task class T
  → Agent B and Agent C, on their NEXT run of T, resolve to it
```

The transfer is a **runtime policy value**, not a source edit and not a
telemetry report a human reads: `resolveProductionRoute` (and the strategy
store) is consumed when a future admission is built, so agent B/C behaviour
actually changes. Rollback is a single deactivation, and the canary performs it
automatically on regression.

## The natural-evolution content gap

The previous card closed the *wiring* gap and left the *content* gap: nothing
turned qualified production evidence into an executable bounded plan, so every
natural derivation ended `UNSUPPORTED` (the only working path was a human or a
test hand-feeding `patchPlan`). This card closes it in two ways:

1. **Source-repair plans** are derived from a bounded patch **the durable
   evidence itself carries** (the evidence-bound extraction added in the
   previous card). The producer never invents patch text.
2. **Agent-strategy plans** are derived from the attributed memory by a
   deterministic rule table over a *finite, declared knob space*.

Consequently S14 runs the whole route end-to-end with the production call site
receiving **only configuration** — no plan, no scope, no observation.

Still honestly limited: no producer in this repository writes a source-repair
`patch_plan` into a journal payload for *natural* evidence, so the natural
source-repair path remains untriggered while the natural **strategy** path is
proven. That is a content gap, not a wiring gap, and it is recorded below.

## Boundaries (stated, not hidden)

| Boundary | State |
|---|---|
| **Agent-strategy authority** | **OPT-IN.** A policy preauthorizes strategy dimensions ONLY via the new `strategy_dimensions_allowed` field. ABSENT — including in the currently issued production policy and every pre-existing policy — means a strategy candidate is refused at authorization (`HOLD / EVOLUTION_SCOPE_OUTSIDE_POLICY`, naming the dimension). Agent-strategy adaptation therefore cannot be enabled by implication: an operator must re-issue the policy deliberately. The CLI lane (`--strategy-dimensions`) accepts only the six LOW dimensions; `PROMPT_EVOLUTION` is not issuable through it (S16). |
| Admitted `provider_binding` | UNCHANGED — the only execution-time provider authority. The routing seam can only choose within `SPAWN_RUNTIME_CAPABILITIES` and an explicit/admitted binding always wins. |
| Admission tool authority | UNCHANGED — `projectToolSelection` / `validateToolSelection` remain the authority; a strategy TOOL_SELECTION value is constrained to the ACTIVE mapping's canonical ids. |
| `bash` in tool selection | STILL UNMAPPED — a strategy naming it is refused at validation. |
| Governance semantics | UNCHANGED — the knob set touches fan-out, phase budget, context band, retry allocation, tool preference and route preference only. |
| Prompt/profile mutation | MEDIUM in v1; a MEDIUM candidate stops at `AWAITING_OPERATOR_PROMOTION` and the value is **not** activated (S13 asserts the generation is unchanged). |
| HIGH classes | UNCHANGED — credentials, security, governance, admission/promotion authority, secret handling, destructive migration, irreversible data, `EVOLUTION_POLICY_SELF`. |
| Strategy-store reset | Deleting `strategy-policy.json` resets all active strategy values to the deployment defaults. The file is operator-writable runtime policy by design; the strategy memory (`strategy-memory.json`) is independent of it, so evidence is not lost by a reset. |

### Known gaps recorded for follow-up (NOT release blockers)

1. **No natural source-repair plan producer.** A journal payload carrying
   `patch_plan` is required for the source-repair family. The strategy family
   needs no such producer.
2. **Baseline ambiguity at balanced sample counts.** The producer's default
   baseline is the most-observed strategy value; with comparable sample counts
   the tie breaks lexicographically. A deployment that knows its current
   strategy SHOULD declare it — `evolution.strategyBaselineValues` /
   `AUTOLOOP_EVOLUTION_*`; exposure is wired through the production consumer.
   **RESOLVED by `AUTOLOOP_AGENT_STRATEGY_EVIDENCE_FEED_REPAIR_1` §J.2**: the
   strategy is now declarable by the DEPLOYMENT through the durable production
   declaration record (`src/evolution/production-declaration.mjs`), the
   `AUTOLOOP_EVOLUTION_STRATEGY_BASELINE_VALUES` JSON variable, or the caller
   object — no internal-config-object-only seam remains.
3. **Strategy memory grows to a bound.** 2000 observations, oldest dropped, and
   each observation keeps ≤32 provenance refs, so the durable file stays
   bounded; `study-manifest.json` counts DO change between runs. This is
   pre-existing `recordTrigger`-style bounded retention, not new behaviour, but
   it is recorded because it makes the store non-hermetic across studies.
4. **Strategy activation counter.** Verifying "only one strategy is active at a
   time" per task class requires reading each task class's activation record;
   `strategyPolicyView().active` exposes exactly that for the workspace.

## Verification

Acceptance suite: `test/evolution/test-agent-strategy-evolution.mjs` (S1–S17;
all 17 PASS). Every case is deterministic and exercised through real modules.

Floors (canonical `COLIMA_HOME`, `--test-concurrency=1` where the recorded
floor requires it):

| Floor | Result |
|---|---|
| evolution (activation + wiring repair + this card) | 56/56 PASS |
| admission | 188/188 PASS |
| governance | 573/573 PASS |
| telemetry + budget | 215/215 PASS |
| rollover | 53/53 PASS |
| v2 full (canonical `COLIMA_HOME`, `--test-concurrency=1`, uncontended) | 661/661 PASS |
| `npm run check` | PASS |

### A test-harness race found while establishing the v2 floor

The v2 floor exposed a PRE-EXISTING flake in the E2 reboot soak (introduced by
`11059ba`; neither evolution commit touches `test/v2/`): the SIGKILL workers
published their ack with a plain `writeFileSync` while the parent gated the kill
on `existsSync` → `readFileSync` → `JSON.parse` with no retry, so a read inside
the create-then-write window threw `SyntaxError: Unexpected end of JSON input`
from `waitForMarker`. It presented as a different subtest failing each run (R7
once, R3 twice) — a race, not a regression. The v2 floor above was subsequently
re-run alone and passed 661/661 with zero failures.

Reproduced on an isolated harness with the identical patterns (7993 torn reads
in 4 s, same message); zero after the fix. Fix landed separately
(`test(v2): fix the E2 reboot-soak marker race`, commit `f0ae793`): the worker
publishes atomically (tmp + rename) and `waitForMarker` treats an unreadable
marker as "not written yet". `test-e2-reboot-soak.mjs` then passed 9/9 on three
consecutive runs. E1 is unaffected (it reads the ack only after the child has
exited).

## Authority boundaries (unchanged invariants)

- main/master integration stays with the human PGMA1/push-gate chain. A
  strategy promotion creates NO branch and NO commit — it activates a bounded
  runtime policy value.
- MEDIUM: autonomous evaluation, operator promotion. HIGH: refused before any
  activation.
- The policy artifact remains the ONE operator issuance step and cannot amend
  itself; `EVOLUTION_POLICY_SELF` stays forbidden.
- A strategy surface (`strategy://<task class>/<dimension>`) is validated by
  its own bounded schema and skipped by the path-based risk classifier and by
  the policy's path containment — so a strategy candidate can never smuggle a
  source path past classification, and a strategy surface can never be read as
  a forbidden governance path.
