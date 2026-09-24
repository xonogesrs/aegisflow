#!/usr/bin/env bash
# scripts/pi-autoloop.sh
#
# Dedicated interactive-Pi entry point for AutoLoop work.
#
# Root cause this closes: a bare `pi` launched from whatever terminal cwd the
# operator happened to be in (typically $HOME) starts a fresh session with no
# idea where the AutoLoop checkout lives. Asked to check AutoLoop state, the
# model then improvised a filesystem discovery command rooted at that cwd --
# which is how a whole-home `grep`/`find` pair (896s, no progress) happened.
#
# This script does exactly two things a bare `pi` invocation does not:
#   1. cd into THIS checkout before starting Pi, so the session's cwd is never
#      $HOME/anything else -- Pi's own AGENTS.md discovery then loads the
#      repo-root AGENTS.md automatically (the AUTHORITATIVE_SOURCE_FIRST /
#      bounded-verification-root instructions) with no manual trust prompt.
#   2. pass --approve so that project-local trust (AGENTS.md / .pi/settings.json)
#      is granted for this run without an interactive confirmation step.
#
# The checkout root is derived from this script's own location, so the launcher
# works from any clone path. Set AUTOLOOP_REPO_ROOT to override it explicitly.
#
# Does not change bare `pi` behavior anywhere else: this is a separate,
# opt-in entry point, not a global alias/wrapper override.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${AUTOLOOP_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
cd "$REPO_ROOT"
exec pi --approve "$@"
