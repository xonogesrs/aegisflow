# AUTOLOOP — POST-SPLIT CANONICAL REALIGNMENT RECORD

Status: `PASS / POST_SPLIT_CANONICAL_REALIGNMENT_CLOSED`
Established: 2026-08-22
Evidence basis: direct audit at standalone HEAD `eb2fac147821569dcfbbd177f304eb794de831ea`
(branch `governance/rsl2-universal-execution-review-surface`)
Method: read-only parallel audit tracks A–D + fresh standalone test validation.
This record is additive; it rewrites no historical document.

## 1. Canonical repository declaration

Standalone AutoLoop canonical repository:

```
/Volumes/NVM2T/Development/repos/autoloop
```

`~/auracore/scripts/ai/autoloop` is a **legacy / shadow / cross-project
integration surface** embedded in the unrelated AuraCore product repo
(`aura.git`). It is NOT canonical for AutoLoop and MUST NOT be treated as a
development target for AutoLoop work. This restates, at the repository level,
the disambiguation first recorded in
`autoloop-revart-rc1b-review-execution-context-and-artifact-provenance-reconciliation.md`.

## 2. Admission authority decision

**Decision: SUCCESSOR (domain-jurisdictional).**

`autoloop.task-admission/v1` (`src/admission/*`, enforced by
`runAdmittedGraph`) is the ONLY AutoLoop admission authority. The retired
AuraCore-shadow P1-AA trusted-admission broker chain governed a different
jurisdiction — privileged cross-OS-boundary issuance for the AuraCore product
runtime — and has NO successor obligation inside standalone AutoLoop.

Semantic comparison (evidence-backed, not name-based):

| Property | standalone task-admission/v1 | shadow P1-AA |
|---|---|---|
| authority owner | self-authorized from task facts (`buildAdmissionRecord`; `authority_record_digest` placeholder) | Controller Ed25519 → Broker Ed25519 chain |
| trust boundary | content integrity (re-derivable sha256 id) | cryptographic provenance across privileged OS boundary |
| caller identity | none (construction-path control is load-bearing) | principal attestations, controller identity |
| authorization | deny-by-default capability registry, full enumeration | controller approval + policy binding |
| payload integrity | deterministic content id + freeze | signed payload digests |
| freeze binding | `freezeAdmission` + `ADMISSION_DRIFT` re-derivation at every gate/resume | immutable envelope digest binding |
| freshness | none by design (single-decision record) | TTL bounded by approval/policy expiry |
| replay resistance | none on the admission itself; budget opKey consumption at operation layer | challenge/grant single-use ledger |
| revocation | out of admission scope; Truth Revocation Cascade governs truth records | broker revocation ledger with cascade |
| generation/epoch | recovery generation on durable resume | run_generation / renewal_generation / epochs |
| durable truth | admission.json + budget-ledger.json bound into checkpoints | SQLite WAL authority-ledger |
| restart behavior | anti-drift resume binding (HOLD/ADMISSION_DRIFT on mismatch) | restart-safe settlement, REVOCATION_ROLLBACK fence |
| privileged OS boundary | not required | required (uid 42471 socket custody) |
| external broker required | NO | YES |
| production entrypoint | `runAdmittedGraph` (sole; legacy entrypoints dead-ended) | broker IPC + sidecar loaders |
| intended jurisdiction | internal AutoLoop task-execution policy | AuraCore cross-boundary production issuance |

The properties P1-AA provided that standalone does not (crypto issuer,
expiry, admission-level replay protection, caller principals) were requirements
OF THE AURAORE JURISDICTION (privileged cross-boundary mutation authority).
They are not requirements of standalone's internal execution-authority model,
whose trust anchor is construction-path control plus tamper-evident content
addressing. If a future requirement demands provenance-grade admission for
AutoLoop itself, that is a new standalone requirement to be designed natively —
not a reason to import the shadow implementation.

## 3. Stage E / c5b1 ownership

**Decision: SHADOW_CLOSED_LINEAGE with SEMANTIC_SUCCESSOR_EXISTS mapping.**

Old Stage E R1–R18 classification:

| Class | Count | Requirements |
|---|---|---|
| SUPERSEDED_BY_STANDALONE | 12 | 1 (execution seam → runAdmittedGraph + pass-oracle seams), 3 (REPLAN ladder), 5 (spec amendment → spec-identity supersession), 6/7 (no-progress/progress → FR4 bounds + failed-strategy REPLAN), 8/9/10 (fact provenance/freshness/invalidation → Truth Revocation Cascade + AET-2), 12/13 (invariant registry/fencing → pass-oracle invariants), 14 (bounded novelty → RR1 B6 capability axis), 15 (restart/reconcile → durable anti-drift resume) |
| PROVEN_BY_STANDALONE | 4 | 4 (contract drift fencing → REVIEW_SPEC_DRIFT codes), 11 (authority revocation → Truth Revocation Cascade, 29-test suite), 16 (stale generation rejection → WRONG_GENERATION fencing + recovery generations), 17 (durable ownership/retirement → CP-1 ownership map + RC1A transition matrix) |
| INTEGRATION_ONLY | 1 | 18 (production dispatch reachability through the AuraCore broker final barrier — AuraCore-runtime jurisdiction only) |
| LEGACY_NOT_APPLICABLE | 1 | c5b1 structured-command contract as a STANDALONE requirement — its native equivalent already exists (`verifyFinalBarrierEvidence`, C5B1 validators in `src/validate-role-artifacts.mjs`) |
| REAL_STANDALONE_GAP | 0 | — |

`STAGE_E_OLD_REQUIREMENTS_TOTAL = 18`.

c5b1 `144/0` belongs to the shadow integration lineage. It is preserved
evidence only and MUST NOT gate standalone progress.

## 4. Cross-project integration gate

**`CROSS_PROJECT_BROKER_GATE = NOT_REQUIRED_NOW`.**

Standalone has zero runtime dependency on `/opt/auracore-admission-broker`,
AuraCore controller keys, or AuraCore worktrees (audit: zero executable
references; all `auracore` hits are provenance comments or historical docs).
If a future product requirement demands interoperability, it opens a separate
**AUTOLOOP ↔ AURACORE EXTERNAL ADMISSION INTEGRATION ACCEPTANCE** gate under
these standing boundaries: broker treated strictly as an external service;
integration adapter lives on whichever side requires it; no shared hidden
authority; no shared mutable source tree; production credentials never enter
standalone fixtures or the standalone repo.

## 5. Legacy import fence (standing rule)

No AuraCore shadow implementation becomes standalone AutoLoop canonical merely
because it historically implemented an AutoLoop-named feature. Any proposed
import requires ALL of:

1. a current standalone requirement,
2. semantic gap proof against current mechanisms,
3. absence of any native equivalent,
4. architecture compatibility with the standalone trust model,
5. independent acceptance criteria defined in the importing card.

## 6. Dependency fences (verified at eb2fac1)

```
STANDALONE_REQUIRES_AURACORE_BROKER        = NO
STANDALONE_REQUIRES_AURACORE_CONTROLLER_KEY = NO
STANDALONE_REQUIRES_AURACORE_WORKTREE       = NO
ACCIDENTAL_CROSS_PROJECT_COUPLING           = NO
DUPLICATE_ADMISSION_AUTHORITY               = NO  (CP-1 §3: one owner per boundary)
DUPLICATE_RUNTIME_TRUTH                     = NO  (AET-1: one authoritative source-of-record per decision boundary)
```

## 7. Current canonical governance lineage (in order)

1. `autoloop-rr1-post-fr4-release-and-roadmap-reconciliation.md` (roadmap doctrine)
2. `autoloop-p4-pass-oracle-contract.md` (THE acceptance oracle; BYPASSABLE_PASS_PATHS=0)
3. `autoloop-post-p4-governance-convergence.md` (Truth Revocation IMPLEMENTED_AND_CLOSED; Semantic Drift RESEARCH_CONTRACT_FROZEN; NEXT_STAGE_ORDERING=EXPLICIT)
4. RevArt RC1A → RC1B → IMPL1/RC2 review-authority line; RSL1/RSL2 execution-review surface
5. Cross-cutting: `authority-execution-truth-invariants.md` (AET-1/2/3), `control-plane-ownership-contract.md` (CP-1)

Historical "Stage E machinery" references in current docs name surviving
durable-state patterns, not a competing authority.

## 8. Fresh standalone evidence (2026-08-22, HEAD eb2fac1)

```
FRESH_STANDALONE_EVIDENCE:
  test/admission core authority suites   55 passed / 0 failed
    (gate NEG19 fail-closed spy proofs, record determinism/drift,
     envelope enforcement, graph wiring, durable binding, closeout hardening)
  test/governance (pass-oracle, truth-revocation, execution-review)
                                          76 passed / 0 failed
  test/budget                             44 passed / 0 failed
  test/control-plane                      58 passed / 0 failed
  test/admission full directory          181 passed / 2 failed
    the 2 failures are FR4 Phase E installed-vendor integrity checks vs the
    machine-local ~/.pi deployment (stale install; in-repo vendor copies are
    byte-identical and passing) — environment state, not architecture.

PRESERVED_SHADOW_EVIDENCE (non-authoritative, historical/integration only):
  /Volumes/NVM2T/Development/worktrees/aura/p1-aa-admission-runtime
    c5b1 144/0; Gate A offline 14/0; Gate B offline 8/0; security probes 10/0
  /Volumes/NVM2T/Development/evidence/autoloop/p1-aa-gateb-signed-bundle-20260822/
    (signed approval void after shadow tree restoration; never installed)
```

## 9. Final canonical model

```text
Standalone AutoLoop (/Volumes/NVM2T/Development/repos/autoloop)
  ├─ canonical task admission authority      src/admission/* (task-admission/v1, runAdmittedGraph)
  ├─ canonical execution/governance stack    lifecycle-runner, budget enforcement+ledger,
  │                                          pass-oracle, Truth Revocation Cascade
  ├─ canonical review surface                RevArt chain + RSL2 Domain A/B
  └─ optional explicit external integrations (none currently declared)

AuraCore (aura.git)
  ├─ own product/runtime authority (engine/ui, Issue-line work)
  └─ legacy AutoLoop shadow surface at scripts/ai/autoloop (closed lineage;
     preserved evidence; not a development target for AutoLoop)

External system infrastructure (/opt broker, controller keys)
  └─ usable only through explicit future integration contracts
     (CROSS_PROJECT_BROKER_GATE = NOT_REQUIRED_NOW)
```

## 10. Known open items (none blocking this verdict)

- FR4 Phase E vendor redeployment: refresh `~/.pi/agent/extensions/
  search-scope-governor/vendor/` from repo sources to restore the two
  machine-local integrity checks (deployment step, not a code change).
- Semantic Drift Gate remains RESEARCH_CONTRACT_FROZEN /
  NOT_STARTED_BY_AUTHORITY per convergence §5 — unchanged by this card.
