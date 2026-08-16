# DE-1 External Review Verdict — HOLD / DE1_RESEARCH_EXTENSION_REQUIRED

## Review Identity

- CARD_ID: `AUTOLOOP-PI-GRAPH-DE1`
- CARD_TITLE: Durable Execution / Crash-Recovery Architecture & Bake-off
- CARD_TYPE: research
- GRAPH_RUN_ID: `de1-self-closeout-20260808`
- REVIEW_BUNDLE_IDENTITY: `aedcafcc8453bc9346e2abaceafb6b7b7615636eafc8c3c9e167773cde3e867b`
- REVIEW_BUNDLE_SHA256: `ae31691b15dd4257f28bf18d1aec9443b554e0970902f6dc273c31ccbeee68a9`
- BUNDLE_PATH: `docs/pi-graph-output/de1/card-closeout-bundle-20260808-aedcafcc.txt`
- REVIEWER_IDENTITY: Controller / External Reviewer
- REVIEWED_AT: `2026-08-08T04:28:47Z`
- VERDICT: **HOLD**
- HOLD_CODE: **DE1_RESEARCH_EXTENSION_REQUIRED**
- FINDING_CODE: **DE1_EXTERNAL_CANDIDATE_BAKEOFF_INCOMPLETE**

## Verdict

`HOLD / DE1_RESEARCH_EXTENSION_REQUIRED`

The DE-1 research has high value and its central architectural finding is
accepted — **AutoLoop does not lack a durable engine; the production Graph
path (STACK_B / `runColimaGraph`) has not been wired to the existing durable
stack (STACK_A)**. The outcome points to **Existing AutoLoop + DE-2 hardening**
as the most likely final direction.

But the bundle cannot be formally closed as
`PASS / EXISTING_DURABLE_EXECUTION_SELECTED`, because the external-candidate
bake-off was never actually run. The formal selection verdict is therefore
downgraded to **PROVISIONAL: EXISTING AUTOLOOP LEADS**, pending a minimal live
comparison (DE-1R).

The graph-internal repair budget (`REPAIR_BUDGET_MAX: 1`, `REPAIR_BUDGET_USED: 1`)
is exhausted, so this finding is **not** closable as an ordinary bounded repair
within the existing bundle. It requires a small research-extension card
(`DE-1R`) that runs the missing external-candidate live prototype bake-off, and
then a re-application of the selection rubric.

---

## 1. Blocking Finding

The bundle's Executive Summary and Architecture sections claim:

> "the same real-SIGKILL failure-injection bake-off"

and select Existing AutoLoop as the winner on that basis.

The bundle's own Known Risks (section 21) then admit:

> "Temporal/Restate were not executed as full server deployments in this
> bake-off; the comparison is design/security/complexity-grounded"

These two statements cannot jointly support a **fair** bake-off. The original
DE-1 requirements were explicit:

- Existing / Temporal / Restate compared fairly;
- the **same failure harness** executed;
- failure injection apples-to-apples;
- correctness / recovery / cost actually measured;
- external frameworks must not be reduced to paper evaluation merely because
  they are more work to run.

### What was actually completed

| Candidate | Live SIGKILL failure injection | Recovery measured | Evidence |
|---|---|---|---|
| **A — Existing AutoLoop** | Yes — T0–T12, 22 runs, 2 kill modes | Yes — 9 recovery PASS / 13 recoverability fail, all safety hard gates held | `de1-bakeoff-results.json` |
| **B — Temporal** | **No** — never deployed (server + DB not run) | **No** | design/security/complexity research only (`de1-candidate-research.json`) |
| **C — Restate** | **No** — never deployed | **No** | design/security/supply-chain research only; fails Stage 13 (`de1-security-findings.json`) |

Therefore: **Existing is the leading candidate, but has not been demonstrated
to beat Temporal / Restate by measurement.** The "same bake-off" claim in the
Executive Summary overstates the evidence.

---

## 2. Accepted Results (not overturned)

- **STACK_A / STACK_B distinction** — stands. STACK_A (journal + atomic
  checkpoint + fingerprint chain + safe resume + manifest) is durable; STACK_B
  (production Graph path via `runColimaGraph` → `runExecutionOrchestrator`
  directly) is in-memory, crash = full re-run. The dominant gap is wiring, not
  engine capability.
- **DurableExecutionProvider 12-method seam** — stands; STACK_A implements all
  12 methods natively (`de1-provider-contract.json`, 12/12).
- **D1–D8 invariants** — stands as the failure-model/invariant framing.
- **Existing AutoLoop bake-off results** — stand: 22 runs, 9 recovery PASS,
  13 recoverability fails, but **all safety hard gates held**:
  - lost completed result = 0
  - duplicate writer mutation = 0
  - false PASS = 0
  - authority escalation = 0
  - The 13 fails concentrate in F1 (resume post-head whitelist:
    `DAG_ACCEPTED / PHASE_STARTED / EXECUTOR_COMPLETED / REVIEWER_COMPLETED /
    PHASE_PASSED / PHASE_SKIPPED` journaled before their checkpoint) and
    F2/F3 (resumed-orchestrator `JOURNAL_OUT_OF_ORDER` / read-only requeue
    HOLD) — all **fail-closed**, never data corruption or false PASS.
  - These become direct DE-2 repair targets.
- **Restate security/supply-chain finding** — stands: SEC-1
  `@restatedev/restate-server@1.7.3` depends on `@scarf/scarf` (default
  phone-home telemetry) = Stage 13 BLOCKER; SEC-2 BSL license = HIGH.
- **Temporal SDK cleanliness** — stands (SEC-3 INFO: `@temporalio/*` only), but
  SEC-4 (server + DB deployment surface) is unmeasured, not eliminated.
- **Existing AutoLoop is the most promising candidate** — but **provisionally**,
  not as a final winner.

---

## 3. The 13 Existing recoverability failures (evidence summary)

From `de1-bakeoff-results.json` (real SIGKILL, T0–T12, 2 kill modes):

- Recovery refused at journal→checkpoint sub-window: **8** (`RESUME_FINGERPRINT_MISMATCH`) — F1.
- Resumed-orchestrator edge: **5** HOLD outcomes — F2 (`JOURNAL_OUT_OF_ORDER`,
  3) + F3 (read-only requeue HOLD, 2).
- All 13 are fail-closed; safety counters all 0.

These are bounded, in-process, DE-2-scope fixes — strong support for hardening
the existing engine, but they do not substitute for the missing B/C comparison.

---

## 4. Governance Disposition

- `REPAIR_BUDGET_MAX: 1`
- `REPAIR_BUDGET_USED: 1` (consumed by the internal SA-W1 writer repair that
  produced the current bundle)

Because the budget is exhausted, the honest disposition is:

**HOLD / DE1_RESEARCH_EXTENSION_REQUIRED**

not a bounded repair pretending budget remains. Downstream (DE-2 finalization,
External Research Escalation) must stop until DE-1R closes.

### Retained as-is (no rework needed)

- STACK_A / STACK_B distinction
- DurableExecutionProvider 12-method seam
- D1–D8 invariants
- Existing F1/F2/F3 → DE-2 repair targets
- Restate Stage-13 security finding
- "PROVISIONAL: EXISTING AUTOLOOP LEADS" (downgraded selection)

---

## 5. Required DE-1R Work (minimal live prototype bake-off)

1. **Temporal**: minimal local isolated deployment (dev server + SQLite or
   Docker Compose) — no production Colima required.
2. **Restate**: if the Stage 13 security gate is formally adjudicated a hard
   FAIL for the server (`@scarf/scarf` phone-home + BSL), it may be excluded
   from the full performance bake-off — but the gate must be proven sufficient
   to eliminate it. It cannot be both "same bake-off" and "not run".
3. **Temporal must run the same key failure classes as Existing**:
   - crash during node
   - result persisted / successor not scheduled
   - writer side-effect boundary
   - duplicate recovery
   - corrupt state/checkpoint equivalent
4. **Measure**:
   - correctness
   - recovery latency
   - duplicate behavior
   - resource/service footprint
   - operational complexity
5. **Re-apply the same selection rubric**: does Temporal's recovery improvement
   justify adding a server + DB + deterministic workflow constraints over the
   Existing engine?
6. Expected outcome if Temporal's advantage does not offset server/DB/ops
   complexity: Existing AutoLoop still wins — then close DE-1 formally and
   enter **DE-2 Native Durable Execution Hardening**.

---

## 6. Next Actions

- `NEXT_ACTION`: open **DE-1R — External Candidate Live Prototype Bake-off**
  (see `DE-1R-card-spec.md`).
- `DOWNSTREAM_BLOCKED`: DE-2 finalization, selection finalization, External
  Research Escalation.
- `DE-2_PREP_ALLOWED`: F1/F2/F3 repair targets may be pre-drafted as DE-2
  inputs, but DE-2 itself waits for DE-1R.

---

### END OF VERDICT
