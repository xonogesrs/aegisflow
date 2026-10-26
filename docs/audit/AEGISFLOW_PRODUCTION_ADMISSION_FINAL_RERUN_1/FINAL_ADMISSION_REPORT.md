# AEGISFLOW Production Admission Final Rerun

**Card:** `AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1`

**Mode:** final admission, minimal verification, Owner decision preparation
**Date:** 2026-10-22 UTC

## Decision

Engineering admission is **PASS**. Submit **GO recommendation to Owner** for a controlled deployment, subject to every restriction and day-of gate below. This is **not** activation authorization. Production remains unchanged and disabled. A day-of governed smoke with the pinned root-owned Node is required before live traffic; its absence today is an activation gate, not a claim that exact tuple was already tested.

```
CARD = AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1

VERDICT = PASS
PREVIOUS_LANDING = PASS
PRODUCTION_BASELINE = VERIFIED

NODE_BINARY_PROVENANCE = PASS
PATH_REPLACEMENT_RISK = CONTROLLED

C1_BOUNDARY = ACCEPTABLE
C2_BOUNDARY = ACCEPTABLE_WITH_RESTRICTION
C3_BOUNDARY = ACCEPTABLE_WITH_RESTRICTION
C4_BOUNDARY = ACCEPTABLE_WITH_RESTRICTION

MINIMAL_SMOKE = PASS
DEPLOYMENT_RUNBOOK = READY
ROLLBACK_RUNBOOK = READY
ISOLATED_ROLLBACK = PASS

INDEPENDENT_REVIEW = PASS
DURABLE_LANDING = PASS (verify canonical remote and clean worktree in final handoff)

PRODUCTION_ADMISSION = GO
OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED
PRODUCTION_MUTATION = NONE
PRODUCTION_ENABLEMENT = false

GDR_1_APPROVED = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED = false

DEPLOYABLE_CODE_SHA = 283b7e155877a366a6b3dbf53288a4e54328f09e
LANDED_HEAD = full SHA in final handoff (documentation commit cannot contain its own SHA)
NEXT_ACTION = Owner reviews restrictions/runbook; after explicit authorization, perform day-of preflight and isolated governed smoke before enabling traffic.
```

`MINIMAL_SMOKE=PASS` combines valid same-build historical governed/OMP evidence with 28 fresh pinned-PATH C1, EKM, and rollback tests. It does **not** mean a governed OMP process using `/usr/local/bin/node` was run today. That exact tuple is explicitly required at activation. If Owner wants that smoke before making any deployment decision, admission may be held operationally without changing the engineering finding.

## Evidence and limits

1. **Landing.** Before this card, worktree clean; branch `feat/omp-cbm-recovery`; local HEAD, upstream, and canonical remote all `283b7e155877a366a6b3dbf53288a4e54328f09e`; unpushed commits zero; stash empty. `git ls-remote --heads origin feat/omp-cbm-recovery` returned that full SHA. No reset, clean, or force action.
2. **Production baseline.** OMP, deployed extensions, config, models, MCP config, and CBM binary hashes match the previous production manifest. `al-omp` remains `OFF/native`; existing OMP and CBM processes were observed, not touched. Deployed extension is older, as expected; read-only installer dry run shows 5 replacements, 8 copies, 2 unchanged. See [baseline manifest](PRODUCTION_BASELINE_MANIFEST.md).
3. **Node provenance.** Current shell/Homebrew Node path is operator-writable. Existing root-owned `/usr/local/bin/node` v22.22.2 has verified hash and `node:sqlite`. `launchGovernedRuntime` accepts `env.PATH`, and the C1 extension selects first existing `node` in that PATH. Set `PATH=/usr/local/bin:/usr/bin:/bin` only for governed launches; check root ownership, immutable-to-Agent ancestors, and digest before each launch. Resolver has Homebrew fallback if no PATH candidate exists: the fail-closed condition is **deployment preflight**, not enforced by code. See [restrictions](DEPLOYMENT_RESTRICTIONS.md).
4. **C1.** C1 saved real-runtime proof contains both exploit-positive pre-repair control and repaired 9/9 facts; R4 proves descriptor/key isolation and authenticated ledger. The remaining same-UID model is bounded by the measured sandbox and deployable path restrictions, not claimed to be OS identity separation. No confirmed Authority bypass remains in admitted path.
5. **C2–C4.** Prior admission independently measured C2's separate-state-dir double commit, C3's per-correlator keys, and C4's ledger-only crash witness. Restrictions remain mandatory and visible in the runbook. These risks were not declared eliminated.
6. **Smoke.** Fresh pinned-PATH targeted tests: C1 10/10, EKM 11/11, rollback 7/7. Prior 45-case OMP acceptance, 103/103 regression, C1 9/9 real governed facts, and R4 16-case adversarial results cover remaining unchanged functions. Exact evidence and limits are in [minimal smoke evidence](MINIMAL_SMOKE_EVIDENCE.md).
7. **Install/rollback.** [Runbook](DEPLOYMENT_ROLLBACK_RUNBOOK.md) binds every planned production change to a reversal, preserves original files and ledger witness, and forbids `uninstall` as rollback. Isolated rollback passed. No formal installation or rollback occurred in production.

## Stop rule

If day-of root Node provenance, baseline, C2 topology, sandbox/capability, isolated EKM query, signed commit, agent denial, ledger witness, or rollback record fails: **HOLD activation**. Report only concrete failed gate and minimum remedy. Do not reopen broad C1 architecture work automatically.

Independent review: [review record](INDEPENDENT_REVIEW.md). Durable landing is verified after documentation commit, push, and fetch; the final handoff reports its full SHA. This report's deployable code SHA remains `283b7e1` when documentation HEAD advances.
