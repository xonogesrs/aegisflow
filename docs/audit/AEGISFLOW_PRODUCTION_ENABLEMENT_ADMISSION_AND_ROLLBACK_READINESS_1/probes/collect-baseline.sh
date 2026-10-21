#!/bin/bash
# Read-only production baseline collection. Touches nothing.
set -u
echo "=== COLLECTED_AT"
date -u +%Y-%m-%dT%H:%M:%SZ
echo
echo "=== OMP_EXECUTABLE"
for p in "$HOME/.local/bin/omp" "$HOME/.bun/bin/omp"; do
  [ -e "$p" ] && { echo "path=$p"; echo "realpath=$(readlink -f "$p")"; echo "sha256=$(shasum -a 256 "$(readlink -f "$p")" | cut -d' ' -f1)"; echo "version=$("$(readlink -f "$p")" --version 2>&1 | head -1)"; echo "mode=$(stat -f '%Sp %Su:%Sg' "$(readlink -f "$p")")"; }
done
echo
echo "=== NODE"
echo "node=$(command -v node) $(node --version 2>/dev/null)"
echo
echo "=== EXTENSIONS_TREE"
( cd "$HOME/.omp/agent/extensions" && find . -type f | sort | while read -r f; do echo "$(shasum -a 256 "$f" | cut -d' ' -f1)  $f"; done )
echo
echo "=== EXTENSION_DISCOVERY_SET"
( cd "$HOME/.omp/agent/extensions" && ls -1 *.js *.ts 2>/dev/null; find . -mindepth 2 -maxdepth 2 -name 'index.js' -o -mindepth 2 -maxdepth 2 -name 'index.ts' -o -mindepth 2 -maxdepth 2 -name 'package.json' 2>/dev/null )
echo
echo "=== CONFIG"
for f in config.yml models.yml mcp.json; do [ -f "$HOME/.omp/agent/$f" ] && echo "$(shasum -a 256 "$HOME/.omp/agent/$f" | cut -d' ' -f1)  $f"; done
echo
echo "=== WRITABILITY_OF_DEPLOY_PATHS"
stat -f '%Sp %Su:%Sg %N' "$HOME/.omp/agent" "$HOME/.omp/agent/extensions" "$HOME/.omp/agent/extensions/lib" 2>/dev/null
echo
echo "=== FILESYSTEM"
df -T -h "$HOME" 2>/dev/null | tail -1
echo
echo "=== PROCESSES"
ps -Ao pid,ppid,lstart,command | grep -E '(^|/)omp( |$)|codebase-memory-mcp|al-omp' | grep -v grep | cut -c1-200
echo
echo "=== AUTOLOOP"
"$HOME/.local/bin/al-omp" status 2>&1 | sed 's/^/  /'
echo
echo "=== SHELL_WIRING"
grep -n -A3 -B1 'al-omp\|PILOT_OMP_EXECUTABLE' "$HOME/.zshrc" 2>/dev/null | head -30
echo
echo "=== AUTHORITY_MARKERS_IN_ENV"
env | grep -E 'OMP_TERMINAL_FENCE|AEGIS_RPC_BIN|AEGIS_CONTROLLER' | sed 's/=.*/=<set>/' || echo "(none)"
echo
echo "=== EXISTING_STATE_DIRS"
ls -d "$HOME"/.omp/*fence* "$HOME"/.omp/agent/*fence* 2>/dev/null || echo "(none)"
echo
echo "=== CBM"
CBM="$HOME/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp"
[ -x "$CBM" ] && { echo "path=$CBM"; echo "sha256=$(shasum -a 256 "$CBM" | cut -d' ' -f1)"; "$CBM" --version 2>&1 | head -1 | sed 's/^/version=/'; }
echo "cache_dir=$(python3 -c 'import json,sys; d=json.load(open("'"$HOME"'/.omp/agent/mcp.json")); print(d["mcpServers"]["codebase-memory"]["env"].get("CBM_CACHE_DIR"))' 2>/dev/null)"
echo
echo "=== PLUGINS"
"$(readlink -f "$HOME/.local/bin/omp")" plugin list 2>&1 | sed 's/^/  /'
