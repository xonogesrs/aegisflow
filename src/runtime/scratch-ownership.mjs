// AegisFlow scratch ownership boundary.
//
// Callers provide only a scratch namespace. AegisFlow owns one deterministic
// child per execution and may recursively delete that child only after its
// marker, path, and repository binding verify.

import { createHash, randomBytes } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

export const SCRATCH_OWNERSHIP_SCHEMA = "autoloop.scratch-ownership/v1";
export const SCRATCH_OWNER_DIR = ".autoloop-owned";
export const SCRATCH_OWNER_MARKER = ".autoloop-owner.json";
const authorityTokens = new Map();

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function authorityDigest(token) {
  if (typeof token !== "string" || token.length < 32) {
    throw new ScratchOwnershipError("scratch authority token required");
  }
  return createHash("sha256").update(token).digest("hex");
}

export class ScratchOwnershipError extends Error {
  constructor(reason) {
    super(`scratchRoot ownership: ${reason}`);
    this.name = "ScratchOwnershipError";
    this.reason = reason;
  }
}

export function normalizeScratchPreservePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScratchOwnershipError("preserved scratch path required");
  }
  if (isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
    throw new ScratchOwnershipError("preserved scratch path must be relative and traversal-free");
  }
  const normalized = value.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new ScratchOwnershipError("preserved scratch path invalid");
  }
  return normalized;
}

function rejectPathInput(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ScratchOwnershipError(`${label} required`);
  }
  if (!isAbsolute(value)) throw new ScratchOwnershipError(`${label} must be absolute`);
  if (value.split(/[\\/]+/).includes("..")) {
    throw new ScratchOwnershipError(`${label} must not contain .. traversal`);
  }
  const absolute = resolve(value);
  if (absolute === parse(absolute).root) {
    throw new ScratchOwnershipError(`${label} may not be filesystem root`);
  }
  return absolute;
}

function assertDirectory(path, label) {
  let stat;
  try { stat = lstatSync(path); } catch (e) {
    throw new ScratchOwnershipError(`${label} unavailable: ${e?.code || e?.message || e}`);
  }
  if (stat.isSymbolicLink()) throw new ScratchOwnershipError(`${label} may not be symlink`);
  if (!stat.isDirectory()) throw new ScratchOwnershipError(`${label} must be directory`);
}

function assertNoSymlinkComponents(path, label) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (e) {
      throw new ScratchOwnershipError(`${label} component unavailable: ${e?.code || e?.message || e}`);
    }
    if (stat.isSymbolicLink()) throw new ScratchOwnershipError(`${label} contains symlink component`);
  }
}

function assertNoExistingSymlinkComponents(path, label) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = relative(current, absolute).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch (e) {
      if (e?.code === "ENOENT") return;
      throw new ScratchOwnershipError(`${label} component unavailable: ${e?.code || e?.message || e}`);
    }
    if (stat.isSymbolicLink()) {
      const target = realpathSync(current);
      const trustedMacAlias = process.platform === "darwin"
        && ((current === "/var" && target === "/private/var") || (current === "/tmp" && target === "/private/tmp"));
      if (!trustedMacAlias) throw new ScratchOwnershipError(`${label} contains symlink component`);
    }
  }
}

function assertNotGitBoundary(path, label) {
  let current = resolve(path);
  while (true) {
    const marker = join(current, ".git");
    try {
      const stat = lstatSync(marker);
      if (stat.isFile() || stat.isDirectory()) throw new ScratchOwnershipError(`${label} may not be repository/worktree path`);
    } catch (e) {
      if (e instanceof ScratchOwnershipError) throw e;
      if (e?.code !== "ENOENT") throw e;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function canonicalPathForContainment(path) {
  let probe = resolve(path);
  const missing = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    missing.unshift(basename(probe));
    probe = parent;
  }
  let canonical = realpathSync(probe);
  for (const part of missing) canonical = join(canonical, part);
  return canonical;
}

function canonicalNamespace(scratchRoot, repo = null) {
  const input = rejectPathInput(scratchRoot, "scratchRoot");
  assertNoExistingSymlinkComponents(input, "scratchRoot");
  assertNotGitBoundary(input, "scratchRoot");
  if (repo && isWithin(canonicalPathForContainment(input), repo)) {
    throw new ScratchOwnershipError("scratchRoot may not be repository root or descendant");
  }
  try {
    assertDirectory(input, "scratchRoot");
  } catch (e) {
    if (!(e instanceof ScratchOwnershipError) || !String(e.reason).includes("unavailable: ENOENT")) throw e;
    mkdirSync(input, { recursive: true });
    assertDirectory(input, "scratchRoot");
  }
  assertNoExistingSymlinkComponents(input, "scratchRoot");
  const canonical = realpathSync(input);
  assertNoSymlinkComponents(canonical, "scratchRoot");
  assertNotGitBoundary(canonical, "scratchRoot");
  if (repo && isWithin(canonical, repo)) {
    throw new ScratchOwnershipError("scratchRoot may not be repository root or descendant");
  }
  return { input, canonical };
}

function canonicalRepository(repoPath) {
  if (repoPath == null) return null;
  const input = rejectPathInput(repoPath, "repoPath");
  assertNoExistingSymlinkComponents(input, "repoPath");
  assertDirectory(input, "repoPath");
  const canonical = realpathSync(input);
  assertNoSymlinkComponents(canonical, "repoPath");
  return canonical;
}

function isWithin(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== "..");
}

function ownershipKey(executionId, repoPath) {
  if (typeof executionId !== "string" || executionId.length === 0) {
    throw new ScratchOwnershipError("executionId required");
  }
  return createHash("sha256")
    .update(`${executionId}\0${repoPath ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

function deriveCandidate({ scratchRoot, executionId, repoPath, createNamespace }) {
  const repo = canonicalRepository(repoPath);
  const namespace = createNamespace ? canonicalNamespace(scratchRoot, repo) : (() => {
    const input = rejectPathInput(scratchRoot, "scratchRoot");
    assertNoExistingSymlinkComponents(input, "scratchRoot");
    assertNotGitBoundary(input, "scratchRoot");
    if (repo && isWithin(canonicalPathForContainment(input), repo)) {
      throw new ScratchOwnershipError("scratchRoot may not be repository root or descendant");
    }
    assertDirectory(input, "scratchRoot");
    const canonical = realpathSync(input);
    assertNoSymlinkComponents(canonical, "scratchRoot");
    assertNotGitBoundary(canonical, "scratchRoot");
    return { input, canonical };
  })();
  if (repo && isWithin(namespace.canonical, repo)) {
    throw new ScratchOwnershipError("scratchRoot may not be repository root or descendant");
  }

  const key = ownershipKey(executionId, repo);
  const ownerParent = join(namespace.canonical, SCRATCH_OWNER_DIR);
  const ownedRoot = join(ownerParent, key);
  if (!isWithin(ownedRoot, namespace.canonical) || (repo && isWithin(ownedRoot, repo))) {
    throw new ScratchOwnershipError("derived owned root outside allowed containment");
  }
  return { namespace, repo, ownerParent, ownedRoot, key };
}

function readOwnerMarker(ownedRoot) {
  const marker = join(ownedRoot, SCRATCH_OWNER_MARKER);
  let stat;
  try { stat = lstatSync(marker); } catch (e) {
    throw new ScratchOwnershipError(`owner marker unavailable: ${e?.code || e?.message || e}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ScratchOwnershipError("owner marker must be regular file");
  }
  let record;
  try { record = JSON.parse(readFileSync(marker, "utf8")); } catch {
    throw new ScratchOwnershipError("owner marker malformed");
  }
  if (!record || record.schema !== SCRATCH_OWNERSHIP_SCHEMA) {
    throw new ScratchOwnershipError("owner marker schema mismatch");
  }
  return record;
}

export function assertOwnedScratchRoot({ ownedRoot, executionId = null, repoPath = null, authorityToken = null } = {}) {
  const input = rejectPathInput(ownedRoot, "owned scratch root");
  assertDirectory(input, "owned scratch root");
  assertNoSymlinkComponents(input, "owned scratch root");
  const canonical = realpathSync(input);
  if (basename(dirname(canonical)) !== SCRATCH_OWNER_DIR || !/^[0-9a-f]{32}$/.test(basename(canonical))) {
    throw new ScratchOwnershipError("target is not an AegisFlow owned execution child");
  }
  const marker = readOwnerMarker(canonical);
  if (marker.owner !== "autoloop") {
    throw new ScratchOwnershipError("owner marker authority mismatch");
  }
  if (typeof marker.authorityDigest !== "string") {
    throw new ScratchOwnershipError("owner marker authority binding missing");
  }
  if (authorityToken != null && marker.authorityDigest !== authorityDigest(authorityToken)) {
    throw new ScratchOwnershipError("owner marker authority token mismatch");
  }
  const stat = lstatSync(canonical);
  if (marker.uid != null && currentUid() != null && marker.uid !== currentUid()) {
    throw new ScratchOwnershipError("owner marker uid mismatch");
  }
  if (marker.uid != null && stat.uid != null && marker.uid !== stat.uid) {
    throw new ScratchOwnershipError("owned scratch root uid mismatch");
  }
  if (marker.ownedRoot !== canonical || marker.ownershipKey !== basename(canonical)) {
    throw new ScratchOwnershipError("owner marker path binding mismatch");
  }
  if (typeof marker.namespacePath !== "string") {
    throw new ScratchOwnershipError("owner marker namespace binding missing");
  }
  const namespaceInput = rejectPathInput(marker.namespacePath, "owner marker namespace");
  assertNoExistingSymlinkComponents(namespaceInput, "owner marker namespace");
  assertDirectory(namespaceInput, "owner marker namespace");
  const namespace = realpathSync(namespaceInput);
  assertNoSymlinkComponents(namespace, "owner marker namespace");
  assertNotGitBoundary(namespace, "owner marker namespace");
  if (canonical !== join(namespace, SCRATCH_OWNER_DIR, basename(canonical))) {
    throw new ScratchOwnershipError("owner marker namespace path binding mismatch");
  }
  if (executionId != null && marker.executionId !== executionId) {
    throw new ScratchOwnershipError("owner marker execution binding mismatch");
  }
  if (repoPath != null) {
    const repo = canonicalRepository(repoPath);
    if (marker.repoPath !== repo) throw new ScratchOwnershipError("owner marker repository binding mismatch");
  }
  return canonical;
}

export function prepareOwnedScratchRoot({ scratchRoot, executionId, repoPath = null, authorityToken = null } = {}) {
  const candidate = deriveCandidate({ scratchRoot, executionId, repoPath, createNamespace: true });
  if (authorityToken != null) authorityDigest(authorityToken);
  let created = false;
  try {
    try {
      const ownerParentStat = lstatSync(candidate.ownerParent);
      if (ownerParentStat.isSymbolicLink()) throw new ScratchOwnershipError("scratch owner parent may not be symlink");
      if (!ownerParentStat.isDirectory()) throw new ScratchOwnershipError("scratch owner parent must be directory");
    } catch (e) {
      if (e instanceof ScratchOwnershipError) throw e;
      if (e?.code !== "ENOENT") throw e;
    }
    mkdirSync(candidate.ownerParent, { recursive: true, mode: 0o700 });
    assertNoSymlinkComponents(candidate.ownerParent, "scratch owner parent");
    mkdirSync(candidate.ownedRoot, { mode: 0o700 });
    created = true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw new ScratchOwnershipError(`owned child create failed: ${e?.code || e?.message || e}`);
  }

  try {
    assertDirectory(candidate.ownedRoot, "owned scratch root");
    assertNoSymlinkComponents(candidate.ownedRoot, "owned scratch root");
  } catch (e) {
    if (created) { try { rmSync(candidate.ownedRoot, { recursive: true, force: true }); } catch { /* bounded newly-created child */ } }
    throw e;
  }

  const markerPath = join(candidate.ownedRoot, SCRATCH_OWNER_MARKER);
  let token = authorityToken ?? authorityTokens.get(candidate.ownedRoot) ?? null;
  if (created) {
    token = token ?? randomBytes(32).toString("hex");
    const record = {
      schema: SCRATCH_OWNERSHIP_SCHEMA,
      owner: "autoloop",
      uid: currentUid(),
      authorityDigest: authorityDigest(token),
      executionId,
      repoPath: candidate.repo,
      namespacePath: candidate.namespace.canonical,
      ownedRoot: candidate.ownedRoot,
      ownershipKey: candidate.key,
    };
    try {
      writeFileSync(markerPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (e) {
      authorityTokens.delete(candidate.ownedRoot);
      try { rmSync(candidate.ownedRoot, { recursive: true, force: true }); } catch { /* bounded newly-created child */ }
      throw new ScratchOwnershipError(`owner marker create failed: ${e?.code || e?.message || e}`);
    }
  } else if (!token) {
    throw new ScratchOwnershipError("existing owned child requires authority token");
  }

  authorityTokens.set(candidate.ownedRoot, token);
  const verified = assertOwnedScratchRoot({ ownedRoot: candidate.ownedRoot, executionId, repoPath, authorityToken: token });
  const marker = readOwnerMarker(verified);
  if (marker.namespacePath !== candidate.namespace.canonical) {
    throw new ScratchOwnershipError("owner marker namespace binding mismatch");
  }
  return verified;
}

// Validate namespace/identity and compute child path without creating the
// destructive target. Durable callers use this before their first checkpoint.
export function planOwnedScratchRoot({ scratchRoot, executionId, repoPath = null } = {}) {
  return deriveCandidate({ scratchRoot, executionId, repoPath, createNamespace: true }).ownedRoot;
}

export function getScratchAuthorityToken(ownedRoot) {
  return authorityTokens.get(resolve(ownedRoot)) ?? null;
}

export function removeOwnedScratchRoot({ scratchRoot, executionId, repoPath = null, authorityToken = null } = {}) {
  const token = authorityToken ?? authorityTokens.get(resolve(scratchRoot)) ?? null;
  if (!token) throw new ScratchOwnershipError("scratch authority token required for deletion");
  const candidate = deriveCandidate({ scratchRoot, executionId, repoPath, createNamespace: false });
  if (!existsSync(candidate.ownedRoot)) return { removed: false, path: candidate.ownedRoot };
  const ownedRoot = assertOwnedScratchRoot({ ownedRoot: candidate.ownedRoot, executionId, repoPath, authorityToken: token });
  rmSync(ownedRoot, { recursive: true, force: true });
  authorityTokens.delete(candidate.ownedRoot);
  return { removed: true, path: ownedRoot };
}
