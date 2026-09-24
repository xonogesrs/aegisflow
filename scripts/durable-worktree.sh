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
#       AUTOLOOP_WORKTREE_ROOT   explicit root
#       AUTOLOOP_HOME            fallback base (default: ~/.autoloop)
#       → <root>/worktrees/<project>/<card-id>
#   - an optional mount-identity gate runs when BOTH are set:
#       AUTOLOOP_WORKTREE_MOUNT        the volume the root must sit on
#       AUTOLOOP_WORKTREE_MOUNT_UUID   that volume's identity
#     With them set, a wrong volume or a shadow mount ("Name 1" alongside
#     "Name") fails before anything is created. This reproduces a stricter
#     deployment policy without baking one machine's volume into the script.
#   - NO fallback path: if a gate fails, this fails clearly and creates nothing.
#   - refuses to clobber an existing destination.
#
# Usage: durable-worktree.sh <project> <card-id> [base-ref]
#   project   the repository to branch from; resolved as
#             AUTOLOOP_REPO_<PROJECT> (uppercased) if set, else a directory
#             named <project> under the current repo's parent, else $PWD
#
# Examples:
#   scripts/durable-worktree.sh autoloop CARD-123
#   AUTOLOOP_REPO_AUTOLOOP=/srv/autoloop AUTOLOOP_WORKTREE_ROOT=/srv/worktrees \
#     scripts/durable-worktree.sh autoloop CARD-123 main

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
project_upper=$(echo "$project" | tr '[:lower:]-' '[:upper:]_')
repo=$(eval "printf '%s' \"\${AUTOLOOP_REPO_${project_upper}:-}\"")
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
[ -d "$repo/.git" ] || fail "project '$project' is not a git repository: $repo (set AUTOLOOP_REPO_${project_upper})"

# ── configured root ────────────────────────────────────────────────────────
base_home=${AUTOLOOP_HOME:-$HOME/.autoloop}
root=${AUTOLOOP_WORKTREE_ROOT:-$base_home/worktrees}
case "$root" in /*) : ;; *) fail "AUTOLOOP_WORKTREE_ROOT must be absolute: $root" ;; esac
[ "$root" != "$HOME" ] || fail "the worktree root must not be \$HOME itself"

# ── optional mount-identity gate ───────────────────────────────────────────
if [ -n "${AUTOLOOP_WORKTREE_MOUNT:-}" ] || [ -n "${AUTOLOOP_WORKTREE_MOUNT_UUID:-}" ]; then
  [ -n "${AUTOLOOP_WORKTREE_MOUNT:-}" ] || fail "AUTOLOOP_WORKTREE_MOUNT_UUID set without AUTOLOOP_WORKTREE_MOUNT (partial gate)"
  [ -n "${AUTOLOOP_WORKTREE_MOUNT_UUID:-}" ] || fail "AUTOLOOP_WORKTREE_MOUNT set without AUTOLOOP_WORKTREE_MOUNT_UUID (partial gate)"
  [ -d "$AUTOLOOP_WORKTREE_MOUNT" ] || fail "$AUTOLOOP_WORKTREE_MOUNT is not mounted; refusing to fall back"
  case "$root" in
    "$AUTOLOOP_WORKTREE_MOUNT" | "$AUTOLOOP_WORKTREE_MOUNT"/*) : ;;
    *) fail "worktree root $root is outside the gated mount $AUTOLOOP_WORKTREE_MOUNT" ;;
  esac
  if command -v diskutil >/dev/null 2>&1; then
    uuid=$(diskutil info -plist "$AUTOLOOP_WORKTREE_MOUNT" 2>/dev/null | plutil -extract VolumeUUID raw -o - - 2>/dev/null || true)
    [ "$uuid" = "$AUTOLOOP_WORKTREE_MOUNT_UUID" ] || fail "mount UUID mismatch on $AUTOLOOP_WORKTREE_MOUNT: got '${uuid:-none}', want $AUTOLOOP_WORKTREE_MOUNT_UUID"
  fi
  mount_name=$(basename -- "$AUTOLOOP_WORKTREE_MOUNT")
  mount_parent=$(dirname -- "$AUTOLOOP_WORKTREE_MOUNT")
  for d in "$mount_parent/$mount_name"*; do
    if [ -e "$d" ] && [ "$d" != "$AUTOLOOP_WORKTREE_MOUNT" ]; then
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
