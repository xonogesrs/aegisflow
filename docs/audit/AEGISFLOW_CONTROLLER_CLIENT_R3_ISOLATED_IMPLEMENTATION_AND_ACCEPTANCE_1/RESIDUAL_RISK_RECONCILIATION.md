# Residual risk reconciliation — all eight

**Card:** `AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1`
**Phase:** A (Admission)
**Source of the eight:** `docs/audit/AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1/FINAL_DISPOSITION.md` §6.

The predecessor card listed eight residual risks. Only three of them were carried
into the R3 authorization as named boundaries; the other five were never
re-examined. This document reads all eight from the source and classifies each
against what R3 actually built.

Classification vocabulary, as the card defines it:

```
CLOSED_BY_R3             the risk no longer exists; the mechanism is gone
MITIGATED_BY_R3          the risk exists but R3 adds a control that bounds it
ACCEPTED_WITH_BOUNDARY   the risk remains and is accepted inside a stated boundary
BLOCKING                 production enablement must not proceed until resolved
OUT_OF_SCOPE             not R3's subject, and not claimed
```

---

## 1. Summary

| # | Risk (short) | Class | Where it now lives |
|---|---|---|---|
| 1 | In-process forgery inside the launch set | **ACCEPTED_WITH_BOUNDARY** | `lib/controller-result.mjs` header; §2.1 below |
| 2 | Ledger is per-session, not per-machine | **ACCEPTED_WITH_BOUNDARY** | §2.2 |
| 3 | `EPHEMERAL` does not continue numbering | **MITIGATED_BY_R3** | `launchGovernedRuntime` always provisions a state dir |
| 4 | Frame size limit | **CLOSED_BY_R3** (no longer reachable) | `publishControllerResult` refuses >4096 bytes; §2.4 |
| 5 | `AEGIS_RPC_BIN` is not attested | **CLOSED_BY_R3** | `attestRpcBinary` |
| 6 | Ledger appends are not atomic across processes | **CLOSED_BY_R3** | `lib/ledger-lock.mjs` |
| 7 | Correlator ids are unique per correlator, not globally | **ACCEPTED_WITH_BOUNDARY** | per-launch key + one correlator per launch |
| 8 | A fence can land whose durable record failed | **ACCEPTED_WITH_BOUNDARY** | frame reports it; R3 adds `probeLedgerForCommit` |

```
BLOCKING = 0
```

No residual risk blocks production enablement *on its own*. What blocks it is
the absence of a production provisioning decision (GDR-1), which is not a risk
on this list.

---

## 2. Each risk, against the code

### 2.1 In-process forgery inside the launch set — ACCEPTED_WITH_BOUNDARY

**The risk.** A module loaded at launch shares the module graph and can read the
result-signing key from memory. It could therefore sign a frame this controller
would accept.

**What R3 changes.** Nothing about the module graph — but the launch surface is
now controlled rather than assumed:

- `launchGovernedRuntime` always passes `--no-extensions`, so discovery
  contributes nothing and the extension set is exactly the `-e` paths.
- The one attested extension must match a caller-supplied SHA-256, and its `lib/`
  siblings must be present, regular and not world-writable (`attestExtension`).
- Every module in the loaded tree carries its own SHA-256, and a governed launch
  REQUIRES the pinned tree (`extensionTree`). Every sibling digest is compared; a
  missing or extra module is a layout refusal, a digest difference is a hash
  refusal, and a launch without a pinned tree fails closed before spawning. There
  is deliberately no "record it this time" escape at launch: a governed process
  either knows the module set it is willing to run or it does not launch. The
  first-run observation is available from `attestExtension` directly, for a caller
  establishing the manifest.
- The client refuses to launch when the launching environment already carries the
  capability marker (`AUTHORITY_INHERITED`), so authority cannot become
  transitive through a chain of launches. Both the PROCESS'S OWN environment and
  any supplied child environment are inspected: an earlier version checked only
  the optional `env` argument, which defaults to `{}`, so a process that really
  held the marker could launch anyway. Measured by independent review. There is
  NO opt-out parameter: an earlier `allowInheritedAuthority` flag was removed
  rather than kept for tests, because a bypass that exists for tests is still a
  bypass.

**Boundary.** A module that is *inside* the attested set, or a deliberate second
`-e` path supplied by the caller, is inside the TCB by construction. R3 makes the
set small, hashed and visible; it does not make it trustworthy in an adversarial
sense. Measured evidence: the `injection` case loads a second, un-attested
extension that forges a correctly-shaped frame — it is refused (`MAC_MISMATCH`)
and recorded, while the genuine frame is still accepted. That proves the boundary
is where this document says it is: an un-attested module outside the set cannot
forge, and a module inside it is not defended against.

### 2.2 Ledger is per-session, not per-machine — ACCEPTED_WITH_BOUNDARY

**The risk.** Two hosts sharing a session directory share numbering.

**What R3 changes.** `withLedgerLock` never reclaims a lock whose record names a
different host — `LEDGER_LOCK_FOREIGN_HOST`, fail closed. That converts a silent
shared-filesystem corruption into a visible refusal, which is strictly better
than the predecessor's behaviour, but it does not make cross-host coordination
work.

**Boundary.** One host per state directory. A deployment that puts a ledger on a
network share will refuse rather than corrupt. Measured: the `foreign host` case
in `test-ledger-exclusivity.mjs`.

### 2.3 `EPHEMERAL` does not continue numbering across restarts — MITIGATED_BY_R3

**The risk.** Without a state directory, a restart begins at generation 1 and a
controller that needs continuity cannot get it.

**What R3 changes.** The client cannot produce this state: `launchGovernedRuntime`
requires a controller root, refuses one whose state dir is missing or unusable
(`STATE_DIR_UNUSABLE`), and always passes `OMP_TERMINAL_FENCE_STATE_DIR`. A
runtime launched by this client is `ALLOCATED`, never `EPHEMERAL`. Measured: the
`commit` case asserts `identityState === "ALLOCATED"`.

**Boundary.** This is a property of the *client*, not of the extension. A runtime
launched by hand without a state dir still starts at generation 1, and the
extension still reports that honestly as `EPHEMERAL` / `generationDurable:false`.
R3 does not change the extension's mode semantics.

### 2.4 Frame size — CLOSED_BY_R3

**The risk.** A `jobIds` list that would exceed 4096 bytes is refused
(`RESULT_FRAME_TOO_LARGE`) rather than split, so a very large commit has no
result frame.

**Why this is closed rather than accepted.** The refusal is still there, but it is
no longer an *unobserved* failure mode for the controller: `publishControllerResult`
reports `RESULT_FRAME_TOO_LARGE` in its return value and the command handler logs
it, and R3's client turns a missing frame into `UNKNOWN` (never `COMMITTED`),
then resolves it from the ledger with `probeLedgerForCommit`. The controller
therefore learns the true outcome even when the frame cannot be emitted.

**Residual, stated.** The controller does not receive the job list in that case.
It learns *whether* the commit landed, not *what* it suppressed. That is a
reporting limitation, not a safety one.

### 2.5 `AEGIS_RPC_BIN` is not attested — CLOSED_BY_R3

**The risk.** The transport suite ran whatever binary that variable named, so a
substituted binary could satisfy it.

**What R3 changes.** `attestRpcBinary`:

- requires an absolute path (`BIN_NOT_ABSOLUTE` — a bare `omp` is refused rather
  than resolved through PATH);
- resolves through `realpath` and requires a regular, executable file;
- refuses a world-writable file (`BIN_WORLD_WRITABLE`) **and** any world-writable
  directory on the path to it (`BIN_PARENT_WORLD_WRITABLE`);
- hashes it before spawn and re-hashes after spawn (`BIN_CHANGED_BEFORE_SPAWN`,
  `BIN_CHANGED_AFTER_SPAWN`);
- reads the child's own executable from the OS and compares it with the attested
  path (`CHILD_EXECUTABLE_MISMATCH`);
- reads the version from the attested file, not from PATH.

Measured: `unattested-binary` case (6 facts) and 7 unit cases. The suite's
`rpcBinary` evidence records the attested path, SHA-256 and version.

**Boundary.** This is provenance, not signature. It proves the file that ran is
the file that was hashed, and that no unprivileged user could have replaced it.
It does not prove the binary was built from a known source.

### 2.6 Ledger appends are not atomic across processes — CLOSED_BY_R3

**The risk, in the predecessor's own words:** "A peer can append between this
runtime's write and its re-read. The pre-fence ownership check makes that fail
closed rather than double-commit — detection, not mutual exclusion. A lock file
around allocation would be the real fix and is outside this card."

**What R3 changes.** `lib/ledger-lock.mjs` is that lock file, and it wraps all
three ledger transactions: allocation, commit-and-claim, and (through
reentrancy) the duplicate-commit check.

Measured, with real OS processes:

| Test | Result |
|---|---|
| 8 processes allocate concurrently, 8 rounds | 8/8 distinct generations every round |
| 6 processes commit the same generation, 6 rounds | exactly 1 winner, exactly 1 commit record, every round |
| The same test with the lock removed (mutant) | **2–3 commit records for one generation** |
| Lock held by a live process | `LEDGER_LOCK_BUSY`, critical section does not run |
| Lock held by a dead process | reclaimed, section runs |
| Lock held by another host | `LEDGER_LOCK_FOREIGN_HOST`, never reclaimed |
| Corrupt lock record | `LEDGER_LOCK_CORRUPT`, fail closed |
| Nested acquire in one process | runs directly, no deadlock |

The mutant result is what makes this a proof rather than an assertion: the test
goes red when the lock is removed.

**What the lock is, and what it is not.** It is an exclusive-create lock whose
record appears atomically (write-temp-then-link) and whose reclaim path is guarded
by a dead-pid test plus a byte comparison. It is not a distributed lock, a lease
protocol, or a fencing-token service, and it is not claimed to be one.

**Defence in depth, not the exclusivity argument.** `recordCommitAndClaimNext`
also re-reads the ledger after appending and requires exactly one commit record
for the generation, matched to this runtime (`COMMIT_RECORD_NOT_UNIQUE_…`
otherwise). Independent review correctly noted this does **not** prove mutual
exclusion by construction — a second writer can append after another writer's
verification. It is a detector for the case where the lock's assumption fails,
and the exclusivity argument remains the lock plus the race measurements above.
Contract case `R2_T3j` covers the detector through a test-only seam that opens the
window the lock closes; without that seam the guard would be untestable.

**Two defects found and fixed while building this, both by measurement:**

1. `open(O_EXCL)` then write leaves a window where the path exists but the record
   is empty; a peer reading it reported `MALFORMED_JSON`. Measured at 1–4 of 8
   processes failing closed for a lock that was merely being written. Fixed by
   writing the record at a private temp path and `link()`ing it into place.
2. A release between a peer's `lstat` and its `read` produced `ENOENT`, which was
   mapped to `UNREADABLE`. Measured at 2 of 8. Fixed by treating `ENOENT` as
   `ABSENT` and retrying.

**A third defect, in the ledger's semantics rather than its locking:**
`recordCommitAndClaimNext` claimed `generation + 1` blindly. With a peer process
running that number, the ledger then held two allocate records for it and
`verifyOwnership` refused *both* — the peer could never commit again
(`GENERATION_OWNERSHIP_LOST`). Fixed by claiming the ledger's highest generation
plus one, and by having the runtime adopt the number the ledger gave it. Measured
in the `two-runtimes` transport case: two live processes on one session, both
commit, one record per generation.

### 2.7 Correlator ids are unique per correlator, not globally — ACCEPTED_WITH_BOUNDARY

**The risk.** Two correlators with the same key would each accept the same frame.

**What R3 changes.** The client creates exactly one correlator per launch and
mints a fresh key per launch (`result.<pid>.<nonce>.key`, unlinked by the
extension at load). Two launches therefore cannot share a key, and a restart
cannot accept a predecessor's frames.

**Boundary.** Within one launch, the correlator is the only acceptance path, and
`ResultCorrelator.expect` refuses a reissued id — but the guarantee is per launch,
not global. A controller that copies a key file before launch would break it; the
client never does.

### 2.8 A fence can land whose durable record failed — ACCEPTED_WITH_BOUNDARY

**The risk.** The frame reports `committed:true` with `ledgerRecorded:false` and
`identityState:UNWRITABLE`, and the runtime stops committing. The local
transition is real; the durable statement is incomplete.

**What R3 changes.** The client does not have to trust the frame's self-report:
`probeLedgerForCommit` reads the ledger directly and is used whenever a frame does
not arrive. Its tri-state (`COMMITTED` / `NOT_COMMITTED` / `UNKNOWN`) keeps
"unreadable" out of both the success and the failure bucket.

The probe validates records rather than matching on type and generation:
a line must parse, be an object, carry a known record type, a positive safe-integer
generation, this session's id and a non-empty runtime id. A commit recorded by a
different runtime than the caller pinned is `UNKNOWN`, not this controller's
success. A torn FINAL line is skipped (the tail states nothing), while a malformed
line anywhere else makes the file `UNKNOWN`. An empty or allocation-free ledger
also answers `UNKNOWN`, because it proves nothing about a commit either way.

**Boundary.** When the durable write genuinely failed, the ledger cannot say the
commit happened, and the client reports `COMMITTED_UNCONFIRMED` (if a frame
claimed the commit) or `UNKNOWN`. It never reports `COMMITTED` without either a
verified frame claiming it or a durable record. This is the honest floor: R3
cannot make an fsync succeed.

---

## 3. The three boundaries the authorization named

| Named boundary | Status | Evidence |
|---|---|---|
| Launch-loaded modules are in the TCB | **PASS** — surface made small, hashed and non-writable; boundary stated | `attestExtension`, `--no-extensions` forced, `untrusted-module` case |
| Ledger cross-process is not exclusive | **PASS** — now exclusive, proven by real processes and by a mutant | `lib/ledger-lock.mjs`, 12 exclusivity tests |
| `AEGIS_RPC_BIN` is unwitnessed | **PASS** — attested by hash, path, mode and child executable | `attestRpcBinary`, 7 unit cases + 6 transport facts |

---

## 4. What this reconciliation does not claim

```
PRODUCTION_READY        = false
PRODUCTION_ENABLEMENT   = false
GDR_1_APPROVED          = false
HARDENING_BRANCH_CLOSED = false
```

Risks 1, 2, 7 and 8 remain real. Each is bounded by a control this card added and
each is measured; none of them is dissolved by it. Production enablement requires
a separate admission that reads this table and decides whether those four
boundaries are acceptable for the actual deployment — that decision is the
Owner's, and R3 does not pre-empt it.
