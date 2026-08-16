# Checkpoint 2026-08-09 — Agent and Runtime Execution Surfaces

## Route inventory

| Route | Wiring/status | Wrong-cwd or authority risk | Disposition |
|---|---|---|---|
| `npm run pi:autoloop` → `scripts/pi-autoloop.sh` | Opt-in launcher; pins `/Volumes/NVM2T/Development/autoloop`, then `exec pi --approve` | Cwd pinned, but Pi shell/tool authority remains external to repo guard | KEEP as canonical launcher; make operational default |
| Bare `pi` | Still available from any cwd | Can miss repo `AGENTS.md`, discover wrong repo, and run broad shell search | P1 operational route |
| `pia`, `DIRECT_PI`, `AUTOLOOP_LIFECYCLE` | No matching production references found | No current route evidence | UNKNOWN/NO ROUTE |
| `src/adapter/pi-rpc-adapter.mjs` | Tests/probes only; no production import found | Accepts caller `cwd`; `--no-context-files`; no OS sandbox; environment allowlist includes `HOME` | Dormant; disable/remove after consumer proof |
| `src/v2/pi-transport-adapter.mjs` | Probe/card surfaces only; no production caller found | Network transport policy is separate from AutoLoop runtime isolation | Dormant; remove if no consumer |
| Lifecycle reviewer | `src/lifecycle-runner.mjs` hard-pins reviewer `toolPolicy: { mode: "no-tools" }` | Good for this path; does not constrain dormant/direct Pi adapters | KEEP |
| Colima task runtime | `src/runtime/colima-runtime.mjs` | Explicit mounts, network none, cap drop, no-new-privileges, limits, timeout, socket not task-mounted | KEEP |
| Subagent graph | `src/subagent/subagent-graph-runner.mjs` | Repo read-only, scratch/results write, network none; durable path preferred | KEEP |

## Production wiring result

No production Pi RPC caller was found in bounded `src` search. Production execution uses Colima/subagent/durable adapters, but direct raw runner/script paths remain. `runAdmittedGraph` is not a repository-wide choke point. Pi files are bootstrap, probe, or dormant integration surfaces. Do not report Pi RPC as production-enforced.

## P0 — Destructive scratch cleanup

`runColimaGraph` accepts arbitrary non-empty `scratchRoot`, passes it into the Colima mount at `src/runtime/colima-graph-runner.mjs:252`, then recursively removes that exact caller-supplied path at `:556`. No canonical run-scoped child or symlink containment check exists before deletion. Static risk is sufficient for P0 safety HOLD; no runtime invocation performed.

## Scope and timeout facts

- Colima task default timeout: 60,000 ms.
- Subagent graph default timeout: 90,000 ms.
- Pi transport frozen timeout: 120,000 ms.
- Runtime mount policy rejects read-only sources outside explicit repo allowlist and read-write sources outside scratch root.
- VCA1 Phase 0 guard/prompt bounds review commands, but evidence explicitly says arbitrary Pi shell can bypass guard; no OS-level interception exists.

## Remaining wrong-cwd route

Bare `pi` is the clear remaining route. `scripts/pi-autoloop.sh` reduces risk only when chosen. `AGENTS.md` is guidance, not shell sandbox. A user or agent launched outside repo can still bypass repo discovery policy. This is P1 because wrong-cwd execution can change evidence scope and attribution before any graph gate sees it.

## Additional P1 runtime findings

- `cwd` and `repoPath` are independently accepted; scheduler scope uses `cwd`, mounts/worktrees use `repoPath`. Bind one canonical repository identity before Colima start.
- Generic Colima executor forwards caller `runtime.network`, `extraArgs`, and `sh -c` command authority. Production adapters must hard-pin `network=none` and reject privileged/extra Docker args.
- Timeout is not end-to-end: synchronous Colima setup/kill calls are unbounded, and verification termination does not prove process-group cleanup. Propagate one deadline through setup, task, verification, kill, and cleanup.
- Stale cleanup filters a static card label; `pkill -f colima-${profile}` can cross execution boundaries. Use execution-specific labels and validated profile ownership.
- Raw `runSubagentGraph` documents `durable:false` as test-only but does not hard-reject it; direct scripts invoke raw path. Make raw path test-only by construction.
- IR validator rejects unknown `runtime` phase fields while task-card builder carries `phase.runtime`; align schema before trusting runtime-bearing IR.
- Mount allowlist uses raw equality/prefix, no `realpath`; C3 and durable defaults can use `$HOME` roots. Require explicit authorized roots and symlink rejection.

## Shell authority

`--approve` on the canonical launcher grants Pi’s normal approval behavior; it does not turn repository policy into an OS boundary. Production safety therefore depends on Colima path and caller selection. Direct Pi RPC remains unsafe as a production seam until cwd, filesystem, and tool policy are independently enforced.

## Disposition

- KEEP: Colima isolation, subagent durable path, no-tools lifecycle reviewer, pinned launcher.
- REWORK: make launcher mandatory for AutoLoop interactive work; add a bounded preflight that rejects wrong cwd.
- DISABLE/REMOVE: dormant Pi RPC and transport adapters if consumer inventory confirms no caller.
- UNKNOWN: named aliases (`pia`, `DIRECT_PI`, etc.) have no repository evidence; do not infer external routes.
- P0: scratch-root deletion. P1: wrong-cwd, admission bypass, identity split, caller-controlled network, timeout/cleanup, and filesystem scope. No runtime reproduction performed.
