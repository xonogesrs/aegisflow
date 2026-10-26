# Final disposition

**Card:** `AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1`
**Verdict:** `PASS` (isolated implementation and acceptance)
**Date:** 2026-10-21

```
CARD = AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1

VERDICT = PASS

PREVIOUS_LANDING  = PASS
MODEL_IDENTITY    = PASS

R3_CONTROLLER_CLIENT = PASS

TRUSTED_LAUNCH            = PASS
TCB_INTEGRITY             = PASS
RPC_BINARY_PROVENANCE     = PASS
AUTHORITY_BOUNDARY        = PASS

SESSION_BINDING           = PASS
GENERATION_BINDING        = PASS
RESULT_CORRELATION        = PASS
COMMIT_STATE_MACHINE      = PASS

CROSS_PROCESS_EXCLUSIVITY = PASS
CRASH_RETRY_IDEMPOTENCY   = PASS

RESIDUAL_RISKS_RECONCILED = PASS
INTEGRATION_TESTS         = PASS
REGRESSION_TESTS          = PASS
ROLLBACK_VERIFIED         = true

INDEPENDENT_REVIEW = PASS
DURABLE_LANDING    = PASS

PRODUCTION_MUTATION   = NONE
PRODUCTION_ENABLEMENT = false

GDR_1_APPROVED                = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false
```

`PASS` here means exactly what §13 of the card says it means: the Controller
Client is implemented, integrated, regression-tested, rollback-verified,
independently reviewed and durably landed **in isolation**. It does not mean
production-ready, and it does not approve GDR-1.

---

## 1. What was built

| Piece | File | Purpose |
|---|---|---|
| Controller client | `src/control-plane/controller-client.mjs` | Attests the RPC binary and the extension tree, launches a governed child, binds its identity, commits through `ResultCorrelator`, and reports a state from the card's machine |
| Cross-process lock | `integrations/omp/extensions/lib/ledger-lock.mjs` | Makes ledger allocation and commit transactions mutually exclusive across processes |
| Identity leg | `integrations/omp/extensions/no-poll-waits.js` (`/fence-identity`) | A read-only identity command, so a controller binds before committing instead of committing to discover |
| Ledger hardening | `integrations/omp/extensions/lib/runtime-identity.mjs` | Lock-wrapped transactions, peer-aware next-generation claim, post-append uniqueness verification |
| Transport suite | `scripts/omp-rpc-controller-r3-suite.mjs` | Phase D on the real binary, 78 facts |
| Ledger worker | `scripts/omp-controller-ledger-worker.mjs` | One-transaction process for the concurrency races |
| Tests | `test/omp-integration/test-controller-client.mjs`, `test-ledger-exclusivity.mjs`, `test-r3-rollback-and-isolation.mjs` | 27 + 12 + 7 cases |

Nothing was reimplemented: `ResultCorrelator` and `verifyResultFrame` are imported
from the shipped `lib/controller-result.mjs`. There is exactly one result
protocol, and the controller is a client of it.

---

## 2. The three named boundaries

### 2.1 Launch-loaded modules are in the TCB

- `--no-extensions` is forced, so discovery contributes nothing.
- Caller argv may not carry `-e` / `--extension` / `--hook`; the legitimate need
  for a second module is met by `additionalExtensions`, where every extra module
  is attested with its own digest.
- The primary extension must match a caller-supplied SHA-256, and **every** `lib/`
  sibling carries its own digest. A caller may pin the whole tree; a missing,
  extra or altered module is refused.

Boundary, stated: without a caller-supplied tree the digests are recorded, not
verified (`treeVerified:false`). A module inside the attested set is inside the
TCB by construction and is not defended against.

### 2.2 Ledger cross-process exclusivity

The predecessor's own words were "detection, not mutual exclusion… a lock file
around allocation would be the real fix". `lib/ledger-lock.mjs` is that lock:
exclusive create, record published atomically (write-temp-then-`link`, so a peer
never observes a half-written record), dead-pid reclaim guarded by a byte
comparison, foreign-host refusal, and in-process reentrancy so nested ledger calls
cannot self-deadlock.

Measured with real OS processes:

| Scenario | Result |
|---|---|
| 8 processes allocate concurrently, 8 rounds | 8/8 distinct generations, every round |
| 6 processes commit one generation, 6 rounds | exactly 1 winner, exactly 1 commit record, every round |
| The same test with the lock removed | **2–3 commit records for one generation** |
| Live holder / dead holder / foreign host / corrupt record | BUSY / reclaimed / refused / refused |
| Nested acquire, throwing section | no deadlock, no leftover lock |

The mutant is what makes this a proof rather than an assertion.

### 2.3 `AEGIS_RPC_BIN` provenance

Absolute path required (a bare `omp` is refused rather than resolved through
PATH), `realpath`-resolved, regular and executable, not world-writable, with no
world-writable directory on the path, hashed before spawn and re-hashed after
spawn, and the child's own executable read from the OS and compared. The version
string is read from the attested file, not from PATH.

---

## 3. Commit state machine

`NOT_REQUESTED · REQUEST_SENT · COMMAND_ACCEPTED · HANDLER_EXECUTED ·
COMMIT_ATTEMPTED · COMMITTED · COMMITTED_UNCONFIRMED · DENIED · FAILED · UNKNOWN`

The load-bearing distinctions, each pinned by a test:

| Distinction | How it is enforced |
|---|---|
| `commandAccepted` ≠ commit | `classifyCommitResult` only returns COMMITTED on `committed:true` |
| `commitExecuted` ≠ committed | attempted-and-failed maps to `COMMIT_ATTEMPTED`, not COMMITTED |
| Timeout ≠ failure | a dispatched command with no answer is `UNKNOWN`, never `FAILED` |
| Lost result ≠ safe retry | `UNKNOWN` is returned with the durable record probed; nothing auto-retries |
| Durable commit + lost response | `COMMITTED_UNCONFIRMED` |
| Commit landed, record failed | `COMMITTED_UNCONFIRMED` with `COMMITTED_NOT_DURABLE` |

Target binding is validated **before** dispatch: contradictory status, incomplete
target, or a target that is not the bound identity all return `NOT_REQUESTED`
with `dispatched:false`. The bound identity supplies session, runtime **and
generation**, so omitting an expectation pins the identity that was bound rather
than whatever is live.

A successful result must name the target's session and runtime, whether or not a
bind happened first. A denial from a different identity stays observable, because
hiding it would hide what a controller needs when its target was wrong.

---

## 4. Verification actually run

| Layer | Command | Result |
|---|---|---|
| Integration tests | `node --test test/omp-integration/*.mjs` | **92 tests, 92 pass** |
| Contract cases (fake host, real `AsyncJobManager`) | `node scripts/omp-integration/run-acceptance.mjs` | `CONTROLLER_CONTRACT_ACCEPTANCE=PASS cases=45`, all five sections PASS |
| Real transport (real `omp --mode rpc` child) | `node scripts/omp-rpc-controller-r3-suite.mjs` | `CONTROLLER_R3_TRANSPORT_SUITE=PASS facts=84` |
| Phase E adjacent | `test-omp-cbm-query` 11/11 · `test-autoloop-entrypoint` + `test-pi-autoloop-launcher` 21/21 · rollback + installer 20/20 | all pass, identical to base |

### Phase D matrix

| # | Scenario | Evidence |
|---|---|---|
| 1 | Correct controller/session/generation | `commit` case, 13 facts |
| 2 | Agent without authority | `no-authority` case (4 facts) + authority acceptance |
| 3 | Wrong runtime | client `TARGET_DRIFT` + runtime `TARGET_RUNTIME_MISMATCH` (raw) |
| 4 | Wrong generation | `targets:wrong-generation-denied` + `TARGET_GENERATION_MISMATCH` |
| 5 | Wrong request id | `R5_T2`, correlator rejects unknown ids |
| 6 | Bad HMAC | `injection` case + `R5_T7` |
| 7 | Duplicate result | `R5_T3` + `targets:duplicate-denied` |
| 8 | Unattested RPC binary | `unattested-binary` case, 10 facts (incl. ambient-authority refusal) |
| 9 | Untrusted loaded module | `untrusted-module` case, 6 facts: argv refusal, unpinned-tree refusal, altered-sibling refusal |
| 10 | Two processes race a commit | `test-ledger-exclusivity` (6-way × 6 rounds) + `two-runtimes` |
| 11 | Ledger unreadable | `R1_T7`, `R2_T3g`, probe `UNKNOWN` |
| 12 | Ledger write failure | `row12:*` — attempted, landed locally, record failed, EACCES named |
| 13 | Lost response after commit | `row13:*` — frame produced and swallowed, ledger confirms the commit |
| 14 | Controller process crash | `controller-crash` case — SIGKILL after the frame is written, same-session resume asserted |
| 15 | Session resume | `resume` case + `R1_T2/T6` + `two-runtimes` |
| 16 | stdout frame injection | `injection` case — attested attacker module, forged frame refused |

### Rollback

`ROLLBACK_VERIFIED = true`, measured:

- the pre-R3 fixture uses the **base-commit bytes** (`git show 51ce4f8:…`), not
  current files minus one module;
- rollback restores the tree byte-for-byte and removes the R3-only module;
- the restored module is syntactically valid and its module graph resolves;
- the pre-R3 extension answers an ordinary prompt and a slash command on the real
  binary, with `success:true`, and the runtime stays alive;
- an out-of-tree ledger and evidence file are byte-identical after rollback;
- no signing key survives controller-root disposal.

---

## 5. Independent review

A fresh reviewer session reviewed the change against the card. It found, and I
fixed, every one of these — each with a test that fails when the fix is removed:

1. a vacuous assertion comparing a value with itself;
2. `expectedStatus` never compared (a signed FAIL-for-PASS was accepted);
3. the status check gated on an optional field callers never supply;
4. the contradictory-status check running **after** dispatch;
5. a `-e`/`--hook` argv bypass that could widen the TCB;
6. `generation + 1` claimed blindly, locking a peer out of the generation it owned;
7. row 12 passing on an unreadable-ledger denial rather than a write failure;
8. row 13 only timing out rather than losing a real response;
9. row 14 killing the runtime instead of the controller;
10. the crash marker written before dispatch, and a vacuous same-session check;
11. `R2_T3f` claiming an injection its body never performed;
12. rollback test names overstating what they executed;
13. the pre-R3 fixture not using pre-R3 bytes;
14. a signed success from a foreign session/runtime accepted without a bind;
15. sibling modules present but not hashed;
16. the ledger probe matching on type and generation only;
17. `EPHEMERAL`-era empty ledger reported as `NOT_COMMITTED`;
18. a lock-record publish window (`open(O_EXCL)` then write) that made peers fail
    closed on a lock that was merely being written;
19. a released-lock `ENOENT` misread as corruption;
20. the pinned-tree helper existing but never wired into the governed launch;
21. the inherited-authority gate reading the optional `env` argument instead of the
    process's real environment;
22. `entry.tree` being optional for additional extensions, so a second module could
    skip the pinning required of the primary;
23. `allowInheritedAuthority` existing at all — removed rather than kept for tests.

Final clause dispositions from the reviewer: **C3 PASS**, **C4 PASS**, **C5 PASS**,
**C6 PASS** for the reviewed paths. C1 and C2 were held, then repaired with code
(pinned trees required by the launch, ambient-environment authority check, every
caller-selectable escape removed) and re-submitted.

The reviewer also corrected one of my claims, and the document now says so: the
post-append uniqueness check is **defence in depth, not a proof of mutual
exclusion**, because a second writer can append after another writer's
verification. The exclusivity argument remains the lock plus the race
measurements and the mutant.

---

## 6. Residual risks — all eight, reconciled

Full table in [RESIDUAL_RISK_RECONCILIATION](RESIDUAL_RISK_RECONCILIATION.md).

| # | Risk | Class |
|---|---|---|
| 1 | In-process forgery inside the launch set | ACCEPTED_WITH_BOUNDARY |
| 2 | Ledger is per-session, not per-machine | ACCEPTED_WITH_BOUNDARY |
| 3 | `EPHEMERAL` does not continue numbering | MITIGATED_BY_R3 |
| 4 | Frame size limit | CLOSED_BY_R3 |
| 5 | `AEGIS_RPC_BIN` is not attested | CLOSED_BY_R3 |
| 6 | Ledger appends are not atomic across processes | CLOSED_BY_R3 |
| 7 | Correlator ids are unique per correlator | ACCEPTED_WITH_BOUNDARY |
| 8 | A fence can land whose durable record failed | ACCEPTED_WITH_BOUNDARY |

`BLOCKING = 0`. Risks 1, 2, 7 and 8 remain real and are bounded, not dissolved.

---

## 7. Production isolation

Measured before any work and after all of it:

| Artifact | Before | After |
|---|---|---|
| `~/.omp/agent/extensions/no-poll-waits.js` | `11d8628b…f8ef` | `11d8628b…f8ef` |
| `~/.omp/agent/config.yml` | `108ca03c…8d66` | `108ca03c…8d66` |

No authority marker, key file, state directory or transport variable was set
outside throwaway controller processes. The test suite asserts this itself: it
hashes both production files around a real transport run, and fails if either
changes.

---

## 8. What this PASS does not mean

```
PRODUCTION_READY        = false
PRODUCTION_ENABLEMENT   = false
GDR_1_APPROVED          = false
HARDENING_BRANCH_CLOSED = false
ORIGINAL_GENERATION_COMMITTED = false
```

The next card should be **Production Enablement Admission / Rollback Readiness**:
it must decide whether the four accepted boundaries above are acceptable for the
actual deployment, and it is the Owner's decision, not this card's.

---

## 9. Known limits, stated rather than implied

- The transport suite runs an inert provider on a closed port, so it proves the
  runtime accepts and answers ordinary prompts and slash commands; it does not
  prove model-quality output and does not exercise tool calling.
- `OMP_ASYNC_DELIVERY`, `OMP_AGENT_END` and `OMP_TERMINAL_FENCE_ORDERING` are
  covered by the host-harness acceptance cases, not by the transport suite.
- Pre-existing `test/v2/*` failures are unrelated to this change: identical counts
  were reproduced at base commit `51ce4f8` (pipeline 18/24, pi-transport-adapter
  8/16, e3-discrimination 5/8, e3-lease-outage-soak 6/9,
  e3-lease-outage-soak-crossproc 4/5). Root cause was a self-referential
  `node_modules` symlink in the canonical checkout, restored unchanged.
