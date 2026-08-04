// scripts/shared/gov-args.mjs
// Shared argv parsing AND governance CLI helpers (git runner, authority
// loading, inventory, review context, secret scan). Single authorized shared
// module under scripts/shared/ per AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §3. No dependencies beyond node builtins.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeAuthority, readLifecycleAuthorization, validateAuthorityRecord, scopeCovers } from "../../src/governance/lifecycle-authorization.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { computeReviewContext } from "../../src/governance/review-context.mjs";
import { scanForSecrets } from "../../src/evidence/run-evidence-store.mjs";
import { GOV_HOLD, hold } from "../../src/governance/holds.mjs";

export function parseArgs(argv) {
  const out = { flags: {} };
  const set = (key, value) => {
    out.flags[key] = value;
    // camelCase alias for kebab-case keys (--authority-file → authorityFile)
    if (key.includes("-")) {
      const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out.flags[camel] = value;
    }
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      set(a.slice(2, eq), a.slice(eq + 1));
    } else {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
    }
  }
  return out;
}

export function asBool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  return v === "true" || v === "1" || v === "yes";
}

export function splitList(v) {
  if (v === undefined || v === null) return [];
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Governance CLI helpers (git / authority / inventory / context / secrets)
// ---------------------------------------------------------------------------

export function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

/** Load the authorization record (exec-dir artifact or authority file).
 * Fail-closed: a record that does not validate against the schema is
 * REJECTED (no fallback to an unvalidated block — top-level bindings such
 * as repository / worktree / branch / base / scope / bundle_path / run_id
 * are mandatory and must pass validation). */
export function loadRecord(flags) {
  if (flags.execDir) return readLifecycleAuthorization(flags.execDir);
  if (!flags.authorityFile) throw new Error("--exec-dir or --authority-file required");
  const raw = JSON.parse(readFileSync(flags.authorityFile, "utf8"));
  const check = validateAuthorityRecord(raw);
  if (!check.valid) {
    throw new Error(`authority record rejected: ${check.errors.join(",")}`);
  }
  return raw;
}

/** Load the lifecycle_authorization block (normalized) from a record. */
export function loadAuthority(flags) {
  const record = loadRecord(flags);
  return normalizeAuthority(record.lifecycle_authorization);
}

/** Build the change inventory for a repo. */
export function buildInventory(cwd, baseBranch = "main") {
  return buildChangeInventory({ git: (args) => git(args, cwd), cwd, baseBranch });
}

/** Recompute the review context (identities) for gates. */
export function contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record, priorBundleSha256, priorFindingsDigest }) {
  // gates need the record-level repository binding for identity; branch/base
  // come from the ACTUAL inventory (never from the record — that would mask
  // branch drift; assertLiveBindings already verified actual == record).
  const bound = record
    ? { ...authority, repository: record.repository ?? "" }
    : authority;
  return computeReviewContext({
    authority: bound, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity,
    priorBundleSha256, priorFindingsDigest,
  });
}

/**
 * Fail-closed binding of the actual execution environment to the authority
 * record (round 3 finding 2). Called by EVERY governance CLI entry
 * (checkpoint / bundle / integration / push / Draft PR).
 *
 *   realpath(cwd) == record.worktree
 *   actual branch  == record.branch
 *   rev-parse(record.base) == record.base_head
 *   baseBranch     == record.base
 *   cardId / runId == record.card_id / record.run_id
 */
export function assertLiveBindings({ record, cwd, inventory, baseBranch, cardId, runId, flags = {} }) {
  const violations = [];
  try {
    const cwdReal = realpathSync(cwd);
    const wtReal = record.worktree ? realpathSync(resolve(record.worktree)) : "";
    if (wtReal && cwdReal !== wtReal) violations.push(`worktree: cwd ${cwdReal} != record ${wtReal}`);
  } catch (e) {
    violations.push(`worktree: cannot resolve (${e.message})`);
  }
  if (record.branch && inventory.branch && record.branch !== inventory.branch) {
    violations.push(`branch: actual ${inventory.branch} != record ${record.branch}`);
  }
  if (record.base && record.base_head) {
    try {
      const actualBaseHead = git(["rev-parse", record.base], cwd).trim();
      if (actualBaseHead !== record.base_head) violations.push(`base_head: ${record.base} is ${actualBaseHead} != ${record.base_head}`);
    } catch {
      violations.push(`base_head: cannot resolve base ${record.base}`);
    }
  }
  if (record.base && baseBranch && baseBranch !== record.base) violations.push(`base: ${baseBranch} != record ${record.base}`);
  const cliCard = flags.cardId ?? cardId;
  const cliRun = flags.runId ?? runId;
  if (record.card_id && cliCard && cliCard !== record.card_id) violations.push(`card_id: ${cliCard} != record ${record.card_id}`);
  if (record.run_id && cliRun && cliRun !== record.run_id) violations.push(`run_id: ${cliRun} != record ${record.run_id}`);
  if (violations.length > 0) {
    throw hold(GOV_HOLD.LIVE_BINDING_MISMATCH, violations.join("; "));
  }
}

/**
 * Fail-closed writable-scope enforcement (round 3 finding 3): every changed
 * path in the FULL inventory must be covered by the authorized paths.
 */
export function assertScopeCoversInventory(inventory, authorizedPaths) {
  const outside = (inventory.changedPaths || []).filter((p) => !scopeCovers(p, authorizedPaths));
  if (outside.length > 0) {
    throw hold(GOV_HOLD.GOVERNANCE_SCOPE_EXPANSION_REQUIRED, `changed paths outside authorized scope: ${outside.join(",")}`);
  }
}

/**
 * Precise remote-URL authorization (round 3 finding 6): substring checks are
 * bypassable (evil.example/xonogesrs/autoloop, /tmp/xonogesrs/autoloop-
 * backup.git). Parse the URL, require an allowed host/transport and an EXACT
 * trailing `owner/repository` match.
 */
export function remoteUrlMatchesAuthorizedRepository(url, repoId) {
  if (typeof url !== "string" || url.length === 0) return false;
  const target = String(repoId || "").replace(/\.git$/, "");
  if (!target || !target.includes("/")) return false;
  let host = "";
  let path = "";
  const s = url.replace(/\.git$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    // https://host/owner/repo  (or file:///abs/path)
    const rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const slash = rest.indexOf("/");
    host = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
  } else if (/^git@/.test(s)) {
    // git@host:owner/repo
    const rest = s.replace(/^git@/, "");
    const colon = rest.indexOf(":");
    host = colon === -1 ? "" : rest.slice(0, colon);
    path = colon === -1 ? rest : rest.slice(colon + 1);
  } else {
    // local absolute path: /tmp/.../owner/repo  → host empty, path = the path
    path = s.replace(/^\//, "");
  }
  const allowedHosts = ["github.com", "git@github.com"];
  if (host && !allowedHosts.includes(host)) return false;
  // extract the trailing owner/repository segments exactly
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  const ownerRepo = segments.slice(-2).join("/");
  return ownerRepo === target;
}

/** Reject explicitly self-declared PASS flags (fail-closed, §9). */
export function rejectSelfDeclaredFlags(flags) {
  const hits = [];
  if (flags.externalReviewStatus && flags.externalReviewStatus !== "PENDING") hits.push("--external-review-status (self-declared PASS rejected)");
  if (flags.reviewedArtifactIdentity) hits.push("--reviewed-artifact-identity (caller-supplied identity rejected)");
  if (flags.externalReviewStatus === "PASS") hits.push("--external-review-status PASS (self-declared)");
  if (flags.resultFile) hits.push("--result-file (caller-supplied result artifact rejected — fixed controller path only)");
  return hits;
}

/** Real secret scan over changed file contents (fail-closed; no trust-input). */
export function scanChangedFilesForSecrets(cwd, changedPaths) {
  const found = [];
  const walk = (rel) => {
    const abs = join(cwd, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const entry of readdirSync(abs)) walk(join(rel, entry));
      return;
    }
    if (!statSync(abs).isFile()) return;
    if (/^node_modules\//.test(rel)) return;
    const text = readFileSync(abs, "utf8");
    const result = scanForSecrets(text);
    for (const hit of (result?.matches ?? [])) found.push(`${rel}: ${hit}`);
  };
  for (const p of changedPaths) walk(p.replace(/\/$/, ""));
  return found;
}
