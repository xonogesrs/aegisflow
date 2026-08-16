# Checkpoint 2026-08-09 — Dirty Tree Attribution

## Baseline

| Snapshot | Path count | Source |
|---|---:|---|
| TA3 card start | 308 | `docs/pi-graph-output/ta3/ta3-card-start-baseline.json` |
| RLD2 card start | 330 | `docs/pi-graph-output/rld2/rld2-card-start-baseline.json` |
| Current | 376 | bounded `git status --porcelain` |

Audit baseline before checkpoint outputs: 17 tracked modified paths, 359 untracked paths (376 total). Untracked expansion was approximately 173 docs, 60 scripts, 57 source files, 68 tests, and `AGENTS.md`. After Controller wrote seven checkpoint artifacts, tree is 17 tracked + 366 untracked = 383 entries; the seven checkpoint files are excluded from attribution. No path from either recorded baseline was removed. Pre-output baseline adds 68 paths after TA3 and 46 after RLD2.

## Attribution

| Group | Attribution | Examples |
|---|---|---|
| Pre-existing before TA3 | PRE_EXISTING | 14 tracked modified paths, including `package.json`, schema, existing v2 modules, and seven v2 tests |
| TA3 overlay | TA3 / completed but uncommitted | `src/budget/*`, budget tests, `scripts/ta3-*`, `docs/pi-graph-output/ta3/*` |
| RLD2 overlay | RLD2 / completed but uncommitted | `scripts/rld2-*`, RLD2 governance tests, `docs/pi-graph-output/rld2/*` |
| VCA1 Phase 0/W1A overlay | VCA1 / completed but uncommitted | `AGENTS.md`, `scripts/pi-autoloop.sh`, verification guard/timing/scope modules, Phase 0/W1A evidence, added tests |
| Mixed tracked overlays | UNKNOWN at whole-file granularity | `package.json`, `src/lifecycle-runner.mjs`, `src/v2/phase-response-contract.mjs`, `test/test-lifecycle-runner.mjs` contain baseline and later W1A changes |

The baseline establishes path presence, not line-level authorship. Mixed files must not be assigned wholly to W1A from current `git status` alone.

## W1A disposition

- KEEP: verification dedup, `--reuse` accounting, real timing, Colima scope gate, reviewer no-tools policy, bounded launcher, guard tests.
- REWORK: budget production-path gate/settlement behavior; reconcile historical TA3 evidence against W1A semantics.
- DEFER: S7 state-driven closeout consolidation and S16 telemetry authority/location.
- REVERT: none supported by bounded evidence.
- UNKNOWN: whether any historical self-closeout script still has an authorized active consumer.

`docs/pi-graph-output/vca1/vca1-w1a-repair-evidence.json` records `gitOps: NONE`; no commit, push, merge, or seal is attributed to W1A.

No VCA1/W1A external-review delivery was found in Current/Archive; Current contains TA3 only. W1A completion remains existing evidence, not externally accepted closeout.

## Attribution decisions

- Treat all baseline-present paths as PRE_EXISTING for change accounting unless a later overlay is explicitly documented.
- Treat TA3/RLD2/VCA1 output files as completed-but-uncommitted work, not clean repository history.
- Do not clean, stash, revert, or commit this tree during checkpoint.
- No P0 dirty-tree finding established.
