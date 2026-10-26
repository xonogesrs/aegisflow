# Isolated deployment rehearsal — evidence

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Phase:** D
**Harness:** [`probes/rehearsal.mjs`](probes/rehearsal.mjs) (re-runnable, one command)
**Raw facts:** [`evidence/rehearsal-facts.json`](evidence/rehearsal-facts.json)

```
REHEARSAL=FAIL  facts=40  pass=36  fail=4
```

`FAIL` is the honest result and the reason the card is `HOLD`: four facts did not
hold, and they are all instances of the same deployment-level boundary. A
rehearsal that reported `PASS` by deleting them would be worthless.

---

## 1. How to reproduce

```bash
node docs/audit/AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1/probes/rehearsal.mjs \
  --omp       "$HOME/.local/bin/omp" \
  --extension "<a deployed R3 tree>/no-poll-waits.js" \
  --client    "$PWD/src/control-plane/controller-client.mjs" \
  --pilot-root /path/to/autoloop-omp-pilot \
  --scratch   /tmp/admission-rehearsal
```

The harness brings its own provider: an in-process HTTP server on
`127.0.0.1:<ephemeral>`, answering `openai-responses` SSE. It is bound to
loopback, reads no credential, and makes no outbound connection. Every run uses a
private `HOME` under the scratch root.

**Isolation, checked rather than asserted:**

| Requirement | How it is met |
|---|---|
| never touches a production session | every run uses `--no-session` or a session file under the scratch root |
| never touches a production ledger | every state dir is under the scratch root |
| never touches production authority | the harness process itself carries no `OMP_TERMINAL_FENCE_*`; the marker is only ever set in a spawned child's environment |
| never touches the production extension | it is copied into the scratch tree first; the source is read, never written |
| never targets the running OMP | no operation references pid 4905 or its daemons |

Verified before and after: `no-poll-waits.js` `11d8628b…f8ef`, `cbm-query.js`
`03c08f43…b75e`, `config.yml` `108ca03c…8d66`, `mcp.json` `032839c1…67d4`,
`omp` `f2a657b3…6ec5` — all unchanged.

## 2. The facts

### 2.1 Regression surface — all PASS

**The first version of this harness never installed the extension into the
regression HOME**, so these eight facts measured a runtime with no extension
loaded. Independent review caught it. `prepareHome` now copies the deployed tree
into the discovery directory, and `EXTENSION_LOADED` proves the three fence
commands are registered before any regression fact is trusted.

| Fact | Result |
|---|---|
| `EXTENSION_LOADED` | `fence-identity`, `fence-generation`, `release-final` all registered |
| `NORMAL_PROMPT` | `REHEARSAL_PROMPT_OK`, no `Failed to load extension` on stderr |
| `TOOL_CALLING` | `REHEARSAL_TOOL_OK` returned through the model |
| `SLASH_COMMAND` | `/help` → `completed` |
| `SLASH_COMMAND:extension-command` | `/fence-identity` → `completed` (a command the extension registered) |
| `SESSION_RESUME` | real session file written by turn 1, resumed; history grew and the second turn landed in the same file |
| `SESSION_RESUME:file-written` | exactly one session file produced (the precondition for the fact above) |
| `ASYNC_JOB_DELIVERY` | job backgrounded, completion woke the agent |
| `AGENT_END` | exactly one terminal settle (`=== 1`, not `>= 1`) |
| `AUTOLOOP_DISPATCH` | isolated pilot `native`, selftest `timeoutOk`, `orphanProcess: 0` |
| `CBM_ROUTING` | `ekm_query` offered, legacy `cbm_query` not offered |

These say the deployment does not break what already works. They do not say
anything about the controller boundary.

### 2.2 Controller surface — all PASS

| Fact | Result |
|---|---|
| `CONTROLLER_AUTHORITY_DENIAL` | signed denial, `CONTROLLER_AUTHORITY_ABSENT` |
| `…:no-ledger-write` | state dir still empty |
| `CONTROLLER_VALID_COMMIT:bound` | `ALLOCATED` |
| `CONTROLLER_VALID_COMMIT` | `COMMITTED`, `ledgerRecorded:true` |
| `…:durable` | `{commitRecords:1, totalRecords:3}` — the asserted number, not the ledger size |
| `…:generation-advanced` | 1 → 2 |
| `RESULT_CORRELATION` | foreign key `MAC_MISMATCH`; replay `DUPLICATE_RESULT` |
| `LEDGER_EXCLUSIVITY` | three independently contested generations (1, 3, 5); each raced by 6 processes: 1 winner, 1 record, every round |
| `C3:cross-instance-frame-refused` | `MAC_MISMATCH` |
| `C3:distinct-keys` | distinct and both 64-hex |
| `C4:dispatched-before-kill` | frame written before SIGKILL |
| `C4:ledger-is-the-only-witness` | `durable:COMMITTED`, `commitRecords:1`, `allocate:1 commit:1 allocate:2` — a two-record ledger would fail |
| `C4:probe-matches-ledger` | probe and ledger agree — asserted as **equality**, so a probe that always answered `UNKNOWN` would fail |

The R3 mechanism works in this environment. That is not in dispute.

### 2.3 The four failures

| Fact | Observed | Meaning |
|---|---|---|
| `C1:forged-record-not-believed` | `COMMITTED` | the agent's own `bash` appended a commit record for the parent's generation and the durable probe believed it |
| `C1:legit-commit-still-succeeds` | `DENIED / GENERATION_ALREADY_COMMITTED` | the controller that owns the generation could no longer close it |
| `C1:agent-cannot-modify-loaded-module` | bytes changed by a same-uid write | the deployed module is writable by the agent's uid |
| `C2:separate-state-dirs-cannot-double-commit` | both `COMMITTED`, both generation 1 | the per-session ledger does not protect across state directories |

The supporting observations that make the first two a boundary rather than a
curiosity:

| Observation | Result |
|---|---|
| `C1:ordinary-start-loads-dropped-module` | a `.js` dropped into the discovery directory executed on the next ordinary start |
| `C1:governed-launch-ignores-dropped-module` | the same file did **not** load in a governed launch (`--no-extensions` forced) |
| `C1:attested-launch-refuses-tampered-tree` | `EXTENSION_HASH_MISMATCH` — the tamper is detected |

So the load path is defended in a governed launch and open in an ordinary one,
and the durable ledger is defended by nothing. See
[`RESIDUAL_RISK_DISPOSITION.md`](RESIDUAL_RISK_DISPOSITION.md) §C1.

### 2.4 Rollback — all PASS, on a production-shaped seed

| Fact | Result |
|---|---|
| `ROLLBACK:install-applied` | `replace,unchanged,unchanged,copy,copy,copy,unchanged,unchanged,unchanged,unchanged,copy` |
| `ROLLBACK:preexisting-files-unchanged` | `cbm-query.js`, `lib/poll-wait-policy.js` and the four existing tests are all `unchanged` at install |
| `ROLLBACK:r3-files-copied` | the three `lib/` modules and the contract test |
| `ROLLBACK:byte-identical-restore` | `{ok:true, identical:true}` over the whole tree |
| `ROLLBACK:preexisting-files-survived` | `cbm-query.js`, `lib/poll-wait-policy.js`, `test/waiter-fence.acceptance.ts` all present |
| `ROLLBACK:r3-files-removed` | none remaining |
| `ROLLBACK:restored-runtime-answers` | `REHEARSAL_PROMPT_OK` |

An earlier version seeded only two files, so `cbm-query.js` and the tests were
`copy` actions and rollback deleted them; the byte-identical result was real but
described a two-file tree. Independent review found it. The seed is now the full
production-shaped set, each file from the revision this deployment runs
(`no-poll-waits.js` from `fb8ce6a`, `cbm-query.js` from `1ebb121`), and the action
classes are asserted rather than assumed.

## 3. The two probes that show the mechanism, not the symptom

**The agent's environment inside a governed run** (captured from its own `bash`):

```
OMP_CONTROLLER_RESULT_KEY_FILE=/…/controller/result.<pid>.<nonce>.key
OMP_CONTROLLER_RESULT_TRANSPORT=stdout
OMP_TERMINAL_FENCE_AUTHORITY=controller-client
OMP_TERMINAL_FENCE_STATE_DIR=/…/controller/state
```

The key file is gone by the time the agent looks (`ls` fails, and the extension
unlinked it at load) — so the *frame* cannot be forged. The marker and the state
directory are present, and they are what the nested-process and ledger-write
attacks use.

**The nested commit**, started by the agent's `bash` with no `-e`, no controller
and no key, inheriting only the environment:

```
allocate:1  <nested runtime>
commit:1    <nested runtime>     ← durable
allocate:2  <nested runtime>
```

## 3a. Vacuous-pass audit

An independent review asked whether any of the 29 PASSes would also pass on broken
code. Four assertions were weak and were strengthened; the harness was re-run and
still reported 29/33 at that point, so the strengthening did not change any
verdict — it removed the possibility that a verdict was reached for the wrong
reason. The count moved to 31/35 only when the missing-extension defect below was
fixed and two new facts were added.

**A sixth defect, found by the same reviewer in a later pass**: `SESSION_RESUME`
resumed a **seeded fixture file** rather than the session turn 1 actually
produced, so it proved "a hand-written session file can be resumed" rather than
"a real session resumes". It now runs turn 1 with a fresh session directory,
takes the file the runtime wrote, resumes that, and asserts the history grew and
that the second turn landed in the **same** file. Facts 35 → 36.

**A fifth defect was found after that audit and is more serious than the other
four**: `prepareHome` configured the model but never installed the extension, so
`NORMAL_PROMPT` through `CBM_ROUTING` were measuring a runtime with no extension
present. They passed, and they would have passed identically if the extension were
deleted. Fixed by `installExtension()` inside `prepareHome`, plus a new
`EXTENSION_LOADED` fact that fails if the three fence commands are not registered,
plus a `Failed to load extension` check on `NORMAL_PROMPT`'s stderr, plus
`SLASH_COMMAND:extension-command` which drives a command only the extension
provides. Facts went 33 → 35 and the pass count 29 → 31: the two new facts are the
ones that make the other eight mean something.

| Fact | Before | After |
|---|---|---|
| `CONTROLLER_VALID_COMMIT:durable` | asserted `=== 1` but printed the ledger's **total** record count (3), which reads like it passed on three | asserts `=== 1` and reports `{commitRecords, totalRecords}` separately |
| `C4:ledger-is-the-only-witness` | `commits.length <= 1` — a run that committed **nothing** also passed | asserts the outcome is `COMMITTED` or `NOT_COMMITTED` (zero or one), and fails `AMBIGUOUS` (two) |
| `C3:distinct-keys` | `r1.key !== r2.key`, detail a literal string | also asserts both keys are 64 lowercase hex |
| `AGENT_END` | `end.length >= 1` | `end.length === 1` |

Two further facts were checked and left as they are, with the reason stated:

- `C1:ledger-exists` is a precondition, not a claim; it cannot pass on broken code
  because the next fact reads the file.
- `LEDGER_EXCLUSIVITY` was itself defective in an earlier version: it reused one
  generation for all three rounds and summed winners, so rounds 2 and 3 were
  duplicate-commit refusals, not races. It now allocates a **fresh generation per
  round** and asserts each round separately; measured generations 1, 3, 5, each
  with exactly one winner and one record. Independent review found this; the
  description in an earlier draft ("one winner and one record per round") was
  true of the assertion and false of the mechanism.

## 4. What this rehearsal does not cover

| Not covered | Why |
|---|---|
| model output quality | the provider is a stub by design; the rehearsal is about plumbing |
| a governed launch of a **real** provider | would spend credentials and prove nothing additional about the boundary |
| network-filesystem ledger semantics | no network filesystem is in the deployment; the lock's foreign-host refusal is the relevant path and it is unit-tested upstream |
| the four npm plugins' effect on the TCB | not audited by this card; marked `UNKNOWN` in the baseline |
| AutoLoop in `ON` state | switching it on is out of scope; it is measured `OFF` and unchanged |
