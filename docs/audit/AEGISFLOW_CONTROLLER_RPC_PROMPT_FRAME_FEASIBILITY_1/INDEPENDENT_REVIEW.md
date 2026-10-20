# Independent review

**Card:** `AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1`
**Reviewers:** four fresh OMP `openai-codex/gpt-6.1-sol` sessions that did not
author any file in this card. Read-only: `read` and `grep` only; no edits, no
Controller command, no authority provisioning, no subagents.
**Final verdict:** `REVIEW = PASS` after three `HOLD` rounds whose findings were
corrected and re-verified. Original reviewer opinions are preserved verbatim
below and were not rewritten.

---

## 1. Review sessions

| Session dir | Round | Outcome |
|---|---|---|
| `/private/tmp/aegis-rpc-review/sessions` | first pass | `REVIEW=HOLD`, 3 findings |
| `/private/tmp/aegis-rpc-review/sessions2` | corrections verified | `REVIEW=HOLD`, 1 finding not fixed + 1 new |
| `/private/tmp/aegis-rpc-review/sessions3` | second correction | `REVIEW=HOLD`, 2 remaining |
| `/private/tmp/aegis-rpc-review/sessions4` | final | `REVIEW=PASS`, `NEW=none` |

---

## 2. Round 1 — HOLD, three findings

> `REVIEW=HOLD`
> **FINDING1** — The dispatch chain is accurate (`rpc-mode.ts:1030` →
> `agent-session.ts:5325,5786-5793`), but `DIAGNOSIS.md:232-233` mislocates the
> Map and initial generation at `:173`/`:179` instead of `no-poll-waits.js:174`/`:181`,
> and `commitTerminalFence` starts at `:367`, not `:366`.
> **FINDING2** — the harness hardcodes `generationDurable:false` (`:378`),
> `notifyCorrelatableToRequest:false` (`:427`), and `adapterWaitsForAgentSettled:true`
> (`:547`), declares `GENERATION_NOT_PINNABLE` merely from a B-process fence
> (`:379`), and can report `argvAccepted:true` from absence of an "unknown flag"
> error (`:512`), contradicting its frame/log-only assertion claim (`:28-29`).
> **FINDING3** — host-issued bash probes (`:445-458`) do not establish the
> categorical agent-isolation claim (`DIAGNOSIS.md:354`), while
> `CONTROLLER_PATH_DECISION.md:5` selects PATH B and `:16` rejects it.
> `VERDICT_SUPPORTED=YES`

All three were accepted. The line citations were corrected against the source;
the hardcoded booleans were replaced with values derived from observed frames and
log records; the trust case was rewritten; and the PATH contradiction was fixed.

## 3. Round 2 — one finding not fixed, one new

> `REVIEW=HOLD`
> **FINDING1_FIXED=YES** — All six spot-checks match.
> **FINDING2_FIXED=NO** — Although `argvAccepted` now requires a ready indication
> and notify correlation compares observed IDs, `generationDurable` becomes true
> with no B fence records, `GENERATION_NOT_PINNABLE` does not require matching
> session IDs, `targetGenerationAccepted` remains hardcoded false, and
> `adapterWaitsForAgentSettled` is source-derived rather than frame/log-derived.
> **FINDING3_FIXED=YES** — T1 now drives the governed agent's bash tool through a
> real model turn with `tool_execution` events, and T2 separately exercises an
> in-process extension.
> **NEW_FINDINGS** — `DIAGNOSIS.md` §2.5 still overclaims: current T1 attempts
> only fd 0/1, not 0/1/2, and its sentinel does not establish successful writes;
> one negative probe does not prove the agent "cannot dispatch," nor support
> `FINAL_DISPOSITION.md`'s categorical "not an agent-reachable path"; unexecuted
> probes still produce false reachability booleans rather than NOT_TESTED.

Accepted in full. `generationDurable` and the result classification now return
`null`/`NOT_TESTED` when nothing was measured, and `GENERATION_NOT_PINNABLE`
requires `sameSessionId`. T1 now attempts fd 0, 1 **and** 2 with a per-fd
sentinel, so a write is proven rather than assumed. §2.5 was rewritten to claim a
measured negative instead of an impossibility, and `FINAL_DISPOSITION.md` was
narrowed to match.

## 4. Round 3 — two remaining

> `REVIEW=HOLD`
> **F1_FIXED=YES** — Probe lines 406–423 return null without generation
> measurements and require matching session IDs before `GENERATION_NOT_PINNABLE`.
> **F2_FIXED=NO** — `targetGenerationAccepted` merely detects `expectedGeneration=`
> in the logged reason; this observes free-text acceptance, not generation
> validation, and returns false when no fence was observed.
> **F3_FIXED=YES** — The source-derived adapter expectation is now paired with
> `adapterCompletionEventObservedFromRuntime` and runtime frame counts.
> **F4_FIXED=NO** — T1 attempts fd 0/1/2 with conditional per-fd sentinels and
> null gating, but T2 lines 613–628 still report false for unexecuted probes, and
> §2.5's closing "corroborates the extension's design claim" overreaches.
> `REMAINING_HARDCODED=none`

Accepted. The free-text observation was renamed to
`expectedGenerationLandedInFreeTextReason`, and validation is now
`targetGenerationValidated: null` with an explicit statement that no field exists
to test. T2's per-stream fields return `null` without a confirmed write. The
closing sentence became "consistent with the extension's design claim … for one
tool in one configuration."

## 5. Round 4 — PASS

> `REVIEW=PASS`
> **F2_FIXED=YES** — `targetGenerationValidated` is explicitly null (NOT_TESTED),
> while `expectedGenerationLandedInFreeTextReason` separately reports the
> free-text observation.
> **F4_FIXED=YES** — T2's per-stream fields return null without confirmed writes,
> its aggregate returns null when neither write occurred, and §2.5 limits
> conclusions to the measured configuration.
> `NEW=none`

---

## 6. What this review does not certify

The reviewers checked the diagnosis record, the harness's derivation discipline,
and scope compliance. They did not re-execute the probes — that is this card's
own evidence, reproducible with the commands in
[FINAL_DISPOSITION](FINAL_DISPOSITION.md) §3. A review PASS on the diagnosis is
not a controller feasibility PASS: the card's verdict remains `HOLD` on its own
measured grounds.
