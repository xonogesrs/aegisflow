# Checkpoint 2026-08-09 — Verification Health Audit

## Scope and authority

Audit is read-only and bounded to repository scripts, manifests, existing evidence, and named review surfaces. No expensive suite ran. Repository HEAD: `2e897e995202c0c8c079c5fdc96b9f5d42d50d25`. Six parallel audit lanes returned; Controller covered remaining complexity/roadmap synthesis.

Structured state wins over report prose. Current external state is read from `/Users/zhengfengqing/Desktop/AutoLoop-Review/Current/delivery.json`.

## Verification paths

W1A changed future card verification scripts to six distinct suites:

| Suite | Current script evidence | Timeout cap |
|---|---|---:|
| budget | `test:budget` | 30–40 min, script-dependent |
| admission | `test:admission` | 30–40 min |
| governance | `test:governance` | 30–40 min |
| scripted lifecycle | `test:scripted-lifecycle` | 30–40 min |
| telemetry | `test:telemetry` | 30–40 min |
| v2 | `test:v2` | 30–40 min |

`scripts/ta3-verify.mjs:355-370` shows the six-suite shape and 2,400,000 ms caps. TA2/TA2R use 1,800,000 ms caps. `scripts/rld2-verify.mjs` adds a 600,000 ms stale-delivery negative test timeout and then the six-suite set. `runSuiteSync` uses `execFileSync` with explicitly named millisecond values. Unit ambiguity is low; timeout sizing is broad.

`package.json:test:colima-all` still runs nine runtime/memory files serially. R1/R2 evidence records it as `>420000 ms`, killed mid-suite, total `NOT_INSTRUMENTED`. Individual tests use 600,000 or 900,000 ms process caps. W1A scope-gates this suite out of ordinary non-runtime card verification; that reduces repeat cost but does not make its runtime coverage current.

## Overlap and accounting

Historical TA3 evidence records 915 test results. VCA1 Phase 0/R1/R2 analysis derives 845 distinct results and 70 duplicate results. The duplicated 70 are the `test:review-bundle`, `test:graph-closeout`, and `test:external-review-delivery` subsets counted again inside `test:governance`.

W1A future verification scripts remove those three nested entries. W1A acceptance says 913 distinct tests / zero double count for its future run, but no post-W1A full run regenerated Current TA3 evidence. Current `review-bundle.txt` still reports the old 915/915 accounting. Therefore:

- 915 is historical report accounting, not current source truth.
- 913 is a W1A acceptance target/claim, not an independently rerun result in this checkpoint.
- 845/70 is the bounded derived overlap analysis of the historical 915.
- No single current full-suite count is authorized by this audit.

`scripts/collect-test-accounting.mjs` now distinguishes reuse from `--execute` forensic reruns. Reuse avoids duplicate execution; forensic mode remains expensive and should not be part of ordinary accounting.

RLD2 still runs `test-rld2-stale-delivery.mjs` directly at `scripts/rld2-verify.mjs:95-106`, again as `test:rld2` at `:145-147`, and again from `scripts/rld2-independent-review.mjs:154-161`. This is three executions of one negative suite across verification and independent review. One authoritative NEG result should be produced and consumed.

The focused W1A contract/timing checks are also inside `test:governance`; the timing test launches git-status parsing tests already covered by governance. Suite names alone do not prove disjoint test files. Require exact suite/file manifests and distinct-count accounting.

## Timeout and cost findings

### P1 — Budget enforcement needs an actual production-path test

Verification tests exercise enforcement objects and fake/controlled runners. Static production path has a possible failure shape: `runColimaGraph` throws `ColimaGraphError` when `preDispatch` blocks at `src/runtime/colima-graph-runner.mjs:328-338`; `src/v2/execution-orchestrator.mjs:181-190` special-cases `PhaseCardError`, then treats other errors as unexpected. Terminal settlement at `src/runtime/colima-graph-runner.mjs:377-388` ignores return values. This is a focused-test requirement, not proof of a runtime failure.

### P1 — Timeout enforcement is not end-to-end

`runSuiteSync` has a suite timeout, but several child/bundle paths have no explicit timeout, and direct-child termination does not prove descendant cleanup. `verification-timing.mjs` also substitutes `Date.now()` for invalid/missing timing inputs and labels the result measured. Persist `timedOut`, termination reason, elapsed time, and process-tree cleanup result; missing timing must be `UNKNOWN`.

### P1 — IR uniqueness checks are weak

`scripts/ta3-independent-review.mjs` checks only a minimum suite count/exclusions. W1A contract tests check source patterns, not exact suite names, command mapping, disjointness, or `passed + failed = tests`. Add exact manifest assertions.

### P2 — Blanket suite caps hide per-suite cost

30–40 minute caps are operational ceilings, not measured duration. They prevent hangs but do not explain impact. Keep hard caps; add measured duration and scope justification to expensive runtime suites. Do not raise caps to make full-suite failures disappear.

### P2 — Runtime suite remains an unbounded governance cost

`test:colima-all` is nine serial files with historical kill evidence. Scope gating is correct subtraction for non-runtime cards. Runtime cards need an explicit impact tag and one bounded matrix, not automatic full-suite inclusion.

## W1A verification disposition

- KEEP: six-suite dedup shape, `--reuse` accounting, real `wallMs`, colima scope gate, no fabricated future node timings.
- REWORK: production budget gate error/settlement path; RLD2 NEG reuse; timeout/process-tree reporting; regenerate or explicitly supersede historical TA3 evidence.
- DEFER: full Colima crash matrix until budget gate behavior is tested on the real runner.
- REMOVE from routine path: per-file accounting re-exec and nested governance sub-suite entries.

## P0 status

No P0 finding established. P1 verification work remains before claiming budget enforcement or current 913-count proof.
