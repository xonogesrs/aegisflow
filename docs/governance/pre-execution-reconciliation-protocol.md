# Pre-Execution Reconciliation Protocol (PER)

> **Card:** `PHASE-R-TEACH1` — derived from the Phase R teaching case
> **AET reference:** `docs/governance/authority-execution-truth-invariants.md` (authoritative for AET-1/2/3)
> **Teaching case:** `docs/governance/phase-r-teaching-case.md`

This is the **normative, reusable** protocol for future card/phase admission. It
implements AET-1 (authority convergence), AET-2 (handoff re-proof), and AET-3
(execution coverage) as concrete steps. It is risk-triggered and scope-bounded,
**not** a mandatory full-system audit.

---

## Risk levels (PER-6)

| Level | Trigger | Permitted scope | Required evidence | Exit condition |
|---|---|---|---|---|
| **NORMAL ADMISSION** | single authoritative baseline; downstream prerequisite proven; bounded mutation | card scope only | identity/revision of the baseline; prerequisite re-proof | admission |
| **FOCUSED RECONCILIATION** | one authority domain shows drift, duplicate candidates, or ambiguous ownership | that authority domain only | candidate classification + provenance; supersede/validation state | exactly one authoritative baseline declared for that domain |
| **DEEP RECONCILIATION** | multiple domains interact; custody/issuer ambiguity; production-vs-repo disagreement; irreversible/high-blast-radius mutation depends on uncertain state | bounded multi-domain evidence reconciliation; no broad HOME/Development traversal | authority matrix + provenance + recovery boundary; Controller decisions recorded where required | authority converged **or** explicit Controller decision/HOLD |

Escalation triggers (evaluate before mutation):
- multiple plausible current sources-of-truth,
- authority/issuer/custody ambiguity,
- production state differs from repository assumptions,
- target runtime provenance unknown,
- historical vs current evidence cannot be separated,
- irreversible/high-blast-radius mutation depends on uncertain state,
- previous PASS does not establish current prerequisite truth,
- repeated repairs reveal ownership/state ambiguity rather than local defects,
- the integration seam crosses repository/runtime/deployment authority domains.

---

## PER-0 — Scope declaration

Declare before acting:
- intended mutation,
- target authority domain,
- expected source-of-record,
- expected runtime/deployment target,
- rollback/recovery boundary.

Without a scope declaration, reconciliation cannot be bounded.

---

## PER-1 — Authority discovery

Enumerate **only** relevant candidate authorities from **bounded known locations**.
No broad HOME / Development traversal. Known authoritative locations first:
tracked repo state, manifests, cards, review artifacts, known worktrees.

---

## PER-2 — Candidate classification

Classify every candidate:

```text
authoritative
candidate
pending-validation
historical
superseded
legacy
unknown
```

If classification is ambiguous, the candidate is `unknown` — not silently
promoted to authoritative.

---

## PER-3 — Provenance proof

For the intended authoritative object, establish:
- identity,
- source revision,
- owner/issuer,
- path/location,
- creation lineage,
- integrity (hash) where applicable.

Provenance is **proven**, not assumed from a filename or timestamp.

---

## PER-4 — Handoff prerequisite re-proof (AET-2)

Re-prove every downstream-critical prerequisite at the handoff boundary:
existence, identity, provenance, authoritative status, revision/version,
expected location, integrity/hash, freshness, compatibility, lifecycle state.

> Previous PASS does not prove current prerequisite truth.

---

## PER-5 — Execution-path coverage (AET-3)

For runtime/tool execution, prove the intended mutation crosses the
authoritative admission/enforcement boundary on the **real** path — not by
inference from a unit test. Record the runtime adapter / seam and the evidence
that the proposal reached admission before spawn/execution.

---

## PER-6 — Risk classification

Choose `NORMAL` / `FOCUSED_RECONCILIATION` / `DEEP_RECONCILIATION` per the table above.

---

## PER-7 — Convergence requirement (AET-1)

If multiple plausible current authorities remain, mutation is **not admitted**
until they are reconciled or explicitly bounded out. One authority domain ⇒ one
current authoritative baseline; alternatives are explicitly classified, never
left as parallel current truths.

---

## PER-8 — Mutation admission

Only now permit source/runtime/deployment mutation — after authority is
established and the risk level is resolved.

---

## PER-9 — Post-mutation convergence

After verification:
- select the authoritative result,
- mark alternatives superseded,
- update the evidence chain,
- ensure no competing current authority remains.

---

## PER-10 — Handoff

Re-prove the next phase's prerequisite rather than carrying forward a PASS by
inference. Record the handoff evidence at the producer→consumer seam.

---

## Automation candidates

| Candidate | Classification |
|---|---|
| repo/worktree identity check | MUST automate |
| current branch/revision verification | MUST automate |
| dirty-tree classification | MUST automate |
| duplicate candidate detection | MUST automate |
| authoritative baseline declaration | SHOULD automate |
| supersede graph validation | MUST automate |
| evidence hash/provenance validation | MUST automate |
| runtime artifact path/hash proof | SHOULD automate |
| prerequisite existence check | MUST automate |
| review-bundle current-vs-historical state validation | MUST automate |
| execution-boundary coverage registration | SHOULD automate |
| no-progress / repeated-command governor | MUST automate |
| bounded-search enforcement | MUST automate |
| handoff freshness checks | MUST automate |

`Agent reasoning remains necessary` for: *why* a root is authoritative, whether
drift invalidates review, which repair strategy is proportionate, and whether
reconciliation should escalate. Not every reconciliation decision is automatable.

---

## Human authority boundary

> HIGH RISK ≠ HUMAN APPROVAL REQUIRED. The human approves the **risk envelope**, not every risky decision.

- Agent may autonomously REPAIR / REPLAN **inside** an authorized risk envelope.
- HOLD for human/Controller **only** when: outside the authorized envelope,
  authoritative truth cannot be established, frozen specifications contradict,
  blast radius exceeds authority, an irreversible action lacks recovery, or a
  new product/business decision is required.

---

## Search discipline

- bounded-by-default discovery,
- known authoritative locations first,
- no unbounded recursive traversal over HOME / Development,
- a failed search strategy triggers REPLAN,
- repeated same-scope traversal is never retried indefinitely.
