// src/governance/change-inventory.mjs
//
// Complete change inventory for a review unit (AUTOLOOP-GOVERNANCE-REVIEW-
// UNIT-FINALIZATION-1 §6/§7/§11). Never relies on `git diff base...HEAD
// --name-status` alone: covers committed, staged, tracked-dirty, untracked
// files, renames/deletions, file modes, symlinks (lstat), binaries and
// dependency changes in one canonical inventory.
//
// Identity digests are computed from *actual content* (never trust-input):
//   changedTreeIdentity = sha256(sorted "status\tpath\tcontentSha256\tmode\tsymlink\tbinary")
//   patchSha256         = sha256(sorted "=== FILE path ===\n<content>")
// Both are staging-independent: the same final content produces the same
// identities whether it lives in committed HEAD, the index or the worktree.

import { lstatSync, readFileSync, readlinkSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { digestOfPayload } from "./external-review.mjs";

const DEPENDENCY_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.mod$/,
  /(^|\/)go\.sum$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Pipfile$/,
  /(^|\/)Pipfile\.lock$/,
];

function isDependencyPath(p) {
  return DEPENDENCY_PATTERNS.some((re) => re.test(p));
}

function isBinaryContent(buf) {
  const head = buf.subarray(0, 8000);
  return head.includes(0);
}

/**
 * Build the complete change inventory.
 *
 * @param {object} env
 * @param {(args: string[]) => string} env.git — git runner (throws on error)
 * @param {string} env.cwd — repository root
 * @param {string} [env.baseBranch="main"]
 * @param {object} [env.fs] — injectable fs for tests
 * @returns inventory object
 */
export function buildChangeInventory({ git, cwd, baseBranch = "main", fs = {}, candidateDomain = null, headRef = "HEAD", includeDirty = true }) {
  const lstat = fs.lstat ?? lstatSync;
  const stat = fs.stat ?? statSync;
  const readFile = fs.readFile ?? readFileSync;
  const readlink = fs.readlink ?? readlinkSync;
  const exists = fs.exists ?? existsSync;

  // H2 (Freeze-R2): authority-owned candidate-domain policy. No policy
  // injected → every path is a candidate (byte-identical pre-R2 behavior).
  // `candidateDomain` is the classifier returning "INCLUDE"|"EXCLUDE".
  const isCandidate = typeof candidateDomain === "function"
    ? (p) => candidateDomain(p) !== "EXCLUDE"
    : () => true;

  // REVIEW-PROVENANCE-MODEL-V2 (§1.3/§9): the committed range may be a
  // FROZEN head (headRef = the candidate commit) instead of live HEAD — the
  // frozen-range identity recompute must be immune to unrelated live work.
  // includeDirty=false restricts the inventory to the committed range only
  // (no working-tree/staged/untracked reads) for that recompute.
  const committedLines = git(["diff", "--name-status", "--no-renames", `${baseBranch}...${headRef}`]).split("\n").filter(Boolean);
  const dirtyLines = includeDirty ? git(["diff", "--name-status", "--no-renames", "HEAD"]).split("\n").filter(Boolean) : []; // tracked, staged+unstaged vs HEAD
  const stagedPaths = includeDirty ? git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).filter(isCandidate) : [];
  const untracked = includeDirty ? git(["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean).filter(isCandidate) : [];
  const head = git(["rev-parse", headRef]).trim();
  const baseHead = git(["rev-parse", baseBranch]).trim();
  const branch = git(["branch", "--show-current"]).trim();

  // Rename detection for REPORTING (the identity canonical form stays on the
  // stable no-renames view: a rename is both a deletion and an addition).
  const renames = [];
  const collectRenames = (lines, source) => {
    for (const line of lines) {
      if (!line.startsWith("R")) continue;
      const parts = line.split("\t");
      if (parts.length >= 3) {
        renames.push({ from: parts[1], to: parts[2], similarity: parts[0], source });
      }
    }
  };
  collectRenames(git(["diff", "-M", "--name-status", `${baseBranch}...${headRef}`]).split("\n").filter(Boolean), "committed");
  collectRenames(git(["diff", "-M", "--name-status", "HEAD"]).split("\n").filter(Boolean), "dirty");

  // index modes for tracked files (100644 / 100755)
  const indexModes = new Map();
  for (const line of git(["ls-files", "-s"]).split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length === 2) indexModes.set(parts[1], parts[0].split(" ")[0]);
  }

  // base-tree modes: exec-bit changes are judged RELATIVE TO BASE (so a
  // committed mode change is still detected, not just an index/worktree one).
  const baseModes = new Map();
  for (const line of git(["ls-tree", "-r", baseBranch]).split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length === 2) baseModes.set(parts[1], parts[0].split(" ")[0]);
  }

  const parseStatusLines = (lines) => lines.map((l) => {
    const parts = l.split("\t");
    const status = parts[0];
    const path = parts[parts.length - 1];
    return { status, path };
  });

  const seen = new Set();
  const entries = new Map();
  const record = ({ status, path }) => {
    // H2 (Freeze-R2): single-point exclusion — generated governance/evidence
    // classes never enter the candidate inventory (committed+dirty+untracked).
    if (!isCandidate(path)) return;
    seen.add(path);
    entries.set(path, { path, status });
  };
  for (const c of parseStatusLines(committedLines)) record(c);
  for (const d of parseStatusLines(dirtyLines)) record(d);
  for (const u of untracked) record({ status: "ADDED", path: u });

  const symlinks = [];
  const binaries = [];
  const execBitChanges = [];
  const dependencyChanges = [];
  const deleted = [];
  const final = [];

  for (const { path, status } of entries.values()) {
    const abs = join(cwd, path);
    let contentSha256 = "MISSING";
    let mode = indexModes.get(path) ?? "";
    let symlink = false;
    let binary = false;
    let execBitChanged = false;
    let present = false;
    try {
      const info = lstat(abs);
      present = true;
      symlink = info.isSymbolicLink();
      const fileMode = info.mode & 0o777;
      if (info.isSymbolicLink()) {
        contentSha256 = sha256Text(readlink(abs));
      } else if (info.isFile()) {
        const buf = readFile(abs);
        contentSha256 = sha256Text(buf);
        binary = isBinaryContent(buf);
        if (!mode) mode = fileMode & 0o111 ? "100755" : "100644";
      }
      if (baseModes.has(path)) {
        // relative to BASE: catches committed mode changes (index == worktree)
        const baseHasExec = baseModes.get(path) === "100755";
        const workHasExec = (fileMode & 0o111) !== 0;
        execBitChanged = baseHasExec !== workHasExec;
      } else if (indexModes.has(path)) {
        // file not in base but tracked: catch dirty index-vs-worktree changes
        const indexHasExec = indexModes.get(path) === "100755";
        const workHasExec = (fileMode & 0o111) !== 0;
        execBitChanged = indexHasExec !== workHasExec;
      }
    } catch {
      present = false; // deleted (or unreadable)
      deleted.push(path);
    }
    const netStatus = !present ? "DELETED" : (status === "ADDED" || !indexModes.has(path) ? "ADDED" : "MODIFIED");
    if (present) {
      if (symlink) symlinks.push(path);
      if (binary) binaries.push(path);
      if (execBitChanged) execBitChanges.push(path);
      if (isDependencyPath(path)) dependencyChanges.push(path);
    }
    final.push({ path, status: netStatus, contentSha256, mode, symlink, binary, execBitChanged, present });
  }

  final.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Human-readable patch text: committed + staged + unstaged + untracked.
  const parts = [];
  const committedPatch = git(["diff", `${baseBranch}...${headRef}`]).trim();
  if (committedPatch) parts.push(`--- COMMITTED DIFF (${baseBranch}...${headRef}) ---\n${committedPatch}`);
  const stagedPatch = git(["diff", "--cached"]).trim();
  if (stagedPatch) parts.push(`--- STAGED DIFF (HEAD...index) ---\n${stagedPatch}`);
  const unstagedPatch = git(["diff"]).trim();
  if (unstagedPatch) parts.push(`--- UNSTAGED DIFF (index...worktree) ---\n${unstagedPatch}`);
  const RULE = "-".repeat(80);
  for (const path of untracked) {
    const abs = join(cwd, path);
    try {
      const info = lstat(abs);
      if (info.isSymbolicLink()) {
        parts.push(`${RULE}\nFILE: ${path}\nSTATUS: ADDED (symlink)\nTARGET: ${readlink(abs)}\n${RULE}`);
      } else if (info.isFile()) {
        parts.push(`${RULE}\nFILE: ${path}\nSTATUS: ADDED\n${RULE}\n${readFile(abs, "utf8")}`);
      }
    } catch { /* skip unreadable */ }
  }
  const patchText = parts.join("\n\n");

  // C1A (Freeze-R2): semantic candidate identity — drop Git transport `status`.
  // Same bytes + path + mode + symlink + binary → same identity regardless of
  // untracked/staged/committed transport state. Deletion stays detectable via
  // contentSha256="MISSING".
  const changedTreeIdentity = digestOfPayload(
    final.map((e) => `${e.path}\t${e.contentSha256}\t${e.mode}\t${e.symlink ? 1 : 0}\t${e.binary ? 1 : 0}`).join("\n"),
  );
  const patchSha256 = digestOfPayload(
    final.map((e) => `=== FILE ${e.path} ===\n${e.contentSha256 === "MISSING" ? "" : e.contentSha256}`).join("\n"),
  );

  return {
    entries: final,
    changedPaths: final.map((e) => e.path),
    deleted,
    symlinks,
    binaries,
    execBitChanges,
    dependencyChanges,
    renames,
    untracked,
    stagedPaths,
    committedPaths: committedLines.map((l) => l.split("\t").pop()).filter(Boolean).filter(isCandidate),
    dirtyPaths: dirtyLines.map((l) => l.split("\t").pop()).filter(Boolean).filter(isCandidate),
    committedCount: committedLines.map((l) => l.split("\t").pop()).filter(isCandidate).length,
    stagedCount: stagedPaths.length,
    dirtyCount: dirtyLines.map((l) => l.split("\t").pop()).filter(isCandidate).length,
    untrackedCount: untracked.length,
    patchText,
    patchLines: patchText.split("\n").length,
    changedTreeIdentity,
    patchSha256,
    repositoryRoot: cwd,
    baseBranch,
    head,
    baseHead,
    branch,
  };
}

/** Expand "~" and resolve a path against cwd for bundle-path comparison. */
export function expandPath(p, cwd) {
  if (typeof p !== "string" || p.length === 0) return "";
  // absolute paths pass through untouched (join() would append them wrong)
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) return p;
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return join(cwd, p);
}

/** Verify an inventory's identities against a fresh inventory (drift check). */
export function inventoryMatches(expected, actual) {
  return expected.changedTreeIdentity === actual.changedTreeIdentity &&
    expected.patchSha256 === actual.patchSha256;
}

export { relative };
