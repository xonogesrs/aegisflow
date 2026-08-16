# VCA-1 R1/R2 — Verification Cost Audit

**Card**: VCA-1 · **Round**: R1 (Verification Path Inventory) + R2 (Historical Cost Reconstruction)
**Executor**: Pi + AutoLoop (launched via `npm run pi:autoloop`)
**Date**: 2026-08-09 · **Mode**: read-only audit · **Git ops**: NONE (no commit/push/merge/seal)
**Bootstrap evidence**: Phases 0A–0F treated as existing prior evidence, NOT re-run (per Controller instruction)

---

## 0. Method & scope discipline

- All verification commands were rooted at `/Volumes/NVM2T/Development/autoloop` (or the two
  explicitly-authorized review-surface dirs). **No** `/`, `~`, `$HOME`, `/Users/zhengfengqing`
  rooted discovery was performed. No recursive whole-home scan. No command whose resolved root
  lands outside the repo + named surface paths.
- Authoritative-source-first: gate behavior was read from the gate scripts and `src/governance/*`
  modules (the code IS the authority), and durations were taken from recorded evidence where real,
  from current read-only measurement where absent, and marked `NOT_INSTRUMENTED` otherwise.
- Where historical data does not exist, it is recorded as `UNKNOWN / NOT_INSTRUMENTED` — no
  filesystem scope was widened to backfill history.
- Current suite runtimes below were measured read-only on this machine (2026-08-09); they are the
  *current* cost baseline, not historical claims.

---

## 1. Verification Path Inventory (R1)

Gate taxonomy used throughout: **V1** = machine verification (per-card `*-verify`), **V2** =
independent review (per-card `*-independent-review`), **C** = closeout (per-card `*-self-closeout`
or state-driven closeout), **D** = external-review delivery/rotation, **R** = regression/parse
gates, **P** = probe/benchmark, **G** = guardrail (bootstrap).

### 1.1 Gate inventory table

| # | Gate | Kind | Trigger | Purpose | Authoritative source | Filesystem scope | Duration (evidence/measured) | Tests run | Evidence reuse | Historical detection value |
|---|------|------|---------|---------|----------------------|------------------|------------------------------|-----------|----------------|---------------------------|
| G1 | `npm run check` (node --check over `src/*.mjs`) | R | any card | syntax gate | source files | repo `src/` | measured 0.42s | parse-only | n/a | LOW (parse errors caught by tests too) |
| G2 | `scripts/ta1-verify.mjs` | V1 | TA-1 close | design deliverables validate | `ta1-*.json` + schema validator | repo `docs/pi-graph-output/ta1/` | NOT_INSTRUMENTED (no verification.json persisted; estimate 1–2s) | 16 checks, no suites | none — reads deliverables | HIGH at the time (found JSON defects) |
| G3 | `scripts/ta2-verify.mjs` | V1 | TA-2 close | admission/capability implementation + wiring | source modules + `ta2-verification.json` | repo | recorded: verifiedAt only; current 8-suite regression ≈ 142s | V1–V18 + 8 suites (~950 now) | reads ta1 inventory | HIGH |
| G4 | `scripts/ta2r-verify.mjs` | V1 | TA-2R repair close | bounded-repair verification + NEG matrix | source + `ta2r-verification.json` | repo | recorded: verifiedAt only; ≈ 143s current | V1–V21 + 8 suites | baseline pathShas | HIGH (V19/V20 found real defects) |
| G5 | `scripts/ta3-verify.mjs` | V1 | TA-3 close | budget-enforcement machine verification | source + `ta3-verification.json` | repo | recorded: verifiedAt only; measured ≈ 143s (V17 set) | V1–V21 + 9 suites (915 recorded) | ta3 baseline + ta2r bundles | HIGH (V1–V21 incl. NEG matrix) |
| G6 | `scripts/rld2-verify.mjs` | V1 | RLD-2 close | root-cause + repair verification | source + `rld2-verification.json` | repo + review surface (read) | NOT_INSTRUMENTED | V1–V14 + suites | incident snapshot | HIGH (stale-delivery NEGs) |
| G7 | `scripts/ta2r-independent-review.mjs` | V2 | TA-2R close | independent recompute of V1 claims | source modules, re-derivation | repo | NOT_INSTRUMENTED (sub-second to ~1s; no suite re-run) | IR-1..IR-10, no suite re-run | verification accounting | MEDIUM (independent check) |
| G8 | `scripts/ta3-independent-review.mjs` | V2 | TA-3 close | independent recompute of V1 claims | source modules, re-derivation | repo | NOT_INSTRUMENTED (≈1s + **re-runs test:budget 0.2s**) | IR-1..IR-10 + budget suite re-run | verification accounting | MEDIUM |
| G9 | `scripts/rld2-independent-review.mjs` | V2 | RLD-2 close | independent recompute | source + re-derivation | repo + surface (read) | NOT_INSTRUMENTED | IR-1..IR-10 | verification accounting | MEDIUM |
| G10 | TA-1/TA-2 independent review | V2 | TA-1/TA-2 close | "fresh session" review | **hand-authored evidence JSON only — no script exists** | repo (evidence only) | NOT_INSTRUMENTED | 0 machine checks (manual review narrative) | none | MEDIUM (real findings in ta1 NBF1–3) but unscripted/inconsistent |
| G11 | per-card `*-self-closeout.mjs` (ta1, ta2, ta2r, ta3, rld2, cbm2, cbm2r, cbm3, cbm4, cost1, de1, de1r, de2, de2r, rb1g, rb1h, rb1r) | C | card close | mandatory graph closeout: bundle render + validation + git facts + evidence snapshot | `runMandatoryGraphCloseout`/`runCloseoutGate` (review-bundle.mjs) + git | repo + review surface | NOT_INSTRUMENTED per script (bundle render+validate ≈ seconds; colima variants much more — see G13/G14) | 0 tests (gate, not suite) | card-start baseline + verification.json | HIGH (closeout is the deliverable gate) |
| G12 | `scripts/gov-closeout-bundle.mjs` (+ `--state-driven-closeout`) | C | any card (shared CLI) | shared closeout entry; state-driven variant reads `closeout-state.json` | `runCloseoutGate`/`runStateDrivenCloseout` | repo | NOT_INSTRUMENTED | 0 | closeout-state.json | HIGH (used by report-lifecycle-repair-1 + fm3-rbi — the MERGE target) |
| G13 | `test:colima-all` (9 integration files, container-backed) | R | old-card closeouts (cbm2–cbm4, cost1, de1, de1r, de2, de2r) + `colima-all` npm script | real containerized graph-run integration | Colima runtime + repo | repo (containers via colima) | **measured: >420s and still running when killed (mid `test-c3-colima-pipeline`); full total NOT_INSTRUMENTED** | 9 files (~200+ tests incl. 30–55s real container runs) | none | HIGH (catches real runtime defects) — but cost is the largest single path |
| G14 | `scripts/collect-test-accounting.mjs` | R | cbm2r/cbm3/cbm4/cost1 closeouts | per-file test accounting (CBM-2R finding 3) | node --test per file | repo test/ | NOT_INSTRUMENTED; **re-executes every test file in a separate process** (e.g. memory 23 files → 23 separate runs) | all suites re-run file-by-file | none | LOW going forward (one-time anti-tamper finding; now redundant with structured verification.json) |
| G15 | `scripts/gov-external-review-surface.mjs` (`--deliver`/`--rotate`/`--status`/`--export-for-card`) | D | bundle → Current/ delivery + verdict rotation | fixed review-surface delivery/rotation, fail-closed | `validateReviewBundle` + `currentReviewDelivery` | `~/Desktop/AutoLoop-Review/Current` + `Archive` (explicitly authorized) | NOT_INSTRUMENTED (seconds) | 0 | bundle identity/sha | HIGH (delivery is the external gate; RLD-2 proved stale-delivery was detectable) |
| G16 | `scripts/gov-commit-checkpoint.mjs` / `gov-commit-integration.mjs` / `gov-push-gate.mjs` / `gov-draft-pr.mjs` | C/G | checkpoint/PR/push boundaries | lifecycle gates (scope, secrets, live bindings, review-unit) | `checkpoint-commit-gate.mjs`, `review-unit-gate.mjs`, etc. | repo | NOT_INSTRUMENTED | 0 (gate checks) | inventory | MEDIUM — **dormant during cards** (no commits by design; dirty worktree) |
| G17 | `scripts/cbm3-memory-probe.mjs`, `cost1-telemetry-probe.mjs`, `de1-bakeoff.mjs`, `de1r-bakeoff.mjs`, `de2-crash-matrix.mjs`, `de2-perf-probe.mjs`, `de2r-subagent-resume-probe.mjs`, `rld2-reproduction.mjs` | P | per-card investigation | one-shot benchmarks / crash matrices / reproduction | measured results (de1r 205s bakeoff, de2 805s crash-matrix embedded in closeout evidence) | repo (+colima) | embedded in closeout evidence for de1r/de2; else NOT_INSTRUMENTED | benchmark scenarios | none | HIGH for their card, LOW as routine |
| G18 | guardrails: `src/governance/verification-scope-guard.mjs`, `AGENTS.md`, `scripts/pi-autoloop.sh`, `test-vca1-phase0b-enforcement.mjs`, `test-verification-scope-guard.mjs` | G | every interactive/automated verification | forbid `$HOME`/`/`-rooted discovery; force authoritative-source-first | guard module + AGENTS.md | repo (+ named surface paths only) | guard tests ≈ 0.1s | ~20 tests | n/a | **the only gate that made the 896s incident class impossible** — KEEP as foundation |
| G19 | `test:memory` suite (23 files, 229 tests) | R | cbm/memory cards + `test:memory-*` scripts | memory write-back/retrieval regression | source modules | repo | measured 51.3s | 229 | none | HIGH for memory cards; **NOT part of ta-line V17** (gap + asymmetry) |
| G20 | telemetry gate (cost1 `telemetry-overhead` evidence + `src/telemetry/*`) | R | graph runs with observer | measure observation overhead + record run cost | `cost1-telemetry-overhead-20260807-evidence.json` (measured) | **`$HOME/.autoloop-telemetry-*` (per-card), OUTSIDE bounded roots** | measured: 1.71ms/graph, +43.7 MiB RSS, 1224 B/event, 538 KB/440 events | benchmark 40 iterations | aggregate evidence | HIGH (only real per-run cost instrumentation in the system) |

### 1.2 Filesystem-scope notes (R1)

- All V1/V2/C gates are repo-bounded (git status parse + source reads + suite runs). ✅
- The review surface (`~/Desktop/AutoLoop-Review/Current|Archive`) is outside the repo but explicitly authorized by `externalReviewSurfaceDir()`/AGENTS.md. ✅ (named, not scanned)
- **Telemetry/scratch state (`$HOME/.autoloop-telemetry-*`, `$HOME/autoloop-*-self-closeout`) is NOT on the authorized-root list** — the only per-run cost evidence lives outside the bounded roots. This is a governance gap: a future automated gate cannot read it without either authorization or in-repo mirroring.
- No gate (code) hardcodes a `$HOME`/`/`-rooted discovery; the 896s incident was agent-generated ad-hoc verification (category C), now closed by G18.

---

## 2. Historical Cost Reconstruction (R2)

### 2.1 What is actually instrumented historically

| Evidence class | Where | Verdict |
|---|---|---|
| Real ms-precision closeout node timings (1–15s/nodes) | cbm2, cbm3, cbm4, cost1, de1 graph-closeout evidence | **REAL** (irregular ms values) |
| Embedded measured benchmark durations | de1r (205s bakeoff node), de2 (805s crash-matrix node) | REAL (round but tied to measured benchmarks) |
| Authored/rounded node timings | ta1 (250s/1650s/500s), ta2, ta2r ×4, ta3, rld2, de2r, rb1g, rb1h | **SYNTHETIC** — 5-min-step values hardcoded in self-closeout `graphResult` objects (verified in `ta3-self-closeout.mjs`: `startedAt: 1786400000000` etc.) |
| No timestamps at all | fm3-rbi ×2, report-lifecycle-repair-1 | NOT_INSTRUMENTED |
| Gate wall time (verify/IR/closeout scripts) | `*-verification.json` has `verifiedAt` **only**; no per-check/per-suite duration | **NOT_INSTRUMENTED** |
| Regression test counts per gate | ta2/ta2r/ta3 `verification.json` `regression[]` | REAL (this is the one solid historical cost axis) |
| Token / tool-call / memory of verification runs | telemetry: `tokenSource: NOT_REPORTED`, `toolCallSource: NOT_REPORTED` | NOT_INSTRUMENTED |
| The 896s incident | `vca1-phase0e-interactive-pi-entry-audit.json` + session transcript | REAL — the only recorded catastrophic verification cost |

**Reconstruction result: historical per-gate wall time is NOT recoverable from evidence.** Only
(1) regression test counts per gate, (2) 5 cards' real closeout-node timings, (3) two embedded
benchmarks, (4) the cost1 telemetry-overhead micro-benchmark, and (5) the 896s incident are
measurable. Everything else is `UNKNOWN / NOT_INSTRUMENTED`. No scope widening was performed to
backfill.

### 2.2 Current measured cost baseline (read-only, 2026-08-09)

| Suite | Wall time | Tests |
|---|---|---|
| `test:budget` | 0.21s | 44 |
| `test:admission` | 46.4s | 76 |
| `test:governance` | 7.1s | 309 (273 at ta3 verify time; RLD2/VCA-1 tests added since) |
| `test:scripted-lifecycle` | 2.9s | 44 |
| `test:telemetry` | 1.3s | 37 |
| `test:v2` | 84.9s | 372 |
| `test:memory` | 51.3s | 229 |
| `test:colima-all` | **>420s, killed mid-suite** (real container runs 30–55s each) | ~9 files, total NOT_INSTRUMENTED |
| `npm run check` | 0.42s | parse-only |

**Ta-3-style V1 regression block (V17):** distinct-suite time ≈ **143s** (budget+admission+governance+scripted+telemetry+v2). Full 9-entry list re-runs 3 sub-sets of governance → 70 tests double-counted in the recorded 915 (see §3).

**Highest-cost verification paths (ranked):**
1. `test:colima-all` — **>420s** (unbounded in evidence; container-backed) — the largest single path.
2. `test:v2` — 85s.
3. `test:memory` — 51s (not in ta-line V17).
4. `test:admission` — 46s.
5. V1 regression aggregate (ta3-style) — ~143s.
6. The 896s whole-home grep (pathological; now guarded by G18).

### 2.3 Necessary vs redundant vs pathological

- **Necessary**: unit/regression suite content (budget/admission/governance/telemetry/v2/memory),
  V1 checks, V2 independent cross-checks, bundle validation + delivery fail-closed gates, scope
  guardrails, baseline content-identity (V18). These protect the whole system and caught real
  defects (ta1 NBF1–3, ta2r V19/V20, rld2 stale-delivery).
- **Redundant**: (a) 3 V17 sub-suite entries that are subsets of `test:governance`; (b) ta3 V2
  re-running `test:budget`; (c) `collect-test-accounting` re-executing every test file in a separate
  process; (d) per-card full `test:colima-all` re-runs on cards whose authorized scope is
  memory/telemetry/docs-only; (e) multiple full bundle generations per card (ta1: 5, ta2: 4,
  ta2r: 4) each re-rendered/re-validated.
- **Pathological**: (a) the 896s incident (ad-hoc `$HOME`-rooted grep — now impossible by guard);
  (b) **synthetic duration claims in closeout evidence** (ta2/ta2r/ta3/rld2/ta1 node timings are
  authored 5-min steps, presented as if measured — a cost-accounting falsity); (c) `test:colima-all`
  with no recorded total (an unbounded verification window).

---

## 3. Overlap matrix

Rows/cols = gate groups; cell = overlap type.

| | G1 parse | G2–G6 V1 verify | G7–G10 V2 IR | G11/G12 closeout | G13 colima-all | G14 per-file accounting | G15 delivery | G17 probes |
|---|---|---|---|---|---|---|---|---|
| **G1 parse** | — | parse ⊂ V1 checks | — | — | — | — | — | — |
| **G2–G6 V1** | — | — | V2 reads V1 accounting | closeout renders V1 accounting | excluded from ta-line V17 | re-runs same suites | — | — |
| **G7–G10 V2** | — | IR-4 (ta3) **re-runs test:budget**; IR-8 re-parses git status (dup of V18) | — | IR digest bound into closeout review identity | — | — | — | — |
| **G11/G12 closeout** | — | renders verifier accounting from verification.json | binds IR digest | ta2r = **4 closeout evidence files + 4 bundles for 1 generation** | old cards re-run it | old cards invoke it | re-validates bundle at delivery | embeds probe results (de1r/de2) |
| **G13 colima-all** | — | not in ta-line V17 (executor-claimed "integration-level re-verify" is **un-instrumented**) | — | old closeouts run full suite | — | duplicates suite content per-file | — | de1bakeoff/de2crash are colima-backed |
| **G14 per-file acct** | — | re-executes everything V1 already ran | — | cbm2r–cost1 only | duplicates colima-all content | — | — | — |
| **G15 delivery** | — | — | — | validates the bundle V1/closeout already validated | — | — | — | — |
| **G17 probes** | — | de2-perf overlaps de2-crash (same card) | — | results embedded in closeout evidence | share colima runtime | — | — | — |

**Quantified duplicate work per ta3-style card:** V17 9-suite list = 3 redundant suite entries (70
tests double-counted) + ta3 V2 re-runs budget = 1 extra suite execution. Marginal wall cost ≈
3 process launches + 0.2s budget re-run (small), but the *recorded* test count (915) is inflated by
70 (≈7.4%) and the closeout `SUITE_LINES` presents review-bundle/graph-closeout/external-review-delivery
as separate suites they are not.

**Structural overlap (worst):** old-card closeouts (cbm2–cbm4, cost1, de1, de1r, de2, de2r) run
`test:colima-all` (>7 min) + `collect-test-accounting` (per-file re-execution of every suite) — i.e.
the same test content executed 2–3× per card, including full container runs, for cards that were
memory/telemetry-scoped.

---

## 4. Subtraction-first decisions (per gate)

| # | Gate | Decision | Rationale |
|---|------|----------|-----------|
| S1 | G18 guardrails (scope guard + AGENTS.md + pi-autoloop.sh) | **KEEP** | Foundation — the only thing that made the 896s class impossible; cheap; zero routine cost |
| S2 | G2–G6 V1 verify gates | **KEEP** (with instrumentation) | Core gate with real historical detection value; add `wallMs` per check + per suite to verification.json (replaces NOT_INSTRUMENTED with measurement) |
| S3 | V17 9-suite list (3 sub-suite entries: review-bundle / graph-closeout / external-review-delivery) | **SIMPLIFY** | Remove the 3 subset entries from the gate's suite list — `test:governance` already covers them. Evidence accounting becomes honest (no 70-test double count); saves 3 launches/card |
| S4 | G8 ta3 V2 IR-4 (budget suite re-run) | **SIMPLIFY** | Reuse V17's recorded budget accounting instead of re-executing `test:budget` — IR's job is independent *recomputation of claims*, not suite re-execution (ta2r IR already does this correctly) |
| S5 | G14 collect-test-accounting.mjs | **DISABLE as routine** (keep script for forensic use) | Per-file re-execution of whole suites is the most redundant cost in the old pattern; its anti-tamper purpose is now served by structured verification.json accounting |
| S6 | G13 test:colima-all in old closeouts | **IMPROVE** | Scope-gate it: run only for cards whose authorized scope touches runtime/subagent/durable/seam paths; instrument total duration (currently unbounded, >420s); for docs/telemetry/memory-only cards substitute the ta-line V17 set (~143s) |
| S7 | G11 bespoke self-closeout scripts (17) | **MERGE** | Merge into the state-driven closeout (`closeout-state.json` + `gov-closeout-bundle --state-driven-closeout`, already proven by report-lifecycle-repair-1 + fm3-rbi). Removes ~17 near-duplicate scaffolding scripts; also removes the source of the synthetic `graphResult` timestamps (S10) |
| S8 | G12 gov-closeout-bundle (state-driven) | **KEEP** | The merged target; shared, single closeout authority |
| S9 | Multiple bundle generations per card (ta1: 5, ta2: 4, ta2r: 4) | **SIMPLIFY** | One authoritative bundle per resolved generation + supersede chain; reseals should reuse the last bundle + delta instead of re-rendering/re-validating a full 25-section bundle each time |
| S10 | Synthetic node timings in closeout evidence | **REMOVE/IMPROVE** | Stop authoring fake durations: drop the timestamps or fill from real gate measurement (see S2). Fictional durations are worse than none — they pollute any future cost reconstruction |
| S11 | G10 TA-1/TA-2 unscripted independent review | **IMPROVE** | Bring TA-1/TA-2 IR under a scripted gate like ta2r/ta3 (or explicitly mark as manual review evidence). Current state is inconsistent with the rest of the line |
| S12 | G15 delivery gate | **KEEP** | Cheap, fail-closed, RLD-2-proven detection value |
| S13 | G16 commit/push/PR gates | **KEEP (dormant)** | Lifecycle gates; correctly not per-card verification; don't add to card loops |
| S14 | G17 probes/benchmarks | **KEEP (one-shot only)** | Never routine; they are investigation tools, not card gates |
| S15 | G19 memory suite | **KEEP** | Necessary for memory cards; note it is outside ta-line V17 (coverage asymmetry — decision for W1, not this audit) |
| S16 | G20 telemetry store location | **IMPROVE** | Mirror per-run telemetry into the repo (or add the per-card telemetry dirs to the authorized-root list). As-is, the only real cost evidence sits outside the bounded verification roots |
| S17 | G1 npm run check | **KEEP** | 0.42s, trivial, catches parse breakage early |

**Subtraction-first ordering** (biggest/cheapest wins first): S3 → S4 → S5 → S6 → S7/S9 → S10 →
S16 → S2 (instrumentation is the enabling change for future cost audits).

---

## 5. Highest-cost verification paths (explicit)

1. **`test:colima-all`** — >420s, unbounded in evidence, container-backed, re-run per old-card
   closeout. Highest single-path cost.
2. **V1 regression aggregate (ta-line V17)** — ~143s per card.
3. **`test:v2`** — 85s (372 tests).
4. **`test:memory`** — 51s (229 tests; outside ta-line V17).
5. **`test:admission`** — 46s (76 tests).
6. **The 896s incident** — pathological, single largest recorded event; now impossible via G18.

**Necessary**: suites + V1 checks + V2 cross-checks + closeout/delivery gates + guardrails.
**Redundant**: V17 sub-suite duplication (70 tests), ta3-V2 budget re-run, per-file accounting
re-execution, per-card full colima-all on non-runtime cards, multi-bundle generations.
**Pathological**: the 896s grep (guarded), synthetic duration claims in ta2/ta2r/ta3/rld2/ta1
closeout evidence, unbounded colima-all duration.

---

## 6. Acceptance criteria status

| Criterion | Status |
|---|---|
| verification inventory | ✅ §1 (20 gates, all 9 attributes) |
| historical cost analysis | ✅ §2 (real vs synthetic vs NOT_INSTRUMENTED, current baseline) |
| overlap matrix | ✅ §3 |
| subtraction-first decisions | ✅ §4 (S1–S17, ordered) |
| highest-cost verification paths | ✅ §5 |
| necessary / redundant / pathological distinguished | ✅ §2.3 / §5 |
| no `$HOME` / `/` rooted discovery | ✅ — all commands bounded to repo + named surface paths; telemetry gap flagged as governance item (S16), not acted on |

**Scope discipline**: read-only audit; no commit/push/merge/seal; no source/test/evidence mutation;
no filesystem-scope widening to backfill history; Bootstrap 0A–0F evidence not re-run.

**Stop point reached per Controller instruction.** No W1 repair was performed — repair decisions
are deferred to the Controller.
