# AUTOLOOP-V1-P3-U1 — Pi Execution Seam Restore & Protocol Compatibility — Review Bundle

**CARD_ID:** `AUTOLOOP-V1-P3-U1-PI-EXECUTION-SEAM-RESTORE-1`
**PARENT:** `AUTOLOOP-V1-P3-PROVIDER-USAGE-TELEMETRY-1`
**ENTRY_VERDICT:** `HOLD / AUTOLOOP_V1_P3_PROVIDER_USAGE_TRUTH_NOT_ESTABLISHED`
**TARGET_VERDICT:** `PASS / P3_PI_EXECUTION_SEAM_RESTORED_AND_REAL_SMOKE_VERIFIED`
**EXECUTED:** 2026-08-18 (this bundle)

---

## 1. Executive Summary

P3's only real blocker was: usage truth exists, but AutoLoop had no sanctioned
Pi execution seam to reach it. This card restored that seam and proved one real
model-backed execution through it.

- `pi` (the `@earendil-works/pi-coding-agent` CLI, bin `pi`) was **missing from
  the machine**; the repo only pins the `@earendil-works/pi-ai` *library*
  (no RPC server, bin `pi-ai`). Root cause: package installation gap, not a
  protocol regression.
- Restored: `npm install -g @earendil-works/pi-coding-agent@0.84.2` →
  `/Users/zhengfengqing/.npm-global/bin/pi`, `pi --version` = 0.84.2. The
  `pia` launcher (`exec pi --approve`) works again.
- Current generation **still officially supports the adapter's JSONL RPC
  contract** (`--mode rpc`, `agent_settled`, `get_last_assistant_text`,
  `message_end{role,stopReason,errorMessage}`) — verified against the live
  wire, not just docs. **No adapter source change needed** (RESTORE, not ADAPT).
- Credential provisioning: DeepSeek key stored in pi's own auth store
  (`~/.pi/agent/auth.json`, pi's `login()` shape) so the adapter's restricted
  child env (PATH/HOME/TMPDIR/LANG/LC_ALL/TERM, no API key) authenticates.
  Verified `ready` under that exact restricted env.
- **Real smoke PASS**: the repo's authorized `test/pi-rpc-real-smoke.mjs`
  → real adapter → real `pi` 0.84.2 → real DeepSeek `deepseek-v4-flash` →
  structured protocol events → `agent_settled` → `get_last_assistant_text` →
  completed, exact output `AUTOLOOP_PI_RPC_SMOKE_OK`, 0 tool calls, 0 session
  side effects, 0 cwd mutations.
- **Usage source reachable on the same wire** (RV-5): 29 authoritative `Usage`
  objects captured on `message_update` + `message_end` (input/output/
  cacheRead/cacheWrite/totalTokens/cost + reasoning). No telemetry wired —
  that stays in the original P3 phase.
- Negative verification N1–N6 all PASS (fail-closed missing executor, protocol
  error mapping, bounded timeout termination, nonzero-process not-PASS,
  missing-usage nonfatal, no fake usage injection).
- Source change: **1 bounded probe script only** (`scripts/pi-rpc-usage-probe.mjs`);
  zero changes to adapter/governance/telemetry/production code.
- No commit / push / PR / merge performed. Evidence hash-bound (SHA256SUMS).

## 2. Executor Reality Map (D1)

| Field | Value |
|---|---|
| EXPECTED_EXECUTOR | `pi` — `@earendil-works/pi-coding-agent` CLI (bin `pi`) |
| ACTUAL_AVAILABLE_EXECUTOR | `/Users/zhengfengqing/.npm-global/bin/pi` |
| VERSION | 0.84.2 |
| INSTALL_LOCATION | npm global prefix `/Users/zhengfengqing/.npm-global` |
| LAUNCH_METHOD | adapter spawn via PATH (`piExecutable: "pi"`); `pia` launcher (`exec pi --approve`); bare `pi` |
| STATUS | RESTORED (was missing) |

Recovery trace: `scripts/pi-autoloop.sh:29` (`exec pi --approve`),
`src/adapter/pi-rpc-adapter.mjs:147` (`piExecutable = "pi"` + `--mode rpc`
args), `scripts/deploy-rb-ssg-governor.sh` (`~/.pi/agent/extensions` install
target = pi's agent dir), npm registry (`pi-coding-agent` bin `pi`).
Full detail: `01-executor-reality-map.json`.

## 3. Protocol Compatibility Map (D2 / RV-6)

Current generation: pi-coding-agent **0.84.2**, `--mode rpc` = JSONL
stdin/stdout. (The separate CBOR `@earendil-works/pi-protocol` is for remote
sessions, not stdio RPC.)

| OLD_EXPECTATION (adapter) | CURRENT_PROTOCOL (0.84.2) | COMPATIBLE? | REQUIRED_CHANGE |
|---|---|---|---|
| spawn flags `--mode rpc --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --provider --model` | all flags present verbatim | YES | none |
| `{type:"prompt", message:string}` | same (superset: `images?`, `streamingBehavior?`) | YES | none |
| `agent_settled` event | still emitted per agent turn; observed on wire | YES | none |
| `get_last_assistant_text` command | still supported; response observed | YES | none |
| response `{command:"get_last_assistant_text", data:{text}}` | same (`data.text` may be null; adapter coalesces) | YES | none |
| `message_end{message:{role:"assistant", stopReason, errorMessage}}` | same shape; observed role=assistant stopReason=stop | YES | none |
| `message_update{message:{content, partial}}` cumulative snapshots | **CHANGED**: `{type:"message_update", usage, assistantMessageEvent}`; snapshots/`partial` removed | YES (contract-safe) | none — adapter uses message_update only for diagnostics; subtype buckets classify as "unknown" |
| `abort` / `abort_bash` | both supported | YES | none |

Full table + evidence: `02-protocol-compatibility-map.json`.

## 4. Restoration Decision (D3)

**RESTORE** — the adapter's JSONL RPC contract is still the officially
supported generation, so C1 (restore/pin the Pi executable) applies; C2
(adapter rewrite) and C3 (rebind to alternate surface) were not needed and
not done.

- Environment fix: install pi-coding-agent@0.84.2; provision DeepSeek
  credential in pi's auth store (adapter child env carries no API key).
- Repository fix: none for production code; one bounded probe/evidence script
  (`scripts/pi-rpc-usage-probe.mjs`, self-guarded by `ALLOW_REAL_PI_USAGE_PROBE`).
- Full rationale: `03-restoration-decision.json`.

## 5. Real Smoke Evidence (D4)

Command: `ALLOW_REAL_PI_SMOKE=1 node test/pi-rpc-real-smoke.mjs` (the repo's
ONE authorized real-Pi smoke; exactly 1 prompt, no retry).

```
PASS / AUTOLOOP_PI_RPC_SMOKE_OK_CONFIRMED
status_completed: PASS   output_exact: PASS   zero_tool_calls: PASS
no_new_sessions: PASS    no_removed_sessions: PASS    zero_cwd_mutations: PASS
Assistant output (trimmed): "AUTOLOOP_PI_RPC_SMOKE_OK"
Terminal reason: stop | Tool call count: 0 | Session diff: +0 / -0
```

- EXECUTOR_IDENTITY: pi 0.84.2 (PATH)
- EXECUTOR_VERSION: 0.84.2
- PROTOCOL_GENERATION: pi-coding-agent JSONL RPC (`--mode rpc`)
- PROVIDER / MODEL: deepseek / deepseek-v4-flash
- TERMINAL_RESULT: completed, exitCode 0, terminalReason `stop`, 63 events
- Evidence: `04-real-smoke/` (normalized-result.json, checks.json,
  session-diff.json, cwd inventories).

## 6. Usage Source Check (D5)

Probe: `ALLOW_REAL_PI_USAGE_PROBE=1 node scripts/pi-rpc-usage-probe.mjs`
(same spawn args + same env allowlist as the adapter; raw child stdout
recorded verbatim).

```
USAGE_PRESENT: true    STRUCTURED: true    AUTHORITATIVE: true
USAGE_SOURCE: protocol event "message_update"/"message_end" .usage
  (pi-ai Usage = AssistantMessage.usage source)
FIELDS_PRESENT: input, output, cacheRead, cacheWrite, totalTokens, cost,
  reasoning  (cost.total 0.0000812 USD on a 555-token completion)
sample_count: 29  (on the same real execution wire as the smoke)
```

- input/output/total/cache/cost: present. reasoning: **present** (this
  DeepSeek model reports a reasoning breakdown — recorded as observed, not
  fabricated; when the contract omits it the field is simply absent).
- Evidence: `05-usage-reachability/` (report.json, raw-protocol.jsonl +
  sha256). Raw log is the verbatim pi stdout — no harness-injected usage (N6).

## 7. Negative Verification (N1–N6)

| # | Check | Verdict | Evidence |
|---|---|---|---|
| N1 | Missing executor fails closed, no fake fallback | PASS | `spawn /nonexistent/pi-binary ENOENT` → status=error |
| N2 | Protocol mismatch → explicit failure | PASS | suite malformed_json / unknown-event scenarios |
| N3 | Timeout → bounded termination | PASS | suite SIGTERM→SIGKILL group escalation tests |
| N4 | Nonzero process failure ≠ PASS | PASS | suite process_disappeared scenarios |
| N5 | Missing usage nonfatal (USAGE_PRESENT false ≠ failure) | PASS | adapter contract has no usage requirement; suite completes w/o usage |
| N6 | No fake usage injection | PASS | fake fixture emits no usage; probe records real wire only |

Detail: `06-negative-verification.json`.

## 8. Tests & Verification Results

| Command | Result |
|---|---|
| `node --test test/test-pi-rpc-adapter.mjs test/test-pi-lifecycle-integration.mjs` | 68/68 pass |
| `ALLOW_REAL_PI_SMOKE=1 node test/pi-rpc-real-smoke.mjs` | PASS (all 6 checks) |
| `ALLOW_REAL_PI_USAGE_PROBE=1 node scripts/pi-rpc-usage-probe.mjs` | exit 0, usage observed |
| `node --check scripts/pi-rpc-usage-probe.mjs` | syntax OK |
| `npm run check` (src syntax) | clean |
| `git diff --check` | clean |

Full AutoLoop suite intentionally NOT rerun (card §11: no shared critical-boundary
source change; affected regression only).

## 9. Allowed-Changes Inventory

| Path | Change | Scope |
|---|---|---|
| `scripts/pi-rpc-usage-probe.mjs` | **added** — bounded usage-source reachability probe (real-smoke test / evidence tool; self-guarded) | repository |
| `docs/pi-graph-output/autoloop-v1-p3-u1/*` | **added** — this evidence bundle | repository |
| `src/**`, `test/**`, `package.json`, `package-lock.json`, governance files | **unchanged** | — |
| `/Users/zhengfengqing/.npm-global` (pi-coding-agent 0.84.2) | installed (environment) | machine |
| `~/.pi/agent/auth.json` | deepseek api_key credential provisioned (pi's own store) | machine |

## 10. Environment vs Repository Responsibility

- **Environment fix**: `pi` binary was not installed (package installation
  gap); credential was missing from pi's store for the restricted child env.
  Both fixed at the machine level — not as architecture code.
- **Repository fix**: none required. The adapter's protocol expectation is
  current-generation-compatible; the only repo addition is the bounded
  evidence probe.

## 11. PASS Gate Checklist

- [x] intended execution surface identified (`pi` = pi-coding-agent CLI)
- [x] current protocol generation identified (0.84.2 JSONL RPC)
- [x] environment/repo responsibility separated
- [x] sanctioned executable usable (`pi` 0.84.2 on PATH; launcher verified)
- [x] AutoLoop issued one real model-backed request (authorized smoke test)
- [x] structured terminal completion observed (agent_settled →
      get_last_assistant_text → response; stopReason `stop`)
- [x] authoritative usage source reachable in the same real execution (29
      samples, structured, source = pi-ai Usage)
- [x] missing/unsupported token fields remain UNAVAILABLE (nothing fabricated)
- [x] no fake/deterministic substitute used for the proof
- [x] bounded failure semantics verified (N1–N6)
- [x] no unnecessary architecture redesign (RESTORE, 0 adapter changes)
- [x] no attributable regression (68/68 adapter tests; only bounded addition)
- [x] evidence hash-bound (SHA256SUMS in this directory)
- [x] formal review bundle produced (this document)

## 12. Open Questions

- None blocking. Note: the current generation's `message_update` no longer
  carries cumulative snapshots; the adapter's diagnostic subtype buckets
  (partial/snapshot/delta) will classify as `unknown`. Metadata-only; the
  original P3 usage-capture phase should consume `message_update.usage` /
  `message_end.message.usage` directly.
- Edge noted (not a blocker): a hypothetical `success:false` on
  `get_last_assistant_text` would complete with empty stdout; the smoke
  gate's exact-output check makes this fail-safe (HOLD).

## 13. Terminal Verdict

```
PASS / P3_PI_EXECUTION_SEAM_RESTORED_AND_REAL_SMOKE_VERIFIED
```

Next (original P3 phase, unchanged by this card): usage capture →
`node.usage` → observer → aggregate → F1–F7 → one real model-backed dogfood →
P3 closeout + external review.

## 14. Evidence Hash Binding

Every file in this directory is listed in `SHA256SUMS` (sha256sum format,
computed from the files themselves). The review bundle does not hardcode the
hashes; the manifest is the single hash-bound truth.
