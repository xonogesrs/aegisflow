# Admission report

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Date:** 2026-10-21
**Mode:** read-only admission → deployment risk assessment → isolated rehearsal
**Production mutation:** none. **Production enablement:** false.

```
VERDICT = HOLD
```

`HOLD`, not `FAIL`: nothing in production was changed, no authority was bypassed,
no commit was faked into a production ledger, and no existing service was
broken. The deployment admission itself does not clear, because one of the four
boundaries the card asks about does not hold in this environment.

---

## 1. The answer, in one paragraph

The R3 controller client works. In an isolated environment built from the R3
commit, it attests the binary, binds a live runtime's identity, commits through a
signed correlated frame, survives a controller crash, refuses cross-instance
frames and replays, keeps six processes from double-committing one generation, and
rolls back byte-for-byte. Installing it changes three `lib/` files and one
extension file, and every ordinary OMP function still works with it installed.
What does not hold is the trust boundary around the controller's **durable
state**: the governed agent runs as the same user as the controller, its `bash`
tool inherits the authority marker and the ledger directory path, and the ledger
is a plain JSONL file with no per-record authentication. Measured: the agent's own
`bash` appended a commit record for its parent's generation, the durable probe
believed it, and the controller that owned that generation could no longer commit
it. That is a `BLOCKING` deployment boundary, so activation cannot be recommended.

## 2. What the card asked, and what was found

| § | Question | Finding |
|---|---|---|
| 1 | How does production start and load OMP, extensions, AutoLoop, CBM? | One `omp/18.12.3` binary at `~/.local/bin/omp`; extensions by directory discovery from `~/.omp/agent/extensions`; AutoLoop via a `zsh` function that routes to `al-omp`, currently `OFF`/`native`; CBM as a stdio MCP server, unrelated to the extension. Full inventory in the baseline manifest. |
| 2 | What execution paths does R3 touch? | One: the extension module set loaded at startup. `src/control-plane/controller-client.mjs` is a caller, not a runtime dependency, and is not deployed. `mcp.json`, CBM, AutoLoop and `config.yml` need no change. On this host an install writes four runtime files (one replacement, three additions) plus one test: `cbm-query.js` already matches the R3 revision, so it is `unchanged`. |
| 3 | Are the four `ACCEPTED_WITH_BOUNDARY` risks acceptable in the real deployment? | C1 **BLOCKING**; C2, C3, C4 **ACCEPTABLE_WITH_RESTRICTION**. Evidence and the exact restriction for each in the residual-risk disposition. |
| 4 | Can it be installed, enabled and rolled back without breaking existing function? | Install: yes, with one hazard (a partial copy silently disables the extension). Existing function: yes, measured across ten regression facts with the extension loaded. Rollback: yes, byte-identical and re-loadable — but only via `omp-rollback-integration.mjs`; the shipped `uninstall` deletes `cbm-query.js`, a pre-existing production file, and was measured doing it. Enable: **not recommended** while C1 stands. |
| 5 | Is there enough evidence for the Owner to decide? | Enough to decide **not** to enable today, and enough to specify what would change that. The C1 repairs are named and bounded; none was implemented here. |

## 3. The finding that decides the verdict

Under a governed launch the child environment carries:

```
OMP_TERMINAL_FENCE_AUTHORITY=controller-client
OMP_TERMINAL_FENCE_STATE_DIR=/…/controller/state
OMP_CONTROLLER_RESULT_KEY_FILE=/…/result.<pid>.<nonce>.key   (unlinked at load)
```

The governed agent's `bash` tool is a child of that process and inherits the
first two. Three measured consequences:

1. **A nested `omp` started from the agent's `bash` obtains controller authority
   and lands a durable commit** — no `-e`, no controller, no key, only inherited
   environment.
2. **The agent can append a commit record to its parent's ledger**, and the
   extension's commit gate matches commit records on `(type, generation, session)`
   only. Measured both ways: with the parent's runtime id copied from the
   `allocate` line, the durable probe answers `COMMITTED`; with a wrong id, the
   probe answers `UNKNOWN` and the controller's own commit is still refused with
   `GENERATION_ALREADY_COMMITTED`.
3. **The deployed extension file itself is writable by that uid.** The tamper is
   *detected* on the next governed launch (`EXTENSION_HASH_MISMATCH`), which is a
   real defence — but it converts the attack into a denial of the next run, and it
   does not protect the ledger at all.

The R3 card's boundary statement is precise and correct for what it covers: a
module *inside* the attested set is inside the TCB. This deployment adds a party
inside the attested set's *uid*, with a shell, and R3's argument does not extend
to that party's access to the controller's durable state.

## 4. Why this is not "the card failed"

Everything the R3 card claimed, this card re-measured in a different environment
and found true:

| R3 claim | Re-measured here |
|---|---|
| trusted launch, attested binary | `attestRpcBinary` succeeds on `omp/18.12.3` |
| pinned extension tree | a tampered tree is refused with `EXTENSION_HASH_MISMATCH` |
| authority boundary | ungoverned start denies, signed, with no ledger write |
| cross-process exclusivity | 6 processes × 3 rounds, one winner, one record |
| result correlation | foreign key `MAC_MISMATCH`, replay `DUPLICATE_RESULT` |
| crash idempotency | ledger is the witness, probe agrees, closed generation not reused |
| rollback | byte-identical restore, restored tree answers |

The regression surface also holds: eleven facts across extension load, prompt,
tool, slash (built-in and extension-registered), a real session resume, async
delivery, `agent_end`, AutoLoop and CBM all pass — measured with the extension
actually installed, after independent review caught that the first harness ran
them against a runtime with no extension present, and that its resume fact
resumed a hand-written fixture rather than the session the first turn produced.

What failed is a question R3 was not asked: whether the deployment's *process and
uid topology* preserves the boundary the code establishes. It does not.

## 5. What would change the verdict

Not more testing. Three specific changes, in order of effect:

| # | Change | Effect |
|---|---|---|
| 1 | **Do not put the marker in the child's environment.** Authority per command (a socket the controller serves) rather than per process. | removes the nested-process escape entirely |
| 1b | **Fix `uninstall`** so an `unchanged` file is `leave`d, matching the rollback's own rule. | a routine "restore" stops deleting unrelated production files |
| 2 | **Authenticate the ledger**, or place it where the agent's uid cannot write it. | a forged record can no longer close a generation or fake a commit |
| 3 | **Bind the commit record to its allocation token**, not just `(type, generation, session)`. | raises the cost of a forgery even if (2) is partial |

Until (1) and (2) exist, `C1` stays `BLOCKING` and this admission stays `HOLD`.

## 6. What was NOT done, by design

```
PRODUCTION_MUTATION      = NONE
PRODUCTION_ENABLEMENT    = false
OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED
GDR_1_APPROVED           = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED  = false
```

- No production extension, config, `mcp.json`, shell profile or authority was
  written. Verified before and after by SHA-256.
- No production OMP process was stopped, restarted or used as a test subject.
- No production ledger was created, and no test commit was written into one.
- No repository code was changed. The only additions are documents and two
  read-only probe scripts under `docs/audit/…/probes/`, which are outside the
  installer's `KNOWN_FILES` deployment surface and are not imported by anything.

## 7. Deliverables

| File | Content |
|---|---|
| [`PRODUCTION_BASELINE_MANIFEST.md`](PRODUCTION_BASELINE_MANIFEST.md) | observed production state, with `UNKNOWN` where it is unknown |
| [`DEPLOYMENT_CHANGE_PLAN.md`](DEPLOYMENT_CHANGE_PLAN.md) | six change records, each with rollback |
| [`RESIDUAL_RISK_DISPOSITION.md`](RESIDUAL_RISK_DISPOSITION.md) | C1–C4 adjudicated for this deployment |
| [`ISOLATED_REHEARSAL_EVIDENCE.md`](ISOLATED_REHEARSAL_EVIDENCE.md) | 40 facts, the 4 failures, reproduction command |
| [`ACTIVATION_SMOKE_CHECKLIST.md`](ACTIVATION_SMOKE_CHECKLIST.md) | 12 day-of checks with abort conditions |
| [`ROLLBACK_RUNBOOK.md`](ROLLBACK_RUNBOOK.md) | ordered, rehearsed, with the measured result |
| [`INDEPENDENT_REVIEW.md`](INDEPENDENT_REVIEW.md) | fresh reviewer session: `HOLD`, eight findings, each with its resolution |
| [`FINAL_DISPOSITION.md`](FINAL_DISPOSITION.md) | the card's verdict block |
| `probes/`, `evidence/` | the harness, the baseline collector, raw facts |

## 8. Next action

Owner decision on C1. Two acceptable next cards:

- **Repair card**: implement C1 repairs (1) and (2), re-run this rehearsal, and
  expect `C1:*` facts to flip to PASS; then re-admit.
- **Scope decision**: authorize the extension *without* controller authority
  (a deployment where every new command denies and nothing else changes). That is
  measurable today and the inertness probe already shows it works, but it delivers
  no closeout capability, so it is a product decision rather than an engineering
  one.

`GDR-1` remains a separate hardening-closeout governance decision and is not
advanced by this card.
