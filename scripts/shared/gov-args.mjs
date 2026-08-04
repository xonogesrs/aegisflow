// scripts/shared/gov-args.mjs
// Shared argv parsing AND governance CLI helpers (git runner, authority
// loading, inventory, review context, secret scan). Single authorized shared
// module under scripts/shared/ per AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §3. No dependencies beyond node builtins.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { normalizeAuthority, readLifecycleAuthorization, validateAuthorityRecord } from "../../src/governance/lifecycle-authorization.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { computeReviewContext } from "../../src/governance/review-context.mjs";
import { scanForSecrets } from "../../src/evidence/run-evidence-store.mjs";

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

/** Load the authorization record (exec-dir artifact or authority file). */
export function loadRecord(flags) {
  if (flags.execDir) return readLifecycleAuthorization(flags.execDir);
  if (!flags.authorityFile) throw new Error("--exec-dir or --authority-file required");
  const raw = JSON.parse(readFileSync(flags.authorityFile, "utf8"));
  if (!validateAuthorityRecord(raw).valid) {
    if (raw.lifecycle_authorization) return raw;
    throw new Error("authority file does not validate against lifecycle-authorization.schema.json");
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
export function contextFor({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity, record }) {
  // gates need the record-level bindings (repository/branch/base) for identity
  const bound = record
    ? { ...authority, repository: record.repository ?? "", branch: record.branch ?? "", base: record.base ?? "" }
    : authority;
  return computeReviewContext({ authority: bound, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity });
}

/** Reject explicitly self-declared PASS flags (fail-closed, §9). */
export function rejectSelfDeclaredFlags(flags) {
  const hits = [];
  if (flags.externalReviewStatus && flags.externalReviewStatus !== "PENDING") hits.push("--external-review-status (self-declared PASS rejected)");
  if (flags.reviewedArtifactIdentity) hits.push("--reviewed-artifact-identity (caller-supplied identity rejected)");
  if (flags.externalReviewStatus === "PASS") hits.push("--external-review-status PASS (self-declared)");
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
