# Final disposition

**Card:** `AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1`
**Verdict:** `PASS`
**Date:** 2026-10-21

```
CARD = AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1

VERDICT = PASS

PREVIOUS_LANDING                 = PASS
R1_RUNTIME_GENERATION_IDENTITY   = PASS
R2_STRUCTURED_COMMIT_RESULT      = PASS
R5_REQUEST_CORRELATION           = PASS
R5_TRANSPORT_INTEGRITY           = PASS (within the stated launch trust boundary)
INTEGRATION_TESTS                = PASS
REGRESSION_TESTS                 = PASS
ROLLBACK_VERIFIED                = true
INDEPENDENT_REVIEW               = PASS
DURABLE_LANDING                  = PASS

PRODUCTION_MUTATION   = NONE
PRODUCTION_ENABLEMENT = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false

CONTROLLER_CLIENT_READY = false
GDR_1_APPROVED          = false

LANDED_HEAD = 59f55f44c4271c4914bee9b48a122c0cdb7e1d55
             (functional commit c7af8cc21115523d43cd246337700faa1089b9ae)

NEXT_ACTION = R3 Controller Client may be opened as a separate card. Production
              provisioning still requires explicit Owner authorization. Do not
              open a closeout card, and do not provision controller authority.
```

---

## 1. What this card fixed

The predecessor card proved the RPC channel works and left three contract gaps
on `HOLD`: the controller could not prove *who* executed a command, *which*
runtime and generation it targeted, or *whether* the extension actually
committed. This card repairs those three, and nothing else.

| Gap | Was | Now |
|---|---|---|
| R1 identity | `sessionId + generation`; generation was a module-local counter that restarted at 1 on resume | `(sessionId, runtimeInstanceId, generation)`, durably allocated, ownership re-verified against the ledger immediately before the fence |
| R2 result | the RPC `response` was `{id,type,command,success}`; `success:true` meant "prompt admitted" | a signed `controller_result` frame with `commandAccepted`, `commandDispatched`, `handlerExecuted`, `commitExecuted`, `committed`, `denial`, `ledgerRecorded`, identity |
| R5 correlation | notify frames carried a runtime-generated id; nothing tied a result to a request | every frame echoes the controller's own `requestId` and is HMAC-signed with a per-launch key; one accepted frame per request id |

---

## 2. Verification actually run

| Layer | Command | Result |
|---|---|---|
| Contract cases (fake host, real `AsyncJobManager`) | `node scripts/omp-integration/run-acceptance.mjs` | `CONTROLLER_CONTRACT_ACCEPTANCE=PASS cases=44` |
| Existing suites | same runner | `POLICY_TEST`, `WAITER_FENCE`, `TERMINAL_FENCE_AUTHORITY`, `TERMINAL_FENCE_ORDERING` all PASS |
| Integration tests | `node --test test/omp-integration/*.mjs` | 43 tests, 43 pass |
| Real transport (real `omp --mode rpc` child per case) | `node scripts/omp-rpc-controller-contract-suite.mjs` | `CONTROLLER_RPC_CONTRACT_SUITE=PASS facts=34` |

The transport suite spawns the real binary with a real session, a private ledger
dir, a private key file and a private `HOME`, and its facts are read from frames
that verify. `AEGIS_RPC_BIN` is honoured but not attested; see §6.5.

---

## 3. Independent review

Two reviewer sessions ran against this tree. Between their rounds they
reproduced eighteen distinct defects, every one of which was fixed and pinned by
a test that goes red when the fix is removed:

ledger record validation · generation range exhaustion · unusable-state-dir
fallback · allocation-time-only ownership · the automatic `agent_end` leg not
advancing the durable identity · malformed target tokens (`generation=1junk`,
`generation=`) · the release command's `parseInt` and its ignored identity pins ·
duplicate commit records for one generation · a post-fence throw reporting
`committed:false` · a prior-fence inference reporting a denial as committed ·
`ledgerRecorded:true` in EPHEMERAL mode · `ledgerRecorded:true` when the ledger
was unreadable · `ledgerRecorded:false` when the commit record WAS durable but
the next-generation claim failed · the same conflation at the FRAME level ·
`commitExecuted:false` for an attempted-but-failed commit · correlator
request-id reuse after `cancel()` · an undeletable key still signing.

Final verdicts: one reviewer closed **correct** (confidence 0.92, "no remaining
actionable defect reproduced"); the other closed `incorrect` on a single P2 —
`commitExecuted` conflating a successful fence with an attempted commit — which
was fixed after that verdict and is now pinned by `R2_T3i`. Three guards were independently
mutation-checked by the reviewer (automatic ownership rejection, the per-attempt
fence delta, the MAC comparison), each red when removed, green when restored.

The reviewer also confirmed the no-authority regression: generation 1, no ledger
file, `committed:false`, `CONTROLLER_AUTHORITY_ABSENT`.

---

## 4. Rollback

`scripts/omp-rollback-integration.mjs` reverses exactly one install from the
install's own `--json` record, and refuses rather than guesses:

- a file whose bytes no longer match the record's `deployedSha256` (a
  post-install edit) is a refusal, not a discard;
- only directories the install recorded in `createdDirectories` are pruned, so a
  pre-existing empty `lib/` survives;
- a missing backup, a missing replaced file, or a path outside the deployment
  set is a refusal, and a refusal changes nothing.

`test/omp-integration/test-omp-rollback.mjs` (7 tests) covers the byte-for-byte
reversal, both refusal classes, both newly-fixed classes, and dry-run. Both new
guards were mutation-checked.

`ROLLBACK_VERIFIED = true`.

---

## 5. Production isolation

Measured before and after all work:

| Artifact | Before | After |
|---|---|---|
| `~/.omp/agent/extensions/no-poll-waits.js` | `11d8628b…f8ef` | `11d8628b…f8ef` |
| `~/.omp/agent/config.yml` | `108ca03c…8d66` | `108ca03c…8d66` |

No authority marker, key file, state directory or transport variable is set
anywhere outside throwaway probe processes. The landing changed the repository;
it did not touch the running installation.

---

## 6. Residual risks — stated, not papered over

1. **In-process forgery inside the launch set.** A module loaded at launch shares
   the module graph and can read the key from memory. Only launch-time control of
   `-e`/discovery mitigates that; it is R3/R4 territory.
2. **Ledger is per-session, not per-machine.** Two hosts sharing a session
   directory would share numbering. Ownership and duplicate-commit checks fail
   closed rather than allowing a double commit, but a shared-filesystem controller
   must know this.
3. **`EPHEMERAL` does not continue numbering across restarts.** It removes the
   identity collision but not the numbering continuity; a controller that needs
   continuity must provision the state dir.
4. **Frame size.** Frames are written under `PIPE_BUF` in one `write`; a `jobIds`
   list that would exceed 4096 bytes is refused (`RESULT_FRAME_TOO_LARGE`) rather
   than split.
5. **`AEGIS_RPC_BIN` is not attested.** The transport suite runs whatever binary
   that variable names. Evidence here used the native
   `/Users/zhengfengqing/.bun/bin/omp`, but the suite does not verify the binary's
   identity, so a substituted binary could satisfy it.
6. **Ledger appends are not atomic across processes.** A peer can append between
   this runtime's write and its re-read. The pre-fence ownership check makes that
   fail closed rather than double-commit — detection, not mutual exclusion. A
   lock file around allocation would be the real fix and is outside this card.
7. **Correlator ids are unique per correlator, not globally.** Two correlators
   with the same key would each accept the same frame. The key is per-launch, so
   a restarting controller gets a fresh one.
8. **A fence can land whose durable record failed.** The frame then reports
   `committed:true` with `ledgerRecorded:false` and `identityState:UNWRITABLE`,
   and the runtime stops committing. The local transition is real; the durable
   statement is incomplete, and the frame says so. The converse is also reported:
   when the commit record IS durable but the next-generation claim failed, the
   frame says `ledgerRecorded:true` with a non-null `ledgerError` — the record
   exists, the advance did not.

---

## 7. What this PASS does NOT mean

```
CONTROLLER_CLIENT_READY = false
GDR_1_APPROVED          = false
PRODUCTION_ENABLEMENT   = false
HARDENING_BRANCH_CLOSED = false
```

The verifier (`ResultCorrelator`, `verifyResultFrame`) is a library a client will
use. It is not a client: it opens no transport and holds no policy about when to
commit. R3 is a separate card, and production provisioning still needs explicit
Owner authorization.
