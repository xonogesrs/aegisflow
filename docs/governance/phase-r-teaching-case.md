# Phase R Teaching Case — Preservation → Reconciliation → Convergence

> **Card:** `PHASE-R-TEACH1` — Preservation → Reconciliation → Convergence Teaching Case & Pre-Execution Reconciliation Protocol
> **Type:** teaching case / governance extraction
> **Baseline:** Phase R closed — `PASS / PHASE_R_CONVERGENCE_EXTERNAL_REVIEW_VERIFIED_AND_AUTHORITY_HANDED_BACK` at `d91e2b54a7cf6342b34af12dc657b49efb9754cd`
> **AET reference:** `docs/governance/authority-execution-truth-invariants.md` (authoritative for AET-1/2/3)

---

## Part A — Why Phase R existed

Phase R was **not** technical-debt cleanup. It was **authority reconstruction**: execution risk could no longer be assessed safely while multiple historical and current forms of truth coexisted.

Categories actually encountered (each grounded in durable Phase R evidence):

| Category | Evidence |
|---|---|
| git HEAD ≠ implementation truth | R-R1: canonical HEAD `2e897e99`, 122 dirty entries (17 modified + 105 untracked), `src/` 91 tracked vs 149 on disk |
| vendored-tree drift | R-R1: Aura copy vs canonical — 48 shared basenames, 34 identical, 14 drifted, 310 canonical-only, 112 Aura-only |
| key/credential custody | R-R2: 11 distinct private keys; production issuer + live controller single-copy; 6 principal keys in two bootstrap locations |
| broker ownership/home | R-R2: `/opt` = deployment + runtime + crypto custody (not source); TA-3 = build evidence; Aura = stale duplicate |
| deployment truth | R-R2: production broker PID 13600 / epoch 9 / manifest `fad6d0c2` |
| review/evidence artifacts | RB1: three-generation bundle chain `9b68a70b → 18f364cf → d86d9e97` |
| runtime/deployment authority | RB-SSG: Pi bash path bypassed the search-scope governor |

The lesson: when several of these coexist, "which file is newest" or "what is running" cannot answer "what is authoritative". Feature work on top of unresolved authority propagates the ambiguity downstream.

---

## Part B — R-R1: Preservation before interpretation

> Before deciding what is obsolete, preserve enough evidence to reconstruct why it exists.

R-R1 came **first** because git HEAD was provably not an adequate preservation identity — the current implementation lived substantially in dirty/untracked material and a drifted vendored tree. Any cleanup before preservation would have destroyed the evidence later reconciliation required.

What preservation protects against:
- irrecoverable loss of uncommitted/dirty implementation,
- drift between vendored copies becoming unprovable,
- provenance becoming impossible to reconstruct after mutation.

**Preserving evidence ≠ granting it authority.** Historical material may remain discoverable while being non-authoritative. This is AET-1's core rule:

> **Discoverable history is not executable authority.**

When preservation is:
- **mandatory** — before any evidence-destroying mutation on provenance-critical, duplicated, or custody-sensitive state;
- **lightweight** — a digest + manifest snapshot of a single unambiguous authoritative tree;
- **unnecessary** — when the state is fully represented by an already-verified authoritative baseline and no mutation will remove evidence.

Preservation must not decay into indefinite archival accumulation; once convergence selects authority, the preserved snapshot becomes historical evidence, not a competing candidate.

---

## Part C — R-R2: Canonical Ownership / Source-of-Record Reconciliation

Central question:

> What is authoritative in this domain now?

R-R2 answered it **read-only**: a design reconciliation that performed zero migration/deletion. It established:

- **one-owner model** — every mutable fact has exactly one authoritative owner, or an explicit `UNRESOLVED` gate;
- **six-layer separation** — source / build / deployment / runtime / crypto / evidence;
- **secret custody** — 11 keys inventoried; issuer/controller single-copy; principals flagged for per-principal custody;
- **broker-home role** — `/opt` = deployment+runtime+crypto (not source).

"Latest timestamp", "newest file", "currently-running process", or "most-recently-edited branch" were all rejected as authority rules — they are freshness signals, not authority.

### Authority Reconciliation Matrix (reusable)

| authority_domain | candidate_object | identity | location | provenance | current_role | validation_state | supersedes | superseded_by | authoritative? | reason |
|---|---|---|---|---|---|---|---|---|---|---|
| AutoLoop source | canonical repo | `2e897e99`→…→`d91e2b5` | `/Volumes/NVM2T/Development/autoloop` | git | current baseline | verified | — | — | yes | verified authoritative baseline lineage |
| AutoLoop vendored copy | Aura tree | drift 48/14/310/112 | Aura repo | vendored | stale duplicate | drift-measured | — | — | no | R-R2 |
| broker deployment | `/opt` v6 modules | manifest `fad6d0c2` | `/opt` | deployment | runtime truth | verified | — | — | domain-local (not AutoLoop source) | R-R2 |
| review bundle | `d86d9e97` | sha `965aeff4` | Desktop RB1 dir | generated | authoritative review bundle | external PASS | `18f364cf` | — | yes | RB1-R2 |
| review bundle | `18f364cf` | sha `0ddb0eda` | Desktop RB1 dir | generated | superseded | REPAIR F1-F3 | `9b68a70b` | `d86d9e97` | no | superseded |

This matrix — not a filename sort — is how reconciliation stays honest.

---

## Part D — R-R3: Convergence Execution

Reconciliation becomes **controlled mutation** only after authority is reconstructed. R-R3 was held at a hard pre-mutation gate (D1 broker canonical source, D2 principal secret strategy) precisely because mutation before those authority decisions would have been guesswork.

The expected transition:

```text
ambiguous candidates → reconciled truth → authorized mutation
   → verification → promotion → single current authority
```

Convergence is **not** complete merely because tests pass. Completion requires alternatives to be explicitly reclassified (superseded/historical/legacy). Branches/worktrees/candidates may exist temporarily for isolation, comparison, review, rollback, or experiment — but must not remain competing source-of-truth indefinitely (AET-1).

---

## Part E — Why not inspect every possible risk at project start?

Deep reconciliation of everything up-front is also a bad policy — it overbuilds the process, burns budget on hypotheticals, and defers actual execution.

**1. Known execution-critical uncertainty** — justifies reconciliation before mutation:
- multiple candidate production sources,
- conflicting authority/key custody,
- unclear deployment source,
- unknown runtime owner,
- competing source-of-record,
- prerequisite whose provenance cannot be proven.

**2. Hypothetical or low-probability uncertainty** — must **not** auto-trigger deep reconciliation:
- theoretical branches not on the planned execution path,
- historical artifacts with no authority role,
- unrelated subsystems untouched by the phase,
- speculative failure modes with no evidence or execution exposure.

> Pre-execution reconciliation is risk-triggered and scope-bounded, not a mandatory full-system audit.

Phase R itself demonstrates the discipline: R-R1/R-R2 inspected only the surfaces that convergence would touch; it did not audit every artifact in every repo.

---

## Part F — Risk classifier escalation

See `pre-execution-reconciliation-protocol.md` (PER-6) for the normative three levels. Summary:

| Level | Trigger | Permitted scope | Exit |
|---|---|---|---|
| **NORMAL ADMISSION** | single authority, proven prerequisite, bounded mutation | card scope | admission |
| **FOCUSED RECONCILIATION** | one authority domain with drift or candidate ambiguity | that domain | single authoritative baseline declared |
| **DEEP RECONCILIATION** | multiple domains / custody / production-vs-repo / irreversible mutation on uncertain state | bounded multi-domain evidence reconciliation | authority converged or explicit Controller decision |

---

## Part G — AET lessons extracted from the case

### AET-1 — Authority Convergence
> One authority domain, one current authoritative baseline.

Precedent: Phase R source/evidence convergence — three review-bundle generations, each explicitly classified (authoritative / superseded), never left as parallel current truths.

### AET-2 — Handoff Re-Proof
> Previous PASS does not prove current prerequisite truth.

Precedent (RB1-R2 handoff): the earlier bundle's evidence had been valid at `ecb8b78`; a later baseline change (RB-SSG detour added three test scripts to `package.json`) made the `package.json` evidence hash stale. Re-proof at the delivery boundary exposed the drift **before** delivery. Correct classification: handoff/evidence staleness — not an implementation defect.

### AET-3 — Execution Coverage
> Policy existence ≠ enforcement. AutoLoop owns policy; runtimes enforce it.

Precedent (RB-SSG): the search-scope governor existed and its unit tests passed, but the real Pi bash path bypassed it because it was wired at the wrong seam (AutoLoop subagent launch, not Pi's own `bash` tool → spawn). The fix was to wire the governor into the actual pre-spawn seam and prove it on the live runtime path (`tool_call` block pre-spawn + `user_bash` no-`executeBash`). Policy authority stayed AutoLoop; Pi became an enforcement adapter.

> Policy existence, current authority, and actual enforcement are three separate facts.

---

## Part H — Narrow repair vs structural convergence

**Use narrow repair** when: one ownership domain, one clear source-of-truth, localized defect, bounded blast radius, no authority ambiguity, no cross-layer state disagreement.

**Escalate to structural convergence / root-cause investigation** when: classifier/executor/state/authority/recovery/deployment interact, repeated repairs expose a new seam each time, multiple systems disagree on current truth, mutation provenance cannot be reconstructed, recovery path changes authority, or the execution graph itself is unclear.

> Repeated failure across overlapping seams is evidence that the unit of analysis is too small.

The RB-SSG detour is the cautionary example in reverse: a first pass "added the governor" (policy), a second pass found it was on the wrong seam (execution coverage), a third pass converged deployment. Each was locally correct; the sequence only closed once the unit of analysis became "the actual execution seam", not "the rule".

---

## Part J — Mechanical automation candidates

Full classification lives in `pre-execution-reconciliation-protocol.md` (PER automation table). Headline:

- **MUST automate** (deterministic, no judgment): repo/worktree identity, current revision, dirty-tree classification, evidence hash validation, supersede graph validation, duplicate-candidate detection, bounded-search/no-progress governor, review-bundle current-vs-historical state validation, handoff freshness, prerequisite existence.
- **SHOULD automate** (deterministic with bounded inputs): authoritative-baseline declaration, runtime artifact path/hash proof, execution-boundary coverage registration.
- **Agent reasoning remains necessary**: *why* a root is authoritative, whether a drift invalidates review, which repair strategy is proportionate, and whether reconciliation should escalate.

Not every reconciliation decision is automatable — and it should not pretend to be.

---

## Part K — Human authority boundary

> HIGH RISK ≠ HUMAN APPROVAL REQUIRED. The human approves the **risk envelope**, not every risky decision.

Within an authorized risk envelope the agent may autonomously REPAIR / REPLAN. HOLD for human/Controller **only** when: outside the authorized envelope, authoritative truth cannot be established, frozen specifications contradict, blast radius exceeds authority, an irreversible action lacks recovery, or a new product/business decision is required.

Phase R obeyed this throughout: D1/D2/F6 were HOLDed *not* because they were risky but because they required authority the agent could not mint; within-scope repairs (RB1-R2, RB-SSG2/3) proceeded under bounded authority.

---

## Part L — Search and investigation discipline

Because the RB-SSG incident is part of this case, investigation guidance must include:

- bounded-by-default discovery,
- known authoritative locations first,
- no unbounded recursive traversal over HOME / Development,
- a failed search strategy triggers REPLAN (not retry-with-wider-scope),
- repeated same-scope traversal is never retried indefinitely.

This is **not** an efficiency rule. It protects execution boundedness, observability, evidence quality, operator trust, and resource budget. The original incident — `cd $HOME && grep -rl … .` — is now mechanically rejected pre-spawn by the governor that AET-3 requires.
