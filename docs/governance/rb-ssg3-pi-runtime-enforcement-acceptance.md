# RB-SSG3 — Pi Runtime Enforcement Acceptance + Deployment Convergence

> **SUPERSEDED by RB-SSG4-RC1 + RB-SSG4-FR4.** Historical record. The
> authoritative post-FR4 deployment-convergence chain is
> `scripts/deploy-rb-ssg-governor.sh` + `test-rb-ssg-vendor-integrity.mjs`
> (now covering the installed `~/.pi` copy, not only repo↔repo).

Status: **RB_SSG3_PI_RUNTIME_SEARCH_ENFORCEMENT_AND_DEPLOYMENT_CONVERGED** (RB-SSG3 changes uncommitted; review boundary).

## Closeout truth

| Item | Value |
|---|---|
| AutoLoop repo revision | `b6a600828ea03e6f243db2ca7d3107ad09db9235` (branch `governance/reversible-lifecycle-draft-pr`) |
| Installed extension | `~/.pi/agent/extensions/search-scope-governor/index.ts` |
| Installed extension SHA256 | `d1c3210eebe5c9db0af6840008b58268647b44a0731dd5937d060cb097097541` |
| Installed governor artifact | `~/.pi/agent/extensions/search-scope-governor/vendor/search-scope-governor.mjs` (sha256 `0382974eccc55c9c7c5211aca2b3a7aef7f43adfe4d627c2953e3fe877228026`) |
| Installed admission bridge | `~/.pi/agent/extensions/search-scope-governor/vendor/pi-command-admission.mjs` (sha256 `cfaf77fbdb3d0e079ba981da0d6bb89f0a0ce1f1a5777f578177ed304b6cdb6b`) |
| effective AUTOLOOP_SRC | unset (bundled vendor is authoritative; env override is dev-only) |
| effective cwd (BLOCK) | `/Users/zhengfengqing` |
| effective cwd (ADMIT) | `/Volumes/NVM2T/Development/autoloop` |
| Source-of-record | AutoLoop repo `pi-extensions/search-scope-governor/` (git-versioned) |

## Phase A — Live runtime acceptance (real Pi processes, not node unit tests)

Acceptance was collected by driving **fresh** `pi --mode rpc --no-session` processes
that auto-discover the installed global extension.

### BLOCK — LLM-issued bash tool call (`tool_call` seam)

The LLM emitted a real `bash` tool call with the exact incident command:

```json
{"name":"bash","arguments":{"command":"cd /Users/zhengfengqing && grep -rl \"Phase R\" ."}}
```

Pi then emitted:

```json
{"type":"tool_execution_start","toolName":"bash","args":{"command":"cd /Users/zhengfengqing && grep -rl \"Phase R\" ."}}
{"type":"tool_execution_end","toolName":"bash",
 "result":{"content":[{"type":"text","text":"search_scope_governor:UNBOUNDED_HOME_TRAVERSAL:unbounded traversal from /Users/zhengfengqing: home directory"}],
 "details":{},"terminate":true},"isError":true}
```

Proof points:
- The rejection reason/classification (`UNBOUNDED_HOME_TRAVERSAL`) is preserved.
- `terminate: true` + `isError: true` — the tool was blocked, not executed.
- No `grep` output and no traversal side effect (turn completed in ~1.5 s).

### BLOCK — `user_bash` seam (RPC `bash` command)

`{"type":"bash","command":"cd /Users/zhengfengqing && grep -rl \"Phase R\" ."}` (cwd=HOME) →

```json
{"success":true,"data":{"output":"BLOCKED search_scope_governor:UNBOUNDED_HOME_TRAVERSAL:unbounded traversal from /Users/zhengfengqing: home directory","exitCode":1,"cancelled":false,"truncated":false}}
```

The `BLOCKED …` output is produced by the extension's `user_bash` handler and is
returned **without** `executeBash()` — no `child_process.spawn`, no traversal.

### ADMIT — non-search command

`ls -la ~/.pi/agent/extensions/search-scope-governor` → real `ls` output, `exitCode: 0` (spawned normally).

### ADMIT — bounded repo-root recursive search

`grep -rl "governPiCommand" /Volumes/NVM2T/Development/autoloop/src/admission` (cwd=repo) →
real `grep` output (`.../src/admission/pi-command-admission.mjs`), `exitCode: 0` (spawned normally).

## Phase B — Persistence across fresh processes

Both BLOCK and ADMIT cases ran in **fresh** Pi processes with no manual
reinstallation or ad-hoc patching — enforcement is load-time, not session state.

## Phase C — Deployment convergence

The installed extension is now self-contained and no longer depends on the
mutable dev volume:

- `~/.pi/agent/extensions/search-scope-governor/vendor/` bundles byte-identical
  copies of `src/admission/search-scope-governor.mjs` and
  `src/admission/pi-command-admission.mjs` (verified sha256-equal to the repo).
- `test/admission/test-rb-ssg-vendor-integrity.mjs` pins this equality (drift fails CI).
- Resolution order: bundled vendor → optional `AUTOLOOP_SRC` dev override →
  fail-closed block for search-looking commands if the governor is unloadable.
- Superseded: `~/.pi/agent/extensions/search-scope-governor.ts` (single-file,
  AUTOLOOP_SRC-dependent) was removed; repo file superseded by the directory form.

## Phase D — Regression

- `npm run test:rb-ssg` → **56/56 pass**
- `test/admission/test-rb-ssg-vendor-integrity.mjs` → **3/3 pass**
- `node --test test/admission/*.mjs` → **135/135 pass**

## Open item for the next review boundary

RB-SSG3 changes are in the working tree (uncommitted):
- `pi-extensions/search-scope-governor.ts` → deleted (superseded by directory)
- `pi-extensions/search-scope-governor/` → new bundled extension
- `test/admission/test-rb-ssg-vendor-integrity.mjs` → new

A scoped RB-SSG3 commit (deployment-convergence only) is the remaining step to
make the bundled directory form the committed source-of-record. Not committed /
pushed / sealed.
