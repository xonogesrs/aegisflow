# AutoLoop — operative instructions for the agent runtime

This file is auto-discovered by Pi (AGENTS.md/CLAUDE.md discovery) whenever a
session's working directory is this repository. It exists to close a real
incident: a fresh interactive session that does not know where the repo lives
will try to discover it by searching outward from wherever it was launched,
which turns into an unbounded scan of the real filesystem (observed: an 896s
whole-home `grep`/`find` pair, no progress).

## Where you are

This is the AutoLoop repository. Its location is whatever directory this file
was loaded from — derive it, do not search for it:

```
git rev-parse --show-toplevel
```

If a task mentions AutoLoop and you are not already in this repository, `cd`
to the path given by the task. You should never need to *search* for this
repository's location.

The supported interactive entrypoint derives it for you:

```
bash scripts/pi-autoloop.sh        # or: npm run pi:autoloop
```

It does two things a bare `pi` invocation does not: it `cd`s into this
repository before the agent starts (so AGENTS.md discovery loads these
instructions with no manual trust step) and passes `--approve` (project-local
trust for the run). The launcher resolves its own location, so it works from
any clone; `AUTOLOOP_REPO_ROOT` overrides it explicitly.

A bare `pi` launched at an arbitrary cwd is NOT a supported AutoLoop
entrypoint — outside this repository the agent discovers none of these
instructions. This is launcher-contract enforcement for the supported
entrypoint, not OS-wide `pi` prevention.

## AUTHORITATIVE_SOURCE_FIRST (mandatory)

When you need to know AutoLoop state, read the structured authoritative source
directly. Do not answer a state question by grepping the filesystem for a
status string.

- **"What's the latest formal execution's review?"** (the human-facing
  entrypoint for a just-finished execution) → read
  `<review surface>/Latest/review.txt` directly; previous reviews rotate into
  `<review surface>/Latest/archive/`. Structured answer:
  `node scripts/gov-execution-review.mjs --status`. Contract:
  `src/governance/execution-review.mjs`.
- **"Is a card awaiting external review?"** (a DIFFERENT question — the
  unresolved external review awaiting a verdict) → `currentSurfaceReviewStatus()`
  in `src/governance/review-bundle.mjs`; the inbox is
  `<review archive>/Current/delivery.json` (env: `AUTOLOOP_REVIEW_SURFACE`).
  A pending inbox occupant never blocks the latest execution review, and vice
  versa.
- **"What's a card's closeout state / requiresReview / evidence?"** → `readCloseoutState()`
  in `src/governance/closeout-state.mjs` against that card's own `outDir`.
- **"What did a graph run actually do?"** (status, phases, rollover
  transitions, provider usage, diagnostics) →
  `node scripts/autoloop-operator.mjs --run <graphRunId> [--json]`. READ ONLY /
  advisory — zero writes, no production authority consumes its output; safe
  against active, completed, partially retained, telemetry-disabled, and
  unknown runs. Contract: `src/telemetry/operator-report.mjs`.
- **"What has the autonomous evolution loop done?"** (policy + generation
  history, circuit breaker, triggers, candidates, reviews, canary, rollbacks,
  active strategy policy, strategy performance memory, the every-run
  attribution feed and its failures, resolved production declaration) →
  `node scripts/evolution-operator.mjs [--store <dir>] [--json]`. READ ONLY /
  advisory — zero writes. Contract: `src/evolution/operator-view.mjs`.
- **Kill switch**: `node scripts/evolution-kill-switch.mjs --store <dir>
  --suspend|--resume|--status` (`AUTO_EVOLUTION = ENABLED | SUSPENDED`;
  SUSPENDED blocks new evolution cycles only — normal operation, telemetry and
  in-flight execution are untouched).
- **Policy issuance** (an operator act — no component may issue its own):
  `node scripts/evolution-issue-policy.mjs --store <dir>
  [--successor [--previous-digest <64hex>]]`. The outgoing generation is
  archived durably under `<store>/evolution-policy-history/`.
- **Deployment declaration**: a deployment declares its evolution inputs
  (storeRoot / checkpointRoot / repoRoot / taskClass / strategyBaselineValues)
  through `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`; the record's shape is
  `src/evolution/production-declaration.mjs`, authored with
  `node scripts/evolution-declare-production.mjs --out <path> --store-root …
  --checkpoint-root … --repo-root …`.
- **Anything else structured** (admission, budget, evidence manifests) has an
  equivalent module under `src/governance/`, `src/admission/`, `src/budget/`,
  or `src/evolution/` — read the module; do not grep for its output.

The every-run attribution feed (`src/evolution/attribution-feed.mjs`) writes
each eligible run into the strategy memory independently of whether a trigger
fires.

## Verification scope (hard rule)

Never construct or run a command whose search root is `/`, `~`, `$HOME`, `/Users`,
or `/Volumes` — including a dynamically-resolved path (a `../..` chain, or `cd`
with no argument) that lands there. Bound every verification command's root to
this repository (derive it with `git rev-parse --show-toplevel`) or a path a
task explicitly names.

If the evidence you need is not reachable from an authorized bounded root —
including "I don't know where the relevant file/repo/state lives" — stop and
report **HOLD / VERIFICATION_SCOPE_UNBOUNDED**. Do not widen the search root on
your own initiative. Ask, or say so, instead of scanning outward.

The code implementing this contract:
`src/governance/verification-scope-guard.mjs` (`checkVerificationRoot` /
`assertVerificationRoot`). This file is the equivalent instruction for an
interactive session, which is not invoked through that code path.

## Search policy

Recursive search is a **normal, supported capability** when bounded.

ALLOWED: `rg pattern .` / `grep -R pattern src` / `find test ...` with a
statically-concrete root inside an authorized scope (this repo, a known
source/test directory, or a path a task explicitly names), plus the structured
`grep` / `find` tools with an explicit eligible path.

GOVERNED (not prohibited): forbidden or oversized roots (`/`, `~`, `$HOME`,
`/Users`, `/Volumes`, broad collections), roots that are not statically
concrete (`~user`, `$VAR`, `$(...)`, globs), and recursive search hidden behind
unresolved execution structure — these are REJECT/RESTATE, not banned
capability. Eligible recursive searches remain subject to default timeout,
output limits, and failed-strategy → REPLAN escalation.

The rule is **scope + resources + retry**, never "avoid recursion".

## Durable worktrees (storage policy)

A worktree that must outlive a single command (task state, card
implementation, anything you expect to return to) is DURABLE. Create durable
worktrees only via:

```
scripts/durable-worktree.sh autoloop <card-id> [base-ref]
→ $AUTOLOOP_HOME/worktrees/autoloop/<card-id>/
```

The helper fails clearly rather than falling back. Never `git worktree add` a
durable task under `/tmp`, `/private/tmp`, or an arbitrary `~/` path.

Exception: short-lived, self-cleaning, non-authoritative temp worktrees
(`src/c2d/mutation-run.mjs` isolated mutation runs, Colima per-run scratch
roots) are ephemeral and must keep using OS temp — do not route them through
the helper.

## Sandbox single-flight (mandatory)

Colima profiles are machine-level shared state. Serialization is enforced in
code (`src/runtime/colima-profile-lock.mjs`): a graph/pipeline run holds the
profile lock from before `ensureInstance` until terminal cleanup, so a second
mutating or reconciling operation on the same profile fails closed with
`HOLD / COLIMA_PROFILE_BUSY` instead of interleaving stop/start.

- Never run two sandbox operations concurrently.
- Never delete a profile lock file while its owner process is alive.
- While a background job holds a profile, do other independent work — never
  run other Colima commands against that profile.

## Background jobs — never poll (mandatory)

A long command (`async: true`) delivers its result automatically when it
completes, and the completion notice wakes the agent. Therefore:

- **NEVER** issue sleep-only background jobs (`sleep N; pgrep …`, `sleep N &&
  ps …`, any `async` bash whose command is only sleep plus status checks) to
  "check on" another background job. Each poll job is itself a background job
  whose completion fires a notification — a queue of stale echoes arrives after
  the real result was already handled.
- The harness blocks such calls. If blocked, do not rephrase into an equivalent
  poll — wait for the job's own completion notice instead. The block covers any
  command whose parts are only sleeps, pure status checks, and pure output
  filters (grep/awk/sort pipelines included).
- While a background job runs, do other independent work. If nothing remains,
  yield; the notification resumes you.
- A bounded wait INSIDE one call is fine: a single foreground `sleep N`, or one
  `for`/`while` loop that sleeps and does real work — one job, one
  notification.

## Repository discipline

- **No machine-local absolute path in `src/` or `scripts/`.** Portability is
  enforced: a fresh clone must work with zero configuration. Paths resolve
  through `src/shared/autoloop-paths.mjs` (config + portable default). If you
  need a root, read it from that module rather than hardcoding one.
- **Never commit a credential.** Not in code, tests, fixtures, examples, docs,
  or commit messages. Use an obviously synthetic sentinel in tests.
- **Never commit generated state.** Evidence under a checkout, telemetry,
  scratch and lock files are machine-local; `.gitignore` covers the known
  shapes. If a suite created such a file in the checkout, that is a bug to fix,
  not a file to commit.
- **Tests must run in parallel and touch no shared state.** Use the OS temp
  directory. `npm test` is the host-only suite; sandbox and real-agent suites
  are separate (`npm run test:colima`, `npm run test:pi`).

See [CONTRIBUTING.md](CONTRIBUTING.md) for the design rules a change is
reviewed against, and [docs/architecture.md](docs/architecture.md) for the
authority map.
