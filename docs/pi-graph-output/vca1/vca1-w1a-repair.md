# VCA-1 W1A — Verification Deduplication & Real Timing

**Card**: VCA-1 · **Round**: W1A (bounded repair per R1/R2 evidence)
**Executor**: Pi + AutoLoop (launched via `npm run pi:autoloop`)
**Date**: 2026-08-09 · **Git ops**: NONE (no commit / push / merge / seal)
**Precondition**: VCA-1 R1/R2 audit PASS (Controller verdict) — repair decisions S3/S4/S5/S6/S2/S10/S9 taken in audit §4 order.

**Out of scope (per Controller)**: S7 closeout architecture merge · S16 telemetry storage
relocation · Semantic Drift · scheduler/runtime rewrite · commit/push/merge/seal.

---

## 0. Method & scope discipline

- All commands rooted at `/Volumes/NVM2T/Development/autoloop`. No `/`, `~`, `$HOME`,
  `/Users/zhengfengqing` rooted discovery. No blanket 900+ suite run — only focused
  (new gates) + impacted regression (governance / scripted-lifecycle / telemetry / budget /
  admission / v2 — the ta-line V17 set).
- **`test:colima-all` was NOT re-run** (>420s container class, would exceed the bounded
  repair scope; the new gate + timed runner are unit-tested instead).
- Historical evidence under `docs/pi-graph-output/*` was NOT modified. Verify scripts were
  changed for FUTURE runs only; the ta2/ta2r/ta3/rld2 `*-verification.json` historical files
  were left untouched.
- Every timing value written to evidence comes from `Date.now()` snapshots via
  `src/governance/verification-timing.mjs` (`timingSource: "MEASURED"`) — never fabricated.

---

## 1. Repairs applied

### S3 — V17 no longer re-runs the 3 governance sub-suites
Removed `test:review-bundle` / `test:graph-closeout` / `test:external-review-delivery` suite
**entries** from the V17 regression lists of `scripts/ta2-verify.mjs`, `scripts/ta2r-verify.mjs`,
`scripts/ta3-verify.mjs`, `scripts/rld2-verify.mjs` — `test:governance`
(`node --test test/governance/*.mjs`) already covers those files. Same 3 lines dropped from the
ta3/rld2 `SUITE_LINES`; ta3 IR-10's distinct-suite expectation is now `>= 6`.

### S4 — Independent Review = evidence/contract cross-check, no suite re-execution
`scripts/ta3-independent-review.mjs` IR-4 no longer execs `test:budget`; it cross-checks the
structured `test:budget` accounting recorded in `ta3-verification.json` (the same evidence the
closeout renders — `ok / failed / wallMs`, explicitly "not re-run by IR"). IR-10 additionally
asserts the V17 list carries only distinct suites. This matches the ta2r IR pattern the audit
endorsed (G7 KEEP).

### S5 — test accounting reuses completed results
`scripts/collect-test-accounting.mjs` rewritten:
- **no mode** → usage + exit 2 (fail-closed; a bare invocation never re-executes tests);
- **`--reuse <verification.json>`** → renders per-suite accounting from the verify gate's
  recorded `regression[]` (`executed:false`, `mode:REUSE`, wallMs attributed to the verify gate);
- **`--execute`** → legacy per-file re-execution kept ONLY as an explicit forensic opt-in.

Real-data smoke: `--reuse docs/pi-graph-output/ta3/ta3-verification.json` → 915 tests reused,
`executed:false`, exit 0.

### S6 — test:colima-all scope-gated to runtime/Colima-touching cards
New `src/governance/colima-scope-gate.mjs`:
- `classifyColimaScope` — a card touches runtime iff it owns a colima-all suite member (the 9
  files in package.json's `test:colima-all`), or its files touch `src/runtime/`,
  `src/subagent/`, `src/v2/durable*`, `src/admission/`, runtime graph tests, or colima driver
  scripts (de1/de2/bakeoff/crash/resume probes);
- `assertColimaAllAuthorized` → `{ ok:false, holdCode: COLIMA_ALL_NOT_AUTHORIZED, substitute }`
  for non-runtime cards (substitute = ta-line V17 set);
- wired into `runMandatoryGraphCloseout` (review-bundle.mjs) — a closeout whose structured
  regression claims a colima-all run for a non-runtime card **HOLDs** fail-closed;
- `runColimaAllTimed` — the canonical colima-all run with REAL wallMs/startedAt/completedAt (S2).

Historical-card classification (documented in the evidence JSON): `cbm2r` → **BLOCKED** (the
audit's redundant run — a closeout-evidence-repair card over memory-contract/closeout
machinery); `de1/de1r/de2/de2r` (durable/runtime drivers) and `cbm3` (owns
`test/memory/test-graph-colima-writeback.mjs`), `cbm4`, `cost1` (runtime seam wiring) →
**AUTHORIZED**. The E2E fixture card (`docs/`-scope) no longer claims colima-all.

### S2 — verification evidence carries real wallMs / startedAt / completedAt
New `src/governance/verification-timing.mjs` (`timingFields` / `parseNodeTestOut` /
`runSuiteSync` / `aggregateTiming`). All four verify gates now embed `startedAt / completedAt /
wallMs / timingSource: "MEASURED"` on the verification summary AND per regression-suite entry.
`runColimaAllTimed` does the same for colima-all. Measured 6-suite V17 (this machine,
2026-08-09): **913 tests, 145447ms wall** (budget 325ms · admission 46777ms · governance
28883ms · scripted-lifecycle 3278ms · telemetry 1507ms · v2 86677ms).

### S10 — synthetic self-closeout timestamps removed
All hardcoded `startedAt/completedAt` in self-closeout `graphResult` objects replaced with
`null` (UNKNOWN): ta2 (6), ta2r (6), ta3 (6), rld2 (7), rb1g (4), rb1h (4), cbm2r (4) = **74
literals removed**. `buildGraphCloseoutEvidenceSnapshot` now tags each node
`timingSource: "MEASURED" | "UNKNOWN"`. Durations are never fabricated. Historical evidence
files were left as-is (recorded history, not rewritten).

### S9 — one authoritative review bundle per generation
`review-bundle.mjs`: `generationKeyFromBundleText` / `scanAuthoritativeBundles` /
`assertAuthoritativeBundle` / `retireAuthoritativeBundles` + `BUNDLE_AUTHORITY_HOLDS`.
`runMandatoryGraphCloseout` retires other **same-generation** authoritative bundles
(same cardId + same supersede target) to `<outDir>/.superseded/` after a **valid** render
(PASS or AWAITING_BUNDLE_DELIVERY) — exactly one authoritative bundle remains. Identical
re-runs overwrite in place (same deterministic identity). repair / supersede generations
(different supersede target) accumulate as the explicit exception. Invalid/HOLD renders never
displace the previous authoritative bundle; delivery retries and HOLD→fix→re-run stay possible
(no blocking — this is why the existing governance gate suite, incl. the T6/T7 delivery-retry
tests, stays green).

---

## 2. Acceptance criteria

```text
A. V17 不再重複 governance 子 suite            PASS  (4 verify scripts drop the 3 sub-suite
                                                     entries; measured 6 distinct suites,
                                                     913 distinct tests, 0 double-count)
B. Independent Review 不再重跑已綠 suite        PASS  (ta3 IR-4 contract cross-check of
                                                     verification.regression; no suite exec)
C. test accounting 不重新執行測試              PASS  (default fail-closed; --reuse renders
                                                     915 recorded tests executed:false)
D. 非 runtime-touching card 不執行 colima-all  PASS  (docs/memory-only -> COLIMA_ALL_NOT_
                                                     AUTHORIZED; cbm2r classified BLOCKED;
                                                     closeout-boundary HOLD proven)
E. runtime-touching card 仍能正確觸發 colima-all PASS  (de1/de1r/de2/de2r + cbm3/cbm4/cost1
                                                     AUTHORIZED by the gate)
F. verification evidence 有真實 wallMs        PASS  (timingFields/runSuiteSync MEASURED;
                                                     V17 measured 145447ms; 6 timing tests)
G. synthetic timestamps 已消除                 PASS  (74 literals removed; contract scan
                                                     finds none; evidence tags UNKNOWN)
H. unchanged generation 不再產生多個 authoritative bundle  PASS  (identical re-run overwrites
                                                     in place; drifted same-generation render
                                                     retires old to .superseded/; supersede
                                                     chain is the explicit exception)
```

---

## 3. Before / after

| Axis | Before (R1/R2) | After (W1A) |
|---|---|---|
| V17 suite entries | 9 | 6 (distinct) |
| Recorded tests | 915 (70 double-counted, +3 extra process launches) | 913 distinct, 0 double-count |
| IR suite re-runs | ta3 IR-4 re-ran test:budget (44 tests) | 0 (contract cross-check) |
| Test accounting | per-file re-execution (e.g. memory 23 files → 23 runs) | REUSE completed results; executed:false |
| colima-all scope | blanket per old-card closeout (cbm2r–de2r; >420s, no recorded total) | gate: runtime-touching only; cbm2r blocked; timed runner records real wallMs |
| Node timestamps in closeout evidence | synthetic 5-min/round-second literals (ta2/ta2r/ta3/rld2/rb1g/rb1h/cbm2r) | null/UNKNOWN; timingSource MEASURED|UNKNOWN |
| Authoritative bundles per generation | 4-6 (ta1:5, ta2:4, ta2r:4, cbm3:5, cbm4:6, de2:5) | 1 (same-generation re-renders retire old to .superseded/; supersede chain excepted) |
| Wall-clock (V17) | 142920ms distinct-suite (9 entries) | 145447ms (6 entries; governance 273→340 tests since ta3) |
| Correctness regression | — | NONE — 913/913 impacted + 31/31 focused green |

---

## 4. Regression evidence (run this card)

Focused (new gates): 31/31
- `test/governance/test-verification-timing.mjs` (6) — S2
- `test/governance/test-colima-scope-gate.mjs` (12) — S6 D/E + S10 cross-check
- `test/governance/test-bundle-authority.mjs` (6) — S9
- `test/governance/test-w1a-contracts.mjs` (7) — S3/S4/S5/S10/S2 static + script contracts

Impacted: 913/913
- `test:governance` 340/340 (incl. the closeout-gate suite exercising the modified
  `runMandatoryGraphCloseout`, delivery-retry T6/T7, and the adapted test-9 S9 invariant)
- `test:scripted-lifecycle` 44/44 · `test:telemetry` 37/37 · `test:budget` 44/44 ·
  `test:admission` 76/76 · `test:v2` 372/372

`npm run check` (parse over src) clean. **No** colima-all / memory blanket run (out of scope).

---

## 5. Notes & deferred

- ta2/ta2r/ta3/rld2 verify scripts now FAIL the V18 scope guard if run outside their own card
  (they were changed by VCA-1) — expected; they are per-card gates for their own closeouts.
- Historical `*-verification.json` / bundle / evidence files were not regenerated; the S2/S3
  timing + dedup shape applies to FUTURE runs.
- S7 (closeout consolidation) and S16 (telemetry authority) remain explicitly deferred per the
  Controller; the S6 gate is the closeout-boundary enforcement point S7 will build on.

**Stop point reached. No commit / push / merge / seal performed — the worktree stays dirty by
design. Next per Controller: W1A PASS → S7 closeout consolidation + S16 telemetry authority.**
