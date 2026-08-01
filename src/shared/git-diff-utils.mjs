// git-diff-utils.mjs
//
// Provider-neutral Git diff/fingerprint utilities. Extracted verbatim (no
// behavioral changes) from Aura's scripts/ai/autoloop/run-card.mjs so that
// c2d/mutation-scope.mjs does not need to import the OpenCode-bound
// run-card.mjs to get captureChangedPaths/computeDelta.
//
// No OpenCode invocation, no task-card lifecycle, no Aura-specific paths,
// no preflight logic. Pure subprocess wrappers + set/diff computation.

import { spawnSync } from "node:child_process";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status, error: r.error, signal: r.signal };
}

function git(args, cwd) {
  return run("git", args, { cwd });
}

function contentFingerprint(path, cwd) {
  // For tracked files: git hash-object gives the blob hash (working tree version)
  const hash = git(["hash-object", path], cwd);
  if (hash.status === 0 && (hash.stdout || "").trim()) return hash.stdout.trim();
  // For deletion or unreadable: return empty
  return "";
}

function isTracked(path, cwd) {
  const r = git(["ls-files", "--error-unmatch", path], cwd);
  return r.status === 0;
}

export function captureChangedPaths(cwd) {
  const diff = git(["diff", "--name-only"], cwd);
  const diffCached = git(["diff", "--cached", "--name-only"], cwd);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
  const stagedDeletions = git(["diff", "--cached", "--diff-filter=D", "--name-only"], cwd);
  const unstagedDeletions = git(["ls-files", "--deleted"], cwd);
  const allPaths = [
    ...(diff.stdout || "").split("\n").filter(Boolean),
    ...(diffCached.stdout || "").split("\n").filter(Boolean),
    ...(untracked.stdout || "").split("\n").filter(Boolean),
    ...(stagedDeletions.stdout || "").split("\n").filter(Boolean),
    ...(unstagedDeletions.stdout || "").split("\n").filter(Boolean),
  ];
  const unique = [...new Set(allPaths)];
  const fingerprints = {};
  for (const p of unique) {
    fingerprints[p] = contentFingerprint(p, cwd);
  }
  return { paths: new Set(unique), fingerprints };
}

export function computeDelta(pre, post, cwd) {
  const allPaths = new Set([...pre.paths, ...post.paths]);
  const delta = [];
  for (const p of allPaths) {
    const inPre = pre.paths.has(p);
    const inPost = post.paths.has(p);
    const tracked = cwd ? isTracked(p, cwd) : false;
    if (!inPre && inPost) {
      if (tracked && !post.fingerprints[p]) {
        // Tracked file appeared in post but has no content → deleted from disk
        delta.push({ path: p, change: "deleted" });
      } else if (tracked) {
        delta.push({ path: p, change: "modified" });
      } else {
        delta.push({ path: p, change: "added" });
      }
    } else if (inPre && !inPost) {
      delta.push({ path: p, change: "deleted" });
    } else if (pre.fingerprints[p] !== post.fingerprints[p]) {
      const fileDeleted = tracked && !post.fingerprints[p];
      delta.push({ path: p, change: fileDeleted ? "deleted" : "modified" });
    }
  }
  return delta;
}
