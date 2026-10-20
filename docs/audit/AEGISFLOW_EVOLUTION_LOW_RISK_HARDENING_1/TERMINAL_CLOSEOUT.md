# Evolution low-risk hardening 1 — terminal closeout

**Card:** `AEGISFLOW_EVOLUTION_HARDENING_TERMINAL_CLOSEOUT_1`
**Branch:** `feat/omp-cbm-recovery`
**Mode:** CLOSEOUT_ONLY — no production code, test, config or environment change
**Date:** 2026-10-20

This document records a closeout verification. It **adds** facts; it does not
rewrite any earlier record. The 15-FAIL host-suite observation in
`N3_SIGNAL_JOURNAL_BINDING_REPAIR.md` §9 and the earlier HOLD/FAIL dispositions
stand exactly as written.

```
TERMINAL_VERDICT      = PASS
TERMINAL_COMMITTED    = false  (controller-side act; see §6)
FINAL_HEAD            = 12298f5a8424ad5013dc091b680217dc9f9f0f6b
REMOTE_VERIFIED       = true
WORKTREE_CLEAN        = true
HARDENING_BRANCH_CLOSED = false  (pending the committed fence)
```

---

## 1. Landing identity

Measured in `/private/tmp/aegis-repair-1` after `git fetch origin`:

| Check | Value |
|---|---|
| `git branch --show-current` | `feat/omp-cbm-recovery` |
| `git rev-parse HEAD` | `12298f5a8424ad5013dc091b680217dc9f9f0f6b` |
| `git rev-parse origin/feat/omp-cbm-recovery` | `12298f5a8424ad5013dc091b680217dc9f9f0f6b` |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | `12298f5a8424ad5013dc091b680217dc9f9f0f6b` |
| unpushed commits | `0` |
| `git status --porcelain --untracked-files=all` | empty |
| `git stash list` | empty |
| other worktree | `/Volumes/NVM2T/Development/repos/autoloop` @ `8bb72a5`, `audit/omp-native-capability-dispatch-1`, clean |

---

## 2. Fix scope (N1–N3) and the N4 boundary

Commits between the card baseline `b32a8e2` and this head, and the paths they
touch:

| Commit | Subject | Behaviour paths changed |
|---|---|---|
| `09df20d` | harden candidate conflict, synthetic typing, evidence guard | `src/evolution/{candidate,loop,production-consumer}.mjs` |
| `773bb8a` | close the two defects the independent review reproduced | `src/evolution/production-consumer.mjs` |
| `b02131d` | bind fired signals and patches to the durable journal (N3) | `src/evolution/production-consumer.mjs` |

`668a74f`, `2ff33db`, `6f08577`, `d596edb`, `12298f5` are report-only. Nothing
outside `src/evolution/`, `test/evolution/`, `docs/` was modified; no
dependency, store, schema or policy was added.

N4 is a **record**, not a change. Measured on this head:

```
resolveEvolutionProductionConfig({ env }) => {
  enabled: false,
  missing: ["storeRoot", "checkpointRoot", "repoRoot"],
  proposalOnly: false
}
AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG / AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG: unset
```

Production evolution remains **DISABLED**. The activation boundary and its five
preconditions are recorded in `HARDENING_REPORT.md` §5 and were not altered.

---

## 3. Suites re-run for this closeout

| Suite | Result |
|---|---|
| `node --test test/evolution/*.mjs` (9 files) | **121 / 121 PASS**, 0 fail, 0 skipped |
| `node --test test/evolution/test-evolution-low-risk-hardening-1.mjs` | **17 / 17 PASS** (N1 ×3, N2 ×4, N3 ×10) |
| `node test/run-suite.mjs` (host-only) | 3216 tests, **3200 pass**, **14 fail**, 2 skipped |
| `node --test test/v2/test-e2-reboot-soak-crossproc.mjs` (isolated) | **3 / 3 PASS** |

The 17 adversarial N3 probes are the refusal set: forged `signature`, forged
`count`, forged class, forged `patchPlan`, journal-carried patch provenance,
no-cooldown-after-refusal, correctly-derived signal still fires,
non-re-derivable classes, and caller-reports-fewer. All refuse or fire as
specified; none reaches a durable write on a forged claim.

### 3.1 Host-only failure set

The 14 failures are one class — `ERR_MODULE_NOT_FOUND: Cannot find package
'@earendil-works/pi-ai'` from `src/v2/pi-transport-adapter.mjs`, an optional peer
dependency absent from this checkout:

```
test/budget/test-reviewer-atomic-reservation-r3.mjs
test/budget/test-reviewer-attempt-meter-unit.mjs
test/control-plane/test-allowlist-parity.mjs
test/control-plane/test-coordinator.mjs
test/control-plane/test-execution-sink.mjs
test/control-plane/test-optimizer.mjs
test/governance/test-execution-review-bypass-fence.mjs
test/test-sop-scale-bind.mjs
test/v2/test-e3-discrimination-probes.mjs
test/v2/test-e3-lease-outage-soak-crossproc.mjs
test/v2/test-e3-lease-outage-soak.mjs
test/v2/test-pipeline.mjs
test/v2/test-pi-transport-adapter.mjs
WP2 T2 (inside test/rollover/test-production-wiring.mjs)
```

`E2 X2 CROSSPROC` is **not** in this run's failure set — 15 FAIL was the
independent review's count, and that record is preserved in §9 of the N3 report.
This run matches the 14-failure baseline, i.e. a strict subset of the 15.

---

## 4. E2 X2 disposition — pre-existing Colima profile lock contention

**Classified as an existing test-isolation defect, not a regression of this
card.**

Evidence, each item measured on this head:

1. **The test and its machinery are untouched by the repair.**
   `test/v2/test-e2-reboot-soak-crossproc.mjs` last changed in `11059ba`
   (2026-09-15), `test/v2/helpers/e2-reboot-fixtures.mjs` in `f0ae793`
   (2026-09-24), `src/runtime/colima-profile-lock.mjs` in `ade4680`
   (2026-09-25). Between `b32a8e2..HEAD` only three commits touch `src`/`test`
   and all three are under `src/evolution/`.
2. **The failure is lock contention, reproduced deterministically.**
   Holding the real profile lock
   (`/Volumes/NVM2T/Development/runtime/colima/autoloop-locks/colima-profile-autoloop-graph.lock`)
   via `acquireColimaProfileLock({profile:"autoloop-graph"})` and then running
   the X2 leg yields:

   ```
   final:  "HOLD"
   reason: "ORCHESTRATION_EXCEPTION:HOLD / COLIMA_PROFILE_BUSY"
   ```

   and the suite reports `'HOLD' !== 'PASS'` at
   `test/v2/test-e2-reboot-soak-crossproc.mjs:76` — the exact shape the
   independent review observed. Releasing the lock and re-running the same leg
   yields `final: "PASS"`, `thrown: null`.
3. **It passes in isolation on the current head** — 3/3, both before and after
   the lock probe.

`test/run-suite.mjs` documents this mechanism for the external suites
("will fail with `HOLD / COLIMA_PROFILE_BUSY` if run in parallel with each
other — that is the profile single-flight lock doing its job, not a flaky
test"). The crossproc file is not in `EXTERNAL_SUITES`, so a host run can
overlap another lock holder. That is a test-isolation gap in the shim, and it is
**not** repaired here: this card is closeout-only.

---

## 5. Scope attestation

Not touched by this card: `src/`, `test/`, package manifests, environment
files, `AEGISFLOW_COLIMA_PROFILE_LOCK_ROOT`, the lock directory, the deployment
declaration, any production store. No history was rewritten, no commit amended,
no evidence document edited. This file is the only addition.

---

## 6. Why `TERMINAL_COMMITTED` is `false`

The terminal fence is a **controller-side act on the host channel**
(`docs/agent-integration.md`): the governed agent may record a disposition with
`request_terminal_fence`, which always reports `committed: false`; committing
requires `/fence-generation PASS` issued by the launcher with
`OMP_TERMINAL_FENCE_AUTHORITY` set. That marker is absent in this session
(`env | grep OMP_TERMINAL` is empty), and the fence is not a capability an agent
can acquire.

So this closeout states its disposition — `TERMINAL_VERDICT = PASS` — and
records the mechanical state a controller needs to commit it. It does not claim
a fence that did not happen. `HARDENING_BRANCH_CLOSED` therefore remains
`false` until the fence is committed.

Remaining controller step, and nothing else:

```
/fence-generation PASS "N1-N3 PASS; N4 boundary recorded; 121/121; E2 X2 = pre-existing lock contention"
```
