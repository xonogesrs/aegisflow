#!/bin/sh
# durable-worktree.sh — create a durable git worktree under the frozen NVM2T
# canonical destination (AURA-DEVELOPMENT-STORAGE-POLICY-V1 §5 / Step 6).
#
# Behavior contract:
#   - verifies the EXACT NVM2T mount by volume UUID; any mismatch fails
#   - rejects shadow mounts (/Volumes/NVM2T 1)
#   - builds the canonical destination /Volumes/NVM2T/Development/worktrees/<project>/<card-id>
#   - NO fallback path: if the gate fails, this fails clearly and creates nothing
#
# Ephemeral, self-cleaning OS-temp worktrees (e.g. c2d mutation-run.mjs,
# colima scratch roots) are an explicit exception and MUST NOT be routed here.
#
# Usage: durable-worktree.sh <aura|autoloop> <card-id> [base-ref]
set -eu

NVM2T_MOUNT=/Volumes/NVM2T
NVM2T_UUID=971A7EA8-5108-4B8E-B9A8-5141F0C04A8A

usage() { echo "usage: $0 <aura|autoloop> <card-id> [base-ref]" >&2; exit 64; }
fail() { echo "DURABLE_WORKTREE_FAIL: $*" >&2; exit 1; }

[ $# -ge 2 ] && [ $# -le 3 ] || usage
project=$1
card_id=$2
base=${3:-HEAD}

case "$project" in
  aura) repo="$HOME/auracore" ;;
  autoloop) repo="$NVM2T_MOUNT/Development/repos/autoloop" ;;
  *) usage ;;
esac
case "$card_id" in "" | .* | */*) fail "invalid card-id: '$card_id'" ;; esac

# --- exact mount gate -----------------------------------------------------
[ -d "$NVM2T_MOUNT" ] || fail "$NVM2T_MOUNT is not mounted; refusing to fall back"
uuid=$(diskutil info -plist "$NVM2T_MOUNT" 2>/dev/null | plutil -extract VolumeUUID raw -o - - 2>/dev/null)
[ "$uuid" = "$NVM2T_UUID" ] || fail "mount UUID mismatch: got '${uuid:-none}', want $NVM2T_UUID"
for d in /Volumes/NVM2T\ *; do
  [ -e "$d" ] && fail "shadow mount detected: $d"
done

# --- canonical destination -------------------------------------------------
dest="$NVM2T_MOUNT/Development/worktrees/$project/$card_id"
if [ -e "$dest" ]; then fail "destination already exists: $dest"; fi

mkdir -p "$NVM2T_MOUNT/Development/worktrees/$project"
git -C "$repo" worktree add "$dest" "$base"
echo "DURABLE_WORKTREE_OK: $dest"
