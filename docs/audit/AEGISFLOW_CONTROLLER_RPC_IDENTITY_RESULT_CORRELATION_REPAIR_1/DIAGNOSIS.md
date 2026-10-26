# Controller RPC identity, result and correlation repair

**Card:** `AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1`
**Branch:** `feat/omp-cbm-recovery`
**Predecessor:** `AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1` — `HOLD`,
`REVIEW=PASS`, `LANDING=PASS` at `68f1a097bcf8687dd36bf65bc122b70b2a8c80f9`.
**Scope:** R1 (runtime/generation identity), R2 (structured commit result),
R5 (request correlation and transport integrity). **R3 (Controller Client) is
NOT implemented.** **Production enablement is NOT performed.**

---

## 0. What was broken, in one table

| # | Defect | Was | Now |
|---|---|---|---|
| R1 | Identity | `sessionId + generation`, generation a module-local counter restarting at 1 on resume | `sessionId + runtimeInstanceId + generation`, generation durably allocated per runtime; every target checked before fence state is touched |
| R2 | Result | RPC `response` = `{id,type,command,success}`; `success:true` meant "prompt admitted" | A signed `controller_result` frame carrying `commandAccepted`, `commandDispatched`, `handlerExecuted`, `commitExecuted`, `committed`, `denial`, identity and generation |
| R5 | Correlation | Notify frames carried a runtime-generated Snowflake id; nothing tied a result to a request | Every frame echoes the controller's own `requestId` and is HMAC-signed with a per-launch key; the controller accepts exactly one frame per request id and refuses the rest |

Measured before the repair (predecessor card, `DIAGNOSIS.md` §2.3, §3): two
processes, one session id `01a159e2-…`, both reporting "generation 1"; and
`RESULT_OBSERVABILITY = HOLD` because the result was only in a log line.

---

## 1. Landing gate (§3) — PASS

Pre-card gate: `git status --porcelain=v1` empty · branch `feat/omp-cbm-recovery` ·
`HEAD = @{upstream} = ls-remote origin = 68f1a097bcf8687dd36bf65bc122b70b2a8c80f9`
(full SHAs compared) · unpushed commits `0` · stash `0`.
No reset, clean, stash drop or forced overwrite was used.

Post-landing gate: `HEAD = @{upstream} = ls-remote origin =
c7af8cc21115523d43cd246337700faa1089b9ae`, worktree clean, and
`~/.omp/agent/extensions/no-poll-waits.js` still hashes `11d8628b…f8ef` — the
landing changed the repository, not the running installation.

---

## 2. Phase A — isolation and baseline protection

The card requires that the running OMP installation not be modified. Measured
before any edit and again after all work:

| Artifact | Before | After |
|---|---|---|
| `~/.omp/agent/extensions/no-poll-waits.js` | `11d8628b…f8ef` | `11d8628b…f8ef` |
| `~/.omp/agent/extensions/cbm-query.js` | `03c08f43…75e` | `03c08f43…75e` |
| `~/.omp/agent/extensions/lib/poll-wait-policy.js` | `7c2eae22…090b0` | `7c2eae22…090b0` |
| `~/.omp/agent/config.yml` | `108ca03c…8d66` | `108ca03c…8d66` |
| `~/.omp/agent/mcp.json` | `032839c1…a67d4` | `032839c1…a67d4` |
| `~/.omp/agent/models.yml` | `e2346f8f…c641` | `e2346f8f…c641` |

All work happened in `/private/tmp/aegis-repair-1`, a worktree of
`/Volumes/NVM2T/Development/repos/autoloop`. Every probe spawned and terminated
its own `omp --mode rpc` child in `$TMPDIR/aegis-controller-contract`, with a
private session dir or `--no-session`, a private ledger dir, a private key file,
and — after review — a **private HOME**. `PRODUCTION_MUTATION = NONE`.

The HOME was not private at first, and that mattered: a "scratch" probe run
created OMP global state (`agent.db`, `models.db`, `skill-descriptions.db`, a
custom-session-file registration, caches, native extraction, logs) under the
operator's real home — a scratch cwd does not isolate OMP's global state. Each
case now runs under its own HOME beneath the scratch root, and each case record
carries `homeIsolation` (`childHome`, `childHomeIsPrivate`,
`childHomeWithinScratchRoot`, `isolated`). The suite fails any case reporting
`isolated: false`: measured, not asserted in a comment.

### Model identity

Session `01a159ff-13c0-758b-bfd8-7b530026fa09` records
`"provider":"merge-gateway","model":"deepseek/deepseek-v4.1-flash-1017"` for the
implementing turns, matching `~/.omp/agent/models.yml`
(`deepseek/deepseek-v4.1-flash-1017`, name `DeepSeek V4.1 Flash 1017`). The same
session also records `typesafe/jev-1.14` under `purpose:"auto-thinking"` — that
is the runtime's classification helper, not the implementer.

---

## 3. Phase B — R1 runtime / generation identity

`integrations/omp/extensions/lib/runtime-identity.mjs`

**Identity.** `runtimeInstanceId = <host fingerprint>-<pid>-<process start ms>-<12 hex>`
derived once at module load. It is **not** read from the environment: a
launcher-supplied id would be visible to every child the governed agent can
spawn, and this value is one of the identities a commit is checked against.

**Allocation.** Two modes, stated rather than blurred:

| Mode | When | Generation | Durable |
|---|---|---|---|
| `EPHEMERAL` | no state dir provisioned | 1, this runtime's own counter | no — uniqueness comes from `runtimeInstanceId` |
| `ALLOCATED` | state dir provisioned by the controller | next free number in the per-session ledger, claimed by appending | yes |

The card asks for the minimal design and says to persist only if the evidence
requires it. The runtime id alone already removes the collision (two processes
can no longer present the same identity), so `EPHEMERAL` is the default and the
ledger is what a controller opts into. `generationDurable` reports which mode is
in force, and the result frame never claims durability it does not have.

**Fail-closed states.** `CORRUPT` (unparseable, unknown, structurally
incomplete, or foreign-session record), `COLLISION` (two `allocate` records claim
one generation), `UNWRITABLE` (append or verify failed, or the configured
directory is unusable), `EXHAUSTED` (the next generation is not a safe integer),
`ADOPTION_CONFLICT` (the ledger's next generation differs from the live one).
Each yields `generation: null` or a refusal — never a fallback to 1, which is the
defect being repaired.

Four of those were too weak in the first implementation and were measured
failing in independent review:

| Was | Consequence | Now |
|---|---|---|
| records validated only for `type` + `generation` | `{"type":"allocate","generation":7}` was accepted as history and yielded 8 | `sessionId`, `runtimeInstanceId` and a safe-integer `generation` are required; a foreign `sessionId` is corruption |
| no range check | a ledger at `MAX_SAFE_INTEGER` produced a generation that could not be incremented, so a fence left the number unchanged | `EXHAUSTED`, `generation: null` |
| unusable state dir fell back to `EPHEMERAL` | a configured-but-blocked ledger silently downgraded durability and the fence succeeded | `UNWRITABLE` |
| ownership checked only at allocation time | a peer's conflicting `allocate` appended afterwards did not stop the original runtime committing — reproduced with a two-process probe: one stayed `ALLOCATED` and committed after the duplicate existed | `verifyOwnership()` re-reads the ledger immediately before the fence; a doubly-claimed generation denies the commit |

The fourth is the important one. Allocation-time verification is a *snapshot*;
the ledger is the authority, so it is re-read at the point of use. The runtime
also carries an `allocationToken`, so "this generation is mine" is a claim the
ledger can check rather than an inference from the generation number.

**Both fence legs advance the identity.** `fenceGeneration()` is reachable from
the controller command *and* from the automatic `agent_end` hook. Both call
`advanceDurableGeneration()`, which records the commit, claims the next
generation, and re-points the token. Before this, the automatic leg incremented
the live generation without naming it in the ledger, leaving `identityState`
reading `ALLOCATED` for a generation this runtime did not own.

**The automatic leg checks ownership too.** It has no controller target, so it
originally fenced without an ownership check: with the durable identity
`UNWRITABLE`, `agent_end` still fenced and committed a generation this runtime
could not prove was its own. It now verifies ledger ownership before fencing and
skips (logging why) when the identity is not `ALLOCATED`/`EPHEMERAL`. `R1_T7k`
covers it.

**One commit record per generation, enforced at the writer.** Independent review
constructed the remaining case: the durable advance fails (so `identityState`
becomes `UNWRITABLE`), the ledger is restored, a peer process commits and claims
the generation, and then this runtime's automatic leg fences and appends a
SECOND `commit` record for it. The local fence was legitimate, but the ledger —
the durable statement of what committed — ended up asserting two commits for one
generation. `recordCommitAndClaimNext()` now refuses to append a commit for a
generation the ledger already records (`GENERATION_<n>_ALREADY_COMMITTED`), so
the advance fails closed instead of corrupting the record. `R1_T7j` covers it.
The remaining exposure is stated in §10.6: this is detection at the writer, not
mutual exclusion between processes.

**Ledger format.** Append-only JSONL, one record per line, `fsync` per append,
mode `0600`, in a directory the controller names via
`OMP_TERMINAL_FENCE_STATE_DIR`. Records: `allocate` and `commit`. There is
deliberately **no default directory**: a tmpdir default would silently reset the
numbering across reboots, which is exactly the bug.

**Where the check happens.** `commitTerminalFence()` verifies, in order:
authority → valid disposition → identity allocated → target identity matches →
generation not already committed in the ledger. Only then does it call
`commitOrderedTerminal()`. A refused target leaves `fenceCalls` at 0 and the
job's delivery path alive (asserted).

**Target syntax.** `/fence-generation PASS session=<id> runtime=<id> generation=<n> request=<id> [reason]`.
A bare `/fence-generation PASS` still works and reports `targetVerified: false`
— the legacy harness shape keeps working, and the controller can see it did not
pin an identity.

Identity tokens are recognized by **prefix**, so a malformed one cannot degrade
into reason text. Two shapes used to fence successfully: `generation=1junk`
(`parseInt` read `1`, so the caller looked pinned while pinning nothing) and
`generation=` (the matcher did not match, so the token became part of the reason
and the caller silently became unpinned). Both now return
`MALFORMED_IDENTITY_TARGET` with `commitExecuted: false` and `fenceCalls: 0`.

The release command had the same defect in its own argument — and a worse one:
it parsed `session=`, `runtime=` and `generation=` pins and then ignored them, so
`/release-final session=foreign runtime=foreign generation=999` released the live
generation. A release mutates `finalReleaseAt`, so a mismatch cannot be reported
after the fact; it is now refused before the mutation
(`TARGET_SESSION_MISMATCH` / `TARGET_RUNTIME_MISMATCH` /
`TARGET_GENERATION_MISMATCH`), and `R1_T7m` covers all three plus the matching
case. The `parseInt` defect:
`/release-final 1junk` parsed to generation 1 and released a generation the
caller never named. An explicit generation is now validated whole
(`MALFORMED_GENERATION`), while no argument still means "the fenced one".
`R1_T7i` covers `1junk`, `1.5`, `-1` and `abc`; reverting to `parseInt` makes it
red.

---

## 4. Phase C — R2 structured commit result

`integrations/omp/extensions/lib/controller-result.mjs`

One frame per command, written to the RPC stdout channel:

```json
{"type":"controller_result","channel":"terminal-fence","v":1,
 "requestId":"probe-1",
 "result":{"op":"commit","sessionId":"…","runtimeInstanceId":"…","generation":1,
           "identityState":"ALLOCATED","commandAccepted":true,"commandDispatched":true,
           "handlerExecuted":true,"commitExecuted":true,"committed":true,
           "denial":null,"status":"PASS","targetVerified":true,
           "jobIds":["bg_1"],"suppressed":1,"fenceAt":…,"FENCE_BEFORE_FINAL":true,
           "ledgerRecorded":true},
 "mac":"<64 hex>"}
```

The distinction that matters is structural, and it rests on WHERE the frame can
come from rather than on three flags set at three checkpoints:

- `commandAccepted`, `commandDispatched`, `handlerExecuted` are `true` on every
  frame, because a frame can only be emitted from inside the command handler.
  A frame's existence therefore proves the prompt was admitted, dispatched and
  that the handler ran — it cannot prove more than that. (An earlier draft of
  this document claimed these were set at three separate checkpoints; that was
  wrong, and the code never did it. The inference is valid, the mechanism
  described was not.)
- `committed` is set only on the primitive's success path. It is `false` on every
  denial, on a target mismatch, on a refused duplicate **and** on a handler
  exception. `commitExecuted` is `true` only once the commit call was actually
  attempted — so a denial has `commitExecuted:false`, while a handler exception
  has `commitExecuted:true` with `committed:false` and `denial:"HANDLER_EXCEPTION"`,
  which is exactly the distinction a controller needs: "never attempted" versus
  "attempted and failed".

So `RPC_SUCCESS ≠ TERMINAL_COMMIT_SUCCESS` holds for the reason it must: the
transport's own `response` frame says `success: true` for a denied commit, while
the result frame says `committed: false` with a `denial` code.

**Delivery invalidation is a third, separate outcome.** `committed` describes the
terminal transition; `deliveryFenceSucceeded` / `deliveryFenceError` describe
whether the bound jobs' pending deliveries were actually invalidated. `suppressed`
cannot carry that: it counts *queued* deliveries dropped, which is normally 0 even
on complete success. This was found in independent review — the original patch
reported `committed: true` with no way to see that `acknowledgeDeliveries` had
thrown — and is now a field, asserted by `R2_T3` (failure) and `R2_T3b` (success,
cross-checked against the manager's real `delivered` array).

`R2_T3` exercises a manager that throws on invalidation: the commit still stands,
the failure is logged, and the frame reports it in `deliveryFenceSucceeded:false`
with `deliveryFenceError`. `R2_T3b` asserts the success path and then checks the
manager's real delivered array. `R2_T4` asserts the agent's
`request_terminal_fence` tool emits no result frame.

**A throw after the fence reports the fence, not a denial.** Independent review
produced a logger that threw from inside the commit primitive, after the fence
had applied. The frame then said `committed:false` — the same lie in the other
direction — and, worse, the throw escaped the handler so *no* frame was emitted.
`commitExecuted` tracks ENTRY into the primitive, not its success. Review
measured a manager throwing inside `acknowledgeDeliveries` with the failure log
also throwing before `fenceCalls` incremented: the frame said
`commitExecuted:false` after a real attempt, collapsing "attempted and failed"
into "never attempted". The catch now reports `commitExecuted:true` whenever the
primitive was entered and produced no denial, with `committed` still from the
fence delta (`R2_T3i`). A malformed-target refusal and an authority denial —
which never reach the primitive — keep `commitExecuted:false`.

`committed` is derived from a **delta** — `state.fenceCalls` sampled before the
attempt and compared after — so it reports only what THIS call fenced, with
`handlerException` recording the throw. The first attempt used
`state.fenced.has(generation-1)`, which asks "has this runtime ever fenced",
and independent review showed the consequence: after any earlier commit, a later
denial whose logging threw reported that earlier generation as `committed:true`.
`R1_T7l` covers that exact sequence and goes red if the delta is reverted. The logger calls after the
commit are individually guarded: logging is a convenience, the frame is the
contract. `R2_T3c` covers it, and it goes red if `landed` is forced to `false`.

**Known limitation, recorded rather than papered over.** The handler's `catch`
covers the commit call; it does not cover `stateFor()` or `resolveJobManager()`.
If either threw, no result frame would be emitted at all, so a controller sees a
*missing* result (and must time out) rather than a false success. Widening the
catch was rejected: a frame claiming `handlerExecuted` for a handler that never
reached the primitive would be a worse lie than silence.

The release command (`/release-final`) answers on the same signed channel with
`op:"release"`, `released`, and `committed:false` — a release commits no fence.

---

## 5. Phase D — R5 correlation and transport integrity

**Key delivery.** The controller writes a 32-byte hex key to a file and passes
`OMP_CONTROLLER_RESULT_KEY_FILE`. The extension reads it once at module load and
**unlinks it immediately**. The key therefore never appears in the environment,
argv, a log line, the session file, or any child process's reach after load —
asserted by scanning every environment value for the key (`R5_T10`).

**Frame MAC.** HMAC-SHA256 over canonical JSON (sorted keys, no whitespace) of
`{type, channel, v, requestId, result}`. Both producer and verifier serialize
through the same `canonicalJson`, so property order cannot silently break
verification.

**Acceptance rule.** `ResultCorrelator.accept()` requires, in order: structural
validity → the request id was issued and is still pending → MAC verifies → the
pinned session/runtime/generation match. Exactly one frame is accepted per
request id; a second is `DUPLICATE_RESULT`, an unknown id is `UNSOLICITED_RESULT`,
a bad MAC is `MAC_MISMATCH`, a stale generation is `GENERATION_MISMATCH`.

**Transport trust boundary — stated, not assumed.**

| Producer | Can write fd 1? | Can produce an accepted frame? |
|---|---|---|
| The runtime's own frame writer | yes | yes (it is the host) |
| A module loaded into the process at launch | yes | **yes** — it shares the module graph and can read the key from memory |
| The governed agent's bash tool | no measured path (predecessor §2.5 T1) | no — no key |
| A child process the agent spawns | no (the RPC fds are unnamed unix sockets) | no — the key file is gone and the key is not in the environment |
| Any other process on the machine | no | no — it would need the key |

The honest statement: **nothing outside the launch-loaded extension set can
produce an accepted result frame.** Code already loaded at launch is inside the
trusted computing base by construction; that is a launch-time property a
single-process stdout transport cannot prove. `R5_T7` measures the consequence
that matters — an in-process forger that writes a structurally perfect frame with
the right request id is refused (`MAC_MISMATCH`), and the genuine frame that
follows is still accepted.

`R5_T7` uses a real injection: a probe extension loaded alongside the SUT writes
the frame to fd 1 from a registered command. The frame is visible on the wire
(`injectedFrameVisibleOnWire: true`) and refused. No hard-coded boolean is
involved; the verdict is the verifier's output.

**`ledgerRecorded` means the COMMIT is durably recorded.** Two separate defects
here, both measured in review. First it was computed as `ledgerError === null`,
which is `true` in `EPHEMERAL` mode — no ledger is opened, so no error can occur
— and a commit nothing durable recorded claimed to have been recorded. It now
requires a ledger path and reports `ledgerError: "NO_LEDGER_EPHEMERAL"`
otherwise (`R2_T3d`). Second, "the commit is recorded" and "the advance
succeeded" are different facts: the commit record is appended first, and the
next-generation claim can fail afterwards. With an injected write failure on the
claim append, `commit:g1` was on disk while the frame said
`ledgerRecorded:false`. `recordCommitAndClaimNext()` now returns
`committedRecorded` separately from `error`, and the frame is derived from it
(`R2_T3f`).

That split exposed a third case, also from review: the duplicate-commit precheck
used `generationAlreadyCommitted()`, which is deliberately fail-closed and
returns `true` for UNREADABLE history. With the ledger path replaced by a
directory, the append failed and the frame still claimed `ledgerRecorded:true`.
The two callers need different answers, so `commitRecordState()` now returns
`COMMITTED` / `NOT_COMMITTED` / `UNREADABLE`: the GATE keeps treating UNREADABLE
as "do not commit", while the REPORT only claims a durable record for
`COMMITTED` (`R2_T3g` asserts both halves).

**A denial whose logging throws is reported as that denial.** The primitive
builds a denial and then logs it; if the log throws, the `catch` used to
synthesize `HANDLER_EXCEPTION` with `commitExecuted:true` for a call that denied
before any commit — `fenceCalls: 0`. The catch now compares `state.commitDenials`
before and after: if a denial was produced and no fence landed, the frame is
that denial with `handlerException` recorded beside it (`R2_T3e`).

**A cancelled request id cannot be reissued.** `cancel()` removed the id from
`pending` but left no trace, so `expect()` would accept it again; a delayed
signed answer to the original request would then verify against the new
expectation. The correlator now keeps every id it ever issued, so reuse throws
and a late frame stays `UNSOLICITED_RESULT`. `R5_T8b` covers it.

**An undeletable key refuses to sign.** Independent review made the key file's
directory read-only: `unlink` failed, the key survived on disk, and a child
process read it and produced a frame that verified. The unlink result is now
load-bearing — if the key cannot be destroyed, `loadResultKey()` returns `null`,
the path is dropped from `process.env` regardless, and no frame is emitted
(`RESULT_KEY_ABSENT`). `R5_T11` covers it.

**`--no-ui`.** The old side channel (`ctx.ui.notify`) is absent under `--no-ui`
(measured: `notifyFrameCount: 0`). The signed frame is present and verifies.

---

## 6. Phase E — integration

`integrations/omp/extensions/test/controller-contract.acceptance.ts`, 44 cases,
driven against the real extension module and a real `AsyncJobManager`:

| Case | Fact |
|---|---|
| R1_T1 | same session, same runtime, pinned generation commits |
| R1_T2 | same session, new runtime: generation advances, runtime differs |
| R1_T3 | wrong runtime denied; `fenceCalls` 0; delivery still delivered |
| R1_T4 | wrong generation denied; `fenceCalls` 0; delivery still delivered |
| R1_T5 | duplicate commit refused; exactly one fence; ledger records it |
| R1_T6 | resume after exit: fresh generation, predecessor's commit visible |
| R1_T7 | corrupt ledger: no usable generation; commit denied |
| R1_T7b | a structurally incomplete record (`{type,generation}` only) is corruption, not history |
| R1_T7c | a record naming another session is corruption |
| R1_T7d | generation range exhaustion is refused, not wrapped |
| R1_T7e | a configured-but-unusable state dir is `UNWRITABLE`, not a silent `EPHEMERAL` |
| R1_T7f | ownership is re-verified against the ledger before the fence; a peer's conflicting claim denies the commit |
| R1_T7g | the automatic `agent_end` fence leg advances the durable identity too |
| R1_T7h | malformed identity tokens (`generation=1junk`, `generation=`) are refused, not silently dropped |
| R1_T7i | the release command validates an explicit generation whole |
| R1_T7j | a failed advance never writes a second commit record for one generation |
| R1_T7k | the automatic `agent_end` leg refuses a generation it does not own |
| R1_T7l | a denial after an earlier commit never reports `committed:true` |
| R1_T7m | the release command honors its session/runtime/generation pins |
| R1_T8 | no capability: `EPHEMERAL`, no ledger file, commit denied |
| R2_T1 | transport success separated from commit success |
| R2_T2 | committed result names the invalidated jobs; the fence really silences |
| R2_T3 | manager failure is logged, not silently swallowed |
| R2_T3c | a throw AFTER the fence reports the fence that landed, and still emits a frame |
| R2_T3d | `ledgerRecorded` is false when there is no ledger at all (EPHEMERAL) |
| R2_T3e | a denial whose logging throws is still reported as that denial |
| R2_T3f | a durable commit record is distinguished from a failed next-generation claim |
| R2_T3g | an unreadable ledger refuses the write and never reports the commit as recorded |
| R2_T3h | the frame distinguishes a durable commit from a failed next-generation claim |
| R2_T3i | "attempted and failed" is distinguishable from "never attempted" |
| R2_T4 | the agent tool surface cannot emit a result frame |
| R5_T1–T8 | accept / wrong id / duplicate / out-of-order / missing / malformed / injection / concurrent |
| R5_T8b | a cancelled request id cannot be reissued, so a delayed answer stays unsolicited |
| R5_T9 | a provisioned key signs; the real key verifies; another key does not |
| R5_T10 | the key is in no environment variable and its file is unlinked |
| R5_T11 | an undeletable key file refuses to sign rather than leaving a forgeable secret |

`scripts/omp-rpc-controller-contract-probe.mjs` runs the same contract on the
**real transport** — a real `omp --mode rpc` child per case, real stdout, real
session files:

| Case | Observed |
|---|---|
| `commit` | signed frame verifies; `rpcResponseShape = [id,type,command,success]`; `rpcResponseCarriesCommit = false`; log agrees; key file unlinked |
| `resume` | two real processes, one session id, generations 1 and 3, distinct runtime ids; a third process pinned to the first's runtime is refused `TARGET_RUNTIME_MISMATCH` |
| `no-ui` | `notifyFrameCount = 0`, result frame present and verified |
| `concurrent` | 4 pipelined commits → 4 accepted, attributed to their own ids, generations `[1,2,3,4]`, none pending |
| `injection` | forged frame visible on the wire, refused `MAC_MISMATCH`; genuine frame accepted |
| `no-authority` | `CONTROLLER_AUTHORITY_ABSENT` observable on the signed channel; `committed:false`; no ledger written |

`scripts/omp-rpc-controller-contract-suite.mjs` turns those records into 34
named PASS/FAIL facts — six of them `private-home`, one per case. A missing field is a failure, not a skip. The pinned
second result and the resume claims are gated on the probe's cryptographic
verdicts (`firstVerified`/`secondVerified`), not on the frame's own
`targetVerified` field: a frame that fails verification proves nothing, and
reading only the self-describing field let a wrong-key signature pass as PASS.

The probe runs every child under a **private HOME** (`prepareScratch()` points
`HOME` at a per-case directory). A scratch cwd does not isolate OMP's global
state; without this, a probe run created `~/.omp/agent/agent.db`, `models.db`,
`skill-descriptions.db`, a custom-session-file registration, caches, native
extraction and logs in the operator's real home.

---

## 7. Phase F — regression and rollback

### Regression

| Surface | How |
|---|---|
| `OMP_NORMAL_PROMPT`, `OMP_TOOL_CALLING`, `OMP_SLASH_COMMAND`, `OMP_AGENT_END`, `OMP_TERMINAL_FENCE_ORDERING` | `terminal-fence-ordering.acceptance.ts` (24 iterations, 552 late completions) — PASS |
| `OMP_ASYNC_JOB_DELIVERY` | `waiter-fence.acceptance.ts` — PASS |
| authority / legacy tool denial | `terminal-fence-authority.acceptance.ts` — PASS |
| wait-strategy policy | `poll-wait-policy.test.mjs` (21 assertions) — PASS |
| `RPC_REQUEST_RESPONSE` | `commit` / `concurrent` / `no-ui` / `no-authority` on the real transport — PASS |
| `AUTOLOOP_DISPATCH`, `CBM_ROUTING` | `test/omp-integration/*.mjs` (43 tests) — PASS; CBM files untouched (hash unchanged) |
| installer / publication hygiene | `test-omp-integration-installer.mjs`, `test-omp-publication-hygiene.mjs` — PASS |

`run-acceptance.mjs` now **scrubs** `OMP_TERMINAL_FENCE_AUTHORITY`,
`OMP_TERMINAL_FENCE_STATE_DIR`, `OMP_CONTROLLER_RESULT_KEY_FILE` and
`OMP_CONTROLLER_RESULT_TRANSPORT` from every harness child. This was not
theoretical: a shell that had exported them made the authority suite allocate
durable generations and fail an assertion that is correct for an ungoverned
process. Proven fixed by running the suite with all four exported — still PASS.

### Rollback — `ROLLBACK_VERIFIED = true`

Measured first, then fixed. `uninstall` is **not** a rollback: on a real pre-card
deployment it restored the replaced `no-poll-waits.js` and then *removed*
`lib/poll-wait-policy.js`, because that file was byte-identical at install time
and therefore had no backup. The restored extension imports the removed file.

`scripts/omp-rollback-integration.mjs` reverses exactly what an install did,
using the install's own `--json` record:

| Install action | Reversal |
|---|---|
| `copy` (file did not exist) | delete it |
| `replace` (file existed) | restore the backup bytes |
| `unchanged` | leave it |

It refuses when the record and the target disagree (a file changed after the
install, a backup missing, a path outside the deployment set), and prunes only
directories the install recorded creating and that are now empty.

Both of those were measured wrong first, and fixed:

- **Post-install edits were discarded.** Preflight checked only existence, so a
  file edited after the install was deleted (for a `copy`) or overwritten with
  the older backup (for a `replace`), with `ROLLBACK_RESULT = APPLIED` either
  way. The install record now carries `deployedSha256` for every action it
  performed, and the rollback compares the current bytes to it. A mismatch is a
  refusal.
- **Pre-existing empty directories were removed.** Ownership was inferred from
  deleted files, so an empty `lib/` that existed before the install was pruned.
  The install now records `createdDirectories`, and the rollback prunes only
  that set.

Verified end-to-end on a real deployment: pre-card bytes → install → rollback →
`diff -r` against the pre-card tree is **identical**, and the restored tree still
runs — a real `omp --mode rpc` child loaded it and committed
(`Terminal fence COMMITTED for run generation 1 as PASS`).
`test/omp-integration/test-omp-rollback.mjs` (7 tests) locks this in. Both new
guards were mutation-checked: neutering `matchesDeployed()` or restoring the
inferred-directory pruning each turns the corresponding test red.

---

## 8. Deployment surface

`KNOWN_FILES` grew by exactly three reviewed files:
`lib/controller-result.mjs`, `lib/runtime-identity.mjs`,
`test/controller-contract.acceptance.ts`.

The installer refused the first attempt because a fourth file
(`test/controller-contract.cases.ts`) was executable and not listed. Rather than
widen the deployment set for a test helper, the harness was merged into one
deployed file. That refusal is the mechanism working.

`node scripts/install-omp-integration.mjs install --dry-run` on this tree plans
only allowlisted copies. Nothing was installed.

---

## 9. Deliberate non-changes

- **R3 Controller Client is not implemented.** The card defers it. The verifier
  (`ResultCorrelator`, `verifyResultFrame`) is a library a client will use; it is
  not a client, opens no transport, and holds no policy about when to commit.
- **No production enablement.** No authority marker, key, state dir or transport
  variable is set anywhere outside throwaway probe processes.
- **`GDR_1` stays unapproved, `HARDENING_BRANCH_CLOSED` stays false,
  `ORIGINAL_GENERATION_COMMITTED` stays false.**
- **Unmanaged behavior is unchanged** by design: no capability means no ledger
  file, generation 1, no result key, commit denied — exactly as before.

---

## 10. Residual risks

1. **In-process forgery inside the trusted set.** A module loaded at launch can
   read the key. Mitigated only by launch-time control of `-e`/discovery, which is
   R3/R4 territory. Stated, not papered over.
2. **Ledger is per-session, not per-machine.** Two hosts mounting the same
   session directory would share numbering; the collision check fails closed
   rather than allowing a double commit, but a shared-filesystem controller must
   know this.
3. **`EPHEMERAL` mode does not continue numbering across restarts.** It removes
   the identity collision (the R1 defect) but not the numbering continuity. A
   controller that needs continuity must provision the state dir.
4. **Frame ordering.** Frames are written under `PIPE_BUF` in one `write`, but a
   very large `jobIds` list could exceed 4096 bytes; the writer refuses that frame
   (`RESULT_FRAME_TOO_LARGE`) rather than splitting it.
5. **`AEGIS_RPC_BIN` is unverified.** The transport suite runs whatever binary
   that variable names. Evidence in this card was produced with the native
   `/Users/zhengfengqing/.bun/bin/omp`, but the suite does not attest the binary's
   identity, so a substituted binary could satisfy it. A client that cares must
   pin the executable it trusts.
6. **Ledger appends are not atomic across processes.** A peer can append a
   conflicting allocation between this runtime's write and its re-read. The
   ownership check before the fence makes that fail closed rather than
   double-commit, but it is detection, not mutual exclusion. A lock file around
   allocation would be the real fix; it is not in this card, and the card's own
   preference is the minimal design.
7. **`ResultCorrelator` ids are unique for the correlator's lifetime, not
   globally.** Two correlator instances with the same key would each accept the
   same frame. A controller that restarts must use a fresh key (which it does:
   the key is per-launch) or a fresh correlator.
8. **A fence can land whose durable record failed.** If `advanceDurableGeneration`
   fails, the frame reports `committed:true` with `ledgerRecorded:false` and
   `identityState:UNWRITABLE`, and the runtime stops committing. The local
   terminal transition is real; the durable statement is incomplete, and the
   frame says so rather than hiding it. A controller must treat
   `ledgerRecorded:false` as "the ledger does not know about this commit".
