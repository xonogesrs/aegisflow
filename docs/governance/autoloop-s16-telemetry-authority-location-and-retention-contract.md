# AUTOLOOP S16 — TELEMETRY AUTHORITY, LOCATION AND RETENTION CONTRACT

Card: `AUTOLOOP_S16_TELEMETRY_AUTHORITY_RESEARCH_AND_CONTRACT_LARGE_1`
Date: 2026-09-22
Branch: `governance/rsl2-universal-execution-review-surface`
HEAD at opening: `99b1ce909a6bfb7e1880392950b1841cb8a4ea32` (== remote published HEAD)
Method: RESEARCH_FIRST. This record freezes the telemetry authority/ownership/location/retention
contract and a bounded code-frozen subset (`src/telemetry/location.mjs`). Full GC/Retention
implementation remains BEHIND S16 (`AUTOLOOP_GC_RETENTION_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1`).
Additive; rewrites no historical document.

---

## Phase A — Opening reconciliation (verified live)

| Item | Value |
|---|---|
| Canonical repo | `/Volumes/NVM2T/Development/repos/autoloop` (remote `git@github.com:xonogesrs/autoloop.git`) |
| HEAD | `99b1ce909a6bfb7e1880392950b1841cb8a4ea32` |
| Branch | `governance/rsl2-universal-execution-review-surface` |
| Remote published HEAD | `99b1ce909a6bfb7e1880392950b1841cb8a4ea32` (exact match, `git ls-remote`) |
| Expected lineage | CONFIRMED (`99b1ce9` post-WP1 roadmap reconciliation; `b25bf89` Semantic Drift Gate landed; `ac8bfa5` WP1 rollover landed) |
| Governance Chapter | FINAL_CLOSED (per `docs/governance/autoloop-post-wp1-roadmap-reconciliation-and-semantic-drift-gate.md`) |
| WP1 | FINAL_CLOSED; WP2 rollover landed; Publication PASS |
| Staged / stash | none / none |
| Dirty | 3 modified tracked evidence/attribution files (`autoloop-auth1/review-job.json`, `checkpoint-20260809/risk-and-debt-register.md`, `rld2/rld2-reproduction.json`) + 85 untracked (pre-WP1 probe JSONs, `rrc/` forensics) — PRESERVED, unrelated WIP |
| Push | NO |

Note: the operator session cwd contained an unrelated checkout
(`/tmp/auracore-wda-rerun-1`, the appium/WebDriverAgent repo — no AutoLoop content). The
canonical AutoLoop repo was located via the landed governance records and verified against the
expected published lineage above. No mutation occurred in the unrelated checkout.

---

## Phase B — Telemetry inventory (complete; UNKNOWN = 0)

Every production telemetry/evidence/logging surface, with authority role and retention class.
`LOCATION` abbreviations: `TEL_ROOT` = canonical telemetry namespace (§5), `PERSIST` = caller
persistence root (evidence-root validated), `REVIEW` = `~/Desktop/AutoLoop-Review/`.

| # | SURFACE | PRODUCER | CONSUMER | LOCATION | PERSISTENCE | IDENTITY BINDING | GENERATION BINDING | AUTHORITY_ROLE | RETENTION | CURRENT_CLEANUP |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | telemetry event store (active + rotated JSONL) | `src/telemetry/graph-observer.mjs` (opt-in) → `src/telemetry/store.mjs` | `aggregate.mjs` (advisory), tests, probes | caller `stateRoot` (historically `$HOME/.autoloop-telemetry-*`; canonical from §5) | durable JSONL | `graphRunId` + deterministic `eventId` | `graphRunId` | OBSERVABILITY | R1 active / R2 rotated | none (rotation only) |
| 2 | memory write-back telemetry events | `src/memory/writeback/telemetry.mjs` | same store as #1 | same as #1 | durable JSONL | `graphRunId` + `eventId` | `graphRunId` | OBSERVABILITY (OBSERVABILITY_ONLY shim, M37) | R1/R2 | none |
| 3 | search-governor telemetry annotation | `src/admission/search-scope-governor.mjs buildSearchGovernorTelemetry` | carried in admission decision output; no gate reads it | embedded in admission record | rides authority record | admission decision | admission generation | OBSERVABILITY (derived FROM the decision, never an input) | R3 (rides #7-class record) | n/a |
| 4 | rollover telemetry token | `rollover-authority.mjs rolloverTelemetryToken` | none (payload annotation) | rollover mirror payload / journal | rides authority record | rollover state | rollover generation | OBSERVABILITY | R3 | n/a |
| 5 | durable evidence store (`journal/`, `artifacts/`, `phases/`, `manifest.json`, `final-report.json`) | `src/evidence/run-evidence-store.mjs` | resume, fold gate, closeout, reviewer bundle | `PERSIST/<executionId>/` | durable, hash-chained | `executionId` | `recoveryGeneration` | EXECUTION + EVIDENCE AUTHORITY | R3 | none (never GC'd) |
| 6 | checkpoint store (`CURRENT.json` + `.sha256` + `.lock` + `prior/`) | `src/c2d/checkpoint-store.mjs` via `src/v2/checkpoint-bridge.mjs` | resume, rollover reconciliation | `PERSIST/<executionId>/` | durable, CAS + external checksum | `executionId` + revision | `recoveryGeneration` | EXECUTION AUTHORITY | R3 | none |
| 7 | budget ledger (`artifacts/budget-ledger.json`) | `src/budget/ledger.mjs` via durable graph | resume (cumulative B3), pre-dispatch gate | `PERSIST/<executionId>/artifacts/` | durable | `executionId` | recovery generation | EXECUTION AUTHORITY (authoritative durable state — NOT telemetry, per cost-optimizer-contract §2.1) | R3 | none |
| 8 | closeout-state records (`closeout-state.json`) | `src/governance/closeout-state.mjs writeCloseoutState` | `runStateDrivenCloseout` (THE closeout trigger) | card `outDir` (repo `docs/pi-graph-output/<run>/` in production) | durable | card + `outDir` | generation | EXECUTION AUTHORITY (closeout trigger) | R3 | none |
| 9 | graph closeout evidence snapshots (`autoloop.review-bundle.graph-closeout-evidence/v1`) | `review-bundle.mjs writeGraphCloseoutEvidence` | closeout gate, R-12 validator | `docs/pi-graph-output/<run>/` | durable | `executionId` | generation | EVIDENCE AUTHORITY | R3 | none |
| 10 | external review inbox trio (`review-bundle.txt`, `delivery.json`, `evidence.json`) | `review-bundle.mjs deliverToExternalReviewSurface` | external reviewer; verdict = sole receipt | `REVIEW/Current/` | durable, atomic, occupancy fail-closed | bundle identity + content SHA | generation | EVIDENCE AUTHORITY | R3 | rotated to Archive after verdict |
| 11 | external review Archive | `review-bundle.mjs rotateExternalReviewSurface` | history / audit | `REVIEW/Archive/` (flat, 142 entries / 1.9 MB) | durable, immutable, digest-named | bundle identity | generation | EVIDENCE (promoted history) | R4 | none |
| 12 | execution review surface (`Latest/review.txt` + `Latest/archive/`) | `src/governance/execution-review.mjs` (RSL2 Domain A) | human entrypoint; barrier checks | `REVIEW/Latest/` (478 archived / 1.9 MB) | durable, byte-identical rotation | execution identity + SHA | execution attempt | EVIDENCE AUTHORITY (Latest) / R4 (archive) | R3 / R4 | rotation only |
| 13 | probe evidence JSONs (`docs/pi-graph-output/**`, incl. WP1 F/G/H/J/L outputs) | card probe scripts | governance records, review bundles | repo tree (git-tracked history) | durable (VCS) | card/probe label | card generation | EVIDENCE (probe history; internal evidence store per RB-1H) | R3 (retained by git) | none |
| 14 | memory store (`memory.db` + `journal.jsonl`) | `src/memory/local-store.mjs` (explicitImport only) | retrieval (admission-gated), write-back gate | `AUTOLOOP_MEMORY_STATE_ROOT` else `~/.autoloop/memory/` | durable sqlite+jsonl | record identity + content hash | record generation | AUTHORITY (memory records per CBM contract; journal is THE write path) | R3 | none |
| 15 | lifecycle event journal rows (N2 seam) | `src/learning/lifecycle/event-journal.mjs` | lifecycle state machine, replay | #14 `journal.jsonl` | durable, digest-chained | recordId + effect key | generation before→after | EXECUTION AUTHORITY (lifecycle truth) | R3 | none |
| 16 | transfer-metrics log (`transfer-events.jsonl` + `transfer-events-<seq>.jsonl`) | `src/learning/transfer-metrics/writer.mjs` (single writer) | projection / reducer (learning) | NVM2T-bounded root (`ALLOWED_ROOT_PREFIX`) | durable, rotated (8 MiB active) | event digest chain | generation | OBSERVABILITY (learning input, NON_AUTHORITATIVE replay cache) | R2 | none (rotation only) |
| 17 | owned scratch (`.autoloop-owned/<exec>/`: worktrees, clones, phase scratch, `results/`) | `src/runtime/scratch-ownership.mjs` + runners | executor/reviewer adapters; WP1 successor eras | caller scratch namespace | ephemeral + preserved subtree | `executionId` + repo binding | recovery generation | MIXED: `results/` CONTINUATION_REQUIRED; rest R0 | R0 (whole child reclaimable at real terminal) | `removeOwnedScratchRoot` / `wipeScratchPreserving` (marker-verified) |
| 18 | probe scratch leftovers in `$HOME` (`.wp1-f-probe` 1.0 MB, `.wp1-g-probe` 9.5 MB, `.pre-wp1-probe` 1.2 MB, `.de2-matrix*` ~12 MB) | probe scripts (crash/keep leftovers) | none (orphans) | `$HOME/...` | orphaned | none (ownerless) | none | TEMPORARY_LEAK | R0-orphan | none today (GC card) |
| 19 | legacy per-card telemetry dirs (`~/.autoloop-telemetry-{cost1,cbm4,de1}`, 44 KB total) | deleted R-04 self-closeout wrappers | none (VCA1 G20 evidence only) | `$HOME/...` | orphaned | `graphRunId` in contents | graph run | R2 orphan (location defect — VCA1 S16/G20) | R2 | none today (GC card) |
| 20 | colima runtime home (`_lima` VM store, 5.4 GB) | colima/lima itself | container runtime | `$COLIMA_HOME` (canonical NVM2T path) | durable VM disks | profile | n/a | ENVIRONMENTAL (runtime infrastructure, NOT AutoLoop telemetry; no AutoLoop retention authority) | n/a (out of scope) | colima lifecycle |
| 21 | `rrc/` forensics outputs (untracked, 144 KB) | RRC rung probes | postmortem records | repo `rrc/out/` | untracked files | probe label | n/a | FORENSIC | R4 | none (preserved WIP) |
| 22 | `PROVIDER_USAGE_OBSERVED` / `ROLLOVER_USAGE_OBSERVATION_FAILED` journal rows | `src/rollover/production-wiring.mjs` | rollover trigger producer (occupancy); NOT the dedup authority | #5 `journal/` | durable journal rows | `usageEventId` | checkpoint basis | OBSERVABILITY rows in the AUTHORITY journal — consequence re-derivable; window-dedup authority is the durable rollover block (`checkpoint-bridge.mjs POST_HEAD_EVENT_SEMANTICS`, replay-safe) | R3 (rides #5) | none |
| 23 | harness/system-delta/review artifacts (`implementation-evidence-N.json`, `reviewer-system-delta.json/.patch`, `reviewer-verdict-N.json`, `executor-output-N.json`) | `harness-evidence.mjs`, `system-delta.mjs`, `review-evidence.mjs` | reviewer bundle, verdict chain | `PERSIST/<executionId>/phases/` | durable | `phaseExecutionId` + attempt | graph generation | EVIDENCE AUTHORITY | R3 | none |
| 24 | scratch-ownership artifact (`artifacts/scratch-ownership.json`) | durable graph | resume wipe authority token | `PERSIST/<executionId>/artifacts/` | durable | `executionId` + repo binding | n/a | EXECUTION AUTHORITY (GC/wipe authorization) | R3 | none |
| 25 | telemetry overhead / perf evidence (`cost1-telemetry-overhead-*.json`, `de2` perf JSONs) | measurement probes | closeout bundles, governance | `docs/pi-graph-output/` | durable (VCS) | measurement date | n/a | EVIDENCE (measurement record) | R3 | none |

`TELEMETRY_CLASSES = 25`, `UNKNOWN_TELEMETRY_SURFACES = 0`.

---

## Phase C — Authority boundary (frozen)

**Central rule: TELEMETRY IS NOT EXECUTION AUTHORITY.** Restatement of the already-frozen
invariants this contract adopts (no new authority is created):

1. `src/telemetry/contract.mjs`: "telemetry is NEVER a task authority; recording failures
   surface as `TELEMETRY_UNAVAILABLE` / `TELEMETRY_STORE_INVALID` and cannot change any task
   semantic."
2. `docs/governance/control-plane-ownership-contract.md` §3/§5: telemetry stays in
   `src/telemetry/*`; the Control Plane never writes the store as a task-authority substitute.
3. `docs/governance/cost-optimizer-contract.md` §2.1: remaining budget is the budget ledger
   (authoritative durable state), NOT telemetry; telemetry is an *observed optimization input*.
4. AET-1 (`authority-execution-truth-invariants.md`): one authoritative source-of-record per
   authority domain; historical/observability copies are not executable authority.

Domain separation:

| Domain | Examples | May influence |
|---|---|---|
| execution/control state | CURRENT.json, journal state machine, budget ledger, closeout-state.json | admission, lifecycle, resume, budget, rollover, dependency consumption, closeout |
| authoritative evidence | execDir artifacts, harness/system-delta/review evidence, delivery.json + verdict, memory records, closeout evidence snapshots | review, verdict, promotion, write-back trust |
| telemetry/observability | surfaces #1–#4, #16, #22 | NOTHING (advisory reads only: optimizer seam, aggregates) |
| diagnostic logs | probe logs (tmpdir), `*.log` | nothing |
| historical/forensic | Archive surfaces, `rrc/`, prior/ snapshots, probe evidence history | nothing (audit only) |

Direction-of-authority check (verified by call-site audit):

- `budget/contract.mjs countLogicalReviewerAttempts` flows INTO `telemetry/graph-observer.mjs`
  (telemetry sources its reviewerCount from the budget authority) — authority → telemetry. The
  reverse never occurs.
- Surface #3 (`search-governor-telemetry`) is computed FROM a finalized decision and attached as
  an annotation; no gate reads `decision.telemetry` as input.
- Surface #22 rows are durable-journal events consumed by the rollover trigger producer, but
  their semantics are frozen as replay-safe observability whose window-dedup authority is the
  durable rollover block in the checkpoint — the journal row is evidence of an observation, not
  the authority for the trigger decision.
- No code path reads the telemetry store to make admission, lifecycle, resume, budget, rollover,
  dependency-consumption, closeout, external-review, verdict, or promotion decisions (verified:
  store consumers = tests, probes, advisory aggregate seam).

`TELEMETRY_AUTHORITY_LEAKS = 0`. `DUPLICATE_TRUTH_SOURCES = 0`.

---

## Phase D — Ownership model (frozen)

Ownership hierarchy: **workflow/run → execution → session/generation → phase/node → event/artifact.**

| Persistent class | Owner binding | Creates | May append | May finalize | May rotate | May delete |
|---|---|---|---|---|---|---|
| Telemetry store (#1/#2) | `graphRunId` (run) | observer wiring at graph start | `TelemetryStore.append` only (validated + secret-scanned) | run terminal (store close) | store-internal `#rotate` | GC contract (§7) only, after release |
| Durable execDir (#5/#6/#7/#23/#24) | `executionId` | `initExecutionDir` under validated root | C2D write seams only (journal intent/complete, CAS checkpoints, exclusive-create artifacts) | `manifest.json` finalize (idempotent, digest-bound) | `prior/` rotation (immutable per revision) | NEVER by telemetry retention |
| Closeout state (#8) | card + `outDir` | `writeCloseoutState` | state machine transitions | terminal disposition | superseded generations | never while card unresolved |
| Review surfaces (#10/#11/#12) | bundle identity | atomic delivery / publication | none (immutable once published) | verdict receipt | rotation into Archive | never (digest-bound history) |
| Memory store (#14/#15) | store identity (genesis digest) | `explicitImport` (journal-first) | N2 seam only | terminal lifecycle events | none | never by telemetry retention |
| Transfer metrics (#16) | root namespace (single writer lock) | writer append | writer only | n/a (streaming) | `#maybeRotate` | GC contract |
| Owned scratch (#17) | `.autoloop-owner.json` marker + authority token | `prepareOwnedScratchRoot` | execution-scoped runners | real terminal publication | n/a | `removeOwnedScratchRoot` / `wipeScratchPreserving` (marker + path + repo binding verified) |

No persistent telemetry is "owned by whoever finds the file": every class above has a single
creating seam and a single append path; identity binding is mandatory at creation.

Crash/resume ownership: a crashed run's telemetry store remains bound to its `graphRunId`; a
resumed era re-opens (or re-creates) the same run-scoped store. Durable execDir ownership is
re-verified from CURRENT.json before any resume mutation (existing §9a/§13a gate).

---

## Phase E — Location contract (frozen)

Current placement findings:

- The telemetry store has **no canonical production location** today: `stateRoot` is
  caller-supplied; the only production callers were the R-04-deleted self-closeout wrappers,
  which wrote `$HOME/.autoloop-telemetry-*` (VCA1 G20/S16 flagged this as a location defect:
  real cost evidence sat outside every bounded verification root). Production graphs currently
  run telemetry-less (R-06 debt: observer is opt-in).
- Authoritative evidence already has a canonical, mount-gated root
  (`scripts/shared/evidence-root.mjs`: `/Volumes/NVM2T/Development/evidence/autoloop`, exact
  volume + UUID, fail-closed, outside-repo enforced by `assertValidEvidenceRoot`).
- Probe scratch leaks in `$HOME` (#18) are placement defects (crash leftovers outside any owned
  root).

Frozen canonical locations (no data is moved by this card):

| Class | Canonical location |
|---|---|
| DURABLE_AUTHORITATIVE (R3) | `PERSIST/<executionId>/` under an `assertValidEvidenceRoot`-validated root; production default `~/.autoloop/durable/<durableExecutionId>` for the sub-agent entry (existing behavior, unchanged); card evidence under `docs/pi-graph-output/<run>/`; closeout surfaces under `REVIEW/` |
| DURABLE_OBSERVABILITY (R1/R2 telemetry, transfer metrics) | **`/Volumes/NVM2T/Development/evidence/autoloop-telemetry/<graphRunId>/`** — a SIBLING namespace of the authoritative evidence root. Everything under `autoloop-telemetry/` is R1/R2 (GC-eligible by class); everything under `autoloop/` is R3/R4 (GC-protected by default). Override: `AUTOLOOP_TELEMETRY_STATE_ROOT` (exact store root; tests/CI isolation — mirrors `AUTOLOOP_MEMORY_STATE_ROOT`). Code-frozen in `src/telemetry/location.mjs`. |
| EPHEMERAL_RUNTIME (R0) | owned scratch children (marker-verified) and OS tmpdirs only; never `$HOME` top-level dotdirs for new producers |
| ARCHIVE / FORENSIC (R4) | `REVIEW/Archive/`, `REVIEW/Latest/archive/`, `rrc/`-class promoted outputs |
| TEST_TMP | isolated tmpdirs (`mkdtemp`) — tests never touch canonical roots |

Placement defect register (recorded, NOT repaired here): #18 `$HOME` probe leftovers, #19 legacy
telemetry dirs. Cleanup belongs to the GC/Retention implementation card, using the §7 contract.

Repo pollution: `docs/pi-graph-output/` is the RB-1H internal evidence store — intentional,
git-tracked, retention via VCS history; not pollution. No telemetry JSONL ever belongs in a repo
worktree.

---

## Phase F — Retention contract (frozen)

| Class | Meaning | Deletion basis |
|---|---|---|
| R0 | ephemeral — scratch, worktrees, tmpdirs, probe logs | operation/process end; ownership-marker-verified reclaim |
| R1 | run/session diagnostic — active telemetry stream | terminal lifecycle of the run, then bounded recovery window |
| R2 | completed-run observability — rotated telemetry chunks, transfer-metrics archives, orphan legacy dirs | bounded count / bounded age per run; never while any consumer holds the runId |
| R3 | authoritative evidence — execDir, checkpoints, ledger, closeout state/evidence, review receipts, memory, probe evidence | owned by the evidence/closeout contracts; NEVER GC'd because telemetry retention expires |
| R4 | explicit forensic/history — Archive surfaces, `rrc/`, promoted incident profiles | intentional promotion only; retained until an explicit retirement authority exists |

Per-surface assignment is column `RETENTION` of the Phase B table (exactly one class per
surface). Retention is expressed in lifecycle terms (terminal state, generations, ownership
release), not wall-clock age: R0 = process/operation end; R1 = run terminal + recovery window;
R2 = bounded count of rotated chunks per `graphRunId`; R3 = never (evidence contract owns it);
R4 = explicit promotion, explicit retirement.

Storage bounds already enforced by code (unchanged): telemetry active file ≤ 10k events /
8 MiB with rotation; transfer-metrics active log ≤ 8 MiB with rotation; memory journal
digest-chained append.

---

## Phase G — GC safety contract (frozen; implementation BEHIND S16)

**GC must never delete data required for:** active execution, resume, rollover, dependency
consumption, authoritative closeout, external review, verdict, promotion, or currently retained
forensic evidence.

- `GC_ELIGIBLE`: R0 after ownership-marker-verified release (existing
  `removeOwnedScratchRoot` semantics); R1 after run terminal + recovery window; R2 rotated
  chunks beyond the bounded per-run count; R2 orphan dirs only after an explicit
  orphan-adjudication record names them.
- `GC_PROTECTED`: everything under an `assertValidEvidenceRoot`-validated durable root
  (`PERSIST/<executionId>/` wholesale), `REVIEW/Current/`, unresolved closeout-state records,
  the memory store, WP1 preserved `results/` subtrees (§8), any surface marked R3/R4.
- `GC_AMBIGUOUS`: any directory without a recognizable ownership marker, retention class, or
  identity binding — including the #18/#19 `$HOME` orphans until individually adjudicated.
  `GC_AMBIGUOUS ⇒ retain` (fail closed).
- Deletion MUST be ownership-aware: only through marker-verified, path-bound, repo-bound seams
  (the `scratch-ownership` model). **No broad recursive deletion over caller-controlled roots.**
- The release authority for run-scoped data is the existing lifecycle rule: a real terminal
  publication releases the owned scratch child; a handover HOLD keeps it (WP1 §8). GC adopts
  the same condition — it never invents a second release authority.

---

## Phase H — WP1 multi-session retention (verified against landed code)

Across Session A → B → C and fan-out/fan-in:

| Class | Items |
|---|---|
| CONTINUATION_REQUIRED | owned-scratch `results/` (authored-result envelopes `autoloop.subagent.authored-result/v1` — preserved via `scratchPreserve`/`wipeScratchPreserving`); durable execDir (journal + CURRENT.json + `phase_result_hashes` dependency bindings + `scratch-ownership.json` authority token); rollover mirror block; `budget-ledger.json` cumulative state |
| HISTORICAL_ONLY | superseded closeout bundles (`.superseded/`), `prior/` checkpoint snapshots, rotated telemetry chunks, archived review surfaces |
| TEMPORARY | worktrees, clones, phase scratch, probe logs |
| SAFE_TO_GC_AFTER_TERMINAL | owned scratch child (non-preserved parts) after real terminal publication with no successor era; telemetry active stream (R1→R2); container instances |

Verification that GC cannot remove continuation truth before its lifecycle authority releases
it: surviving authored results, provenance envelopes, rollover lineage, dependency bindings and
crash/resume journal state all live in `GC_PROTECTED` locations (durable execDir + preserved
scratch subtree); the scratch release condition is exactly the runner's real-terminal rule
(`durable-graph.mjs`: handover HOLD returns BEFORE the reclaim line). The WP1 F/G/H/I/J/L probes
already prove the preservation semantics; no telemetry GC path exists that could reach them.

---

## Phase I — Storage / growth study (measured on real on-disk state, 2026-09-22)

| Contributor | Measured | Per-run/unit | Class |
|---|---|---|---|
| Telemetry events | 1224 B/event, 538 KB / 440 events (cost1 measured evidence); active capped 8 MiB | ~KB–MB/run | EXPECTED (bounded active) |
| Telemetry rotated chunks | count unbounded per `stateRoot` | small rate | UNBOUNDED (count) — retention owner §5/§7 |
| Durable journal | ~92 KB / 23 events incl. intents (~4 KB/event) | linear in phases | EXPECTED |
| Checkpoints | CURRENT ~KB + `prior/` one immutable snapshot per revision (10 snapshots = 40 KB observed) | linear in revisions | EXPECTED within run; `prior/` count unbounded within very long runs — noted for GC card |
| Evidence root | 101 MB / 211 card dirs over ~7 weeks (~15 MB/week; top dir 25 MB) | per card | EXPECTED (R3, card-cadence bound) |
| Repo probe evidence | 4.8 MB, 239 tracked files | per card | EXPECTED (VCS-retained) |
| Transfer-metrics tmp | **87 MB** `/Volumes/NVM2T/Development/tmp/transfer-metrics-core-1` (probe leftovers) | — | TEMPORARY_LEAK (largest single contributor) |
| `$HOME` probe leftovers | ~12 MB `.de2-matrix*` + 10.7 MB wp1/pre-wp1 probes | — | TEMPORARY_LEAK |
| Review surfaces | Archive 1.9 MB/142, Latest/archive 1.9 MB/478 | per card | EXPECTED (slow) |
| Memory store | 244 KB | — | EXPECTED |
| Colima `_lima` | 5.4 GB VM store | — | ENVIRONMENTAL (runtime infra; outside AutoLoop retention authority) |

`UNBOUNDED_GROWTH_SOURCES = 2` with material leak risk (telemetry rotated-chunk count;
`prior/` within-run count) plus three `TEMPORARY_LEAK` clusters (~110 MB total). No optimization
is performed in this card; the GC card owns cleanup using §7.

---

## Phase J — Failure / crash semantics (frozen)

| Case | Semantics |
|---|---|
| crash before telemetry write | event lost; observability gap only; execution unaffected (observer is post-result, opt-in) |
| crash during append (torn line) | next `open()` fails closed `TELEMETRY_STORE_INVALID` (store-level); callers degrade to `TELEMETRY_UNAVAILABLE`; the graph never fails on it |
| crash after telemetry write, before checkpoint | telemetry is post-result observability; the checkpoint seam is unaffected; replay-safe |
| duplicate replay | deterministic `eventId` (sha256 of graphRunId/eventType/node/attempt/sequence) makes duplicates detectable; duplicates in the store are tolerated as observability and never consumed as authority |
| partial/corrupt telemetry | store-level fail-closed (`TELEMETRY_STORE_INVALID`); never task-level |
| missing telemetry | `TELEMETRY_UNAVAILABLE`; R-06 disposition stands: un-instrumented facts are marked unknown, never fabricated |
| stale generation telemetry | `eventId`/`graphRunId` binding marks it historical-only; never consumed cross-generation |
| foreign-execution telemetry | run-scoped state roots (§5) prevent collision; a foreign store is simply not the current run's store |

**Observability loss must not stop execution; authority/evidence loss fails closed.** The
existing seams already enforce the split: telemetry failures degrade (`TELEMETRY_UNAVAILABLE`),
while evidence/checkpoint/ledger failures HOLD (`PERSISTENCE_*`, `CHECKPOINT_CORRUPT`,
`BUDGET_AUTHORITY_INVALID`, journal↔checkpoint alignment gates).

---

## Phase K — Contract freeze

1. **Taxonomy**: Phase B table (25 surfaces, 0 unknown).
2. **Authority boundary**: Phase C — telemetry is never execution authority; 0 leaks, 0
   duplicate truth sources.
3. **Ownership**: Phase D — every persistent class has a single creator, append path,
   finalizer, rotator; deletion only via §7.
4. **Locations**: Phase E — canonical telemetry namespace
   `/Volumes/NVM2T/Development/evidence/autoloop-telemetry/<graphRunId>/` (env override
   `AUTOLOOP_TELEMETRY_STATE_ROOT`), sibling-separated from the authoritative evidence root;
   code-frozen in `src/telemetry/location.mjs`.
5. **Retention classes**: Phase F — R0–R4 with per-surface assignment.
6. **GC eligibility/protection**: Phase G — fail-closed, ownership-aware, no broad recursive
   deletion; implementation deferred.
7. **WP1 multi-session semantics**: Phase H — continuation set is GC-protected until the
   lifecycle authority releases it.
8. **Crash/replay semantics**: Phase J — observability loss degrades; authority loss fails
   closed.
9. **Storage bounds**: Phase I — measured; 2 unbounded-count sources + 3 leak clusters named
   for the GC card.
10. **Migration/backward compatibility**: additive only. No data is moved or deleted by this
    card. Existing `$HOME` orphans are classified (R0/R2 orphans), not touched. R-06
    (telemetry opt-in) remains open and its future instrumentation MUST adopt
    `resolveTelemetryStateRoot`. Existing `TelemetryStore` callers (tests, probes) are
    unaffected; the resolver is opt-in until instrumentation lands.

`S16_CONTRACT_READY = YES`.

---

## Phases L/M — Implementation decision and bounded implementation

`IMPLEMENTATION_CLASS = BOUNDED_WIRING`.

Bounded implementation landed (commit 2):

- `src/telemetry/location.mjs` — the S16 code-frozen subset: canonical location constants,
  retention-class constants, per-surface retention assignment (data mirror of Phase B/F), and
  the fail-closed `resolveTelemetryStateRoot` resolver (run-scoped; `$HOME` rejected; env
  override; never a task authority — resolution failure is an ordinary error the caller
  surfaces as `TELEMETRY_UNAVAILABLE`).
- `test/telemetry/test-telemetry-location.mjs` — contract tests for the resolver and the
  retention-assignment invariants (namespace separation: no R3/R4 surface lives under the
  telemetry namespace).
- `package.json` `test:telemetry` includes the new suite.

Explicitly NOT in this card: retention engine, background GC, artifact migration, logging
redesign, telemetry instrumentation of production graphs (R-06 stays open).

---

## Phase N — Independent review (self-check)

- No telemetry-as-authority leak: verified by call-site audit (§C); the only authority→telemetry
  flow is `countLogicalReviewerAttempts`.
- No duplicate truth source: telemetry aggregates are advisory; budget remaining is ledger;
  usage observation authority is the rollover block.
- Ownership complete: every Phase B surface has an owner row (§D).
- Location complete: every class has a canonical location (§E).
- Every persistent class has exactly one retention class (§B/§F).
- GC protected set covers all WP1 continuation truth (§H).
- Crash semantics explicit for all eight cases (§J).
- No speculative complexity: one additive module + one test + one suite-list edit; no GC engine,
  no migration, no new abstractions.

## Phase O — Regression

Contract + bounded additive module: `npm run check` (syntax), `npm run test:telemetry`
(37 pre-existing + new location tests), targeted only. No Colima suite claimed (telemetry-only
card; `colima-scope-gate` classifies this as a non-runtime card — V17 substitute satisfied by
the telemetry suite). Floors untouched: governance 573/573, admission 188/188, budget 86/86,
retrieval 24/24, writeback 71/71, colima-all 80/80 (not re-run; no runtime seam touched).

## Phase P — Landing

- Commit 1: this contract/research record.
- Commit 2: bounded S16 implementation (`location.mjs` + test + suite entry).
- Unrelated WIP preserved (3 modified + 85 untracked files untouched).
- Push: NO.
