# Checkpoint 2026-08-09 — Risk and Debt Register

## Lifecycle authority

Closeout has two paths:

1. `runStateDrivenCloseout` reads persisted closeout state, applies metadata/identity/idempotency rules, then calls mandatory graph closeout.
2. `runMandatoryGraphCloseout` remains available for legacy in-memory callers.

`src/runtime/colima-graph-runner.mjs:467-497` selects state-driven closeout only when `closeout.statePath` is present. `scripts/gov-closeout-bundle.mjs` uses state-driven closeout. Seventeen historical `scripts/*-self-closeout.mjs` files still invoke mandatory closeout directly.

## Current truth

Current structured delivery says:

- card: `AUTOLOOP-TA3`
- bundle generated and validated: true
- external review required/attempted: true
- external status: `AWAITING_EXTERNAL_REVIEW`
- verdict: `null`
- bundle SHA-256: `3fc4a8e95b7bebcea7cf20e5a630af6310a12c78efeb0feeb9d145623891b285`

Current graph evidence and bundle report internal `PASS`. That is an internal graph/closeout result. It is not external acceptance. No contradiction exists if both labels stay qualified; unqualified “PASS” is a reporting risk.

Legacy integration gates still read harness-owned `external-review-result.json` and legacy `READY_FOR_REVIEW.txt` artifacts (`src/governance/integration-commit-gate.mjs:11-18`; `scripts/gov-commit-integration.mjs:69-82`). Current `delivery.json` is therefore not yet the sole verdict authority.

State-driven closeout also accepts a persisted graph evidence shape with limited schema/digest/provenance validation (`src/governance/closeout-state.mjs:189-232`) and derives verifier PASS from `graphResult.final`. Bespoke self-closeout scripts can supply synthetic all-PASS graph/review results. Treat internal PASS as untrusted until runner-owned, digest-bound evidence is required.

Verdict application copies bundle identity/SHA from the delivery record instead of re-reading and hashing the bundle (`scripts/gov-closeout-bundle.mjs:209-227`); forced delivery can set `reviewBundleValidated=false` (`scripts/gov-external-review-surface.mjs:141-172`), and `runStateDrivenCloseout` ignores the `writeCloseoutState` result (`src/governance/review-bundle.mjs:3337`). These are fail-closed authority defects.

## Risk register

| ID | Class | Finding | Evidence | Disposition |
|---|---|---|---|---|
| R-00 | P0 | Caller-supplied `scratchRoot` is recursively deleted after mount; no canonical run-root or symlink containment gate | `src/runtime/colima-graph-runner.mjs:168,252,556` | HOLD all runtime execution; derive/delete only run-scoped child |
| R-01 | P1 | Reviewer/repair/retry budget dimensions settle after lifecycle action; return values ignored; contract promises fail-closed pre-action behavior | `src/budget/contract.mjs:142-175`; `src/budget/ledger.mjs:251-259`; `src/runtime/colima-graph-runner.mjs:377-420` | Focused production-path gate test and bounded rework |
| R-02 | P1 | Current TA3 report carries historical duplicate count and synthetic timing lineage while Current waits for external verdict | `Current/delivery.json`; `Current/evidence.json`; `vca1/vca1-r1-r2-evidence.json` | Reconcile or explicitly label historical evidence before acceptance |
| R-03 | P1 | Bare `pi` remains a wrong-cwd/repo-discovery route; launcher is opt-in and guidance is not OS enforcement | `scripts/pi-autoloop.sh`; VCA1 Phase 0b/0f evidence | Make canonical launcher operationally mandatory for AutoLoop work; retain guard limits |
| R-04 | P2 | Legacy closeout branch and 17 one-shot wrappers can mint parallel historical artifacts | `src/runtime/colima-graph-runner.mjs:467-497`; `scripts/*-self-closeout.mjs` | Migrate callers, then remove wrappers |
| R-05 | P2 | `wrapGraphHooks` duplicates runner wiring and is not called | `src/budget/graph-wiring.mjs:39-99`; call-site search | Merge/remove |
| R-06 | P2 | Telemetry observer is opt-in; default wall/token/tool/memory evidence is absent | `src/telemetry/graph-observer.mjs`; VCA1 evidence | Instrument only named authoritative stores; otherwise mark unknown |
| R-07 | P2 | Full Colima suite is expensive and historically killed without total timing | `package.json:test:colima-all`; VCA1 R1/R2 evidence | Scope-gate and retain forensic mode |
| R-08 | REMOVE candidate | Dormant Pi RPC/transport adapters have no production caller | `src/adapter/pi-rpc-adapter.mjs`; `src/v2/pi-transport-adapter.mjs`; probe/test-only references | Disable, prove no consumer, remove |
| R-09 | P1 | `runAutoLoop`, raw subagent, and direct script paths can bypass `runAdmittedGraph` | `src/autoloop.mjs:91-124`; raw `runSubagentGraph` callers | One canonical admitted production seam |
| R-10 | P1 | Memory retrieval executes when provider exists without checking projected `retrieval_allowed` | `src/admission/policy-projection.mjs:104-106`; `src/runtime/colima-graph-runner.mjs:201-218` | Add fail-closed retrieval authority |
| R-11 | CLOSED | Legacy commit/push/PR gates read `external-review-result.json`, not Current `delivery.json` | `scripts/gov-push-gate.mjs`; `scripts/gov-draft-pr.mjs`; `src/governance/integration-commit-gate.mjs`; `scripts/gov-commit-integration.mjs` | CLOSED. All three legacy authority seams migrated to the canonical chain (review-job ACCEPTED → delivery PASS bound to delivered-bundle digest → recomputed candidate identity → live bindings). Push/draft-PR gates: CLOSED by `AUTOLOOP-PGMA1` (implementation `54ea90a`, remote promotion anchor `governance/push-draft-gate-authority-migration` @ `7e04f4e75f1ddb261d4fa55167c655e5f54069d9`, closeout evidence `docs/pi-graph-output/pgma1/card-closeout-bundle-20260919-pgma1.txt`). Commit-integration gate: CLOSED by landing commit `b9f35f81813dd75c8f656c14d3765903f9af3d1c` on `governance/rsl2-universal-execution-review-surface` (Landing Admission + Landing Review PASS; retired artifact authority = NONE; reverse controls RC-A/RC-B/RC-C/RC-D green; governance regression 534/534). `external-review-result.json` is RETIRED / NON-AUTHORITY for push, draft PR, and commit integration; historical artifacts remain on disk as evidence only. |
| R-12 | CLOSED | State-driven closeout accepts graph evidence with weak schema/digest/provenance binding and can derive internal PASS from supplied result | `src/governance/closeout-state.mjs`; `src/governance/review-bundle.mjs` | CLOSED by `AUTOLOOP_R12_CLOSEOUT_ACCEPTANCE_*`. Technical landing commit `ea927e358dc3678c5d6b74709913f3c18a944cae` on `governance/rsl2-universal-execution-review-surface` (reviewed bytes frozen by `AUTOLOOP_R12_CLOSEOUT_ACCEPTANCE_REVIEW_AND_CLOSEOUT_1`, Review PASS): one canonical graph-evidence validator (`validateGraphEvidence` + `assertGraphAggregateConsistency` in `closeout-state.mjs`) serves both the in-memory graphResult path and the disk `autoloop.review-bundle.graph-closeout-evidence/v1` loader — exact schema enforcement, mandatory `task.cardId`/`graphRunId` identity with card/run binding against the closeout lineage, no silent `graph-unknown`/default-final synthesis, node normalization restricted to canonical runner shapes, required-node completeness from `scheduler.order`, aggregate/child contradiction fencing (`R12_AGGREGATE_CHILD_CONTRADICTION`), state non-authority preserved via durable `verifyAppliedCloseoutBundle` re-verification. Evidence: independent Review PASS (reverse controls RC-A/RC-B/RC-C/RC-D green; 20-case negative matrix fail-closed; disk/memory parity; real `runColimaGraph` E2E 2/2; CLI graph-evidence E2E PASS/HOLD/HOLD; governance regression 548/548, review-unit 17/17, promotion authority 27/27). R-13 (verdict application artifact binding) remains OPEN and out of scope for this closure. |
| R-13 | P1 | Verdict apply copies identity/SHA from delivery record; forced/unvalidated delivery remains possible; state write failure is ignored | `scripts/gov-closeout-bundle.mjs:209-237`; `scripts/gov-external-review-surface.mjs:141-172`; `review-bundle.mjs:3337` | Re-read/hash/validate atomically; fail closed on write |
| R-14 | P2 | Same-generation bundle bytes depend on time; peers retire after render; archive filenames can disagree with persisted status | `review-bundle.mjs:1512-1532,1864-1885,3118-3190`; Archive delivery records | Freeze bytes/identity and add archive index |

## Complexity red-team

Skeptical subtraction result:

- No value in keeping duplicate verification entries after W1A.
- No value in routine IR budget rerun when accounting can reuse recorded regression.
- No value in per-file accounting re-exec outside forensic diagnosis.
- No value in automatic full Colima matrix for non-runtime cards.
- No value in 17 card-specific closeout scripts after state-driven parity.
- No value in a second budget hook abstraction unless a production caller appears.
- No demonstrated need for Agent Plugins or Central Control Plane roadmap work.
- No demonstrated need for another policy/report nexus until current consumers and authorities are mapped.

## Lifecycle debt

State-driven closeout is the right authority seam, but migration is incomplete. Historical one-shot scripts, legacy in-memory closeout, and multiple output directories still exist. This is P2 cleanup unless a caller bypasses current delivery authority; current static evidence does not prove such bypass.

The preceding legacy gate findings upgrade part of this debt to P1: commit/push/PR authorization can consume a different verdict artifact than Current. Same-generation bundle identity also excludes `generatedAt` while rendered bytes include it, so retries can produce time-dependent bytes under one nominal generation. Freeze bytes/identity and retire bundle/evidence/delivery as one linked unit.

## P0 status

P0 established: unbounded recursive scratch deletion is reachable through `runColimaGraph`. P1 risks block a clean “fully enforced and externally accepted” claim. No repair authorized in this checkpoint.
