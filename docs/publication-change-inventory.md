# Publication remediation — change inventory

Every change made by `AUTOLOOP_OPEN_SOURCE_PUBLICATION_REMEDIATION_1`, with what
it was for. Nothing here is committed by the card; this is the record of the
working tree.

## Added

### License and legal

| File | Purpose |
|---|---|
| `LICENSE` | unmodified Apache-2.0 text (202 lines; verified byte-identical to the canonical text, placeholder copyright retained) |
| `NOTICE` | AutoLoop's own copyright + attribution only — no dependency list |
| `THIRD_PARTY_NOTICES.md` | generated from the lockfile: 93 packages, 0 unknown licenses; LINKED DEPENDENCY / OPTIONAL INTEGRATION / EXTERNAL TOOL / NETWORK SERVICE; trademark and non-endorsement statement |
| `CONTRIBUTING.md` | setup, tests, the design rules a change is reviewed against, PR and commit expectations, license terms for contributions |
| `SECURITY.md` | private vulnerability reporting, in/out of scope, known limitations, credential handling |

### Public documentation

| File | Contents |
|---|---|
| `docs/getting-started.md` | clean clone → install → configure → first real task → inspect |
| `docs/architecture.md` | the control flow, the authority map, the module map |
| `docs/configuration.md` | every public variable, its default, its validation rule, and how to preserve a prior deployment's behaviour |
| `docs/agent-integration.md` | the pinned runtime identity, the tool vocabulary, the adapter contract |
| `docs/durable-execution.md` | journal, checkpoints, evidence, resume, and what it does not survive |
| `docs/governance.md` | classification, admission, budget, scope, evidence, review, promotion, commit, HOLD codes |
| `docs/telemetry-and-operator.md` | the observability/authority split, retention classes, the operator surface |
| `docs/autonomous-evolution.md` | the loop, the risk classes, the operator controls, honest limits |
| `docs/cross-agent-learning.md` | attribution → memory → fitness → transfer, and its evidence floors |
| `docs/operations.md` | routine inspection, HOLD triage, crash/resume, sandbox and telemetry operations |
| `docs/troubleshooting.md` | symptom → likely cause → inspection → safe action |
| `docs/benchmark.md` | the effectiveness benchmark: methodology, environment, results, limitations |
| `docs/publication-triage.md` | what was kept, what was archived and where, which test baselines were re-derived |
| `docs/publication-dry-run.md` | what a public HEAD exposes, and the findings surfaced while verifying it |

### Benchmark

| File | Purpose |
|---|---|
| `benchmarks/README.md` | how to run it, what each arm means, how to reproduce the pilot |
| `benchmarks/tasks/*.json` | 7 self-contained task definitions (fixture + acceptance suite) |
| `benchmarks/runner/run-benchmark.mjs` | executes the arms via real AutoLoop runs |
| `benchmarks/runner/build-learned-store.mjs` | turns prior runs into the learned arm's strategy store |
| `benchmarks/analysis/analyze.mjs` | descriptive statistics, proportions, differences; no composite score |
| `benchmarks/analysis/append-analysis.mjs` | regenerates `results/analysis.json` + `provenance.json` |
| `benchmarks/results/*.jsonl` | the raw per-run records (committed so the benchmark is reproducible): 3 samples × 35 runs |
| `benchmarks/results/learned-strategy-store/` | the strategy store the learned arm reads, built from the committed samples |
| `benchmarks/results/analysis.json`, `provenance.json` | computed statistics and which raw file contributed what |

### Examples

| File | Purpose |
|---|---|
| `examples/minimal/run.mjs` (+ README) | the whole pipeline once, plus a negative case where the gate refuses |
| `examples/subagent/run.mjs` (+ README) | per-child envelope projection, role separation, fail-closed join |

### Instrumentation and seams

| File | Purpose |
|---|---|
| `src/shared/autoloop-paths.mjs` | **the single configuration seam**: every state root, review surface, executable and mount gate resolves here |
| `test/run-suite.mjs` | the default `npm test` entrypoint: host-only suite, with the external suites listed and explained |
| `scripts/durable-worktree.sh` | rewritten: configured root, optional mount gate, no hardcoded volume |
| `test/fixtures/card-5-live-e2-ir.json` | live-IR fixture extracted from archived evidence |
| `test/fixtures/card-5c-live-cases.json` | live-case fixture extracted from archived evidence |
| `test/fixtures/incident-opening-goldens.json` | opening goldens, re-derived on a machine-independent identity root |
| `test/fixtures/task-decomposition-eval-cases.json` | byte-identical copy of the archived eval cases |

## Modified

### Portability (the functional remediation)

| File | Change |
|---|---|
| `src/runtime/colima-runtime.mjs` | `COLIMA_HOME` becomes configured (was a hardcoded volume path); the volume-UUID + shadow-mount gate becomes opt-in via `AUTOLOOP_COLIMA_MOUNT`/`_UUID`; `colima`/`docker` resolve from `PATH` with explicit overrides |
| `src/runtime/colima-profile-lock.mjs` | lock root derives from `COLIMA_HOME` → `AUTOLOOP_HOME`; accepts an injectable env |
| `src/telemetry/location.mjs` | `TELEMETRY_ROOT` resolves from config; the evidence-separation fence is enforced by the resolver |
| `src/telemetry/gc.mjs` | both GC namespace checks resolve the evidence root from config |
| `src/telemetry/store.mjs` | append cost made O(1) (rotation accounting was re-reading the active chunk per append) |
| `src/admission/policy-projection.mjs` | the pinned runtime identity resolves from config + `PATH` (was one machine's npm prefix); `FROZEN_RUNTIME_IDENTITY` retained as a lazy compatibility view |
| `src/learning/transfer-metrics/schema.mjs` | storage prefix resolves from config |
| `src/learning/transfer-metrics/fixtures.mjs` | scratch root resolves from config; fixture **identities** use a fixed synthetic root so digests are machine-independent |
| `src/learning/transfer-metrics/writer.mjs`, `src/learning/incidents/{current-verification,lifecycle-terminal-adapter}.mjs` | the storage guard refuses `$HOME` itself and enforces the namespace boundary (was: refuse any `$HOME` subtree) |
| `src/governance/{review-bundle,execution-review,verification-scope-guard}.mjs` | review surfaces resolve from the shared seam |
| `src/memory/local-store.mjs`, `src/subagent/subagent-graph-runner.mjs` | defaults resolve through `AUTOLOOP_HOME` (were literal `~/.autoloop/...`, contradicting the docs) |
| `scripts/shared/evidence-root.mjs` | portable default; the volume gate becomes opt-in (`AUTOLOOP_EVIDENCE_MOUNT*`) |
| `scripts/pi-autoloop.sh` | repo root derived from the script's own location; `AUTOLOOP_REPO_ROOT` override |
| `scripts/c3-colima-task.mjs`, `scripts/gov-closeout-bundle.mjs` | default output directories resolve from config |
| governance CLI comments/docs | reference the configured surface rather than one machine's Desktop path |
| 63 test files | repo-root literals replaced with location-derived values (trailing separator stripped so path comparisons are exact) |
| `test/test-pi-autoloop-launcher.mjs` | rewritten to exercise the REAL launcher with a `pi` stub, instead of asserting a hardcoded path |
| `test/admission/test-rb-ssg-vendor-integrity.mjs` | the installed-runtime half becomes strictly opt-in (`AUTOLOOP_PI_EXTENSION_DIR`); the repo byte-identity invariant is unchanged |
| `test/admission/test-rb-ssg4-bounded-rewrite.mjs` | the "broad development root" derives from the checkout (the ancestor relation is what the test needs, not a path) |
| test fixtures using an operator path | replaced with documented example users or `homedir()` |

### Publication tree

| Change | Detail |
|---|---|
| removed | `docs/pi-graph-output/**` (370 files), `autoloop-analysis/**` (7), 45 `docs/governance/*`, 61 one-off `scripts/*` — all byte-identically archived first (see `docs/publication-triage.md`) |
| kept | 16 frozen governance contracts (each named in `docs/governance.md`) |
| restored | 16 contracts, archived then restored (verification path) |
| `.gitignore` | rewritten: platform litter, dependencies, secrets, local AutoLoop state, generated evidence, test litter; `file:*` fixed to cover the observed literal-directory shape |
| `package.json` | `license: Apache-2.0`; description, repository, homepage, bugs, engines (`>=24`), keywords; `peerDependencies` for the optional Pi CLI; `test`, `test:colima`, `test:pi`, `example:*` scripts; dead `gate:card5e` removed |
| `package-lock.json` | regenerated |
| `README.md` | rewritten as a public landing page |
| `AGENTS.md` | rewritten: repo location derived (not stated), no machine path, sandbox single-flight and background-job rules kept |
| vendored Pi extension | re-synced byte-identically to `src/admission/*` after the comment/comment-free changes |

### Test baselines legitimately re-derived

| Test | What changed and why |
|---|---|
| `incident-opening-goldens` (13 digests) | identity inputs moved from the operator's scratch path to a fixed synthetic root; digests recomputed **using the same construction the test performs**. Code path unchanged. |
| `adapter_sha256`, `writer_sha256`, `durability_1r_sha256` | re-pinned: those files changed to remove the hardcoded storage path. `authority_state_sha256` and `projection_sha256` are **unchanged**. |
| `test-incident-observation-profile-1r.mjs` "production reachability" | the bare substring `learning/transfer-metrics` matched a legitimate `TRANSFER_CODES` value import; now asserts that single import explicitly and fails on any other reference |
| `test-incident-current-verification.mjs` T82 | the bare substring `learning/` matched legitimate `learning/lifecycle/*` and `learning/patterns/*` imports (4 false hits); now scans for the specific forbidden modules |
| `test-learning-authority-durability-1r.mjs` R57/R58 | asserted the transfer-metrics stack had *zero* importers and no current-verifier module; a later authorized extraction added both. Restated as "only the learning layer may reach it" and "the verifier exists only as the incident-layer module" |
| `test-incident-observation-profile.mjs` T43/T44 | same false-positive scan as above (`learning/transfer-metrics` matching the `TRANSFER_CODES` value import); restated to assert that one documented import explicitly |
| `test-incident-observation-profile.mjs` T41 | kept a second, divergent inline copy of the opening goldens; now sourced from the shared fixture so the two suites cannot drift |
| `src/shared/autoloop-paths.mjs` `resolveScratchRoot` | the *default* now resolves symlinks in the existing prefix: on macOS `/tmp` is a symlink to `private/tmp`, and a `$HOME` reached through it made the default scratch root unusable. An **explicitly configured** root is never rewritten, so a symlinked configuration still fails loudly |
| `test-telemetry-overhead` append latency | replaced an absolute wall-clock threshold (which measured the host disk) with a calibrated budget against a raw append on the same volume |

`test-w1a-contracts.mjs` was **archived with its subject**: it tested only the
archived internal verification scripts.

## Not changed

- Git history (no rewrite, no reflog surgery).
- Repository visibility (still private).
- The `data`/`schema` contracts, the durable format, or any artifact digest
  semantics.
- No credential rotation (none was needed).

## Follow-up landed on top of this remediation

`AUTOLOOP_OPEN_SOURCE_SCOPE_PROJECTION_CANONICALIZATION_REPAIR_1` — the F1
finding recorded in `docs/publication-dry-run.md` (the admission scope
projection accepted a lexically escaping boundary such as
`src/../../etc/x` while the enforcement gate canonicalized it away). The
projection now resolves paths through the same canonicalization seam as the
gate (`src/c2d/mutation-scope.mjs`) and fails closed on anything unresolvable,
ambiguous, absolute or escaping; `PROJECTION_DECISION === ENFORCEMENT_DECISION`
is asserted over a boundary fixture corpus in
`test/admission/test-scope-projection-canonicalization.mjs`. No legitimate
scope form changed.

| File | Change |
|---|---|
| `src/c2d/mutation-scope.mjs` | added `canonicalScopePath`, `canonicalScopeEntry`, `canonicalScopeEntries`, `isWithinCanonicalScope`; `canonicalRepositoryPath` split into the pure lexical part + root/symlink part (semantics unchanged) |
| `src/admission/policy-projection.mjs` | `projectEnvelopeFields` / `assertMutationWithinAdmissionScope` canonicalize both sides and fail closed; lexical `normalizeScope` / `withinScope` removed; optional `repositoryRoot` |
| `src/subagent/subagent-contract.mjs` | `validateWriterSubagentResult` scope containment canonicalized; optional `repositoryRoot` |
| `src/subagent/subagent-writer-executor-adapter.mjs` | host-observed `scopeViolations` canonicalized; passes the worktree root |
| `src/subagent/subagent-graph-runner.mjs` | writer envelope projection passes `phase.runtime.worktreePath` as the boundary root |
| `docs/governance.md`, `docs/architecture.md`, `docs/publication-dry-run.md` | document the single canonicalization seam and mark F1 fixed |

## Follow-up landed on top of the canonicalization remediation — M1 write containment

`AUTOLOOP_OPEN_SOURCE_SYMLINK_WRITE_CONTAINMENT_REPAIR_1` — the M1 finding from
`AUTOLOOP_OPEN_SOURCE_LOCAL_SECURITY_REVIEW_1`: a write through a symlink that
already exists in the worktree landed outside it while git reported **no**
changed path (`git diff` / `git ls-files` empty), so the post-mutation scope
gate had nothing to classify, and a dangling symlink was accepted as a declared
artifact boundary. The git-delta gate is unchanged and still runs; a second,
git-independent filesystem layer was added, and the declaration path now
`lstat`s each component before any existence test so a dangling link is refused
exactly like a resolvable one.

| File | Change |
|---|---|
| `src/c2d/write-containment.mjs` | NEW — `scanSymlinkEscapes`, `auditBoundarySymlinkComponents`, `verifyWriteContainment`, `literalBoundaryPrefix`, `WRITE_CONTAINMENT_REASON`; walks the materialized worktree with `lstat`/`readlink`/`realpath` and fails closed |
| `src/c2d/mutation-scope.mjs` | `canonicalRepositoryPath` rejects a symlink component by `lstat`-first (a dangling link is no longer skipped by `existsSync`); documentation of the git-inventory limit and of the companion layer |
| `src/c2d/mutation-run.mjs` | C3B boundary audits the isolated worktree before dispatch (`pre_mutation_write_containment`: a symlink escape ⇒ `SCOPE_VIOLATION`, the command never runs) and after the mutation (`post_mutation_write_containment`); evidence is recorded for every terminal state |
| `src/subagent/subagent-writer-executor-adapter.mjs` | host-observed writer scope verification includes the git-independent containment scan |
| `test/test-write-containment.mjs` | NEW — reproduces the empty-delta write, and pins declared-symlink denial, pre-existing/dangling/create-then-write refusal, swap-after-validation refusal and unchanged legal in-scope writes |
| `test/v2/test-post-finalization-derived-artifact.mjs` | the `src/c2d` module freeze (L4) now pins the exact sealed module SET instead of a bare count, so it still fails on any addition/removal/rename; `write-containment.mjs` is listed explicitly with its non-state rationale |
| `docs/governance.md`, `docs/architecture.md`, `docs/troubleshooting.md` | document the second layer and the scope checks it records |


## Follow-up landed on top of this remediation — brand rename

`AEGISFLOW_PROJECT_RENAME_AND_COMPATIBILITY_MIGRATION_1` — the project was
renamed from **AutoLoop** to **AegisFlow**, with positioning "a governed
execution layer for autonomous agents". The rename is branding-only: it is
deliberately *not* a protocol, schema or state change, and no state migration is
required. The classification that governed every edit:

| Class | Decision |
|---|---|
| A. public branding (README, docs, CONTRIBUTING, SECURITY, examples, benchmark prose, package description) | renamed |
| B. user-facing command/path (`scripts/aegisflow-operator.mjs`, `scripts/pi-aegisflow.sh`, `npm run pi:aegisflow`, example temp prefixes) | renamed, forwarding alias kept |
| C. environment contract (`AEGISFLOW_*`) | brand name primary, `AUTOLOOP_*` still resolved; brand wins when both are set |
| D. machine/persistence contract (`autoloop.*` schema ids, `~/.autoloop`, `evidence/autoloop*`, `refs/autoloop/candidates/`, `autoloop_format_version`, hash-domain seeds, Colima profile names, `autoloop.card=` label, commit trailer keys) | **unchanged** |
| E. internal code symbols (`runAutoLoop`, `AutoLoopError`, `autoloop-paths.mjs`, `AUTOLOOP_HOLD`, …) | **unchanged** |
| F. historical records (committed benchmark results, frozen governance contracts, past commit messages, benchmark arm names) | **unchanged**, no history rewrite |

| File | Change |
|---|---|
| `src/shared/autoloop-paths.mjs` | NEW `readConfigEnv` / `legacyEnvName` / `LEGACY_ENV_PREFIX`: one precedence rule (`AEGISFLOW_*` wins, blank counts as unset, never merged) applied by every root, review-surface, mount-gate and executable resolver |
| `src/telemetry/location.mjs`, `src/telemetry/gc.mjs`, `src/telemetry/production-observer.mjs` | telemetry state-root override resolves through the same rule |
| `src/memory/local-store.mjs`, `src/runtime/colima-profile-lock.mjs`, `src/runtime/colima-runtime.mjs`, `src/evolution/production-declaration.mjs`, `src/evolution/production-consumer.mjs`, `src/evolution/operator-view.mjs`, `src/admission/policy-projection.mjs`, `src/adapter/pi-spawn-adapter.mjs`, `src/governance/{promotion-authority,review-job}.mjs`, `scripts/shared/evidence-root.mjs`, `scripts/gov-closeout-bundle.mjs`, `scripts/c3-colima-task.mjs`, `pi-extensions/search-scope-governor/index.ts`, `benchmarks/runner/run-benchmark.mjs` | read configuration through the shared rule; the exported `*_ENV` constants now carry the brand spelling while the legacy spelling still resolves |
| `scripts/aegisflow-operator.mjs`, `scripts/pi-aegisflow.sh` | renamed (was `autoloop-operator.mjs` / `pi-autoloop.sh`); the pre-rename paths are now thin forwarding aliases |
| `scripts/durable-worktree.sh` | `AEGISFLOW_WORKTREE_*` / `AEGISFLOW_HOME` / `AEGISFLOW_REPO_<PROJECT>` with the `AUTOLOOP_*` spellings as fallbacks; partial mount gates still refuse |
| `scripts/pi-aegisflow.sh`, `package.json` | `AEGISFLOW_REPO_ROOT` wins, `AUTOLOOP_REPO_ROOT` still honored; `pi:aegisflow` + `operator` are canonical, `pi:autoloop` + `autoloop:operator` are the aliases |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `NOTICE`, `THIRD_PARTY_NOTICES.md`, `AGENTS.md`, `.gitignore`, `docs/*.md`, `examples/*`, `benchmarks/README.md` | branding, repository URLs and configuration names |
| `src/schema/*.schema.json` (17), `src/admission/admission-record.mjs` | `title` annotations only — the `$id` / `const` contract strings are untouched, and no validator reads `title` |
| `docs/migration-rename.md` | NEW: the migration note (what changed, what is frozen, precedence table, GitHub rename semantics) |
| `test/test-env-compatibility.mjs` | NEW: 17 behavioural assertions over legacy-only, brand-only and both-supplied precedence, persisted-identity freeze, and a real spawned-CLI check |
| `test/pi-autoloop-launcher`, `test/telemetry/*`, `test/evolution/*`, `test/governance/*`, `test/test-standalone-paths`, `test/v2/*` + others | canonical script/env names; the launcher suite now also pins that the alias forwards instead of duplicating the contract |

Deliberately **not** changed: `package.json` `"name"` stays `autoloop` (the
package is `"private": true` and the `aegisflow` name on the public registry
belongs to an unrelated package — the repository does not take it), the
benchmark raw results and arm names (`AUTOLOOP_FRESH`, `AUTOLOOP_LEARNED`), and
every `autoloop.*` persisted identifier.
