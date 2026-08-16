# AUTOLOOP-REVART-RC1B — Review Execution Context & Artifact Provenance Reconciliation

## Status

`READY_TO_START` → **`RECONCILED`** (this document)

## Type

Foundation Reconciliation / Execution-Context Authority Repair (read-only + contract freezing)

## Parent

`AUTOLOOP-REVART-RC1A`

## Trigger

RC1A Independent Review returned `REPAIR_REQUIRED / RC1A_ARCHITECTURE_NOT_READY_FOR_IMPL1_SPEC`
with a decisive finding ("target RC1A file does not exist") that was internally inconsistent
with the producer's own record ("RC1A written, 698 lines, untracked").

## Implementation Authorization

**NO.** This document reconciles execution contexts and freezes a review-context
contract. It does not authorize IMPL1, source mutation, AUTH1 change, or any
context-binding implementation.

---

# 1. Verdict (local)

```
PASS / RC1B_REVIEW_EXECUTION_CONTEXT_AND_ARTIFACT_PROVENANCE_RECONCILED
```

RC1B PASS does **not** authorize IMPL1 and does **not** constitute an RC1A
architecture verdict.

---

# 2. D1 — Context Incident Reconstruction

## 2.1 The two contexts are two different repositories

| Dimension | Producer (RC1A) | Reviewer (previous round) | Match? |
|---|---|---|---|
| Repository identity | `git@github.com:xonogesrs/autoloop.git` | `git@github.com:xonogesrs/aura.git` | **NO** |
| Absolute repo root | `/Volumes/NVM2T/Development/autoloop` | `/Users/zhengfengqing/auracore` | **NO** |
| Worktree root | `/Volumes/NVM2T/Development/autoloop` | `/Users/zhengfengqing/auracore` | **NO** |
| Branch | `governance/reversible-lifecycle-draft-pr` | `master` | **NO** |
| HEAD | `56bb281fee0ac3735cdff08949e9d71997e6011c` | `acce6ec53672427c2044e41f4e06a33049255144` | **NO** |
| RC1A absolute path | `/Volumes/NVM2T/Development/autoloop/docs/governance/autoloop-revart-rc1a-durable-review-authority-architecture-closure.md` | (never resolved; searched `/Users/zhengfengqing/auracore` only) | **NO** |
| RC1A presence | **exists**, 698 lines, 31,162 bytes, untracked | reported "No such file or directory" | **NO** |
| RC1A SHA-256 | `fdf41313c3d2f1e1fb1cdf8d7ba8480a9e3ff746a111344d411c7c028237c1c4` | n/a | — |
| Candidate (AUTH1) state | 13 tracked modified files, +133 / −33 | (different repo — N/A) | **NO** |
| Filesystem namespace | external volume `NVM2T` | internal boot volume | **NO** |

## 2.2 The reviewer inspected a different repo that contains a same-named subsystem

`/Users/zhengfengqing/auracore` is the **music engine** (`aura.git`). It embeds an
older-generation AutoLoop-like harness at `scripts/ai/autoloop/` (with
`candidate-review.mjs`, `authority-ledger.mjs`, `c2d/*`, etc.), but that embedded
copy is **not** the AutoLoop project and does **not** contain `closeout-state.mjs`,
`review-context.mjs`, `review-history.mjs`, `delivery.json`, or any RC1A/REVART
governance document.

The reviewer searched that embedded harness, found none of the RC1A-cited
machinery, and concluded the architecture and its foundation were absent.

## 2.3 Reviewer session cwd

Reviewer session cwd was `/Users/zhengfengqing` (home), **not** the AutoLoop repo.
A HOME-wide search for the real repo was blocked by the deployed
`search-scope-governor` (`UNBOUNDED_HOME_TRAVERSAL` / `MISSING_SEARCH_DECLARATION`),
so the reviewer never reached `/Volumes/NVM2T/Development/autoloop`.

---

# 3. D2 — Root-Cause Classification

**`C1 — WRONG_REPOSITORY`** (primary) with **`C6 — CONTEXT_NOT_PREDECLARED`** (upstream cause).

Mechanism:

```text
no predeclared review context
  → reviewer cwd = HOME, not the target repo
  → reviewer must "find the repo" opportunistically
  → bounded-search governor blocks HOME-wide discovery (correctly)
  → reviewer latches onto a same-named embedded subsystem in the wrong repo
  → reviewer produces a coherent verdict about the wrong filesystem state
```

This is the exact "reviewer decides which world it is reviewing" defect that
RC1B is chartered to close. No `C7 — PRODUCER_CLAIM_FALSE` applies: the producer
claim is **true** (RC1A exists, 698 lines, untracked, at the claimed path in the
claimed repo).

---

# 4. D3 — Review Execution Context Contract (frozen)

Every independent review job MUST receive the following **before** reviewer
execution begins. The reviewer MUST NOT discover its own target by broad search.

```text
reviewExecutionContext:
  repoIdentity          # durable, mechanically verifiable (canonical remote / root marker)
  repoAbsolutePath      # e.g. /Volumes/NVM2T/Development/autoloop
  worktreeAbsolutePath  # explicit; not inferred from shell cwd
  expectedHead          # HEAD/base the review is bound to
  candidateIdentity     # base_head + current_head + patchSha256 + changedTreeIdentity
                        # + relevant untracked-file identity + dirty-state contract
  targetArtifacts[]     # per artifact: role, absoluteOrMechanicallyDerivedPath,
                        #   requiredExistence, expectedDigestIfKnown, trackedState, schema
  specIdentity          # specId + specDigest
  reviewLineageIdentity # cardId lineage + generation (monotonic)
```

### 4.1 Repository identity

`repoIdentity` must distinguish repositories even when directory names collide
(e.g. `autoloop.git` vs `aura.git` both containing a path segment named
`autoloop`). Canonical remote identity is the minimum; a repo-local durable
identifier is preferred.

### 4.2 Absolute worktree binding

The reviewer may not search HOME, choose another clone/worktree, or use the
current shell directory by convention. `resolved worktree == declared worktree`
is mechanically verified before review. Mismatch → `HOLD / REVIEW_WORKTREE_IDENTITY_MISMATCH`.

### 4.3 HEAD binding

`actual HEAD == expected HEAD` (or the candidate contract explicitly authorizes
a dirty base). Mismatch → `HOLD / REVIEW_HEAD_MISMATCH`.

### 4.4 Dirty candidate binding

HEAD alone is insufficient. The candidate identity (§8 of RC1A) is recomputed
from the live tree and must match. Mismatch → `HOLD / REVIEW_CANDIDATE_IDENTITY_MISMATCH`.

---

# 5. D4 — Pre-Review Context Gate

Before substantive review begins, a mandatory gate verifies, in order:

1. correct repository identity;
2. correct worktree root;
3. expected HEAD/base;
4. expected candidate identity (recomputed, not caller-supplied);
5. target artifact path resolves inside the bound worktree;
6. required target exists;
7. digest matches when predeclared;
8. spec identity matches;
9. review lineage/generation is current.

Only after all pass may state advance to `REVIEW_CONTEXT_BOUND`.

---

# 6. D5 — Drift / Supersession Rules

If context changes after review starts (HEAD moves, candidate diff changes,
target artifact bytes change, untracked test changes, spec changes, worktree
reset, another process stages files), the review MUST NOT silently continue
against mixed generations.

Outcome: `SUPERSEDE` (newer generation exists) or `HOLD` (mismatch with no newer
generation). A verdict produced against one context must never attach to another.

---

# 7. D6 — Prior Finding Reclassification

| Finding | Prior claim | Reclassification | Evidence |
|---|---|---|---|
| **R-001** | "RC1A not persisted; session-only" | **INVALID_CONTEXT** | RC1A exists: `/Volumes/NVM2T/Development/autoloop/docs/governance/autoloop-revart-rc1a-durable-review-authority-architecture-closure.md`, 698 lines, 31,162 B, SHA-256 `fdf41313…c1c4`, untracked. |
| **R-002** | "convergence machinery absent" | **INVALID_CONTEXT** | `closeout-state.mjs`, `review-context.mjs`, `review-history.mjs` exist under `src/governance/`; `gov-controller-ingest-result.mjs`, `gov-closeout-bundle.mjs`, `gov-review-bundle.mjs` exist under `scripts/`. `Current/delivery.json` is a runtime surface produced by `src/governance/review-bundle.mjs` (identity/sha/supersedes + atomic/idempotent publish), not a tracked file. |
| **R-003** | "legacy reviewer-authored evidence / verdict schema / legacy verdict paths still authoritative" | **INVALID_CONTEXT as cited**; substance remapped | R-003's citations (`docs/loop/review-contract.md`, `docs/loop/state-transitions.md`, `schema/reviewer-verdict.schema.json`, `external-review-reader.mjs`) are all from the **wrong repo** (`aura.git`). The correct surfaces are `src/governance/external-review.mjs`, `review-bundle.mjs`, `closeout-state.mjs`. RC1A §7.1/§7.2 already classifies legacy paths (external-review-result.json → RETIRED, 11-section gov-review-bundle → RETIRED, per-card IR/self-closeout scripts → HISTORICAL). → **Carry as a re-review checklist item, not a standalone blocker.** |

---

# 8. D7 — RC1A Re-review Preconditions

The RC1A independent review may be rerun only after ALL of:

1. review context predeclared with the §4 fields (repo = `/Volumes/NVM2T/Development/autoloop`,
   branch `governance/reversible-lifecycle-draft-pr`, HEAD `56bb281…`, RC1A absolute path + SHA-256 above);
2. §5 pre-review context gate passes;
3. reviewer cwd/repo bound to the declared worktree (not HOME);
4. candidate identity (AUTH1: 13 tracked +133/−33 + untracked `test/admission/test-retrieval-authority.mjs`) recomputed and bound;
5. R-003's substance rechecked against `src/governance/external-review.mjs` / `review-bundle.mjs` / `closeout-state.mjs` (does RC1A §7.2 actually retire every legacy acceptance path?).

---

# 9. Adversarial Scenario Outcomes (frozen, deterministic)

| # | Scenario | Outcome |
|---|---|---|
| 1 | correct repo, wrong worktree | `HOLD` |
| 2 | wrong repo with same folder names | `HOLD` |
| 3 | correct worktree, wrong HEAD | `HOLD` |
| 4 | correct HEAD, candidate diff changed | `HOLD` / `SUPERSEDE` |
| 5 | target artifact untracked in producer worktree only | `HOLD` |
| 6 | target artifact deleted between job creation and execution | `HOLD` |
| 7 | target artifact changed after preflight | `HOLD` |
| 8 | reviewer begins in HOME directory | `HOLD` (context not bound) |
| 9 | reviewer discovers a stale clone first | `HOLD` (repo identity mismatch) |
| 10 | two worktrees, same artifact path, different bytes | `HOLD` |
| 11 | spec path correct, spec digest changed | `HOLD` |
| 12 | reviewer resumes after worktree reset | `HOLD` |
| 13 | review result exists, context provenance missing | `REJECT` |
| 14 | context correct, review result session-only | `RESUME` (incomplete) |
| 15 | artifact + result durable but different generations | `SUPERSEDE` |

---

# 10. Acceptance Criteria Mapping (RC1B §23)

| AC | Requirement | Result |
|---|---|---|
| AC1 | producer context identified | **YES** — `/Volumes/NVM2T/Development/autoloop` @ `56bb281` |
| AC2 | reviewer context identified | **YES** — `/Users/zhengfengqing/auracore` @ `acce6ec5` |
| AC3 | visibility-mismatch cause established without guessing | **YES** — C1 + C6 (evidence: remotes, HEADs, governor blocks) |
| AC4 | review target context becomes predeclared input | **YES** — §4 frozen |
| AC5 | repo/worktree identity mechanically verified before review | **YES** — §4.1/§4.2 frozen |
| AC6 | dirty candidate identity bound (not HEAD-only) | **YES** — §4.4 frozen |
| AC7 | required review artifacts predeclared | **YES** — §4 `targetArtifacts[]` |
| AC8 | wrong-context review cannot reach substantive review | **YES** — §5 gate |
| AC9 | context drift invalidates/supersedes deterministically | **YES** — §6 |
| AC10 | verdict provenance includes reviewed context | **YES** — §4 fields |
| AC11 | persistence vs context binding modeled as separate invariants | **YES** (RC1B §17) |
| AC12 | prior RC1A verdict not incorrectly reused | **YES** — set to `HOLD / INDEPENDENT_REVIEW_EXECUTION_CONTEXT_UNBOUND` |
| AC13 | R-001/R-002/R-003 individually reclassified | **YES** — §7 |
| AC14 | 15 adversarial scenarios deterministic | **YES** — §9 |
| AC15 | no AUTH1/RC1A implementation mutation | **YES** — read-only throughout |

---

# 11. Boundary Reminder

RC1B resolves **where the world is**, not **whether the world is correct**.

- RC1A architecture verdict: **still `HOLD / INDEPENDENT_REVIEW_EXECUTION_CONTEXT_UNBOUND`** — not yet PASS, not yet REPAIR_REQUIRED.
- Next action: bind the §4 review context, run the §5 gate, then re-run the RC1A
  independent architecture review against `/Volumes/NVM2T/Development/autoloop`.

---

# 12. Execution Order (unchanged)

```text
RC1 → RC1A Architecture Closure
→ RC1A Independent Review (context-mismatched → HOLD)
→ RC1B Context & Provenance Reconciliation   ← THIS DOCUMENT
→ Context Gate Frozen (§4–§6)
→ Fresh RC1A Independent Review (correctly bound)
→ PASS → AUTOLOOP-REVART-IMPL1 Spec
```
