# Targeted remediation 2 — F1–F5

**Card:** `AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REMEDIATION_2`
**Baseline:** `23cbe67` (unchanged, not amended)
**Branch:** `feat/omp-cbm-recovery`
**Input verdict:** `HOLD` — independent review of `AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REPAIR_1`
**Scope:** fix the five reproduced defects; preserve the verified G1/G2/G3 behaviour; no architecture change.

This document records what was fixed, how each fix is proven, and what the
evidence says. It does **not** declare the card closed: the independent rerun
belongs to a reviewer session that did not write this code.

---

## 1. Environment note — why the review had five more findings than my run

The implementation session ran the evolution suite and the host-only suite at
`23cbe67`. The review reproduced five defects beyond the three the implementation
card scoped (G1/G2/G3). Two reasons, both now addressed:

- The implementation's verification never exercised the **cross-family** order
  (strategy proposal first, then a source derivation of the same
  signature@baseline). The suite only ever drove one family per store.
- The implementation's "malformed declaration" case asserted that the resolver
  `enabled === false` and that the error was *surfaced*. It never asserted what
  the ceiling RESOLVED TO — which is where the fail-open lived.

Both gaps are now permanent tests (§3), so the same class of defect cannot
return silently.

---

## 2. The fixes

### F1 — unqualified evidence consumed the cooldown (MEDIUM)

**Defect.** The self-deriving loop entry applied only the *declared-synthetic*
half of the provenance rule (`syntheticEvidenceReason`). A hand-built array with
no durable journal identity passed; the loop gated it, recorded it, wrote trigger
state, and spent the signature's `lastFiredAt`. The next REAL signal for the same
signature was then suppressed as `cooldown` — fixture evidence silently blocking
a production trigger for a whole window.

**Fix.** One fence, applied before trigger evaluation and before any durable
write: `assessEvidenceProvenance` — the same predicate the observer and the
every-run feed use. `src/evolution/loop.mjs` (Stage 0b) now runs it for BOTH
entry modes, returns `HOLD / EVOLUTION_LOOP_EVIDENCE_UNQUALIFIED` with
`evidence_exclusion` and `evidence_rows`, and touches nothing. The declared
provenance is threaded from the consumer (`synthetic`) so the loop and the
observer can never disagree about the same run.

**Proof.** `test-evolution-targeted-remediation-2.mjs`
`F1 unqualified evidence is refused BEFORE any durable trigger write and consumes no cooldown`
— refuses a hand-built array, asserts zero trigger records, no trigger-state
file, no candidate; then runs REAL durable evidence over the same signature and
asserts it is NOT gated and records exactly one trigger.

### F2 — declaration fail-open (HIGH)

**Defect.** `readEvolutionProductionDeclaration` returned `declaration: null` for
ANY validation error, and the resolver read the ceiling from
`declarationInputs(null)` → `{}`. So an operator's `proposalOnly:true` next to an
unrelated bad key (a typo, a bad baseline value) resolved to `false`, and the
loop ran in the MUTATING mode. An authority ceiling was silently lost to a typo
elsewhere in the same file.

**Fix**, in `src/evolution/production-declaration.mjs` and
`src/evolution/production-consumer.mjs`:

- the reader returns the RAW parsed `record` alongside the validated
  `declaration`, so a reader can distinguish *no declaration* from *a declaration
  that could not be used*;
- `readDeclaredProposalOnly(record)` is the single reader of the ceiling, over
  the RAW record. A `proposalOnly` declared as a non-boolean is reported as an
  error, never coerced;
- precedence is explicit and stops at the first surface that supplies a value:
  `runnerOpts.evolution.proposalOnly` → `AEGISFLOW_EVOLUTION_PROPOSAL_ONLY` →
  declaration. An explicit boolean at any level ends the search, so a narrower
  `false` is never overridden by a broader `true`, and a declared `false` is not
  overridden by absence;
- an unusable ceiling value, an unreadable/unparsable declaration, and a
  non-boolean `synthetic` all fold into `configurationInvalid`, which the
  consumer reports as `CONFIGURATION_INVALID`. That check now runs **before** the
  inert check, because an invalid declaration also fails to supply `storeRoot` —
  the old order reported a benign `DISABLED`, hiding the real condition.

**Proof.** Six cases in `test-evolution-targeted-remediation-2.mjs`:
declared ceiling surviving an unrelated bad key; non-boolean in the object, the
env and the declaration; an unparsable file; the full precedence matrix; and an
end-to-end case asserting `CONFIGURATION_INVALID`, `cycle_started:false`, zero
triggers, zero candidates, unchanged `git status`/HEAD, no evolution branch.

### F3 — cross-family index aliasing (MEDIUM)

**Defect.** `persistCandidate` (strategy family) and
`deriveImprovementCandidate` (source family) shared ONE index key,
`<signature>@<baseline>`. Whichever family wrote first became the answer for the
other: the loop returned `CANDIDATE_EXISTS` with a candidate of the WRONG family
and never derived the one it was asked for. Reproduced with the reviewer's
probe: a strategy proposal made a later source cycle return `HOLD` carrying the
strategy artifact.

**Fix**, in `src/evolution/candidate.mjs`:

- one namespace per family: `SOURCE` keeps the historical
  `<signature>@<baseline>` key (no migration, no second database, no schema
  change); `AGENT_STRATEGY` uses `AGENT_STRATEGY:<signature>@<baseline>`;
- `indexDerivation` is the single writer: an entry already owned by the SAME
  candidate is an idempotent no-op; an entry owned by a DIFFERENT candidate of
  the SAME family is a conflict that fails closed; an entry belonging to another
  family (or whose artifact is gone) is legacy residue the owning family
  reclaims — the other family's artifact is never touched;
- the SOURCE dedup path additionally verifies the indexed artifact's family, so
  a legacy unqualified entry pointing at a strategy artifact is not accepted as
  a source derivation.

**Proof.** Both orders through the real loop, plus a legacy-store case
(`F3 strategy-first then source`, `F3 source-first then strategy`,
`F3 a legacy unqualified entry…`): each order produces TWO distinct candidates
with TWO family keys; the legacy artifact survives byte-identical.

### F4 — persistence error classification (LOW)

**Defect.** A failure AFTER the candidate file was durable (the derivation-index
write) surfaced as the generic `PERSIST_FAILED`, which the loop reported as
"proposal not persisted". The artifact existed; only the index did not. That is a
false claim about durable data.

**Fix:**

- `writeDerivationIndex` classifies its own failure as
  `EVOLUTION_CANDIDATE_INDEX_WRITE_FAILED`;
- `persistCandidate` and `deriveImprovementCandidate` attach
  `artifact_durable: true` with `candidate_id` / `candidate_path` when the
  artifact landed but the index did not;
- the loop maps that to a NEW verdict-path hold,
  `HOLD / EVOLUTION_LOOP_CANDIDATE_NOT_INDEXED`, distinct from
  `CANDIDATE_NOT_PERSISTED`, and never reports a durable proposal as lost;
- SOURCE derivation failures that were previously **thrown** (and so escaped as
  a generic `CYCLE_FAILED`) are now returned as named holds via
  `derivationFailureHold`, so no persistence failure leaves the loop unclassified.

**Proof.** Five cases: an index-only failure, an artifact-only failure (still
`NOT_PERSISTED`, `artifact_durable:false`), the same for a SOURCE derivation,
identity-conflict refusal, and a retry that repairs the index while leaving
exactly one artifact and the FIRST write's `created_at`.

### F5 — self-deriving provenance parity (LOW)

**Fix.** Same predicate as F1, plus the declared-provenance thread from the
consumer. The self-deriving entry now refuses exactly the shapes the observer
refuses: no rows, a non-object row, a missing journal identity,
`payload.synthetic`, `payload.test_only`, a `SYNTHETIC_EVIDENCE` row, and a
deployment that declares itself synthetic.

**Proof.** A table-driven case over all six shapes (each asserting the reason and
that nothing was written), a declared-synthetic case, a case proving REAL durable
evidence still fires (no over-fencing), and a parity case that feeds the SAME
real journal through the production path and the self-deriving path.

---

## 3. Test evidence

| Suite | Result |
|---|---|
| `test/evolution/` (7 files, was 6) | **104 / 104 PASS** (84 pre-existing + 20 new F1–F5) |
| New file | `test/evolution/test-evolution-targeted-remediation-2.mjs`, 20 cases |
| Host-only suite (`node test/run-suite.mjs`) | **3199 tests, 3182 pass, 15 fail** |
| Host-only at baseline `23cbe67` (same worktree family) | 3179 tests, 3160 pass, 17 fail |

### The 15 host-only failures, classified exactly

They are NOT one class. Measured by running each failing file standalone and
reading the thrown error:

| Class | Count | Files / cases |
|---|---|---|
| `Cannot find package '@earendil-works/pi-ai'` (`ERR_MODULE_NOT_FOUND`, raised from `src/v2/pi-transport-adapter.mjs`) | **14** | 13 whole-file failures (`test/budget/*` ×2, `test/control-plane/*` ×4, `test/governance/test-execution-review-bypass-fence.mjs`, `test/test-sop-scale-bind.mjs`, `test/v2/test-e3-*` ×3, `test/v2/test-pipeline.mjs`, `test/v2/test-pi-transport-adapter.mjs`) + the named case `WP2 T2` inside `test/rollover/test-production-wiring.mjs` |
| `E2 X2 CROSSPROC` in `test/v2/test-e2-reboot-soak-crossproc.mjs` | **1** | a real cross-process checkpoint assertion, not a module-resolution failure |

So the earlier phrasing "15 suites requiring the unrunnable `pi-ai` dependency"
is wrong for exactly one of them. Corrected in §5.

### Regression comparison against the baseline

Set difference over the failing-test names:

```
NEW in head (regressions):  (none)
ONLY in baseline:           L6. concurrent publishers…
                            T36 G1≠G2 detected under concurrent CURRENT mutation…
```

Both `L6` and `T36` are concurrency cases in
`test/governance/test-execution-review-rotation-lifecycle.mjs`. Neither appears
in the 15-failure list the review recorded, and both pass standalone: 3/3 runs
of `test-e2-reboot-soak-crossproc.mjs` + `test-execution-review-rotation-lifecycle.mjs`
at baseline were 16/16 PASS, and `L6` failed 1 of 3 isolated runs earlier with
identical code. They are load-sensitive under `--test-concurrency=4`, not
regressions — which is why the head run shows FEWER failures than the baseline
rather than more.

The test-count delta (+20) is exactly the new file; no pre-existing test was
removed.

Fixtures that the fence legitimately invalidated were corrected rather than the
fence relaxed: `test-evolution-loop.mjs`,
`test-evolution-production-activation.mjs` and
`test-evolution-agent-strategy-evolution.mjs` now stamp
`event_id`/`sequence` on their journal rows, which is what
`RunEvidenceStore.appendEvent` writes. Their intent (downstream stages) is
unchanged; they simply carry valid durable identity now.

No test was deleted. No assertion was weakened. No pre-existing expectation was
re-pinned to make a fix pass: the two failures my own new tests produced first
(`configurationInvalid` ordered after the inert check; a legacy index entry
treated as an owner) were fixed in the SOURCE, not in the tests.

---

## 4. Regression assessment

`git show --stat` of the landed commit `9184961`:

```
 docs/audit/.../REMEDIATION_REPORT.md                    | 281 +++++++
 docs/autonomous-evolution.md                            |  60 +-
 src/evolution/candidate.mjs                             | 162 +++-
 src/evolution/loop.mjs                                  | 154 ++--
 src/evolution/production-consumer.mjs                   |  95 +-
 src/evolution/production-declaration.mjs                |  57 +-
 test/evolution/test-agent-strategy-evolution.mjs        |  15 +-
 test/evolution/test-evolution-loop.mjs                  |  13 +-
 test/evolution/test-evolution-production-activation.mjs |  12 +-
 test/evolution/test-evolution-targeted-remediation-2.mjs | 872 +++++ (new)
 10 files changed, 1610 insertions(+), 111 deletions(-)
```

Five source files, four test files, one doc and one report. No new module, no new
dependency, no new store, no schema change.

Behaviour deliberately preserved:

- G1 fence (synthetic evidence refused before derivation) — test `G1a`–`G1e` PASS;
- G2 durable proposal, idempotent retry, digest re-derivation — `G2a`–`G2d` PASS;
- G3 proposal-only hard stop and its stage trace — `G3a`–`G3f` PASS;
- normal-mode promotion / canary / rollback / circuit breaker / kill switch —
  `N*`, `P*`, `S*`, `R*` PASS;
- the SOURCE index key format is unchanged, so existing stores need no migration.

Production evolution remains **DISABLED**. No `EKM`, `CBM`, production config or
production evolution store was read or written by this card. Every test runs in
`mkdtemp` or a fixture git repository.

---

## 5. Evidence corrections (from the independent review)

These correct claims in earlier card records. They are corrections, not new work.

| Claim in an earlier record | Correction |
|---|---|
| "host-only suite fails identically before and after (15 suites)" | The 15 failures are **not** one class: **14 are `@earendil-works/pi-ai` module-resolution failures** (the package is absent from this checkout — `require.resolve` → `MODULE_NOT_FOUND`), and **1 is `E2 X2 CROSSPROC`** in `test/v2/test-e2-reboot-soak-crossproc.mjs`. Saying "15 suites requiring the unrunnable pi-ai dependency" is inaccurate for the E2 case. |
| OMP binary unchanged relative to the previous audit baseline | The binary is **`omp/18.12.2`, sha256 `abd9a5b0…eee48`**, measured at remediation time. The audit baseline recorded **`omp/18.12.1`, sha256 `fa41b27d…4bac5`**. The change is an INDEPENDENT OMP update, not a result of this card; "unchanged" must not be claimed against the older baseline. |
| original engineering-card traceability | The original `AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REPAIR_1` implementation card text is **not present in this repository or in the session artifacts available to this card**. It is recorded as a traceability gap. It is NOT reconstructed here, and nothing below pretends to be that original. |

Two further notes, offered because they affect how the numbers above read:

- `test/governance/test-execution-review-rotation-lifecycle.mjs` (case `L6`) is
  **flaky**: 1 of 3 standalone runs failed, the other 2 passed with the same
  code. It is not in the 15-failure baseline list.
- The baseline and head runs of the host-only suite were executed from the SAME
  worktree at different commits (`/private/tmp/tr2-base` @ `23cbe67`,
  `/private/tmp/aegis-repair-1` @ remediation head), with `node_modules` shared
  from the canonical checkout, so the `pi-ai` failures are environmental in both.

---

## 6. What this card does NOT claim

- It does not claim PASS. The card's disposition is a remediation report for an
  independent reviewer that did not write this code.
- It does not claim the host-only suite is green. It is compared against the
  baseline failure set, per the card's instruction.
- It does not treat any synthetic fixture as production acceptance.

---

## 7. Durable landing

Precondition check, before any edit (the prior card's landing was already
published, and was NOT reset, amended or rewritten):

| Check | Value |
|---|---|
| `git rev-parse HEAD` (pre-edit) | `23cbe6790facf79757817c8d8f952c7cdb612b3f` |
| `git rev-parse origin/feat/omp-cbm-recovery` | same |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | same |
| `git rev-list --count origin/…..HEAD` | `0` |
| `git status --porcelain` | empty |
| `git stash list` | empty |
| worktrees | `autoloop` @ `8bb72a5`; `aegis-repair-1` @ `23cbe67` |

Post-push verification (after the allowlist commit):

| Check | Value |
|---|---|
| local `HEAD` | `9184961158cbd6da8bc2618c5c7adf9f35987260` |
| `origin/feat/omp-cbm-recovery` (post-fetch) | `9184961158cbd6da8bc2618c5c7adf9f35987260` |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | `9184961158cbd6da8bc2618c5c7adf9f35987260` |
| unpushed commits | `0` |
| `git status --porcelain` | empty |
| `git stash list` | empty |

The commit contains exactly the 10 files itemised in §4. The temporary baseline
worktree used for the host-suite comparison was removed; the throwaway probes
were deleted. `23cbe67` remains reachable, unamended, and published — this card
adds one commit on top of it.

## 8. Handoff to independent review

This card's disposition is **REMEDIATION READY FOR INDEPENDENT RERUN**, not
PASS. Suggested rerun focus, in order:

1. Re-run the three reviewer probes that reproduced F3 and F1/F5 against
   `9184961` and confirm both now fail closed / derive both families.
2. Adversarially verify F2: construct declarations combining a valid ceiling
   with each invalid key, an unparsable file, an empty file, and a
   `proposalOnly` of `0`, `1`, `"true"`, `null`; confirm the resolved ceiling and
   the consumer disposition in every case.
3. Verify F4 by making the index path unwritable in a COPY of a store that
   already holds a candidate, and confirm the artifact survives and the retry
   indexes it without a duplicate.
4. Confirm `test/evolution` is 104/104 at `9184961` and that the host-only
   failure set is a SUBSET of the baseline set.
