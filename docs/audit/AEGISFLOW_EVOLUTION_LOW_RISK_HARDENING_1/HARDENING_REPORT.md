# Evolution low-risk hardening 1 — N1–N4

**Card:** `AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1`
**Baseline:** `b32a8e2` (unchanged, not amended)
**Branch:** `feat/omp-cbm-recovery`
**Scope:** the four LOW findings the independent review left open after
`AEGISFLOW_EVOLUTION_PROPOSAL_ONLY_TARGETED_REMEDIATION_2`. Minimal repair only:
no CBM, no EKM, no production evolution activation, no architecture change.

This document records what changed, how each item is proven, and the activation
boundary for N4. It does **not** claim PASS — that disposition belongs to a
reviewer session that did not write this code.

---

## 1. Prior-card durable landing gate (card §0)

Checked BEFORE any edit in this card.

| Check | Value |
|---|---|
| Remediation 2 independent review | PASS (recorded by the operator's card text) |
| `git fetch origin` | clean |
| `git rev-parse HEAD` (pre-edit) | `b32a8e201de01b73750c43f3cd88d26c13bce3c5` |
| `git rev-parse origin/feat/omp-cbm-recovery` | same |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | same |
| `git log origin/feat/omp-cbm-recovery..HEAD --oneline` | empty (0 unpushed) |
| `git stash list` | empty |
| other worktree | `/Volumes/NVM2T/Development/repos/autoloop` @ `8bb72a5`, branch `audit/omp-native-capability-dispatch-1`, clean |

The prior card's Terminal PASS fence is a controller-side act. This card does
**not** fabricate a Reviewer or Controller record: it verified that the
mechanical landing (commit → push → remote HEAD → clean worktree) is complete
and proceeded. Any controller fence record remains the controller's to write.

**A note on how this card was resumed.** The implementation session that started
this card (`01a154cf…`) ended with a provider error, not a tool failure: the
model gateway returned `504 Gateway time-out` (`merge-gateway`,
`deepseek/deepseek-v4.1-flash-1017`) on the turn after
`test/evolution` had reached 104/104. Its uncommitted work was preserved
verbatim before continuing (see §6); nothing was reset, stashed away, or
re-derived from scratch.

---

## 2. N1 — candidate conflict classification (LOW)

**Finding.** Two different `AGENT_STRATEGY` candidates for one
signature/baseline reported the identity conflict as
`CANDIDATE_NOT_INDEXED` / `INDEX_WRITE_FAILED`, which reads as an index I/O
fault. The operator is sent to inspect storage when the actual fact is a
competing proposal.

**Fix** (`src/evolution/candidate.mjs`, `src/evolution/loop.mjs`):

- a new closed code `EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT`
  (`HOLD / EVOLUTION_CANDIDATE_CONFLICT`) and its loop projection
  `EVOLUTION_LOOP_HOLD.CANDIDATE_CONFLICT`;
- `indexDerivation` reports a healthy-but-refusing index as
  `status: "CONFLICT"` with `conflict: { kind, owner_id, family, key }`, where
  `kind` is `different_candidate` or `unreadable_owner`; an actually unwritable
  index stays `status: "WRITE_FAILED"` with `INDEX_WRITE_FAILED`;
- `persistCandidate` classifies a same-id/different-content artifact as
  `CANDIDATE_CONFLICT` (`kind: "different_content"`) instead of
  `PERSIST_FAILED`;
- `derivationIndexHold` picks the code from `index.code` FIRST and only then
  falls back to the write-failure classification;
- the loop's `persistenceHold` classifies by CODE before it reads
  `artifact_durable`, so a conflict can carry `artifact_durable: true` without
  being mistaken for an index failure;
- the proposal-only proof path distinguishes "readable but a different
  immutable proposal" (conflict) from "not durably readable" (not persisted).

**Invariants preserved.** First-writer-wins; the index never repoints an owner;
no second store; the candidate schema, the derivation-index format and the
SOURCE key are unchanged; idempotent replay still returns `EXISTING`; the
`artifact_durable` flag keeps its existing meaning.

**Proof** — `test/evolution/test-evolution-low-risk-hardening-1.mjs`:

| Case | Asserts |
|---|---|
| `N1 the store classifies an identity conflict separately from an index write failure` | conflict code + `conflict.kind/owner_id/key`; owner artifact and index untouched; the SAME store shape with an unwritable index still yields `INDEX_WRITE_FAILED` |
| `N1 a same-id artifact with different content is a conflict … and replays stay idempotent` | `EXISTING` on replay; `different_content` conflict; first write remains authoritative |
| `N1 the LOOP reports CANDIDATE_CONFLICT … and keeps the owner` | loop hold code, `stage: "proposal"`, `conflict.owner_id`, `artifact_durable: true`, no `proposal` claim, no authorization stage, repo untouched |

---

## 3. N2 — synthetic configuration typing (LOW)

**Finding.** A non-boolean `synthetic` could be read as `false`: the runner
object was only compared with `=== true`, and an env string outside
`1/true/0/false` fell through. A malformed configuration therefore read as
production evidence and let a cycle run on data the operator had marked
otherwise.

**Fix** (`src/evolution/production-consumer.mjs`):

- one fail-closed resolution for all three governed surfaces, in precedence
  order — `runnerOpts.evolution.synthetic`, `AEGISFLOW_EVOLUTION_SYNTHETIC`
  (and its legacy alias, through the shared `readConfigEnv`), the deployment
  declaration;
- a type that is not `boolean` (object surface) or not one of
  `1/true/0/false` (env) or not `boolean` (declaration) produces
  `syntheticInvalid`, which folds into `configurationInvalid` ⇒
  `CONFIGURATION_INVALID` and **no cycle**;
- no implicit conversion anywhere: `"true"`, `"false"`, `1`, `0`, `null`, `{}`,
  `[]` are all rejected, never coerced;
- legal booleans keep the previous semantics exactly (any surface saying `true`
  marks the run synthetic; the provenance policy is unchanged).

**Proof:**

| Case | Asserts |
|---|---|
| `N2 a non-boolean synthetic is rejected on the runner object` | 7 bad shapes rejected; `synthetic` stays `false`; legal `true`/`false` unchanged |
| `N2 a non-boolean synthetic is rejected in the environment (brand and legacy names)` | 4 bad strings rejected on the brand name; a malformed LEGACY value is rejected on the same surface; all four legal spellings resolved exactly |
| `N2 a non-boolean synthetic is rejected in the deployment declaration` | declaration rejection + legal boolean accepted |
| `N2 an unusable synthetic starts ZERO cycles and performs ZERO mutation (end to end)` | real `runAdmittedGraph`: run still `PASS`, disposition `CONFIGURATION_INVALID`, `cycle_started:false`, zero outcomes, zero triggers, no trigger-state file, no candidate, repo byte-clean, HEAD unmoved |

The declaration-only case already passed before this card's consumer change
(the type was validated in `production-declaration.mjs`); it is pinned here so
the three surfaces stay consistent.

---

## 4. N3 — consumer evidence guard (LOW)

**Finding.** `observation.evidence_qualified` is a field on an object the caller
hands in. A non-production direct caller could forge it, and the consumer would
write a durable trigger record and consume the signature's cooldown before the
loop's own fence ever ran.

**Fix** (`src/evolution/production-consumer.mjs`):

- `revalidateEvidenceProvenance` re-reads the run's durable journal with the ONE
  shared reader (`readObservationJournal`) and re-applies the ONE shared
  predicate (`assessEvidenceProvenance`) **before** the trigger gate, the
  durable trigger write, the cooldown and the scheduled cycle;
- `signalEvidenceRefusal` additionally requires every fired signal (except
  `QUALIFIED_PATTERN_EVIDENCE`, which cites pattern digests by construction) to
  cite at least one journal-shaped reference (`evt_<n>_<hex>`) that the journal
  actually holds. A forged signal therefore cannot pass by citing nothing, and
  cannot pass by citing fiction;
- a refusal is total: `NO_QUALIFIED_TRIGGER` with `evidence_reverified: true`,
  zero trigger records, zero cooldown consumed, zero cycles;
- a caller that supplies no journal identity cannot be verified and is refused —
  never trusted by default;
- real production journals keep their normal behaviour, and the existing
  `evidence_qualified === false` short-circuit is unchanged.

**Design note (deliberate, not an expansion).** The "cites nothing" half was
added during this card's own verification: with only the "cites unknown rows"
half, a forged signal that listed no refs still reached the durable write over a
real journal. `QUALIFIED_PATTERN_EVIDENCE` is explicitly exempt because its refs
are pattern digests, not journal rows; the exemption is asserted by a test.

**Disclosed side effect.** The shared journal reader (`readObservationJournal`)
initialises the evidence store's own execution directory (owner-only, empty) when
it is absent. That is pre-existing reader behaviour — the observer already does
it on the production path before this guard runs — and it writes no journal row,
no trigger record and no cooldown slot. It is verified by probe and recorded
here rather than hidden.

**Proof:**

| Case | Asserts |
|---|---|
| `N3 a forged evidence_qualified with no durable journal writes NOTHING` | refused; no trigger-state file; no candidate |
| `N3 a forged observation over synthetic journal evidence writes NOTHING` | refused with the `synthetic_evidence:` reason |
| `N3 a forged observation citing rows absent from a REAL journal writes NOTHING and spends no cooldown` | refused; then a REAL production run over the SAME store still reaches `CYCLE_STARTED` and records exactly one trigger — proving no cooldown was spent |
| `N3 a forged signal citing NO journal rows is refused over a real journal` | refused with `cites no durable journal row` |
| `N3 a real journal with matching evidence refs still fires (no over-fencing)` | `CYCLE_STARTED`, one durable trigger |
| `N3 a signal with no journal refs (pattern-derived) is not refused by the ref check` | `QUALIFIED_PATTERN_EVIDENCE` still starts a cycle |

---

## 5. N4 — production activation boundary (record only)

**Not enabled. Not modified.** This section records the risk; it changes no
production declaration, adds no auto-activation, and performs no production
mutation.

Current state, measured (not asserted from memory):

- this checkout exports no `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` and no
  `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG`;
- without a resolvable declaration, `resolveEvolutionProductionConfig` returns
  `enabled: false` with `missing: [storeRoot, checkpointRoot, repoRoot]`, and
  `consumeEvolutionObservationForProduction` reports `DISABLED`;
- the wiring exists in `src/admission/admission-gate.mjs` (post-result
  observation → consumer), so the reason production evolution is inactive is
  **the absent declaration and policy, not a missing code path**. The earlier
  card's summary ("inactive because it is not wired") is imprecise: it is
  inactive because the governed inputs are not declared.

**The risk, stated precisely.** If an operator points
`AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` at a declaration whose
`proposalOnly` is absent or `false` — and issues policy — the loop can enter the
MUTATING mode (authorization → mutation in an isolated worktree → fitness →
review → promotion → canary). It cannot self-approve: promotion without an
operator-designated reviewer fails closed.

**Activation conditions.** Before production evolution is enabled, an explicit
operator authorization must separately confirm, at minimum:

1. the declaration exists, validates, and its `proposalOnly` value is a
   deliberate choice;
2. a policy is issued, unexpired, and its scope/risk classes are the intended
   ones;
3. a reviewer identity is designated (otherwise promotion always fails closed);
4. the kill switch is reachable and its state is known;
5. the canary window and the fitness metric are acceptable for the workload.

Nothing in this card automates any of that. This section is the boundary record
the card asks for.

---

## 6. Verification

| Suite | Result |
|---|---|
| `test/evolution/` (8 files, was 7) | **117 / 117 PASS** |
| New file | `test/evolution/test-evolution-low-risk-hardening-1.mjs`, 13 cases (N1 ×3, N2 ×4, N3 ×6) |
| Pre-existing evolution cases | 104 unchanged and still PASS; one assertion updated for N1 (see below) |
| Host-only suite | recorded in §6.1 below |

### 6.1 Host-only comparison

| Run | Totals | Failing names |
|---|---|---|
| head (this card) | 3212 tests, 3196 pass, **14 fail**, 2 skipped | the 14 below |
| prior card head `b32a8e2` (recorded) | 3199 tests, 3182 pass, 15 fail | 14 × `@earendil-works/pi-ai` + `E2 X2 CROSSPROC` |

Every one of this run's 14 failures is the SAME class: `ERR_MODULE_NOT_FOUND:
Cannot find package '@earendil-works/pi-ai'` raised from
`src/v2/pi-transport-adapter.mjs` (the package is absent from this checkout; the
14 are 13 whole-file failures plus the named case `WP2 T2` inside
`test/rollover/test-production-wiring.mjs`):

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

The head failure set is a strict SUBSET of the prior card's: the flaky
`E2 X2 CROSSPROC` did not reproduce, and no new class appeared. The +13 test
count is this card's new file; no pre-existing test was removed.

### 6.2 The one pre-existing assertion that changed

`test/evolution/test-evolution-targeted-remediation-2.mjs`, case
`F4 the index never repoints an identity it already owns (conflict fails
closed)`, previously asserted only `status: "CONFLICT"` and `indexed: false`.
It now also asserts `code === CANDIDATE_CONFLICT` and
`conflict.kind === "different_candidate"`.

This is not a re-pin of incidental behaviour: N1 *requires* the distinct
classification, and the test's own stated intent ("conflict fails closed", "the
original owner is untouched") is unchanged and still asserted. No assertion was
weakened or removed.

### 6.3 Regression direction, stated honestly

The three N2/N3 end-to-end cases were run against the PREVIOUS consumer
(`git checkout -- src/evolution/production-consumer.mjs`) and FAILED there
(`CYCLE_STARTED` where `NO_QUALIFIED_TRIGGER` was required; missing
`configurationInvalid`), then passed with the repair restored. The N1 cases
exercise codes that do not exist at baseline, so they cannot pass there by
construction.

---

## 7. Scope check

| Area | Touched? |
|---|---|
| `src/evolution/candidate.mjs` | yes — N1 classification |
| `src/evolution/loop.mjs` | yes — N1 hold projection + shared persistence classifier |
| `src/evolution/production-consumer.mjs` | yes — N2 typing, N3 provenance guard |
| `src/evolution/production-declaration.mjs` | **no** |
| CBM / EKM / OMP binary | **no** |
| production config / production store | **no** (no production declaration exists here; none was created) |
| `docs/autonomous-evolution.md`, `docs/configuration.md` | yes — operator-facing contract for N1/N2/N3 |
| new dependency / store / schema | **no** |

No second persistence store, no new database, no proxy layer, no architecture
refactor.

---

## 8. Durable landing

Pre-edit gate: §1. Post-push verification is recorded after the allowlist
commit; the exact file list is this card's change surface (§7) plus this report
and the new test file.

## 9. Handoff to independent review

Disposition of this card: **REMEDIATION READY FOR INDEPENDENT RERUN**, not PASS.

Suggested rerun focus, in order:

1. **N1** — create two distinct strategy candidates for one signature/baseline,
   persist both, and confirm the second reports `CANDIDATE_CONFLICT` with the
   first as `owner_id`; then make the index path unwritable and confirm the SAME
   store shape reports `INDEX_WRITE_FAILED` instead. Confirm the two are never
   confused in either ordering.
2. **N2** — resolve `synthetic` as `"true"`, `"false"`, `1`, `0`, `null`, `{}`,
   `[]` on each of the three surfaces (including the legacy env alias) and
   confirm `CONFIGURATION_INVALID` with no trigger, no cooldown, no cycle.
3. **N3** — call `consumeEvolutionObservationForProduction` directly with
   `evidence_qualified: true` and (a) no journal, (b) a synthetic journal,
   (c) a real journal with fictional refs, (d) a real journal with no refs.
   Confirm zero trigger-state writes in every case, then confirm a real run
   still fires (no cooldown was consumed).
4. Confirm `test/evolution` is 117/117 and that the host-only failure set is a
   subset of the baseline set.
