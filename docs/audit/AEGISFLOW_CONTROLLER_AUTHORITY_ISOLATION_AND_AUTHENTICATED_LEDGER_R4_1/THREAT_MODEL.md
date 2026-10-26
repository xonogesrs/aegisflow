# R4 — Threat model and trust boundary

**Card:** `AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1`
**Phase:** A
**Predecessor:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1` (`VERDICT = HOLD`, `C1_IN_PROCESS_FORGERY = BLOCKING`)

Every claim below is a **measurement on this host**, not a design assertion. Where
a measurement was not possible, the row says so instead of guessing.

---

## 1. The deployment's actual OS topology

| Question | Answer | How it was established |
|---|---|---|
| Do the Agent and the Controller share an OS user? | **YES.** Both are uid 501. | `ps -p <parent> -o uid=` from a child process returned `501`; the child's own `process.getuid()` is `501`. |
| Can the Agent read files the Controller reads? | **YES**, subject to mode bits. | `~/.omp/agent` is `0700` and owned by uid 501; the governed child runs as 501. |
| Can the Agent modify the deployed extension? | **YES — before this card.** | Admission card measured `C1:agent-cannot-modify-loaded-module = FAIL`; this card re-measured the write succeeding pre-repair. |
| Can the Agent read the Controller's memory? | **NO.** | `task_for_pid(mach_task_self(), parent_pid, &task)` returns `(os/kern) failure` (5). `lldb -p <parent>` and `sample <parent>` time out without attaching. The macOS hardened runtime / SIP policy blocks same-uid task ports for these binaries. |
| Can the Agent start a nested OMP? | **YES.** | It has `bash`, the `omp` binary is executable by uid 501, and the binary is on `PATH`. |
| Can a same-uid child read a parent's open file *by path*? | **YES** if mode allows — but only by path. | Not a separate boundary; included because it is what makes "the key is in a file" insufficient on its own. |

**Conclusion:** environment variables, hidden paths and module scope are NOT
boundaries here. Any design that relies on them is theatre. The only real
boundaries available are (a) OS file descriptors, (b) OS-level sandbox policy,
and (c) file permissions.

---

## 2. What each mechanism actually enforces (measured)

### 2.1 `sandbox-exec` (Seatbelt)

| Property | Result | Evidence |
|---|---|---|
| Denies a write to a denied subpath | **YES** | `Operation not permitted` |
| Applies to descendants of the sandboxed process | **YES** | a `sh -c` grandchild is denied identically |
| Denies creation of a NEW file in a denied subpath | **YES** | `evil.js` refused |
| Denies `rename` out of a denied subpath | **YES** | `mv` refused |
| Leaves unrelated paths writable | **YES** | `UNRELATED_OK` |
| Rule ordering | **last match wins** | broad `deny` then narrow `allow` on a subpath: the allowed subpath writes, its denied sibling does not |
| A descendant can WIDEN the policy by nesting `sandbox-exec` | **NO** | `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71) |
| `sandbox-exec` execs in place | **YES** — the child keeps its pid and its `comm` becomes the target binary | `ps -o comm=` on a sandboxed `/bin/sleep` reports `/bin/sleep`; on `sandbox-exec … node` reports the node path |

### 2.2 File descriptors

| Property | Result | Evidence |
|---|---|---|
| A descriptor passed as an extra `stdio` slot reaches the child | **YES** | child sees fd 3 open, writes through it |
| The same descriptor reaches an exec'd **grandchild** | **YES — this is the trap** | a Node grandchild reported `FD3_INHERITED` |
| A descriptor re-opened via `/dev/fd/N` (libuv `O_CLOEXEC`) reaches a grandchild | **NO** | grandchild reported `OWN_ABSENT` while writes through it still landed |
| A `/dev/fd/N` re-open still enforces file MODE | **YES** | after `chmod 444` on the ledger, the fd write succeeded but a fresh `open()` failed `EACCES`; after `chmod 000` the fd write is the only remaining path |
| A `/dev/fd/N` re-open BYPASSES the sandbox's path rule | **YES** | the reopened descriptor wrote to a path the sandbox denies to `open()` |

**Consequence that shaped the design.** The extension is the party that must
write the ledger, and the Agent's `bash` is its descendant. A whole-child sandbox
therefore cannot be the boundary between them: the extension would be denied its
own write. The boundary is the **descriptor**: the controller opens the ledger and
passes it, the extension re-opens it close-on-exec, and the sandbox denies the
*path* to everyone. The extension keeps writing; the Agent's `bash` has neither
the path nor the descriptor.

### 2.3 The result key, re-examined

The R5 result key is delivered as a path and unlinked at load. That remains
correct for its own purpose, and this card did not change it. It is **not**
sufficient as a ledger authority, because the ledger is a durable artefact that
outlives the process: a MAC key that exists only in memory cannot verify a record
after a crash, which is exactly when the ledger matters most. That is why the
ledger has its own per-root key with a different lifetime, delivered over a
descriptor and additionally `file-read*`-denied by the sandbox.

---

## 3. Role matrix — what each role can and cannot do

| Role | Can | Cannot (enforced by) |
|---|---|---|
| **Agent** (model + tools) | propose a fence request; run `bash`; read its own session | commit a fence (no capability); write the ledger (path denied by sandbox, no descriptor); read the ledger key (`file-read*` denied, no descriptor) |
| **Agent's `bash` child** | run ordinary commands; start a nested `omp` | inherit the ledger/key descriptors (`O_CLOEXEC`; measured `FD3_CLOSED` in real agent bash); open the ledger path (sandbox); tamper with the extension (sandbox); read the key (sandbox) |
| **Nested OMP** | run a full agent session | commit (no capability: it is a grandchild, so no descriptors, and the marker is not authority); obtain a key; write the ledger |
| **Controller** | verify requests; open the ledger; mint the capability; commit | commit without a grant; accept an unattested binary or extension; launch with an inherited marker |
| **Ledger reader** (probe) | answer "did it commit" from authenticated records | treat unsigned text as a commit; treat unsigned text as a denial |

---

## 4. Threats this card closes, and how

| Threat | Pre-repair | Post-repair | Test |
|---|---|---|---|
| Agent inherits authority via env | marker inherited → **authority** | marker never set; authority is a descriptor + key | `R4_A01` |
| Agent commits directly | reachable through the inherited marker | no capability in the agent's tree | `R4_A02` |
| Nested OMP commits | inherited marker was sufficient | grandchild has no descriptor and no key | `R4_A03` |
| Agent obtains the key | key file readable by same uid | descriptor-only + `file-read*` deny | `R4_A04` |
| Agent writes a ledger record | plain append succeeded | path denied; and unsigned records are not evidence | `R4_A05` |
| Forged record read as COMMITTED | matched on type+generation | MAC required | `R4_A06` |
| Forged record denies a real commit | `GENERATION_ALREADY_COMMITTED` | unsigned records ignored, not fatal | `R4_A07` |
| Wrong runtime/allocation accepted | identity not fully checked | full identity pinning | `R4_A08`, `R4_A09` |
| Agent edits the extension | write succeeded, detected later | sandbox denies the write | `R4_A13` |
| Agent replaces the binary | write succeeded | sandbox denies the write | `R4_A14` |

---

## 5. What this card does NOT claim

Stated plainly, because a threat model that hides its residual risk is a
misdirection:

1. **The Agent and the Controller are still the same uid.** The sandbox is a
   policy layer, not an identity boundary. The durable answer is a separate
   account for the controller, which requires an install-time change that this
   card is not authorized to make. The deployment plan carries that as the next
   step; it is not silently assumed to be done.
2. **`sandbox-exec` is macOS-only.** On another platform `buildLaunchSandbox`
   returns `ok:false` and the launch result reports `sandbox.active:false`. It
   never claims isolation it does not have. A Linux deployment needs its own
   mechanism (namespaces/seccomp) and is out of scope.
3. **The controller process itself is not sandboxed.** A caller that already runs
   inside the controller's authority can do what the controller can. That is the
   definition of the controller, not a defect — but it means the controller must
   not be run by the same untrusted party, which is deployment guidance.
4. **No key rotation.** One key per controller root. Rotation is a deployment
   concern; the design does not pretend to have solved it.
