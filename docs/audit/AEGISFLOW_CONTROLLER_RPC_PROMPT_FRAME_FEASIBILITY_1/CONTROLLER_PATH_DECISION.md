# Controller path decision

**Card:** `AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1`

The card's Phase D offers three paths. The evidence does not select any of them
cleanly, and that is itself the finding: **PATH A is half-met** (the transport
works, the result contract does not), **PATH B is unavailable** (no alternative
host-command entry point exists — RPC *is* the entry point), and **PATH C's
remedy is what applies** (the channel is insufficient *as a controller channel*
until R1–R3 are done, while remaining sufficient as a dispatch transport).

---

## 1. Which path

| Path | Condition | Verdict |
|---|---|---|
| A — RPC native support | RPC prompt frame dispatches the host command, session binding correct, result verifiable | **partially met**: dispatch PASS, session binding PASS, result observability **HOLD** |
| B — RPC unsupported but another formal entry exists | another formal host-command entry point | **not available**: no such entry point exists; `RpcCommand` has no dispatch member and every probe frame type returned `Unknown command` |
| C — all channels insufficient | none meets the requirement | **applies to the controller requirement**: dispatch works, but generation binding, result observability and the client all fail |

The honest reading is: **the transport is proven, the client and the
observability are not.** That is `HOLD`, not `PASS` and not `FAIL`.

```
RPC_PROMPT_COMMAND_DISPATCH = PASS
SESSION_BINDING             = PASS
GENERATION_BINDING          = HOLD
RESULT_OBSERVABILITY        = HOLD
ALTERNATIVE_HOST_CHANNEL    = NOT_FOUND
FEASIBILITY                 = HOLD
```

---

## 2. Why this is HOLD and not PASS

Three measured facts, each independently sufficient:

1. **Generation is not pinnable** (§2.3 of [DIAGNOSIS](DIAGNOSIS.md)). One
   session id, two processes, both reporting "generation 1". A controller cannot
   state `EXPECTED_GENERATION` and have it verified, and cannot distinguish a
   fresh process's generation 1 from the original. §5/B3 of the card makes this
   a HOLD condition by name.
2. **The result is not on the wire** (§3). The RPC response carries
   `{id, type, command, success}` and nothing else. The handler's `committed`,
   `denial`, `generation` and `authority` reach a controller only through a log
   line it cannot correlate to its own request, or through a `notify` frame that
   disappears under `--no-ui` and whose `id` is generated inside the runtime.
3. **The only RPC client in this repository cannot drive it** (§4). Wrong argv
   for `omp`, no `-e`, wrong completion event.

None of the three is a defect in N1–N3. All three are prerequisites of the
*next* card.

---

## 3. Minimal repair boundary (PATH C's deliverable, applied)

The card forbids implementing a new Controller architecture here. It does ask,
when feasibility is HOLD, for the minimum repair boundary: components, permission
risk, acceptance. This section names them and implements none.

| # | Component | Change | Permission risk | Acceptance test |
|---|---|---|---|---|
| R1 | `integrations/omp/extensions/no-poll-waits.js` — generation identity | Give each runtime a durable epoch: persist `{sessionId, processEpoch, generation}` on `session_start` and restore it on resume, or include a process/epoch discriminator in the commit record. | Low: extension-local state file; no new authority. Must not let a new process *reuse* a terminal generation. | Restart a session; the second process must report a generation that cannot collide with the first process's terminal generation. |
| R2 | same file — commit result surface | Have `/fence-generation` return its result as the command's value and/or emit a structured result frame carrying `{sessionId, generation, committed, denial, authority, requestId}`. | Low: no authority change; only observability. | A controller can read `committed` and `denial` from a frame tied to its own request id, with `--no-ui`. |
| R3 | `src/adapter/pi-rpc-adapter.mjs` — or a new, separate controller client | Fix argv for the target runtime, pass the extension, and complete on the runtime's actual settled event. A **new** client is preferable to retargeting the governed-agent adapter, which is used for provider-backed subagents. | Medium: touching the adapter risks the subagent path; a new client risks duplication. | The client drives `/fence-generation` end to end and reports the R2 result. |
| R5 | the controller client (same as R3) | Correlate every frame to a request id the controller issued; reject unsolicited `response` frames. Measured necessity: in-process code can write a frame to fd 1 that the host parses as runtime output (§2.5 T2). | Low for a new client; a correctness requirement, not a hardening nicety. | A forged frame with an unknown id is rejected, not acted on. |
| R4 | `scripts/` — provisioning | A launcher that sets the marker and is the *only* thing that issues the command. | **High**: this is the authority grant itself; it is GDR-1's subject, not this card's. | Out of scope here. |

R1 and R2 are prerequisites for any Controller Provisioning card. R3 and R5 are
prerequisites to R4. R4 is GDR-1 territory and requires Owner approval.

---

## 4. What this card does not authorize

- It does not provision `OMP_TERMINAL_FENCE_AUTHORITY` anywhere outside
  throwaway harness processes.
- It does not issue a Hardening receipt.
- It does not close the branch.
- It does not approve GDR-1.
- It does not implement R1–R4.

```
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false
PRODUCTION_MUTATION           = NONE
```
