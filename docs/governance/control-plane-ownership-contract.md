# Central AutoLoop Control Plane — Ownership Contract

> **Card:** `CP-1` — Central AutoLoop Control Plane Ownership & Cost-Optimization Contract Freeze
> **Mode:** DESIGN / CONTRACT FREEZE — no implementation code on this card
> **Policy authority:** AutoLoop governance
> **Status:** candidate — pending CP-1 independent review (defines the Control Plane ownership contract; becomes authoritative/frozen only after CP-1 external PASS + commit)
> **Sibling contract:** `docs/governance/cost-optimizer-contract.md`
> **AET/PER reference:** `authority-execution-truth-invariants.md` (AET-1/2/3), `pre-execution-reconciliation-protocol.md` (PER)

---

## 0. What this document freezes

This document freezes **what the v1 Central AutoLoop Control Plane owns and does not own**, before any implementation exists. It is the answer to one question:

> Where does cross-task coordination live without turning it into a second policy authority that absorbs every subsystem?

The companion document (`cost-optimizer-contract.md`) freezes the optimizer's input/output decision contract. Scoring formulas, model weights, and tuning policy are **not** decided here — they are deferred to CP-2 (or later) and must obey the boundaries frozen here.

---

## 1. Authority basis (why a Control Plane now)

The 2026-08-09 checkpoint (`docs/pi-graph-output/checkpoint-20260809/roadmap-revalidation.md`) classified **Central Control Plane → DROP** with the reason:

> No demonstrated multi-controller requirement; risks abstraction before integration evidence.

That classification was a **recommendation**, not a frozen decision. The Controller has since re-sequenced the v1 mainline: **TA-3 closed**, and the next mainline topic is the Central Control Plane / cost optimizer. CP-1 is therefore admitted as a **design/contract-freeze card only** — the exact mitigation for the risk that motivated the earlier DROP:

- no implementation until the ownership contract is frozen (this card),
- no god-object: central coordination ≠ centralized ownership,
- no scoring formulas before the decision contract is frozen,
- multi-controller coordination and predictive/learning complexity are explicitly deferred (§8).

This re-decision is a Controller product decision, recorded here so downstream cards do not treat the checkpoint's DROP as still-current.

---

## 2. Entry re-proof (Phase A)

Applied PER to the bounded AutoLoop domain only. Verified at `3ab1ebf`:

| Check | Result |
|---|---|
| repo / worktree | `/Volumes/NVM2T/Development/autoloop` — canonical path per `AGENTS.md` |
| branch | `governance/reversible-lifecycle-draft-pr` |
| HEAD | `3ab1ebf3c9bf604cf14b2aff4a1ed47a048774fc` (matches `expected_HEAD=3ab1ebf`) |
| worktree | clean |
| TA-3 completion | graph `ta3-implementation-20260809` final PASS (6/6 nodes); verification 21/21; independent review 10/10; external PASS verdict received (Controller-pasted, per VCA-1 Phase 0E audit record) |
| admission authority handed back | `runAdmittedGraph` is the production admission gate (TA-2R); budget authority derives from the frozen admission (TA-3 B1) |
| competing Control Plane implementation | none — `git grep` over tracked sources shows "Central Control Plane" only in roadmap/unauthorized lists; no `src/control-plane/`, `src/optimizer/`, `src/cost-optimizer/` module exists |
| unrelated domains inspected | none — Aura / PR17 / broker / Receiver were not traversed |

Conclusion: CP-1 prerequisites hold. No competing Control Plane exists; the field is greenfield and is being bounded here.

---

## 3. Ownership map (Phase B) — exactly one owner per fact/decision

The existing system already assigns most authority. CP-1 must not move any of it. This map is the reference for every downstream card.

| Fact / decision | Exactly one owner | Current module | CP-1 does NOT change this |
|---|---|---|---|
| Execution permission (admit / block a task) | Admission | `src/admission/admission-gate.mjs` (`runAdmittedGraph`) | unchanged |
| Size / risk classification | Admission classifier | `src/admission/classify.mjs` | unchanged |
| Capability grant / deny | Admission registry + projection | `src/admission/registry.mjs`, `src/admission/policy-projection.mjs` | unchanged |
| Policy projection (lifecycle / isolation / durability / memory / review / repair / evidence / human gates / review surface) | Admission | `src/admission/policy-projection.mjs` | unchanged |
| Per-task budget envelope (limits) | Admission-derived | `src/budget/contract.mjs`, `src/budget/envelope.mjs` | unchanged — runtime never widens it |
| Budget consumption enforcement | Budget enforcement | `src/budget/enforcement.mjs`, `src/budget/ledger.mjs` | unchanged |
| Single-task lifecycle sequencing (PASS / REPAIR / HOLD) | Lifecycle runner | `src/lifecycle-runner.mjs` | unchanged |
| Single-task graph scheduling (DAG order) | Graph scheduler / runners | `src/v2/runner.mjs` + colima/subagent/durable runners | unchanged |
| Model selection policy | Frozen single-model policy (R9) | `src/schema/card-input.schema.json`, `src/admission/registry.mjs`, `src/v2/pi-transport-adapter.mjs` | unchanged — CP may only select within the frozen allowlist |
| Reviewer routing (deterministic / independent / external) | Admission review policy + risk | `src/admission/policy-projection.mjs` | unchanged |
| Repair budget (authority, not meter) | Admission repair_budget + lineage | admission record (TA-2 / TA-2R) | unchanged |
| Runtime / subagent adapters (executor, reviewer, writer) | Enforcement adapters | `src/adapter/`, `src/runtime/`, `src/subagent/` | unchanged — shape validation only, no authority |
| Telemetry recording | Telemetry | `src/telemetry/` | unchanged — observation only, never task authority |
| External review verdict | Controller / harness | `src/governance/external-review.mjs` | unchanged — result artifact is harness-owned |
| Memory trust ladder / write-back | Memory | `src/memory/` | unchanged |
| Reversible lifecycle authorization | Governance | `src/governance/` | unchanged |
| **Cross-task coordination (queue / ordering / global scheduling)** | **Control Plane (v1)** | **new — frozen here** | **the gap this card fills** |
| **Cost/quality optimization (bounded selection inside authority)** | **Control Plane optimizer** | **new — frozen here** | **see cost-optimizer-contract.md** |
| **Cross-task budget allocation (within Controller-authorized global budget)** | **Control Plane (v1)** | **new — frozen here** | **never overrides per-task admission envelopes** |

**Rule of the map:** a fact that already has exactly one owner keeps that owner. The Control Plane only becomes the owner of facts that today have **no owner** (cross-task) or are explicitly assigned to it below. It never becomes a second owner of an already-owned fact.

---

## 4. Control Plane boundary (Phase C) — what it DOES own

The v1 Control Plane owns exactly the coordination and optimization decisions that are **cross-task or cross-path**, and nothing else.

### 4.1 DOES own

1. **Cross-task execution coordination** — the queue/sequence of tasks, global scheduling, and prioritization. (v1 minimal: an explicit ordering seam; a task set is admitted one task at a time through the existing `runAdmittedGraph`.)
2. **Policy-driven model/runtime selection** — choosing executor model/runtime **from the admission-frozen model/runtime allowlist** using observable facts; it must **not** enable new models or fallbacks. (Configuration note, not contract semantics: the current allowlist value is exactly `deepseek/deepseek-v4-flash` under R9 — a lawful change to the allowlist changes configuration, not this ownership contract.)
3. **Cross-task budget allocation** — splitting a **Controller-authorized global budget** across queued tasks. It may propose/set a task-level allocation, but the per-task budget envelope still derives from the frozen admission (TA-3 B1); allocation can only narrow, never widen.
4. **Cost/quality optimization** — the optimizer decision function (inputs → bounded outputs) defined in `cost-optimizer-contract.md`. It recommends/selects **inside** authorized authority.
5. **Telemetry-derived adaptation** — consuming telemetry + historical evidence to adjust the bounded choices (executor, retry, reviewer strategy, allocation) for the **next** decision. It does not write telemetry or give telemetry authority.
6. **Routing between execution / review / repair / replan paths** — routing the admitted task along those paths strictly inside the authorized risk envelope. Routing follows the eligible-set ladder: the **Lifecycle Runner owns which transitions are legal now**, the **admission review policy owns which reviewer strategies are required/allowed**, the optimizer **selects/orders only within those eligible sets**, and the authoritative owner validates and enforces the transition. When only one option is authorized, the optimizer has no freedom.

### 4.2 MUST NOT absorb

The Control Plane must **not** own, re-implement, or become a second authority for:

- **Admission** — execution permission, classification, capability registry, policy projection remain `src/admission/*`. CP consumes frozen admissions; it never mints or amends them.
- **Budget envelope authority** — the per-task budget contract stays admission-derived; runtime enforcement stays in `src/budget/*`. CP allocation is a scheduling input, not a new envelope authority.
- **Telemetry** — recording, event identity, store, and the "telemetry is never a task authority" invariant stay in `src/telemetry/*`.
- **Lifecycle state machine / reversible lifecycle** — stays in `src/governance/*` and `src/lifecycle-runner.mjs`.
- **Reviewer verdict authority** — external review result artifact stays harness/Controller-owned.
- **Runtime / subagent adapters** — stay enforcement adapters (`src/adapter/*`, `src/runtime/*`, `src/subagent/*`); CP never bypasses them.
- **Memory trust ladder / write-back** — stays in `src/memory/*`.
- **Model policy (R9)** — CP selects within the frozen allowlist; it may not add models, fallbacks, or "pro" tiers.

### 4.3 Required invariant

> **Central coordination ≠ centralized ownership of every subsystem.**

The Control Plane is a **coordination seam**, not a policy authority. It is allowed to hold only the cross-task/cross-path facts; every subsystem keeps its own single owner from §3. If a future card finds the Control Plane re-implementing admission, budget, telemetry, or lifecycle logic, that is a contract violation (HOLD), not an acceptable refactor.

---

## 5. Authority boundaries (Phase E)

```text
Agent proposal
      ↓
Runtime adapter (captures proposal + context)
      ↓
Admission authority (ALLOW / BLOCK / REPLAN / HOLD)          ← authoritative
      ↓
Budget envelope (admission-derived)                          ← authoritative
      ↓
Control Plane (coordination + optimizer)                     ← selects INSIDE authority
      ↓
Runtime enforcement                                          ← mechanical
      ↓
Actual execution + telemetry/evidence
```

- **Admission remains authoritative for execution permission** — no task runs without a frozen admission through `runAdmittedGraph`.
- **AET / PER remain governance policy** — the Control Plane obeys them; it does not rewrite them.
- **Runtime adapters remain enforcement adapters** — they enforce AutoLoop decisions, never mint policy (AET-3).
- **The optimizer may recommend/select inside authority but may not mint authority** — it cannot grant a capability, widen a budget envelope, enable a model, or turn a HOLD into a PASS.
- **Eligible-set selection** — the Lifecycle Runner owns legal transitions and the admission review policy owns reviewer strategies; the optimizer selects only among multiple already-authorized options and returns `NO_RECOMMENDATION` / "authoritative constraint requires HOLD" when it has no freedom or the constraint forces HOLD. The optimizer's HOLD is not a new HOLD authority; the existing owner executes the transition.
- **HIGH RISK ≠ HUMAN APPROVAL REQUIRED** — the human approves the **risk envelope**, not every risky decision; inside the authorized envelope the agent/optimizer may proceed autonomously.
- **Outside the authorized risk envelope ⇒ HOLD** — the optimizer has no discretion to "trade off" its way out of the envelope; out-of-envelope is a routing decision to HOLD, never a scoring decision.

---

## 6. State model (Phase F) — Control Plane datum classification

Every datum the Control Plane touches must be classified into exactly one bucket. Telemetry and cache must never become accidental source-of-truth.

| Bucket | Definition | Examples | Authority rules |
|---|---|---|---|
| **authoritative durable state** | the single source-of-record for a mutable fact; one owner | frozen admission records; budget ledger; external-review-result artifacts; lifecycle authorization records; governance docs | written only by its §3 owner; CP reads, never rewrites |
| **derived state** | re-computable from authoritative durable state | effective budget contract/envelope; policy projections; effective authority intersection | re-derived, never stored as a second truth; a drift between derived and source is a HOLD, not a merge |
| **telemetry** | bounded, allowlisted observation records (identities + counters + timings + metadata) | `autoloop.telemetry-event/v1` events; aggregates | observation only; a recording failure surfaces as `TELEMETRY_UNAVAILABLE` / `TELEMETRY_STORE_INVALID` and cannot change task semantics |
| **cache** | disposable, re-computable acceleration | optimizer suggestion snapshots; memory retrieval snapshots | never authoritative; any consumer must be able to re-derive from durable state; cache loss is a performance event, never a correctness event |
| **historical evidence** | preserved but non-authoritative past state | superseded bundles; superseded admissions; historical telemetry aggregates; closeout evidence | discoverable history is not executable authority (AET-1); read-only for adaptation |

**Hard rule:** the Control Plane's optimizer reads telemetry + historical evidence + durable state, and writes only (a) bounded optimizer decisions recorded as derived state, and (b) any cross-task queue/schedule facts that CP owns (§4.1). It never writes into the telemetry store as a task-authority substitute, and it never treats a cache hit as a source-of-record.

---

## 7. Minimum v1 contract (Phase G)

The smallest Control Plane needed for v1:

1. A **cross-task coordination seam** that admits tasks one at a time through `runAdmittedGraph` and records ordering/priority. No multi-controller consensus, no distributed queue.
2. An **optimizer** that is a bounded, deterministic decision function: telemetry + historical evidence + frozen admission + Controller-authorized global budget → the bounded outputs in `cost-optimizer-contract.md`. v1 optimizer selects among the choices already authorized by admission; it invents nothing.
3. A **routing seam** that dispatches the task to execution / review / repair / replan strictly inside the authorized risk envelope, with out-of-envelope ⇒ HOLD.
4. A **budget allocation seam** that splits a Controller-authorized global budget across queued tasks without widening any per-task admission-derived envelope.

### Explicitly deferred (not v1)

- multi-controller / multi-agent consensus coordination,
- predictive or learning complexity (no model training, no online weight updates, no self-evolution),
- dynamic pricing strategy,
- autonomous model switching beyond the frozen allowlist (R9 single-model remains until separately authorized),
- cross-project / cross-repo / cross-deployment coordination,
- global budget forecasting,
- a persistent "world model" of task outcomes beyond historical evidence records.

Each deferred item may be re-admitted by a **separate future card** only after the v1 contract is proven and the authority boundaries of §4–§5 are re-verified.

---

## 8. Anti-patterns (what CP-2 must not build)

1. **God-object:** a single module that imports admission, budget, telemetry, memory, and governance and re-decides their outputs.
2. **Second policy authority:** CP emitting its own `ALLOW/BLOCK/REPLAN/HOLD` verdicts that admission is expected to obey.
3. **Telemetry-as-truth:** the optimizer treating a telemetry aggregate as a permission or a budget.
4. **Cache-as-truth:** a stale optimization snapshot surviving a source-of-record change (must re-derive or invalidate).
5. **Optimizer minting authority:** "the optimizer chose a cheaper model" as a substitute for "the model is in the frozen allowlist and the admission authorizes it."
6. **Envelope escape by scoring:** any scoring formula whose output can exceed the authorized risk envelope. Out-of-envelope is HOLD, never a score.

---

## 9. Review-question answers (self-check before CP-2)

1. **Is every decision owned exactly once?** Yes — §3 maps each fact/decision to one owner; CP owns only cross-task/cross-path facts that previously had no owner.
2. **Does the Control Plane coordinate rather than absorb subsystems?** Yes — §4.1 owns coordination; §4.2 lists the subsystems it must not absorb; §4.3 states the invariant.
3. **Can optimizer decisions be made without minting authority?** Yes — §5: select inside authority, never mint; out-of-envelope ⇒ HOLD.
4. **Are cost/quality/risk inputs observable and provenance-bearing?** Yes — see `cost-optimizer-contract.md` §2 (input provenance requirements); telemetry stays observation-only; no fabricated cost data.
5. **Are outputs bounded enough to implement mechanically?** Yes — see `cost-optimizer-contract.md` §3 (bounded output enum).
6. **Does it preserve authorized-risk-envelope autonomy?** Yes — §5 (HIGH RISK ≠ HUMAN APPROVAL; autonomy inside envelope; HOLD outside).
7. **Does it avoid coupling to Pi/Codex/other specific runtimes?** Yes — CP is provider-neutral; adapters remain the only runtime-specific seam; model selection is allowlist-driven, not provider-coupled.
8. **Is the v1 surface minimal?** Yes — §7 lists four seams; predictive/learning/multi-controller items are explicitly deferred.
9. **Can CP-2 implement this without reopening architecture?** Yes — CP-2 must implement only §7 seams against §3–§6; any need to reopen §3 ownership is a HOLD (architecture change), not an implementation detail.
10. **Are any D1/D2/F6 dependencies accidentally introduced?** No — CP-1 is repo-local governance design; it does not touch broker (D1), principal secret strategy (D2), or the authority domains those block.

---

## 10. Fixed shorthand

- **CP-OWN-1** — exactly one owner per fact/decision; the Control Plane owns only cross-task/cross-path facts that had no owner.
- **CP-OWN-2** — central coordination ≠ centralized ownership; CP must not absorb admission/budget/telemetry/lifecycle/memory/adapters.
- **CP-OWN-3** — optimizer selects inside authority, never mints it; outside the authorized risk envelope ⇒ HOLD.
- **CP-OWN-4** — telemetry and cache are never source-of-truth; authoritative durable state is written only by its §3 owner.

---

## Scope boundary

This document is AutoLoop governance policy for the **bounded AutoLoop domain only**. It does not merge, own, or redefine the authority of Aura / PR17 / broker / Receiver / Pi. Those remain domain-local (AET-1); they appear here only as names of domains CP-1 must not inspect or absorb.
