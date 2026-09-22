# AUTOLOOP R-06 — PRODUCTION GRAPH TELEMETRY INSTRUMENTATION RECONCILIATION

Card: `AUTOLOOP_R06_PRODUCTION_GRAPH_TELEMETRY_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1`
Date: 2026-09-22
Branch: `governance/rsl2-universal-execution-review-surface`
Authority contract: `docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md`
(S16 remains THE authority contract; this record reconciles the landed
R-06 instrumentation against it — it does not restate or amend S16.)
Prior reconciliation: `docs/governance/autoloop-s16-gc-retention-implementation-reconciliation.md`
(GC_RETENTION = PRODUCTION_READY; S16_GC_STAGE = FINAL_CLOSED — unchanged).
Additive; rewrites no historical document.

---

## Phase A — Opening reconciliation (verified live)

| Item | Value |
|---|---|
| Canonical repo | `/Volumes/NVM2T/Development/repos/autoloop` |
| HEAD at open | `08decbd` (S16-GC reconciliation; branch 2 ahead of remote `99b1ce9`, un-pushed, per S16/GC landing) |
| Branch | `governance/rsl2-universal-execution-review-surface` |
| S16 contract commit | `7aa531301d66c203404034bb7a84f8252070b2f0` — present, verified |
| S16 bounded wiring commit | `5ba0372dea83045b9119ff0e13107ea59c4eca94` — present, verified |
| GC implementation commit | `c30f56e` — present, verified |
| GC documentation commit | `08decbd` — present, verified |
| S16_GC_STAGE | FINAL_CLOSED (confirmed) |
| GC_RETENTION | PRODUCTION_READY (confirmed) |
| Staged / stash | none / none |
| Dirty | 3 modified tracked evidence/attribution files + 85 untracked (`rrc/` forensics, pre-WP1 probe JSONs) — PRESERVED as unrelated WIP |
| Push | NO |

Operator session cwd was an unrelated checkout (`/tmp/auracore-wda-rerun-1`,
appium/WebDriverAgent — no AutoLoop content). No mutation occurred there.

## Phase B — Observer seam map (complete; UNKNOWN = 0)

| Seam | Producer | Event type | Lifecycle position | Consumers | Opt-in mechanism | Production callers | Test callers | Storage | Retention | Classification |
|---|---|---|---|---|---|---|---|---|---|---|
| COST-1 passive observer | `src/telemetry/graph-observer.mjs` via `runColimaGraph` `telemetry.observer` | graph.run / node.run / node.repair / graph.closeout / retrieval.observed / verification.recorded | POST-result (after closeout gate, before budget reconciliation attach) | `aggregate.mjs` (advisory), tests, probes | caller `telemetry` opt (was opt-in) | none before this card | test/telemetry/* | TelemetryStore (caller stateRoot) | R1/R2 | **CANONICAL_OBSERVER** (now default-wired) |
| CBM-4 writeback telemetry | `src/memory/writeback/telemetry.mjs` | memory.writeback | post-writeback-gate | same store | `writeback.telemetryStore` opt | none (store optional) | test/memory/test-writeback-telemetry.mjs | same store | R1/R2 | OPTIONAL_ADAPTER |
| Search-governor annotation | `buildSearchGovernorTelemetry` | n/a (embedded) | derived FROM finalized decision | none (no gate reads it) | none | admission decision path | admission tests | rides authority record | R3 | OPTIONAL_ADAPTER |
| Rollover telemetry token | `rolloverTelemetryToken` | n/a (payload annotation) | state mapping | none | none | rollover mirror/journal | rollover tests | rides authority record | R3 | OPTIONAL_ADAPTER |
| Provider usage journal rows | `observeProviderUsageAndTrigger` | PROVIDER_USAGE_OBSERVED / ROLLOVER_USAGE_OBSERVATION_FAILED | at phase terminal (WP1 producer) | rollover trigger producer; window-dedup authority is the durable rollover block | none (WP1-wired) | durable/subagent production paths | rollover tests | evidence journal | R3 (rides #5) | CANONICAL_OBSERVER (authority-journal surface, unchanged) |
| **R-06 lifecycle timeline** (NEW) | `src/telemetry/production-observer.mjs` emitter via runner hook seams | lifecycle.observed (15 bounded stages) | dispatch → phase start → provider usage → rollover → dependency consumption → retry → resume → final → closeout | aggregate (advisory), operators | default-on; `telemetry:false` = explicit disable | runAdmittedGraph → all three graph runners | test/telemetry/test-telemetry-production-instrumentation.mjs | TelemetryStore via S16 resolver | R1/R2 | **CANONICAL_OBSERVER** |

`DUPLICATE_TELEMETRY_SEAMS = 0` (one shared production seam; no second writer
invented a persistent root; the pre-existing opt-in observer is the SAME seam,
now default-wired, not a duplicate).

Why normal production graphs previously ran telemetry-less: `recordGraphTelemetry`
was reachable ONLY through a caller-supplied `telemetry.observer`; no production
caller passed it (verified by call-site census — the only former callers were
deleted R-04 self-closeout wrappers). R-06 closes this by resolving the wiring
once in `runAdmittedGraph` (THE production entrypoint; `runAutoLoop` remains a
fail-closed dead end per R-09).

## Phase C — Production event contract (frozen by implementation)

Operational timeline reconstructable from telemetry alone:

RUN → admission (graph.run.admission) → dispatch (phase.dispatch) → phase start
(phase.start) → provider/subagent usage (provider.usage; subAgentCount via
graph.run) → lifecycle transition (phase.terminal / node.repair) → rollover
(rollover.observed/triggered/request/handover) → dependency consumption
(dependency.consumed) → retry/repair (phase.repair) → final state (run.final) →
closeout (run.closeout).

Event vocabulary: ONE additive event type `lifecycle.observed` with a bounded
15-stage enum (`LIFECYCLE_OBSERVED_STAGES`) + the existing COST-1 taxonomy.
Identity fields only: graphRunId, nodeId/phaseId, attempt, sequence,
occurredAt, outcome (≤64 chars), detail (≤160 chars), sessionId/generation.
NO authoritative artifact is duplicated into telemetry (no prompts, bodies,
stdout/stderr, secrets — allowlist validation fails closed; banned-field scan
retained).

## Phase D — Authority fence (frozen + tested)

`TELEMETRY_AUTHORITY_LEAKS = 0`:

- Resolution failure → `TELEMETRY_UNAVAILABLE` disposition on the envelope;
  the run proceeds identically (D1).
- Corrupt prior store → `TELEMETRY_STORE_INVALID` degraded disposition (D2).
- Append failure / closed store → emitter drops the event, counts it, never
  throws (D3).
- Explicit disable → `telemetryDisabled: true` disposition; zero writes (F2).
- The disposition attach (`attachTelemetryDisposition`) touches ONLY
  `result.telemetry` and never throws (D4: admission/closeout/verdict
  deep-equal untouched).
- No code path reads the telemetry store to make any authority decision
  (verified by call-site census: store consumers = tests, probes, the
  advisory aggregate seam in the coordinator — unchanged from S16 §C).
- Where an existing authoritative evidence contract requires an event (WP1
  provider usage, rollover window dedup), that authority STAYS in the durable
  journal/checkpoint; the R-06 timeline events are mirrors, never the trigger
  basis.

## Phase E — Canonical location wiring (frozen)

All production telemetry resolves through `resolveTelemetryStateRoot()`:
`/Volumes/NVM2T/Development/evidence/autoloop-telemetry/<graphRunId>/` or the
validated `AUTOLOOP_TELEMETRY_STATE_ROOT` override. The resolver is invoked
exactly once per production run, in `runAdmittedGraph` (via
`resolveProductionTelemetryWiring`). No production telemetry writer invents its
own persistent root; no repo-local fallback; no silent cwd fallback (E1/E2
tests). The GC engine's containment fence admits only this namespace.

## Phase F — Default production instrumentation (landed)

Normal supported production graph → `runAdmittedGraph` → telemetry initialized
automatically → canonical event stream emitted. No caller-by-caller opt-in; one
shared seam. Explicit disable is retained (`telemetry: false` at the gate):
explicit, semantics-unchanged, observable (`telemetryDisabled` disposition).
Test-context refinement: inside `node --test` the default is off unless the
override is set — suites never write the canonical production namespace
(F3); this is an isolation refinement of the DEFAULT, not a supported
telemetry-less production path (production processes have no
`NODE_TEST_CONTEXT`).

`SUPPORTED_TELEMETRYLESS_PRODUCTION_PATHS = 0`
(`EXPLICIT_DISABLE_MODE = YES`, documented here and in the runner docs).

## Phase G — Event identity / ordering (frozen + tested)

- Deterministic `eventId` = sha256(graphRunId, eventType, nodeId, attempt,
  sequence) — replayed emission is byte-identical; duplicate lines in the
  store are tolerated as observability and never consumed as authority (G1).
- `sequence` orders chronology within a run; `generation`/`sessionId` bind
  each event to its durable era WITHOUT authority (G2): stale-generation
  telemetry is retained/classified historical-only, never interpreted as
  current authority.

## Phase H — WP1 multi-session telemetry (PASS)

Live probes (canonical COLIMA_HOME):

| Probe | Result |
|---|---|
| `multi-session-wp1-f-continuity.mjs` (A→rollover→B; generation transition, rollover request/dispatch, successor start, dependency consumption, final outcome) | VERDICT = PASS |
| `multi-session-wp1-g-multihop.mjs` (B→rollover→C) | MULTI_HOP_CONTINUITY = PASS |
| `multi-session-wp1-h-fanout.mjs` (A→B1/B2/B3→C; distinct child identities, fan-in without completion-order authority) | PARALLEL_CONTINUITY = PASS |

`MULTI_SESSION_TELEMETRY = PASS`. (During implementation a successor-composition
wiring defect was caught by WP1-F F7 and repaired in-iteration — see Phase M.)

## Phase I — Crash / resume (PASS)

- Resumed era re-opens the SAME run-scoped store; init replay is idempotent
  (H1 test: `created=false`, `replayedInit=true`, single stream across eras).
- Telemetry does not cause resume failure: the resume path emits
  `resume.start` best-effort inside try/catch; durable RESUME_VALIDATED stays
  the authority.
- Partial/torn telemetry: store-level fail-closed (`TELEMETRY_STORE_INVALID`),
  degraded disposition at init; never authoritative (I1 test).
- GC does not remove active recovery telemetry: `RUN_ACTIVE` /
  `RESUME_REQUIRED` / `ROLLOVER_IN_PROGRESS` lifecycles delete NOTHING
  (Phase L live proof below); terminal telemetry becomes retention-eligible
  only after the recovery window.

`CRASH_RESUME_TELEMETRY = PASS`.

## Phase J — Failure / degradation matrix (PASS)

| Case | Classification | Authority effect |
|---|---|---|
| telemetry root unavailable (unwritable parent) | DEGRADED_OBSERVABILITY (`TELEMETRY_UNAVAILABLE`) | none (D1) |
| permission/write failure (closed store / append throw) | RETRYABLE_TELEMETRY (emitter drops + counts; next append may succeed) | none (D3) |
| malformed previous telemetry | INVALID_TELEMETRY (`TELEMETRY_STORE_INVALID`, degraded) | none (D2) |
| truncated chunk (torn line) | INVALID_TELEMETRY (store-level fail-closed on reopen) | none (I1) |
| duplicate event | IGNORED_DUPLICATE (byte-identical id; tolerated) | none (G1) |
| stale generation event | retained/classified historical (generation binding) | none (G2) |
| wrong graphRunId | foreign run — run-scoped roots prevent collision; not this run's store | none (S16 §J) |
| disk pressure / bounded write failure | RETRYABLE_TELEMETRY (rotation bounds; drop+count) | none |
| observer throws | DEGRADED_OBSERVABILITY (try/catch at every seam; envelope disposition) | none (invariance tests) |
| telemetry explicitly disabled | observable disable disposition | none (F2) |

No observability failure is converted into a graph failure; the frozen S16
contract requires none. `DEGRADATION_MATRIX = PASS`.

## Phase K — Operator value (PASS)

K1 test derives a concise operational timeline from telemetry ALONE (run
started → phases dispatched/completed → provider usage figures → repairs →
final state → closeout state) with monotonic chronology — no authoritative
state read required. `OPERATIONAL_TIMELINE = PASS`.

## Phase L — Storage / GC integration (PASS, live)

Soak (canonical namespace, override-isolated repetitions):

- 400-event forced rotation (10 rotated chunks) → GC under
  terminal+window-elapsed → deleted 6, reclaimed 389,512 B; converged state =
  newest 4 rotated chunks + active stream + init marker. Second cycle
  idempotent (delete 0).
- ACTIVE / RESUME_REQUIRED / ROLLOVER_IN_PROGRESS lifecycles → 0 deletions
  (active telemetry protected).
- No duplicate persistence (rotation appends exactly one chunk), no orphan
  chunks (AMBIGUOUS = 0 after the init-marker classification), no repo/system
  root leak (no telemetry artifacts under the repo worktree; canonical
  namespace only), S16 canonical location used throughout.

`TELEMETRY_STORAGE_BOUND = PASS`; `STORAGE_LEAK = NO`.

## Phase M — Independent review (read-only, adversarial)

- **Single observer seam**: exactly one production telemetry construction site
  (`production-observer.mjs` → `TelemetryStore`); the runner observer hook is
  the same pre-existing post-result seam, now default-wired. No second GC
  path, no second emitter.
- **Authority separation**: disposition attach mutates only `result.telemetry`;
  no gate reads the store; authority→telemetry flows unchanged from S16 §C
  (`countLogicalReviewerAttempts`, usage journal rows).
- **Event taxonomy**: additive enum + allowlist; unknown stage/field fails
  closed; banned-field scan intact.
- **Identity/generation binding**: mandatory graphRunId; per-event
  generation/sessionId; deterministic ids.
- **Canonical location**: single resolver call site in the gate; GC containment
  admits only the canonical namespace.
- **Crash/replay**: idempotent init; torn-line fail-closed; duplicate replay
  harmless.
- **WP1 semantics**: probes re-run PASS end-to-end (F/G/H/J/L).
- **GC integration**: init marker classified protected; convergence re-proven.
- **Backend coupling**: the telemetry module imports ONLY telemetry-internal
  modules (location/store/contract) — no execution-backend imports; the
  runners forward the wiring, never the reverse.
- **Duplicate instrumentation**: none — one emitter consumed through existing
  hook seams; no runner mints its own store.
- **TODO/FIXME census**: 0 in `src/telemetry/*`.
- **Hidden telemetry-less supported path**: none (raw `durable:false` runner
  path is the documented TEST-ONLY escape hatch, regression-guarded; the
  coordinator `runtime:"direct"` FAST_PATH route remains OPTIONAL +
  fail-closed per the post-WP1 roadmap classification — it reaches the gate,
  so its disposition is attached; its bounded lifecycle timeline is emitted
  only for graph runners, consistent with its OPTIONAL classification).
- **Counterexample attempts**: (1) disable-then-observe — disable carries no
  wiring, zero writes; (2) degraded-init authority leak — disposition carries
  only observability keys; (3) successor-era ReferenceError (found by WP1-F
  F7 live: `telemetry` referenced but not destructured in
  `composeSuccessorSubagentGraphOpts`, which aborted the sub-agent hook
  mid-way and left the writer's admission-projected mutationScope unset) —
  REPAIRED in-iteration (destructure + default null) and WP1 F/G/H re-proven.

`INDEPENDENT_REVIEW = PASS` (one bounded in-iteration repair, re-verified).

## Phase N — Regression (canonical COLIMA_HOME; Colima suites SERIAL)

| Suite | Floor | Measured |
|---|---|---|
| telemetry | ≥86 | 105/105 (86 pre-existing + 19 new) |
| governance | ≥573 | 573/573 |
| admission | ≥188 | 188/188 |
| budget | ≥86 | 86/86 |
| retrieval | ≥24 | 92/92 (floor subset green) |
| writeback | ≥71 | 71/71 |
| colima-all | ≥80 | 80/80 (serial) |
| durable graph/resume | 19 | 19/19 |
| lifecycle | — | 172/172 |
| control-plane | — | 58/58 |
| rollover | — | 53/53 |
| memory-contract | — | 93/93 |
| WP1 F/G/H/J/L | PASS | PASS ×5 |
| rollover 3-era + e2e | PASS | PASS |

Environment note (pre-existing, unchanged): the shared `autoloop-graph`
Colima profile reconciles its mount generation per run; suites run serially
per the documented discipline. Two v2 tests that shell out to real colima
were green under the canonical `COLIMA_HOME` (baseline-verified: the same
tests fail identically WITHOUT the R-06 changes when the profile's pinned
mount generation is stale — environmental, not a regression).

## Phase O — Product truth updates (this record)

- Production telemetry is ENABLED BY DEFAULT for every `runAdmittedGraph`
  dispatch (colima / subagent / durable / explicit runner): one run-scoped
  store at the S16 canonical namespace, post-result COST-1 observation PLUS
  the mid-run lifecycle timeline.
- Event vocabulary: `autoloop.telemetry-event/v1` + `lifecycle.observed`
  (15 bounded stages; identity fields only).
- Canonical location: `/Volumes/NVM2T/Development/evidence/autoloop-telemetry/<graphRunId>/`
  (override `AUTOLOOP_TELEMETRY_STATE_ROOT`, exact store root).
- Explicit disable: `telemetry: false` at `runAdmittedGraph` — observable
  (`telemetryDisabled`), semantics-unchanged. Test contexts default off
  without the override (isolation refinement).
- Degradation semantics: Phase J table — observability failure NEVER changes
  execution semantics.
- Multi-session behavior: one run-scoped stream per graphRunId; eras
  distinguished by generation/sessionId; rollover + fan-out identities
  preserved (Phase H).
- GC/retention behavior: unchanged S16 R1/R2 classes; the init marker is a
  protected observability surface; convergence re-proven (Phase L).
- Operator timeline semantics: Phase K — telemetry alone reconstructs the
  operational timeline.
- Non-authority guarantee: Phase D — `TELEMETRY_AUTHORITY_LEAKS = 0`.

R-06 is reconciled as completed product work.

## Phase P — Landing

- Commit 1: production telemetry instrumentation + tests
  (`46d59d9` — src/telemetry/production-observer.mjs, contract/gc/index,
  gate + runner wiring, package.json suite entry, new test suite).
- Commit 2: this product/R-06 reconciliation record (isolated).
- Unrelated WIP preserved (3 modified + 85 untracked files untouched).
- Push: NO.

`R06 = FINAL_CLOSED`; `PRODUCTION_TELEMETRY = PRODUCTION_READY`.
