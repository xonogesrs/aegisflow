# P0-RS1 Controller Synthesis

## Baseline and scope

- Repository: `/Volumes/NVM2T/Development/autoloop`
- Branch: `governance/reversible-lifecycle-draft-pr`
- HEAD: `2e897e995202c0c8c079c5fdc96b9f5d42d50d25`
- Dirty baseline before this card: 17 tracked + 366 untracked = 383 entries.
- Review surfaces: `/Users/zhengfengqing/Desktop/AutoLoop-Review/Current` and `Archive` only.
- Six parallel lanes completed. All lanes read-only; no tests, lifecycle, bundle, commit, push, or destructive experiment ran.
- Card scope only: `scratchRoot` recursive deletion. Prior checkpoint P1 findings remain out of scope.

## Disposition gate

`A — CONFIRMED_REACHABLE`

Unsafe caller-controlled recursive deletion is reachable through current production execution.

Evidence:

- `src/admission/admission-gate.mjs:120-139,192-199,202-210` selects production Colima/subagent/durable runners and forwards runner options, including `scratchRoot`, after admission.
- `src/runtime/colima-graph-runner.mjs:168-169` checks only truthiness of `repoPath`/`scratchRoot`.
- `src/runtime/colima-graph-runner.mjs:252` mounts caller-supplied `scratchRoot` as writable Colima storage.
- `src/runtime/colima-graph-runner.mjs:342,352-355` creates worktree and phase scratch descendants under that root.
- `src/runtime/colima-graph-runner.mjs:556` executes `rmSync(scratchRoot, { recursive: true, force: true })` on the exact caller-supplied root.
- `src/runtime/colima-runtime.mjs:111-123,269-271` has mount/root helpers, but graph deletion does not establish an ownership marker or strict deletion target before `rmSync`.
- `scripts/c3-colima-task.mjs:38,56` accepts operational `--scratch`; raw subagent/self-closeout paths also pass scratch roots. Production reachability is not limited to fixtures.

## Call graph

```text
admission record
  -> runAdmittedGraph
     -> runColimaGraph / runSubagentGraph / runDurableGraph
        -> runColimaGraph
           -> ensureInstance(... rwMounts: [scratchRoot])
           -> prepareWorktree / phase scratch descendants
           -> rmSync(scratchRoot, recursive: true, force: true)
```

Durable/resume paths also use `scratchRoot/<durableExecutionId>/results` (`src/subagent/subagent-graph-runner.mjs:165,316`; `src/v2/durable-graph.mjs:810,1156`). This is legitimate state that must survive resume until its owning execution completes. Ownership cannot be defined by creator process or PID.

## Current contract result

No authoritative deletion contract exists. Current code allows:

- repo root or home-like root if truthy;
- filesystem root if caller can pass it;
- ancestor or sibling-containing directories;
- relative paths and `..` subject to process cwd/path resolution;
- symlink/reparse-point ambiguity because graph deletion does not canonicalize or reject symlinks;
- arbitrary external paths;
- non-existent paths, which `force:true` silently accepts.

Existing `assertMountAllowlist` checks writable mount strings against `scratchRoot`, but it does not prove that `scratchRoot` itself is AutoLoop-owned, nor does it protect recursive deletion. Existing graph/C3 tests prove normal cleanup and cancellation/failure cleanup only; no destructive-boundary negative matrix exists.

## Required ownership contract for Phase B

1. Caller input is a scratch namespace/parent, never a recursive deletion target.
2. AutoLoop derives one per-execution owned directory beneath that namespace using a validated execution identity.
3. AutoLoop may recursively delete only that exact derived directory, and only after verifying ownership metadata and containment.
4. Root, ancestor, repository/worktree, sibling, external, empty, missing, traversal, and symlink-escaped targets fail closed. Missing owned target is an idempotent no-op only after ownership/containment validation.
5. Durable resume reuses same execution-owned directory and preserves `results` subdirectory until durable truth permits cleanup.
6. Custom scratch location remains valid as namespace location; ownership follows durable execution, not process identity.

Descriptor-relative/no-follow deletion is required if implementation uses a path that can be concurrently replaced. String-prefix checks alone are insufficient.

## Compatibility gate

Likely compatible:

- Colima writable mounts can point at derived execution-owned directory.
- Worktrees and phase scratch remain descendants.
- Durable resume can deterministically derive same directory from stable durable execution ID.
- Existing test fixtures can use isolated temporary namespace and sentinel files.

Needs proof in Phase B/verification:

- exact stable ID used by fresh-process resume;
- results preservation during resume and final cleanup;
- C3 custom `--scratch` behavior;
- symlink and ancestor rejection without touching real repo/user paths.

## Authorization

Phase B minimal repair is authorized. Exactly one Writer may modify source/tests. No unrelated P1 work. Independent verifier/reviewer must inspect Writer diff and run only isolated focused verification plus bounded regression.

## Phase B — single-writer repair result

Repair completed by Controller only. Changed P0 surfaces:

- `src/runtime/scratch-ownership.mjs`
- `src/runtime/colima-graph-runner.mjs`
- `src/v2/durable-graph.mjs`
- `src/subagent/subagent-graph-runner.mjs`
- `test/test-scratch-ownership.mjs`
- `test/v2/test-durable-subagent-resume.mjs`

Authoritative contract now:

1. Caller `scratchRoot` is namespace only. AutoLoop derives `.autoloop-owned/<execution-key>` from execution identity + repository binding.
2. Recursive wipe/delete APIs require namespace, execution ID, repository path, and authority token. They derive target internally; caller cannot supply destructive child path directly.
3. Owned child has canonical path, schema/owner/UID marker, exact namespace/repository/execution bindings, and authority digest. Durable run stores authority token in 0700/0600 durable evidence; fresh resume must re-present it.
4. Admission rejects empty/relative/`..`/filesystem-root/repository/worktree/symlinked-ancestor targets. Missing namespace may be created; missing unsafe namespace under repository is rejected before creation.
5. Resume binds repository and scratch namespace into durable input fingerprint. Durable child creation occurs after DAG checkpoint; pre-checkpoint crash cannot leave recursively-deletable child. `results` remains preserved and `./results` normalizes safely.
6. Symlink descendants are removed as links, never followed; preserved symlink paths fail closed. External sentinel fixtures remain intact.

## Phase C — verification

Passed:

- `npm run check`
- `node --test test/test-scratch-ownership.mjs` — 6/6
- `node --test --test-concurrency=1 test/v2/test-durable-subagent-resume.mjs` — 4/4
- focused non-Colima durable tests — 9/9
- `node --test test/test-colima-runtime.mjs` — 5/5

Not run: `test:colima-all`, real Colima lifecycle, destructive tests against repository/user paths, commit/push/bundle/seal. This matches card safety and parallel-lane restrictions. Focused production-entry test rejects repository scratch before runtime mount.

Independent second-pass reviewer: `PASS`. Reviewer accepted authority token as trusted durable evidence and classified descriptor-relative/no-follow deletion as future broad redesign, not current P0 blocker. Residual is recorded, not hidden.

## Dirty-tree attribution

The three main runner files were pre-existing untracked source paths at card start. Controller changed only listed P0 call sites; unrelated dirty/untracked paths remain untouched. No general cleanup performed. No commit or push.

## Final verdict

`PASS / P0_SCRATCHROOT_DELETION_BOUNDARY_REPAIRED_AND_VERIFIED`
