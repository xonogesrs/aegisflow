# Activation smoke checklist

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Phase:** E
**Purpose:** the minimal set of checks to run **on the day** production
enablement is authorized, in order, with a baseline, an expected result, an
abort condition and a rollback trigger for each.

This checklist does not authorize activation. It exists so that when the Owner
does authorize it, the operator is not improvising.

**Rules that apply to every row:**

- Do not run a check against a historical Hardening generation. Every governed
  run below is a fresh run with a fresh session.
- Take the pre-activation baseline **immediately before** the change, not from
  this document: the values in §0 were observed on 2026-10-21 and the machine may
  have moved.
- A row marked **ABORT** is a stop: restore, then report. Do not "retry until
  green".
- Rows 9–12 are only reachable if the deployment provisions controller authority.
  If the Owner authorizes the *extension* only, rows 9–12 become "the commands
  deny" and that is the expected result — see the note at the end.

---

## 0. Baseline to capture before touching anything

```bash
shasum -a 256 ~/.omp/agent/extensions/no-poll-waits.js \
              ~/.omp/agent/extensions/cbm-query.js \
              ~/.omp/agent/config.yml ~/.omp/agent/mcp.json
~/.local/bin/omp --version
al-omp status
ls ~/.omp/agent/extensions ~/.omp/agent/extensions/lib
```

Expected (2026-10-21 observations, for comparison only):

| Item | Value |
|---|---|
| `no-poll-waits.js` | `11d8628b…f8ef` (pre-R3) |
| `cbm-query.js` | `03c08f43…b75e` |
| `config.yml` | `108ca03c…8d66` |
| `mcp.json` | `032839c1…67d4` |
| version | `omp/18.12.3` |
| `al-omp status` | `native` |
| `extensions/lib` | exactly `poll-wait-policy.js` |

Keep this output. Every post-change comparison is against it, not against a
document.

---

## 1. The twelve checks

| # | Check | Baseline | Expected after | Touches a production session? | Abort if | Rollback? |
|---|---|---|---|---|---|---|
| 0 | **EXTENSION_LOADED** — start OMP and list commands | the three fence commands are absent (pre-R3) | `fence-identity`, `fence-generation`, `release-final` all present; no load error on stderr | no | any is missing, or stderr says `Failed to load extension` | yes |
| 1 | **NORMAL_PROMPT** — `omp -p "list the files here"` in a scratch dir | answers, exits 0 | answers, exits 0, same latency order | no (scratch cwd) | no answer, or `Failed to load extension` on stderr | yes, immediately |
| 2 | **TOOL_CALLING** — a prompt that forces one `bash` call | tool executes, result returns to the model | identical | no (scratch cwd) | tool blocked, or the model never receives the result | yes |
| 3 | **SLASH_COMMAND** — `/help` and one built-in command | completes, `agentInvoked:false` | identical; the three fence commands appear in the command list | no | `/help` errors, or the command list is empty | yes |
| 4 | **SESSION_RESUME** — start a session, exit, `--resume` it | resumes with history | resumes, answers | yes, but a **new** session created for this check | resume loses history, or the session file is corrupt | yes |
| 4a | **SESSION_RESUME under a governed launch** — same, but the controller launches both turns | n/a (new surface) | the second turn gets a generation **strictly higher** than the closed one, same session, different runtime id | yes, controller-owned, new session | the resumed turn reuses a closed generation, or binds generation 1 again | **yes, and stop** |
| 5 | **ASYNC_JOB_DELIVERY** — one backgrounded job, wait for the wake | job backgrounds, completion wakes the agent | identical | yes, new session | job never delivers, or delivers after the run ended | yes |
| 6 | **AGENT_END** — observe the terminal settle of #5 | `agent_end` fires once | once | same run as #5 | no `agent_end`, or two | yes |
| 7 | **AUTOLOOP_DISPATCH** — `al-omp status`, then one `al-omp run` with dispatch still OFF | `native`, run refused | identical (this card changes nothing here) | no | dispatch flips ON by itself | no — investigate |
| 8 | **CBM_ROUTING** — a prompt that needs memory | `ekm_query` offered and callable; `cbm_query` not offered | identical | yes, new session | `ekm_query` missing, or `cbm_query` offered | yes |
| 9 | **CONTROLLER_AUTHORITY_DENIAL** — `/fence-generation` on an ordinary (ungoverned) start | signed denial, `CONTROLLER_AUTHORITY_ABSENT`, no ledger file created | identical | no | a commit succeeds without a marker | **yes, and stop** |
| 10 | **CONTROLLER_VALID_COMMIT** — one governed run: bind, commit | n/a (new surface) | `COMMITTED`, `ledgerRecorded:true`, exactly one commit record, generation advances by 1 | yes, new session, controller-owned | `COMMITTED` without a durable record, or two records | yes |
| 11 | **RESULT_CORRELATION** — replay an accepted frame; feed one to a foreign correlator | n/a | replay → `DUPLICATE_RESULT`; foreign key → `MAC_MISMATCH` | no (harness) | either is accepted | **yes, and stop** |
| 12 | **LEDGER_EXCLUSIVITY** — N processes commit one generation | n/a | exactly one winner, exactly one record, every round | no (harness) | two records for one generation | **yes, and stop** |

Rows 10–12 are the ones that matter for the R3 claim. Rows 0–8 are the ones that
matter for "did we break the thing that already worked".

**Row 0 is a precondition for every other row.** The rehearsal's first harness ran
rows 1–8 against a runtime with no extension installed and they all passed; the
same eight facts would pass with the extension deleted. Before trusting any row,
confirm the three fence commands appear in the command list and that stderr has no
`Failed to load extension`.

---

## 2. What each row proves, and what it does not

### Measured note on row 4a — generations are monotonic, not contiguous

Measured on this host: launch 1 binds generation 1 and commits; the commit
transaction claims the next generation; launch 2 on the same session then binds
generation **3**, not 2. The ledger reads
`allocate:1 commit:1 allocate:2 allocate:3`.

The claim of 2 was written by the *committing* runtime as part of its own
transaction, and that runtime then exited without adopting it. The next launch
takes the ledger's highest generation plus one. So:

- **no generation is ever reused** — that is the property that matters;
- generation numbers can have **gaps**, and an operator must not read "generation
  3" as "three runs".

A check that asserts "the next generation is exactly previous + 1" will fail here
for a correct reason. Assert only "strictly higher".

| Row | Proves | Does **not** prove |
|---|---|---|
| 0 | the extension actually loaded — without it, rows 1–8 pass on a runtime that never loaded anything | that the commands behave correctly; only that they exist |
| 1–3 | the extension still loads and the runtime still answers | model quality; the provider was not exercised for correctness |
| 4 | a session the runtime wrote is readable and resumable, and the resumed turn lands in the same file | that a governed resume is safe — see 4a, which measures generation monotonicity separately |
| 5–6 | the async delivery path the extension intercepts still works | delivery under a *committed* fence (that is row 10's territory) |
| 7 | AutoLoop is untouched | that AutoLoop would work if switched on — it is OFF and this card does not test ON |
| 8 | the EKM tool is still registered and the legacy alias still inactive | that EKM data is correct |
| 9 | the commit path is closed without authority | that authority cannot be obtained — see C1 |
| 10 | a governed commit is durable and advances the generation | that it is *safe* against a hostile agent (C1) |
| 11 | correlation is per launch | global uniqueness across hosts |
| 12 | exclusivity within one ledger file | exclusivity across two state dirs (C2: it does **not** hold) |

## 3. The pre-activation gate this checklist does not replace

Rows 1–8 can be run today, because they are non-destructive and use new
sessions. Rows 9–12 presuppose the CHG-3/CHG-4 provisioning decision.

Given the C1 disposition in
[`RESIDUAL_RISK_DISPOSITION.md`](RESIDUAL_RISK_DISPOSITION.md), **row 10 must not
be run against a session whose closeout matters**, because a governed agent that
writes its own ledger can make row 10 pass while the closeout it records is
false. That is the finding, not a caveat on the checklist.

## 4. Abort and rollback triggers

| Signal | Meaning | Action |
|---|---|---|
| `Failed to load extension … Cannot find module` | partial deployment (the measured failure mode) | re-run `install`, then `check --strict-bytes`; if still failing, roll back |
| OMP starts but the extension's commands are absent | extension did not load at all | roll back |
| `check --strict-bytes` reports `DRIFT`/`MISSING` **after** the install | bytes are not what was installed | do not proceed; investigate before rollback |
| `check` exits 1 **before** the install | expected — production is behind the repository | record it as the pre-change baseline; it is not a fault |
| a governed launch fails with `AUTHORITY_INHERITED` | the launching environment already carries the marker | unset it in the operator shell, not in the child |
| any row 9–12 behaves better than it should (a commit without authority, two records) | authority or exclusivity is broken | **stop, roll back, preserve evidence** |
| the pre-existing `test/v2/*` counts change | unrelated but unexpected | investigate; not automatically a rollback |
| OMP process count grows without a matching session | a nested/leaked runtime | identify the owner before killing anything |

## 5. Post-run evidence to preserve

- the §0 baseline and the same command run afterwards;
- `node scripts/install-omp-integration.mjs check --strict-bytes` output;
- the install record JSON (it is the rollback input — without it there is no
  precise rollback);
- every governed run's ledger file and its signed result frames;
- `al-omp status` before and after.

Do not delete a state directory to "clean up" until its ledger has been archived.
The ledger is the only durable statement of what committed.
