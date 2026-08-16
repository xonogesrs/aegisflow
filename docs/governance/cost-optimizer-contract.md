# Cost Optimizer — Decision Contract

> **Card:** `CP-1` — Central AutoLoop Control Plane Ownership & Cost-Optimization Contract Freeze
> **Mode:** DESIGN / CONTRACT FREEZE — no implementation code, no scoring formulas
> **Policy authority:** AutoLoop governance
> **Status:** candidate — pending CP-1 independent review (defines the optimizer input/output contract; becomes authoritative/frozen only after CP-1 external PASS + commit)
> **Sibling contract:** `docs/governance/control-plane-ownership-contract.md`

---

## 0. What this document freezes

This document freezes the **input/output decision contract** of the v1 cost optimizer. It deliberately does **not** freeze scoring formulas, weights, thresholds, or tuning policy — those are implementation decisions deferred to CP-2 (or later) and must obey the boundaries here.

The optimizer's job is one sentence:

> Given observable, provenance-bearing facts and the already-authorized envelope, return a **bounded** selection — never a new authority.

---

## 1. Authority position

- The optimizer is a **recommender/selector inside authority**, not a policy authority (CP-OWN-3).
- It cannot grant a capability, widen a budget envelope, enable a model, change a reviewer verdict, or convert a HOLD into a PASS.
- Every output must be **mechanically checkable** against the frozen admission and the authorized risk envelope.
- **Outside the authorized risk envelope ⇒ HOLD** — there is no score that authorizes leaving the envelope.

```text
authority/durable inputs (frozen admission + budget ledger: risk class, profile, capabilities, budget envelope, remaining budget, review policy)
        +
observed optimization inputs (telemetry + historical evidence + lifecycle/graph-derived phase)
        +
Controller-authorized global budget
        ↓
optimizer (bounded, deterministic)
        ↓
bounded decision: executor/model/runtime · budget allocation · retry/replan · reviewer strategy · escalation class
```

---

## 2. Inputs (facts) — what the optimizer may read

Every input must be **observable** (produced by a real meter or a recorded event) and **provenance-bearing** (traceable to the producing module and record identity). Unobservable or fabricated inputs are not legal optimizer inputs.

### 2.1 Authority / durable inputs

| Input | Source | Provenance |
|---|---|---|
| task type | admission record (`task_id`) | `autoloop.task-admission/v1` (frozen) |
| risk class | `admission.risk` (LOW/MEDIUM/HIGH/CRITICAL) | admission record |
| profile | `admission.profile` | admission record |
| authorized risk envelope | admission capabilities + policy projection + budget envelope | `src/admission/policy-projection.mjs`, `src/budget/envelope.mjs` |
| repair budget (authority) | `admission.repair_budget` + lineage | admission record (TA-2 / TA-2R) |
| authorized capability / eligibility | `admission.capabilities` (required / allowed / denied) | `src/admission/registry.mjs` (frozen capability registry) |
| remaining budget | budget ledger (cumulative consumed vs limit) — **authoritative durable state**, not telemetry | `autoloop.budget-ledger/v1` |
| frozen model/runtime allowlist | card input schema + registry (R9 policy) | `src/schema/card-input.schema.json`, `src/admission/registry.mjs` |
| global budget allocation | Controller-authorized global budget | Controller record (not optimizer-invented) |

### 2.2 Observed optimization inputs (telemetry + lifecycle/graph-derived context)

| Input | Source | Provenance |
|---|---|---|
| current execution/decomposition phase | lifecycle/graph state — **not admission authority**; provenance-bearing derived context | lifecycle runner / graph scheduler |
| historical success/failure | `node.run` / `graph.closeout` events, final verdicts | `autoloop.telemetry-event/v1` |
| model/runtime identity (observed) | recorded executor/runtime identity — an observation of **who ran**, not a capability proof | adapter result + telemetry identity |
| token/cost measurements | `tokenSource` — legal value `NOT_REPORTED` today; never an estimate | telemetry model block |
| latency | `timing.durationMs`, node `latencyMs` | telemetry / graph result |
| retry history | `agent.retryCount`, node `attempt`, recovery provenance | telemetry / graph result |
| quality / reviewer outcomes | reviewer verdict + classification | reviewer result + telemetry |

### 2.3 Hard rules on inputs

- **No fabricated cost data** — `tokenSource: NOT_REPORTED` is the only legal value while no provider meter exists; derived estimates are not recorded as real tokens. The optimizer must treat missing token data as *unknown*, never as zero cost.
- **No secret / content inputs** — prompts, model responses, source blobs, stdout/stderr, and user data are not legal optimizer inputs (telemetry allowlist already excludes them).
- **Telemetry is never task authority** — an optimizer that reads telemetry as a *permission* or a *budget* violates both this contract and the telemetry contract.
- **Identity ≠ capability (F3)** — observed runtime/model identity is a telemetry fact; eligibility/capability is authoritative only from the admission capability registry. The optimizer may observe "who executed before" but must not infer "what it is currently allowed to execute" from that history.
- **Phase ≠ admission authority** — the current execution/decomposition phase is lifecycle/graph-derived context; the optimizer reads it as context but must never use a phase transition to amend, re-derive, or override the frozen admission.

---

## 3. Outputs (bounded decisions) — what the optimizer may return

Every output must be a member of a **closed enum**, mechanically checkable. The optimizer returns a bounded decision record; the enforcing component (admission/budget/runtime) remains authoritative.

| Output | Bounded set | Enforced by |
|---|---|---|
| selected executor / model / runtime | an entry from the **admission-frozen model/runtime allowlist** (no fallback, no routing to an unauthorized model) | admission registry + card input schema |
| budget allocation | a split of the Controller-authorized global budget; each task's envelope stays admission-derived (allocation only narrows) | `src/budget/*` |
| retry / replan choice | an option from the **eligible transition set owned by the Lifecycle Runner** (`CONTINUE` / `RETRY` / `REPLAN`), inside the admission repair budget; when the only legal transition is `HOLD`, the optimizer returns `NO_RECOMMENDATION` / "authoritative constraint requires HOLD" | lifecycle runner + admission repair_budget |
| reviewer strategy | an option from the **eligible reviewer set owned by the admission review policy** (`deterministic` / `independent` / `external`), never weaker than required; if only one option is authorized, the optimizer has no selection freedom | `src/admission/policy-projection.mjs` |
| escalation class | `IN_ENVELOPE` / `HOLD_*` — the optimizer **reports the authoritative constraint** that requires HOLD (e.g. `REPAIR_BUDGET_EXHAUSTED`, `BUDGET_EXHAUSTED`, `AUTHORITY_ESCALATION_REJECTED`); it does not mint HOLD authority | `src/governance/holds.mjs` |

**Eligible-set selection — lifecycle/reviewer boundary:** the optimizer never decides *whether* a transition is legal or *which* reviewer strategies are required/allowed — that authority stays with the Lifecycle Runner (legal transitions) and the admission review policy (reviewer strategies). The optimizer's only freedom is to **order or choose among multiple already-authorized options**:

```text
authoritative owner (Lifecycle Runner / admission review policy)
        ↓
eligible action / strategy set (authorized transitions / allowed reviewers)
        ↓
optimizer selects within that already-authorized set
        ↓
authoritative owner validates and enforces the transition
```

- If the authoritative owner authorizes exactly one option, the optimizer has **no freedom** — it returns that option (or `NO_RECOMMENDATION`).
- The optimizer's `HOLD` is **not a new HOLD authority**: it reports "authoritative constraint requires HOLD" or returns `NO_RECOMMENDATION`; the final transition is still executed by the existing owner.

**Model/runtime allowlist — configuration vs contract (F2):** the contract freezes the *rule* — selected model/runtime MUST be a member of the admission-frozen allowlist. The *current value* of that allowlist — today exactly `deepseek/deepseek-v4-flash` (R9), no fallback, no "pro", no multi-model routing — is **operational/configuration truth**, not optimizer contract semantics. A future lawful change to the allowlist changes configuration, not this contract.

**Negative output is part of the contract:** the optimizer may return "no recommendation" (e.g., insufficient evidence). `NO_RECOMMENDATION` means the enforcing component uses the **authoritative owner's existing default / sole eligible option** — the optimizer never invents a fallback. For admission-derived choices that is the admission-derived default; for lifecycle/reviewer choices it is the default or sole eligible option defined by their existing authoritative owner (Lifecycle Runner / admission review policy).

---

## 4. Trade-off boundary (cost vs quality vs latency vs risk)

The optimizer may trade off cost/quality/latency **only within the authorized envelope**, and every trade-off must be expressible as a choice among §3 outputs. It may **not**:

- trade away a **capability** the admission required,
- trade away an **external review** the admission required,
- trade away the **risk envelope** (HIGH/CRITICAL requirements are not scored away),
- widen the **budget envelope** to "save time" or "improve quality",
- select a **weaker reviewer** than admission requires to save cost.

`HIGH RISK ≠ HUMAN APPROVAL REQUIRED` (PER / Phase-R teaching case): the human approves the envelope; inside the envelope the optimizer may choose autonomously. Outside the envelope the only legal output is the relevant HOLD.

---

## 5. Scoring formulas — explicitly deferred

CP-1 freezes the **decision contract**, not the **scoring policy**. The following are deferred to CP-2 (or later) and must not be designed here:

- numeric weights across cost/quality/latency/risk,
- threshold tuning,
- any learned / predictive model (no training, no online updates, no self-evolution),
- dynamic pricing strategy,
- autonomous model switching beyond the frozen allowlist.

When CP-2 (or later) introduces scoring, it must prove:
1. every scored input is observable + provenance-bearing (§2),
2. every scored output is a member of the §3 bounded enums,
3. no score can produce an out-of-envelope result (§4),
4. the scoring policy has exactly one owner and does not re-own admission/budget/telemetry (CP-OWN-1/2).

---

## 6. Minimal v1 optimizer surface

The v1 optimizer is a bounded, deterministic function with:

- **inputs:** §2 facts (authority/durable inputs — frozen admission / risk envelope / repair budget / budget ledger / allowlist / global budget — plus observed optimization inputs — telemetry + lifecycle/graph-derived phase context),
- **outputs:** §3 bounded decision record,
- **fallback (optional optimization evidence only, F4):** historical latency / quality / retry / reviewer-outcome evidence that is absent or contradictory ⇒ `NO_RECOMMENDATION`, and the enforcing component uses the **authoritative owner's existing default / sole eligible option** (admission-derived default for admission-derived choices; the Lifecycle Runner / admission review policy default or sole eligible option for lifecycle/reviewer choices). The optimizer never invents a fallback; missing optimization evidence never stops the task.
- **fail-closed (authority-critical truth, F4):** admission / risk envelope / budget ledger / model allowlist that is contradictory, malformed, or missing provenance ⇒ **HOLD** — never fall back to a default and continue.
- **fail-closed (out-of-envelope):** any output outside the authorized risk envelope ⇒ HOLD (never a "best guess").

It is **not** a service, a server, or a second authority. It is a decision seam the Control Plane calls between decisions, and its outputs are verified by the existing enforcement components.

---

## 7. Review-question answers (self-check)

1. **Owned exactly once?** The optimizer's decision record is derived state; the Lifecycle Runner owns legal transitions and the admission review policy owns reviewer strategies (eligible sets), the optimizer only selects within them, and admission/budget/telemetry/reviewer authorities are unchanged (see ownership contract §3).
2. **Coordinate rather than absorb?** The optimizer consumes, never re-owns.
3. **Decisions without minting authority?** Yes — §1/§3/§4; out-of-envelope ⇒ HOLD.
4. **Inputs observable + provenance-bearing?** Yes — §2; fabricated/missing cost data is treated as unknown, never zero.
5. **Outputs bounded enough to implement mechanically?** Yes — §3 closed enums.
6. **Preserves authorized-risk-envelope autonomy?** Yes — §4.
7. **Avoids coupling to specific runtimes?** Yes — allowlist-driven; Pi/Codex/other runtimes appear only as enforcement adapters.
8. **v1 surface minimal?** Yes — §6; scoring/learning/dynamic pricing deferred in §5.
9. **CP-2 can implement without reopening architecture?** Yes — implement §6 against §1–§5; reopening ownership is a HOLD.
10. **No D1/D2/F6 introduced?** Yes — optimizer touches only the bounded AutoLoop domain.

---

## 8. Fixed shorthand

- **OPT-1** — optimizer selects inside authority; it never mints authority.
- **OPT-2** — inputs must be observable + provenance-bearing; unknown cost ≠ zero cost.
- **OPT-3** — outputs are closed-enum, mechanically checkable; no score may leave the authorized envelope.
- **OPT-4** — scoring formulas/weights/learning are deferred until CP-2 (or later) and must obey OPT-1/2/3.
- **OPT-5** — the optimizer selects only within the eligible set owned by the authoritative owner (Lifecycle Runner / admission review policy); no eligible-set owner ⇒ no optimizer freedom; optimizer HOLD is a reported constraint, never a minted authority.
