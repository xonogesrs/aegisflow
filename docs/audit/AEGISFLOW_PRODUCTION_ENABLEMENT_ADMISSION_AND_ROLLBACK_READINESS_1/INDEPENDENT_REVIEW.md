# Independent review

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Reviewer:** a fresh `reviewer` session that authored none of this card's files.
Read-only: no edits, no production mutation, no authority provisioning, no harness
re-execution in the deciding pass.
**Reviewer verdict:** `HOLD` — and it was right to hold.
**Review rounds:** 1 (long, interactive), 8 findings, all addressed below.

The reviewer's verdict is recorded as `HOLD`, not converted to `PASS` after the
findings were fixed. That is deliberate: the review found that the documents had
asserted `INDEPENDENT_REVIEW = PASS` and `DURABLE_LANDING = PASS` **before either
had happened**, and the honest record of a review that caught that is the review's
own verdict, not a retroactive green.

---

## 1. Verdict block, verbatim

```
REVIEW = HOLD
LANDING_CLAIM = UNSUPPORTED
BASELINE = SUPPORTED
CHANGE_PLAN = COMPLETE
C1_DISPOSITION = SUPPORTED
C2_DISPOSITION = SUPPORTED
C3_DISPOSITION = SUPPORTED
C4_DISPOSITION = SUPPORTED
REHEARSAL_EVIDENCE = UNSUPPORTED
ROLLBACK = UNSUPPORTED
PRODUCTION_MUTATION = NONE
SCOPE = WITHIN
```

The reviewer also stated, and this card adopts:

> The production-enablement HOLD is justified. Both load-bearing C1 effects follow
> from the consuming code: a correctly attributed forged ledger record satisfies
> `probeLedgerForCommit`, while `commitRecordState` closes the generation without
> matching its runtime identity or allocation token. The remaining findings
> concern supporting claims and operator instructions, not grounds for enabling
> production.

That is the important split. The **card's verdict** (`HOLD`) rests on the C1
measurement, and the reviewer independently supported it from source. The
**review's verdict** (`HOLD`) rests on eight defects in this card's own supporting
claims, which are listed and resolved below.

## 2. What the reviewer verified independently

| Check | Result |
|---|---|
| all ten live extension/test files, `config.yml`, `models.yml`, `mcp.json`, `~/.local/bin/omp` hashed against the baseline | **every hash matched** |
| `git diff --numstat fb8ce6a..2fa42d6` over `KNOWN_FILES` | six entries; confirmed the revised plan distinguishes repo delta from live delta |
| filesystem type | APFS on both inspected local volumes |
| `uninstall` as rollback | correctly rejected; its treatment of files without backups deletes pre-existing dependencies and `cbm-query.js` |
| rollback reversal mapping, out-of-tree evidence preservation | supported |
| C2 shared-directory restriction, C3 per-launch correlation | supported |
| unauthorized production mutation | none found |
| scope | within the card |

Reviewer's stated limits, preserved: it ran no harness, tests, builds or
formatters; it made no file changes; it did not independently exercise a durable
write failure for C4; and matching present-day hashes does not prove the absence of
every possible transient mutation.

## 3. Findings and resolutions

| # | Sev | Finding | Resolution |
|---|---|---|---|
| 1 | HIGH | `FINAL_DISPOSITION` asserted `INDEPENDENT_REVIEW = PASS` and `DURABLE_LANDING = PASS` while the review was running and the directory was untracked | `INDEPENDENT_REVIEW = HOLD`, `DURABLE_LANDING = PENDING`; landing is recorded only after the push |
| 2 | MEDIUM | the Phase 0 gate's "before any admission work" timing has no retained transcript | the document now separates what is independently checkable (refs, re-verified at the end) from the session-ordering claim, which it says is not third-party auditable |
| 3 | HIGH | the rollback rehearsal seeded two files, so `cbm-query.js` and four tests were `copy` actions and rollback deleted them; the "untouched" claim described a two-file tree | seed is now the full production-shaped set from the correct per-file revisions; four new facts assert the action classes (`preexisting-files-unchanged`, `r3-files-copied`, `preexisting-files-survived`, `r3-files-removed`) |
| 4 | HIGH | recovery instructions said to reconstruct everything from `fb8ce6a`, which would downgrade `cbm-query.js` | new §8a table names the revision and expected hash **per file**; `cbm-query.js` restores from `1ebb121` |
| 5 | MEDIUM | "unset the parent marker stops future governed launches" is false — the client provisions the marker in every child it launches | §4b and §5 step 2 rewritten: clearing an inherited marker only removes a launch refusal; launches stop when orchestration stops calling the client |
| 6 | MEDIUM | rollback was called idempotent and re-runnable after a partial application; the script refuses when a `copy` target is already absent | §4 rewritten: explicitly **not** idempotent, with a five-step manual reconciliation procedure instead of a re-run |
| 7 | MEDIUM | `C4:probe-matches-ledger` passed on `probe === "UNKNOWN"`, so a probe that always answered UNKNOWN would pass | now asserts **equality** with the independently read ledger |
| 8 | MEDIUM | the exclusivity description said "one winner and one record per round", but the harness reused one generation across three rounds and summed winners | the harness now allocates a **fresh generation per round** and asserts each separately; measured generations 1, 3, 5 |

Findings 3, 7 and 8 required re-measurement rather than wording, and the harness
was re-run after each. Facts went 33 → 40 as defects were converted into
assertions.

## 4. Two defects the reviewer found in the harness itself

These are recorded separately because they are the kind of failure a review exists
for: the harness was reporting PASS on things it had not measured.

**a. No extension installed.** `prepareHome` wrote model config only, so the eight
regression facts measured a runtime with **no extension loaded** and would have
passed with the extension deleted. Fixed by installing the tree inside
`prepareHome`, plus `EXTENSION_LOADED` (the three fence commands must be
registered), a `Failed to load extension` check on stderr, and
`SLASH_COMMAND:extension-command` driving a command only the extension provides.

**b. Resume resumed a fixture.** `SESSION_RESUME` resumed a hand-written session
file rather than the one turn 1 produced. Fixed to take the file the runtime wrote,
resume it, and assert the history grew and the second turn landed in the **same**
file.

## 5. What this review does not establish

- It does not overturn the card's `HOLD`. It supports it.
- It does not establish that the C1 repairs proposed in
  `RESIDUAL_RISK_DISPOSITION.md` would work; they are untested proposals.
- It does not audit the four installed npm plugins, the OMP 18.12.1 → 18.12.3
  upgrade, or network-filesystem ledger behaviour. Those remain `UNKNOWN` in the
  baseline manifest.
- A `HOLD` here means the deliverables are honest, not that the deployment is
  safe. Those are different questions, and only the first one is this document's
  subject.
