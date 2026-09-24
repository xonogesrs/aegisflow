# Configuration reference

AutoLoop's configuration surface is **environment variables only**. There is no
config file format to learn, nothing is written back to disk, and every
resolver in the codebase goes through one module:
`src/shared/autoloop-paths.mjs`.

Two universal rules, both fail-closed:

1. **A configured path must be absolute.** A relative value is an error and is
   never resolved against the process cwd.
2. **State lives in the AutoLoop namespace or outside `$HOME`.** `$HOME` itself
   is refused as a root; a path inside `$HOME` must be under `AUTOLOOP_HOME`.

Secret material is **never** configured in this repository. Only the *names* of
credential variables are documented; their values are supplied by your shell or
by the provider CLI's own credential store.

---

## REQUIRED

Nothing. A clean checkout runs with zero configuration for local exploration:
all state defaults into `~/.autoloop`.

| Variable | Default | Enforced |
|---|---|---|
| — | — | — |

---

## OPTIONAL

### State locations

| Variable | Default | Purpose |
|---|---|---|
| `AUTOLOOP_HOME` | `~/.autoloop` | Container for every default below. Relocating this one variable moves all AutoLoop state that has no more specific override — including the memory store and durable checkpoints, which resolve through it rather than hardcoding `~/.autoloop`. |
| `AUTOLOOP_EVIDENCE_ROOT` | `$AUTOLOOP_HOME/evidence/autoloop` | Durable evidence: checkpoints, journals, evidence artifacts. |
| `AUTOLOOP_TELEMETRY_ROOT` | `$AUTOLOOP_HOME/evidence/autoloop-telemetry` | Telemetry stream. **Must not be inside the evidence root** — the resolver rejects that outright. |
| `AUTOLOOP_LEARNING_ROOT` | `$AUTOLOOP_HOME/learning` | Cross-agent learning storage (transfer-event log, incident records). |
| `AUTOLOOP_SCRATCH_ROOT` | `$AUTOLOOP_HOME/learning/scratch` | Scratch space for fixture/sandbox work. |
| `AUTOLOOP_MEMORY_STATE_ROOT` | `$AUTOLOOP_HOME/memory` | Memory store root (tests and CI isolate themselves with this). |
| `AUTOLOOP_PI_GRAPH_OUTPUT` | *(unset → `docs/pi-graph-output`)* | Where the governance engine writes per-run evidence inside the checkout. |

### Human-facing review surfaces

These are operator-visible directories, so an override may point anywhere
absolute (including, deliberately, a Desktop folder). They are not authority
stores.

| Variable | Default |
|---|---|
| `AUTOLOOP_REVIEW_SURFACE` | `$AUTOLOOP_HOME/review/Current` |
| `AUTOLOOP_REVIEW_ARCHIVE` | `$AUTOLOOP_HOME/review/Archive` |
| `AUTOLOOP_EXECUTION_REVIEW_SURFACE` | `$AUTOLOOP_HOME/review/Latest` |
| `AUTOLOOP_EXECUTION_REVIEW_ARCHIVE` | `$AUTOLOOP_HOME/review/Latest/archive` |

### Agent runtime

| Variable | Default | Purpose |
|---|---|---|
| `AUTOLOOP_PI_RUNTIME_PATH` | resolved from `PATH` | Absolute path to the `pi` CLI entry point. Required only when `pi` is not on `PATH`. |
| `AUTOLOOP_PI_RUNTIME_SHA256` | computed from the file | Expected content digest. Set this to pin an exact artifact. |
| `AUTOLOOP_PI_RUNTIME_VERSION` | *(unset)* | Expected version string; reported in the admission contract. |

The resolved identity (realpath + digest) is part of the admission contract.
Upgrading the runtime without re-pinning produces a fail-closed drift HOLD —
see [getting-started.md](getting-started.md#step-4b--run-against-a-real-agent).

### Sandbox runtime (Colima)

| Variable | Default | Purpose |
|---|---|---|
| `COLIMA_HOME` | *(unset)* | **Required for any sandbox/container execution.** Absolute Colima runtime home. Unset ⇒ fail-closed HOLD, never a fallback to `~/.colima`. |
| `AUTOLOOP_COLIMA_MOUNT` | *(unset)* | Optional volume the runtime home must sit on. |
| `AUTOLOOP_COLIMA_MOUNT_UUID` | *(unset)* | Volume UUID for `AUTOLOOP_COLIMA_MOUNT`. With both set, the mount gateway verifies the UUID and refuses shadow mounts. |
| `AUTOLOOP_COLIMA_SKIP_MOUNT_GATE` | *(unset)* | Set to `1` to disable the volume gate while still requiring an absolute, non-`$HOME` `COLIMA_HOME`. |
| `AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT` | `$COLIMA_HOME/autoloop-locks` | Where per-profile single-flight locks live. |
| `AUTOLOOP_COLIMA_BIN` | discovered via `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` | Override the `colima` executable. |
| `AUTOLOOP_DOCKER_BIN` | discovered via `PATH` | Override the `docker` executable. |
| `AUTOLOOP_TEST_PROFILES` | the four `autoloop-*` profiles | Restricts which Colima profiles AutoLoop may ever stop or reconcile. A profile outside this set is never mutated. |

### Evidence mount gate (optional)

For deployments that require durable evidence to live on one specific volume:

| Variable | Purpose |
|---|---|
| `AUTOLOOP_EVIDENCE_MOUNT` | Absolute mount root the evidence root must sit under. |
| `AUTOLOOP_EVIDENCE_MOUNT_UUID` | That mount's volume UUID. |

Both must be set together, or neither: a partial gate fails closed rather than
silently disabling the check. With both set, importing the evidence module
verifies the mount is present, its UUID matches, and no shadow mount exists.

### Telemetry

| Variable | Default | Purpose |
|---|---|---|
| `AUTOLOOP_TELEMETRY_STATE_ROOT` | *(unset)* | Exact store root for one run. Used for test/CI isolation. Must be absolute and not `$HOME` itself. |
| `AUTOLOOP_TELEMETRY_ROOT` | see above | Relocates the whole telemetry namespace. |

---

## Preserving an existing deployment's behaviour

Before this remediation the runtime resolved several roots to one specific
machine layout. That layout is now **configuration**, so a deployment that
prefers the previous behaviour keeps it exactly — by setting the variables it
used to get implicitly:

```bash
# State roots on a dedicated volume
export AUTOLOOP_EVIDENCE_ROOT=/Volumes/YourVolume/evidence/autoloop
export AUTOLOOP_TELEMETRY_ROOT=/Volumes/YourVolume/evidence/autoloop-telemetry
export AUTOLOOP_LEARNING_ROOT=/Volumes/YourVolume/
export AUTOLOOP_SCRATCH_ROOT=/Volumes/YourVolume/tmp

# Sandbox runtime on that volume, with the mount-identity gate
export COLIMA_HOME=/Volumes/YourVolume/runtime/colima
export AUTOLOOP_COLIMA_MOUNT=/Volumes/YourVolume
export AUTOLOOP_COLIMA_MOUNT_UUID=$(diskutil info -plist /Volumes/YourVolume | plutil -extract VolumeUUID raw -o - -)

# Durable worktrees + the evidence mount gate
export AUTOLOOP_WORKTREE_ROOT=/Volumes/YourVolume/worktrees
export AUTOLOOP_WORKTREE_MOUNT=/Volumes/YourVolume
export AUTOLOOP_WORKTREE_MOUNT_UUID="$AUTOLOOP_COLIMA_MOUNT_UUID"
export AUTOLOOP_EVIDENCE_MOUNT=/Volumes/YourVolume
export AUTOLOOP_EVIDENCE_MOUNT_UUID="$AUTOLOOP_COLIMA_MOUNT_UUID"

# Human review surfaces where they were
export AUTOLOOP_REVIEW_SURFACE=$HOME/Desktop/AutoLoop-Review/Current
export AUTOLOOP_REVIEW_ARCHIVE=$HOME/Desktop/AutoLoop-Review/Archive
export AUTOLOOP_EXECUTION_REVIEW_SURFACE=$HOME/Desktop/AutoLoop-Review/Latest
export AUTOLOOP_EXECUTION_REVIEW_ARCHIVE=$HOME/Desktop/AutoLoop-Review/Latest/archive

# The pinned agent runtime
export AUTOLOOP_PI_RUNTIME_PATH=/Users/you/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

Behaviour this faithfully reproduces:

| Previously hardcoded | Now | Gate preserved |
|---|---|---|
| evidence root on your volume | `AUTOLOOP_EVIDENCE_ROOT` | mount UUID + shadow-mount refusal via `AUTOLOOP_EVIDENCE_MOUNT*` |
| Colima home on your volume | `COLIMA_HOME` | volume UUID + shadow-mount refusal via `AUTOLOOP_COLIMA_MOUNT*` |
| profile locks beside the profiles | derived from `COLIMA_HOME` | same |
| learning storage prefix | `AUTOLOOP_LEARNING_ROOT` | same namespace-boundary refusal |
| scratch for fixtures | `AUTOLOOP_SCRATCH_ROOT` | same |
| the `pi` install path | `AUTOLOOP_PI_RUNTIME_PATH` | same digest pinning |
| review surfaces under `~/Desktop` | the four review vars | same |
| `/opt/homebrew/bin/{colima,docker}` | `PATH` discovery, or `AUTOLOOP_COLIMA_BIN` / `AUTOLOOP_DOCKER_BIN` | same |

**Two behaviour changes are deliberate**, because the old form was a defect
rather than a policy:

1. **`COLIMA_HOME` is required for sandbox work.** It used to be a hardcoded
   path that had to match exactly; now it must be *set*, and a relative or
   `$HOME`-rooted value is still refused. An unset value is a fail-closed HOLD,
   as before.
2. **`$HOME` itself is no longer rejected as a *namespace*.** The old rule
   refused any path under `$HOME`; the new rule refuses `$HOME` itself and any
   `$HOME` path outside `AUTOLOOP_HOME`. That is what makes the portable
   default (`~/.autoloop/...`) possible. A deployment that wants the strict
   form keeps it by configuring roots outside `$HOME`, as above.

Both are covered by tests, and the deployment above reproduces every remaining
gate.

---

## ADVANCED

### Evolution

| Variable | Purpose |
|---|---|
| `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG` | Path to a production declaration declaring the deployment's evolution inputs (`storeRoot`, `checkpointRoot`, `repoRoot`, `taskClass`, `strategyBaselineValues`, `strategyDimensions`, `reviewerIdentity`). Without a resolvable declaration, evolution refuses to run. |
| `AUTOLOOP_EVOLUTION_STORE_ROOT` | Evolution store root (policy, candidates, reviews, canary state). |
| `AUTOLOOP_EVOLUTION_REPO_ROOT` | Repository the evolution loop may propose changes against. |
| `AUTOLOOP_EVOLUTION_CHECKPOINT_ROOT` | Checkpoint root used when evaluating candidates in isolation. |
| `AUTOLOOP_EVOLUTION_TASK_CLASS` | Task class attributed to runs, used for the performance-memory key. |
| `AUTOLOOP_EVOLUTION_STRATEGY_DIMENSIONS` | Declared strategy dimensions a policy may propose changes to. |
| `AUTOLOOP_EVOLUTION_STRATEGY_BASELINE_VALUES` | Baseline values used for fitness comparison. |
| `AUTOLOOP_EVOLUTION_REVIEWER` | Reviewer identity used for evolution review. |

An evolution policy is issued, read and inspected with the operator CLIs:

```bash
node scripts/evolution-declare-production.mjs --out <path> --store-root … --checkpoint-root … --repo-root …
node scripts/evolution-issue-policy.mjs --store <dir> [--successor [--previous-digest <64hex>]]
      [--scope <glob> ...] [--strategy-dimensions <DIM,...>] [--json]
node scripts/evolution-operator.mjs [--store <dir>] [--json]
node scripts/evolution-kill-switch.mjs --store <dir> --suspend|--resume|--status
```

### Governance workflow

The governance CLIs take their run identity, card identity and output paths as
explicit arguments (`--run`, `--card`, `--out`, `--repo`). There is no hidden
ambient run selection: an omitted required argument is a usage error, not a
fallback to "the latest run".

### Provider binding (advanced, by name only)

A task declares its provider binding explicitly; AutoLoop does not read ambient
provider configuration implicitly. Depending on the binding you choose, the
provider credential is supplied through the agent runtime's own auth store, or
through an environment variable you export yourself. Common names seen in
configurations:

`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`MISTRAL_API_KEY`, `MERGE_GATEWAY_API_KEY`, and the AWS credential chain for
Bedrock.

AutoLoop never writes, logs or persists these values. It does not require any
particular one to exist — only the one your binding names.

---

## TEST_ONLY

These exist so the test suite can isolate itself. Do not use them in
production.

| Variable | Purpose |
|---|---|
| `AUTOLOOP_TEST_PROFILES` | Restricts mutation to named Colima profiles during sandbox tests. |
| `AUTOLOOP_TELEMETRY_STATE_ROOT` | Pins a test run's telemetry store to a temp directory. |
| `AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT` | Pins the profile lock directory during tests. |
| `E2_REPO_ROOT`, `E3_REPO_ROOT` | Repo root injection for the E2/E3 reboot/lease-outage fixtures. |
| `ALLOW_REAL_PI_SMOKE` | Set to `1` to permit the one-shot real-agent RPC smoke test. Without it the test skips, so an accidental glob can never trigger a real provider call. |
| `BENCH_ROUTE` | Pins the provider route for every benchmark arm (see [benchmarks/README.md](../benchmarks/README.md)). |
| `AUTOLOOP_C3_RESULTS_DIR` | Output directory for the Colima task runner's results (default: `<AUTOLOOP_HOME>/review/governance/c3-results`). |
| `AUTOLOOP_REPO_ROOT` | Overrides the repository root the interactive launcher (`scripts/pi-autoloop.sh`) enters. |
| `AUTOLOOP_PI_EXTENSION_DIR` | Installed directory of the search-scope-governor Pi extension. Setting it enables the deployment check that the installed copy still matches the source-of-record; unset means that check is skipped (a repo suite must not depend on a machine-local installation). |

Test suites must write to the OS temp directory. If you find a stray
`file:`, `learning-incidents*`, or `transfer-metrics-core*` directory inside
the checkout, that is a bug in a suite, not something to commit — the
`.gitignore` lists them so it cannot be committed by accident.

---

## Validation behaviour you can rely on

| Situation | Result |
|---|---|
| Relative path in any `*_ROOT` variable | error (`*_NOT_ABSOLUTE`), no fallback |
| `$HOME` itself as a state root | error (`AUTOLOOP_ROOT_IS_HOME`) |
| A path inside `$HOME` but outside `AUTOLOOP_HOME` | error (`AUTOLOOP_ROOT_IN_HOME_NAMESPACE`) |
| A telemetry root inside the evidence root | error (`AUTOLOOP_TELEMETRY_INSIDE_EVIDENCE`) |
| `COLIMA_HOME` unset when sandbox work is requested | HOLD `COLIMA_HOME_NOT_CANONICAL` |
| `COLIMA_HOME` under `$HOME` | HOLD `COLIMA_HOME_NOT_CANONICAL` |
| Configured mount UUID mismatch | HOLD `COLIMA_MOUNT_IDENTITY_FAILED` |
| Shadow mount of the configured volume present | HOLD `COLIMA_SHADOW_MOUNT` |
| Only one of the evidence mount pair set | error (partial gate) |
| `pi` not found when tool selection runs | `TOOL_SELECTION_CONTRACT_MISSING` |

Every one of these is a refusal, never a substitute path. If AutoLoop cannot
run under your configuration it says so and stops.
