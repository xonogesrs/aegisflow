#!/usr/bin/env bash
# scripts/pi-autoloop.sh
#
# VCA-1 Phase 0F — dedicated interactive-Pi entry point for AutoLoop work.
#
# Root cause closed (VCA1-F1 / Phase 0E): a bare `pi` launched from whatever
# terminal cwd the Controller happened to be in (observed: $HOME) starts a
# fresh session with no idea where the AutoLoop repo lives. Asked to check
# AutoLoop state, the model then improvised a filesystem discovery command
# rooted at that cwd -- which is how a 896s whole-home `grep`/`find` pair
# happened (see docs/pi-graph-output/vca1/vca1-phase0e-interactive-pi-entry-audit.json).
#
# This script does exactly two things a bare `pi` invocation does not:
#   1. cd into this repo before starting Pi, so the session's cwd is never
#      $HOME/anything else -- Pi's own AGENTS.md discovery then loads
#      ../AGENTS.md automatically (the AUTHORITATIVE_SOURCE_FIRST /
#      bounded-verification-root instruction) with no manual trust prompt.
#   2. pass --approve so that project-local trust (AGENTS.md / any future
#      .pi/settings.json) is granted for this run without an interactive
#      confirmation step -- the friction that a manual `cd` + bare `pi`
#      never gets past in the first place.
#
# Does not change bare `pi` behavior anywhere else: this is a separate,
# opt-in entry point, not a global alias/wrapper override.
set -euo pipefail

REPO_ROOT="/Volumes/NVM2T/Development/autoloop"
cd "$REPO_ROOT"
exec pi --approve "$@"
