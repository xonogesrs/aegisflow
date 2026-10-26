# INSTALLATION_CHANGE_MANIFEST

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Time window:** 2026-10-19 11:03–11:20 UTC
**Principle:** every mutation is listed. Anything not listed here was not changed.

## 1. Complete list of changes to this machine

### 1.1 A1 deployment closeout (EKM extension)

| # | Path | Action | Before | After |
|---|---|---|---|---|
| 1 | `~/.omp/agent/extensions/cbm-query.js` | replaced (temp+rename) | sha256 `9d56cffa…f117` | sha256 `03c08f43…b75e` (= repo source, byte-identical) |
| 2 | `~/.omp/agent/omp-integration-backups/2026-10-19T11-04-18-632Z-ekm-single/cbm-query.js` | created (backup) | — | sha256 `9d56cffa…f117` |
| 3 | `~/.omp/agent/deploy-evidence/2026-10-19T11-03-45Z/` | created (evidence only) | — | baseline hashes, config copies |

No other extension file changed — before/after sha256 of `no-poll-waits.js`,
`orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`, `lib/poll-wait-policy.js`, and
the four files under `extensions/test/` are identical (`evidence/extensions-sha256-before.txt` vs
`-after.txt`).

### 1.2 CBM installation (binary only, no installer)

| # | Path | Action | Size |
|---|---|---|---|
| 4 | `~/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp` | created (copy of verified release member) | 334,786,400 B, sha256 `a36cfa1f…601e` |
| 5 | `~/.local/opt/codebase-memory-mcp/0.12.1/LICENSE` | created (MIT) | 1,107 B |
| 6 | `~/.local/opt/codebase-memory-mcp/0.12.1/THIRD_PARTY_NOTICES.md` | created | 690,430 B |
| 7 | `/Volumes/NVM2T/cbm/` , `/Volumes/NVM2T/cbm/cache/` | created, `0700` | — |
| 8 | `/Volumes/NVM2T/cbm/cache/_config.db` | created by CBM (`config set`) | 24,576 B |
| 9 | `/Volumes/NVM2T/cbm/cache/Volumes-NVM2T-Development-repos-autoloop.db` | created by index | 49,348,608 B |
| 10 | `/Volumes/NVM2T/cbm/cache/private-tmp-aegis-work.db` | created by index | 42,401,792 B |
| 11 | `/Volumes/NVM2T/cbm/cache/activity.db` | created by CBM | 102,400 B |
| 12 | `/Volumes/NVM2T/cbm/cache/logs/cbm-daemon.log` | created by CBM | ~15 B… 15 KB |
| 13 | `/private/tmp/cbm-daemon-501/` | created transiently by CBM (rendezvous), daemon stopped | — |

Runtime settings written via CBM's own `config set` (rows in `_config.db`):

```
auto_index=false  auto_watch=false  watcher_enabled=false  ui_enabled=false  doc_candidates=auto
```

Rationale: no background reindexing, no watcher thread, no project auto-registration on connect, no
loopback HTTP UI. This is strictly *less* machinery than the upstream defaults.

### 1.3 OMP MCP registration

| # | Path | Action | Before | After |
|---|---|---|---|---|
| 14 | `~/.omp/agent/mcp.json` | one server added | sha256 `0177341c…e89a`, servers `[kicad]` | sha256 `032839c1…67d4`, servers `[kicad, codebase-memory]` |

The JSON writer also reflowed `kicad.args` from a single line to a multi-line array. Semantic content
is unchanged (`["\$HOME/MCP/KiCad-MCP-Server/dist/index.js"]`). Pre-change copy retained
at `~/.omp/agent/deploy-evidence/2026-10-19T11-03-45Z/mcp.json.pre-cbm`.

### 1.4 Repository (this card's durable record)

| # | Path | Action |
|---|---|---|
| 15 | `docs/audit/AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1/**` | created (this documentation set) |

## 2. Explicitly NOT changed

| Surface | Evidence |
|---|---|
| OMP binary | sha256 `fa41b27d…4bac5` before and after; version `omp/18.12.1` both times |
| OMP source / reinstall / upgrade | not performed |
| `~/.omp/agent/config.yml` | sha256 `108ca03c…8d66` before and after |
| `~/.omp/agent/models.yml*` | not opened for write |
| OMP tool dispatcher, system prompt, agent definitions | not touched |
| `~/.omp/agent/skills/` | not created (upstream installer would have added `codebase-memory/SKILL.md`) |
| `~/.omp/agent/agents/` | not created (upstream installer would have added 3 agent `.md` files) |
| `~/.omp/agent/extensions/no-poll-waits.js` | unchanged (intentionally — installer would have rewritten it) |
| `~/.profile` | unchanged (installer would have appended a PATH export) |
| `~/.zshrc`, `~/.zshenv`, `~/.zprofile` | unchanged |
| EKM store `~/.autoloop/memory/*` | no write; mtimes still 2026-08-16 / 10-18 |
| AegisFlow worktrees | `git status --porcelain` empty in both, before and after |
| AuraCore / DAC repositories | never referenced |
| Evolution / Jev / Terminal Fence configs | not touched |
| Other MCP servers (kicad) | definition and runtime unchanged |
| Running OMP sessions (pid 51649, 85927) | no signal sent; still running |

## 3. Upstream installer: examined, not executed

`codebase-memory-mcp install --dry-run --clients=omp` would have written:

```
mcp:   ~/.omp/agent/mcp.json
skill: ~/.omp/agent/skills/codebase-memory/SKILL.md      (1 skill)
agent: ~/.omp/agent/agents/codebase-memory-scout.md
agent: ~/.omp/agent/agents/codebase-memory.md
agent: ~/.omp/agent/agents/codebase-memory-auditor.md
PATH:  ~/.profile
```

and `install --dry-run --skip-config --dir=…` **still** reported the `~/.profile` PATH edit, i.e.
`--skip-config` did not fully suppress out-of-scope writes in this build. Per card §4.6 ("no one-click
installer that modifies all agent settings") and §2 ("prefer official install/config; do not expand
architecture"), the official **binary** was installed by extracting the verified archive member and the
MCP entry was written by hand in the documented schema. No agent definitions, skills, hooks, or PATH
entries were introduced.

## 4. Reproduction of the deployed state

```bash
# 1. fetch + verify
curl -fSLO https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/checksums.txt
curl -fSLO https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/codebase-memory-mcp-darwin-arm64.tar.gz
grep 'darwin-arm64.tar.gz' checksums.txt | shasum -a 256 -c -

# 2. place binary (no installer)
mkdir -p ~/.local/opt/codebase-memory-mcp/0.12.1/bin
tar xzf codebase-memory-mcp-darwin-arm64.tar.gz -C /tmp/cbm-x
cp /tmp/cbm-x/codebase-memory-mcp ~/.local/opt/codebase-memory-mcp/0.12.1/bin/
cp /tmp/cbm-x/LICENSE /tmp/cbm-x/THIRD_PARTY_NOTICES.md ~/.local/opt/codebase-memory-mcp/0.12.1/

# 3. cache root OUTSIDE $HOME (see §5), conservative runtime config
mkdir -p /Volumes/NVM2T/cbm/cache && chmod 700 /Volumes/NVM2T/cbm /Volumes/NVM2T/cbm/cache
export CBM_CACHE_DIR=/Volumes/NVM2T/cbm/cache
B=~/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp
$B config set auto_index false
$B config set auto_watch false
$B config set watcher_enabled false
$B config set ui_enabled false

# 4. index (per repository, no watcher)
$B cli --json index_repository '{"repo_path":"/Volumes/NVM2T/Development/repos/autoloop","mode":"full"}'

# 5. register (add to ~/.omp/agent/mcp.json mcpServers)
#    command  = $B
#    env      = { "CBM_CACHE_DIR": "/Volumes/NVM2T/cbm/cache", "CBM_LOG_LEVEL": "warn" }
#    type     = "stdio", timeout = 120000, args = []
```

## 5. Environment constraint an operator must know

`CBM_CACHE_DIR` **cannot** be under `$HOME` on this machine. CBM validates every ancestor of the cache
root: owned by the user or root, not world-writable, and **no allow-ACL**. `$HOME` carries
`1: user:auracore-broker allow search`, so every `$HOME/...` cache path fails with
`codebase-memory-mcp: could not load saved runtime settings` (and, with an explicit runtime dir,
with `secure CLI coordination could not be created`).

| Path tried | Result |
|---|---|
| `~/.cache/codebase-memory-mcp` | fails |
| `~/.cbm/cache`, `~/cbmfoo`, `~/.local/cbmfoo` | fail |
| `/tmp/cbm-cache-test`, `/tmp/cbmfoo2` | works |
| `/Volumes/NVM2T/...` | works (chosen) |

`/Volumes/NVM2T` is APFS on local disk (`/dev/disk7s1`), not a network filesystem, which CBM requires
for SQLite WAL. `CBM_RUNTIME_DIR` was left at its default (`/private/tmp/cbm-daemon-501`); relocating
it under `$HOME` hits the same rule.
