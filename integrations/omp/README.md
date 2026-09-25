# OMP integration (optional)

This directory publishes the **optional** OMP integration: a single agent-host
extension that makes a governed agent's *background waits* and *task
termination* behaviour safe. It is a separate artifact from AegisFlow core —
see [Core feature vs. integration feature](#core-feature-vs-integration-feature)
before assuming anything here applies to AegisFlow itself.

- **Target**: OMP (`@oh-my-pi/pi-coding-agent`), the Oh My Pi coding agent.
- **Source of truth**: the bytes in this directory. `scripts/install-omp-integration.mjs`
  copies them into the agent's extension directory.
- **Deployed layout** (the host discovers top-level `*.js` / `*.ts` files):

```
~/.omp/agent/extensions/
  no-poll-waits.js                          <- the only module the host loads
  lib/poll-wait-policy.js                   <- pure policy, imported by it
  test/poll-wait-policy.test.mjs            <- policy self-test (plain node)
  test/waiter-fence.acceptance.ts           <- lifecycle acceptance (bun)
  test/terminal-fence-authority.acceptance.ts <- authority acceptance (bun)
```

`lib/` and `test/` are deliberately **not** load candidates: they have no
`index.js`, no `index.ts` and no `package.json`, so extension discovery resolves
exactly one module. `scripts/install-omp-integration.mjs` refuses any source
layout that would change that, rather than reason about the consequence.

---

## Why this exists

Two failures were measured on a real governed run, both at the same seam (OMP's
`tool_call` / `agent_end` extension hooks):

**1. Background-waiter fan-out.** An agent that waits by polling —
`sleep 600; date; pgrep -f runner; echo "(empty=done)"` — issues commands that do
no work. Each one outlives OMP's `bash.autoBackground.thresholdMs` (60 s) and is
converted into a real background job *after* the hook has already run. Every job
delivers its own completion, so N polls become N late wakes, and those deliveries
can re-enter the transcript and re-invoke the agent after the task has already
gone terminal. The previous guard only looked at `input.async === true`, so a
`sleep` sent with `async` **unset** walked straight through it — that is the
bypass this integration closes.

**2. Pre-terminal self-fence.** The first repair gave the *agent* a tool that
could commit a terminal fence. A governed model then used it to declare its own
run terminal while the task was still active, suppressing deliveries the active
task was entitled to. Terminal authority was on the wrong side of the boundary.
The second repair moved the commit primitive to the controller and made the
denial mechanical rather than advisory.

---

## What is deployed

Deployed behaviour, all of it exercised by the harnesses in
`extensions/test/`:

| Behaviour | Mechanism |
|---|---|
| Semantic poll/wait classification | `classifyBashWait()` parses the command into segments and loop bodies; a command is poll-only when *every* segment merely sleeps or observes state |
| async-unset auto-background bypass protection | `decideBashWait()` refuses poll-only commands **before** OMP can promote them to a job, which is why the hook must act here and not after |
| Loop / `date` / status-wrapper protection | `for`/`while`/`until` bodies are extracted and classified recursively; `date`, `ps`, `pgrep`, `git status`, pipes to filters are all observations |
| Bounded-foreground clamp | An admitted short poll gets its timeout clamped under the auto-background threshold, so it cannot drift into a job mid-flight |
| Generation-bound waiter handling | Each background job is bound to the run generation that created it (`tool_result` → job id) |
| Post-terminal stale-delivery suppression | Fencing a generation acknowledges every bound job's pending delivery, closing both the queued path and the already-enqueued path |
| Terminal fence authority separation | The commit primitive is reachable only from the host prompt-command channel, gated by the controller capability |
| Agent self-fence denial | No tool in the agent's vocabulary can commit a fence; the legacy name is refused at the hook, fail closed |
| Trusted controller commit path | `/fence-generation <PASS\|HOLD\|FAIL\|CANCELLED> [reason]` on the host channel, with `OMP_TERMINAL_FENCE_AUTHORITY` set |
| Active / new-generation delivery preservation | Fencing invalidates *only* the fenced generation; the session advances and the next task's deliveries are untouched |

Real work that merely contains a legitimate sleep (`for i in 1 2 3; do sleep 30;
npm test; done`) is never poll-only and is always admitted with its timeout
untouched.

---

## Terminal fence authority

The boundary is the point of the integration:

```
governed Agent                  trusted controller / orchestrator
──────────────                  ────────────────────────────────
request_terminal_fence(…)  ──▶  /fence-generation <STATUS> [reason]
  records a REQUEST               commits the fence
  always reports committed:false  invalidates the generation's pending deliveries
  suppresses nothing              requires OMP_TERMINAL_FENCE_AUTHORITY
```

- **An agent MAY request.** `request_terminal_fence` records the disposition the
  model claims for its own generation. It returns `committed: false` for every
  status — PASS, HOLD, FAIL, CANCELLED — and touches no delivery.
- **An agent MUST NOT commit.** There is no agent-reachable commit tool. The
  hook refuses the legacy tool name `fence_background_waiters` outright, so a
  stale model turn or a third-party extension re-registering that name cannot
  reach the commit primitive.
- **Only the trusted controller commits.** `fenceGeneration()` is reachable from
  the host prompt-command channel — which the governed model cannot dispatch into
  its own session, because commands are resolved from submitted prompt text
  before any agent turn runs — and only while the process carries the
  capability marker.
- **Absent capability ⇒ DENIED, fail closed.** Without
  `OMP_TERMINAL_FENCE_AUTHORITY` the command reports
  `Terminal fence DENIED (CONTROLLER_AUTHORITY_ABSENT)` and the generation stays
  active: pending deliveries keep being delivered. An OMP process nobody is
  governing therefore cannot be fenced at all, which is the safe direction.

`OMP_TERMINAL_FENCE_AUTHORITY` is **not** a capability an agent can obtain. It is
an environment marker that the orchestrator which launched the governed process
sets deliberately. It is not derived from anything the model produces, it is not
readable as a tool, and no prompt text or tool payload grants it. Treat any
suggestion that an agent "has" this authority as a defect report, not a feature.

There is also an automatic leg: a genuinely terminal `agent_end` (settled with no
scheduled continuation) fences the generation, because OMP only settles that way
once no unsuppressed async wake is outstanding. That leg is host-observed
terminality, never an agent declaration.

### Controller contract

```sh
OMP_TERMINAL_FENCE_AUTHORITY=1 omp --mode rpc …   # launch the governed process
# then, on the host channel (RPC prompt frame or an interactive prompt line):
/fence-generation PASS card accepted
```

An orchestrator that never issues the command does not need the marker: the
`agent_end` leg and the wait policy work without it.

---

## Installation

Requires Node.js >= 24. Nothing else: the installer is plain Node with no
dependencies, and it runs before any `npm install`. No daemon, no watcher and no
background state are created by anything in this directory.

```sh
git clone https://github.com/xonogesrs/aegisflow.git
cd aegisflow
node scripts/install-omp-integration.mjs install
```

That writes the five files above into `~/.omp/agent/extensions`, which is where
OMP discovers extensions. Override the destination with `--target <dir>` or
`OMP_EXTENSIONS_DIR`. Other options: `--dry-run`, `--json`, `--source <dir>` (the
extension source tree, for testing), `--backup-root <dir>`.

Equivalent npm scripts:

```sh
npm run omp:install     # node scripts/install-omp-integration.mjs install
npm run omp:check       # drift check (below)
npm run omp:uninstall   # restore the previous deployment
npm run omp:scan        # publication hygiene scan
npm run omp:test        # the acceptance harnesses (needs bun, see Tests)
```

### What the installer guarantees

- **Copies only known files.** The file list is a frozen allowlist in
  `scripts/omp-integration/lib.mjs`. Nothing else is ever copied.
- **Refuses an unexpected source layout.** A missing known file, a symlink, any
  unexpected executable file, or anything OMP's discovery would load in addition
  to `no-poll-waits.js` fails the install with a per-problem message and copies
  nothing.
- **Preserves a conflicting deployment.** A file that is already there and
  differs is copied to `<parent of target>/omp-integration-backups/<timestamp>/`
  byte for byte before it is replaced. The backup root is outside the extension
  directory on purpose: a backup must not be a load candidate.
- **Never reads or copies secrets.** Only the five source files and, at the
  destination, those same five paths are opened. `models.yml`, provider keys and
  API credentials are not read, written, hashed or globbed — the deployment's own
  test asserts this with an unreadable config file next to the target.
- **Never rewrites unrelated extensions.** Files under the extension directory
  that are not in the allowlist are not opened at all.
- **Is idempotent and atomic.** Files that already match are left alone (no
  backup, no timestamp churn); a write goes to a sibling temp file and is renamed
  into place, so a reader never sees a half file.

### Update

Same command. `npm run omp:install` after `git pull` replaces any file whose
bytes changed and reports `INSTALL_RESULT = INSTALLED`, or `UP_TO_DATE` when the
deployment already matches the checkout.

### Uninstall / restore

```sh
node scripts/install-omp-integration.mjs uninstall
```

Each deployed file is restored from the **newest** backup of that file if one
exists, and removed otherwise. Only the five known paths are touched: an
unrelated extension in the same directory stays exactly as it was. To remove the
integration after a fresh install (no backups), this simply deletes the five
files. The last line reports `UNINSTALL_RESULT = RESTORED` when a backup was
used, or `REMOVED` when there was none.

### Drift check

```sh
node scripts/install-omp-integration.mjs check
```

Compares the repository source against the deployed bytes and prints one state
per file:

| State | Meaning |
|---|---|
| `MATCH` | byte-identical |
| `EQUIVALENT` | differs only by a redacted private identifier (see below) |
| `DRIFT` | any other difference |
| `MISSING` | not deployed |

Exit status is `0` when every file is `MATCH` or `EQUIVALENT`, `1` on any
`DRIFT` or `MISSING`, `2` on a usage or source error. `--strict-bytes` makes
`EQUIVALENT` a failure too. `--json` emits the whole report for tooling. There is
no daemon and no scheduled monitoring: run it when you want to know.

#### Why `EQUIVALENT` exists

One comment in `no-poll-waits.js` used to cite the session identifier of the
original incident. A session identifier is private runtime state, so the
published source replaces it with `<session-id-redacted>`; the rest of the file is
byte-identical to what was validated in production. The classifier canonicalises
identifier-shaped strings on both sides and only reports `EQUIVALENT` when the
published side contains **no** identifier of that shape and the deployed side
contains at least one — so an `EQUIVALENT` verdict cannot hide a real edit, and
`--strict-bytes` is available when you want byte identity instead.

---

## Tests

Four layers, all runnable from a clean checkout:

```sh
# 1. host-only repo suite (no agent runtime, no provider, no bun)
node --test test/omp-integration/

# 2. the deployed policy self-test — plain node, no dependencies
node integrations/omp/extensions/test/poll-wait-policy.test.mjs

# 3. the acceptance harnesses — real extension against a real AsyncJobManager
npm install --prefix /tmp/omp-deps @oh-my-pi/pi-coding-agent@17.4.0
OMP_PI_CODING_AGENT_ROOT=/tmp/omp-deps/node_modules/@oh-my-pi/pi-coding-agent \
  node scripts/omp-integration/run-acceptance.mjs

# 4. publication hygiene: no secrets, no private paths, no personal identifiers
node scripts/omp-integration/scan-publication.mjs
```

| Harness | Proves |
|---|---|
| `test/omp-integration/test-omp-wait-policy.mjs` | the classification seam, the async-unset bypass, the threshold clamp, real work untouched |
| `test/omp-integration/test-omp-integration-installer.mjs` | clean install, extension discovery, the deployed self-test, idempotent update, `MATCH`/`EQUIVALENT`/`DRIFT`/`MISSING`, layout refusal, backup + restore, confinement |
| `test/omp-integration/test-omp-publication-hygiene.mjs` | the three publication counts are 0, with a negative control proving the scanner can fail |
| `test/poll-wait-policy.test.mjs` (deployed copy) | 21 classifier cases: the incident's exact waiter shapes, and the real-work shapes that must stay allowed |
| `test/waiter-fence.acceptance.ts` | waiter lifecycle end to end: 8 refused waiters, 6 delayed completions maturing post-terminal with `POST_TERMINAL_AGENT_INVOCATIONS=0`, an un-fenced negative control reproducing 6 wakes, 4 concurrent legitimate jobs all delivered, new generation unaffected |
| `test/terminal-fence-authority.acceptance.ts` | the authority contract: `SELF_FENCE=DENIED`, forged terminal `DENIED` for all four dispositions, `COMMIT_WITHOUT_CAPABILITY=DENIED`, controller commit `PASS`, `AGENT_FENCE_TOOL_EXPOSURE=NONE`, `AGENT_REPORT_TOOL=REQUEST_ONLY`, `REAL_CONCURRENT_WORK=UNAFFECTED` |

Harnesses 3 (the `.ts` files) need `bun` (>= 1.3) and
`@oh-my-pi/pi-coding-agent`, because the package's `./async` export resolves to
TypeScript source. That dependency is deliberately **not** declared in
`package.json`: AegisFlow's host-only suite must stay installable on a machine
that never runs an agent. `scripts/omp-integration/run-acceptance.mjs` resolves
the package from `$OMP_PI_CODING_AGENT_ROOT`, this repo's `node_modules`,
`$HOME/node_modules`, `$HOME/.omp/plugins/node_modules` or the global npm root,
stages the published bytes into a temporary directory, and exits `2` with
`OMP_INTEGRATION_ACCEPTANCE=PREREQUISITE_MISSING` when it cannot find one.

Validated against `@oh-my-pi/pi-coding-agent@17.4.0` and `bun 1.3.14`. The
harnesses are deterministic — no LLM, no timing luck, every completion released
explicitly — but they do reach into the host package's internals, so a future OMP
release may need the harnesses adjusted. That is a harness compatibility
question, not a policy question: the policy self-test (layer 2) has no
dependency beyond Node.

---

## Core feature vs. integration feature

AegisFlow core does not require any of this, and none of it changes AegisFlow's
own behaviour. If you never install the OMP integration:

- AegisFlow still runs: admission, execution, durable checkpointing, review,
  closeout and commit gates are all in `src/` and are unaffected.
- `npm install` and `npm test` still work with no agent runtime and no bun.
- No file in this directory is imported by `src/`, by any script other than the
  tooling entry points listed above, or by any test outside
  `test/omp-integration/`.

| Concern | Lives in | Applies without OMP? |
|---|---|---|
| Admission, budgets, mutation scope, review, closeout, commit gates | AegisFlow core `src/` | yes |
| Durable execution, journal, resume | AegisFlow core `src/` | yes |
| Bounded task termination and active-task cancellation | AegisFlow core `src/` | yes |
| Background-waiter policy, terminal fence, generation binding | **this integration** | no — it is behaviour of the agent host |

The one thing AegisFlow provides *for* the integration is the controller side:
whatever launches a governed OMP process (the pilot, or your own orchestrator)
decides whether to set `OMP_TERMINAL_FENCE_AUTHORITY` and when to commit a fence.

---

## Known limitations

- **OMP-only.** The integration is written against OMP's extension hooks
  (`tool_call`, `tool_result`, `agent_end`), its `registerTool` /
  `registerCommand` surface and its `AsyncJobManager`. Another agent host needs
  its own integration; there is no adapter layer, by design.
- **Host-internals coupling.** The terminal fence reuses OMP's own staleness
  contract (`manager.acknowledgeDeliveries` / `isDeliverySuppressed`). If a future
  OMP release changes that contract, the fence must be re-derived against the new
  source; the acceptance harnesses are what would catch it.
- **One process, one governed session.** Waiter state is in-memory and per
  session; a fence is a runtime decision and is not persisted. Restarting the
  process drops it, which is intentional — a stale persisted fence would be a
  worse failure than a re-delivered completion.
- **The `agent_end` leg is heuristic.** It fences when the session settles with
  no scheduled continuation and no outstanding unsuppressed wake. A host that
  settles differently would need the controller command instead.
- **The timeout clamp applies to bash calls only.** Other tools can still be
  slow; that is out of scope here.
- **macOS/Linux POSIX shells.** The classifier parses POSIX shell syntax. A
  command the classifier cannot parse is treated as *not* poll-only, i.e. it is
  allowed — the failure direction is permissive for real work, and the load-bearing
  protection for the incident's shapes is covered by the tests.

---

## Publication delta

This directory is a publication of a validated deployment, not a rewrite. The
delta between it and the deployed bytes is exactly one thing: the private session
identifier cited in a comment was replaced by `<session-id-redacted>`. Everything
else — including the acceptance harnesses, which are the regressions that pin the
authority contract — is byte-identical. `node scripts/install-omp-integration.mjs
check` reports this as `EQUIVALENT`; `--strict-bytes` reports it as a difference.

No personal paths, credentials, provider keys, `models.yml` content or session
transcripts are published here, and
`node scripts/omp-integration/scan-publication.mjs` is the check that says so
(`REAL_SECRETS=0`, `PRIVATE_PATHS=0`, `PERSONAL_IDENTIFIERS=0`).

One cosmetic artifact is preserved deliberately:
`extensions/test/waiter-fence.acceptance.ts` carries a `// Run under bun …` header
line naming the scratch directory the harness was first written in. It is a
comment, not a path the harness reads — the harness resolves everything relative
to its own location — and the supported invocation is the one below and in
[Tests](#tests). It was left verbatim so the published file stays byte-identical
to the validated deployment, and changing it would turn a `MATCH` into a
misleading `DRIFT`.

## License

Apache-2.0, same as the rest of the repository. See
[`../../LICENSE`](../../LICENSE) and [`../../NOTICE`](../../NOTICE).
