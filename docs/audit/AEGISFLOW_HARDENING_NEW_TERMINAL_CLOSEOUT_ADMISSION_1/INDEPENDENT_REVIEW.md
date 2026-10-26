# Independent review — new terminal closeout admission

**Card:** `AEGISFLOW_HARDENING_NEW_TERMINAL_CLOSEOUT_ADMISSION_1`
**Reviewers:** fresh OMP `openai-codex/gpt-6.1-sol` sessions that did not author
any file in this card. Read-only: no edits, no Controller command, no authority
provisioning, no subagents in the deciding passes.
**Final verdict:** `REVIEW = PASS` for the admission record, after one `HOLD`
round whose findings were corrected.

---

## 1. Review sessions

| Session | Purpose | Outcome |
|---|---|---|
| `01a15980-4919-7628-aa62-a6fe1e39af17` | first pass, broad prompt | **no verdict** — aborted at the 900 s harness timeout after ~40 read/grep calls and two subagents; transcript preserved |
| `01a1598e-5e23-743f-8dc1-a10353a7dc85` | first pass, bounded prompt | `REVIEW=HOLD`, 3 findings, `GOVERNANCE_ADMISSION_ASSESSMENT=SUPPORTED` |
| `01a1598f-fe24-737a-8d82-66c6ea8562b5` | second pass, corrections verified | `REVIEW=PASS`, 1 non-blocking finding |
| `01a15991-8a38-769d-9ae3-5d764bd06e83` | third pass, last correction verified | `REVIEW=PASS`, `FINDING1_RESOLVED=YES` |

Transcripts: `/private/tmp/aegis-closeout-review-sessions/`. Outputs:
`/private/tmp/aegis-closeout-admission-review-output2.txt`,
`…-output3.txt` (extracted from the reviewer session transcript
`2026-10-20T13-46-11-364Z_01a1598f-fe24-737a-8d82-66c6ea8562b5.jsonl`).

## 2. First pass — HOLD, with findings

The reviewer confirmed the governance conclusion and rejected three evidence
claims:

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | MEDIUM | `CONTROLLER_PROVISIONING.md` said the RPC adapter **"structurally cannot"** carry the marker; `pi-rpc-adapter.mjs:31,41-46` only establishes a default allowlist | Rewritten to "No by default", noting `environmentAllowlist` is a caller option at `:199` |
| 2 | LOW | The document's "authority absent" phrasing conflated *does not provision* with *no environment anywhere carries it*; `pi-aegisflow.sh:32` does not sanitize inherited env | Header qualified; new "Two qualifications" block at `§2` separates missing provisioning from inherited environment |
| 3 | LOW | The `:317-330` citation for `request_terminal_fence` did not show the `committed:false` return; the pilot/forwarder claims had no in-read-set source | Citation corrected to `:780-798` (the `details: {…, committed: false}` return) plus `:330-341`; out-of-repo pilot evidence explicitly marked as cited, not audited |

Reviewer also stated its own limits: prescribed read set, no independent
re-execution of historical measurements, no repo-wide proof of
non-implementation.

## 3. Second pass — PASS

Verbatim (abridged to the verdict lines):

> **REVIEW=PASS**
> A. Confirmed core correction: `CONTROLLER_PROVISIONING.md:48` says "No by
> default" and acknowledges caller overrides; `src/adapter/pi-rpc-adapter.mjs:31,41-47,199`
> supports this.
> B. Confirmed: `CONTROLLER_PROVISIONING.md:24` cites
> `integrations/omp/extensions/no-poll-waits.js:780-798`; line 797 actually
> returns `committed:false`.
> C. Confirmed: `CONTROLLER_PROVISIONING.md:65-75` distinguishes missing built-in
> provisioning from inherited environments…; `scripts/pi-aegisflow.sh:32`
> simply executes `pi`.
> D. No blocking fabrication, unsupported current-card PASS, scope expansion, or
> production-mutation claim found. Proposals are explicitly unimplemented and
> unverified; receipt remains unissued.
> E. Confirmed: `NEW_CLOSEOUT_ADMISSION.md` retains HOLD;
> `NEW_TERMINAL_RECEIPT.md` retains branch-open status. `FINAL_DISPOSITION.md:42`
> explicitly requires governance authorization; `TERMINAL_CLOSEOUT.md:22,180-181`
> requires a committed fence.
> **FINDINGS: LOW** — `CONTROLLER_PROVISIONING.md:48`: "no in-repo caller does" is
> overbroad if it means any allowlist widening:
> `src/subagent/subagent-graph-runner.mjs:956-960` adds provider-required
> environment keys. No blocking defect found.

That LOW finding was verified and corrected: `subagent-graph-runner.mjs:956-960`
does append `providerBinding.value.requiredEnvKeys`, so the table now states the
widening, its derivation (admitted provider binding), and that no caller adds
`OMP_TERMINAL_FENCE_AUTHORITY`.

## 4. What the review does and does not certify

**Certifies:** the admission record is internally sound; the HOLD conclusion is
supported by the existing contract; the closeout identity is distinct and does
not impersonate the original generation; no Controller commit was claimed; the
receipt is honestly `NOT_ISSUED`; no production mutation occurred.

**Does not certify:** that a Controller closeout is *possible*. Both reviewers
treated provisioning as absent, and the proposal in `CONTROLLER_PROVISIONING.md`
§5 was explicitly not executed, not feasibility-tested, and not authorized. The
one open technical question — whether an RPC prompt frame can drive
`/fence-generation` against a live session and return the extension's own commit
result — is unanswered.

## 5. Evidence limits carried forward

- The aborted first pass produced no verdict. Its partial work is preserved but
  is not evidence for anything.
- Reviewer checks of historical measurements (the 121/121 and 17/17 suites, the
  original session's empty `OMP_TERMINAL_*` env) are document-level
  corroboration, not independent re-execution. Those numbers are carried forward
  from the hardening card's own records, as this card's §11 requires.
- Reviewer sessions ran with `--no-extensions --no-skills`, so no terminal fence
  was armed or committed in them either; their own generation state was
  irrelevant to their findings.
