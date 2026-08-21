# AUTOLOOP POST-P4 — GOVERNANCE CONVERGENCE RECORD

Status: this document is the normative record of the post-P4 governance
convergence card（Truth Revocation Cascade implemented; Semantic Drift research
contract frozen）.

Predecessor: `docs/governance/autoloop-p4-pass-oracle-contract.md`
（PASS / AUTOLOOP_P4_VERIFICATION_PASS_ORACLE_CLOSED, HEAD `4c6b40b`）.

---

## 1. Authority reconciliation

The task-card-named `AUTOLOOP-MASTER-PLAN-AUTHORITY-V1.md` does not exist in
the repository and is NOT authority. Active post-P4 authority:

| Source | Role |
|---|---|
| `docs/pi-graph-output/checkpoint-20260809/roadmap-revalidation.md` | canonical item classification（Truth Revocation Cascade DO_LATER; Semantic Drift RESEARCH_FIRST; No-Progress/Livelock MERGE_WITH_OTHER） |
| `docs/governance/autoloop-rr1-post-fr4-release-and-roadmap-reconciliation.md` | roadmap-layer reconciliation doctrine |
| `docs/governance/autoloop-p4-pass-oracle-contract.md` | THE structured acceptance oracle（satisfies Truth Revocation's declared prerequisite） |
| `AGENTS.md` | AUTHORITATIVE_SOURCE_FIRST / verification scope / storage policy |
| current `src/governance/*` implementation | binding implementation truth |

`ROADMAP_AUTHORITY_CONFLICTS = 0`：the checkpoint's DO_LATER classification is
conditional on its stated prerequisites, not a prohibition; P4 discharged the
"structured acceptance oracle" prerequisite. Obsolete wording is historical
record, not active constraint.

## 2. Dependency graph（frozen）

```text
P4 PASS Oracle (DONE)
   └─ enables → Truth Revocation Cascade (READY → IMPLEMENTED here)
                   └─ consumes future input from → Semantic Drift Gate
                                                   (RESEARCH_FIRST; contract frozen here,
                                                    implementation NOT started by authority)
No-Progress/Livelock = MERGE_WITH_OTHER（durable scheduler/recovery state;
   remains governed by existing Stage E bounded-repair machinery）
```

Explicit answers:

- Does Truth Revocation require Semantic Drift? **NO**（independent; drift only
  supplies an additional future trigger `semantic-source-superseded`, already
  reserved in the trigger enum）.
- Does Semantic Drift require Truth Revocation? **NO** for its research
  contract; YES as a downstream consumer once it implements.
- Can Semantic Drift research run while Truth Revocation is implemented?
  **YES**（it did — see §5）.
- Does No-Progress/Livelock depend on either? **NO**; revocation cannot create
  a verify→revoke→retry livelock because revocation is fail-closed（a revoked
  check yields HOLD/MISSING, never automatic retry credit）and repair budget
  narrowing in review-bundle.mjs stays monotonic.

`NEXT_STAGE_ORDERING = EXPLICIT`: no new "P5" label exists or is invented.

## 3. Truth Revocation contract（frozen + implemented）

Modules:

- PURE decision core: `src/governance/truth-revocation.mjs`
  - Schema `autoloop.truth-revocation/v1`.
  - `REVOCABLE_TRUTH_CLASSES = evidence | artifact | authority`
    （NOT all persisted data — history/journals/bundles are never "truth"
    candidates for revocation）.
  - `REVOCATION_TRIGGERS` = source-mutation | authority-revoked |
    generation-superseded | artifact-hash-changed | invariant-violated |
    verifier-retraction | contract-superseded | semantic-source-superseded.
  - `REVOCATION_ISSUER_ROLES = operator | reviewer | system`（executor
    deliberately excluded — an executor must never revoke independent proof）.
  - Fencing codes: WRONG_GENERATION_REVOCATION / WRONG_LINEAGE_REVOCATION /
    UNAUTHORIZED_REVOCATION. Duplicate revocationId = idempotent.
  - `computeCascade()` = deterministic BFS closure over minimal dependency
    edges（implicit: evidence → artifact via `binding.artifactSha256`;
    explicit: caller-supplied `{dependentId, dependsOnId}`）.
- Durable ledger: `src/governance/truth-revocation-store.mjs`
  - One atomic JSON file per event under `<outDir>/truth-revocations/`
    （stage → exclusive link() commit → unlink; same discipline as
    closeout-state.mjs — NO new durable engine）. link() never overwrites:
    concurrent same-id writers collide loudly（idempotent duplicate or
    ID_CONFLICT）— a racing writer can never silently lose a revocation.
  - Ledger reads re-validate every record. Any unreadable/corrupt entry
    FAILS CLOSED（ok:false → callers HOLD）: a torn file might BE a
    revocation, so CURRENT-AUTHORITY is never derived from a partial view;
    a pre-revocation checkpoint can never resurrect truth.
- PASS-oracle integration: `evaluatePassOracle({ revocations })` — revoked
  evidence ids / artifact digests / REVOKED AUTHORITY producer identities all
  reject evidence with `ORACLE_EVIDENCE_REVOKED`; required checks then fail
  MISSING_REQUIRED. Both enforcement seams self-load the durable ledger:
  `runCloseoutGate`（<outDir>/truth-revocations/, fail-closed on corrupt
  ledger or invalid events）and the final acceptance bar
  `assertFinalCardCloseout`（its second oracle call re-derives facts from the
  same ledger — authority-identity fencing covers its distinct synthetic
  evidence ids）. The oracle remains the ONLY PASS authority;
  `PASS_ORACLE_REPLACED = NO`.

Historical semantics: revocation adds durable CURRENT-AUTHORITY state; it
never deletes or rewrites bundles, journals, or past PASS records
（`HISTORY_REWRITTEN = NO`）。A historical PASS does not certify current state
after invalidation — current decisions re-evaluate with ledger-derived facts.

## 4. Verification

`test/governance/test-truth-revocation.mjs` — 29 tests:
TR1–TR18 matrix（malformed/unauthorized/wrong-generation/wrong-lineage strict
fencing incl. field-omission dodge; cascade precision TR3/TR5/TR14; oracle
TR2/TR15/TR17/TR18 race-ordering; restart TR11; stale-checkpoint resurrection
TR12; history immutability TR13; idempotency TR10; property table P-TR）+
gate integration GR1–GR3 + red-team regressions RT1–RT4（revoked-authority
enforcement, gate self-load enforcement, executor-role laundering blocked,
corrupt-ledger HOLD）.

Independent red-team review round: 9 findings（2 blocker-class enforcement
gaps, 7 hardening defects）— ALL repaired and regression-pinned before
closure. Governance suite after repairs: identical pass/fail set to the
pristine working baseline（510 pass / the same 2 pre-existing live-repo
environment failures, verified identical with the new modules removed）.

## 5. Semantic Drift Gate — RESEARCH_FIRST outcome（contract frozen, implementation NOT started）

Research finding（live code survey）: **no single authoritative semantic source
exists today.** Three disjoint freeze authorities:

| Candidate | What it freezes | Freeze mechanics |
|---|---|---|
| admission record (`src/admission/admission-record.mjs`) | POLICY only（capabilities/scope/review policy）— no semantic content | deterministic `admission_id`, tamper-detecting |
| review-job + spec identity (`review-job.mjs`, `spec-identity.mjs`) | spec-doc + code-candidate identity | SHA-256 normalization; drift codes REVIEW_SPEC_DRIFT/REVIEW_CANDIDATE_DRIFT; authorized change ONLY via `createSuccessorReviewJob` supersession |
| closeout-state successContract | DECLARED TASK SEMANTICS reaching the oracle | **NONE — convention only** |

Frozen research contract（the smallest canonical missing piece）:

```text
SEMANTIC_SOURCE          = normalized successContract（declared task semantics）+
                           bound spec digest（spec-identity）+ admission policy
SEMANTIC_BINDING_POINT   = persisted closeout-state record at write time
                           （already the oracle's only successContract source）
SEMANTIC_CHANGE_AUTHORITY= successor-generation machinery only
                           （createSuccessorReviewJob supersession semantics）；
                           in-place contract mutation = drift
MISSING MECHANISM        = successContractDigest = sha256(canonical(normalized
                           contract)) bound into closeout-state/admission at
                           declaration time and re-derived at gate time
DRIFT DEFINITION         = any gate-time divergence between the bound digest/
                           structure and the live declared contract that is not
                           accompanied by an authorized successor-generation record
```

Deterministic detection covers hash/structure/required-check-set comparison;
LLM semantic review is reserved for genuine equivalence questions only（not
needed for the digest seam above）. Implementation status:
`IMPLEMENTATION_STATUS = NOT_STARTED_BY_AUTHORITY`（RESEARCH_FIRST holds）.

## 6. Node status summary

```text
TRUTH_REVOCATION_FINAL_STATUS = IMPLEMENTED_AND_CLOSED
SEMANTIC_DRIFT_FINAL_STATUS   = RESEARCH_CONTRACT_FROZEN（implementation RESEARCH_FIRST-held）
NO_PROGRESS_FINAL_STATUS      = MERGED_WITH_EXISTING_GOVERNANCE（no new gate; bounded-repair machinery unchanged）
NEXT_CANONICAL_STAGE          = implement successContractDigest freeze when opening the
                                Semantic Drift Gate card; then wire
                                semantic-source-superseded into REVOCATION_TRIGGERS consumers
```
