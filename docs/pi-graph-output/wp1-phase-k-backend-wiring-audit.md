# WP1 Phase K — Supported Harness / Backend Wiring Audit

Card: AUTOLOOP_WP1_MULTI_SESSION_CONTINUITY_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1
Date: 2026-09-21
Method: source-trace of every production dispatch route from the supported
backends/adapters through the canonical AutoLoop entrypoint to WP1's
durable-session / rollover / provenance / consumption seams.

## Backend/adapter inventory

| # | Backend / adapter | Source | Role |
|---|---|---|---|
| 1 | `pi-builtin` provider adapter (RPC) | `src/adapter/pi-rpc-adapter.mjs` | executor backing for provider-backed sub-agent nodes; the sole `providerUsage` authority |
| 2 | `pi-builtin` spawn adapter | `src/adapter/pi-spawn-adapter.mjs` | successor session spawn (rollover); registers both capability rows |
| 3 | Colima container runtime | `src/runtime/colima-*.mjs` | isolated execution (executor/reviewer/worktree/scratch) |
| 4 | Scripted adapter | `src/adapter/scripted-adapter.mjs` | deterministic offline lifecycle testing — never a provider |
| 5 | Direct lifecycle runner (SOP) | `src/sop/proportional-sop.mjs` `createDirectExecutionRunner` | FAST_PATH direct execution, no graph |

## Dispatch routes (all through `runAdmittedGraph`, `src/admission/admission-gate.mjs`)

| Route | Entry | WP1 seams reached |
|---|---|---|
| `graph: "subagent"` → `runSubagentGraphAdmitted` | `src/subagent/subagent-graph-runner.mjs` → `runDurableGraph` → `runColimaGraph` | ALL: durable session, rollover intake (canonical executor derived inside the gate), provider-backed dispatch + usage observation, authored-result provenance envelope, CEDF reconciliation, successor composition, scratchPreserve continuity |
| `graph: "durable"` → `runDurableGraphAdmitted` | `src/v2/durable-graph.mjs` → `runColimaGraph` | durable session, rollover intake, §9a/§13a gates, budget handover. Sub-agent provenance seams compose only when the IR declares sub-agent phases (`composeSuccessorSubagentGraphOpts`) |
| `graph: "colima"` → `runColimaGraphAdmitted` | `src/runtime/colima-graph-runner.mjs` | container execution only — no durable session, no rollover (legacy same-session semantics; the gate derives no rollover executor for this route) |
| coordinator `runtime: "direct"` → `DIRECT_EXECUTION_RUNNER` | `src/control-plane/coordinator.mjs` → `runAdmittedGraph` | admission/budget/governance only — no durable session, no WP1 continuation (by design: FAST_PATH direct tasks are single-shot) |
| coordinator `runtime: "colima" / "durable"` | `t.graph = runtime` → `runAdmittedGraph({ graph })` | durable route reaches the WP1 durable seams; colima route does not |
| `runtime: "subagent"` (isolation_policy `worktree`) | same mapping — `graph: "subagent"` | reaches ALL WP1 seams when dispatched through the coordinator |

## Classification

| Backend / route | Class | Evidence |
|---|---|---|
| `graph: "subagent"` (pi-builtin provider + Colima isolation, via `runSubagentGraphAdmitted`) | **WP1_WIRED** | Phase G/H/I probes ran this exact route: rollover A→B→C (MULTI_HOP PASS), fan-out/fan-in (PARALLEL PASS), crash/resume (CRASH PASS) |
| `graph: "durable"` (non-sub-agent IR) | **WP1_WIRED** (durable session + rollover seams; sub-agent provenance seams N/A — no sub-agent phases) | `scripts/rollover-3era-probe.mjs` PASS (13/13); durable-graph suite 19/19 |
| `graph: "durable"` (sub-agent IR via `runSubagentGraphAdmitted`) | **WP1_WIRED** | same entry as row 1 |
| coordinator `runtime: "durable"` | **WP1_WIRED** | routes to `graph: "durable"` through the same gate |
| coordinator `runtime: "subagent"` | **WP1_WIRED** | `t.graph = runtime` maps directly; same gate |
| `graph: "colima"` (`runColimaGraphAdmitted`) | **OPTIONAL_UNWIRED** | no durable session / rollover by design (legacy same-session semantics documented at `resume-gate.mjs` §14); NOT advertised as a WP1 continuation route |
| coordinator `runtime: "direct"` (FAST_PATH) | **OPTIONAL_UNWIRED** | single-shot direct execution; no durable session by design |
| Scripted adapter | **INTERNAL_ONLY** | offline lifecycle testing surface; never registered in the spawn registry; never a provider |
| `pi-builtin` × `deepseek` / `merge-gateway` capability rows | **WP1_WIRED** | both rows registered in `SPAWN_RUNTIME_CAPABILITIES` and exercised (3-era probe used deepseek; G/H/I probes used merge-gateway) |
| Other providers/adapters (unregistered pairs) | **UNSUPPORTED** | `resolveSpawnAdapter` fails closed (`spawn_adapter_kind_unsupported`) before any provider call |
| `src/autoloop.mjs` / `runDurableAutoLoop` / `resumeAutoLoop` | **UNSUPPORTED** | unconditional `NON_PRODUCTION_ENTRYPOINT` fail-closed dead ends |

## Key invariants verified

1. **No silent fallback**: a provider-backed sub-agent node whose provider
   session fails fails the node closed (`PROVIDER_BACKING_FAILED`) — no
   container-only fallback (`subagent-graph-runner.mjs` PB4 test).
2. **Single rollover authority**: the canonical rollover executor is derived
   INSIDE the gate from the frozen admission + durable truth; caller-supplied
   executors are fenced at both sinks (`AUTHORITY_SEAM_RUNNER_KEYS`,
   `AUTHORITATIVE_RUN_KEYS`).
3. **No non-durable downgrade**: a supported route that loses its durable
   state fails closed (`RESUME_FINGERPRINT_MISMATCH`, budget-ledger
   reconstruction refusal) — never silently continues session-local.

## Counts

- SUPPORTED_BACKENDS = 5 (subagent route, durable route, colima route, direct route, pi-builtin provider rows)
- WP1_WIRED_BACKENDS = 4 (subagent, durable, coordinator durable/subagent mappings, pi-builtin rows)
- OPTIONAL_UNWIRED_BACKENDS = 2 (colima legacy route, direct FAST_PATH)
- INTERNAL_ONLY = 1 (scripted adapter)
- UNSUPPORTED = 2 (unregistered provider pairs, legacy autoloop entrypoints)
- UNKNOWN = 0 → no HOLD

## Conclusion

Every supported production route either reaches the WP1 continuation seams or
is explicitly scoped out (legacy colima route / FAST_PATH direct) with its
non-durable semantics documented and fail-closed. No supported backend
silently falls back to non-durable/session-local behavior.
