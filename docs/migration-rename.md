# Migration note — AutoLoop was renamed to AegisFlow

AutoLoop was renamed to **AegisFlow**. The product positioning is now:

> **AegisFlow — a governed execution layer for autonomous agents.**

The rename is a *branding* change. It is deliberately not a protocol, schema or
state change, and it requires **no migration on your side**.

| What changed | What did **not** change |
|---|---|
| the project name, README, public docs, examples, benchmark descriptions | persisted `autoloop.*` schema identifiers |
| the repository name (`xonogesrs/autoloop` → `xonogesrs/aegisflow`) | the `~/.autoloop` state namespace and its default subdirectories |
| the public CLI file names (`scripts/aegisflow-operator.mjs`, `scripts/pi-aegisflow.sh`) | the durable state, telemetry, evolution and evidence formats |
| the documented configuration variable prefix (`AEGISFLOW_*`) | commit trailer keys (`AutoLoop-Card:` / `AutoLoop-Run:` / `AutoLoop-Milestone:`) |
| the primary environment-variable name | Colima profile names, git ref namespaces, container labels |

## Environment variables

`AEGISFLOW_*` is now the primary name. The pre-rename `AUTOLOOP_*` name is still
resolved, so an existing deployment keeps working without editing a single
shell profile:

| Deployment exports | Result |
|---|---|
| `AUTOLOOP_HOME=/srv/state` only | honored — resolved exactly as before |
| `AEGISFLOW_HOME=/srv/state` only | honored |
| both, same value | honored |
| both, different values | **`AEGISFLOW_HOME` wins**; the legacy value is ignored, never merged |
| a blank value in either | treated as unset, so an inherited empty variable cannot shadow a real one |

Precedence is explicit, deterministic and covered by
`test/test-env-compatibility.mjs`.

Every variable follows the same rule — `AUTOLOOP_HOME`, `AUTOLOOP_EVIDENCE_ROOT`,
`AUTOLOOP_TELEMETRY_ROOT`, `AUTOLOOP_LEARNING_ROOT`, `AUTOLOOP_SCRATCH_ROOT`,
`AUTOLOOP_MEMORY_STATE_ROOT`, `AUTOLOOP_REVIEW_*`, `AUTOLOOP_EXECUTION_REVIEW_*`,
`AUTOLOOP_PI_*`, `AUTOLOOP_COLIMA_*`, `AUTOLOOP_DOCKER_BIN`, `AUTOLOOP_EVOLUTION_*`,
`AUTOLOOP_WORKTREE_*`, `AUTOLOOP_EVIDENCE_MOUNT*`, `AUTOLOOP_TELEMETRY_STATE_ROOT`,
`AUTOLOOP_C3_RESULTS_DIR`, `AUTOLOOP_REPO_ROOT`, `AUTOLOOP_SRC`. The full table is
in [configuration.md](configuration.md).

`COLIMA_HOME` was never `AUTOLOOP_`-prefixed and is unchanged.

## Command names

The renamed entrypoints keep a forwarding alias, so existing runbooks,
automation and shell history continue to work:

| Pre-rename | Now | Alias |
|---|---|---|
| `scripts/autoloop-operator.mjs` | `scripts/aegisflow-operator.mjs` | `scripts/autoloop-operator.mjs` forwards |
| `scripts/pi-autoloop.sh` | `scripts/pi-aegisflow.sh` | `scripts/pi-autoloop.sh` forwards |
| `npm run pi:autoloop` | `npm run pi:aegisflow` | `npm run pi:autoloop` still defined |
| `npm run operator` | `npm run operator` (**now** the AegisFlow entrypoint) | `npm run autoloop:operator` for the alias |
| `AUTOLOOP_REPO_ROOT` | `AEGISFLOW_REPO_ROOT` | legacy honored |
| `AUTOLOOP_WORKTREE_*` | `AEGISFLOW_WORKTREE_*` | legacy honored |
| `AUTOLOOP_REPO_<PROJECT>` | `AEGISFLOW_REPO_<PROJECT>` | legacy honored |

## Persisted identity is frozen

Branding never rewrites identity. These stay exactly as they were, because
changing any of them would invalidate state that already exists on disk or in
git:

- **Schema and journal identifiers** — `autoloop.telemetry-store/v1`,
  `autoloop.task-admission/v1`, `autoloop.implementation-evidence/v1`, and every
  other `autoloop.*` schema id, plus the `$id` / `const` values inside
  `src/schema/*.schema.json`.
- **The state namespace** — `~/.autoloop`, `evidence/autoloop`,
  `evidence/autoloop-telemetry`, `review/*`, `learning/*`, `colima-locks/*`.
  `AUTOLOOP_HOME` (and therefore `AEGISFLOW_HOME`) still defaults to
  `~/.autoloop`, so an existing store is found where it already is.
- **Durable format** — checkpoint and chain identifiers, the
  `autoloop_format_version` field, and the hash-domain seeds used to derive
  checkpoint ids, writer ids and evidence integrity digests.
- **Git identity** — the `refs/autoloop/candidates/` retention namespace and the
  `AutoLoop-Card:` / `AutoLoop-Run:` / `AutoLoop-Milestone:` commit trailer keys
  that already exist in history.
- **Machine identity** — the four Colima profile names (`autoloop-graph`,
  `autoloop-c3`, `autoloop-w1`, `autoloop-w2`), the `autoloop-locks` lock
  directory, the `autoloop.card=…` container label, and the operator's
  `~/Desktop/AutoLoop-Review` surface.
- **Historical records** — committed benchmark results, frozen governance
  contracts and past commit messages keep the name that was correct when they
  were written. Git history was not rewritten. The benchmark **arm names**
  (`AUTOLOOP_FRESH`, `AUTOLOOP_LEARNED`) are also unchanged: they are CLI
  arguments, the names of the committed raw result files under
  `benchmarks/results/`, and the join key of every published number.

## Repository rename (GitHub)

The repository moved from `xonogesrs/autoloop` to `xonogesrs/aegisflow`.

GitHub keeps the old location working:

- **web** — an old repository URL redirects to the new one;
- **git over HTTPS/SSH** — `git clone`/`fetch`/`push` against the old URL keeps
  working (the redirect is served at the transport level), and a fetch reports
  the new canonical URL;
- **API** — requests to the old owner/name redirect to the new one.

Two things do **not** carry over, so update them if you have them:

1. **A local clone's `origin` URL is not rewritten for you.** Git keeps fetching
   through the redirect, but `git remote -v` will keep printing the old name
   until you run:
   ```bash
   git remote set-url origin git@github.com:xonogesrs/aegisflow.git
   ```
2. **A GitHub Actions `uses: xonogesrs/autoloop@...` reference** in a workflow of
   another repository is redirected, but the safer form is to point it at the
   new name.

What the rename does **not** change: the default branch (`main`), the commit
history, issues, pull requests, releases, or visibility. Nothing is force-pushed
and no history is rewritten — the commit that was `HEAD` before the rename is
still `HEAD` after it.

## What this means for you

Nothing. Do not delete durable state, rebuild telemetry, re-pair anything, clear
evolution memory or rebuild the evidence store. Point the tool at the same
configuration you already had and it reads the same state it already wrote.

If you want the new names, export the `AEGISFLOW_*` equivalents and unset the
legacy ones whenever you like — there is no cutover step and no window during
which both spellings disagree about anything.

### One boundary: an in-flight durable run and a repointed `origin`

Everything above concerns configuration and branding, which the rename handles
for you. There is exactly **one** thing the rename cannot decide for you,
because it is a genuine repository-identity change and the harness is designed
to notice exactly that.

A durable run freezes the repository fingerprint at admission, and resume
compares it field by field — including `origin_url`
(`src/c2d/fingerprint.mjs` → `src/v2/durable-execution.mjs`,
`RESUME_FINGERPRINT_MISMATCH`). If you run `git remote set-url origin …` **while
a durable run is still in flight**, resuming that run fails closed:

```
HOLD / RESUME_FINGERPRINT_MISMATCH: repository fingerprint mismatch: origin_url
```

That is the fence working: "the repository changed underneath this run" is
precisely what it exists to refuse, and it cannot distinguish "renamed" from
"a different repository" without trusting the network.

Your options, all of which preserve the gate:

- Finish (or abandon) in-flight durable runs before repointing `origin`; or
- Restore the pre-rename URL (`git remote set-url origin <old-url>`) for the
  duration of the resume — GitHub serves it by redirect, so it still works; or
- Resume in a worktree whose `origin` still names the old URL.

**No state is deleted, migrated or rebuilt in any of these paths**, a completed
run is never re-examined, and runs started after the rename freeze the new URL
and resume normally. Only the exact-string `origin_url` comparison is affected —
`repository_root_identity`, `worktree_identity`, `git_common_dir_identity`,
`expected_head` and `expected_ref` are unchanged by the rename.
