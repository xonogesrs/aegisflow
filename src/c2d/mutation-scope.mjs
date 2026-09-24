// C3B controlled mutation boundary — scope enforcer.
//
// Three-gate scope enforcement (pre-mutation / post-mutation /
// post-validation) over a git worktree. Reuses the existing changed-path
// capture/delta primitives from shared/git-diff-utils.mjs (extracted
// verbatim from Aura's run-card.mjs so this module does not need to import
// the OpenCode-bound run-card.mjs) rather than reimplementing git diffing.
//
// CANONICAL SCOPE SEMANTICS — single source. Every scope DECISION in the
// system resolves its paths here and compares the RESULTS component-wise:
// this enforcement gate, the admission scope projection
// (admission/policy-projection.mjs), the writer-result scope validation
// (subagent/subagent-contract.mjs) and the host-side writer scope
// verification (subagent/subagent-writer-executor-adapter.mjs). A lexical
// prefix test over uncanonicalized strings is never a scope decision: it
// authorizes a boundary such as `src/../../etc/x` that this gate then
// refuses — a projection that says "authorized" where enforcement says
// "denied" is an authority discrepancy, so the projection canonicalizes with
// these same rules and fails closed on anything undecidable.
//
// GIT IS NOT THE ONLY SIGNAL. This module's gate compares git's changed-path
// inventory; a write THROUGH a pre-existing symlink produces NO changed path,
// so it is invisible here. That class is covered by the companion,
// git-independent layer c2d/write-containment.mjs (pre/post-execution
// materialized-filesystem audit of the isolated worktree) — the two layers are
// deliberately separate and both run.

import { lstatSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { captureChangedPaths, computeDelta } from "../shared/git-diff-utils.mjs";

/**
 * Lexically canonicalize a repository-relative scope path. Pure — no
 * filesystem access and no repository root needed.
 *
 * Returns the canonical path, or null (fail closed) for anything that is not
 * ALREADY canonical and resolvable: absolute / drive-letter paths,
 * backslashes, NUL, wildcards (`* ? [ ] { }`), empty / blank / untrimmed
 * input, `.` or `..` segments, an empty segment (trailing separator), a
 * non-normalized spelling, and any path component named `.git`.
 */
export function canonicalScopePath(rawPath) {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath !== rawPath.trim()) return null;
  if (rawPath.includes("\0") || rawPath.includes("\\") || isAbsolute(rawPath) ||
      /^[A-Za-z]:[\\/]/.test(rawPath) || /[*?[\]{}]/.test(rawPath)) return null;
  if (rawPath === "." || rawPath === "/" || rawPath.split("/").includes("..") || rawPath.split("/").includes(".")) return null;
  const normalized = normalize(rawPath);
  if (normalized !== rawPath || normalized === "." || normalized === "") return null;
  // `.git` mutation is always rejected, tracked or not, top-level or nested.
  if (normalized === ".git" || normalized.startsWith(".git" + sep) || normalized.split("/").includes(".git")) return null;
  return normalized;
}

/**
 * Canonicalize a repository-relative path against a repository root: the
 * lexical rules above, plus root containment and symlink rejection on every
 * path component (including the leaf). This is the enforcement gate's
 * canonicalizer; the projection uses it whenever a root is known, so both
 * sides agree on symlink-adjacent representations too.
 */
export function canonicalRepositoryPath(rawPath, repositoryRoot) {
  const normalized = canonicalScopePath(rawPath);
  if (!normalized) return null;
  const absolute = resolve(repositoryRoot, normalized);
  const contained = relative(repositoryRoot, absolute);
  if (!contained || contained.startsWith(".." + sep) || contained === ".." || isAbsolute(contained) || contained !== normalized) {
    return null;
  }
  // Reject if any path component (including the leaf) is a symlink — blocks
  // repository-escape via a symlinked directory or file pointing outside root.
  // lstat FIRST, never existsSync-then-lstat: existsSync follows a symlink, so
  // a DANGLING link was skipped (`existsSync === false` → `continue`) and the
  // boundary was accepted as if it were a plain path, while the very same
  // spelling was refused once the link's target existed. A symlink component —
  // resolvable or dangling — never canonicalizes: the real target is decided
  // by the link, not by the requested spelling. A component that does not
  // exist (ENOENT, or ENOTDIR for a path under a regular file — the
  // pre-existing file-shaped subtree semantics) cannot redirect a write; any
  // other lstat failure is undecidable and fails closed.
  let current = repositoryRoot;
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      return null;
    }
    if (stat.isSymbolicLink()) return null;
  }
  return normalized;
}

/**
 * Canonicalize ONE declared scope boundary (admission `mutation_scope` entry,
 * phase artifact boundary, envelope `mutationScope` entry). A trailing
 * separator is stripped first — `"src/"` ≡ `"src"`, the H5/checkPathArray
 * equivalence `v2/phase-task-card.mjs` already applies to declared artifact
 * boundaries — and everything else must already be canonical. Returns null
 * (fail closed) for an empty, unresolvable, ambiguous or escaping entry.
 *
 * @param {unknown} rawEntry
 * @param {string|null} [repositoryRoot] — when known, the entry is resolved
 *   with the enforcement gate's full canonicalization (root containment +
 *   symlink rejection); without it, lexical canonicalization only.
 */
export function canonicalScopeEntry(rawEntry, repositoryRoot = null) {
  if (typeof rawEntry !== "string") return null;
  const stripped = rawEntry.replace(/\/+$/, "");
  if (stripped.length === 0) return null;
  return repositoryRoot ? canonicalRepositoryPath(stripped, repositoryRoot) : canonicalScopePath(stripped);
}

/**
 * Canonicalize a declared scope LIST. Returns null (fail closed) when ANY
 * entry is undecidable — an undecidable scope authorizes nothing, it is never
 * narrowed into a grant. Duplicate canonical entries collapse to one.
 */
export function canonicalScopeEntries(entries, repositoryRoot = null) {
  const out = [];
  for (const entry of entries ?? []) {
    const canonical = canonicalScopeEntry(entry, repositoryRoot);
    if (!canonical) return null;
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * Boundary containment over CANONICAL paths: `candidate` is inside a boundary
 * IFF it equals it or continues it at a component boundary. Never a raw
 * prefix/substring test — the caller must have canonicalized both sides
 * (`canonicalScopeEntry` / `canonicalScopePath` / `canonicalRepositoryPath`).
 */
export function isWithinCanonicalScope(candidate, boundaries) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  for (const boundary of boundaries ?? []) {
    if (typeof boundary !== "string" || boundary.length === 0) continue;
    if (candidate === boundary) return true;
    if (candidate.length > boundary.length && candidate.startsWith(boundary) && candidate[boundary.length] === "/") return true;
  }
  return false;
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
 *
 * GIT-INVENTORY LIMIT (by construction): only paths git reports are classified.
 * A write through a pre-existing symlink leaves the symlink blob unchanged and
 * the content outside the tree, so it never enters `delta` and this gate cannot
 * deny it. Callers that guard a real mutation must pair this gate with
 * `verifyWriteContainment` (c2d/write-containment.mjs).
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
