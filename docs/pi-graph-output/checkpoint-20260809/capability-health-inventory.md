# Checkpoint 2026-08-09 — Capability Health Inventory

## Scope

- Repository: `/Volumes/NVM2T/Development/autoloop`
- Branch: `governance/reversible-lifecycle-draft-pr`
- HEAD: `2e897e995202c0c8c079c5fdc96b9f5d42d50d25`
- Review surfaces: `/Users/zhengfengqing/Desktop/AutoLoop-Review/Current` and `Archive` only.
- Method: bounded, read-only controller audit. No expensive suites, lifecycle runs, commits, or repairs.
- Six available parallel lanes returned findings. Two requested lanes (complexity and roadmap) were covered by Controller. No lane ran tests, lifecycle, edits, bundles, or pushes.

## Production capability graph

`runAdmittedGraph` is one production admission seam. It derives budget authority, invokes Colima/subagent/durable runners, attaches budget reconciliation, and reaches closeout. `src/autoloop.mjs:91-124` exposes a separate `runAutoLoop` path that can call durable/orchestration code without an admission record. Raw subagent/Colima callers also remain. `runColimaGraph` uses state-driven closeout when `closeout.statePath` is supplied; otherwise it retains legacy in-memory closeout. External delivery is structured through `Current/delivery.json`.

| Capability | Wiring | Health | Disposition |
|---|---|---|---|
| Admission gate | `src/admission/admission-gate.mjs` → `runAdmittedGraph` | Production entrypoint; fail-closed admission path | KEEP |
| AutoLoop library entrypoint | `src/autoloop.mjs` → `runAutoLoop` | Separate path can bypass `runAdmittedGraph`; caller/deployment map absent | P1 REWORK |
| Budget contract/enforcement | `src/budget/*.mjs`, admission + runtime runners | Wired, but reviewer/repair/retry meters settle after lifecycle events; see P1 below | KEEP + REWORK |
| Colima isolation | `src/runtime/colima-runtime.mjs` | Network none, explicit mounts, cap drop, no-new-privileges, resource limits, task timeout | KEEP |
| Durable graph/resume | `src/v2/durable-graph.mjs`, `src/subagent/subagent-graph-runner.mjs` | Production path; journal/checkpoint ordering is explicit | KEEP |
| State-driven closeout | `src/governance/closeout-state.mjs`, `runStateDrivenCloseout` | Production-wired when state path exists; legacy branch remains | KEEP + CONSOLIDATE |
| External review delivery | `src/governance/review-bundle.mjs`, Current surface | Structured authority; current verdict still absent | KEEP |
| Verification timing/accounting | `src/governance/verification-timing.mjs`, `scripts/*-verify.mjs` | W1A removes known overlap and uses real elapsed timing for future runs; historical evidence remains stale | KEEP + RESEAL |
| Graph telemetry | `src/telemetry/graph-observer.mjs` | Optional caller callback, not default production instrumentation | KEEP + INSTRUMENT |
| Memory/retrieval/writeback | `src/memory/*`, runner options | Opt-in capability; no default production evidence in allowed roots | KEEP DORMANT |
| Pi RPC / Pi transport | `src/adapter/pi-rpc-adapter.mjs`, `src/v2/pi-transport-adapter.mjs` | No production caller found; probe/test surfaces only | DISABLE or REMOVE after consumer check |

## Findings

### P0 — Caller-supplied scratch root is recursively deleted

`runColimaGraph` accepts any non-empty `scratchRoot` (`src/runtime/colima-graph-runner.mjs:168`), mounts it at `:252`, then executes `rmSync(scratchRoot, { recursive: true, force: true })` at `:556`. No canonical run-scoped-root or symlink-containment check precedes this destructive operation. A caller can therefore turn cleanup into broad filesystem deletion. This is static evidence; no exploit or runtime was run. HOLD all runtime execution until root derivation and deletion scope are fail-closed.

### P1 — Admission is not one universal production seam

`runAdmittedGraph` enforces frozen admission, but `runAutoLoop` and direct raw runner/script callers remain. No bounded deployment/export map proves all production reachability goes through the gate. Make one canonical production entrypoint or explicitly demote raw/library paths.

### P1 — Memory retrieval lacks the writeback-style authority check

`src/admission/policy-projection.mjs:104-106` projects `memory_policy.retrieval_allowed`, but `src/runtime/colima-graph-runner.mjs:211-218` retrieves whenever a provider is supplied. Writeback has an explicit authority check at `:629-633`; retrieval does not. Denied retrieval may execute. Add a fail-closed retrieval check or mark retrieval outside production policy.

### P1 — Policy projection and enforcement are branch-local

Admission profiles declare isolation, durability, memory, review, and human gates. Subagent envelope projection applies only on selected paths; Colima and caller-supplied closeout options do not prove one shared enforcement point. Restrict production runners and derive mandatory review/closeout from the frozen admission.

### P1 — Budget dimensions are observed after some actions, not gated before them

`src/budget/contract.mjs:142-175` declares fail-closed exhaustion for repair, reviewer, and retry counts. `src/budget/enforcement.mjs:210-227` calls `ledgerConfirm`; `src/budget/ledger.mjs:251-259` increments counters and marks state, but returns `{ ok: true }` even when the new counter reaches or exceeds its limit. Production runner calls at `src/runtime/colima-graph-runner.mjs:377-387` and `:414-420` ignore return values. Reviewer and repair hooks are reached from `src/v2/execution-orchestrator.mjs:143-150` during lifecycle execution.

Result: these dimensions are evidence meters and state markers, not complete non-bypassable pre-dispatch gates. `finalize()` reconciles ledger/evidence divergence but does not turn an over-limit counter into a hold by itself. This conflicts with contract text and needs focused production-path verification before any PASS claim about budget enforcement.

### P2 — Dead budget hook wrapper duplicates runner logic

`src/budget/graph-wiring.mjs:39-99` exports `wrapGraphHooks`, including stricter error handling than the production runner. Repository call-site search found definition/comments only; production runners wire the hooks themselves. `attachBudgetResult` is used. Keep one wiring seam; remove or merge unused `wrapGraphHooks` after production consumer confirmation.

### P2 — Telemetry is opt-in, not authoritative by default

`recordGraphTelemetry` is reached through a caller-supplied observer. No default production caller was found. This keeps capability surface small but leaves wall time, token/tool counts, and memory cost absent unless each caller opts in. Treat absent fields as `NOT_INSTRUMENTED`, never zero.

### P2 — Two durable orchestration stacks need ownership map

`src/v2/durable-execution.mjs` and `src/v2/durable-graph.mjs` both own durable state, checkpointing, evidence, termination, and resume. Split may be intentional, but no bounded consumer map proves parent-vs-graph ownership. Inventory consumers before adding another layer; delegate one stack to the other or remove duplicate authority.

### P2 / REMOVE — Historical agent adapters remain reachable by direct invocation

`src/adapter/pi-rpc-adapter.mjs` and `src/v2/pi-transport-adapter.mjs` have tests/probes but no production import. They add maintenance and policy surface without current production value. Preserve only if a named consumer is demonstrated; otherwise disable first, then remove adapters and probe-only contracts together.

## Subtraction decisions

- KEEP: admission, Colima isolation, durable ordering, structured closeout state, Current delivery authority, evidence validation.
- SIMPLIFY: nested verification suites, accounting reruns, IR budget rerun, duplicate closeout wrappers, duplicate bundle generation.
- DISABLE for routine runs: full `test:colima-all`; retain forensic/runtime-card use behind explicit scope.
- MERGE: state-driven closeout into all graph callers; one authoritative bundle per generation.
- REMOVE after parity proof: 17 bespoke `scripts/*-self-closeout.mjs` files, unused `wrapGraphHooks`, and unconsumed Pi adapters.

## Join resolution

Other lanes initially reported no P0. Runtime lane supplied the destructive `scratchRoot` path; direct source inspection confirmed it. Controller assigns P0 despite no runtime reproduction. `runAdmittedGraph` remains a valid gate, but direct `runAutoLoop`/raw callers mean “production path is gated” is not a repository-wide claim.
