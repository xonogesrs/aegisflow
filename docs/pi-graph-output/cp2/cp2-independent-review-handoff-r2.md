# CP-2R2 — Independent Implementation Re-Review Handoff (Sink-Time Enforcement Repair)

> Card: `CP-2R2 — SINK-TIME AUTHORITY AND BUDGET ENFORCEMENT REPAIR`
> Mode: Scoped implementation repair + execution-path verification
> Implementer: AutoLoop agent (Pi, this session)
> Produced at: 2026-08-15T06:28:53Z
> Baseline commit: `4958739a657f2e6e472379cf3d75d9a827e081f7` (CP-1 frozen — unchanged)
> Independent review status: **PENDING**
> Implementer self-report: **REPAIR COMPLETE / CP2R2_READY_FOR_INDEPENDENT_REREVIEW**
> NOT self-reviewed for PASS. NOT committed.

---

## 0. Supersedes prior handoffs

This handoff **supersedes** the R1 handoff
(SHA `31b16585c8ec7ec2ea1d1a57209da6b0b72536b1cc062993becf1d3dcbd3c534`)
and the original CP-2 handoff
(SHA `af44df677e10a00325070d87595f3316b1da15026b42c3ab3ddac41db70c076f`).
Do not reuse either prior review binding.

---

## 1. Frozen review decisions (do not reopen)

- CP-1 executor/model/runtime ownership split = **CONFORMANT (A)** — frozen.
- CP-1 contracts are frozen and unchanged. Their SHA-256 (identical to prior reviews):

| Contract | SHA-256 |
|---|---|
| `docs/governance/control-plane-ownership-contract.md` | `841f3fd2469d269505430cf12c7cce9f16e778fc22cb697a92536cdbae6124e6` |
| `docs/governance/cost-optimizer-contract.md` | `85073aba75c66cd4b70a85dd4bd02d769876af2d909341e1b0305d84afc88b6c` |

---

## 2. Repaired implementation (working tree, uncommitted)

The central invariant repaired here is:

> **PLANNED AUTHORITY != ENFORCED AUTHORITY** unless the exact authoritative
> values are cryptographically/structurally bound through to the execution
> sink and validated there.

| File | SHA-256 |
|---|---|
| `package.json` | `ca5ec6dec8eeace39d120ed7b2a3228228afc065392f947ed0ee49dfeaf29b44` |
| `src/control-plane/contract.mjs` | `1dba99af11763ae6e2128835875a4fda0c9f578a9545cd4c9ecc55ac569f78fa` |
| `src/control-plane/optimizer.mjs` | `b9eea9b142445d09044c74ab1607973ed65a1c72fbe36af0056f52a88e5d88c5` |
| `src/control-plane/coordinator.mjs` | `d48b57a49978d488f1648729dffee0c068029648faa0236fc4d83bce3f25cd7a` |
| `src/control-plane/index.mjs` | `3a62f2efe25e0781e7f0a921690992ceee970b2b4427ab18d4c09647c48ef0e0` |
| `src/admission/admission-gate.mjs` | `9d87ab1f5bc39579bc068bc669934cc5d2ad48dbadc556d917218a518444bbff` |
| `src/admission/admission-record.mjs` | `ec8e4259bb3864e9f6a0334a782b0d4e21faea9690c6d147684df9ce0db28f3f` |
| `src/admission/policy-projection.mjs` | `d337f0eecf55311de4f558f9513fc784a044d09497d63e8ae0567026d748b696` |
| `src/budget/enforcement.mjs` | `f4ba3c208106ad16e364a14cc3b3a7355ee1fad2f4b1620cf77f230638cb6912` |
| `src/lifecycle-runner.mjs` | `df062d2eaa91faeaf659be50311910c9505189e8538f55d9fd2137d78b90729b` |
| `test/control-plane/helpers.mjs` | `10ddfe0bfd9dc2fcfdd7f49462dc245f974f67c8ff6a3afb50ad920a6c463753` |
| `test/control-plane/test-optimizer.mjs` | `9485aaa1592649db228515823f3a7e7d4bfefefc2c40d6ee9efc92a099bf180a` |
| `test/control-plane/test-coordinator.mjs` | `f9acb780c3d16b3450a484f75d4e431d18a5cbac73c743dae6d31bb591ce182c` |
| `test/control-plane/test-allowlist-parity.mjs` | `5182d66609945a2d48550bf67fbf44c9c39fbb0787ec7190bf9ed9dd4c670e79` |
| `test/control-plane/test-execution-sink.mjs` | `c9015285ef98e2cb8d71fa9705f94ed59fada430b4cc34762fa873cf02ff8daf` |

No CP-1 contract touched. `src/control-plane/index.mjs` is unchanged from R1.

---

## 3. Finding → repair → test mapping

### Finding 1 — global budget allocated in plan but not enforced at sink

**Repair paths:**
- `src/control-plane/coordinator.mjs` — each task's authoritative allocation
  is now a bound object `{ taskId, admissionId, dimensions, allocationId }`
  (allocationId = `sha256(canonical({taskId, admissionId, dimensions}))`)
  carried in `plan.tasks[].taskAllocation`. `executeSequentially` passes it to
  `runAdmittedGraph` as `budget.allocation` and independently re-verifies the
  taskId/admissionId binding + integrity digest before dispatch.
- `src/admission/admission-gate.mjs` — the sink validates the allocation's
  admissionId binding + integrity digest (`ALLOCATION_BINDING_MISMATCH`)
  BEFORE the runner resolves, and forwards the validated dimensions as
  `childLimits`.
- `src/budget/enforcement.mjs` — `createBudgetEnforcement` now applies
  `childLimits` MONOTONICALLY (narrow-only) to the derived envelope even
  without a parent enforcement, so the runner-visible envelope limits ARE the
  global-derived allocation, never the original full envelope.

**Tests:** `test/control-plane/test-execution-sink.mjs` proves the runner
receives effective node limits **16 and 4** (not 16 and 16) under a global
remaining budget of 20; plus missing-allocation / cross-task-reuse /
reconstructed-allocation rejection. `test/control-plane/test-coordinator.mjs`
proves the collective split + bound allocation.

### Finding 2 — Control Plane minting lifecycle authority from budget

**Repair paths:**
- `src/control-plane/coordinator.mjs` — the budget-derived
  `deriveEligibleTransitions` is REMOVED. `coordinate` consumes the
  authoritative eligible transition set from the Lifecycle Runner; a missing /
  invalid lifecycle state yields `OPTIMIZER_MISSING_LIFECYCLE_AUTHORITY`.
- `src/lifecycle-runner.mjs` — new authoritative
  `deriveLifecycleEligibleTransitions({ lifecycleState, repairBudget,
  repairAttempts })` derives CONTINUE/RETRY/REPLAN from lifecycle state +
  admission repair authority ONLY (never budget counters); terminal/unknown
  state → fail closed.
- `src/control-plane/optimizer.mjs` — missing `eligibleTransitions` →
  `MISSING_LIFECYCLE_AUTHORITY`; empty → `NO_ELIGIBLE_OPTION`; and a new
  required-dimension exhaustion check turns a zero remaining in ANY dimension
  the admission contract requires (positive envelope limit) into
  `BUDGET_EXHAUSTED`, so a non-node exhausted dimension can no longer produce
  `RECOMMENDATION / IN_ENVELOPE`.

**Tests:** `test-coordinator.mjs` "missing lifecycle authority", "empty
eligible lifecycle set", "zero budget in each required dimension", "mixed
exhausted/non-exhausted dimensions", "lifecycle eligibility comes from the
Lifecycle Runner, not budget counters". `test-optimizer.mjs` "missing
lifecycle authority", "empty eligible transitions", "unknown transition enum",
"caller-substituted REPLAN with repair_budget 0", "required-dimension
exhaustion". All exercise actual decision/execution eligibility via
`coordinate`/`runOptimizer`, not helper return values.

### Finding 3 — admission identity substitutable after planning

**Repair paths:**
- `src/control-plane/coordinator.mjs` — `executeSequentially` no longer
  spreads caller options over authoritative fields. It verifies the plan
  identity re-derives, verifies `admission.admission_id === planned
  admissionId`, and rejects any `runnerOpts` key that names an authoritative
  field (`CP_AUTHORITY_OVERRIDE_REJECTED`). Only the test-injection `runner`
  seam is forwarded, and it still passes through `runAdmittedGraph`'s
  mandatory gate.
- `src/admission/admission-record.mjs` — production admission validation now
  enforces semantic policy consistency: isolation/durability policy must match
  the profile projection. A rehashed FAST_PATH + `durability_policy:"durable"`
  (and any other profile/policy inconsistency) is rejected, not merely
  shape/hash-validated.

**Tests:** `test-execution-sink.mjs` "runnerOpts admission override",
"STANDARD plan + HIGH admission substitution", "admission identity/digest
mismatch", "caller substitution cannot change the admission identity between
planning and sink", "valid original admission executes exactly once".
`test-optimizer.mjs` "rehashed but semantically invalid FAST_PATH (durable)",
"valid-looking admission with policy inconsistency".

### Finding 4 — Control Plane duplicates R9 model configuration

**Repair paths:**
- `src/control-plane/contract.mjs` — `EXECUTOR_MODEL_ALLOWLIST` is now READ
  from the single authoritative `TRANSPORT_FREEZE`
  (`src/v2/pi-transport-adapter.mjs`); the duplicated hardcoded value set is
  removed. Fail-closed: an unloadable/invalid authoritative configuration
  yields a null allowlist, and the optimizer's existing
  `OWNERSHIP_UNRESOLVED` HOLD fires (never a fallback to a second value set).

**Tests:** `test/control-plane/test-allowlist-parity.mjs` asserts the allowlist
is derived from `TRANSPORT_FREEZE` and that `contract.mjs` contains no second
hardcoded model literal.

### Finding 5 — runtime still caller-selectable

**Repair paths:**
- `src/admission/policy-projection.mjs` — `deriveExecutorRuntime` and
  `EXECUTOR_RUNTIMES` now live with the admission owner (single source).
- `src/control-plane/optimizer.mjs` — runtime is AUTHORITATIVELY derived from
  the validated admission. A caller/context-supplied runtime is evidence only:
  it must equal the derivation or `CONTRADICTORY_AUTHORITY`; unknown derived
  runtime → `RUNTIME_UNRESOLVED`. The optimizer never selects or substitutes
  runtime independently.

**Tests:** `test-optimizer.mjs` "runtime is admission-derived (no caller
evidence needed)", "caller runtime substitution → HOLD" (STANDARD + `direct`),
"unknown runtime → HOLD". `test-coordinator.mjs` "deriveExecutorRuntime is
strict".

---

## 4. Sink-time execution evidence

New targeted integration suite: `test/control-plane/test-execution-sink.mjs`
spans the full path:

```
coordinate → planned authority → executeSequentially → runAdmittedGraph
→ runner-visible/effective execution constraints
```

A spy runner captures the ACTUAL arguments reaching the runner. The mechanical
test proves:

- two STANDARD tasks (envelope 16 nodes each) under a Controller global budget
  of 20 reach the runner with **node limits 16 and 4** (sum ≤ 20, no
  double-spend at execution time);
- the admission object reaching the runner is EXACTLY the planned admission
  identity (caller substitution cannot change it between planning and sink);
- `runnerOpts` admission override, STANDARD→HIGH admission substitution,
  admission identity/digest mismatch, missing allocation, cross-task allocation
  reuse, reconstructed allocation, and tampered plan identity are all rejected
  BEFORE the runner is invoked.

---

## 5. Anti-bypass audit result

Inspected CP-2 entry points (`coordinate`, `runOptimizer`,
`executeSequentially`, and the `runAdmittedGraph` budget/allocation seam):

- **Object spread precedence** — fixed: `executeSequentially` no longer spreads
  caller `runnerOpts` over `admission`/`graph`/`budget`; authoritative fields
  are bound first and caller authority keys are rejected.
- **Optional/default parameters** — `runAdmittedGraph({ admission, graph,
  runner, budget, ...runnerOpts })` keeps the mandatory admission gate before
  any runner resolution; the `runner` test seam still goes through the gate.
- **Test injection seams** — the `runner` seam is the only execution seam and
  is forwarded through `runAdmittedGraph`, never called directly.
- **Direct calls to optimizer** — runtime is admission-derived (Finding 5);
  lifecycle eligibility is consumed from the Lifecycle Runner (Finding 2);
  allowlist is read from R9 (Finding 4). No caller substitution path remains.
- **Direct calls to executeSequentially** — plan identity re-derivation +
  admission identity + allocation binding are all re-verified at the sink.
- **Missing-field fallback** — missing `remaining` → HOLD (never full
  envelope); missing lifecycle state → HOLD; missing allocation where a
  Controller global budget was provided → HOLD.
- **Reconstruction/re-hashing of authority objects** — allocation integrity
  digest + admission_id re-derivation + semantic policy consistency all
  fail closed.

No alternate path bypasses global child allocation, lifecycle authority,
production admission validation, admission identity binding, authoritative
model allowlist, or admission-derived runtime. Audit did not broaden into
unrelated repository domains.

---

## 6. Verification

| Suite | Result |
|---|---|
| control-plane (incl. new sink-time suite) | 58 / 58 |
| budget | 44 / 44 |
| admission | 135 / 135 |
| governance | 340 / 340 |
| telemetry | 37 / 37 |
| `npm run check` (all src syntax) | clean |
| `git diff --check` | clean |

Sink-time integration suite reported separately: `test/control-plane/test-execution-sink.mjs`
(9 tests, all passing).

(Note: the top-level `test/test-*.mjs` suite shows pre-existing,
environment-related `scratchRoot may not be repository/worktree path`
failures in `src/runtime/scratch-ownership.mjs` / subagent-graph tests —
outside CP-2R2 scope and untouched by this repair.)

---

## 7. Acceptance criteria

Reviewer confirms/denies:

1. The exact per-task global allocation is the EFFECTIVE runner-visible limit
   (16 + 4 = 20, never 16 + 16 = 32), enforced at `runAdmittedGraph`/budget
   enforcement, not merely at plan generation.
2. Control Plane no longer mints lifecycle transitions from budget counters;
   it consumes the Lifecycle Runner's authoritative eligible set and fails
   closed when that authority is missing/invalid/empty.
3. Budget exhaustion in ANY required dimension prevents an executable
   recommendation (HOLD), including non-node dimensions.
4. Admission identity is bound through to the sink; caller `runnerOpts`,
   admission substitution, and rehashed but semantically invalid admissions
   are all rejected.
5. The R9 allowlist has ONE runtime source; the Control Plane holds no second
   authoritative value set.
6. Runtime is admission-derived; caller runtime is evidence-only and
   substitution fails closed.
7. The sink-time tests capture actual runner arguments/limits and prove
   caller substitution cannot change authoritative values between planning and
   sink execution.
8. CP-1 ownership boundaries are unchanged; no new parallel owner created.

Final verdict:
`PASS / CP2_CONTROL_PLANE_MINIMAL_SEAMS_AND_COST_OPTIMIZER_IMPLEMENTED_AND_VERIFIED`
or a precise `HOLD` naming the remaining conflict.

The implementer does NOT self-report the final PASS.

---

## 8. How to bind this review

Verify this file's SHA-256, then verify the frozen-contract SHAs in §1 and the
implementation/test SHAs in §2 against the working tree (uncommitted by design;
review the working tree, not any other revision). Absolute path of this
handoff:

`/Volumes/NVM2T/Development/autoloop/docs/pi-graph-output/cp2/cp2-independent-review-handoff-r2.md`
