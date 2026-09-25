#!/usr/bin/env bash
# scripts/pi-autoloop.sh
#
# COMPATIBILITY ALIAS — the interactive-Pi entry point was renamed to
# `scripts/pi-aegisflow.sh` by
# AEGISFLOW_PROJECT_RENAME_AND_COMPATIBILITY_MIGRATION_1.
#
# Existing wrappers, aliases and muscle memory that call the pre-rename file
# name keep working: this forwards the argument vector verbatim. The real
# launcher resolves its own location, so it still lands on this checkout and
# still passes --approve.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/pi-aegisflow.sh" "$@"
