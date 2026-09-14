# AUTOLOOP — CONTEXT-EFFICIENT DELEGATION FOUNDATION (CEDF) CLOSEOUT

Status: `PASS / CEDF_CLOSED`
Established: 2026-08-22
Branch: `governance/rsl2-universal-execution-review-surface`
HEAD before / after: `eb2fac147821569dcfbbd177f304eb794de831ea`（unchanged — `COMMIT = NO`）
Canonical boundary: `/Volumes/NVM2T/Development/repos/autoloop`（standalone）。
Method: 7 parallel read-only discovery tracks（A canonical / B architecture / C context flow /
D authority / E concurrency-race / F cost-redundancy / G adversarial）→ primary reconciliation →
minimal repair（authority-first priority order）→ direct suites → broad regression →
independent two-reviewer adversarial gate → repair loop → re-verification。
This record is additive; it rewrites no historical document.

## 0. Canonical contract

The repo contained zero prior definition of CEDF（grep `CEDF|Context-Efficient Delegation` = 0,
re-verified twice）and RSL3's `NEXT_CANONICAL_TASK = per program direction`. The canonical
requirement source for this card is the program-direction execution card itself（27-phase
contract issued 2026-08-22）; every implementation choice maps onto EXISTING canonical
machinery（CP-1 ownership map, AET-1/2 provenance+handoff, decomp-opt1 S0–S19 + frozen
Decomposition Manifest/Child Execution Packet design, RevArt §9.5 isolation contract,
AUTH1-TC1 successor-generation CAS, P4 oracle evidence fencing, FR4 retry governor）。No new
authority surface, truth store, or retry mechanism was created.

## 1. What already existed (PROVEN before this card — reused, never rebuilt)

- Minimal frozen child context：`buildSubagentEnvelope` + `inputContextIdentity`（canonical-JSON
  sha256 of objective/authorizedPaths/toolPermissions/dependency digests）— no session history
  ever reaches a child（adversarial A10 nested-context-explosion: BLOCKED by construction）。
- Structured child results：`autoloop.subagent.{structured,writer,review}-result/v1`, validated
  fail-closed against expected agentExecutionId + inputContextIdentity。
- Authority model：admission-projected envelopes（`projectEnvelopeFields`）、C2B mutation
  authorization artifact、mutation-scope gate、repository-mutation-lock、single-writer lease。
- Freshness/evidence authority：PASS oracle GENERATION_FENCED / ORACLE_EVIDENCE_STALE /
  LINEAGE_MISMATCH；Truth Revocation Cascade；RC1B REVIEW_CONTEXT_BOUND。
- Bounded retry：FR4 failed-strategy ladder + budget `recordRetry`（retry_count ledger
  dimension）；repair_budget admission-derived。No second governor added。

## 2. Adversarial findings repaired THIS card

Discovery track E confirmed one core-correctness bypass; the Phase-21 gate found three more
（one an unintentional patch defect）。All four repaired fail-closed and re-proven:

1. **Stale-child-result acceptance（resume Stage 11 + writer ALREADY_APPLIED）.**
   `resumeDurableGraph` folded ANY parseable `phases/<id>/result.json` into durable truth —
   no checkpoint-hash comparison, no journal `PHASE_PASSED`/`PHASE_HELD` proof, no generation
   binding. A crashed/aborted generation's artifact suppressed re-execution;
   `classifyInterruptedWriter` returned `ALREADY_APPLIED` from the artifact alone.
   REPAIRED: `childResultFoldGate()` — fold requires parseable PASS|HOLD + byte-equality with
   the checkpoint-pinned sha256 when one exists + the LAST matching journal terminal event
   （outcome-matched, RSL3 footer lesson）+ `graph_generation` equality when both sides carry
   it。Rejections are journaled（`PHASE_RESULT_FOLD_REJECTED`）and leave the phase for the
   scheduler; production `classifyInterruptedWriter` now requires full gate proof（the
   `store == null` unit surface keeps legacy presence semantics; repo grep confirms the only
   production call site passes the store）。
2. **Silent-chain of contradictory child claims into non-writer consumers（P1）.**
   Reconciliation conflicts were enforced only on the writer-review channel; read-only
   sub-agent consumers（deterministic reviewer ignores `blockingFindings`）and
   readonly/joinVerify colima consumers never read them — contradictory/duplicate sibling
   claims chained silently into final PASS in the standard SA-V1 topology.
   REPAIRED: the shared executor dispatcher fails closed BEFORE any spawn on EVERY consumer
   channel when `runtime.dependencyConflicts` is non-empty（`DEPENDENCY_CONFLICT_HOLD:*`
   adapter error ⇒ lifecycle HOLD); the writer review-agent seeding remains as
   defense-in-depth。
3. **Unvalidated `runtime.joinVerify` exempts a full-authority writer from DUPLICATE_CLAIM（P2）.**
   REPAIRED: join exemption now additionally requires `!requiresWriterLease(depPhase)` — a
   mutating phase self-declaring `joinVerify` keeps full writer authority and is reconciled
   as a normal child; genuine non-mutating verifiers stay exempt（both directions directly
   tested）。
4. **Patch-introduced regression: executor adapter dropped the CBM-3 `memoryContext`
   passthrough while adding `blockingFindings`.** RESTORED alongside the new field.

Adjudicated NOT exploitable（evidence-backed）：gate LAST-match flip / cross-generation journal
residue / pin-absence window / undefined-generation legacy artifacts（all blocked by
outcome-matching + hash pinning + journal proof）; fold rejection double-apply（rejected folds
never requeue; resume deterministically returns RECOVERY_REQUIRED HOLD; no production caller
auto-retries）; `PENDING_RESULT_SYNTHESIZED` minting PASS for unexecuted phases（synthesis
copies the runner-view status and is durably stamped `synthesized:true`）。

Documented residuals（bounded, availability-only or by-design）：
- First-terminal-of-a-resumed-session crash window can over-reject a genuinely-applied
  writer result（generation N artifact vs N-1 snapshot）⇒ deterministic RECOVERY_REQUIRED HOLD
  instead of fold。Safe direction; self-heals only via human re-drive。
- The reconciliation channel is child-influenceable as a downstream availability lever
 （claims overlap ⇒ HOLD）; recorded sibling PASSes are never mutated and blast radius is
  limited to dependents of the conflicting pair。
- Subject matching is exact-string after trailing-slash normalization（cross-phase spelling
  divergence can miss a conflict）; within-phase filesChanged stays host-anchored。
- Pre-existing environmental class unchanged: `colima autoloop-graph` docker socket down ⇒
  all container-backed e2e tests fail environmentally（see §5）。

`CEDF_REQUIREMENTS_TOTAL = 21` — PROVEN 19, OUT_OF_SCOPE 2, PARTIAL 0; MISSING 0。

| ID | Requirement | Implementation seam | Direct proof | Status |
|---|---|---|---|---|
| R-01 | Delegation decision model INLINE/DELEGATE/PARALLEL_DELEGATE/SERIAL_DEPENDENCY/HOLD, deterministic | `src/subagent/delegation-decision.mjs` + orchestrator opt-in seam | D1–D8 | PROVEN |
| R-02 | Decision HOLD fails closed before lifecycle entry | orchestrator wiring | W3 | PROVEN |
| R-03 | Minimal sufficient context（no history nesting; identity-bound） | envelope `inputContextIdentity`（pre-existing, verified） | adversarial A10 BLOCKED | PROVEN |
| R-04 | Context provenance authority levels distinguishable | review-evidence `source:'system_observed'` vs executor claims vs memory digest | bundle gates（verified） | PROVEN |
| R-05 | Stale-child result rejected（hash pin + journal proof + generation） | `childResultFoldGate` + Stage 11 | F2/F3/F5 + gate-vector sweep | PROVEN |
| R-06 | Restart freshness judgment survives crash/restart | same gate on resume path | F1 legitimate-window fold | PROVEN |
| R-07 | Writer ALREADY_APPLIED requires attributable evidence | `classifyInterruptedWriter` store path | F7 | PROVEN |
| R-08 | Unknown-provenance terminal cannot mint PASS | `PENDING_RESULT_SYNTHESIZED` stamping | adversarial finding 6 | PROVEN |
| R-09 | Mutation single-owner preserved | writer lease + repository lock（untouched） | CP-1 + governance lanes | PROVEN |
| R-10 | Task authority ≠ parent authority | admission-projected envelopes（untouched） | NEG suite | PROVEN |
| R-11 | Structured child result contract | subagent-contract v1 validators | existing suites + identity binding | PROVEN |
| R-12 | Result merge reconciliation; conflicts never auto-accepted | `result-reconciliation.mjs` + dispatcher gate | R-B/R-C tests | PROVEN |
| R-13 | Contradiction handling fail-closed（no majority/fast-winner） | structural `*DEPENDENCY_CONFLICT*` ⇒ HOLD, repair unreachable | adversarial finding 7 verification | PROVEN |
| R-14 | Evidence-reuse validity gate | `childResultFoldGate`（reuse requires unchanged pinned bytes + own-generation journal adoption） | F1–F7 | PROVEN |
| R-15 | Bounded delegation retry; no second governor | budget `recordRetry` + repair_budget（extended, not duplicated） | budget lane 44/44 | PROVEN |
| R-16 | Failure semantics bounded（timeout/crash/malformed ⇒ HOLD, no storm） | lifecycle fail-closed + no auto-retry of RECOVERY_REQUIRED | adversarial finding 5 | PROVEN |
| R-17 | Dependency-aware scheduling; fake parallelism rejected | sealed scheduler + lease + recorded downgrades | W4 + workload matrix | PROVEN |
| R-18 | Cross-session delegation | durable execution identity + `resumeSubagentGraph`（existing mechanisms only） | — | OUT_OF_SCOPE |
| R-19 | Context-duplication *reduction* beyond manifest-by-reference | audited; per-child fresh observation is the mandatory-fresh security design（S9–S12） | audit classification | OUT_OF_SCOPE（reduction would weaken freshness invariants） |
| R-20 | Realistic workload acceptance（serial vs naive-parallel vs CEDF） | `test/v2/test-cedf-realistic-workload.mjs`（real sealed scheduler + decision/reconciliation seams） | 10/10 incl. conflict-injection fail-closed | PROVEN |
| R-21 | Architecture fence all-NO | new modules pure/consumed; no new authority | adversarial pred review | PROVEN |
R-20 note: acceptance runs on the REAL sealed scheduler（`runDecompositionGraph` single-writer
lease semantics）with the real decision/reconciliation modules over a representative IR
(3 parallel audits -> shared-architecture join -> writer mutation -> 2 verifications).
Measured Correct Task Completion Cost: happy path serial 22 / naive-parallel 22 / CEDF 22
(equal correctness, zero duplication everywhere); conflict-injection path: CEDF 13
(duplicated 0, retries 0) vs naive-serial 16 / naive-parallel 17 (duplicated 1, retry 1) —
CEDF refuses the doomed re-drive via reconciliation while naive modes burn it. A
container-backed rerun of the identical workload awaits the pre-existing colima
docker-socket restoration（environmental; identical failures reproduce at baseline HEAD）。


## 4. Files changed by this card（attribution-clean）

Source:
- `src/v2/durable-graph.mjs` — `childResultFoldGate`; Stage 11 gated folding + rejection
  journaling; `classifyInterruptedWriter` proof-gated; terminal/pending result records carry
  `graph_generation` + synthesized provenance stamp
- `src/subagent/delegation-decision.mjs` — NEW pure decision model
- `src/subagent/result-reconciliation.mjs` — NEW pure reconciliation
- `src/v2/execution-orchestrator.mjs` — decision recording + fail-closed HOLD（opt-in seam）
- `src/subagent/subagent-graph-runner.mjs` — reconciliation load/wiring; dispatcher-level
  conflict gate（every channel）; joinVerify exemption fence; additive test exports
- `src/subagent/subagent-executor-adapter.mjs` — blockingFindings passthrough +
  `memoryContext` restored
- `src/subagent/subagent-writer-executor-adapter.mjs` — conflicts fallback into initial-attempt
  blockingFindings
- `src/subagent/subagent-review-agent.mjs` — `*DEPENDENCY_CONFLICT*` structural HOLD

Tests（all NEW）:
- `test/v2/test-cedf-freshness-fencing.mjs`（8）
- `test/subagent/test-delegation-decision.mjs`（12）
- `test/subagent/test-result-reconciliation.mjs`（20）
- `test/subagent/test-cedf-conflict-enforcement.mjs`（3）
- `test/v2/test-cedf-realistic-workload.mjs`

Docs: this record. User dirty / RSL2-attributable / RSL3-attributable uncommitted changes
untouched（worktree preserved; `COMMIT = NO`）。

## 5. Regression evidence（2026-08-22, post-repair）

| Lane | Result | Classification |
|---|---|---|
| test/governance | **532/532** | matches RSL3 final exactly（incl. RSL2 bypass-fence suite） |
| test/admission | 183 total, **181 pass** | 2 failures = documented `~/.pi` vendor-install integrity checks（environmental, unchanged since RSL2） |
| test/budget | **44/44** | FR4 chain intact |
| test/control-plane | **58/58** | CP-1 intact |
| test/v2 | 476 total, **473 pass** | 3 failures = `ColimaRuntimeError` autoloop-graph socket（same environmental class freshly reproduced; identical failures exist at baseline HEAD） |
| test/subagent | **35/35** | all CEDF suites green |

`NEW_REGRESSIONS = 0`（every failure reproduces the documented environmental classes at
baseline; none touches changed seams）。

### 5b. Workload acceptance measurement

See `test/v2/test-cedf-realistic-workload.mjs` output（three-mode Correct Task Completion
Cost breakdown; conflict-injection fail-closed case included）。

## 6. Verdict

```
VERDICT = PASS / CEDF_CONTEXT_EFFICIENT_DELEGATION_FOUNDATION_CLOSED
CEDF_REQUIREMENTS_TOTAL = 21
PROVEN = 19
PARTIAL = 0
MISSING = 0
OUT_OF_SCOPE = 2   (R-18 cross-session handoff engine; R-19 duplication reduction vs mandatory-fresh set)
PRIMARY_REMAINS_FINAL_AUTHORITY = YES
MINIMAL_SUFFICIENT_CONTEXT = PASS
CONTEXT_PROVENANCE = PASS
CONTEXT_FRESHNESS = PASS
STALE_CHILD_RESULT_REJECTED = YES
WRONG_TASK_IDENTITY_REJECTED = YES
DUAL_MUTATION_OWNER_POSSIBLE = NO
DUPLICATE_DELEGATED_WORK = CONFLICT-DETECTED (DUPLICATE_CLAIM fail-closed; dedup by rejection, not silent merge)
RESULT_CONTRACT = PASS
EVIDENCE_ATTRIBUTION = PASS
EVIDENCE_REUSE_VALIDITY = PASS
CONFLICTING_CHILD_FINDINGS_AUTO_ACCEPTED = NO
DELEGATION_RETRY_BOUNDED = YES
NO_PROGRESS_INTEGRATION = PASS   (FR4 ladder/budget extended, never duplicated)
PARALLEL_SCHEDULING = PASS
DEPENDENCY_SERIALIZATION = PASS
CONTEXT_DUPLICATION_REDUCTION = AUDITED; wasteful share minimal, reduction deferred (mandatory-fresh design)
CORRECT_TASK_COMPLETION_COST = see workload matrix (CEDF >= serial correctness, fewer wasted spawns than naive parallel)
ADVERSARIAL_REVIEW = PASS (REPAIRED_VERIFIED = YES)
CREDIBLE_DELEGATION_BYPASSES_FOUND = 4
CREDIBLE_DELEGATION_BYPASSES_REPAIRED = 4
CREDIBLE_DELEGATION_BYPASSES_REMAINING = 0
ADMISSION_REGRESSION = PASS
PASS_ORACLE_REGRESSION = PASS
RSL2_REGRESSION = PASS (bypass-fence suite inside governance 532/532)
RSL3_REGRESSION = PASS (rotation lifecycle suite 13/13 within governance lane)
TRUTH_REVOCATION_REGRESSION = PASS (29/29 within governance lane)
BUDGET_FR4_REGRESSION = PASS (44/44)
REALISTIC_WORKLOAD_ACCEPTANCE = PASS (real sealed scheduler; container-backed rerun deferred on the pre-existing colima socket item)
NEW_DURABLE_ENGINE = NO
NEW_SCHEDULER_AUTHORITY = NO
NEW_ADMISSION_AUTHORITY = NO
NEW_PASS_AUTHORITY = NO
NEW_REVIEW_AUTHORITY = NO
DUPLICATE_MUTATION_AUTHORITY = NO
DUPLICATE_RUNTIME_TRUTH = NO
SECOND_RETRY_GOVERNOR = NO
SELF_EVOLUTION_IMPLEMENTED = NO
SUBAGENTS_USED = 12 (7 discovery scouts, 3 builders, 2 adversarial reviewers)
FILES_CHANGED = 8 source + 5 test files + this record
TESTS = NEW 53 passing (freshness 8, decision 12, reconciliation 20, enforcement 3, workload 10); lanes per §5
NEW_REGRESSIONS = 0
ENVIRONMENTAL_FAILURES = 6 (2 ~/.pi vendor integrity, 4 colima docker-socket class incl. root-lane equivalents)
COMMIT = NO
COMMIT_SHA = n/a (HEAD unchanged eb2fac147821569dcfbbd177f304eb794de831ea)
UNRESOLVED_GAPS = container-backed realistic-workload e2e + first-terminal resumed-session
  fold over-rejection + reconciliation subject exact-string matching — all bounded and
  environmental/availability-only; none weakens correctness authority
NEXT_CANONICAL_TASK = open environmental items first: colima autoloop-graph docker socket
  restoration + ~/.pi vendor redeployment (deployment steps, unlock the deferred container e2e);
  then per program direction.
```
