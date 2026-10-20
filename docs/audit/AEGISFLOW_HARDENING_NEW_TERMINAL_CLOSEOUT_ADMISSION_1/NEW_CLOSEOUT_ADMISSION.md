# AEGISFLOW hardening — new terminal closeout admission

**Card:** `AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1`
**Branch:** `feat/omp-cbm-recovery`
**Mode:** governance admission only — no production code, test, config or environment change
**Date:** 2026-10-20

This document decides only one thing: whether existing governance already
authorizes a **new** Controller-supervised closeout to serve as the formal
closure basis for the hardening branch. It establishes the identity that
*would* be used. It does not claim a Controller commit, and it does not close
the branch.

```
CARD                          = AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1
CLOSEOUT_ID                   = AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1
CLOSEOUT_TYPE                 = NEW_AUTHORIZED_CLOSEOUT
GOVERNANCE_ADMISSION          = HOLD
CONTROLLER_COMMIT             = NOT_AUTHORIZED
HARDENING_BRANCH_CLOSED       = false
```

---

## 1. Prior-card durable landing gate (§3 of the card)

Measured in `/private/tmp/aegis-repair-1` after `git fetch origin --prune`, and
re-measured immediately before this document was written.

| Check | Command | Value |
|---|---|---|
| worktree | `git status --porcelain=v1 --untracked-files=all` | empty (0 lines) |
| head | `git rev-parse HEAD` | `4e41bb6412f2d795e0306318000428bce978369b` |
| upstream | `git rev-parse @{upstream}` | `4e41bb6412f2d795e0306318000428bce978369b` |
| canonical remote ref | `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | `4e41bb6412f2d795e0306318000428bce978369b` |
| default-branch head (NOT used as the target) | `git ls-remote --symref origin HEAD` | `ref: refs/heads/main` → `1cf1e9fa284d2407c4edbe42f525fffe12a169c2` |
| unpushed | `git log @{upstream}..HEAD --oneline` | empty |
| stash | `git stash list` | empty |
| remote | `git remote -v` | `origin git@github.com:xonogesrs/aegisflow.git` |

`origin HEAD` points at `refs/heads/main`, which is **not** the canonical target
for this work. The gate is therefore taken from the explicit
`refs/heads/feat/omp-cbm-recovery` ref, not from the default branch. HEAD =
upstream = canonical ref = `4e41bb64…`.

`PREVIOUS_REVIEW = PASS` and `PREVIOUS_LANDING = PASS` are the recorded
dispositions of the prior card
([`INDEPENDENT_REVIEW.md`](../AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1/INDEPENDENT_REVIEW.md),
[`FINAL_DISPOSITION.md`](../AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1/FINAL_DISPOSITION.md) §7).
**Gate result: PASS.**

## 2. Evidence this closeout identity would cite

All six commits below were re-verified as ancestors of the current head
(`git merge-base --is-ancestor`), i.e. they are reachable and unamended:

| Cited evidence | Identity | Verified |
|---|---|---|
| engineering baseline | `d217383040b531dcefd01cc36ea2db14d6e66a1c` | ancestor of HEAD |
| reviewed head of the hardening card | `12298f5a8424ad5013dc091b680217dc9f9f0f6b` | ancestor of HEAD |
| first closeout landing | `e930422268f297b52742622f4f484d8700dd93a3` | ancestor of HEAD |
| N1 fix | `09df20d` | ancestor of HEAD |
| review-reproduced defect fix | `773bb8a` | ancestor of HEAD |
| N3 journal binding | `b02131d` | ancestor of HEAD |
| recovery HOLD record | `4e41bb6412f2d795e0306318000428bce978369b` | HEAD |

Engineering disposition carried forward, **not re-derived**:

```
N1_N3                         = PASS
N4                            = BOUNDARY_RECORDED  (record, not a change)
EVOLUTION_TESTS               = 121/121 PASS
ADVERSARIAL_TESTS             = 17/17 PASS
PRODUCTION_EVOLUTION          = DISABLED (no deployment declaration)
ORIGINAL_GENERATION           = 1
ORIGINAL_REQUEST              = PASS, committed:false
ORIGINAL_SESSION_RUNTIME      = EXITED
RECOVERY_VERDICT              = HOLD
RECOVERY_REVIEW               = PASS
RECOVERY_DURABLE_LANDING      = PASS
```

Delta from the engineering baseline `d217383` to the current head is
**documentation only** — one commit (`4e41bb6`), two added files
(`FINAL_DISPOSITION.md`, `INDEPENDENT_REVIEW.md`), zero `.mjs`/`.ts`/`.sh`/
manifest changes. Nothing in this card reopens N1–N3.

## 3. The question this card has to answer

> Does the existing governance contract already permit a new,
> Controller-supervised closeout — with a new Session ID and a new generation —
> to serve as the formal closure basis for the hardening branch, while original
> generation 1 remains `committed:false`?

## 4. What the contract actually says

Searched: `AGENTS.md`, `SECURITY.md`, `README.md`, `docs/*.md`,
`docs/governance/*`, `docs/audit/*`, `integrations/omp/README.md`,
`src/governance/*`, `scripts/pi-aegisflow.sh`, `scripts/*launcher*`.

**4.1 Branch closure is bound to the committed fence.** The hardening closeout
record states the binding directly:

- [`TERMINAL_CLOSEOUT.md:22`](../AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/TERMINAL_CLOSEOUT.md#L22):
  `HARDENING_BRANCH_CLOSED = false  (pending the committed fence)`
- [`TERMINAL_CLOSEOUT.md:180`](../AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/TERMINAL_CLOSEOUT.md#L180):
  the record "does not claim a fence that did not happen", so the flag "remains
  `false` until the fence is committed".

**4.2 Substitution needs explicit authorization.** The recovery disposition
states it as a governance change, not a mechanical recovery:

- [`FINAL_DISPOSITION.md:42`](../AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1/FINAL_DISPOSITION.md#L42):
  "Existing hardening closeout contract ties branch closure to the original
  pending committed fence; treating a new acceptance as sufficient to close that
  branch **changes governance and needs explicit authorization**."
- [`FINAL_DISPOSITION.md:73`](../AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1/FINAL_DISPOSITION.md#L73):
  `NEXT_ACTION = Obtain explicit governance decision for distinct new closeout…`

**4.3 The authority model does not mint closure from a record.** The closeout
stage machine makes a persisted record descriptive only, and reserves `CLOSED`
for an actual authoritative operation:

- `src/governance/closeout-state.mjs:79-116` — a persisted `stage:"CLOSED"` is
  never echoed back as authority; `CLOSED` is granted "only after an actual
  authoritative closeout/commit/seal operation is recorded".

**4.4 A prior PASS does not transfer.** `docs/governance/authority-execution-truth-invariants.md`
(AET-2) — a previous PASS proves a previous state, not a current prerequisite.

**4.5 No supersession clause covers closeout identity.** `docs/governance/` has
supersession machinery for review-bundle generations
(`buildSupersedeRecord`, `createSuccessorReviewJob`) and for artifact
classification (`docs/governance/pre-execution-reconciliation-protocol.md`), but
nothing that lets a successor **terminal closeout** stand in for an
uncommitted terminal generation. The closest analogue —
`createSuccessorReviewJob` supersession — supersedes a *review job*, not a
runtime terminal fence, and that fence is host-runtime state, not repo state.

**4.6 The card's own text is not an authorization.** The card reserves this
explicitly (§4): "不得自行將本卡的任務描述視為已核准所有治理例外" — the task
description must not be read as blanket approval of the governance exception.

## 5. Admission decision

```
GOVERNANCE_ADMISSION = HOLD
CONTROLLER_COMMIT    = NOT_AUTHORIZED
```

Rationale, in one sentence: the identity, the evidence and the technical
preconditions are all satisfiable, but **no existing document grants a
successor closeout the authority to close the branch that an uncommitted
original fence left open**, and the two documents that address the question say
so explicitly.

This is not a failure of the engineering, and it is not a re-opening of the
recovery verdict. It is the contract behaving as designed: closure authority is
not inferable, so it must be granted.

## 6. Proposed governance decision for Owner approval

Submitted as a decision request, **not** applied by this card. If approved, it
should be recorded in a governance document (e.g. an amendment to
`TERMINAL_CLOSEOUT.md`'s closure clause, or a new
`docs/governance/terminal-closeout-succession.md`) before Phase D is attempted.

> **GDR-1 — terminal closeout succession.**
>
> 1. An OMP run generation whose runtime has exited and whose terminal request
>    was never Controller-committed is **expired**, and MUST remain recorded as
>    `committed:false`. It MUST NOT be reopened, back-filled, re-committed, or
>    attributed to a later runtime.
> 2. An expired generation MAY be superseded for **branch-closure purposes only**
>    by a distinct, explicitly identified successor closeout
>    (`CLOSEOUT_TYPE = NEW_AUTHORIZED_CLOSEOUT`) that runs in a live runtime with
>    its own Session ID and its own generation.
> 3. The successor MUST cite, by immutable identity: the engineering baseline,
>    the reviewed head, the suites and their counts, the independent review, and
>    the durable landing of the branch. It MUST NOT re-derive or weaken them.
> 4. The successor MUST NOT rewrite, amend, or annotate the expired generation's
>    records. Historical `HOLD`/`FAIL` records stay as written.
> 5. Closure requires a real Controller receipt (`committed:true`, matching new
>    Session ID and generation, `authority = controller-command`) verified by a
>    reviewer that did not participate in the closeout.
> 6. On success the branch is recorded as
>    `HARDENING_BRANCH_CLOSED = true`,
>    `CLOSURE_BASIS = NEW_AUTHORIZED_CLOSEOUT`, with original
>    `ORIGINAL_TERMINAL_COMMITTED = false` unchanged. The closure MUST NOT be
>    described as "original generation 1 committed".
> 7. This grant does not authorize production evolution, does not authorize a
>    Controller architecture change, and does not weaken the fail-closed
>    authority check.

Until that text (or equivalent) is recorded as governance, the correct
disposition for this card is `HOLD`.

## 7. Identity that a future Phase D would use

Fixed now so a later card cannot quietly redefine it:

```
CLOSEOUT_ID                   = AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1
CLOSEOUT_TYPE                 = NEW_AUTHORIZED_CLOSEOUT
SUPERSEDES                    = (nothing for engineering; supersedes only the closure basis)
ORIGINAL_GENERATION           = 1
ORIGINAL_COMMITTED            = false
ORIGINAL_SESSION_ID           = 01a15944-556f-7234-beed-b21fe74fd214
ORIGINAL_RUNTIME_PID          = 6407 (exited)
ENGINEERING_BASELINE          = d217383040b531dcefd01cc36ea2db14d6e66a1c
RECOVERY_BASELINE             = 4e41bb6412f2d795e0306318000428bce978369b
HISTORICAL_REWRITE            = FORBIDDEN
NEW_SESSION_ID                = NOT_ASSIGNED
NEW_GENERATION                = NOT_ASSIGNED
```

`NEW_SESSION_ID`/`NEW_GENERATION` are deliberately unassigned: assigning them
before a live Controller runtime exists would be inventing identity, and the
runtime that would carry them must be the one the launcher starts.

## 8. Scope attestation

No file under `src/`, `test/`, `integrations/`, `scripts/` was modified. No test
was re-run, because nothing in this card changes behaviour. No environment
marker was set on any process. No `/fence-generation` command was dispatched by
an agent. This document and its three companions are the only additions.
