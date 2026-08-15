# RB-SSG2 — Pi Command-Execution Admission Coverage (Root Cause + Repair)

> **SUPERSEDED by RB-SSG4-RC1 + RB-SSG4-FR4.** Historical record of the
> pre-FR4 default-deny governor. Authoritative post-FR4 policy is Bounded
> Search Execution Governance (recursive search allowed when bounded; scope +
> resources + retry are governed). See
> `docs/governance/rb-ssg4-rc1-search-governance-objective-and-enforcement-boundary-reconciliation.md`
> and `docs/governance/rb-ssg4-fr4-bounded-search-execution-foundation.md`.

Status: **RB_SSG2_ROOT_CAUSE_AND_PI_COMMAND_ADMISSION_COVERAGE_REPAIRED**

Prior RB-SSG record: `PASS_WITH_EXECUTION_COVERAGE_GAP → SUPERSEDED_BY_RB-SSG2`.
Commit `4dd04a3` is not reverted; RB-SSG2 supersedes its execution coverage.

## Incident

This Pi session executed, via the `bash` tool with `cwd=/Users/zhengfengqing`:

```text
cd /Users/zhengfengqing && grep -rl "Phase R" .
```

This is an unbounded recursive HOME traversal and should have been rejected by
the RB-SSG search-scope governor. It was not.

## Root cause

The RB-SSG governor (`src/admission/search-scope-governor.mjs`, commit
`4dd04a3`) was wired into **two AutoLoop boundaries only**:

1. `src/subagent/subagent-contract.mjs` — rejects unbounded `authorizedPaths`
   in a subagent envelope (`assertAuthorizedPathsBounded`).
2. `src/subagent/subagent-executor-adapter.mjs` — governs the static
   container-launch script (`buildAgentCommand`) *before* `runTask`.

Neither boundary is on the path a Pi agent uses to execute its own shell
commands. The actual Pi command-execution path is:

```text
Pi command proposal
  → `tool_call` extension event (admission seam — can block)
  → `bash` tool `execute()` (dist/core/tools/bash.js)
  → `resolveSpawnContext()` (spawnHook seam)
  → `createLocalBashOperations().exec()`
  → child_process.spawn()
```

The `bash` tool never calls `governSearch`. Therefore interactive/direct Pi
shell commands (including AutoLoop subagent Pi sessions, which also execute
through the same `bash` tool) bypassed the governor entirely. The coverage gap
is a **wrong-seam** gap, not a missing-rule gap.

## Secondary gap found during verification

Requirement 8 lists `cd /Users/USER && grep -rl pattern .`. `governSearch`
resolved relative roots (`"."`) against the *pre-command* cwd and did not
track `cd`. So `cd $HOME && grep -rl pattern .` executed from a bounded repo
cwd was **ADMITTED** (`.` resolved to the repo, not `$HOME`). This is a real
invariant-B bypass, now closed (see repair).

## Coverage repair implemented

1. **`src/admission/search-scope-governor.mjs`** — added `parseCdCommand` and
   per-chunk cwd tracking in `governSearch`. Sequential `cd` segments now
   update the effective cwd used to resolve relative traversal roots; command
   substitutions inherit their parent segment's cwd (subshell semantics).

2. **`src/admission/pi-command-admission.mjs`** — new bridge `governPiCommand`
   that wraps `governSearch`, defaults `authorizedRoots` to `[cwd]` (the
   session's bounded root), and exposes `spawnAllowed` / `blockReason` for the
   Pi seam. A forbidden cwd (HOME/Desktop/root) is still rejected by the
   forbidden-root invariant before the allowlist.

3. **`pi-extensions/search-scope-governor.ts`** — new Pi extension that wires
   the governor into the actual pre-spawn seams:
   - `tool_call` (bash tool): blocks the call with `{ block: true, terminate: true }`
     before the tool executes (no spawn).
   - `user_bash` (`!` / `!!`): replaces the command with a blocking result
     (no spawn).
   - Fail-closed: if the governor cannot be loaded, recursive-search-looking
     commands are blocked rather than admitted ungoverned. Source path is
     overridable via `AUTOLOOP_SRC`.

4. **`test/admission/test-pi-command-admission.mjs`** — 24 regression tests:
   exact incident, `cd` bypass from a repo cwd, `find .` / `rg` / `grep -r`
   from HOME, `$(...)` / backtick substitution, pipelines, cwd-relative roots,
   narrow repo-root ADMIT, non-search pass-through, a spawn counter proving
   rejected commands never reach spawn, and no cd-state leakage.

5. **`package.json`** — added `test:pi-command-admission` and `test:rb-ssg`.

## Verification

- `npm run test:rb-ssg`: **56/56 pass** (32 original RB-SSG + 24 new).
- Extension smoke test (node type-stripping):
  - `tool_call` incident → `{ block: true, terminate: true, reason: ...UNBOUNDED_HOME_TRAVERSAL... }`
  - `tool_call` `ls -la` → no block; `tool_call` non-bash tool → ignored.
  - `user_bash` incident → blocking result (no spawn); `user_bash` `ls` → pass-through.

## Wiring

Install the extension globally so it covers interactive/direct Pi sessions:

```bash
cp /Volumes/NVM2T/Development/autoloop/pi-extensions/search-scope-governor.ts \
   ~/.pi/agent/extensions/search-scope-governor.ts
# active on next session or after /reload
```

Not committed / pushed / sealed (per execution rules).
