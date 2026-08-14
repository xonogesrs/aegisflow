// src/runtime/colima-worktree.mjs
//
// Isolated-worktree lifecycle manager for the Colima writer pipeline.
//
// The writer NEVER operates on the source repo directly. A governed wrapper
// (this module) owns the git worktree lifecycle on the writable scratch:
//   prepare  -> clone the read-only source once, `git worktree add` a fresh
//               detached worktree for this task (host-side git; source is
//               only ever READ)
//   verify   -> prove the worktree is bound to the clone, its root is the
//               worktree dir, and the clone's MAIN checkout is unpolluted
//   capture  -> record the worktree's changed files + diff (reviewable output)
//   revoke   -> `git worktree remove --force` (revocable; idempotent)
//
// The containerized writer is allowed to touch ONLY the worktree path
// (read-write) and the source (read-only); that mount allowlist is enforced
// by colima-runtime.mjs assertMountAllowlist before any container starts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export class WorktreeError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "WorktreeError";
    this.details = details;
  }
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new WorktreeError(`git ${args[0]} failed in ${cwd}: ${(r.stderr || r.stdout).trim()}`, { args, status: r.status });
  }
  return r.stdout.trim();
}

/**
 * Prepare a dedicated worktree for one task.
 * cloneDir is shared per scratchRoot; worktreeDir is per task.
 */
export function prepareWorktree({ sourceRepo, scratchRoot, taskId }) {
  const cloneDir = join(scratchRoot, "clone");
  const worktreeDir = join(scratchRoot, String(taskId), "wt");
  mkdirSync(dirname(worktreeDir), { recursive: true });

  if (!existsSync(join(cloneDir, ".git"))) {
    git(".", ["clone", "--no-hardlinks", "-q", sourceRepo, cloneDir]);
  }
  if (!existsSync(join(worktreeDir, ".git"))) {
    git(cloneDir, ["worktree", "add", "--detach", "-q", worktreeDir]);
  }
  const head = git(cloneDir, ["rev-parse", "HEAD"]);
  return { cloneDir, worktreeDir, head };
}

/** Prove the worktree is a git worktree of cloneDir and clone main is clean. */
export function verifyWorktree({ cloneDir, worktreeDir }) {
  const root = git(worktreeDir, ["rev-parse", "--show-toplevel"]);
  const commonDir = git(worktreeDir, ["rev-parse", "--git-common-dir"]);
  const mainPorcelain = git(cloneDir, ["status", "--porcelain"]);
  const head = git(worktreeDir, ["rev-parse", "HEAD"]);
  return {
    ok: root === worktreeDir && commonDir === join(cloneDir, ".git"),
    root,
    commonDir,
    mainPorcelain,
    head,
  };
}

/** Record the worktree's changed files + diff (reviewable, revocable output). */
export function captureWorktreeOutput({ worktreeDir, cloneDir }) {
  // NUL-delimited porcelain v1（RB-1R path-identity fix）: the previous
  // line-slice of a trimmed porcelain blob lost the FIRST character of the
  // FIRST path（`package.json` -> `ackage.json` class defect）. Structured
  // records keep spaces / Unicode / nesting / renames intact.
  const raw = spawnSync(
    "git",
    ["-C", worktreeDir, "-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  if (raw.status !== 0) {
    throw new WorktreeError(`git status -z failed in ${worktreeDir}: ${(raw.stderr || raw.stdout).trim()}`, { status: raw.status });
  }
  const files = parsePorcelainV1Z(raw.stdout ?? "");
  const diff = git(worktreeDir, ["diff", "HEAD", "--stat"]).trim();
  const fullDiff = git(worktreeDir, ["diff", "HEAD"]).trim().slice(0, 64 * 1024);
  // Untracked files are not part of `git diff`; record their content so the
  // output stays reviewable without mutating the worktree index（files only;
  // directories are listed separately to avoid EISDIR）.
  const untrackedFiles = [];
  const untrackedDirs = [];
  for (const f of files) {
    if (f.status === "??" && f.path) {
      const full = join(worktreeDir, f.path);
      let isFile = false;
      try {
        isFile = statSync(full).isFile();
      } catch {
        isFile = false;
      }
      if (isFile) {
        untrackedFiles.push({ path: f.path, content: readFileSync(full, "utf8").slice(0, 4 * 1024) });
      } else {
        untrackedDirs.push(f.path);
      }
    }
  }
  return { files, diff, fullDiff, untrackedFiles, untrackedDirs, cloneHead: git(cloneDir, ["rev-parse", "HEAD"]) };
}

/**
 * Minimal porcelain v1 -z parser（same contract as
 * src/governance/review-bundle.mjs parseGitStatusPorcelainZ; kept local to
 * avoid a governance -> runtime import edge）. Rename records are
 * `XY <dest>\0<source>\0`（git status -z emits destination first）.
 */
function parsePorcelainV1Z(raw) {
  const records = [];
  const fields = String(raw ?? "").split("\0");
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    i += 1;
    if (f.length === 0) continue;
    if (f.length < 3) {
      records.push({ status: f, path: null, source: null, destination: null, rename: false, malformed: true });
      continue;
    }
    const status = f.slice(0, 2);
    const destination = f.slice(3);
    if ((status[0] === "R" || status[0] === "C") && i < fields.length) {
      const source = fields[i];
      i += 1;
      records.push({ status, path: destination, source, destination, rename: true, malformed: false });
      continue;
    }
    records.push({ status, path: destination, source: null, destination: null, rename: false, malformed: false });
  }
  return records;
}

/** Remove the worktree (revocable). Idempotent: missing worktree is a no-op. */
export function revokeWorktree({ cloneDir, worktreeDir }) {
  if (!existsSync(join(worktreeDir, ".git"))) return { revoked: false, reason: "not_present" };
  git(cloneDir, ["worktree", "remove", "--force", worktreeDir]);
  return { revoked: true };
}
