# Governance: admission, budgets, review, promotion

"Governance" here is not a policy document — it is the set of mechanical gates
a change must pass, and the durable records that prove it did. Every gate is
code you can read; four of them have frozen contract documents kept in
`docs/governance/`.

## 1. Classification

`src/admission/classify.mjs` turns evidence scores into size, risk and profile.
It makes no model call, and its inputs are claims *about the task* (how many
files, how ambiguous, how much verification), not claims by the model.

Two properties matter:

- **under-classification is detected.** A dimension supplied without a score or
  without a reason marks the classification under-specified rather than
  silently defaulting to zero risk.
- **risk signals can only escalate.** `scanRiskSignals` looks for terms that
  must raise the risk class; nothing lowers it.

## 2. The admission record

`buildAdmissionRecord` + `freezeAdmission` produce one immutable record:

| Field group | What it fixes |
|---|---|
| `capabilities` | required / allowed / denied capability sets |
| `mutation_scope` | the only paths any node may write |
| `tool_permissions` | the tool envelope derived from the granted capabilities |
| `isolation_policy` / `durability_policy` | whether execution is containerised and durable |
| `review_policy` | whether review is required and at what strength |
| `budget` / envelope | the resource envelope |

The record is content-addressed: `admission_id` is derived from the payload, so
a modified record has a different identity and fails the drift check
(`ADMISSION_DRIFT`).

**This is the single source of authority.** Everything downstream is a
projection of it (see [architecture.md](architecture.md)).

## 3. Budget

`src/budget/envelope.mjs` projects a resource envelope, and the ledger meters
usage during execution. The important property is that budget is **reserved
before** execution, not reconciled afterwards:

- a missing ledger remaining value is a HOLD
  (`MISSING_BUDGET_AUTHORITY`), never a full-envelope default;
- an exhausted dimension yields zero allocation → not executable;
- the global split narrows sequentially so the sum of allocations never exceeds
  the global budget.

A run that cannot pay for itself does not start.

## 4. Scope enforcement

`src/c2d/mutation-scope.mjs`:

- `captureScopeSnapshot` records the tree state;
- `enforceScopeGate` compares before/after and reports the delta plus any
  violation (`outside_allowlist`, `forbidden_path`,
  `path_escape_or_symlink_or_git`).

Containment rules, all fail-closed: a path outside the repository, through a
symlink, or inside `.git` is a violation regardless of the allowlist.

**One canonicalization seam.** The same module owns the path semantics every
scope *decision* in the system uses — `canonicalScopePath` (pure lexical),
`canonicalRepositoryPath` (adds root containment and symlink rejection),
`canonicalScopeEntry` (a declared boundary, trailing-separator tolerant:
`src/` ≡ `src`) and `isWithinCanonicalScope` (component-wise containment over
canonical paths). The admission scope projection
(`src/admission/policy-projection.mjs`), the writer-result validation
(`src/subagent/subagent-contract.mjs`) and the host-side writer scope
verification (`src/subagent/subagent-writer-executor-adapter.mjs`) all resolve
through it. A projection therefore never reports a boundary as authorized that
`enforceScopeGate` would canonicalize away: an entry or boundary that is
unresolvable, ambiguous (a glob), absolute, or lexically/canonically escaping
is refused at projection time. The parity corpus is
`test/admission/test-scope-projection-canonicalization.mjs`.

**Write containment is a second, git-independent layer.**
`enforceScopeGate` classifies git's changed-path inventory. A write performed
**through a symlink that already exists in the worktree** produces no changed
path at all — the symlink blob is unchanged and the content went outside the
tree — so the delta is empty and the gate has nothing to classify; path
canonicalization never sees the write either. That class is covered by
`src/c2d/write-containment.mjs`, which never consults git:

- `scanSymlinkEscapes(root)` walks the materialized worktree without following
  symlinks and reports every link whose resolved target — or, when the link is
  dangling, its lexically resolved target — leaves the root;
- `auditBoundarySymlinkComponents(root, boundaries)` refuses a declared
  writable boundary whose literal path component is a symlink, resolvable or
  dangling;
- `verifyWriteContainment({ root, boundaries })` is the decision (`ok: false`
  means: do not execute).

The C3B boundary (`src/c2d/mutation-run.mjs`) audits the isolated worktree
**before** dispatching the mutation — a symlink escape is a `SCOPE_VIOLATION`,
the command never runs and nothing is written outside — and audits again after
it, so a symlink created or swapped in during the mutation fails the run
closed. The host-side writer verification
(`src/subagent/subagent-writer-executor-adapter.mjs`) applies the same scan to
its worktree. Containment can only deny: it never widens a scope and never
replaces the admission gate, the canonical scope projection or the
post-mutation git gate. `canonicalRepositoryPath` refuses a symlink component
by `lstat`-ing each component *before* any existence test, so a dangling link
is refused exactly like a resolvable one. Regression:
`test/test-write-containment.mjs`.

## 5. Evidence

`src/v2/harness-evidence.mjs` builds the implementation-evidence object from
harness observations:

- identity is mechanically bound (a mismatch is
  `HARNESS_EVIDENCE_IDENTITY_MISMATCH`);
- the verification command is run **by the harness**, and its exit code is
  recorded — a writer phase cannot pass without a system-observed test process
  (`HARNESS_TEST_EVIDENCE_MISSING`);
- the object must satisfy the published schema
  (`HARNESS_EVIDENCE_SCHEMA_INVALID`) — fields are never guessed;
- `executor_verdict` is derived (`PASS` only when the scope check passed and
  the verification command succeeded), not copied from the model.

`src/v2/system-delta.mjs` independently re-observes changed paths: per-path
before/after SHA-256, a re-derived patch, and nine fail-closed gates including
a secret scan.

## 6. Review

Three structural properties:

1. **Role separation.** The reviewer is a distinct role. Its projected tool
   policy is no-tools: a reviewer reaching the tool selector is treated as a
   bypass attempt.
2. **Independence is checked, not asserted.** The reviewer identity must be
   independent of the executor. Self-approval is refused by construction, and
   in the evolution path an `agent:`-prefixed or self-identifying reviewer is
   rejected.
3. **Verdicts are fail-closed.** `PASS` requires `confidence: HIGH` and zero
   blocking issues and zero evidence gaps. A malformed or schema-invalid
   verdict is `MALFORMED_REVIEWER_VERDICT`, not a soft pass.

The reviewer receives objective facts (changed paths, digests, test results)
alongside the model's narrative — and the narrative is labelled advisory.

## 7. Closeout and external review

`src/governance/` carries the lifecycle:

- **closeout state** — a durable record of a card's terminal state, read back
  by `readCloseoutState()`;
- **review bundle / review job** — a self-contained, reviewable artifact plus
  the job record that tracks its lifecycle to exactly one accepted verdict;
- **external review surface** — a fixed inbox where at most one card awaits a
  verdict, with a flat archive on rotation;
- **execution review** — the human-facing entrypoint for the latest formal
  execution's review.

Delivery is a *verified dereference* of authoritative lifecycle state — card
identity, bundle identity, content SHA and lifecycle state — never a filesystem
discovery by filename or mtime. Stale-bundle delivery was a real defect class,
and the fix is in the contract.

## 8. Promotion gates

Before a change may be committed, all of these must hold *simultaneously*:

| Gate | Failure |
|---|---|
| admission drift | `ADMISSION_DRIFT` |
| budget re-check | budget HOLD |
| scope re-verification | `MUTATION_SCOPE_VIOLATION` |
| evidence identity + schema | harness evidence HOLD |
| review verdict | `MALFORMED_REVIEWER_VERDICT` / non-PASS |
| semantic drift (canonical digest comparison) | drift HOLD |
| live HEAD equals the reviewed baseline | stale baseline HOLD |
| pass oracle | oracle rejection code |

A gate is not "mostly passed". The pass oracle (`src/governance/pass-oracle.mjs`)
exists precisely to reject a self-certified PASS: only executor-role evidence
supported by independent verification counts.

## 9. Commit

The commit path re-verifies that the tree, the evidence digest and the verdict
still agree with what was reviewed. `commit_allowed` is derived from the
admission, not requested. The commit carries a gate footer naming the card, run
and evidence digest, so the commit itself is traceable to the gate that
authorised it.

## HOLD codes: the diagnostic surface

A HOLD is a structured refusal with a stable code. Names are worth knowing
because they tell you *which* fence you hit:

| Prefix | Domain |
|---|---|
| `ADMISSION_*` | admission construction, drift, envelope scope |
| `TOOL_SELECTION_*` | runtime identity, vocabulary, mapping drift |
| `MUTATION_SCOPE_VIOLATION` | a write outside the admitted scope |
| `HARNESS_EVIDENCE_*` / `HARNESS_TEST_*` | harness-owned evidence gates |
| `JOURNAL_*` / `RESUME_*` | durable state integrity |
| `COLIMA_*` | sandbox runtime and storage gates |
| `CROSS_SESSION_ROLLOVER_*` | session handover |
| `EXTERNAL_REVIEW_*` / `BUNDLE_*` | review artifact lifecycle |
| `EVOLUTION_*` | autonomous evolution policy and promotion |
| `ORACLE_*` | pass-oracle rejections |

## Frozen contracts

Four documents in `docs/governance/` are the authoritative contracts for
behaviour the code implements. They are named by the code they bind:

| Document | Binds |
|---|---|
| `authority-execution-truth-invariants.md` | what counts as truth vs. what is an input |
| `control-plane-ownership-contract.md` | who owns scheduling/retry/budget decisions |
| `cost-optimizer-contract.md` | budget optimisation and its limits |
| `review-bundle-format.md`, `review-bundle-reconciliation.md` | the reviewer-facing artifact format |
| `reversible-lifecycle.md` | the reversible lifecycle and its authority |
| `pre-execution-reconciliation-protocol.md` | re-derivation before execution |
| `autoloop-p4-pass-oracle-contract.md` | the PASS oracle |
| `autoloop-auth1-tc1-ordering-contract.md` | terminal verdict ordering |
| `autoloop-s16-telemetry-authority-location-and-retention-contract.md` | telemetry location and retention |
| `autoloop-post-p4-governance-convergence.md` | semantic drift gate |
| `rb-ssg2-pi-command-admission-coverage.md` | command-admission coverage |
| `rb-ssg3-pi-runtime-enforcement-acceptance.md` | runtime enforcement acceptance |
| `rb-ssg4-fr4-bounded-search-execution-foundation.md` | the bounded-search execution model |
| `rb-ssg4-rc1-search-governance-objective-and-enforcement-boundary-reconciliation.md` | the search-governance enforcement boundary |
| `phase-r-teaching-case.md` | the Phase-R teaching case |

Historical card records (closeouts, reviews, process narratives) are not in the
public tree — they are internal operational records.
