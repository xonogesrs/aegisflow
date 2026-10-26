# PLUGGABILITY_AND_ROLLBACK

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`

CBM is one `mcpServers` entry in one OMP user config file. Removing it is a config edit plus an
optional binary/directory removal. Nothing in AegisFlow, EKM, OMP, or the Extension layer references it.

## 1. Disable without touching the global config

OMP resolves the user MCP config through `PI_CODING_AGENT_DIR`. Point it at a copy of the agent
directory whose `mcp.json` omits `codebase-memory`:

```bash
mkdir -p /tmp/omp-no-cbm
for f in ~/.omp/agent/*; do
  b=$(basename "$f"); case "$b" in mcp.json|*.lock) continue;; esac
  ln -sfn "$f" "/tmp/omp-no-cbm/$b"
done
cp ~/.omp/agent/.env /tmp/omp-no-cbm/.env
python3 - <<'PY'
import json, os
src = os.path.expanduser("~/.omp/agent/mcp.json")
dst = "/tmp/omp-no-cbm/mcp.json"
j = json.load(open(src)); j["mcpServers"].pop("codebase-memory", None)
json.dump(j, open(dst, "w"), indent=2)
PY

PI_CODING_AGENT_DIR=/tmp/omp-no-cbm omp -p "…"
```

**Verified outcome** (`evidence/a2-pluggability-disable.txt`, `…-functional.txt`):

| Probe | Result |
|---|---|
| CBM tools present in the isolated session | `NO — no codebase_memory tool is mounted` |
| `ekm_query` available | `YES` |
| `ekm_query` executes | `state: AVAILABLE` |
| Other MCP (kicad) available | `YES — mcp__kicad_get_board_info` |
| `bash` / terminal path | `echo TERMINAL_FENCE_OK` → ran, `TERMINAL_FENCE_OK` |
| AegisFlow source changes needed to disable | none |

This is the card's required non-destructive unplug test: the **global** `~/.omp/agent/mcp.json` was
not modified for it.

## 2. Disable in the real profile (reversible, one edit)

Remove the `codebase-memory` key from `~/.omp/agent/mcp.json`, or keep the definition and add it to the
user-level denylist:

```json
{ "disabledServers": ["codebase-memory"] }
```

`disabledServers` is OMP's highest-precedence user-level switch: the server is not connected, no tools
appear, and no other server is affected. Re-enabling = delete one array element.

There is no per-card "start in a session only when needed" mode beyond this: OMP connects all enabled
stdio MCP servers at startup. CBM's own `--tool-profile=analysis|scout` flag (restricting its exposed
surface) was **not** applied — 17 tools is below any threshold that would justify it, and the card
forbids inventing extra scheduling layers.

## 3. Restore the pre-CBM state exactly

| Item | Restore action |
|---|---|
| OMP MCP config | `cp ~/.omp/agent/deploy-evidence/2026-10-19T11-03-45Z/mcp.json.pre-cbm ~/.omp/agent/mcp.json` (sha256 `0177341c…e89a`) |
| EKM extension | `cp ~/.omp/agent/omp-integration-backups/2026-10-19T11-04-18-632Z-ekm-single/cbm-query.js ~/.omp/agent/extensions/cbm-query.js` (sha256 `9d56cffa…f117`, the pre-EKM-naming bytes) |
| CBM binary | `rm -rf ~/.local/opt/codebase-memory-mcp/0.12.1` |
| CBM indexes + config | `rm -rf /Volumes/NVM2T/cbm` (87.7 MiB; contains only CBM data) |
| CBM runtime dir | `/private/tmp/cbm-daemon-501` — auto-created, self-removed with the daemon; may be deleted when no CBM process runs |
| PATH | never modified |
| `~/.profile`, `~/.zshrc`, `~/.zshenv` | never modified |
| OMP binary / config.yml | never modified |
| AegisFlow repo | never modified by CBM |
| EKM store | never written by CBM (`~/.autoloop/memory` hashes recorded in `evidence/ekm-intact.txt`) |

Rollback order: remove the MCP entry (or the denylist entry) → restart/launch a new session → verify
`ekm_query` and kicad → delete binary/cache when no CBM process is running.

## 4. Upgrade path

1. Download the new `codebase-memory-mcp-darwin-arm64.tar.gz` and the matching `checksums.txt`.
2. Verify the archive hash against the published checksum.
3. Stop all CBM clients (`codebase-memory-mcp daemon status`; no OMP session with the server running).
4. Extract into `~/.local/opt/codebase-memory-mcp/<new-version>/bin/` — **new directory, old one kept**.
5. Point `mcpServers["codebase-memory"].command` at the new path; the `env` block is unchanged.
6. `CBM_CACHE_DIR` is version-agnostic; existing indexes are opened by the new build. Mixed-version
   processes are refused by CBM's own admission barrier, which is why step 3 matters.

Because the cache root is outside the version directory, upgrading does not invalidate indexes, and
downgrading is "point `command` back at the old path".

## 5. Replaceability

The integrated surface is MCP stdio only. Any other MCP server that indexes code can be swapped in by
replacing the `codebase-memory` entry; nothing in EKM, the Extension layer, AegisFlow source, or the
OMP baseline encodes CBM's tool names, schema, or storage format. The repository does not import CBM at
runtime — no `src/` file, script, or test references `codebase-memory-mcp`.

## 6. Independence from EKM (verified, not assumed)

| Property | EKM | CBM |
|---|---|---|
| Store | `~/.autoloop/memory/` (SQLite + JSONL journal) | `/Volumes/NVM2T/cbm/cache/*.db` |
| Data model | engineering knowledge records, trust/validity, provenance | code graph (nodes/edges), no records |
| Write path | extension (`ekm_query` is read-only over an existing store) | CBM's own indexer, only on `index_repository` |
| Tool names | `ekm_query`, `cbm_query` (inactive compat) | `codebase_memory_*` |
| Failure mode | `UNAVAILABLE`/`EMPTY_MEMORY` structured answer | MCP server not connected → tools absent |
| Disabling one affects the other | no | no |

The only textual collision is the token "CBM", which EKM retains in historical identifiers
(unchanged by A1) and which this card's new upstream tool legitimately owns as a product name. Tool
namespaces do not collide, and the `AGENT_AUTONOMOUS_TOOL_SELECTION.md` transcript shows both surfaces
coexisting in one session.
