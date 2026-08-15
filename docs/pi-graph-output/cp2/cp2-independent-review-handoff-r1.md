# CP-2R1 — Independent Implementation Re-Review Handoff

> Card: `CP-2R1 — CONTROL PLANE AUTHORITY / BUDGET FAIL-CLOSED REPAIR`
> Mode: Scoped implementation repair
> Implementer: AutoLoop agent (Pi, this session)
> Produced at: 2026-08-15T05:26:54Z
> Baseline commit: `4958739a657f2e6e472379cf3d75d9a827e081f7` (CP-1 frozen — unchanged)
> Independent review status: **PENDING**
> Implementer self-report: **REPAIR COMPLETE / CP2R1_READY_FOR_INDEPENDENT_REREVIEW**
> NOT self-reviewed for PASS. NOT committed.

---

## 0. Supersedes prior handoff

The previous CP-2 handoff (SHA `af44df677e10a00325070d87595f3316b1da15026b42c3ab3ddac41db70c076f`)
is **superseded** for review of the repaired implementation. Do not reuse the
old review binding.

---

## 1. Frozen review decisions (do not reopen)

- CP-1 executor/model/runtime split = **CONFORMANT (A)** — frozen by the
  independent reviewer.
- CP-1 contracts are frozen and unchanged. Their SHA-256 (identical to the
  prior review):

| Contract | SHA-256 |
|---|---|
| `docs/governance/control-plane-ownership-contract.md` | `841f3fd2469d269505430cf12c7cce9f16e778fc22cb697a92536cdbae6124e6` |
| `docs/governance/cost-optimizer-contract.md` | `85073aba75c66cd4b70a85dd4bd02d769876af2d909341e1b0305d84afc88b6c` |

---

## 2. Repaired implementation (working tree, uncommitted)

| File | SHA-256 |
|---|---|
| `package.json` | `ca5ec6dec8eeace39d120ed7b2a3228228afc065392f947ed0ee49dfeaf29b44` |
| `src/control-plane/contract.mjs` | `7a9014d8fcc1b6648e028f0d682827bbf4048f43cc1b560aa85859341e9f2c15` |
| `src/control-plane/optimizer.mjs` | `5236e8370a6a97bfa02240bfece296d59f00d2a65a4c5a7e58c25658b2090bd1` |
| `src/control-plane/coordinator.mjs` | `7da0006dbec2e938a7df80514d96cf3e95f488ac064b1d9dadfad495a2748895` |
| `src/control-plane/index.mjs` | `3a62f2efe25e0781e7f0a921690992ceee970b2b4427ab18d4c09647c48ef0e0` |
| `test/control-plane/helpers.mjs` | `648765d1e9a4b679bd0b4eeb556a193c11020fa31358727f1cfb8aaecf0ad0e6` |
| `test/control-plane/test-optimizer.mjs` | `d00ed1d915a774591e05076c846048c660e4e4e0d20041a930fba7ed00022a67` |
| `test/control-plane/test-coordinator.mjs` | `c509a2ff4b8ba8d0652fecabea3d998b49805a981e36677894dc8bca49533868` |
| `test/control-plane/test-allowlist-parity.mjs` | `60b6133ba30ab9adf3ad5055431bbce2d92cd7d44f4a1390612a30ebfa1990ca` |

No other tracked file modified. No CP-1 contract touched.

---

## 3. Finding → repair → test mapping

### Finding 1 — global budget not split
- **Repair:** `coordinator.splitGlobalBudget()` now performs a collective,
  sequential narrowing over the ordered tasks: `sum(allocations) ≤ global`
  and each task ≤ its envelope. The optimizer no longer computes per-task
  `min(global, envelope)` independently; it validates a per-task
  `taskAllocation` ceiling that may only narrow the envelope.
- **Tests:** `global budget is split collectively — no double-spend`;
  `zero global budget → task is not executable (HOLD)`.

### Finding 2 — lifecycle / budget authority fail-open
- **Repair:** `deriveEligibleTransitions` no longer hardcodes `CONTINUE`
  (returns `[]` when `node_execution_count ≤ 0`); the coordinator requires
  ledger-derived `remaining` (never defaults to the full envelope); the
  optimizer requires `budgetRemaining` (missing → `OPTIMIZER_MISSING_BUDGET_AUTHORITY`);
  exhausted → `OPTIMIZER_NO_ELIGIBLE_OPTION`.
- **Tests:** `deriveEligibleTransitions never hardcodes CONTINUE and fails
  closed`; `missing ledger remaining → HOLD`; `exhausted ledger remaining →
  HOLD`; `missing budget remaining (ledger authority) → HOLD`.

### Finding 3 — admission execution bypass
- **Repair:** `executeSequentially` dispatches only through the imported
  authoritative `runAdmittedGraph` (arbitrary `runTask` callback removed);
  `runnerOpts` merely forward `ir`/`cwd`/`runner` into `runAdmittedGraph`,
  where admission is enforced BEFORE the runner. The optimizer now uses
  `assertProductionAdmission` (full schema/capability/profile validation)
  instead of id-only re-derivation.
- **Tests:** `executeSequentially reaches authoritative runner exactly once`;
  `rehashed/forged admission is never dispatched`; `rehashed/forged
  admission surfaces HOLD`; `rehashed/forged admission → HOLD`.

### Finding 4 — allowlist caller-controlled
- **Repair:** the optimizer imports the authoritative
  `EXECUTOR_MODEL_ALLOWLIST`; a caller-supplied `executorAllowlist` is
  accepted only if deep-equal to the authoritative one, else
  `OPTIMIZER_CONTRADICTORY_AUTHORITY`.
- **Tests:** `caller cannot substitute the authoritative allowlist → HOLD`;
  `caller allowlist equal to authoritative → accepted`;
  `control-plane allowlist mirrors the R9 transport freeze`.

### Finding 5 — runtime fallback fail-open
- **Repair:** `deriveExecutorRuntime` is strict — only
  `durable`/`colima`/`worktree`/`FAST_PATH` map; unknown → `null`. The
  optimizer validates `runtime ∈ EXECUTOR_RUNTIMES` (`null` →
  `OPTIMIZER_RUNTIME_UNRESOLVED`, unknown → `OPTIMIZER_UNKNOWN_ENUM`);
  `direct` added for FAST_PATH; `executeSequentially` never graph-dispatches
  `direct` (no silent fallback).
- **Tests:** `deriveExecutorRuntime is strict (no permissive fallback)`;
  `unknown runtime → HOLD`; `missing runtime → HOLD`;
  `fast-path (direct) task is not graph-dispatched`.

---

## 4. Negative coverage added (card §REQUIRED NEGATIVE COVERAGE)

1. multi-task global budget allocation / no double-spend — ✓
2. exhausted ledger / zero remaining budget — ✓
3. missing required ledger/authority — ✓
4. malformed but rehashed/re-shaped admission — ✓
5. execution attempt without authoritative admission — ✓
6. arbitrary runner / injected runner bypass attempt — ✓ (runner seam removed;
   dispatch goes through `runAdmittedGraph`)
7. unauthorized singleton model/provider allowlist — ✓
8. caller-supplied allowlist expansion/substitution — ✓
9. invalid runtime policy — ✓
10. FAST_PATH / unknown runtime fallback attempt — ✓
11. authoritative eligible/default unavailable — ✓ (empty eligible set → HOLD)
12. valid happy path after all fail-closed repairs — ✓

---

## 5. Tests / evidence

| Suite | Result |
|---|---|
| control-plane (new/repaired) | 37 / 37 |
| budget | 44 / 44 |
| admission | 135 / 135 |
| governance | 340 / 340 |
| telemetry | 37 / 37 |
| `npm run check` (all src syntax) | clean |
| `git diff --check` | clean |

---

## 6. Ownership constraints preserved

The Control Plane / optimizer still does NOT own admission, budget
ledger/envelope, lifecycle transitions, model allowlist, runtime
isolation/durability, or reviewer policy. It consumes authoritative inputs
and recommends only inside them. No new competing source-of-truth.

---

## 7. Acceptance criteria

Reviewer confirms/denies:
1. All five blocking findings are actually repaired (not papered over).
2. sum(task allocations) ≤ authoritative global remaining budget, deterministically.
3. Missing/exhausted/invalid budget or lifecycle state is never converted to
   a permissive default.
4. No Control Plane path dispatches a task without `runAdmittedGraph`
   admission enforcement; arbitrary runner cannot bypass.
5. The authoritative allowlist cannot be replaced/expanded by caller input.
6. Invalid/unknown runtime policy never falls back to a permissive runtime.
7. The 12 negative-coverage items prove actual behavior, not string output.
8. CP-1 ownership boundaries are unchanged.

Final verdict: `PASS / CP2_CONTROL_PLANE_MINIMAL_SEAMS_AND_COST_OPTIMIZER_IMPLEMENTED_AND_VERIFIED`
or a precise `HOLD` naming the remaining conflict.

The implementer does NOT self-report the final PASS.
