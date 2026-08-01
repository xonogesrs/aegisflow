import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { C2dHoldError, HOLD, sha256Hex, assertPathComponentsNotSymlink } from "./fs-atomic.mjs";

function git(repoRoot, args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function collectFingerprint(repoRoot) {
  const requestedRoot = resolve(repoRoot);
  const root = realpathSync(requestedRoot);
  assertPathComponentsNotSymlink(root);
  if (!existsSync(root)) {
    throw new C2dHoldError(HOLD.REPOSITORY_FINGERPRINT_MISMATCH, `repo missing: ${root}`);
  }
  if (lstatSync(root).isSymbolicLink()) {
    throw new C2dHoldError(HOLD.SYMLINK_REJECTED, `repo root is symlink: ${root}`);
  }
  let head, commonDir, branch, originUrl, originMaster, statusPorcelain;
  try {
    head = git(root, ["rev-parse", "HEAD"]);
    commonDir = realpathSync(resolve(root, git(root, ["rev-parse", "--git-common-dir"])));
    assertPathComponentsNotSymlink(commonDir);
    try { branch = git(root, ["branch", "--show-current"]); } catch { branch = ""; }
    try { originUrl = git(root, ["remote", "get-url", "origin"]); } catch { originUrl = ""; }
    try { originMaster = git(root, ["rev-parse", "origin/master"]); } catch { originMaster = ""; }
    statusPorcelain = git(root, ["status", "--porcelain"]);
  } catch (e) {
    throw new C2dHoldError(HOLD.REQUIRED_GIT_OBJECT_MISSING, e.message || String(e));
  }
  const dirty = statusPorcelain.length > 0;
  // Slice-1: dirty digest is status-path only, NOT content affinity evidence.
  const dirtyDigest = dirty
    ? `dirty_status_only:${sha256Hex(Buffer.from(statusPorcelain, "utf8"))}`
    : "clean";
  return {
    repository_root_identity: root,
    git_common_dir_identity: commonDir,
    worktree_identity: root,
    expected_head: head,
    expected_ref: branch || "HEAD",
    origin_url: originUrl,
    origin_master: originMaster,
    expected_worktree_state: dirtyDigest,
    dirty,
    dirty_digest_is_content_affinity: false,
  };
}

export function assertFingerprint(actual, expected, { requireClean = true } = {}) {
  if (requireClean && actual.dirty) {
    throw new C2dHoldError(HOLD.DIRTY_STATE_MISMATCH, "dirty worktree not allowed in slice-1 (dirty resume unsupported)");
  }
  const fields = [
    "expected_head",
    "repository_root_identity",
    "worktree_identity",
    "git_common_dir_identity",
    "expected_ref",
    "origin_url",
    "origin_master",
    "expected_worktree_state",
  ];
  for (const f of fields) {
    if (expected[f] !== undefined && expected[f] !== null && expected[f] !== "") {
      if (actual[f] !== expected[f]) {
        const code = f === "expected_head" ? HOLD.EXPECTED_HEAD_MISMATCH
          : f === "worktree_identity" ? HOLD.WORKTREE_IDENTITY_MISMATCH
            : f === "expected_worktree_state" ? HOLD.DIRTY_STATE_MISMATCH
              : HOLD.REPOSITORY_FINGERPRINT_MISMATCH;
        throw new C2dHoldError(code, `fingerprint field mismatch: ${f}`, {
          expected: expected[f],
          actual: actual[f],
        });
      }
    }
  }
  return true;
}
