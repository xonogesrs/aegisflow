# AEGISFLOW terminal fence controller closeout recovery 1

**Card:** `AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1`
**Disposition:** `HOLD / CONTROLLER_CLOSURE_UNAVAILABLE`
**Scope:** read-only mechanism diagnosis and isolated validation; no production mutation or terminal commit

## 1. Durable landing admission

On 2026-10-20, before this report was written, `/private/tmp/aegis-repair-1` was the clean `feat/omp-cbm-recovery` worktree. `git rev-parse HEAD`, `git rev-parse @{upstream}`, and `git ls-remote origin refs/heads/feat/omp-cbm-recovery` each returned `d217383040b531dcefd01cc36ea2db14d6e66a1c`. `git status --short`, `git stash list`, and `git log @{upstream}..HEAD --oneline` were empty. Canonical remote: `git@github.com:xonogesrs/aegisflow.git`. The separate main checkout was on `audit/omp-native-capability-dispatch-1`; it was not altered. This report adds evidence and does not modify the earlier [terminal closeout snapshot](../AEGISFLOW_EVOLUTION_LOW_RISK_HARDENING_1/TERMINAL_CLOSEOUT.md).

The established engineering baseline remains `ENGINEERING_VERDICT=PASS`, Evolution `121/121`, adversarial `17/17`, N1–N3 PASS, N4 boundary recorded. Those suites were not rerun for this controller-only card.

## 2. Controller mechanism diagnostic

The installed `~/.omp/agent/extensions/no-poll-waits.js` is `EQUIVALENT` to [published extension](../../../integrations/omp/extensions/no-poll-waits.js): `node scripts/install-omp-integration.mjs check` reported one redacted identifier difference, zero drift. Its module-local `sessions = new Map()` creates generation 1 on first access to each `sessionId`. No session-state serialization, load hook, historical terminal receipt store, or process-independent generation allocator exists in this extension. `session_start` calls `stateFor(sessionId)`; no hook restores the Map. The [integration contract](../../../integrations/omp/README.md) explicitly says waiter state is in memory and lost on process restart.

`request_terminal_fence` is an agent tool. It records an agent-request disposition and always returns `committed:false`; it does not call `fenceGeneration`. `/fence-generation` is registered with `pi.registerCommand`, reached through OMP host prompt-command entry points (interactive prompt or RPC prompt frame). Its handler resolves current `sessionId`, calls `stateFor`, and commits **current** generation only through `commitTerminalFence`. That primitive requires nonempty `OMP_TERMINAL_FENCE_AUTHORITY`. The capability must be supplied by a trusted process launcher before governed work begins; an agent shell export is not controller provisioning. `/release-final` requires a committed, fenced generation record. The automatic `agent_end` leg may fence pending deliveries as `host-agent-end`, but does not create a controller PASS terminal record.

The supported [interactive launcher](../../../scripts/pi-aegisflow.sh) only changes directory and invokes `pi --approve`; it does not provision `OMP_TERMINAL_FENCE_AUTHORITY` or supervise controller commits. The [operator contract](../../../docs/operations.md) says grant that marker only to a launcher that will actually issue `/fence-generation`. A generic RPC controller invocation is documented, but no existing AEGISFLOW launcher/Controller in this scoped repository provides it. No authorized Controller Authority was present in the original session, per the earlier closeout record and its final session messages.

## 3. Session and generation lifecycle

Original OMP session JSONL: `~/.omp/agent/sessions/-.omp-agent/2026-10-20T12-23-32-975Z_01a15944-556f-7234-beed-b21fe74fd214.jsonl`. Its session header identifies `01a15944-556f-7234-beed-b21fe74fd214`. OMP `--resume`/`--restore` reopens a saved transcript, but the extension's Map is module memory; transcript persistence does not restore its generation, request, jobs, or terminal records. A new process can present the same saved Session ID while its fresh extension state starts at generation 1. This is a namespace collision risk, not recovery.

Original runtime PID 6407 appears in `~/.omp/logs/omp.2026-10-20.6407.log`; `ps -p 6407` returned no process. A currently running `omp` PID 4905 began at 20:57:48 local, after PID 6407's 20:42–20:51 events, and is not proof of original state. `sessions` entries are never explicitly deleted within a live module, but process exit destroys the Map. Neither `waiterStateSnapshot()` nor `/fence-generation` reads historical receipts; both use current process state. The extension has no historical terminal-receipt query.

## 4. Original generation 1 evidence

| Event | Evidence | Meaning |
|---|---|---|
| `REQUEST_RECORDED` | Session JSONL tool result at `2026-10-20T12:42:47.001Z`: `status:PASS`, `generation:1`, `committed:false`, `pending:1`; PID 6407 log line 248 | Agent recommendation only. |
| `HOST_AGENT_END` | PID 6407 log line 252 at `20:43:01.987+08:00`: `generation:1`, `status:TERMINAL`, `authority:host-agent-end`, `jobIds:[bg_26]`, `suppressed:0` | Delivery fence occurred; generation advanced in that process. No PASS commit. |
| `CONTROLLER_COMMITTED` | No `terminal transition committed in order` or successful `terminal fence command` for original session in original PID log; no such tool result in its JSONL | Not observed. Cannot turn `committed:false` into `true`. |
| `HISTORICAL_RECEIPT` | No persisted receipt facility in extension; original session artifacts contain no controller PASS receipt | Absent. JSONL is transcript, not restored Extension state. |

The original session later handled another user turn, but no controller commit appeared. A second `host-agent-end` fence in PID 6407 belongs to a different Session ID and must not be attributed to this card. Original generation 1 is expired: it was fenced by `agent_end` and its process has exited.

## 5. Recovery path decision

**PATH A rejected.** Original runtime/state no longer exists. Original generation 1 already advanced after host-observed fence. `/fence-generation` has no target-session or expected-generation parameter and cannot submit historical generation 1. Resuming its JSONL would initialize a new Map at generation 1; committing then would falsely attribute a new runtime event to old generation 1.

**PATH B is factual state.** Preserve original `committed:false` and `HARDENING_BRANCH_CLOSED=false`. Existing engineering PASS and durable landing may be cited in a **new**, explicitly named Controller-supervised acceptance, without rerunning N1–N3. New acceptance needs unique closeout identity plus new OMP Session ID and generation, live Controller authority provisioned by a trusted launcher, a host-channel commit, and a recorded Controller receipt. Its receipt must name both new identity and the original uncommitted request without claiming to repair history. Existing hardening closeout contract ties branch closure to the original pending committed fence; treating a new acceptance as sufficient to close that branch changes governance and needs explicit authorization.

**PATH C is a provisioning gap for any future run.** The current `pi-aegisflow.sh` is interactive, not a Controller. A possible separate repair would add a trusted Controller-owned launcher/closeout flow, keep the marker outside agent-controlled input, commit only against a live session with explicit expected identity/generation, and persist a new receipt with provenance. This is a proposal, not an implemented or authorized flow. No environment marker was set and no Controller command was dispatched by this card.

Thus no legal, executable Controller closeout path is established for the original generation. A new closeout may become possible after Controller provisioning and governance decision. **Current verdict: HOLD.**

## 6. Validation report

`node scripts/omp-integration/run-acceptance.mjs` exited 0 using synthetic hosts and real extension/AsyncJobManager: policy `21/21`, waiter `PASS`, terminal authority `PASS`, ordering `PASS`. Authority harness showed agent request `REQUEST_ONLY`, no-capability commit `DENIED`, valid controller command committing current generation, old generation suppression, new generation preserved, and per-session job-manager lookup by matching Session ID. Ordering harness showed fence before final release, refused early/duplicate releases, and zero post-final agent invocations across 24 ordered iterations. These are isolated tests, not production commits.

A separate read-only module-reload probe used the **same synthetic Session ID** with two fresh module instances. First had one PASS request with `committed:false`; second restarted at `generation:1` with zero requests and zero terminal records. Output:

```json
{"sameSessionId":true,"oldGeneration":1,"oldRequests":1,"requestCommitted":false,"reloadedGeneration":1,"reloadedRequests":0,"reloadedTerminalRecords":0}
```

This probe demonstrates why old generation 1 cannot be inferred from a newly loaded generation 1. It does not create a historical receipt or validate a future Controller flow. Cross-session and expired-generation safety for a *new* controller process therefore remain design gates, not claimed PASS. No Evolution, adversarial, or E2 X2 Host suites were rerun.

## 7. Final disposition

```text
CARD = AEGISFLOW_TERMINAL_FENCE_CONTROLLER_CLOSEOUT_RECOVERY_1
VERDICT = HOLD
ORIGINAL_GENERATION = 1
ORIGINAL_TERMINAL_COMMITTED = false
RECOVERY_PATH = B
CONTROLLER_AUTHORITY = ABSENT
ENGINEERING_BASELINE = d217383040b531dcefd01cc36ea2db14d6e66a1c
HARDENING_BRANCH_CLOSED = false
REVIEW = PASS
DURABLE_LANDING = PASS
NEXT_ACTION = Obtain explicit governance decision for distinct new closeout; provision trusted live Controller and receipt path in a separately authorized card.
```

`CONTROLLER_AUTHORITY=ABSENT` means absent for original session and supported AEGISFLOW launcher, not absence of the generic OMP capability check. The [independent review](INDEPENDENT_REVIEW.md) passed the diagnostic report. `DURABLE_LANDING=PASS` refers only to landing these HOLD reports on the engineering branch, verified by the controller-side final response against the canonical remote; it does not change the original terminal state.
