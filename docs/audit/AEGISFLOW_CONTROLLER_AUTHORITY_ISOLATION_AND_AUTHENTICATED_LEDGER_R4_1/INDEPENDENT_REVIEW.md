# R4 — Independent review and its disposition

**Card:** `AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1`
**Phase:** G

**Reviewer:** a separate `reviewer` agent session, given the diff, the two new
modules, the controller client, `THREAT_MODEL.md` and the adversarial probes, with
the instruction to be adversarial and to try to refute six named claims. It was
read-only: it did not run the probes, modify files, or touch production.

**Reviewer verdict:** `HOLD` — 5 × HIGH, 2 × MEDIUM, all marked blocking for PASS.

**Disposition: all seven findings were confirmed by measurement and fixed.** The
card does not treat a reviewer HOLD as a PASS, and it does not treat its own
repairs as verified because they were written — each fix below was re-measured,
and the two that changed a test's contract say so explicitly.

---

## Findings

### 1. [HIGH] The ledger key was write-protected only against reads

**Reviewer's claim.** The profile denied `file-read*` on `ledger.key` but not
`file-write*`, so a same-uid Agent could overwrite the key with one it knows.

**Confirmed by measurement**, not argument:

```
sandbox-exec … cat ledger.key     → Operation not permitted
sandbox-exec … printf … > ledger.key → KEY_OVERWRITTEN
result: 0000000000000000000000000000000000000000000000000000000000000000
```

**Fixed.** `ledgerKeyPath` is now in the `denyWrite` list as well as `denyRead`.
Confidentiality is not integrity, and the review was right that the two are
different properties.

### 2. [HIGH] The writable lock directory was a denial primitive — and could fake a durable commit

**Reviewer's claim.** Two parts, both correct:

1. The lock directory is deliberately writable, so the Agent could create
   `ledger.jsonl.lock` containing `{}` and every legitimate commit would fail
   closed with `LEDGER_LOCK_CORRUPT`.
2. Worse: deleting the lock directory made the lock create throw *after* the fence
   had applied, and the exception branch reported `committed:true` with no
   `ledgerRecorded` field. `commitFence` only downgrades an explicit
   `ledgerRecorded === false`, so it returned `COMMITTED, durable:true` for a
   commit with no durable record.

**Confirmed by measurement:**

```
attacker creates corrupt lock: CORRUPT_LOCK_WRITTEN
legit lock attempt: {"ok":false,"code":"LEDGER_LOCK_CORRUPT","detail":"BAD_PID"}
```

**Fixed, in two places.**

* A corrupt or unreadable lock record is now **reclaimed**, not fatal. Exclusivity
  never depended on trusting the record: the winner is decided by one atomic
  `link(2)`, and a record that is not a valid record proves nothing about a
  holder — so reclaiming it is the same operation as reclaiming a provably-dead
  holder. A **symlink** is still refused, because a symlink is an attempt to
  redirect the lock rather than a malformed one. Measured: corrupt → acquired,
  lock released; symlink → `LEDGER_LOCK_SYMLINK`.
* The exception branch now always emits `ledgerRecorded: false` and a
  `ledgerError`, so an unrecorded commit can never be reported as durable.

### 3. [HIGH] The attested executable was not write-protected

**Reviewer's claim.** The deny list covered the extension trees but not
`attestation.path`, so an Agent could plant a replacement beside the running
binary and rename over it; the hash attestation is a launch-time check.

**Confirmed** by reading the deny list: it contained extension paths, the state
dir and the ledger, and nothing naming the executable.

**Fixed.** Both `attestation.path` and `dirname(attestation.path)` are denied.
Denying the directory as well as the file is what closes the rename, since the OS
refuses to write an executing image but does not refuse a rename over it. `A14`
now asserts the plant **and** the rename are denied.

### 4. [HIGH] Authority descriptors were passed even when nothing consumed them

**Reviewer's claim.** `extensionPath` is optional. A launch with no extension — or
with only `cbm-query.js` — never runs `installControllerCapabilityFromEnv()`, so
nothing closes or re-opens the descriptors close-on-exec, and the Agent's bash
would inherit a writable ledger handle and a readable key.

**Confirmed** by reading the launch: `stdio` always included both descriptors.

**Fixed.** The descriptors are handed over only when a module that revokes them is
loaded (`consumesCapability`). Without it there is no commit path at all, so there
is nothing to authorize and nothing to leak; the launch result reports
`capabilityProvisioned: false` rather than implying authority that was never
given.

### 5. [HIGH] Sandbox construction failure fell open

**Reviewer's claim.** A controller-root path containing `"` or `\` makes
`buildLaunchSandbox` throw; the catch turned that into `ok:false`, and the launch
then proceeded **without a sandbox while still supplying both authority
descriptors**.

**Confirmed** by reading the catch: it assigned `sandbox = {ok:false}` and the
spawn used the unwrapped binary.

**Fixed.** Both the throw and the honest "this platform has no sandbox" answer now
**refuse the launch** with `SANDBOX_UNAVAILABLE`. On the supported deployment
platform, no sandbox means no governed launch. Reporting `active:false` after the
fact was never a boundary.

### 6. [MEDIUM] A rejected unterminated tail swallowed the next authentic record

**Reviewer's claim.** If the ledger ends with `garbage` and no newline, the next
append concatenates onto it and both readers discard the whole line — so an
authentic commit vanished. `A07` only injected newline-terminated garbage.

**Confirmed by measurement:**

```
file: "garbage-without-newline{\"type\":\"commit\",\"generation\":1}\n"
DISCARDED: garbage-without-newline{"type":"commit","generatio
```

**Fixed.** `appendRecord` checks the last byte and prefixes a newline when the
file does not end with one. The junk stays junk (still not evidence) and the new
record is a line of its own. Measured after the fix: an allocation over a hostile
unterminated tail yields `ALLOCATED gen 1`, and a commit over the same file yields
`COMMITTED`.

### 7. [MEDIUM] The frame-forgery probe never submitted a forged frame

**Reviewer's claim.** `A15` constructed a forged frame, then sent a legitimate
identity command instead, and asserted on a field `accepted()` does not return.
The fact passed without attempting a forgery.

**Confirmed** by reading the probe.

**Fixed.** The forged frame is now handed to a real `ResultCorrelator` that is
expecting that request id — both an attacker's correlator and the controller's own
— and the rejection is the correlator's verdict. Measured: `MAC_MISMATCH`,
`accepted()` yields no result, one rejection recorded. The probe also asserts the
genuine frame is still accepted afterwards.

---

## Claims the reviewer refuted, and what changed

| Claim | Reviewer | After the fixes |
|---|---|---|
| 1. Authority is fd + key, not the marker | REFUTED (fd could be absent; custody failed) | **VERIFIED** — descriptors are gated on a consumer; `capabilityPresent()` is the only authority question |
| 2. `/dev/fd/N` prevents bash inheritance | REFUTED globally (init not required; path fallback) | **VERIFIED** on every governed launch, because a governed launch now always loads the revoking module and always has the descriptor |
| 3. Sandbox denies writes to extensions, ledger, key | REFUTED (key read-only, executable omitted, fail-open) | **VERIFIED** — all three fixed |
| 4. Unauthenticated records cannot cause denial | REFUTED (tail + lock namespace) | **VERIFIED** — both fixed |
| 5. Gate/attribution split avoids double commit | VERIFIED | unchanged |
| 6. Probe requires MAC and pins runtime + allocation | REFUTED (token never pinned in practice) | **VERIFIED** — the identity frame now publishes the allocation token and `bindIdentity` carries it, so a normal caller pins it |

## Probe limitations the reviewer listed, and their status

| Probe | Weakness | Status |
|---|---|---|
| `A02` | "attack" wrote `/fence-generation` to `/dev/null` | now also proves the Agent's stdin is not the command channel and that no frame was produced |
| `A03` | passes if the nested runtime merely failed to start | the assertion now also requires the denial text or a positive record count |
| `A09` | "correct allocation" used an identity with no token | fixed by claim 6 — `bindIdentity` now returns the token |
| `A11` | two `--no-session` sessions, not one generation | accepted: the invariant asserted is "no double commit per (session, generation)", which holds across any number of sessions |
| `A12` | restarts into a new session | assertion corrected to "no closed (session, generation) is reissued", which is the contract the ledger actually makes |
| `A13` | only attacked the discovery copy | now also attacks the attested `--extension` path |
| `A14` | never asserted the plant/rename was denied | now asserts both |
| `A10`/`A11` | MAC-shaped strings are not proof of verification | accepted as a real limitation: those facts assert *presence* of a MAC; `A06`, `A07` and the client tests assert *verification* by inverting the outcome for unsigned and wrong-key records |

## One limitation the reviewer raised that this card does NOT close

`cbm-query.js` lazily imports `<checkout>/src/memory/index.mjs` when the Agent
calls `ekm_query`, and that module is **not** in the sandbox's deny list. Code
loaded there runs inside the governed process and could import
`controller-capability.mjs` and read the installed capability.

The reviewer correctly noted this predates the patch and did not count it as a
patch-introduced finding. It is recorded here rather than dismissed:

* the deny list now covers the attested extension trees and the executable, but a
  lazy dependency resolved from the **session cwd** is a genuinely larger attack
  surface than "the extension file";
* the durable fix is the account separation named in `THREAT_MODEL.md` §5, plus
  pinning `cbm-query.js`'s dependency to an attested path.

It is **not** claimed to be closed. It is named as residual risk, and it is the
first item for the deployment plan.
