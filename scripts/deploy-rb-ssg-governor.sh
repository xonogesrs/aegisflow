#!/usr/bin/env bash
#
# RB-SSG4-FR4 (Phase E) — idempotent deployment convergence for the Pi
# search-scope-governor extension.
#
# Integrity chain:
#   src/admission/*                     (authoritative source)
#     → pi-extensions/search-scope-governor/vendor/*   (repo bundle)
#       → ~/.pi/agent/extensions/search-scope-governor/* (installed runtime)
#
# Usage: scripts/deploy-rb-ssg-governor.sh [--dry-run]
#   --dry-run   verify SHA equality without copying anything.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$REPO_ROOT/src/admission"
VENDOR_DIR="$REPO_ROOT/pi-extensions/search-scope-governor/vendor"
INSTALL_DIR="$HOME/.pi/agent/extensions/search-scope-governor"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

sha() { shasum -a 256 "$1" | awk '{print $1}'; }

FILES=("search-scope-governor.mjs" "pi-command-admission.mjs")

step_sync() {
  local src="$1" dst="$2"
  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ ! -f "$dst" ]] || [[ "$(sha "$src")" != "$(sha "$dst")" ]]; then
      echo "DRIFT  $dst  (would copy from $src)"
    else
      echo "OK     $dst"
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "SYNCED $dst"
  fi
}

echo "== repo bundle (src → vendor) =="
for f in "${FILES[@]}"; do
  step_sync "$SRC_DIR/$f" "$VENDOR_DIR/$f"
done

echo "== installed runtime (repo bundle + index.ts → ~/.pi) =="
for f in "${FILES[@]}"; do
  step_sync "$VENDOR_DIR/$f" "$INSTALL_DIR/vendor/$f"
done
step_sync "$REPO_ROOT/pi-extensions/search-scope-governor/index.ts" "$INSTALL_DIR/index.ts"

echo "== integrity verification =="
STATUS=0
for f in "${FILES[@]}"; do
  s="$(sha "$SRC_DIR/$f")"
  v="$(sha "$VENDOR_DIR/$f")"
  i="$(sha "$INSTALL_DIR/vendor/$f")"
  if [[ "$s" == "$v" && "$v" == "$i" ]]; then
    echo "SHA256 EQUAL  $f  ($s)"
  else
    echo "SHA256 DRIFT  $f  src=$s vendor=$v installed=$i"
    STATUS=1
  fi
done

if [[ "$STATUS" == "0" ]]; then
  echo "DEPLOYMENT_CONVERGED  (source == vendor == installed)"
else
  echo "DEPLOYMENT_DRIFT_DETECTED"
  exit 1
fi

echo "NOTE: reload Pi (/reload) or start a fresh session to load the new extension."
