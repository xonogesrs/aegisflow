#!/bin/sh
# scripts/durable-worktree.sh — create a DURABLE git worktree.
#
# A worktree is DURABLE when it must outlive a single command: task state, a
# card implementation, anything you expect to return to. Ephemeral, self
# cleaning OS-temp worktrees (c2d mutation-run.mjs isolated runs, Colima
# per-run scratch roots) are an explicit exception — do NOT route them here.
#
# Behaviour contract:
#   - the worktree root is CONFIGURED, never hardcoded:
#       AEGISFLOW_WORKTREE_ROOT   explicit root
#       AEGISFLOW_HOME            fallback base (default: ~/.autoloop)
#       → <root>/worktrees/<project>/<card-id>
#     The pre-rename AUTOLOOP_* names are still honored as fallbacks; the
#     AegisFlow name always wins when both are set.
#   - an optional mount-identity gate runs when BOTH are set:
#       AEGISFLOW_WORKTREE_MOUNT        the volume the root must sit on
#       AEGISFLOW_WORKTREE_MOUNT_UUID   that volume's identity
#     With them set, a wrong volume or a shadow mount ("Name 1" alongside
#     "Name") fails before anything is created. This reproduces a stricter
#     deployment policy without baking one machine's volume into the script.
#   - NO fallback path: if a gate fails, this fails clearly and creates nothing.
#   - refuses to clobber an existing destination.
#
# Usage: durable-worktree.sh <project> <card-id> [base-ref]
#   project   the repository to branch from; resolved as
#             AEGISFLOW_REPO_<PROJECT> (uppercased) if set, else a directory
#             named <project> under the current repo's parent, else $PWD
#
# Examples:
#   scripts/durable-worktree.sh aegisflow CARD-123
#   AEGISFLOW_REPO_AEGISFLOW=/srv/aegisflow AEGISFLOW_WORKTREE_ROOT=/srv/worktrees \
#     scripts/durable-worktree.sh aegisflow CARD-123 main

set -eu

usage() { echo "usage: $0 <project> <card-id> [base-ref]" >&2; exit 64; }
fail() { echo "DURABLE_WORKTREE_FAIL: $*" >&2; exit 1; }

[ $# -ge 2 ] && [ $# -le 3 ] || usage
project=$1
card_id=$2
base=${3:-HEAD}

case "$card_id" in "" | .* | */*) fail "invalid card-id: '$card_id'" ;; esac
case "$project" in "" | .* | */*) fail "invalid project: '$project'" ;; esac

# ── project repository ─────────────────────────────────────────────────────
# Brand name wins; the pre-rename AUTOLOOP_REPO_<PROJECT> is the fallback.
project_upper=$(echo "$project" | tr '[:lower:]-' '[:upper:]_')
repo=$(eval "printf '%s' \"\${AEGISFLOW_REPO_${project_upper}:-\${AUTOLOOP_REPO_${project_upper}:-}}\"")
if [ -z "$repo" ]; then
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  candidate=$(CDPATH= cd -- "$script_dir/.." 2>/dev/null && pwd) || candidate=$PWD
  if [ "$(basename -- "$candidate")" = "$project" ]; then
    repo=$candidate
  else
    sibling=$(dirname -- "$candidate")/$project
    [ -d "$sibling/.git" ] && repo=$sibling || repo=$candidate
  fi
fi
[ -d "$repo/.git" ] || fail "project '$project' is not a git repository: $repo (set AEGISFLOW_REPO_${project_upper})"

# ── configured root ────────────────────────────────────────────────────────
# Resolution precedence per variable: AEGISFLOW_* wins, AUTOLOOP_* is the
# legacy fallback. A partial mount gate is still refused (see below).
home_cfg=${AEGISFLOW_HOME:-${AUTOLOOP_HOME:-}}
worktree_cfg=${AEGISFLOW_WORKTREE_ROOT:-${AUTOLOOP_WORKTREE_ROOT:-}}
mount_cfg=${AEGISFLOW_WORKTREE_MOUNT:-${AUTOLOOP_WORKTREE_MOUNT:-}}
mount_uuid_cfg=${AEGISFLOW_WORKTREE_MOUNT_UUID:-${AUTOLOOP_WORKTREE_MOUNT_UUID:-}}
base_home=${home_cfg:-$HOME/.autoloop}
root=${worktree_cfg:-$base_home/worktrees}
case "$root" in /*) : ;; *) fail "AEGISFLOW_WORKTREE_ROOT must be absolute: $root" ;; esac
[ "$root" != "$HOME" ] || fail "the worktree root must not be \$HOME itself"

# ── optional mount-identity gate ───────────────────────────────────────────
if [ -n "$mount_cfg" ] || [ -n "$mount_uuid_cfg" ]; then
  [ -n "$mount_cfg" ] || fail "AEGISFLOW_WORKTREE_MOUNT_UUID set without AEGISFLOW_WORKTREE_MOUNT (partial gate)"
  [ -n "$mount_uuid_cfg" ] || fail "AEGISFLOW_WORKTREE_MOUNT set without AEGISFLOW_WORKTREE_MOUNT_UUID (partial gate)"
  [ -d "$mount_cfg" ] || fail "$mount_cfg is not mounted; refusing to fall back"
  case "$root" in
    "$mount_cfg" | "$mount_cfg"/*) : ;;
    *) fail "worktree root $root is outside the gated mount $mount_cfg" ;;
  esac
  if command -v diskutil >/dev/null 2>&1; then
    uuid=$(diskutil info -plist "$mount_cfg" 2>/dev/null | plutil -extract VolumeUUID raw -o - - 2>/dev/null || true)
    [ "$uuid" = "$mount_uuid_cfg" ] || fail "mount UUID mismatch on $mount_cfg: got '${uuid:-none}', want $mount_uuid_cfg"
  fi
  mount_name=$(basename -- "$mount_cfg")
  mount_parent=$(dirname -- "$mount_cfg")
  for d in "$mount_parent/$mount_name"*; do
    if [ -e "$d" ] && [ "$d" != "$mount_cfg" ]; then
      fail "shadow mount detected: $d"
    fi
  done
fi

# ── destination ────────────────────────────────────────────────────────────
dest="$root/$project/$card_id"
[ -e "$dest" ] && fail "destination already exists: $dest"

mkdir -p "$root/$project"
git -C "$repo" worktree add "$dest" "$base"
echo "DURABLE_WORKTREE_OK: $dest"
