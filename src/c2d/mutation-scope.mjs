// C3B controlled mutation boundary — scope enforcer.
//
// Three-gate scope enforcement (pre-mutation / post-mutation /
// post-validation) over a git worktree. Reuses the existing changed-path
// capture/delta primitives from shared/git-diff-utils.mjs (extracted
// verbatim from Aura's run-card.mjs so this module does not need to import
// the OpenCode-bound run-card.mjs) rather than reimplementing git diffing.

import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { captureChangedPaths, computeDelta } from "../shared/git-diff-utils.mjs";

export function canonicalRepositoryPath(rawPath, repositoryRoot) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath !== rawPath.trim()) return null;
  if (rawPath.includes("\0") || rawPath.includes("\\") || isAbsolute(rawPath) ||
      /^[A-Za-z]:[\\/]/.test(rawPath) || /[*?[\]{}]/.test(rawPath)) return null;
  if (rawPath === "." || rawPath === "/" || rawPath.split("/").includes("..") || rawPath.split("/").includes(".")) return null;
  const normalized = normalize(rawPath);
  if (normalized !== rawPath || normalized === "." || normalized === "") return null;
  // `.git` mutation is always rejected, tracked or not, top-level or nested.
  if (normalized === ".git" || normalized.startsWith(".git" + sep) || normalized.split("/").includes(".git")) return null;
  const absolute = resolve(repositoryRoot, normalized);
  const contained = relative(repositoryRoot, absolute);
  if (!contained || contained.startsWith(".." + sep) || contained === ".." || isAbsolute(contained) || contained !== normalized) {
    return null;
  }
  // Reject if any path component (including the leaf) is a symlink — blocks
  // repository-escape via a symlinked directory or file pointing outside root.
  let current = repositoryRoot;
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    try {
      if (lstatSync(current).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  return normalized;
}

function globToRegExp(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$+.|()[]{}".includes(char)) {
      source += "\\" + char;
    } else {
      source += char;
    }
  }
  return new RegExp(source + "$");
}

export function matchesAnyPattern(path, patterns) {
  if (!path || !Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0") ||
        pattern.includes("\\") || isAbsolute(pattern) || pattern.split("/").includes("..")) {
      return false;
    }
    if (pattern === "*") return true;
    try { return globToRegExp(pattern).test(path); } catch { return false; }
  });
}

/**
 * Capture a scope snapshot of the given worktree — thin wrapper around the
 * existing captureChangedPaths so call sites in mutation-run.mjs don't need
 * to import run-card.mjs directly.
 */
export function captureScopeSnapshot(cwd) {
  return captureChangedPaths(cwd);
}

/**
 * Classify every path in the delta between two snapshots against the
 * declared allowed/forbidden scope. A path is a violation if:
 *  - it fails canonicalization (escape, symlink, traversal, `.git`), or
 *  - it matches a forbidden pattern, or
 *  - it does not match any allowed pattern.
 *
 * Returns { ok, delta, violations } — delta always contains the full
 * changed-path inventory (tracked/untracked/deleted/renamed-as-add+delete)
 * regardless of outcome, so callers get full mutation evidence even on HOLD.
 */
export function enforceScopeGate(repositoryRoot, baselineSnapshot, currentSnapshot, allowedPaths, forbiddenPaths) {
  const delta = computeDelta(baselineSnapshot, currentSnapshot, repositoryRoot);
  const violations = [];
  for (const change of delta) {
    const canonical = canonicalRepositoryPath(change.path, repositoryRoot);
    if (!canonical) {
      violations.push({ ...change, reason: "path_escape_or_symlink_or_git" });
      continue;
    }
    if (matchesAnyPattern(canonical, forbiddenPaths || [])) {
      violations.push({ ...change, canonical_path: canonical, reason: "forbidden_path" });
      continue;
    }
    if (!matchesAnyPattern(canonical, allowedPaths || [])) {
      violations.push({ ...change, canonical_path: canonical, reason: "outside_allowlist" });
    }
  }
  return { ok: violations.length === 0, delta, violations };
}

export { computeDelta };
