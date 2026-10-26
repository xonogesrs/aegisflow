# Residual risk disposition — the four accepted boundaries, in the deployment

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Phase:** C
**Input:** [`RESIDUAL_RISK_RECONCILIATION.md`](../../AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1/RESIDUAL_RISK_RECONCILIATION.md)
(R3 classified all eight; risks 1, 2, 7 and 8 are `ACCEPTED_WITH_BOUNDARY`).
**Question this document answers:** are those four boundaries acceptable for
*this* deployment, as measured, or not?

The R3 card proved the boundaries are where it says they are **inside a
controller-launched runtime**. This card asks a different question: what happens
when that runtime sits in the real environment, with the real OMP 18.12.3, the
real shell wiring, and an agent that has a `bash` tool.

Vocabulary, as the card defines it:

```
ACCEPTABLE_FOR_DEPLOYMENT     the boundary holds in this deployment; deploy
ACCEPTABLE_WITH_RESTRICTION   it holds only under a named, enforceable condition
BLOCKING                      it does not hold here; do not enable
UNKNOWN                       this card could not measure it
```

---

## Summary

| # | Boundary | R3 class | **Deployment class** |
|---|---|---|---|
| C1 | In-process forgery inside the launch set | ACCEPTED_WITH_BOUNDARY | **BLOCKING** |
| C2 | Ledger is per-session, not per-machine | ACCEPTED_WITH_BOUNDARY | **ACCEPTABLE_WITH_RESTRICTION** |
| C3 | Correlator ids are unique per correlator | ACCEPTED_WITH_BOUNDARY | **ACCEPTABLE_WITH_RESTRICTION** |
| C4 | A fence can land whose durable record failed | ACCEPTED_WITH_BOUNDARY | **ACCEPTABLE_WITH_RESTRICTION** |

One boundary is `BLOCKING`. The admission verdict follows from that, and from
nothing else: see §C1.

---

## C1 — In-process forgery inside the launch set — **BLOCKING**

### What R3 established

The launch surface is small, hashed and pinned: `--no-extensions` is forced,
caller argv cannot carry `-e`/`--hook`, the entry module and every `lib/` sibling
carry a SHA-256, and a governed launch refuses a tree it was not given digests
for. Nothing *outside* the attested set can forge an accepted frame.

### What this deployment adds

Three facts that R3's isolated acceptance did not have to face, each measured on
the real 18.12.3 binary with the R3 bytes installed:

**1. The controller's authority marker is inherited by the agent's tool children.**

A governed launch sets `OMP_TERMINAL_FENCE_AUTHORITY=controller-client`,
`OMP_TERMINAL_FENCE_STATE_DIR` and `OMP_CONTROLLER_RESULT_KEY_FILE` in the
child's environment. The governed agent's `bash` tool is a child of that process,
so it inherits all three. Measured from inside a governed run:

```
OMP_TERMINAL_FENCE_AUTHORITY=controller-client
OMP_TERMINAL_FENCE_STATE_DIR=/…/controller/state
```

The key file is *not* inherited usefully — the extension unlinks it at load, and
the measured `ls` of the path fails — so frame forgery through the key stays
closed. But the marker and the state directory do not.

**2. A nested `omp` started from the agent's bash obtains controller authority
and commits durably.**

With the marker and state dir inherited, a plain `omp --mode rpc` (no `-e`, no
controller, no key) that the agent started from `bash` accepted
`/fence-generation PASS` and wrote a durable commit record:

```
allocate:1  <nested runtime>   commit:1  <nested runtime>   allocate:2
```

That is not a forged frame — it is a real governed commit by a process the agent
chose to start. `commitFence`'s correlator and the extension's target checks
both work exactly as designed; they simply are not in the path, because the
nested process is its own runtime with its own session and its own key.

**3. The ledger is a same-uid file, and a same-uid write is believed.**

The state directory is `0700` and the ledger is `0600`, owned by the invoking
user. The governed agent runs as that user. Writing one correctly-shaped line
into the ledger is therefore a permitted operation, and the controller believes
it:

| Step | Result |
|---|---|
| `probeLedgerForCommit` before any commit | `NOT_COMMITTED` |
| the agent's `bash` appends `{"type":"commit", …generation:1…}` | `appended` |
| `probeLedgerForCommit` after | **`COMMITTED`** |
| the controller's own legitimate commit | **`DENIED / GENERATION_ALREADY_COMMITTED`** |

The consequence is worse than a false positive, and it has two independent
halves, both measured:

* **The probe believes it when it names the right runtime.** `probeLedgerForCommit`
  requires the record's `runtimeInstanceId` to match the caller's — a real check —
  but the ledger's own `allocate` line contains that id in plaintext, so an agent
  that can read the ledger can copy it. Measured with the copied id:
  `C1:forged-record-not-believed = FAIL`, probe answers `COMMITTED`.
* **The commit gate believes it regardless.** `commitRecordState` matches a commit
  record on **type, generation and session only** — it does not check the runtime
  instance, the request id or the allocation token. Measured with a deliberately
  wrong runtime id: the probe correctly answers `UNKNOWN`, and the extension
  still refuses the controller's own commit with
  `DENIED / GENERATION_ALREADY_COMMITTED` (`C1:legit-commit-still-succeeds = FAIL`).
  The run cannot be closed out, and its final report cannot be released.

So a forged line either produces a false durable success or a permanent denial of
closeout, depending only on whether the agent bothered to copy an id it can read.

The same permission reaches the loaded module itself: appending a byte to
`~/.omp/agent/extensions/no-poll-waits.js` succeeds (`C1:agent-cannot-modify-
loaded-module = FAIL`). That particular attack is *detected* on the next
governed launch (`EXTENSION_HASH_MISMATCH`), which is a real defence — but it
detects, it does not prevent, and it converts the attack into a denial of
service for the next governed run.

**4. Discovery is a live load path in every non-governed start.**

Dropping `zz-dropped.js` into `~/.omp/agent/extensions` and starting an ordinary
`omp` executes it (`C1:ordinary-start-loads-dropped-module = PASS`, i.e. the
module ran). A governed launch ignores it (`--no-extensions` is forced:
`C1:governed-launch-ignores-dropped-module = PASS`). So the two trust domains are
genuinely different — but the deployment runs both, on the same directory, under
the same uid.

### Why this is BLOCKING and not a restriction

A restriction would have to be enforceable. The candidate restrictions are:

| Candidate | Why it does not hold |
|---|---|
| "the agent must not spawn `omp`" | the agent has `bash` and the pilot's own prompt-level fences are advisory; nothing in the extension blocks re-invocation |
| "the agent must not write the state dir" | the state dir is `0700` for the *user*, and the agent **is** that user; file permissions cannot separate them |
| "the ledger is integrity-protected" | it is plain JSONL with no MAC, no per-record signature and no token check on the commit record |
| "`--no-extensions` protects the load path" | true for governed launches only; ordinary starts still discover, and the deployment runs ordinary starts |

The boundary R3 states — "a module inside the attested set is inside the TCB by
construction and is not defended against" — is honest, but it is not the whole
boundary here. In this deployment the TCB's *durable state* is also writable by
the party the TCB exists to constrain. That is a different and larger claim than
the one R3 made, and it is not acceptable for a production closeout authority.

**Minimal repairs that would move this to ACCEPTABLE_WITH_RESTRICTION** (not
performed; the card forbids production mutation and this is a new card's work):

1. **Bind the commit record to its allocation.** `commitRecordState` should match
   on `(generation, runtimeInstanceId, allocationToken)` — the ledger already
   contains all three. A record the agent appends would then not close the
   generation, because it cannot know the token without reading the ledger's
   allocation line… which it can. So this alone is insufficient; it must be
   paired with (2).
2. **Authenticate the ledger.** Either an HMAC per record under a key the agent
   cannot read, or move the ledger outside any path the agent can write. The
   first is the R3 result-frame key applied to the ledger; the second is a uid
   boundary (a separate account or a root-owned directory).
3. **Do not hand the marker to the child.** Provision authority per command, not
   per process environment — e.g. a unix socket the controller listens on, where
   the *controller* performs the commit. The nested-process escape disappears
   because the marker no longer exists in the agent's environment.

Until at least (2) and (3) exist, a governed run's durable closeout is not
protected from the run's own agent.

---

## C2 — Per-session ledger — **ACCEPTABLE_WITH_RESTRICTION**

### Measured

| Topology | Result |
|---|---|
| Two controllers, **two** state dirs, one session | both bind generation 1; **both commit successfully** (`C2:separate-state-dirs-cannot-double-commit = FAIL`) |
| Two controllers, **one** state dir, one session | distinct generations (1 and 2); each commits its own; a re-commit of the closed generation is `DENIED / TARGET_GENERATION_MISMATCH` |
| Six processes, one generation, three rounds | exactly one winner, exactly one record every round (`LEDGER_EXCLUSIVITY = PASS`) |
| Lock on both local volumes (APFS) | acquires and releases correctly |

So exclusivity is real **within one ledger file**, and absent **across ledger
files**. The R3 reconciliation says this ("One host per state directory"); what
this card adds is that the deployment topology can accidentally violate it,
because `prepareControllerRoot` creates a fresh directory per controller root and
nothing warns when two roots serve one session.

### The restriction

```
R-C2.1  Exactly one state directory per session id.
R-C2.2  Exactly one live controller per session at a time.
R-C2.3  The state directory is on a local filesystem on the same host as the runtime.
R-C2.4  If a second controller must exist, it uses the SAME directory and the
        same session; it does not get its own.
```

R-C2.1 and R-C2.2 are operator procedure, not code. They are checkable before a
run (one directory, one controller pid) and they are violated by exactly the
configuration the rehearsal measured as broken. A deployment that cannot promise
them has no double-commit protection.

`R-C2.3` is required because the lock's foreign-host path refuses rather than
coordinates; a network share converts a concurrency bug into a liveness bug.

---

## C3 — Per-correlator request ids — **ACCEPTABLE_WITH_RESTRICTION**

### Measured

| Probe | Result |
|---|---|
| Frame from launch A accepted by launch B's correlator | refused, `MAC_MISMATCH` |
| Accepted frame replayed into its own correlator | refused, `DUPLICATE_RESULT` |
| Keys per launch | distinct (`result.<pid>.<nonce>.key`, unlinked at load) |
| Key file after load | absent from disk |
| Restart after a crash | fresh key, fresh correlator; a closed generation is not re-committed |

Per-launch key material and single-use request ids do what the R3 document says.
The boundary is real.

### The restriction

```
R-C3.1  A controller instance is single-use: one launch, one correlator, one key.
R-C3.2  Concurrent controller instances are limited to one per session (this is
        R-C2.2, restated because C3's guarantee is per launch, not global).
R-C3.3  A crashed controller is reconciled from the ledger; it is never resumed
        with its old key.
```

The client already enforces R-C3.1 and R-C3.3 by construction. R-C3.2 is the
deployment's job.

---

## C4 — Non-durable fence state — **ACCEPTABLE_WITH_RESTRICTION**

### Measured — what is durable, what is not

| State | Durable? | Evidence |
|---|---|---|
| allocation `(session, runtime, generation)` | **yes** — fsynced JSONL line | ledger content after commit |
| commit record | **yes** | `commit:1` present after the runtime exited |
| next-generation claim | **yes** | `allocate:2` written in the same transaction |
| in-memory `fenced` set, job bindings, barrier counters | **no** — process memory only | not present in the ledger |
| which jobs were suppressed | **no** | only counts appear in the frame, not in the ledger |
| the frame itself (the report) | **no** — stdout only | a lost frame leaves `UNKNOWN`/`COMMITTED_UNCONFIRMED` |

### Crash reconciliation, measured

Killing the controller mid-commit (SIGKILL after the frame was written) leaves the
ledger as the only witness:

```
durable: COMMITTED   records: allocate:1, commit:1, allocate:2
probe after restart: COMMITTED   (matches the ledger)
```

A fresh controller does not invent a success the ledger lacks, and does not
re-commit the closed generation.

### The restriction

```
R-C4.1  A fence's durable truth is the ledger. A frame is a report about it.
R-C4.2  After any crash, the outcome is whatever the ledger says; if the ledger
        is unreadable, the outcome is UNKNOWN and no retry is issued.
R-C4.3  A new run is a NEW controlled closeout (new generation). An old
        generation is never resumed.
R-C4.4  Suppressed-job identity is not recoverable. A crash loses it, and the
        operator must not claim otherwise in a closeout record.
```

R-C4.2 and R-C4.4 are the honest floor and they are what the client already does.
The restriction is that the *closeout paperwork* must not overstate them.

---

## What this disposition does not decide

It does not approve activation. `PRODUCTION_ENABLEMENT = false`,
`OWNER_ACTIVATION_AUTHORIZATION = NOT_GRANTED`, `GDR_1_APPROVED = false`.

It does not modify the R3 code. Every repair named under C1 is a *proposal* for a
separately authorized card; none was implemented here, and none may be
implemented by editing the deployed extension in place.
