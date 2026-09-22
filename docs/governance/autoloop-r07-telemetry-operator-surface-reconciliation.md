# AUTOLOOP R-07 — TELEMETRY AGGREGATE OPERATOR SURFACE RECONCILIATION

Card: `AUTOLOOP_R07_TELEMETRY_AGGREGATE_OPERATOR_SURFACE_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1`
Date: 2026-09-23
Branch: `governance/rsl2-universal-execution-review-surface`
Authority contract: `docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md`
(S16 remains THE authority contract; this record reconciles the landed
R-07 operator surface against it — it does not restate or amend S16.)
Prior reconciliation: `docs/governance/autoloop-r06-production-graph-telemetry-implementation-reconciliation.md`
(R06 = FINAL_CLOSED; PRODUCTION_TELEMETRY = PRODUCTION_READY — unchanged).
Additive; rewrites no historical document.

---

## Phase A — Opening reconciliation (verified live)

| Item | Value |
|---|---|
| Canonical repo | `/Volumes/NVM2T/Development/repos/autoloop` |
| HEAD at open | `ce7420c` (R-06 documentation record) |
| Branch | `governance/rsl2-universal-execution-review-surface` |
| Remote published HEAD | `99b1ce9` (`git ls-remote` — branch 6 ahead, un-pushed, per S16/GC/R-06 landing) |
| R06 implementation commit | `46d59d9` — present, verified |
| R06 documentation commit | `ce7420c` — present, verified |
| S16_GC_STAGE | FINAL_CLOSED (confirmed) |
| GC_RETENTION | PRODUCTION_READY (confirmed) |
| R06 | FINAL_CLOSED (confirmed) |
| PRODUCTION_TELEMETRY | PRODUCTION_READY (confirmed) |
| Staged / stash | none / none |
| Dirty | 3 modified tracked evidence/attribution files + 115 untracked (`docs/pi-graph-output/` probe JSONs, `rrc/` forensics) — PRESERVED as unrelated WIP |
| Push | NO |

Operator session cwd was an unrelated checkout (`/tmp/auracore-wda-rerun-1`,
appium/WebDriverAgent — no AutoLoop content). The canonical AutoLoop repo was
located via the landed governance records and verified against the expected
published lineage. No mutation occurred in the unrelated checkout.

## Phase B — Aggregation inventory (complete; UNKNOWN = 0)

| Surface | Classification | Disposition |
|---|---|---|
| `src/telemetry/aggregate.mjs` (`aggregateGraphRun`, COST-1) | **CANONICAL_REUSABLE** | REUSED as the advisory aggregation layer (F5 test proves the report's aggregate IS the canonical output) |
| `src/telemetry/store.mjs` (`TelemetryStore.readAll`) | INTERNAL_ONLY (writer-owned; `open()` fail-closed on the ACTIVE stream) | not reused for reading: the operator reader must tolerate torn ROTATED chunks and absent stores, which `readAll` (open-gated, active-only validation) does not |
| `src/telemetry/graph-observer.mjs` | INTERNAL_ONLY (post-result producer) | unchanged |
| `src/telemetry/production-observer.mjs` (R-06 wiring) | CANONICAL_REUSABLE | reused verbatim for successor-era wiring continuity (Phase F repair) |
| `src/telemetry/location.mjs` (`resolveTelemetryStateRoot`) | CANONICAL_REUSABLE | THE only location authority for the reader |
| `src/telemetry/gc.mjs` (retention engine) | INTERNAL_ONLY (deletion authority, R0/R2 only) | not invoked by the operator surface; its containment vocabulary is mirrored conceptually, never imported |
| K1 timeline test seam (`test-telemetry-production-instrumentation.mjs` Phase K) | TEST_ONLY | superseded by the product surface (the K1 derivation logic is now `buildOperatorReport`) |
| coordinator lazy-loaded aggregation (`src/control-plane/coordinator.mjs`) | ADVISORY (pre-existing) | unchanged; still the only non-test aggregate consumer, advisory-only |
| reporting/debug/status CLIs (`scripts/gov-execution-review.mjs` etc.) | ADVISORY (different domain: review surfaces) | no overlap; no telemetry reporting CLI existed before this card |
| telemetry chunk readers (GC `classifyRotatedChunk` header validation) | INTERNAL_ONLY | header-validation semantics mirrored (same store schema constant), never imported to avoid coupling the reader to the deletion engine |
| retention/GC readers (`planTelemetryGc` enumeration) | INTERNAL_ONLY | not reused (GC plans deletion; the operator reads) |

No second aggregation engine was created. `DUPLICATE_ENGINES = 0`.

## Phase C — Operator contract (frozen by implementation)

`graphRunId → resolveTelemetryStateRoot (S16) → bounded read → aggregate
(COST-1, reused) → operator report`.

Report schema: `autoloop.telemetry-operator-report/v1`. Sections:
identity (graphRunId, cardId when observed, durable-id aliases, store
creation epoch), run status (observed start / latest observed stage /
observed final state / closeout observation), phase summary (started /
dispatched / completed / failed-held / skipped / repairs / distinct
attempts / last outcome per phase), usage (provider usage observations +
parsed totals, sub-agent activity, retrieval, writeback), multi-session
(rollover transitions, generations, successor sessions, dependency
consumption, resume observations, fan-out/fan-in), timing (observed
start/end, elapsed DERIVED, graph duration, per-phase durations),
diagnostics (degraded telemetry, torn/malformed lines, duplicates,
retention gaps, foreign/alias events, missing expected observations),
read bounds, event counts, and the canonical aggregate.

**Epistemic tags**: every report field is `{ value, evidence }` with
evidence ∈ `OBSERVED | DERIVED | UNKNOWN | NOT_APPLICABLE`. The report
NEVER synthesizes certainty from missing telemetry: no `run.final` ⇒
status `OBSERVED_ACTIVE_OR_INCOMPLETE` (never terminal), an empty store ⇒
`UNKNOWN`, an absent root ⇒ `ABSENT` + `NO_TELEMETRY_ROOT`.

## Phase D — Authority fence (frozen + tested)

`OPERATOR SURFACE = READ ONLY / ADVISORY`.

- The reader performs ZERO writes: mutation-path census test (D1) proves
  no `mkdir/write/append/rename/rm/unlink/truncate/chmod` call exists in
  `src/telemetry/operator-report.mjs` or the CLI. `OPERATOR_MUTATION_PATHS = 0`.
- It never retries, repairs, triggers rollover, changes budget, writes
  admission, modifies lifecycle, alters closeout, applies verdict, or
  promotes. It never mutates telemetry to make a report succeed.
- It reads TELEMETRY ONLY: no durable evidence store, checkpoint, budget
  ledger, or closeout state is consulted as report input (D2 test).
- `AGGREGATE_AUTHORITY_CONSUMERS = 0`: post-implementation call-site
  census — `buildOperatorReport`/`readRunTelemetry`/
  `renderOperatorReportText` are consumed only by
  `scripts/autoloop-operator.mjs` (the operator CLI) and
  `test/telemetry/test-telemetry-operator-report.mjs`. No production
  authority path reads the report. The pre-existing advisory coordinator
  seam (S16 §C) is unchanged.

## Phase E — Canonical reader (implemented)

`readRunTelemetry({ graphRunId, env })`:

- resolves storage ONLY through `resolveTelemetryStateRoot()` — the
  canonical namespace child or the validated `AUTOLOOP_TELEMETRY_STATE_ROOT`
  override (exact store root; absolute; `$HOME` rejected; flat identity
  enforced). No arbitrary root by default, no cwd fallback, no repo-local
  fallback (E1 test).
- bounded chunk reads: newest `OPERATOR_MAX_CHUNKS = 64` rotated chunks +
  the active stream, `OPERATOR_MAX_TOTAL_BYTES = 64 MiB`; over budget the
  read stops, availability degrades to `PARTIAL`/`READ_BOUNDS_EXCEEDED`
  (L4 test).
- retention-aware: rotated-chunk sequence gaps are explicit
  `RETENTION_GAP` diagnostics — the signature of legitimately GC'd R2
  history (K1/L5 tests); absence is never fabricated as failure.
- tolerates legitimately GC'd R1/R2 history: a run store with only rotated
  chunks (no active stream) still yields a safe report (K1).
- malformed telemetry surfaced explicitly: torn lines (`TORN_LINE_*`),
  contract-invalid events (`MALFORMED_EVENT`), unknown chunk headers
  (`CHUNK_HEADER_UNKNOWN`), unreadable init marker — never silently
  dropped (L1/L2 tests).
- no broad filesystem scan: the reader enumerates ONLY the run-scoped
  namespace; entries outside the store vocabulary are reported as
  `UNRECOGNIZED_ENTRY`, never traversed.
- symlink/path escape attempt: a symlinked chunk or run directory is
  never followed (`SYMLINK_ENTRY_SKIPPED`; fail-closed read boundary,
  L3 test — the linked file's content is provably untouched).
- duplicate events: byte-identical replay tolerated (S16 §J) and counted
  (`DUPLICATE_EVENTS`), never double-counted into state (F2 test).
- stale/foreign generation: generation binding is preserved and reported
  (`MULTI_GENERATION_TIMELINE` diagnostic); never interpreted as current
  authority (F4 test).
- wrong-graphRunId events INSIDE a run store are the durable-id alias
  pattern (the post-result observer binds `graph.run`/`node.run` to the
  durable execution id while the store directory is named by the caller's
  logical id): they are included in the run view and reported explicitly
  (`DURABLE_ID_ALIAS_EVENTS`). A truly foreign run's events cannot appear
  through the canonical reader (run-scoped roots prevent collision, S16 §J).

## Phase F — Aggregation (reconciled)

`aggregateGraphRun` (COST-1) is THE aggregation layer, invoked over the
full run-scoped store (aliases included) so the graph.run summary minted
under the durable id is consumed. Required properties verified:

- deterministic for the same retained bytes (F1: identical reportIdentity);
- generation-aware (generations reported; era binding observational);
- duplicate-event safe (F2);
- replay safe (deterministic eventIds; duplicates tolerated + counted);
- completion ordering is not authority (`completionOrderAuthoritative:
  false` is a frozen report field, J2);
- missing telemetry does not fabricate state (F3, H1);
- stale-generation events remain distinguishable (F4);
- malformed input cannot silently disappear (L1/L2).

No authoritative state machine is duplicated inside the aggregator.

**Bounded repair (successor-era telemetry continuity)**: R-06 declared
"generation distinguishes the eras", but the successor era ran through
`bootstrapSuccessorSession → resumeAsSuccessor` which never received the
canonical wiring (the admission gate resolves wiring only for era A) —
era B emitted nothing. `resumeAsSuccessor` now re-opens THE run-scoped
store through `buildProductionTelemetryWiring` (idempotent init) when the
caller passed no telemetry wiring, forwarding it so the successor era
appends to the SAME lifecycle stream with its durable owner generation/
session. Best-effort only (init failure degrades, never blocks resume);
callers passing their own wiring are untouched. This preserves
`SUPPORTED_TELEMETRYLESS_PRODUCTION_PATHS = 0`. Additionally the
`rollover.handover` emission now carries the observed successor
generation (`successorGen=` bounded detail + generation field) so the
operator surface exposes era transitions without reading durable truth.

## Phase G — Operator CLI / report surface (implemented)

`node scripts/autoloop-operator.mjs --run <graphRunId> [--json] [--root <dir>]`

- human-readable summary (default) + machine-readable JSON (`--json`);
- `--root` flows through THE existing validated S16 override semantics
  (the env var as consumed by `location.mjs`); a relative `--root` is
  refused (usage, exit 2) — a cwd-resolved fallback is exactly what the
  S16 fence forbids;
- safe against: active run (H1 + live Phase H), completed run (live
  Phase I), partially retained run (K1/L5), telemetry-disabled run (E2b/
  L6), unknown graphRunId (E2), malformed graphRunId (E1 — fail-closed
  refusal, safe UNKNOWN report);
- no server/dashboard (nothing in the architecture requires one).

## Phase H — Active-run view (PASS, live)

Live exercise against real production sub-agent graphs (canonical
COLIMA_HOME, real provider-backed execution):

- WP1-H fan-out leg H1 observed MID-RUN (`wp1-h-H1-mucvh86k`): status
  `OBSERVED_ACTIVE_OR_INCOMPLETE`, no premature final state
  (`observedFinalState = null`), latest observed stage = `phase.terminal`,
  SA-R2 in flight (`started=1 completed=0`), partial telemetry explicit.
  The report invocation did not interfere with execution (probe completed
  `PARALLEL_CONTINUITY = PASS` immediately after).
- WP1-H leg H2 observed mid-run the same way.
- Two consecutive reports during active writes: both safe, exit 0 (the
  append-vs-read race degrades to an explicit torn-line diagnostic by
  design, never a crash).

`ACTIVE_RUN_REPORT = PASS`.

## Phase I — Completed-run view (PASS, live)

- `wp1-h-H1-mucvh86k` (completed, ground truth `wp1-h-fanout-*.json`
  H1 leg PASS): report reconstructs status OBSERVED_TERMINAL / PASS,
  all five phases with outcomes, 5 provider-usage observations with
  parsed totals, dependency consumption SA-W1←{R1,R2,R3} and
  SA-V1←{W1}, elapsed 53.4s DERIVED, aggregate verdict PASS — all from
  telemetry alone.
- `wp1-j18-exec_78d9c87f55d93a3ec702a55e035549c4` (completed HOLD run,
  ground truth `wp1-j-adversarial-mucruh4y.json` verdict PASS with
  J18 `final=HOLD ORCHESTRATION_HOLD`, `w1=HOLD v1=SKIPPED`): report
  shows final state HOLD, SA-W1 failed/held, SA-V1 skipped,
  dependency consumption, aggregate verdict HOLD ORCHESTRATION_HOLD —
  matches the authoritative evidence exactly, without reading it.

`COMPLETED_RUN_REPORT = PASS`.

## Phase J — WP1 multi-session view (PASS, live)

- WP1-F continuity probe re-run live (`wp1-f-mucvefre`, VERDICT = PASS):
  the A-era report shows rollover.observed/triggered/request/handover
  with `successorGen=1`, generations [0,1], `MULTI_GENERATION_TIMELINE`
  diagnostic; the B-era (durable-id store `exec_160bff9…`) report shows
  successor generations [1] WITH real sessionIds (the Phase F repair
  working: era B now emits), dependency consumption at gen 1, final PASS.
- WP1-H fan-out/fan-in 10-leg probe re-run live
  (`wp1-h-fanout-mucvu5mt.json`, PARALLEL_CONTINUITY = PASS): the H10
  three-era chain report shows rollover transitions across eras,
  `successorGen=1` and `successorGen=2`, successor sessions
  `{generations:[1,2], sessionIds:[…]}` OBSERVED, dependency consumption
  W1@gen1 and V1@gen2 (fan-in across eras), final PASS — matching the
  probe's `FANIN_PASSED_ACROSS_ERAS w1=PASS@g1 v1=PASS@g2` ground truth.
  No completion-order assumption anywhere.

`MULTI_SESSION_REPORT = PASS`.

## Phase K — Retention / GC view (PASS, live)

- Fixture run with 10 rotated chunks + active stream: GC under
  terminal+window-elapsed deleted the 6 oldest rotated chunks
  (bounded keep window); report before (11 chunks, no gaps) → after
  (5 chunks, no gaps, status/final unchanged). Active/protected telemetry
  remained readable; R3/R4 authority untouched (the GC engine never
  leaves the telemetry namespace).
- GC-created history gap (chunks 2 and 4 removed): report surfaces
  `RETENTION_GAP [2, 4]` explicitly; status stays OBSERVED_TERMINAL
  from the surviving events — absence is never treated as failure
  unless observation proves it.
- No attempt to resurrect deleted telemetry anywhere in the surface.

`RETENTION_AWARE_REPORT = PASS`.

## Phase L — Negative matrix (PASS)

| Case | Result |
|---|---|
| unknown graphRunId | ABSENT + `NO_TELEMETRY_ROOT`, safe report (E2) |
| malformed graphRunId (`../evil`, empty, traversal) | fail-closed refusal from the S16 resolver → safe UNKNOWN report, exit 0 (E1/G2) |
| telemetry disabled (empty store) | safe report, `ACTIVE_CHUNK_ABSENT` explicit (E2b/L6) |
| no telemetry root (canonical absence) | ABSENT, safe report (E2) |
| empty telemetry | safe UNKNOWN report (E2b) |
| torn chunk | `TORN_LINE_*` explicit, valid events survive (L1) |
| malformed event | `MALFORMED_EVENT` explicit (L2) |
| duplicate event | tolerated + counted, never double-counted (F2) |
| stale generation | distinguishable, observational only (F4) |
| future/foreign generation | same generation-binding report path (F4) |
| wrong graphRunId event | durable-id alias reported explicitly (live j18/wp1-f reports) |
| missing middle chunk | `RETENTION_GAP [2,3]` (L5) |
| GC-created history gap | `RETENTION_GAP` (Phase K live) |
| active write during report | two consecutive live reports safe; torn-read degrades to a diagnostic by design |
| symlink/path escape attempt | symlinked chunk never followed; content provably untouched (L3) |

Never mutates or repairs source telemetry in any case.

`NEGATIVE_MATRIX = PASS`.

## Phase M — Operator value (PASS)

With only a graphRunId, the report answers (M1 test + live reports):
active vs terminal as observed ✓; what has happened (timeline + latest
stage) ✓; which phases ran ✓; retries/repairs observed ✓; rollover
occurred ✓; sessions/generations observed ✓; dependencies consumed ✓;
retrieval/writeback observed ✓; telemetry degradation/gaps ✓.

`OPERATOR_VALUE = PASS`.

## Phase N — Performance / bounds (PASS)

Heaviest retained real run (`wp1-h-H1-mucrh4k7`, 55,687 B): 1 chunk /
55,687 bytes read, 4.75 ms wall, negative heap delta. Bounds enforced by
construction (64 chunks / 64 MiB; L4 proves degradation, not failure).
Report generation is bounded by the S16 retained telemetry set; no
unbounded recursive history traversal; no unrelated graph runs are read
(the reader never leaves the graphRunId namespace).

`REPORT_BOUNDS = PASS`.

## Phase O — Independent review (PASS)

- read-only semantics: mutation-path census test D1 + static scan PASS.
- no authority consumer: call-site census `AGGREGATE_AUTHORITY_CONSUMERS = 0`.
- canonical location: only `resolveTelemetryStateRoot`; override refusal
  paths proven (E1, CLI usage exit 2).
- aggregate reuse: F5 proves report aggregate ≡ canonical aggregateGraphRun.
- no duplicate state machine: no lifecycle/rollover/closeout logic in the
  reader; statuses derive from OBSERVED events only.
- generation semantics: F4/J1; era binding observational only.
- missing-data honesty: E2/F3/H1 — UNKNOWN/NOT_APPLICABLE everywhere.
- retention awareness: K1/L5/Phase K live.
- active-run safety: Phase H live (no interference, no premature final).
- path containment: L3 symlink fence; reader never leaves the namespace.
- bounded reads: L4 + Phase N.
- operator usability: human renderer total over every report shape
  (including the refused-resolution shape); JSON contract fixed.
- TODO/FIXME census: 0 in `src/telemetry/operator-report.mjs`,
  `scripts/autoloop-operator.mjs`, and the touched production files.

`INDEPENDENT_REVIEW = PASS` (no architecture expansion; no HOLD).

## Phase P — Regression (canonical COLIMA_HOME; Colima suites SERIAL)

| Suite | Floor | Measured |
|---|---|---|
| telemetry | ≥105 | 129/129 (105 pre-existing + 24 new) |
| governance | ≥573 | 573/573 |
| admission | ≥188 | 188/188 |
| budget | ≥86 | 86/86 |
| retrieval | ≥24 | 24/24 |
| writeback | ≥71 | 71/71 (canonical COLIMA_HOME) |
| colima-all | ≥80 | 80/80 (serial, canonical COLIMA_HOME, exit 0) |
| durable graph/resume | 19 | 19/19 (canonical COLIMA_HOME) |
| durable subagent resume (de2r) | 1 | 1/1 (canonical COLIMA_HOME) |
| lifecycle | — | 172/172 |
| control-plane | — | 58/58 |
| rollover | — | 52/52 |
| memory-contract | — | 93/93 |
| review-bundle | — | 30/30 |
| writeback-graph | — | 8/8 |
| WP1 F (A→B continuity) | PASS | PASS (live, telemetry observed mid-run + post-run) |
| WP1 H (fan-out/fan-in, 10 legs incl. H10 three-era chain) | PASS | PASS (live) |
| syntax (`npm run check`) | — | PASS |

## Phase Q — Product documentation (this record)

Product truth updates:

- **Supported operator command**: `node scripts/autoloop-operator.mjs
  --run <graphRunId> [--json] [--root <dir>]` — THE read-only operator
  surface over the production telemetry backbone.
- **Output contract**: human summary (default) or
  `autoloop.telemetry-operator-report/v1` JSON (`--json`). Every field
  carries `{ value, evidence }` with evidence ∈ OBSERVED / DERIVED /
  UNKNOWN / NOT_APPLICABLE. `reportIdentity` = sha256 over the canonical
  report body (generatedAt excluded) — deterministic for the same
  retained telemetry bytes.
- **Field semantics**: run status derives ONLY from observed lifecycle
  events (`run.final` ⇒ OBSERVED_TERMINAL; absence ⇒
  OBSERVED_ACTIVE_OR_INCOMPLETE; empty/absent store ⇒ UNKNOWN). Phase
  summary counts distinct observed transitions (mid-run emitter and
  post-result observer describe the same transitions — never summed).
  Usage parses provider-reported counters from `provider.usage` details
  (never estimated). The durable-id alias pattern (logical store name +
  durable execution id inside one store) is reported explicitly.
- **Active-run semantics**: safe to run against an executing graph; the
  report shows only what has actually been observed; invocation never
  interferes with execution.
- **Retention-gap semantics**: missing rotated-chunk sequence numbers are
  explicit `RETENTION_GAP` diagnostics (legitimately GC'd R2 history);
  absence is never fabricated as failure.
- **Multi-session representation**: rollover transitions, generation
  progression, successor generations (from the enriched handover event),
  successor session ids (observed once the successor era emits — the
  Phase F continuity repair), dependency consumption per era, fan-out/
  fan-in with `completionOrderAuthoritative: false`.
- **Advisory/non-authoritative guarantee**: the surface performs zero
  writes, reads telemetry only, and no production authority consumes its
  output (`AGGREGATE_AUTHORITY_CONSUMERS = 0`,
  `OPERATOR_MUTATION_PATHS = 0`).

R-07 is reconciled as completed product work.

## Phase R — Local landing

- Commit 1 (`640b051`): operator aggregate surface + tests
  (src/telemetry/operator-report.mjs, scripts/autoloop-operator.mjs,
  test/telemetry/test-telemetry-operator-report.mjs,
  src/telemetry/index.mjs, src/rollover/production-wiring.mjs,
  src/v2/durable-graph.mjs, package.json).
- Commit 2: this product/documentation reconciliation record (isolated).
- Unrelated WIP preserved (3 modified + 115 untracked files untouched).
- Push: NO.

## Phase S — Final acceptance

| Gate | Result |
|---|---|
| CANONICAL_READER | PASS |
| CANONICAL_AGGREGATOR | PASS (aggregate.mjs reused; no second engine) |
| OPERATOR_SURFACE | PASS |
| AGGREGATE_AUTHORITY_CONSUMERS | 0 |
| OPERATOR_MUTATION_PATHS | 0 |
| ACTIVE_RUN_REPORT | PASS |
| COMPLETED_RUN_REPORT | PASS |
| MULTI_SESSION_REPORT | PASS |
| RETENTION_AWARE_REPORT | PASS |
| NEGATIVE_MATRIX | PASS |
| OPERATOR_VALUE | PASS |
| REPORT_BOUNDS | PASS |
| INDEPENDENT_REVIEW | PASS |
| REGRESSION | PASS (all floors green; Colima suites serial, canonical COLIMA_HOME) |
| LOCAL_LANDING | PASS |
| UNRELATED_MUTATION | NO |
| EXCLUDED_WIP_INTEGRITY | PASS (3 modified + 115 untracked preserved) |
| REMOTE_MUTATION | NO (no push) |

`R07 = FINAL_CLOSED`; `TELEMETRY_OPERATOR_SURFACE = PRODUCTION_READY`.

NEXT_CANONICAL_TASK: the telemetry backbone now has default-on
instrumentation (R-06), retention/GC (S16-GC), and an operator surface
(R-07). The next genuinely open product item is exposing the operator
surface through the canonical interactive entrypoint documentation path
(`AGENTS.md` product-truth section) and the remaining roadmap item:
provider-usage attribution granularity (per-phase token attribution from
the adapter-owned usage authority) — the first telemetry consumer that
can inform (never gate) budget optimization.
