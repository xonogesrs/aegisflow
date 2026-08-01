#!/usr/bin/env bash
# operator-tick.sh
#
# Safe operator wrapper for the sealed AutoLoop scheduler dry-run tick.
#
# Enforces safety:
#   - --metadata-dir is REQUIRED (never default to tracked docs/loop/metadata)
#   - --lock-file is REQUIRED (never default to shared /tmp in CI)
#   - --card-state / --debug are FORBIDDEN (operator must not use them)
#   - Calls scheduler-tick-dry.mjs (not run-chain-dry.mjs directly)
#   - Preserves all scheduler exit codes
#
# Usage:
#   scripts/ai/autoloop/operator-tick.sh \
#     --metadata-dir /path/to/metadata \
#     --lock-file /path/to/tick.lock \
#     [--fake-events-file /path/to/events] \
#     [--chain-timeout 300000] \
#     [--candidate /path/to/candidate.json \
#      --checkpoint-root /path/to/checkpoints \
#      --repo-root /path/to/repo [--actor-id id]]
#
# C3A (read-only C2D integration): when --candidate is given the tick is
# routed through operator-tick.mjs. Dispatch through the C2D runtime only
# happens when AURA_AUTOLOOP_C3A_C2D_READ_ONLY=1 is set; otherwise the
# legacy scheduler path runs unchanged and no C2D state is created.
#
# Exit codes (inherited from scheduler tick):
#   0  tick completed (candidate may or may not have been processed)
#   2  LOCK_HELD (another scheduler tick is running)
#   3  LOCK_STALE_UNSAFE (lock exists, cannot classify safely)
#   4  CHAIN_FAILED (chain subprocess timed out, errored, or crashed)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCHEDULER="$HERE/scheduler-tick-dry.mjs"
C3A_TICK="$HERE/operator-tick.mjs"

metadata_dir=""
lock_file=""
fake_events_file=""
chain_timeout=""
candidate=""
extra_args=()
c3a_args=()

usage() {
  sed -n 's/^#//p' "$0"
  exit 2
}

# ── Parse arguments (long-form only, no short flags) ──────
while [ $# -gt 0 ]; do
  case "$1" in
    --metadata-dir)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --metadata-dir requires a value"; exit 2; fi
      metadata_dir="$1"
      extra_args+=("--metadata-dir" "$1")
      ;;
    --lock-file)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --lock-file requires a value"; exit 2; fi
      lock_file="$1"
      extra_args+=("--lock-file" "$1")
      ;;
    --fake-events-file)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --fake-events-file requires a value"; exit 2; fi
      fake_events_file="$1"
      extra_args+=("--fake-events-file" "$1")
      ;;
    --chain-timeout)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --chain-timeout requires a value"; exit 2; fi
      extra_args+=("--chain-timeout" "$1")
      ;;
    --stale-lock-ttl)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --stale-lock-ttl requires a value"; exit 2; fi
      extra_args+=("--stale-lock-ttl" "$1")
      ;;
    --candidate)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --candidate requires a value"; exit 2; fi
      candidate="$1"
      c3a_args+=("--candidate" "$1")
      ;;
    --checkpoint-root)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --checkpoint-root requires a value"; exit 2; fi
      c3a_args+=("--checkpoint-root" "$1")
      ;;
    --repo-root)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --repo-root requires a value"; exit 2; fi
      c3a_args+=("--repo-root" "$1")
      ;;
    --actor-id)
      shift
      if [ -z "${1:-}" ]; then echo "ERROR: --actor-id requires a value"; exit 2; fi
      c3a_args+=("--actor-id" "$1")
      ;;
    --card-state|--debug)
      echo "ERROR: '$1' is forbidden in the operator command"
      echo "  --card-state overrides card state — operator must not use"
      echo "  --debug exposes internal detail — operator must not need"
      exit 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      echo "ERROR: unknown argument: $1"
      usage
      ;;
  esac
  shift
done

# ── Validate required args ────────────────────────────────
if [ -z "$metadata_dir" ]; then
  echo "ERROR: --metadata-dir is REQUIRED"
  echo "  Never default to the tracked docs/loop/metadata/."
  echo "  Pass an explicit path to your controlled metadata directory."
  exit 2
fi

if [ -z "$lock_file" ]; then
  echo "ERROR: --lock-file is REQUIRED"
  echo "  Pass an explicit path to a private lock file path."
  echo "  Do not rely on the shared /tmp default in CI/container environments."
  exit 2
fi

# ── Ensure metadata directory exists ──────────────────────
# Idempotent: if the dir already exists, mkdir -p is a no-op.
# This allows the operator to pass a persistent path like
# .aura/autoloop/metadata/ without pre-creating it manually.
mkdir -p "$metadata_dir"

# ── C3A candidate mode routes through operator-tick.mjs ───
# Feature gating (AURA_AUTOLOOP_C3A_C2D_READ_ONLY) is enforced inside
# operator-tick.mjs; with the feature disabled it delegates back to the
# legacy scheduler unchanged. This branch never touches $SCHEDULER, so its
# presence is checked below, only on the legacy path that actually needs it.
if [ -n "$candidate" ]; then
  if [ ! -f "$C3A_TICK" ]; then
    echo "FATAL: C3A operator tick not found at $C3A_TICK"
    exit 4
  fi
  exec node "$C3A_TICK" "${extra_args[@]}" "${c3a_args[@]}"
fi

# ── Verify scheduler exists (legacy path only) ────────────
if [ ! -f "$SCHEDULER" ]; then
  echo "UNSUPPORTED_STANDALONE_LEGACY_SCHEDULER: scheduler tick not found at $SCHEDULER"
  exit 4
fi

# ── Invoke scheduler with preserved args ──────────────────
exec node "$SCHEDULER" "${extra_args[@]}"
