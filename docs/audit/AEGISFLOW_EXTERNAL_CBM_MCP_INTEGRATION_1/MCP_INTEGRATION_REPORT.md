# MCP_INTEGRATION_REPORT

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Verdict:** PASS
**Date:** 2026-10-19

## 1. What was integrated

`codebase-memory-mcp` v0.12.1 as an **independent stdio MCP server**, registered in OMP's native
user-level MCP config. OMP's own agent decides when to call its tools; no adapter, router, prompt
injection, hook or extension was written.

```
OMP (unmodified v18.12.1)
 ├── extension: ekm_query          (EKM, unchanged, deployed from d926bbc3)
 └── MCP: codebase-memory (stdio)  (CBM v0.12.1, independent process)
        └── tools: codebase_memory_* (17)
```

The two systems share **no** code, store, schema, or lifecycle:
- EKM store: `~/.autoloop/memory/{memory.db,journal.jsonl,repository-aliases.json}`
- CBM store: `/Volumes/NVM2T/cbm/cache/*.db` (`CBM_CACHE_DIR`)

## 2. A1 deployment closeout (precondition for this card)

### 2.1 Gate re-verified before touching anything

| Check | Expected | Observed |
|---|---|---|
| Worktree HEAD | `d926bbc3` | `d926bbc3ad0416c2be854c28ec5775990890b901` |
| Branch | `feat/omp-cbm-recovery` | same |
| `origin/feat/omp-cbm-recovery` | `d926bbc3` | `d926bbc3ad0416c2be854c28ec5775990890b901` |
| `origin/main` | unchanged | `1cf1e9fa284d2407c4edbe42f525fffe12a169c2` |
| Worktree A `/Volumes/NVM2T/Development/repos/autoloop` | clean at `8bb72a5` | clean at `8bb72a5` |
| Worktree B `/private/tmp/aegis-work` | clean | clean |
| Stash | empty | empty |
| OMP binary | `omp/18.12.1` | `omp/18.12.1`, sha256 `fa41b27d…4bac5` |

### 2.2 Installer scope was checked, then not used

`node scripts/install-omp-integration.mjs install --dry-run` showed the installer would rewrite
**two** files:

```
replace   no-poll-waits.js  -> backup …/2026-10-19T11-03-04-439Z/no-poll-waits.js
replace   cbm-query.js      -> backup …/2026-10-19T11-03-04-439Z/cbm-query.js
unchanged lib/poll-wait-policy.js + 4 test files
```

The `no-poll-waits.js` difference is a single comment line — the deployed copy carries a real OMP
session id where the repository copy carries `<session-id-redacted>` (`classifyDeployment` reports
`EQUIVALENT`, not `DRIFT`). Rewriting it would have replaced a live session identifier with a
placeholder for no functional gain.

Controller's instruction (A1 step 4) is explicit: if the installer repairs more than the one file,
use the existing safe deployment path for a single file instead. That is what was done.

### 2.3 Single-file deployment

| Step | Evidence |
|---|---|
| Pre-deploy backup | `~/.omp/agent/omp-integration-backups/2026-10-19T11-04-18-632Z-ekm-single/cbm-query.js`, sha256 `9d56cffa…f117` (= the pre-deploy deployed bytes, byte-identical) |
| Pre-deploy deployed sha | `9d56cffa8502600c4e64604b26bda72bfa65af48704d6cc7a265a347d7f7f117` |
| Source sha | `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e` |
| Write method | temp-file + rename via the repository's own `writeFileAtomic` from `scripts/omp-integration/lib.mjs` |
| Post-deploy deployed sha | `03c08f43…b75e` — **byte-identical to source** |
| Other extension files | sha256 comparison before/after: only `cbm-query.js` changed. `no-poll-waits.js`, both `.ts` orca files, `lib/poll-wait-policy.js`, all four test files: unchanged |
| `config.yml` | sha256 `108ca03c…8d66` before and after — unchanged |
| `mcp.json` (at that moment) | unchanged (CBM registration is a separate, later step of this card) |

`node scripts/install-omp-integration.mjs check` after the write: `MATCH=6 EQUIVALENT=1 DRIFT=0
MISSING=0`, `ok: true`. The single `EQUIVALENT` is the redacted-session-id comment described above;
`--strict-bytes` flags it as expected, and it is not a functional difference.

### 2.4 Fresh-session verification of the deployed extension

| Probe | Result |
|---|---|
| "list memory/knowledge tools you have" (no tool call) | `ekm_query` — the only memory tool |
| "call ekm_query once" | `State: AVAILABLE` |
| "is `cbm_query` available by default?" | `NO` — "No `cbm_query` tool is mounted" |
| `--tools cbm_query,ekm_query` then ask for `cbm_query` | `AVAILABLE` (legacy alias still resolves when explicitly requested) |
| `node --test test/omp-integration/test-omp-cbm-query.mjs` | 11/11 pass |

Two pre-existing interactive OMP sessions (pid 51649, pid 85927) were left running and undisturbed;
all probes used fresh `-p --no-session` processes.

## 3. OMP baseline freeze

| Item | Value |
|---|---|
| Version | `omp/18.12.1` |
| Binary | `\$HOME/.local/bin/omp` (symlink target of `~/.bun/bin/omp`) |
| Binary SHA-256 | `fa41b27d434380e99b713e4f9ced0f73eb1fc0c409fdf23a57c119971d24bac5` |
| `config.yml` SHA-256 | `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66` (unchanged) |
| `mcp.json` before | `0177341cb04c57d7929622804c9a21bc921c3e38f6cf6ae92147ab3b0a6ce89a` |
| `mcp.json` after | `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4` |
| MCP servers before | `kicad` |
| MCP servers after | `kicad`, `codebase-memory` |
| Extensions | `cbm-query.js`, `no-poll-waits.js`, `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts` |
| OMP source modified | no |
| OMP upgraded/reinstalled | no |
| Tool dispatcher / system prompt touched | no |

The **only** OMP-side mutation of this card is one added key in `~/.omp/agent/mcp.json`. The JSON
diff also reflows `kicad.args` from one line to a multi-line array (JSON serialization of identical
data — same array, same single element).

## 4. Registration entry (exact)

```json
"codebase-memory": {
  "type": "stdio",
  "command": "\$HOME/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp",
  "args": [],
  "env": { "CBM_CACHE_DIR": "/Volumes/NVM2T/cbm/cache", "CBM_LOG_LEVEL": "warn" },
  "timeout": 120000
}
```

No API key, token, or credential appears in the command, args, or env. `CBM_LOG_LEVEL=warn` keeps
the MCP stdout channel clean (JSON-RPC only) and keeps stderr quiet.

## 5. Runtime behavior observed

- Handshake: `initialize` → protocol `2025-06-18`, `serverInfo.name = codebase-memory-mcp`,
  `version = 0.12.1`. `tools/list` → 17 tools.
- Daemon lifecycle: CBM starts a per-account coordination daemon for the duration of work and stops it
  when the last client disconnects. Observed in `logs/cbm-daemon.log`:
  `daemon.start … daemon.runtime_stopping reason=last_committed_client_disconnected … daemon.stop`.
  `daemon status` afterwards: **not running**. No standing daemon was created.
- Watcher and auto-index are **disabled** by config (`watcher_enabled=false`, `auto_index=false`,
  `auto_watch=false`), so nothing reindexes in the background and no project registration happens on
  connect.
- UI is **disabled** (`ui_enabled=false`), so no loopback HTTP listener and no model download path is
  active.

## 6. Deviations and constraints found

1. **`CBM_CACHE_DIR` cannot live under `$HOME` on this machine.** CBM validates the ancestry of the
   cache root: every ancestor must be owned by the user or root, not world-writable, and **carry no
   allow-ACL**. `$HOME` (`\$HOME`) carries
   `1: user:auracore-broker allow search`, and the check fails with the generic
   `could not load saved runtime settings` message. Verified: `$HOME/...` fails, `/tmp/...` and
   `/Volumes/NVM2T/...` succeed. The cache was therefore placed at `/Volumes/NVM2T/cbm/cache`
   (APFS local volume, not a network filesystem), owner-only (`0700`).
   `CBM_RUNTIME_DIR` cannot be relocated under `$HOME` either (same rule) and was left at its default
   `/private/tmp/cbm-daemon-501` (sticky, root-owned, accepted). Both facts are recorded in
   `INSTALLATION_CHANGE_MANIFEST.md` and `PLUGGABILITY_AND_ROLLBACK.md` so a future operator does not
   re-diagnose it.
2. **Upstream `install` subcommand was not executed.** Its `--clients=omp` dry run showed it would
   write, in addition to `mcp.json`: a skill (`~/.omp/agent/skills/codebase-memory/SKILL.md`) and
   **three agent definitions** (`agents/codebase-memory.md`, `-scout.md`, `-auditor.md`). That is
   outside the card's authorized scope ("no one-click installer that modifies all agent settings").
   The official binary + manual stdio registration path was used instead — the card's documented
   fallback.
3. **`spctl` rejects the ad-hoc-signed binary** (`rejected`) and the release notes document an
   antivirus false positive for this binary family. The archive checksum matched upstream's published
   `checksums.txt` byte-for-byte, and the artifact is an ad-hoc-signed, un-quarantined release binary;
   it executes normally on this machine. Recorded as a known supply-chain posture, not a failure.
4. **`--skip-config` is ignored when `install` is combined with a custom `--dir`** — the dry run still
   reported the PATH edit. PATH was therefore not modified; the server is registered with an absolute
   command path, so PATH is irrelevant to it. `~/.profile` was **not** touched.

## 7. Unmodified surfaces (verified)

| Surface | Check |
|---|---|
| AegisFlow repository | `git status --porcelain` clean in both worktrees before and after indexing; no `.codebase-memory/` or `*.graph.db*` written inside either worktree |
| EKM store | journal 8 events (sha256 `c5093265…2733`), `memory.db` mtime `2026-10-18 21:53`, `repository-aliases.json` mtime `2026-10-18 23:47` — no writes during this card |
| `ekm_query` | AVAILABLE in default sessions and in the CBM-disabled isolated profile |
| Existing OMP sessions | pids 51649 and 85927 still running; no signal sent |
| Evolution / Jev / Terminal Fence | not invoked, not configured, not modified |
| OMP binary / source | sha256 unchanged, no reinstall |
