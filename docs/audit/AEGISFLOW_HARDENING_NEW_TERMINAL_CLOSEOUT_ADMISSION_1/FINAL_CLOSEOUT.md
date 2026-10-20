# Final closeout — new terminal closeout admission

**Card:** `AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1`
**Branch:** `feat/omp-cbm-recovery`
**Canonical remote:** `git@github.com:xonogesrs/aegisflow.git`
**Date:** 2026-10-20

```
CARD                          = AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1
VERDICT                       = HOLD

PREVIOUS_LANDING              = PASS
GOVERNANCE_ADMISSION          = HOLD

ORIGINAL_GENERATION           = 1
ORIGINAL_COMMITTED            = false

NEW_CLOSEOUT_ID               = AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1
NEW_SESSION_ID                = NOT_ASSIGNED
NEW_GENERATION                = NOT_ASSIGNED

CONTROLLER_AUTHORITY          = ABSENT
CONTROLLER_COMMIT             = NOT_EXECUTED
RECEIPT                       = NOT_ISSUED

INDEPENDENT_REVIEW            = PASS
DURABLE_LANDING               = this commit's push (verified below)

HARDENING_BRANCH_CLOSED       = false
NEXT_ACTION                   = Owner records GDR-1 (terminal closeout
                                succession) as governance, then a separately
                                authorized card implements and runs the
                                Controller closeout against the live runtime.
```

Deliverables for this card, in this directory:

| File | Content |
|---|---|
| [`NEW_CLOSEOUT_ADMISSION.md`](NEW_CLOSEOUT_ADMISSION.md) | landing gate, cited evidence, governance question, contract reading, admission decision, proposed GDR-1, fixed closeout identity |
| [`CONTROLLER_PROVISIONING.md`](CONTROLLER_PROVISIONING.md) | extension mechanism from source, per-launcher audit, rejected self-grant paths, minimal proposal P-1…P-4 |
| [`NEW_TERMINAL_RECEIPT.md`](NEW_TERMINAL_RECEIPT.md) | `NOT_ISSUED`, with the receipt schema a future authorized closeout must satisfy |
| [`INDEPENDENT_REVIEW.md`](INDEPENDENT_REVIEW.md) | two reviewer sessions, one HOLD round with corrections, final PASS |
| `FINAL_CLOSEOUT.md` | this file |

---

## 1. Why HOLD and not PASS

Card §10 requires **all** of: `GOVERNANCE_ADMISSION = PASS`,
`CONTROLLER_AUTHORITY = VERIFIED`, a real receipt, `INDEPENDENT_REVIEW = PASS`,
and `DURABLE_LANDING = PASS`. Two of those are false:

1. **Governance admission is HOLD.** The existing contract binds branch closure
   to the original committed fence
   ([`TERMINAL_CLOSEOUT.md:22,180`](../AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/TERMINAL_CLOSEOUT.md))
   and states that substituting a new acceptance "changes governance and needs
   explicit authorization"
   ([`FINAL_DISPOSITION.md:42`](../AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1/FINAL_DISPOSITION.md)).
   No document in the repository grants that authorization. Card §4 also forbids
   reading the card text itself as the grant.
2. **Controller authority is ABSENT.** No shipped launcher sets
   `OMP_TERMINAL_FENCE_AUTHORITY` or supervises a commit
   (`CONTROLLER_PROVISIONING.md` §2). Provenance: this session's own environment
   has no `OMP_TERMINAL_*` variable, the interactive launcher is a `cd` plus
   `exec pi --approve`, and no production entry point issues
   `/fence-generation`.

Neither is an engineering defect, and neither is repairable from inside an agent
session. Attempting either would be the forgery card §10 calls `FAIL`.

## 2. Why not FAIL

No fabricated authority, no back-filled receipt, no original-generation rewrite,
no production mutation, and no branch-closure claim were made. The record states
`committed:false` for the original generation exactly as it was observed.

## 3. What was established (and is durable)

- **Landing gate passed.** HEAD = upstream = explicit canonical ref
  `refs/heads/feat/omp-cbm-recovery` = `4e41bb6412f2d795e0306318000428bce978369b`;
  worktree clean, no stash, no unpushed commits. `origin HEAD` resolves to
  `refs/heads/main` and was deliberately **not** used as the target ref.
- **Evidence chain verified.** Six cited commits (`d217383`, `12298f5`, `e930422`,
  `09df20d`, `773bb8a`, `b02131d`) are ancestors of HEAD
  (`git merge-base --is-ancestor`, all YES), so the engineering PASS is cited from
  reachable, unamended history rather than re-derived.
- **Delta is documentation only.** At the landing gate — before this card's own
  commit — `d217383..HEAD` was one commit and two files
  (`FINAL_DISPOSITION.md`, `INDEPENDENT_REVIEW.md`, both report-only). After this
  card's commit it is two commits and seven files, all under `docs/audit/`.
  N1–N3 were not reopened, and no suite was re-run because no behaviour changed.
- **Authority mechanism re-verified from source**, not from prose: marker test at
  `no-poll-waits.js:312-315`, fail-closed denial at `:366-381`, command binding to
  the live session/current generation at `:807-824`, agent request returning
  `committed:false` at `:780-798`, in-memory generation map at `:173-215`.
- **Integration acceptance still green** after this card's edits:
  `node scripts/omp-integration/run-acceptance.mjs` → `OMP_INTEGRATION_ACCEPTANCE=PASS`,
  `TERMINAL_FENCE_ORDERING=PASS` (24 iterations), `FAILURES: []`, exit 0.
  Drift check: `MATCH=6 EQUIVALENT=1 DRIFT=0 MISSING=0`. This card changed no
  integration file; the run confirms nothing drifted.
- **Identity is fixed for the successor.** `CLOSEOUT_ID =
  AEGISFLOW_HARDENING_TERMINAL_CLOSEOUT_V2_1`, type
  `NEW_AUTHORIZED_CLOSEOUT`, with `NEW_SESSION_ID`/`NEW_GENERATION` deliberately
  unassigned — inventing them before a live Controller runtime exists would be
  identity fabrication.

## 4. What the successor card must do, in order

1. Owner records **GDR-1** (or equivalent) as governance — the text is drafted in
   `NEW_CLOSEOUT_ADMISSION.md` §6. Until it is recorded, `GOVERNANCE_ADMISSION`
   stays `HOLD`.
2. Implement only the minimal Controller described in
   `CONTROLLER_PROVISIONING.md` §5 (P-1…P-4): one entry point, expected-identity
   guard, host-channel commit, durable receipt outside the agent's writable
   scope, fail-closed on any mismatch.
3. Resolve the one open technical question first: whether an RPC prompt frame can
   carry `/fence-generation` for a live session and return the extension's own
   commit result. It is **unverified** here and is a prerequisite, not a detail.
4. Run the closeout from the trusted launcher, capture the receipt, and have a
   reviewer who did not participate verify the receipt itself.
5. Only then set `HARDENING_BRANCH_CLOSED = true` with
   `CLOSURE_BASIS = NEW_AUTHORIZED_CLOSEOUT`, leaving
   `ORIGINAL_TERMINAL_COMMITTED = false` untouched.

Step 1 and step 2 are independent of each other; step 4 requires both.

## 5. Historical records untouched

No existing file was modified. This card adds five files. In particular:

- `TERMINAL_CLOSEOUT.md` keeps `HARDENING_BRANCH_CLOSED = false` and its
  `committed:false` closeout statement.
- The recovery `HOLD` in `FINAL_DISPOSITION.md` stays `HOLD`. Nothing here
  reclassifies it as PASS.
- The aborted first reviewer session produced no verdict and is not cited as
  evidence.

## 6. Durable landing of this record

Verified after the push of the commit carrying this document:

| Check | Value |
|---|---|
| `git rev-parse HEAD` | the pushed commit (this file cannot name its own hash) |
| `git rev-parse @{upstream}` | same as HEAD |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | same as HEAD |
| `git log @{upstream}..HEAD --oneline` | empty |
| `git status --porcelain --untracked-files=all` | empty |
| `git stash list` | empty |

`DURABLE_LANDING = PASS` refers to landing these report files. It does not
change any terminal state, and it does not close the branch.
