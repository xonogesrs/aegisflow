// C3B controlled mutation boundary — filesystem write containment.
//
// WHY THIS IS A SEPARATE LAYER FROM mutation-scope.mjs
//
// The scope gate (enforceScopeGate) iterates GIT's changed-path inventory. A
// write performed THROUGH a symlink that already exists in the worktree lands
// outside the repository while git reports NO changed path at all: the symlink
// blob is unchanged and the content went outside the tree, so the delta is
// EMPTY and indistinguishable from "nothing happened". Path canonicalization
// cannot see it either — it is never asked about the path, because the path
// never appears in the delta. (Measured: `git diff` / `git ls-files` empty,
// gate ok, outside file written — Local Security Review M1.)
//
// This module is the enforcement layer that does NOT depend on git. It
// inspects the MATERIALIZED filesystem directly (lstat / readlink / realpath)
// and refuses a mutation whose writable tree can redirect a write out of the
// authorized root:
//
//   - any symlink whose resolved (realpath) or lexically-resolved target is
//     outside the worktree root is a containment violation — resolvable or
//     DANGLING (a dangling link can gain an external target later);
//   - any symlink COMPONENT of a declared writable boundary is a containment
//     violation, even when it points inside the root (declaration parity with
//     canonicalRepositoryPath, which refuses symlink-adjacent boundaries);
//   - anything that cannot be inspected fails closed.
//
// AUTHORITY MODEL. This is an ADDITIONAL boundary, never a replacement: the
// admission gate, the canonical scope projection, this containment layer and
// the post-mutation git scope gate all run. Containment can only DENY; it never
// authorizes anything, and it never widens a scope.
//
// RESIDUAL LIMIT (documented, not hidden): the mutation is an externally
// spawned command. A symlink created by that command after this pre-execution
// audit is caught by the post-execution re-audit (and by the git gate, which
// sees the newly created symlink as a changed path), so the run fails closed —
// but the write itself cannot be made atomic from Node without OS-level
// sandboxing, which this host-process path does not have (docs/architecture.md
// §Isolation: host-process isolation is not a security boundary). Fail-closed
// detection is the guarantee; atomic prevention is not claimed.

import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Containment violation reasons (stable, citable). */
export const WRITE_CONTAINMENT_REASON = Object.freeze({
  SYMLINK_ESCAPE: "symlink_escape",
  SYMLINK_SCOPE_COMPONENT: "symlink_scope_component",
  SCAN_FAILED: "containment_scan_failed",
});

/** True when `targetAbs` is the root or lives under it (both real/absolute). */
function isContained(rootAbs, targetAbs) {
  const rel = relative(rootAbs, targetAbs);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(".." + sep);
}

/**
 * Resolve an absolute path through the REAL path of its nearest existing
 * ancestor, re-joining the missing trailing components.
 *
 * Why this exists: the root has been `realpath`-resolved, but a symlink's own
 * target spelling may use an OS-level alias of the same tree — on macOS
 * `/var/...` is `/private/var/...` and `/tmp` is `/private/tmp`. Comparing a
 * raw lexical target against the resolved root would call a perfectly
 * INSIDE-pointing absolute symlink an escape and deny a legitimate mutation.
 * Falling back to the lexical path when even the root is unresolvable keeps
 * the decision fail-closed rather than silently permissive.
 */
function resolveThroughExistingAncestor(absPath) {
  let current = absPath;
  const missing = [];
  for (;;) {
    try {
      const base = realpathSync(current);
      return missing.length === 0 ? base : join(base, ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absPath;
      missing.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""));
      current = parent;
    }
  }
}

/**
 * The literal leading segments of a scope PATTERN — the part that must be a
 * real path before any glob metacharacter begins. `src/**` -> ["src"],
 * `lib/utils/retry.ts` -> ["lib","utils","retry.ts"], `**` -> [].
 *
 * Returns null for a pattern that is not a safe repository-relative path
 * (absolute, backslash, NUL, `..`/`.` segment, empty, empty segment), and an
 * EMPTY array when the first segment is already a glob — the caller skips it,
 * because a glob-only boundary is governed by the authority/pattern layer and
 * contributes no literal path to walk.
 */
export function literalBoundaryPrefix(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return null;
  if (pattern.includes("\0") || pattern.includes("\\") || pattern.startsWith("/")) return null;
  // A trailing separator is the documented `src/` ≡ `src` equivalence
  // (canonicalScopeEntry strips it too).
  const cleaned = pattern.replace(/\/+$/, "");
  if (cleaned.length === 0) return null;
  const segments = cleaned.split("/");
  if (segments.includes("..") || segments.includes(".")) return null;
  const out = [];
  for (const segment of segments) {
    if (segment === "") return null;
    if (/[*?[\]{}]/.test(segment)) break;
    out.push(segment);
  }
  return out;
}

/**
 * Walk the materialized worktree of `root` WITHOUT following symlinks and
 * report every symlink whose resolved target escapes `root`.
 *
 * `dangling` is true when the link target does not exist: the violation is
 * decided on the LEXICALLY resolved target — normalized through its nearest
 * existing ancestor, which is exactly what the link will resolve to once the
 * target is created (an OS alias such as macOS `/var` → `/private/var` must not
 * read as an escape against the realpath-resolved root).
 *
 * Fail closed: a directory or entry that cannot be inspected produces a
 * `containment_scan_failed` violation rather than a silent pass. A raced
 * deletion (ENOENT) is skipped — there is nothing left to redirect a write.
 *
 * @returns {{ ok: boolean, violations: object[], scanned: number, root: string|null }}
 */
export function scanSymlinkEscapes(root) {
  const requested = resolve(root);
  let rootReal;
  try {
    rootReal = realpathSync(requested);
  } catch (e) {
    return {
      ok: false,
      violations: [{ path: ".", reason: WRITE_CONTAINMENT_REASON.SCAN_FAILED, detail: `root_unresolvable:${e?.code || e?.message || e}` }],
      scanned: 0,
      root: null,
    };
  }

  const violations = [];
  let scanned = 0;
  const stack = [rootReal];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      if (e?.code === "ENOENT") continue;
      violations.push({ path: relative(rootReal, dir) || ".", reason: WRITE_CONTAINMENT_REASON.SCAN_FAILED, detail: `readdir_failed:${e?.code || e?.message || e}` });
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      let stat;
      try {
        stat = lstatSync(abs);
      } catch (e) {
        if (e?.code === "ENOENT") continue;
        violations.push({ path: relative(rootReal, abs), reason: WRITE_CONTAINMENT_REASON.SCAN_FAILED, detail: `lstat_failed:${e?.code || e?.message || e}` });
        continue;
      }
      scanned += 1;
      if (stat.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(abs);
        } catch (e) {
          violations.push({ path: relative(rootReal, abs), reason: WRITE_CONTAINMENT_REASON.SCAN_FAILED, detail: `readlink_failed:${e?.code || e?.message || e}` });
          continue;
        }
        // Both signals are compared in REAL terms: the root has been
        // realpath-resolved, so a raw lexically-spelled target (macOS
        // `/var` vs `/private/var`) would read as an escape even though it
        // names a path inside the tree.
        const lexical = resolveThroughExistingAncestor(isAbsolute(target) ? resolve(target) : resolve(dirname(abs), target));
        let resolved = lexical;
        let dangling = false;
        try {
          resolved = realpathSync(abs);
        } catch {
          dangling = true;
          // Dangling: the target does not exist, so `realpath` cannot normalize
          // it. The lexical value above is already normalized through its
          // nearest EXISTING ancestor — that is what the link will resolve to
          // once the write creates the target.
        }
        if (!isContained(rootReal, lexical) || !isContained(rootReal, resolved)) {
          violations.push({
            path: relative(rootReal, abs),
            reason: WRITE_CONTAINMENT_REASON.SYMLINK_ESCAPE,
            target,
            resolved_target: resolved,
            dangling,
          });
        }
        // Never traverse a symlink: the link itself is decided above, and its
        // target (inside or outside) is inspected on its own when it is real
        // content under the root.
        continue;
      }
      if (stat.isDirectory()) stack.push(abs);
    }
  }
  return { ok: violations.length === 0, violations, scanned, root: rootReal };
}

/**
 * Audit the declared writable boundary patterns: any symlink COMPONENT of a
 * boundary's literal prefix is a violation, resolvable or dangling. This is
 * the materialized-tree counterpart of canonicalRepositoryPath's component
 * rule — a boundary declared behind a symlink authorizes a path whose real
 * target is decided by that symlink.
 */
export function auditBoundarySymlinkComponents(rootReal, boundaries = []) {
  const violations = [];
  for (const boundary of boundaries ?? []) {
    const segments = literalBoundaryPrefix(boundary);
    if (!segments || segments.length === 0) continue;
    let current = rootReal;
    for (const segment of segments) {
      current = join(current, segment);
      let stat;
      try {
        stat = lstatSync(current);
      } catch (e) {
        // Not materialized yet (ENOENT), or unreachable because an ancestor is
        // a regular file (ENOTDIR, the file-shaped subtree semantics) — nothing
        // can redirect a write there. Anything else is undecidable: fail closed.
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") break;
        violations.push({ path: relative(rootReal, current), boundary: String(boundary), reason: WRITE_CONTAINMENT_REASON.SCAN_FAILED, detail: `lstat_failed:${e?.code || e?.message || e}` });
        break;
      }
      if (stat.isSymbolicLink()) {
        violations.push({ path: relative(rootReal, current), boundary: String(boundary), reason: WRITE_CONTAINMENT_REASON.SYMLINK_SCOPE_COMPONENT });
        break;
      }
    }
  }
  return violations;
}

/**
 * Full write-containment decision for an authorized mutation boundary.
 *
 * @param {object} p
 * @param {string} p.root — the authorized worktree root (the ONLY place an
 *   authorized write may land)
 * @param {string[]} [p.boundaries] — declared writable scope PATTERNS
 *   (`mutation_scope` entries or C3B `allowed_paths` glob patterns)
 * @returns {{ ok: boolean, violations: object[], scanned: number, root: string|null }}
 *   `ok === false` means: do not execute the mutation. Never a grant.
 */
export function verifyWriteContainment({ root, boundaries = [] }) {
  const scan = scanSymlinkEscapes(root);
  const violations = scan.root === null
    ? scan.violations
    : [...auditBoundarySymlinkComponents(scan.root, boundaries), ...scan.violations];
  return { ok: violations.length === 0, violations, scanned: scan.scanned, root: scan.root };
}
