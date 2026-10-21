# R4 — Implementation record

**Card:** `AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1`
**Phases:** B (authority isolation), C (authenticated ledger), D (deployed code integrity)

This is what changed and why each change is load-bearing. Every claim about
mechanism has a matching measurement in `THREAT_MODEL.md` and a test in
`ADVERSARIAL_EVIDENCE.md`.

---

## R4-A — Controller authority isolation

### The defect

`OMP_TERMINAL_FENCE_AUTHORITY` **was** the authority. A governed launch set it on
the child; the child's `bash` inherited it; setting it again on a nested `omp`
was sufficient to commit. Anything a process can print, it can also put in its
own children's environment, so this was never a boundary.

### The repair

Authority is now a **capability**: an open descriptor to the ledger plus the key
that authenticates what is written through it. New module
`lib/controller-capability.mjs`.

| Mechanism | Why it is a boundary |
|---|---|
| The controller opens the ledger and passes the descriptor as a `stdio` slot | the child receives something it cannot manufacture from a string |
| The extension re-opens it through `/dev/fd/N` (`O_CLOEXEC`) and closes the inherited one | a descriptor passed via `stdio` **is** inherited by exec'd grandchildren (measured `FD3_INHERITED`); the re-open is not (measured `OWN_ABSENT`) |
| The launch sandbox denies `file-write*` on the ledger path and `file-read*` on the key | a descendant that knows the path still cannot use it |
| `controllerAuthorityPresent()` asks `capabilityPresent()`, not `env[...]` | the question is "does this process hold it", not "does a variable say so" |

The retired variable is still **read**, but only to recognise and refuse it:
`launchGovernedRuntime` refuses to launch when its own environment or a supplied
child environment carries it (`AUTHORITY_INHERITED`). It grants nothing.

`installControllerAuthorityForTest` / `clearControllerAuthorityForTest` exist for
the acceptance harness, which has to drive the real commit path from a process it
controls. They are not registered as a tool or a command, so the Agent cannot
reach them.

**Lifetime.** One capability per process, installed once at module load. The key
descriptor is read and closed immediately. Nothing is serialisable and nothing is
transferable by copying a string.

---

## R4-B — Authenticated ledger

### The defect

A commit record was believed because it looked right:
`{"type":"commit","generation":1,…}`. The admission card measured a forged record
reported as `COMMITTED`, and the same forgery then blocked the legitimate
controller with `GENERATION_ALREADY_COMMITTED`.

### The repair

New module `lib/ledger-auth.mjs`. Every record carries an HMAC-SHA256 over a
canonical projection of its own fields, computed with the controller root's
ledger key.

```
ledgerMacInput = canonicalJson({ v, type, sessionId, runtimeInstanceId,
                                 generation, allocationToken, status, requestId, at })
```

`canonicalJson` is the one the R5 result frame already uses, so both signed
artefacts share a serializer and neither depends on property order.

### The distinction that matters most

The card requires full identity validation. Applied naively, that introduces a
double commit, so the two questions are separated:

| Question | Function | Semantics |
|---|---|---|
| Is this generation closed **at all**? | `commitRecordState(path, gen, session)` | ANY authenticated commit for (session, generation). This is the **gate**: a peer's commit must stop this runtime writing a second one. |
| Is it closed **by me**? | `commitRecordState(path, gen, session, { runtimeInstanceId, allocationToken })` | the commit is attributable to this runtime and this allocation. This is the **attribution** check, used for reporting. |

Commit records now carry `allocationToken`, so a commit can be tied to the
allocation that owned the generation rather than merely to a number.

### Unauthenticated text is IGNORED, not fatal

This is the single most important behavioural decision in the card.

Treating a bad line as corruption would hand the Agent a **denial primitive**:
append one junk line, and every legitimate commit fails closed forever. That is
exactly the `C1:legit-commit-still-succeeds = FAIL` finding. So:

* a line that does not parse, does not authenticate, or does not carry a known
  type is **not evidence** — it is skipped and counted;
* a signed record for another session is legitimate (one file serves a root) and
  is filtered, not called corruption;
* a file that cannot be READ is `UNREADABLE`, and the gate fails closed — the
  difference between "nothing was asserted" and "the assertion cannot be read".

### One ledger file per controller root

The filename moved from `<stateDir>/<sessionId>.jsonl` to
`<stateDir>/ledger.jsonl`. The reason is mechanical: the controller must open the
descriptor **before** the child starts, so it cannot know the session id when it
names the file. Session identity is a record field, so readers filter by
`sessionId` exactly as before. Every reader in the repository was updated.

### The lock moved

`withLedgerLock` accepts a `lockDir`. Under a governed launch the ledger
directory is write-denied, and a lock is created **by path** — so the controller
provisions `<root>/locks` and the ledger bytes stay unreachable. Exclusivity,
crash-reclaim and reentrancy are unchanged.

### `probeLedgerForCommit`

The probe now verifies the MAC of every record before it counts, and pins
`runtimeInstanceId` and `allocationToken` when supplied. A fresh controller (one
that never launched the runtime) reads the key from its own root — the root is
its secret, and `probeLedgerForCommit` derives the path from `stateDir` rather
than accepting a key as an argument.

---

## R4-C — Deployed code integrity

### The defect

The admission card measured that the Agent could append a byte to the deployed
extension. The startup hash check **detects** this on the next launch, which
converts the attack into a denial of service rather than preventing it.

### The repair

`buildLaunchSandbox` wraps the governed launch in an OS sandbox (`sandbox-exec`
on darwin) that denies, **for the whole process tree**:

* `file-write*` on the extension entry, its `lib/` siblings, and any additional
  attested extension;
* `file-write*` on the state directory and the ledger path;
* `file-read*` on the ledger key;
* and then re-allows `file-write*` on the lock directory (last-match-wins).

Measured: descendants are denied identically; a nested `sandbox-exec` cannot
widen the policy (`sandbox_apply: Operation not permitted`); the allowed lock
directory still works.

The hash attestation stays. It is now the **second** line of defence rather than
the only one.

**Honest reporting.** On a platform without a usable sandbox,
`buildLaunchSandbox` returns `ok:false` and the launch result carries
`sandbox: { active: false, reason }`. The launch is not silently described as
isolated when it is not.

**Post-spawn identity.** `sandbox-exec` execs in place, so the child's executable
is briefly the wrapper. The identity check became a bounded poll that accepts the
attested path or the wrapper mid-exec and treats any third value as substitution —
it never accepts "could not tell".

---

## Files

| File | Change |
|---|---|
| `integrations/omp/extensions/lib/ledger-auth.mjs` | **new** — record MAC, key-from-fd, `O_CLOEXEC` re-open |
| `integrations/omp/extensions/lib/controller-capability.mjs` | **new** — install/read/clear the capability |
| `integrations/omp/extensions/lib/runtime-identity.mjs` | authenticated `readLedger`, signed `appendRecord` via fd, identity-aware `commitRecordState`, `allocationToken` on commits, `lockDir` |
| `integrations/omp/extensions/lib/ledger-lock.mjs` | `lockDir` support |
| `integrations/omp/extensions/no-poll-waits.js` | capability replaces the env marker; `controllerCapabilityState`; token threaded into the advance |
| `src/control-plane/controller-client.mjs` | capability provisioning, ledger+key descriptors, launch sandbox, authenticated probe, `prepareControllerRoot` gains `lockDir`/`ledgerPath`/`ledgerKeyPath` |
| `scripts/omp-integration/lib.mjs` | the two new modules added to `KNOWN_FILES` |
| `scripts/omp-controller-ledger-worker.mjs` | installs a capability from the root; one ledger file |
| `scripts/omp-rpc-controller-r3-suite.mjs` | ledger path + session filter |
| acceptance + host tests | authority sites converted to capabilities; ledger fixtures signed; one-file-per-root filters |

Nothing in this card changes `R1`, `R2`, `R3` or `R5` semantics. Every change
above is downstream of "authority is a capability" and "a record must be
authenticated".
