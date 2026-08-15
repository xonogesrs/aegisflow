# CP-2 — Independent Implementation Review Handoff

> Card: `CP-2 — CONTROL PLANE MINIMAL SEAMS + COST OPTIMIZER IMPLEMENTATION`
> Mode: Implementation + verification (CP-1 contracts frozen and authoritative)
> Implementer: AutoLoop agent (Pi, this session)
> Produced at: 2026-08-15T04:53:21Z
> Baseline commit: `4958739a657f2e6e472379cf3d75d9a827e081f7` (CP-1 frozen)
> NOT self-reviewed. NOT committed. Implementation left untouched while producing this handoff.

---

## 1. Review request

This handoff requests an **independent implementation review** of CP-2 against the
frozen CP-1 contracts. The reviewer must judge conformance, not implementation
style. The implementer has made no review verdict and has not committed.

Expected verdicts (exact):

```text
PASS / CP2_CONTROL_PLANE_MINIMAL_SEAMS_AND_COST_OPTIMIZER_IMPLEMENTED_AND_VERIFIED
```
or a precise `HOLD` identifying a real contract/implementation conflict.

---

## 2. Frozen CP-1 contracts (authoritative inputs)

These are the only authority CP-2 may implement against. Their content SHA-256
at the CP-1 commit:

| Contract | Path | SHA-256 |
|---|---|---|
| Control Plane ownership | `docs/governance/control-plane-ownership-contract.md` | `841f3fd2469d269505430cf12c7cce9f16e778fc22cb697a92536cdbae6124e6` |
| Cost optimizer | `docs/governance/cost-optimizer-contract.md` | `85073aba75c66cd4b70a85dd4bd02d769876af2d909341e1b0305d84afc88b6c` |

Key frozen clauses CP-2 is bound by:

- CP-1 §7 defines four minimal seams: (1) cross-task coordination, (2) bounded
  deterministic optimizer, (3) routing strictly inside the authorized risk
  envelope with out-of-envelope ⇒ HOLD, (4) budget allocation that only narrows.
- Optimizer selects **inside** authority, never mints it (CP-OWN-3 / OPT-1).
- `NO_RECOMMENDATION` uses the authoritative owner's existing default / sole
  eligible option; the optimizer never invents a fallback (C1).
- Inputs must be observable + provenance-bearing; unknown cost ≠ zero cost.
- Outputs are closed-enum, mechanically checkable; no score may leave the envelope.
- Scoring formulas are deferred (CP-1 §5).

---

## 3. CP-2 implementation diff / scope

Working-tree state (uncommitted by design):

```text
 M package.json
?? src/control-plane/
?? test/control-plane/
```

### 3.1 package.json (only change to a tracked file)

```diff
     "test:governance": "node --test test/governance/*.mjs",
+    "test:control-plane": "node --test test/control-plane/*.mjs",
     "test:search-scope": "node --test test/admission/test-search-scope-governor.mjs",
```

### 3.2 New files (content SHA-256 for binding)

| File | SHA-256 |
|---|---|
| `src/control-plane/contract.mjs` | `9856bf5eb5054fd793374d5b380432344f65c04cf812da5b25024be5df70e1f6` |
| `src/control-plane/optimizer.mjs` | `e999dcab3852d020504dcb3661fcd977d0a91500b8081318ab6fb0eafb129e19` |
| `src/control-plane/coordinator.mjs` | `c8beff90153350dd937b53e2a4436dee09aed09b3d51b9364eb0284c0c1f1098` |
| `src/control-plane/index.mjs` | `3a62f2efe25e0781e7f0a921690992ceee970b2b4427ab18d4c09647c48ef0e0` |
| `test/control-plane/helpers.mjs` | `05cc09d8b9f0ab3ebe76195c50ef48d09b11d8df2f298c40385df03584adccde` |
| `test/control-plane/test-optimizer.mjs` | `3de2918e228c5be26c487c81bc285a78a0ae577f7d0e53bcc938e137033d683a` |
| `test/control-plane/test-coordinator.mjs` | `0d0a103e7e98302049680195bdabfb3289981676aa69454acb053f9b100e84bc` |
| `test/control-plane/test-allowlist-parity.mjs` | `60b6133ba30ab9adf3ad5055431bbce2d92cd7d44f4a1390612a30ebfa1990ca` |

No other tracked file was modified. No existing source was changed.

---

## 4. Authoritative ownership mapping (implementation vs authority)

| Fact / decision | Authoritative owner | CP-2 usage |
|---|---|---|
| Execution permission | `src/admission/admission-gate.mjs` (`runAdmittedGraph`) | consume frozen admission only; never mint |
| Budget envelope / ledger | `src/budget/*` (TA-3) | `deriveBudgetEnvelope` + `assertEnvelopeUntampered`; never re-derive |
| Telemetry | `src/telemetry/aggregate.mjs` | `aggregateGraphRun` → observed provenance (`aggregateIdentity`) |
| Lifecycle transitions | `src/lifecycle-runner.mjs` | eligible transition set projected from budget/repair facts; enforcement not reimplemented |
| Reviewer strategy | admission `review_policy.strength` | singleton eligible reviewer set |
| Model allowlist | R9 `TRANSPORT_FREEZE` (config truth) | `EXECUTOR_MODEL_ALLOWLIST`; parity test guards drift |

---

## 5. Four seams (CP-1 §7) → implementation

1. **Cross-task coordination** — `coordinator.coordinate()` orders tasks
   (priority, then stable input index); `executeSequentially()` runs ONE task at
   a time through an injected runner (production binds to `runAdmittedGraph`).
   No multi-controller consensus, no distributed queue.
2. **Optimizer** — `optimizer.runOptimizer(ctx)` is pure/deterministic; consumes
   only authority/durable inputs + provenance-bearing observed input; emits a
   closed-enum decision record.
3. **Routing** — decision `escalationClass ∈ {IN_ENVELOPE} ∪ HOLD`; out-of-
   envelope / no-eligible-option / unknown-enum / ownership-unresolved ⇒ HOLD;
   final transition still executed by the Lifecycle Runner.
4. **Budget allocation** — `min(globalBudget[d], envelope.limit[d])` per
   dimension; allocation only narrows, never widens.

---

## 6. Explicit item requiring reviewer judgment (implementer §7 note)

The frozen cost-optimizer contract §3 lists ONE output:

> selected executor / model / runtime — an entry from the admission-frozen
> model/runtime allowlist (no fallback, no routing to an unauthorized model)

CP-2 implementation **splits** this into:

- **Optimizer selects** `{ provider, model }` from `EXECUTOR_MODEL_ALLOWLIST`
  (single R9 entry `deepseek/deepseek-v4-flash`).
- **Coordinator derives** `runtime` (colima/subagent/durable) from the
  admission's `durability_policy` / `isolation_policy`
  (`deriveExecutorRuntime`), NOT from the optimizer.

Implementer's rationale: the runtime is already authoritative from admission
(isolation/durability policy); making the optimizer "select" it would give the
optimizer a second authority over a fact admission already owns, violating
CP-OWN-1/2 and "runtime adapters remain enforcement adapters".

**Reviewer must judge exactly one of:**

- (A) CONFORMANT refinement — the frozen output's "runtime" component is
  admission-derived, so the optimizer correctly selects only the allowlisted
  `{provider, model}` and the runtime is a passthrough of admission authority; or
- (B) DEVIATION — the frozen contract requires the optimizer to also select the
  runtime as part of the allowlist entry, so the implementation must be changed
  before CP-2 can PASS.

This is the single most consequential conformance question in the review.

---

## 7. Fail-closed matrix implemented (cost-optimizer §2/§3 + CP-2 card)

| Condition | Hold code (reported, never minted) |
|---|---|
| malformed input (missing admission/envelope, bad globalBudget shape) | `OPTIMIZER_MALFORMED_INPUT` |
| observed input without provenance | `OPTIMIZER_MISSING_PROVENANCE` |
| contradictory authority (envelope/admission mismatch, RETRY with 0 retry budget, REPLAN with 0 repair_budget) | `OPTIMIZER_CONTRADICTORY_AUTHORITY` |
| unsupported/unknown dimension (e.g. `token_budget`) | `OPTIMIZER_UNKNOWN_ENUM` |
| unknown transition / reviewer enum | `OPTIMIZER_UNKNOWN_ENUM` |
| no authorized executor allowlist | `OPTIMIZER_OWNERSHIP_UNRESOLVED` |
| no eligible transition / reviewer | `OPTIMIZER_NO_ELIGIBLE_OPTION` |

Selection rule: sole eligible → select; multiple eligible → `NO_RECOMMENDATION`
(owner default applies, field = null); the optimizer never invents a fallback.
Scoring/ranking is **not** implemented (deferred per CP-1 §5).

---

## 8. Tests / evidence

Command: `node --test test/control-plane/*.mjs`

| Suite | Result |
|---|---|
| control-plane (new) | 25 / 25 |
| budget | 44 / 44 |
| admission | 135 / 135 |
| governance | 340 / 340 |
| telemetry | 37 / 37 |
| `npm run check` (all src syntax) | clean |

`git diff --check` — clean.

Mechanical properties proven by test (map to CP-2 card §6):

- deterministic identical-input → identical-output: `test-optimizer` "deterministic"
- closed enums: "every output stays inside its closed enum"
- cannot escape eligible set / allowlist: "selection cannot escape the eligible set / allowlist"
- NO_RECOMMENDATION uses owner default (no invented fallback): "multiple eligible options → NO_RECOMMENDATION"
- fail-closed matrix: malformed / provenance / contradictory / out-of-envelope /
  unknown-enum / ownership-unresolved / no-eligible-option tests
- cannot override owner: `test-coordinator` "invalid admission surfaces a HOLD"
  and "routing stays inside envelope"
- one-at-a-time dispatch: "executeSequentially dispatches one at a time, skips HOLD"
- no competing source-of-truth: `test-allowlist-parity` binds the control-plane
  allowlist to the single R9 `TRANSPORT_FREEZE`.

---

## 9. What the implementer did NOT do

- No commit / push / merge / seal.
- No self-review verdict.
- No scoring/ranking policy (deferred per CP-1 §5).
- No change to any existing source module other than the single `package.json`
  test-script line.
- No new runtime backend, no scheduler rewrite, no competing Control Plane.

---

## 10. Acceptance criteria (exact)

The reviewer confirms or rejects each:

1. CP-2 implements only CP-1 §7 minimal seams; no ownership architecture reopened.
2. Optimizer consumes only authorized/provenance-bearing inputs.
3. Optimizer operates inside authoritative eligible sets and envelopes.
4. Optimizer emits only contract-defined closed-enum recommendations.
5. `NO_RECOMMENDATION` never invents a fallback.
6. Authoritative owner remains final validator/enforcer.
7. Fail-closed on malformed / missing-provenance / contradictory / out-of-
   envelope / unknown-enum / ownership-unresolved.
8. Optimizer does NOT become owner of admission / global budget / telemetry
   truth / lifecycle authority / reviewer policy / final enforcement.
9. Mechanical tests prove the card §6 properties.
10. The §6 (above) executor/model/runtime split is judged (A) conformant or
    (B) deviation — a definitive answer is required.

Final: `PASS / CP2_CONTROL_PLANE_MINIMAL_SEAMS_AND_COST_OPTIMIZER_IMPLEMENTED_AND_VERIFIED`
or a precise `HOLD` naming the contract/implementation conflict.

---

## 11. How to bind this review

Verify this file's SHA-256, then verify the frozen-contract SHAs in §2 and the
implementation file SHAs in §3.2 against the working tree before judging. The
working tree is uncommitted by design; review the working tree at the SHAs
listed above, not any other revision.
