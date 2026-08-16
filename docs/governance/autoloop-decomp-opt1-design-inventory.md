# AUTOLOOP-DECOMP-OPT1 — As-Is Inventory, Problem Model & Solution-Space Freeze

Card: xonogesrs/autoloop Issue #6 (analysis/design only — no production code mutated).
Parent: Issue #5 AUTOLOOP-DECOMP-OPT1 — Hierarchical Decomposition & Workflow Reuse.
Baseline: `governance/auth1-production-retrieval-authority` @ `e1ecb45fb69778a4d85f0b968ed6847008d029ce` (PR #4 lineage).

## 0. Baseline authority sync (verified at execution time)

| Source | HEAD of `governance/auth1-production-retrieval-authority` | State |
|---|---|---|
| GitHub (API) | `e1ecb45fb69778a4d85f0b968ed6847008d029ce` | matches issue-stated baseline |
| Local clone (this work) | `e1ecb45fb69778a4d85f0b968ed6847008d029ce` | in sync with GitHub |

- PR #4 (AUTH1) is OPEN; `main` is 2 commits behind the AUTH1 branch (a06124c, e1ecb45 are not on main). The AUTH1 branch is the authoritative design/inventory baseline; no baseline change to record.
- All inventory below is traced mechanically from source at this commit; where runtime behavior was verified by execution, the probe and its output are cited (Section E).

## 1. As-Is execution graph

Production entry: `runAdmittedGraph` (`src/admission/admission-gate.mjs`) → `graph=durable` → `runDurableGraph` (`src/v2/durable-graph.mjs`) → `runColimaGraph` (`src/runtime/colima-graph-runner.mjs`) → `runExecutionOrchestrator` (`src/v2/execution-orchestrator.mjs`) → `runDecompositionGraph` (`src/v2/runner.mjs`, sealed scheduler) + `runLifecycle` (`src/lifecycle-runner.mjs`).
STACK_A harness (non-production): `runAutoLoopInternal` (`src/autoloop.mjs`) → `runProductionPipeline` + same orchestrator; durable variant `runDurableAutoLoopInternal` (`src/v2/durable-execution.mjs`).

Legend: M = model/adapter call, G = git subprocess spawn, FS = filesystem write, CPU = deterministic in-process.

| # | Step | Owner / authority | Inputs | Outputs / artifacts | Durable vs ephemeral | M/G/FS | Repo reads | Repo mutations | Verification work | Evidence generation | Reviewer work | Restart / resume | Invalidation implemented |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S0 | Admission gate | `admission-gate.mjs` assertProductionAdmission | frozen admission, per-task allocation | budget enforcement | ephemeral | CPU | none | none | admission re-derive + freeze check | none | none | n/a | fail-closed on any admission drift (existing) |
| S1 | Repository fingerprint | `checkpoint-bridge.mjs` collectRepositoryFingerprint → `c2d/fingerprint.mjs` | repo root | fingerprint: root identity, git-common-dir, worktree, HEAD, ref, origin url/head, dirty digest | durable (frozen in checkpoint) | G×6 | rev-parse HEAD, --git-common-dir, branch, remote get-url origin, rev-parse origin/master, status --porcelain | none | dirty-state check | none | none | re-run on resume; mismatch → RESUME_FINGERPRINT_MISMATCH | yes: field-wise compare (existing, run-level only) |
| S2 | Input freeze | `durable-execution.mjs` | source, parent, manifest | input.json artifact + input fingerprint | durable | FS×2 | none | none | none | none | none | recomputed on resume | yes (fingerprint) |
| S3 | Config freeze | `durable-execution.mjs` buildConfigurationFingerprint | repair budget, timeout, tool policy, env allowlist, reviewer model, runtime, 27 source-file hashes, adapter hashes | configuration fingerprint | durable (in checkpoint) | FS×27 reads | none | none | none | none | none | recomputed on resume | yes (fingerprint) |
| S4 | Decomposition | `production-pipeline.mjs` (schema → structural H1/H2/H3/H5/H7/H8/H12 → semantic H4/H6/H9/H10 + frontier → scorecard v2, NO case oracle) | prompt bundle (source goal, requirements, authority) | IR, shape/structural/semantic/scorecard snapshots; artifacts decomposition-response.json / decomposition-ir.json / decomposition-validation.json; irSha + dagSha | durable | **M×1** (decompositionAdapter.generate), CPU gates | none | none | structural+semantic gates | IR + validation snapshots | none | pre-decomposition interruption → RESTART_REQUIRED (new execution) | fail-closed HOLD per stage (existing) |
| S5 | Memory retrieval (AUTH1 R-10) | `colima-graph-runner.mjs`, gated by `admission.memory_policy.retrieval_allowed` | repoPath, cwd, executionId, taskIdentity | memoryContext (state, selectedRecords, digests) | ephemeral (store-backed) | **M×1 per graph** (retrieveGraphMemory) | store reads | none | store validity (corrupt → HOLD) | none | none | re-retrieved on resume (fresh graph) | store snapshot digest binding (existing) |
| S6 | Scheduler | sealed `runner.mjs runDecompositionGraph` | IR phases, depends_on | order, statuses, runLog, lease transitions, skipped set | ephemeral (mirrored to durable by hook) | CPU | none | none | writer-lease arbitration, dependency readiness | none | none | initialState seed from checkpoint; running state must be pre-resolved | transitive-dependents skip on HOLD (existing) |
| S7 | Phase task card | `phase-task-card.mjs buildPhaseTaskCard` | phase, parent scope, executionId | task card: identity (sha256(run:phase)), boundaries, scope patterns, 2 prompts, 2 final-response contracts | ephemeral (+embedded in artifacts via evidence) | CPU | none | none | boundary canonicalization, parent-scope containment, forbidden-path exclusion | none | none | rebuilt per child on resume | fail-closed card errors (existing) |
| S8 | Scope baseline snapshot | `execution-orchestrator.mjs` (or colima `scopeBaselineForPhase`) | cwd (or writer worktree) | baselineSnapshot (paths + content fingerprints) | ephemeral (bound into mutation scope) | G×5 per child (+G×1 hash-object + G×1 ls-files --error-unmatch per changed path in computeDelta) | git diff, diff --cached, ls-files --others/--deleted, staged deletions | none | none | none | none | re-taken on resume | none (per-child by design) |
| S9 | Executor call | lifecycle `callAdapter("executor")`; adapter fresh per child (session reuse = 0) | task card, phase prompt, timeout, tool policy | normalized adapter result | ephemeral (diagnostic persisted) | **M×1 per child** (model/container/subagent) | model-dependent (bounded by prompt/tool policy) | model-dependent (gated post-hoc) | none (harness-owned) | none (diagnostic only; non-authoritative) | none | re-run on resume (child not terminal) | none (fresh per child by design) |
| S10 | Executor output diagnostic | `harness-evidence.mjs buildExecutorOutputDiagnostic` | adapter stdout/stderr, protocol counts | executor-output-N.json | durable | FS×1 | none | none | none | bounded diagnostic | none | replay-safe post-head | none |
| S11 | Mutation scope gate | `lifecycle-runner.mjs checkMutationScope` → `c2d/mutation-scope.mjs` | baseline + current snapshot, allowed/forbidden patterns | delta (path+change), violations | ephemeral (delta feeds evidence) | G×5 per child (+per-path hash-object/ls-files in computeDelta) | git diff, diff --cached, ls-files --others/--deleted, staged deletions | none | scope enforcement (fail-closed on violation) | delta inventory | none | re-run on resume | yes: violation → HOLD (existing, per-child) |
| S12 | System-observed delta | `system-delta.mjs buildSystemObservedDelta` | scopeCheck delta, task card identity | patch text, per-path before/after SHA-256, identity record | durable (reviewer-system-delta.json + .patch) | G×7+ per child (re-observation G×5 + per-path hash-object/ls-files, rev-parse HEAD + tree G×2, cat-file/git show/git diff per changed path) | fresh re-observation of changed paths + HEAD blobs | none | 9 fail-closed gates (identity, baseline, scope binding re-observation, path count, SHA, oversize, decodable, secret) | patch + metadata | delivered to reviewer via bundle | SYSTEM_DELTA_READY is post-head resume-safe | yes: any gate mismatch → HOLD (existing, per-child) |
| S13 | Harness implementation evidence | `harness-evidence.mjs buildHarnessOwnedEvidence` | task card, scopeCheck, baseline, testRun, executor result | implementation-evidence-N.json (schema `autoloop.implementation-evidence/v1`) | durable | G×9 per child (collectGitBaseline: rev-parse HEAD, HEAD^{tree}, branch, @{upstream}, rev-list ×2, remote -v, show-toplevel) + G×1 verification command | repo identity re-read | none | identity gate, facts presence, writer-test-evidence gate, schema, size bound, secret scan | full evidence object | consumed by reviewer bundle | EXECUTOR_COMPLETED post-head resume-safe | yes: any gate → HOLD (existing, per-child) |
| S14 | Review evidence bundle | `review-evidence.mjs buildReviewEvidenceBundle` | harness evidence, observed changed paths, system delta, task card | review bundle (`autoloop.review-evidence/v1`) incl. objective_facts + durable_references | ephemeral (referenced durable artifacts) | G×2 per child (gitHeadTree: rev-parse HEAD, HEAD^{tree}) | repo identity re-read | none | identity correspondence, delta patch SHA re-verify, test coherence, size, secret | bundle | reviewer input | rebuilt on resume | yes: gate → HOLD (existing, per-child) |
| S15 | Reviewer call | lifecycle `callAdapter("reviewer")`; fresh adapter; tool policy hard-pinned `no-tools` | review bundle, task card | reviewer verdict (normalized) | ephemeral (verdict artifact persisted) | **M×1 per child** | none (no tools) | none | verdict shape + PASS-suppression rules | reviewer-verdict-N.json | independent judgment per child | REVIEWER_COMPLETED post-head resume-safe | fail-closed on malformed verdict (existing) |
| S16 | Durable journaling/checkpoints | `durable-execution.mjs` DurableRun hooks (or `durable-graph.mjs`) | lifecycle events | per child: events PHASE_READY, PHASE_STARTED, EXECUTOR_COMPLETED, SYSTEM_DELTA_READY, REVIEWER_COMPLETED, PHASE_PASSED/HELD/FAILED; artifacts executor-output, implementation-evidence, reviewer-system-delta.json/.patch, reviewer-verdict, result.json; ~5 checkpoint publishes (CURRENT.json CAS + lease acquire/release each) | durable | FS×~10 + lease ops per child | none | none | journal↔checkpoint alignment on resume | journal + artifacts + checkpoints | none | resume from checkpoint; interrupted writer → RECOVERY_REQUIRED | yes: publication failure → HOLD; CAS revision (existing) |
| S17 | Phase terminal → closeout | `colima-graph-runner.mjs` + `review-bundle.mjs runMandatoryGraphCloseout` | graph result (join in declaration order) | review bundle, closeout result, delivery record | durable (review surface) | **M×0–1 per graph** (gate), FS | none | none | bundle gate | closeout bundle | closeout review (once per graph) | state-driven closeout idempotent | downgrades PASS → HOLD on gate failure (existing) |
| S18 | Termination | `durable-execution.mjs terminateDurableRun` / `durable-graph.mjs` | final verdict, journal, checkpoints | RUN_PASSED/HELD event, final checkpoint, manifest (artifact inventory walk), final report | durable | FS×N | none | none | journal verify + artifact inventory | manifest | none | TERMINAL → resume returns completed | yes (existing) |
| S19 | Resume | `durable-execution.mjs resumeAutoLoopInternal` | persistenceRoot, executionId, adapter factories | resumed run result | durable reads | G×6 (fingerprint re-observation), FS reads | repo identity re-read | none | format-major check, journal chain/head alignment, post-head event classification, fingerprint field compare, input/config/IR/DAG hash recompute, completed-phase hash pinning, phase-set equality | none | none | read-only requeue OR INTERRUPTED_WRITER_PHASE_RECOVERY_REQUIRED | yes: every mismatch → RESUME_FINGERPRINT_MISMATCH (existing) |

Notable as-is facts verified by execution (probe `/tmp/decomp-opt1-measure.mjs`, Section E):

1. Production decomposition is one pipeline call; decomposition adapter invoked **exactly once per parent** (probe: adapterCalls=1).
2. Memory retrieval (R-10) is **once per graph**, exposed to all children by reference (`phase.runtime.memoryContext`).
3. Every child re-observes the repository identity independently in **four modules**: `collectRepositoryFingerprint` (run-level), `collectGitBaseline` (S13), `gitHeadTree` (S14), `system-delta` rev-parse (S12). Measured: HEAD read 3×/child, tree 3×/child, branch/upstream/ahead/behind/remote/toplevel 1×/child (13 identity git spawns/child).
4. `captureChangedPaths` (5 git spawns + per-path hash-object/ls-files in computeDelta) runs 3×/child (S8 baseline, S11 post-mutation, S12 re-observation).
5. **Observed limitation**: in durable mode, parallel read-only phases race the checkpoint CAS — probe hit `exception:HOLD / CHECKPOINT_STALE_REVISION` on the second of two parallel phases (one won, the other failed → whole-run HOLD). The scheduler permits parallelism; the durable checkpoint layer does not tolerate concurrent publishes. Cost scaling and resume behavior must account for this.

## 2. Repetition / classification matrix (per child, N-child decomposition)

Categories: **MFRESH** = MUST_FRESH_PER_CHILD · **PAR** = PARENT_OR_DECOMPOSITION_INVARIANT · **DEP** = DEPENDENCY_SENSITIVE · **ARCH** = ARCHITECTURAL_DUPLICATION · **UNK** = UNKNOWN_REQUIRES_PROOF.

| Operation | Repetition | Class | Rationale |
|---|---|---|---|
| Decomposition model call (S4) | 1×/parent | PAR | Produced once; artifact (decomposition-ir.json) + irSha/dagSha frozen. Already not repeated. |
| IR schema/structural/semantic/scorecard gates (S4) | 1×/parent | PAR | Deterministic over (IR, parent, manifest); IR immutable per decomposition revision. |
| Memory retrieval R-10 (S5) | 1×/graph | PAR | Already once; children consume by reference. |
| Input/config fingerprint (S2/S3) | 1×/run | PAR | Run-bound. |
| Repository fingerprint (S1) | 1×/run (+1 resume) | PAR | Run-bound; resume re-verifies. |
| Phase task card build (S7) | 1×/child | ARCH | Deterministic derivation from (IR phase, parent scope, executionId); identical parent→child inheritance recomputed per child. |
| Phase prompt construction (S7) | 2×/child | ARCH | Deterministic CPU; per-child because prompts embed phase facts — but the parent-derived sections (authority, verification obligations) are re-rendered per child. |
| Scope baseline snapshot (S8) | 1×/child | MFRESH | Must reflect the state AFTER prior siblings (shared-repo mode) / per-worktree baseline (isolated-writer mode). C4I invariant. |
| Repo identity observation (S13/S14/S12) | 3–13 git spawns/child | DEP | HEAD/tree/branch/origin are stable while the frozen worktree is untouched (phases cannot commit/push); stable within a run → reusable under a run-level fingerprint binding. `captured_at` is observation metadata, not the fact. Worktree dirty set is NOT stable. |
| Scope-gate post-mutation capture (S11) | 1×/child | MFRESH | Child-local mutation evidence. |
| System-delta re-observation + per-path diff (S12) | 1×/child | MFRESH | C4S scope-binding proof is per-child; per-path content evidence is child-local. |
| Verification command (S13) | 1×/child (all phases, colima wiring) | MFRESH (writer) / ARCH (read-only) | Writer phases require system-observed test evidence (hard gate). Read-only phases get the same `git status --porcelain` process run as "test evidence" — redundant for read-only phases; harness gate does not require it. |
| Harness evidence build (S13) | 1×/child | MFRESH (child-local facts) / ARCH (repo-identity block re-collected) | Evidence must be fresh for child-local mutation facts; its `repository_baseline` duplicates the run-level identity. |
| Review evidence bundle (S14) | 1×/child | MFRESH | Contains fresh delta/evidence; repo-identity block duplicated (gitHeadTree). |
| Executor call (S9) | 1×/child | MFRESH | Child execution can change facts. |
| Reviewer call (S15) | 1×/child | MFRESH | Reviewer independence; never reused. |
| Durable journal events + artifacts + checkpoints (S16) | ~5 events + ~5 artifacts + ~5 checkpoint publishes/child | MFRESH | Evidence durability per child; checkpoint CAS is a real concurrency constraint (Section 1 finding 5). |
| Graph closeout (S17) | 1×/graph | PAR | Already once per graph. |

## 3. Root-cause map

| # | Duplication | Root cause | Evidence |
|---|---|---|---|
| RC1 | Child re-derives full task card + scope + prompts | Child modeled as independent root task: `buildPhaseTaskCard` recomputes from (phase, parent, executionId) with no first-class parent artifact; no decomposition-revision digest is carried into the child | `phase-task-card.mjs` (S7); task card fields are all derivable from IR + parent |
| RC2 | Repo identity re-observed by 4 modules | No binding digest shared across evidence layers; each evidence schema carries its own `repository_baseline`/`objective_facts` block requiring fresh-looking observation | `harness-evidence.mjs` collectGitBaseline (9 G), `review-evidence.mjs` gitHeadTree (2 G), `system-delta.mjs` rev-parse (2 G), `c2d/fingerprint.mjs` (run-level) |
| RC3 | Per-child identity reads persist | Evidence schema (`validateImplementationEvidence` IE) requires a per-phase `repository_baseline` object with head/tree/upstream — the schema forces re-collection of run-stable facts | `validate-role-artifacts.mjs` IE_REQUIRED_FIELDS; `harness-evidence.mjs` evidence.repository_baseline |
| RC4 | Fresh session ⇒ fresh discovery | Session-freshness rule ("each phase gets fresh adapter instances, session reuse = 0") is enforced at the adapter layer, but the HARNESS re-does the discovery/observation work itself instead of injecting a frozen parent-bound fact bundle — the rule was not meant to force re-observation | `autoloop.mjs` header comment; orchestrator S8/S11/S12/S13/S14 |
| RC5 | No dependency/invalidation graph between facts | Nothing records which facts a child evidence bundle depends on; every child re-observes everything because no reuse decision is representable | no binding/invalidation structure exists in task card or evidence |
| RC6 | Verification command runs for read-only phases | Colima graph wiring sets `verificationCommand: ["git","status","--porcelain"]` globally (all phases); the writer test-evidence gate is the only consumer that is mandatory | `colima-graph-runner.mjs` hooks (S13); `harness-evidence.mjs` TEST_EVIDENCE_MISSING gate applies only when `allowedPaths.length > 0` |
| RC7 | Per-child checkpoint flood + CAS race | Durability design checkpoints at every safe boundary (5+/child); parallel phase terminals race the CAS (`CHECKPOINT_STALE_REVISION`, observed) | `durable-execution.mjs` hooks; probe output |
| RC8 | Parent context re-encoded per child | No immutable parent/decomposition artifact; the child packet's parent-derived sections (authority, verification scope) are re-derived per child | `phase-response-contract.mjs` sectionAuthority/sectionVerification per task card |

None of these is "it runs once per phase" — each traces to a missing shared artifact (RC1/RC5/RC8), a schema forcing re-collection (RC2/RC3), or wiring that over-broadens a safety rule (RC4/RC6/RC7).

## 4. Fact taxonomy + invalidation dependency model

Fact classes (F1–F8):

| Class | Facts | Binding inputs | Validity predicate | Invalidation edges | Safe reuse scope |
|---|---|---|---|---|---|
| F1 immutable parent/spec | source.goal, requirements, parent scope, authority, manifest | parent revision + admission id | input fingerprint matches frozen input.json | parent revision change; admission change | entire run; all children |
| F2 decomposition-revision | IR phases, edges, coverage, dispositions, execution_policy | F1 + source hashes + prompt_builder_version + decomposition adapter config | irSha == frozen decomposition-ir.json sha; config fingerprint matches | F1 change; decomposition re-run (new digest) | all children of one decomposition revision |
| F3A run-level artifact identity | repo root identity, HEAD, tree | frozen worktree identity + run start | per-child guard: `git rev-parse HEAD` == frozen expected_head (tree is a deterministic function of the commit object, so one HEAD check proves both) | in-run HEAD change (forbidden for phases); worktree drift; resume | all children of one run, referenced by digest |
| F3B external/ref metadata | branch, origin url/head, ahead/behind | run start + resume gate | validated by collectRepositoryFingerprint field compare at run start and resume ONLY; never claimed fresh in child evidence | ref/remote change between runs | run-level context; NOT bound into child evidence |
| F4 mutable worktree | dirty set, per-path content, untracked files | (worktree, time) | fresh capture | any mutation (including prior siblings) | none — always fresh |
| F5 child-local mutation | changed paths, before/after SHA-256, patch text | (child phase, baseline snapshot, run identity) | system-delta gates + scope gate | child re-execution; upstream subtree change | none — always fresh per child |
| F6 dependency-sensitive | sibling artifacts a child consumes (results dir, prior evidence) | producing phase terminal state | producing phase passed with pinned result hash | upstream re-run / invalidated | child subtree only (transitive dependents) |
| F7 global verification | verification/test process records | (command, cwd, worktree state) | harness process record + exit code | worktree mutation | per child where required (writer gate); not required for read-only |
| F8 reviewer-only judgment | verdicts, blocking issues, evidence gaps | (child, evidence bundle digest, reviewer identity) | verdict normalization + PASS-suppression | never | never reused |

Expected reusable-candidate form (issue Phase D requirement) — three concrete candidates:

- `fact: decomposition-ir.json + irSha + dagSha`
  → binding inputs: F1 fingerprint + source hashes + prompt version + adapter config hash
  → validity predicate: `buildIrSha256(artifact) == checkpoint.decomposition_ir_sha256 && buildDagFingerprint(artifact) == checkpoint.dag_sha256` (already enforced on resume)
  → invalidation edges: input/config fingerprint mismatch → fail-closed
  → safe reuse scope: every child of the run; children reference by digest, never re-derive.

- `fact: repository_baseline (repo identity block in implementation evidence)`
  → binding inputs: **F3A** frozen identity (root, HEAD, tree) only; F3B metadata is run-level context, never a child-evidence binding (R1-C)
  → validity predicate: `git rev-parse HEAD` == frozen expected_head per child before reuse (tree implied by commit identity); full `collectRepositoryFingerprint` field compare at run start and resume only
  → invalidation edges: HEAD change (forbidden for phases); worktree drift; resume
  → safe reuse scope: run-level; per-child evidence references the F3A snapshot by digest (or embeds the frozen copy) instead of re-collecting 13 spawns/child.

- `fact: memoryContext (R-10)`
  → binding inputs: repo identity + **task identity** + store snapshot digest
  → validity predicate: retrieval digest unchanged; store valid; task identity unchanged (R2-B1: a child graph's task identity differs from its parent's, so the parent's retrieval is NOT valid for the child by reference — each graph re-retrieves with its own scoped task identity)
  → invalidation edges: store snapshot digest change (MEMORY_STORE_INVALID fail-closed already); task identity change (expansion)
  → safe reuse scope: within one graph, once per graph (parent graph + each expanded child graph); never inherited across task-identity boundaries.

Mandatory-fresh set (protected from optimization): F4, F5, F7 (writer), F8, S8–S12 evidence collection, S15 reviewer call, S16 durable evidence writes.

## 5. Cost / repetition baseline (measured)

Probe: `/tmp/decomp-opt1-measure.mjs` + git-spawn counter preload (`/tmp/decomp-opt1-preload.cjs`) against the real pipeline modules at baseline `e1ecb45`. Synthetic 5-child IR (P1/P2 read-only analysis; P3/P4 isolated writers with artifact boundaries; P5 verification depending on P3/P4), shared-repo STACK_A orchestrator path with production-mirroring hooks (expectedExecutorProvider/Model, expectedReviewerModel, toolPolicy, env allowlist, verificationCommand `git status --porcelain`). Full run: **final PASS, all 5 phases completed**.

| Metric | Value (5 children) | Per child | Notes |
|---|---|---|---|
| Decomposition adapter (model) calls | 1 | 0.2 | once per parent (probe adapterCalls=1) |
| Executor calls | 5 | 1 | fresh adapter per child (session reuse = 0) |
| Reviewer calls | 5 | 1 | fresh adapter per child |
| git subprocess spawns (phase-attributable) | 172 | ≈34.4 | 179 total incl. 7 fixture setup; excludes run-level fingerprint (6) |
| — captureChangedPaths (S8+S11+S12) | 75 | 15 | 5 spawns × 3 captures |
| — repo identity (S13+S14+S12) | 65 | 13 | HEAD 3×, tree 3×, branch/upstream/ahead/behind/remote/toplevel 1× |
| — per-path content fingerprinting (computeDelta: hash-object + ls-files --error-unmatch) | 23 | 4.6 | scales with changed-path count |
| — verification command | 5 | 1 | `git status --porcelain` — redundant for read-only phases |
| — per-path system-delta (cat-file + diff) | 4 | <1 | writer phases only |
| Wall time (deterministic adapters) | ~705 ms | ~140 ms | excludes model latency; model calls and container starts dominate real cost |
| Durable journal files / artifacts (1 completed child + run-level) | 31 / 11 | ≈5 events + ≈5 artifacts + ≈5 checkpoint publishes | from code trace + probe; each checkpoint = CURRENT.json CAS + lease acquire/release |
| Memory retrieval | 1 | — | once per graph (R-10) |
| Graph closeout | 1 | — | once per graph |

Cost classification: **expensive** = executor/reviewer model calls (2N+1), per-phase container start (colima), verification command execution; **cheap but duplicated** = git identity observations (~13/child), deterministic gate recomputation, prompt re-render. Optimization priority follows real cost + failure risk: (1) identity observation dedup (13 spawns/child, cross-module drift risk — a HEAD that changed between S12/S13/S14 would produce inconsistent evidence), (2) verification layering, (3) manifest/packet artifact (removes RC1/RC8 and enables digest references).

## 6. Solution-space comparison

| Candidate | Problems solved | Complexity | New authority/consistency risk | Crash/resume | Evidence/review implications | Removes work vs moves it | CBM compatibility |
|---|---|---|---|---|---|---|---|
| A. Decomposition Manifest (frozen, content-addressed parent/decomposition snapshot) | RC1, RC5, RC8 (context/authority re-derivation; no shared artifact) | manifest schema + write-through evidence path + digest plumbing | manifest↔checkpoint drift if written outside evidence path; must reuse existing secret-scan/size-bound store | recoverable from artifacts; resume re-verifies digest (existing fingerprint machinery) | evidence references manifest by digest; reviewer sees frozen coverage/authority | removes per-child re-derivation of parent-derived card sections; replaces "child = root task" semantics | manifest becomes the CBM context seed; no parallel lifecycle |
| B. Run-level repository identity binding | RC2, RC3 (13 git spawns/child; cross-module HEAD inconsistency risk) | identity service or shared frozen snapshot; evidence schema allows digest reference | captured_at semantics: evidence must still prove observation time; must NOT weaken resume fingerprint gate | resume gate already enforces equality; in-run guard = 1 `rev-parse HEAD`/child | repository_baseline by reference (digest) or frozen copy; reviewer still sees system-observed identity | removes the largest repeated observation class; merges 4 modules → 1 observation | CBM reads the same binding |
| C. Explicit REUSE/REVALIDATE/RECOMPUTE engine | auditable reuse decisions | new decision table + state machine + telemetry | risk of bypassing freshness if disposition mis-derived | needs journaled dispositions | reviewer must not trust dispositions; only objective digests | mostly moves decision-making; adds machinery | CBM wants exactly this contract |
| D. Verification layering (child-local / dependency / parent-global) | RC6 (redundant read-only verification) | policy per phase (writer-only default) | none meaningful | none | writer test-evidence gate unchanged (MFRESH) | removes 1 redundant process/child and future parent-global dedup | orthogonal |
| E. Child Execution Packet (manifest ref + child-local scope + inherited facts by digest + fresh obligations) | RC1/RC4/RC8 composition | packet schema; orchestrator/phase-card construction change | packet must never widen child authority (containment re-check per child stays) | packets re-derivable from manifest + checkpoint; deterministic | review bundle embeds packet; reviewer independence unchanged | removes context re-construction AND enables B/D; single seam for all reuse | packet is the CBM consumption surface |
| F. Evidence reference reuse (bundle embeds sha256 references to prior artifacts) | token/bloat duplication in bundles | reference resolution on read | stale-reference risk — bounded by sha256 binding (fail-closed on mismatch) | references re-verifiable | reviewer receives digests + resolved objective facts | removes re-serialization; keeps freshness per child | compatible |

Comparison verdict: C alone is the most complex with the least direct subtraction today (the current deterministic path has only 2 model calls/child; the expensive repeated work is observation, not decisions). A+B+D compose into E with a strict subset of C's semantics (dispositions as recorded decisions with telemetry, not as a speculative cache). F is a packaging optimization of A/B.

## 7. Recommended design and subtraction rationale

**Design: Decomposition Manifest + Child Execution Packet (E), built on run-level repository identity binding (B) and verification layering (D); REUSE/REVALIDATE/RECOMPUTE dispositions recorded as auditable decisions + telemetry, not as a speculative cache layer.**

- Frozen Decomposition Manifest (`autoloop.decomposition-manifest/v1`, content-addressed) emitted once after DAG_ACCEPTED through the existing evidence path (secret-scanned, size-bounded, journaled): parent identity + revision, input fingerprint, config fingerprint, irSha, dagSha, F3 repository identity snapshot, source/prompt hashes, phase table digests.
- Child Execution Packet (`autoloop.child-execution-packet/v1`) replaces "standalone-from-zero child card": immutable manifest_ref (digest), child-local purpose/effects/boundaries (re-derived and re-verified per child — containment checks stay per child), inherited facts by digest (F3 identity, F2 coverage), fresh obligations list (F4/F5/F7 writer), per-stage disposition record.
- Run-level repository identity: ONE observation per run (already exists as the frozen fingerprint); evidence builders reference **F3A** (root/HEAD/tree) by digest; per-child in-run guard = single `rev-parse HEAD` (tree implied by commit identity); F3B (branch/upstream/origin/ahead-behind) is run-level context validated at run start and resume only — never claimed fresh in child evidence (R1-C).
- Verification layering: verification command runs for writer phases (mandatory gate) and explicitly-flagged verification phases only; read-only phases skip the redundant process.
- Scheduler, writer lease, mutation scope, reviewer independence, evidence schema gate order, journal/lease authority: UNCHANGED. Checkpoint publication: **R1-A** — per-run serialized durable commit (see Design R1 closure).

Subtraction rationale (work removed vs work moved):
- Removes: 13 identity git spawns/child (S13+S14+S12 re-observation → 1 guard spawn/child); redundant read-only verification process/child; per-child re-derivation of parent-derived card sections (prompt/authority/verification obligations rendered once, referenced by manifest); cross-module HEAD-inconsistency risk (single frozen identity).
- Keeps fresh per child: scope baseline, post-mutation capture, system delta, harness evidence child-local block, review bundle, executor+reviewer calls, journal+checkpoint writes, containment checks.
- Adds: two schema-versioned artifacts + digest plumbing + disposition recording + telemetry counters — a manifest layer, NOT a cache layer; no new authority, no CBM, no reviewer state.

## 8. Frozen contract candidate

1. **Reusable artifact/fact model**: `Decomposition Manifest` (immutable per decomposition revision, content-addressed sha256, written via evidence path) + per-run F3 repository identity snapshot (already frozen in checkpoint; made referenceable by digest).
2. **Identity/binding model**: manifest_id = sha256(manifest payload); child packet binds manifest_id + phase_id + executionId; evidence `repository_baseline` binds to F3 snapshot digest; every reference is a sha256 that fails closed on mismatch.
3. **Invalidation rules**: parent/spec revision change or admission change → new input fingerprint → new decomposition (existing resume gate); decomposition re-run → new manifest digest → children rebind; repo identity drift → fail-closed (existing assertFingerprint) with the **F3A** per-child in-run guard (single `rev-parse HEAD`; tree implied by commit identity — R1-C) before F3A reuse; F3B metadata validated only at run start and resume, never claimed fresh in child evidence; child subtree change → invalidates child + transitive dependents only (scheduler semantics already implement this).
4. **Child inheritance rules**: packet inherits F1/F2/F3 by digest; F4/F5/F7(writer)/F8 never inherited.
5. **Mandatory fresh per child**: scope baseline, mutation gate, system delta, harness child-local evidence, review bundle, executor/reviewer calls, journal/checkpoint writes, authority containment re-check.
6. **Review/evidence semantics**: reviewer receives fresh bundle; manifest facts (coverage, identity) by digest; reviewer independence unchanged (fresh adapter, no-tools, verdict authority unchanged); no agent-memory trust path.
7. **Recursive decomposition** (full lifecycle/authority contract — R1-B + R2-B1/R2-B2): child B → B1/B2 emits a child-scoped manifest revision bound to B's packet. Authority, scheduler semantics, join-back, review ownership, budget, bounds, memory binding, and crash/resume identity are defined in the Design R1/R2 closures below; the sealed runner is NOT modified (expansion is an orchestrator-level dispatch, never a DAG rewrite); B's terminal is the child graph's FINAL verdict after mandatory closeout.
8. **Idempotency**: identical (parent_revision, decomposition_revision, bound inputs) → identical manifest digest; rerun returns existing artifact reference; retry of one subtree regenerates only that subtree (scheduler initialState).
9. **Resume/crash**: resume/crash semantics unchanged; checkpoint publication concurrency follows R1-A/R2-A (per-run serialized durable commit); manifest recoverable from artifacts; resume re-verifies all bindings before any REUSE; interrupted writer → RECOVERY_REQUIRED.
10. **Telemetry (before/after)**: parent_context_compute_count, context_reuse_count, context_revalidate_count, context_recompute_count, duplicate_verification_avoided_count, evidence_reuse_count, subtree_invalidation_count, full_graph_invalidation_count, per-child repo-identity observation count.
11. **Non-goals**: no cache layer, no CBM dependency, no reviewer statefulness, no evidence reuse across changed bindings, no authority broadening, no removal of decomposition, no weakening of writer lease / mutation scope / fail-closed evidence.
12. **Implementation boundary**: `src/v2/production-pipeline.mjs` (manifest emission), `src/v2/execution-orchestrator.mjs` + `src/v2/phase-task-card.mjs` (packet construction), `src/v2/harness-evidence.mjs` + `src/v2/review-evidence.mjs` + `src/v2/system-delta.mjs` (digest-referenced repository identity), `src/v2/durable-execution.mjs` + `src/v2/durable-graph.mjs` (manifest artifact + binding verification + telemetry) — the durable modules also own the R1-A/R2-A per-run serialized durable commit boundary. Admission, budget, runner, governance, c2d sealed stores: unchanged. This card does NOT implement any of it.

## 8b. Design R1 closure (independent review response)

Independent design/spec review (first pass) verdict: `HOLD / AUTOLOOP_DECOMP_OPT1_DESIGN_CONTRACT_NOT_YET_IMPLEMENTATION_READY` — direction accepted (Manifest + Child Execution Packet + run-level identity binding + verification layering; subtraction rationale confirmed; no speculative cache), three contract gaps to close before implementation. This section closes all three; inventory, cost measurement, and root-cause map were not re-opened.

### R1-A — Durable parallel CAS disposition: **fix in this card (option A, minimal)**

- Problem (observed, Section 1 finding 5, RC7): parallel read-only phases terminate concurrently → two `publishCheckpoint` calls race the CAS → one wins, the other throws `CHECKPOINT_STALE_REVISION` → phase exception → whole-run HOLD. Affects both durable paths (`durable-execution.mjs` STACK_A, `durable-graph.mjs` production). This is a correctness defect in the production durable path, not merely a cost issue, and DECOMP-OPT1 keeps read-only parallelism — so it must be disposed, not deferred.
- Frozen disposition: **per-run serialized durable commit**. All checkpoint publications inside one DurableRun/DurableGraphRun are serialized through a per-run single-flight queue (async mutex). Each publish still performs the existing CAS + lease + journal-first write; the queue only removes concurrent publication. Merge-safe (not merge-based): no checkpoint diffing/merging is introduced. **Critical-section boundary (R2-A)**: the serialized section covers the FULL state machine — read latest durable revision → derive checkpoint state from latest committed state + current event → journal-first write → CAS checkpoint publication — not merely the final filesystem write; no caller may capture an expected revision or final checkpoint payload before entering the queue (see Design R2 closure).
- Fail-safe: if a CAS mismatch still occurs after serialization (external interference), behavior is unchanged — fail-closed HOLD (`CHECKPOINT_PUBLICATION_FAILED` / `CHECKPOINT_STALE_REVISION`), never silent skip.
- Non-goals (explicit): no checkpoint format change, no CAS-foundation change, no lease/permit semantics change, no weakening of journal-first durability, no change to the sealed runner's parallel scheduling.
- Contract text updates: Section 7 and Section 8 item 12 now read "journal/lease authority: UNCHANGED; checkpoint publication: R1-A per-run serialized durable commit" (conflict with the previously frozen `checkpoint/journal/lease authority: UNCHANGED` is resolved).

### R1-B — Recursive decomposition lifecycle/authority contract

Authority, scheduler semantics, join-back, review ownership, budget, bounds, and crash/resume identity for hierarchical decomposition — frozen as follows:

1. **Who may decompose B**: only the parent decomposition authority (admission-bound policy: `expansion_allowed`, `max_decomposition_depth`) may trigger B's expansion. Executor, reviewer, and model have no expansion authority; a reviewer verdict can never trigger decomposition (reviewer is verification-only). Child decomposition is the SAME decomposition authority applied recursively, bound by the same input/config fingerprint machinery as the parent decomposition (F2 semantics per child-scoped revision).
2. **B's scheduler state**: NO new runner status, NO sealed-runner change. B remains an ordinary phase in the parent DAG; expansion is an orchestrator-level dispatch: `execute(B)` invokes `runChildGraph()` (the same sealed scheduler + orchestrator + lifecycle + evidence path recursively) instead of a direct lifecycle run. B's `effects` are unchanged (B is normally a read-only container node); writer-lease arbitration is untouched.
3. **How B1/B2 join the DAG**: B1/B2 live in a child-scoped DAG (child manifest revision); `depends_on` inside the child DAG references only child phases. The PARENT DAG is never rewritten: downstream phases keep `depends_on: [B]`. **B's terminal authority (R2-B2)**: B's terminal is the child graph's FINAL verdict — leaves all PASS → child graph mandatory closeout gate → child graph final PASS → B PASS; any leaf HOLD/failure OR child graph closeout HOLD/downgrade → B HOLD → the existing transitive-dependents skip mechanism propagates invalidation exactly as today. Leaf aggregation alone can never decide B's terminal (hierarchical decomposition must not bypass the graph-closeout authority).
4. **Review ownership**: leaves B1/B2 each get a fresh child-local reviewer (fresh adapter, `no-tools`, independent verdict — unchanged). B itself is not executed, so it has no independent executor/reviewer call — the "decompose then re-run the whole parent workflow" failure mode is structurally impossible. One existing graph-level closeout gate runs per child graph (not per leaf, not per parent) and is the child graph's FINAL verdict authority: leaves PASS alone is insufficient — the child graph's final PASS requires the closeout gate to pass, and B inherits that final verdict (R2-B2).
5. **Budget split**: on expansion, B's envelope is partitioned into child limits (`childLimits`, monotonic narrowing via the existing `createBudgetEnforcement` semantics); the sum of child limits must not exceed B's envelope; children enforce their own limits; B's settlement records actual child consumption.
6. **Bounds / no-progress / repeated decomposition**: admission policy sets `max_decomposition_depth` (default 1) and each layer keeps the existing ≤7 phase IR cap. No-progress guard: a child manifest revision whose input fingerprint + scope/goal digest equals its parent's is rejected (identical re-decomposition). Idempotency: identical (parent revision, B packet, child IR, policy) → identical child manifest revision digest.
7. **Nested crash/resume revision identity**: child execution id is derived mechanically as `sha256(parentRunId + B.phase_id + child_manifest_revision)` — the revision is part of the identity, so different revisions can never collide on one checkpoint. Resume verifies, in order: parent checkpoint's B packet references a child manifest revision digest that matches the existing child checkpoint's digest → child input/config fingerprint recompute (existing resume gate) → child journal/checkpoint alignment. Interrupted child writer → `RECOVERY_REQUIRED` (unchanged semantics, scoped to the child subtree).
8. **No parent-level rework in a child graph**: child graph does NOT re-run the decomposition call and does NOT re-collect the run-level fingerprint (frozen at parent run start). **R-10 memory retrieval (R2-B1)**: the child graph re-runs retrieval with the CHILD-scoped task identity — `memoryContext` binding includes task identity (Section 4), and a child's task identity differs from B's, so the parent's retrieval is NOT valid for the child by reference. Retrieval therefore runs once per graph: once for the parent graph, once per expanded child graph (never per leaf). This preserves the R-10 binding intact at the cost of one graph-level retrieval per expansion, which is not a duplication driver.

### R1-C — F3 fact split + exact revalidation predicates

F3 (Section 4) is split into two facts with distinct predicates:

- **F3A — immutable artifact identity**: repo root identity, HEAD, tree. Binding: frozen worktree identity + run start. Per-child guard: single `git rev-parse HEAD` == frozen `expected_head`; **tree needs no separate check** — the tree object id is a deterministic field of the commit object, so identical HEAD implies identical tree. Root identity is bound by the orchestrator's fixed cwd (never re-derived per child). Child evidence `repository_baseline` embeds/references ONLY F3A (root, HEAD, tree, `captured_at`).
- **F3B — external/ref metadata**: branch, origin url/head, ahead/behind. These are run-level context, not child-fresh facts. Validated by `collectRepositoryFingerprint` field compare at run start and resume ONLY; **child evidence never claims F3B fresh** (fields removed from per-child `repository_baseline` or carried as an explicit run-level snapshot reference with no per-child freshness claim).
- Revalidation predicate summary: F3A → `rev-parse HEAD` per child (tree implied); F3B → run-start + resume fingerprint compare only. One HEAD check no longer endorses metadata it does not prove.

## 8c. Design R2 closure (targeted re-review response)

Targeted re-review verdict: `HOLD / AUTOLOOP_DECOMP_OPT1_R1_TARGETED_REVIEW_RESIDUAL_CONTRACT_GAPS` — R1-C accepted; R1-A accepted with one critical-section tightening (R2-A); R1-B has two authority/binding conflicts (R2-B1 memory task-identity binding, R2-B2 child closeout authority). This section closes all three; depth/budget/child-execution-id/parent-DAG-immutability/reviewer-independence/subtree-resume from R1-B are retained unchanged.

### R2-A — Serialized checkpoint critical section (exact boundary)

The per-run single-flight section covers the FULL commit state machine, not just the final filesystem write:

```text
Serialized commit boundary =
read latest durable revision
→ derive checkpoint state from latest committed state + current event
→ journal-first write
→ CAS checkpoint publication
```

- All four steps occur inside the same per-run critical section.
- No caller may capture an expected revision or final checkpoint payload before entering the queue (a stale revision captured outside the queue is exactly the original race; a payload built outside the queue can overwrite newer committed state even after a successful CAS).
- Rationale: the original race is between two concurrent `read revision → build snapshot` pairs; queueing only the `publishCheckpoint()` write serializes the CAS but still lets both phases build from the same stale revision, and a refreshed revision with a stale payload is a state-overwrite risk.
- This is a design-freeze requirement for DECOMP-OPT1 implementation; no runtime proof required now.

### R2-B1 — Recursive child memoryContext vs taskIdentity binding (resolved: fresh child retrieval)

- Contradiction: Section 4 binds memoryContext to repo identity + **task identity** + store digest, but R1-B clause 8 declared the child graph inherits the parent's retrieval by reference. After B → B1/B2 the child's task identity differs from B's, so the parent retrieval cannot be declared valid for the child on "same run / same F3A" grounds.
- Resolution (option A, as recommended): **each graph re-runs R-10 retrieval with its own scoped task identity** — the parent graph once, each expanded child graph once, never per leaf. The R-10 binding (task identity as a validity input) stays intact; one graph-level retrieval per expansion is not a duplication driver and is accepted cost.
- Updated text: R1-B clause 8 (no longer inherits parent memoryContext), Section 4 memoryContext candidate (task-identity invalidation edge: expansion), Section 8 item 7 reference.
- Rejected alternative: redefining taskIdentity out of the memory binding would weaken AUTH1 retrieval authority to save one graph-level call — not acceptable.

### R2-B2 — B terminal = child graph FINAL verdict after mandatory closeout

- Contradiction: R1-B clause 3 ("all child leaves PASS → B PASS") vs clause 4 (child graph closeout gate). Leaves PASS with a closeout HOLD must HOLD the child graph, hence B.
- Resolution: **B's terminal authority is the child graph's FINAL verdict, decided only after the mandatory graph closeout gate**:

```text
leaves PASS
→ child graph closeout gate
→ child graph final PASS
→ B PASS
```

- Any leaf HOLD/failure OR child graph closeout HOLD/downgrade → B HOLD → parent DAG transitive-dependents skip semantics apply unchanged. Leaf aggregation alone can never decide B's terminal; hierarchical decomposition cannot bypass the graph-closeout authority.
- Updated text: R1-B clauses 3 and 4, Section 8 item 7.

### Closure scope for the next (final) targeted review

- R2-A: serialized commit critical-section boundary frozen (full read→derive→journal→publish inside one single-flight section; no external revision/payload capture).
- R2-B1: child graph re-runs R-10 retrieval with child-scoped task identity; memory binding intact.
- R2-B2: B terminal = child graph FINAL verdict after mandatory closeout.
- Updated text: R1-A/R1-B clauses 3/4/8, Section 4 memoryContext candidate, Section 8 items 3/7/12, Sections 8b/8c. Inventory, cost baseline, root-cause map, and solution comparison are unchanged.

## 9. Readiness verdict

- First-pass independent design/spec review: `HOLD / AUTOLOOP_DECOMP_OPT1_DESIGN_CONTRACT_NOT_YET_IMPLEMENTATION_READY` (R1-A durable parallel CAS, R1-B recursive lifecycle, R1-C F3 split) — closed in Section 8b.
- Targeted re-review: `HOLD / AUTOLOOP_DECOMP_OPT1_R1_TARGETED_REVIEW_RESIDUAL_CONTRACT_GAPS` (R2-A commit critical section, R2-B1 memory task-identity binding, R2-B2 child closeout authority) — closed in Section 8c. R1-C accepted unchanged.
- Final targeted re-review: **PASS** — R2-A (serialized commit boundary locked at read→derive→journal→publish inside one per-run critical section, no external revision/payload capture), R2-B1 (child graph fresh R-10 retrieval under child-scoped task identity; AUTH1 binding intact), R2-B2 (B terminal = child graph FINAL verdict after mandatory closeout) all accepted; R1-C (F3A/F3B split) maintained. Two LOW wording fixes applied to Section 8 items 9/12 (checkpoint publication concurrency follows R1-A/R2-A; durable modules own the serialized commit boundary) — non-blocking, no further review required.
- Baseline sync: **verified** — GitHub == local == issue-stated `e1ecb45…`; no baseline change.
- Problem space: **sufficiently modeled** — full source trace at baseline + executed 5-child probe (PASS) + durable-path probe + measured cost profile; one real as-is limitation surfaced (durable checkpoint CAS race on parallel phases, Section 1 finding 5).
- Readiness gate 1–11: **met** (execution graph, classification, root-cause, binding/invalidation, baseline, ≥2 solution comparisons with subtraction rationale, frozen contract candidate, recursive decomposition + subtree invalidation modeled, fail-closed crash/resume + stale-evidence modeled, before/after telemetry defined, CBM out of scope).
- Readiness gate 12 (independent design/spec review): **not self-certifiable within this unit** — the card's PASS gate requires an independent review of this document.
- **Verdict: `PASS / AUTOLOOP_DECOMP_OPT1_DESIGN_SPEC_REVIEWED_AND_IMPLEMENTATION_READY`** — readiness gates 1–12 met; independent design/spec review completed across three rounds (R1 gaps, R2 gaps, final PASS). Design freeze is complete: Decomposition Manifest + Child Execution Packet + run-level F3A identity binding + verification layering, with R1-A/R2-A serialized durable commit, R1-B/R2-B1/R2-B2 recursive lifecycle/authority, and R1-C F3A/F3B split. **Implementation NOT started** — Issue #5 DECOMP-OPT1 implementation may now proceed strictly against this frozen design (sequencing: AUTH1 convergence → this design card → DECOMP-OPT1 implementation → CBM integration).

Measurement artifacts: `/tmp/decomp-opt1-measure.mjs`, `/tmp/decomp-opt1-preload.cjs` (probe + counter), `/tmp/debug4.mjs` (durable-path probe), `/tmp/debug2.mjs`, `/tmp/debug3.mjs`, `/tmp/dbg5.mjs` (fault-isolation helpers). No production code was modified.
