# AUTOLOOP S16-GC — RETENTION AND GC IMPLEMENTATION RECONCILIATION

Card: `AUTOLOOP_GC_RETENTION_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1`
Date: 2026-09-22
Branch: `governance/rsl2-universal-execution-review-surface`
Authority contract: `docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md`
(S16 remains THE authority contract; this record reconciles the landed
implementation against it — it does not restate or amend S16.)
Additive; rewrites no historical document.

---

## Phase A — Opening reconciliation (verified live)

| Item | Value |
|---|---|
| Canonical repo | `/Volumes/NVM2T/Development/repos/autoloop` |
| HEAD at open | `5ba0372dea83045b9119ff0e13107ea59c4eca94` (S16 bounded wiring) |
| Branch | `governance/rsl2-universal-execution-review-surface` |
| Remote published HEAD | `99b1ce9` (`git ls-remote` — branch is 2 commits ahead, un-pushed, per S16 landing) |
| CONTRACT_COMMIT | `7aa531301d66c203404034bb7a84f8252070b2f0` — present, verified |
| IMPLEMENTATION_COMMIT | `5ba0372dea83045b9119ff0e13107ea59c4eca94` — present, verified |
| Dirty / staged / stash | 3 modified tracked + 85 untracked (pre-WP1 probe JSONs, `rrc/`) — PRESERVED as unrelated WIP |
| S16_CONTRACT_READY | YES |
| TELEMETRY_AUTHORITY_LEAKS | 0 (S16 §C audit stands; no new authority flow introduced) |
| DUPLICATE_TRUTH_SOURCES | 0 |
| WP1_RETENTION_SAFETY | PASS (S16 §H; re-proven live by Phase L below) |

Operator session cwd was an unrelated checkout (`/tmp/auracore-wda-rerun-1`,
appium/WebDriverAgent — no AutoLoop content). No mutation occurred there.

## Canonical R0–R4 assignments

Recovered verbatim from S16 Phase B/F and the code mirror
(`src/telemetry/location.mjs` `TELEMETRY_RETENTION_ASSIGNMENT`, 28 surfaces).
Canonical telemetry location:
`/Volumes/NVM2T/Development/evidence/autoloop-telemetry/<graphRunId>/`
(override `AUTOLOOP_TELEMETRY_STATE_ROOT` — exact store root). No
reinterpretation was performed.

---

## Phase B/C — GC contract and ownership model (implemented)

`src/telemetry/gc.mjs` implements the S16 §7 GC safety contract:

- **Retention classes**: R0–R4 enforced; `GC_PROTECTED` = R3/R4; every plan
  candidate carries an explicit class; R3/R4 can never appear as candidates
  (proven by B1/B2 tests + namespace separation fence from S16).
- **Ownership binding**: every candidate binds `graphRunId` (or executionId
  for prior snapshots / temp namespace owner), retention class, planned shape,
  and byte size. Unknown/ambiguous ⇒ `AMBIGUOUS ⇒ retain` (fail closed).
- **Containment fence**: `resolveGcNamespace` admits ONLY (1) the canonical
  run-scoped telemetry root, (2) the canonical namespace sweep, (3) an
  explicitly marker-admitted temporary namespace (`autoloop.gc-temp-admission/v1`,
  owner-lifecycle-gated). `$HOME`, the authoritative evidence root, and
  repo-adjacent arbitrary roots are rejected (`GC_ARBITRARY_ROOT_DELETE = 0`).
- **Symlink fence**: every candidate is walked component-by-component with
  `lstat`; any symlink component ⇒ skip/AMBIGUOUS (`GC_SYMLINK_ESCAPE = 0`).
  macOS `/var`→`/private/var` admission aliases are normalized on BOTH sides
  of the containment comparison (namespace realpath vs candidate realpath) so
  the fence cannot be bypassed by an alias NOR fire on a legitimate namespace.
- **Ownership order**: derive → validate → containment → ownership →
  eligibility → delete EXACT candidate. The executor re-validates containment,
  symlink state, retention class, protected-set membership, and planned entry
  shape (file vs dir) before each deletion; it never recomputes permissively.

Fence invariants proven by the adversarial suite (Phase J tests) and the
Phase M review probes: arbitrary root, traversal identity, forged retention
class, forged temp marker (wrong schema / wrong case), symlink escape
(including swap DURING the plan→execute window), foreign run, and
outside-namespace execute are ALL blocked.

## Phase D — Protected set (implemented)

`deriveProtectedSet` derives protection from AUTHORITATIVE lifecycle state
only (never telemetry observations):

| Source | Effect |
|---|---|
| `runTerminal: null` (unknown) | whole run protected (`LIFECYCLE_UNKNOWN`) |
| `runTerminal: false` | whole run protected (`RUN_ACTIVE`) |
| `resumableExecution` | whole run protected (`RESUME_REQUIRED`) |
| `rolloverInProgress` | whole run protected (`ROLLOVER_IN_PROGRESS`) |
| `successorDispatchPending` | whole run protected (`SUCCESSOR_DISPATCH_PENDING`) |
| `externalReviewUnresolved` | whole run protected (`EXTERNAL_REVIEW_SURFACE`) |
| `closeoutUnresolved` | whole run protected (`CLOSEOUT_UNRESOLVED`) |
| terminal + within recovery window (default 24 h) | whole run protected (`RECOVERY_WINDOW`) |
| terminal + window elapsed | rotated chunks become R2-bounded; the ACTIVE stream is retained (`ACTIVE_STREAM_RETAINED_POST_WINDOW`) |

Within-run checkpoint protection is derived from the durable checkpoint
itself: `CURRENT.json` (+ checksum + lock) are `CURRENT_REQUIRED`; while no
terminal verdict exists every `prior/` snapshot is `RESUME_REQUIRED`; after a
terminal verdict the newest `keep` (default 8) snapshots remain
(`BOUNDED_PRIOR_WINDOW`), older ones become eligible. A checkpoint is NEVER
deleted merely because a newer filename exists — eligibility follows the
durable lifecycle authority, and any snapshot whose identity/revision does
not re-validate against the exec dir is `AMBIGUOUS` (retained).

## Phase E — Rotated-chunk bounds (implemented, convergence proven)

- Active chunk protected; required recovery window protected; the newest
  `keep` (default 4) VALID rotated chunks retained as bounded historical
  observability; oldest beyond the window reclaimed deterministically.
- NO filename-order authority: a chunk's sequence counts ONLY after its
  store header re-validates (`autoloop.telemetry-store/v1`); malformed,
  unknown-schema, non-positive-sequence, or foreign-rank chunks are
  `AMBIGUOUS` (retained) and never shift the window (E3/E4).
- Deletion idempotent (double replay deletes nothing).
- Convergence proven live: 40 rotations → 61 chunks / 3.95 MB → GC → 4
  chunks / 292 KB; a second 20-rotation soak round converged again
  (4 chunks / 277 KB). Storage does not grow across repeated rotation+GC.

## Phase F — Within-run prior/checkpoint bounds (implemented, WP1-safe)

Classification vocabulary: `CURRENT_REQUIRED` / `RESUME_REQUIRED` /
`ROLLOVER_REQUIRED` (via rollover-in-progress lifecycle flag) /
`HISTORICAL_ONLY` / `GC_ELIGIBLE`. Live soak: 20 revisions published through
the SEALED `publishCheckpoint` seam with GC cycles interleaved every 5
revisions — zero eligibility while non-terminal (resume truth intact); after
a terminal verdict the prior/ set bounded 19 → 8 with CURRENT.json + checksum
intact and `readCheckpoint` returning the terminal verdict. WP1 A→B→C and
fan-out/fan-in re-proven end-to-end with the GC engine and leak repairs
landed (Phase L below).

## Phase G — Temporary leak clusters (closed)

| Cluster | Owner | Lifetime | Disposition |
|---|---|---|---|
| `transfer-metrics-core-1` (~87 MB, 4173 dirs) | learning test fixtures (`createTestRoot`/`createTestWriter`, `WORKER_PARENT` scripts) | test process | source FIXED: fixture roots are now tracked + exit-swept (`trackedCleanupAttestation` + process-exit sweep in `src/learning/transfer-metrics/fixtures.mjs`); historical orphans adjudicated R0-orphan and reclaimed via the GC engine (25/25 deleted, 0 ambiguous) |
| `.de2-matrix*` (~12 MB + 1072 empty macOS-tmp shells) | `scripts/de2-crash-matrix.mjs` probe scratch | probe run | orphans adjudicated + reclaimed; durable-graph suite temp dirs now tracked + exit-swept (`trackTmp` in `test/v2/test-durable-graph.mjs`) |
| wp1/pre-wp1 probe material (~10.7 MB + wp1-h 54 MB + ro3/r12/log leftovers) | WP1 probe scripts, rollover-3era probe, graph-closeout suite | probe/suite run | orphans adjudicated + reclaimed; `test-graph-closeout.mjs` R12 root now exit-swept; WP1 probe LOG dirs remain (single small dir per probe run — probe scripts own them; left to the probes' own lifecycle) |

Intentionally retained evidence was NOT touched: `rrc/` forensics (R4),
review surfaces (R3/R4), durable execDirs (R3), memory store (R3), the
`pytest-of-*` tree (206 MB — a DIFFERENT project's live working set, outside
AutoLoop retention authority), `adb.501.log` / Apple system dirs (non-AutoLoop).

## Phase H — Plan-first GC (implemented)

A GC cycle is a deterministic plan: `PROTECTED / ELIGIBLE / AMBIGUOUS /
MISSING / PLANNED_DELETE / EXPECTED_BYTES_RECLAIMED`. Execution consumes ONLY
the frozen plan: exact-path membership, live-existence (missing ⇒ recorded,
idempotent), namespace containment, symlink walk, retention class,
protected/ambiguous-set cross-check, and planned-vs-live entry shape are all
re-verified per candidate. Drift ⇒ `DRIFT:*` skip (fail closed); no
permissive recomputation during deletion.

## Phase I — Crash/replay semantics (proven)

I1 (crash before plan → later cycle converges), I2 (crash after plan → same
frozen plan replays safely, all-missing), I3/I8 (lifecycle advancement after
planning — a FRESH plan under an active/rollover lifecycle deletes nothing;
stale plans cannot turn unsafe because the executor only ever deletes exact
planned paths and the fresh-plan discipline is the caller contract),
I4 (rollover after planning honored), I5/I6 (duplicate/concurrent replay —
exactly-once deletion proven under `Promise.all` double execution),
I7 covered by I4. Missing already-deleted candidates handled safely;
ambiguous state retained.

## Phase J — Adversarial matrix (all blocked)

arbitrary external root / repo-adjacent root / traversal identity / symlink
escape (static + mid-execution swap) / foreign graphRunId / foreign execution
id / forged retention class / forged temp marker / malformed ownership
metadata / missing owner marker / missing CURRENT / evidence-root overlap /
execute-outside-namespace / protected-set tampering / duplicate replay —
every unsafe or ambiguous attempt blocked or retained; zero deletions outside
the frozen eligible set.

## Phase K — Storage soak (measured)

| Metric | Value |
|---|---|
| ORPHAN_START_BYTES (named leak clusters) | 172,277,760 |
| RECLAIMED_BYTES (GC-engine adjudicated reclaim) | 80,782,737 (25 clusters) + 2,143,925 (ro3 ×40) + 155,440 (de2 tmp ×1072) + 1,115,243 (gc/col test orphans ×976) + 2,269,599 (r12 ×9) + 2,941 (pre-wp1 log) + 9,791,048 (yosys m9-r5 leftover) ≈ 96,261,000 |
| TERMINAL_BYTES (AutoLoop-owned temp clusters) | 0 |
| Rotation soak | 3.95 MB → 292 KB → converges across repeated rounds |
| Checkpoint soak | priors 19 → 8 bounded; CURRENT intact |
| `pytest-of-*` 206 MB | NON-AutoLoop (other project) — out of scope, retained |

EXPECTED_RETAINED_GROWTH: durable evidence (~101 MB / 211 cards, R3,
card-cadence), review archives (~3.8 MB, R3/R4), memory store (244 KB, R3),
repo probe evidence (VCS) — all intentional, classed, bounded by their own
contracts. LEAK_GROWTH = 0: every measured unbounded source is now bounded
(rotation GC, prior GC) or exit-swept at source (test/probe temporary
material).

## Phase L — WP1 / authority non-regression (re-run live, post-GC)

| Probe / suite | Result |
|---|---|
| `multi-session-wp1-f-continuity.mjs` (A→B→C sequential) | VERDICT = PASS |
| `multi-session-wp1-g-multihop.mjs` | MULTI_HOP_CONTINUITY = PASS |
| `multi-session-wp1-h-fanout.mjs` (fan-out/fan-in, crash legs) | PARALLEL_CONTINUITY = PASS |
| `test/v2/test-durable-graph.mjs` (crash/resume, rollover N3–N9) | 19/19 |
| `test/governance` (closeout, review, drift gate, promotion) | 573/573 |
| `test/test-colima-graph.mjs` + `test-colima-runtime.mjs` | included in colima-all |

GC did not change any authority decision: the engine only ever deletes inside
the telemetry namespace / adjudicated temp namespaces / terminal-run prior
snapshots; telemetry deletion cannot reach execution truth (durable execDir,
checkpoints, ledgers, closeout state, review surfaces are outside every
admitted namespace).

## Phase M — Independent review (read-only, adversarial)

- Deletion-seam census: exactly TWO `rmSync` sites in the engine, both behind
  the full re-validation chain; no broad recursive deletion over
  caller-controlled roots; no hidden cleanup fallback; no TODO/FIXME.
- Duplicate-implementation check: `planTelemetryGc`/`executeGcPlan` exist
  only in `src/telemetry/gc.mjs`; no second GC path.
- Counterexample attempts (protected artifact deleted): recovery-window
  boundary, sweep under unknown lifecycle, resumable-CURRENT prior GC,
  symlinked run dir in sweep, marker case-forgery, symlink swap during the
  plan→execute window, concurrent double execution — ALL failed to delete a
  protected artifact. `COUNTEREXAMPLE_FOUND = NO`.
- Bounded defects found during review were repaired in-iteration (containment
  alias normalization, protected-set cross-check, entry-shape drift check)
  and the relevant tests re-run green.

## Phase N — Regression (canonical COLIMA_HOME; Colima suites SERIAL)

| Suite | Floor | Measured |
|---|---|---|
| governance | ≥573 | 573/573 |
| admission | ≥188 | 188/188 |
| budget | ≥86 | 86/86 |
| retrieval | ≥24 | 24/24 |
| writeback | ≥71 | 71/71 (canonical `COLIMA_HOME`) |
| telemetry | ≥44 | 86/86 (44 pre-existing + 42 new GC tests) |
| colima-all | ≥80 | 80/80 (serial) |
| scratch ownership | 6 | 6/6 |
| durable graph/resume | 19 | 19/19 |

Environment note (pre-existing, not introduced by this card): the shared
`autoloop-graph` Colima instance reconciles its mount generation per run;
CONCURRENT graph runs against the same profile can interleave stop/start and
fail closed with `COLIMA_RUNTIME_MOUNT_RECONCILE_INCOMPLETE`. Serial
execution (the documented discipline for Colima suites) is unaffected; all
colima suites above were run serially and pass.

## Phase O — Product truth updates

- GC lifecycle / R0–R4 enforcement / protected-set rules / storage bounds /
  crash-replay behavior / temporary cleanup: THIS record (the product
  reconciliation for the S16 contract).
- Operator interface: none added — GC is a library seam
  (`src/telemetry/gc.mjs`: `resolveGcNamespace` → `planTelemetryGc` →
  `executeGcPlan`, or the `runTelemetryGc` one-shot). No background GC
  daemon, no CLI. S16 explicitly deferred background GC; the engine is
  invocation-scoped.
- Explicit non-goals (unchanged from S16): no telemetry instrumentation of
  production graphs (R-06 open; future instrumentation MUST adopt
  `resolveTelemetryStateRoot`); no migration of historical data; no R3/R4
  retirement authority; colima `_lima` VM store is environmental (outside
  AutoLoop retention authority).
- Known retained growth: durable evidence per card (R3), review archives
  (R3/R4), memory store (R3), VCS probe evidence — EXPECTED, classed.

## Phase P — Landing

- Commit 1: GC/Retention implementation + tests (`src/telemetry/gc.mjs`,
  `test/telemetry/test-telemetry-gc.mjs`, `package.json` suite entry, leak
  repairs in `src/learning/transfer-metrics/fixtures.mjs`,
  `test/v2/test-durable-graph.mjs`, `test/governance/test-graph-closeout.mjs`).
- Commit 2: this product/contract reconciliation record (isolated).
- Unrelated WIP preserved (3 modified + 85 untracked files untouched).
- Push: NO.

`S16_GC_STAGE = FINAL_CLOSED`; `GC_RETENTION = PRODUCTION_READY`.
