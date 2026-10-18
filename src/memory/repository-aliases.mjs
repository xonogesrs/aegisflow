// src/memory/repository-aliases.mjs
//
// CBM repository-identity lineage (card: CANONICAL_PUBLICATION_AND_CBM_IDENTITY_REPAIR_1).
//
// WHY THIS EXISTS
// ---------------
// `repositoryIdentity = sha256(canonical({ remote, canonicalPath }))` is FROZEN:
// it is an input to recordId/logicalKey, so changing the formula would rewrite
// the identity of every stored record. But the formula has a real consequence —
// moving a checkout, or renaming the remote, silently produces a NEW identity
// and every record bound to the old one becomes unreachable:
//
//   stored   a8d935…  { remote: git@github.com:xonogesrs/autoloop.git,
//                       canonicalPath: /Volumes/NVM2T/Development/autoloop }
//   stored   29dcbe…  { remote: git@github.com:xonogesrs/autoloop.git,
//                       canonicalPath: /tmp/autoloop }
//   current  e3cc9b…  { remote: git@github.com:xonogesrs/aegisflow.git,
//                       canonicalPath: /Volumes/NVM2T/Development/repos/autoloop }
//
// All three are the same repository (the legacy remote `autoloop.git` and
// `aegisflow.git` resolve to byte-identical refs; the trees recorded in the
// store are present in the canonical object database). The records were correct
// when written; the identity input moved underneath them.
//
// WHAT THIS MODULE DOES — AND REFUSES TO DO
// -----------------------------------------
// It never rewrites a record, never merges scopes and never guesses. A lineage
// edge is a DECLARATION bound to evidence, recorded in a machine-local registry
// beside the store:
//
//   {
//     schema: "aegisflow.memory-repository-aliases/v1",
//     aliases: [
//       { canonical: <hex64>, alias: <hex64>, evidence: <string>, recordedAt: <iso> }
//     ]
//   }
//
// Resolution is one-directional: an alias is visible ONLY to the canonical
// identity it was declared for. Nothing is symmetrical, nothing is transitive
// across unrelated canonicals, and an undeclared identity stays isolated —
// exactly the previous behaviour.
//
// The registry is local state, not repository content: a checkout must not be
// able to widen its own visibility by shipping an alias table.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REPOSITORY_ALIAS_SCHEMA = "aegisflow.memory-repository-aliases/v1";
export const REPOSITORY_ALIAS_FILE = "repository-aliases.json";

const HEX64 = /^[0-9a-f]{64}$/;

/** Default registry location: beside the store it qualifies. */
export function aliasFileFor(stateRoot) {
  return join(stateRoot, REPOSITORY_ALIAS_FILE);
}

/** An empty registry — the answer for every machine that declares nothing. */
export function emptyAliasRegistry() {
  return { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [] };
}

/**
 * Validate a registry. Malformed content is REJECTED (never partially honoured):
 * a wrong alias table must not silently widen or narrow retrieval.
 *
 * @returns {{ valid: boolean, errors: string[], registry: object }}
 */
export function validateAliasRegistry(input) {
  const errors = [];
  const registry = { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [] };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["registry_not_object"], registry: emptyAliasRegistry() };
  }
  if (input.schema !== REPOSITORY_ALIAS_SCHEMA) {
    errors.push(`schema_invalid:${String(input.schema)}`);
  }
  if (!Array.isArray(input.aliases)) {
    errors.push("aliases_not_array");
    return { valid: false, errors, registry: emptyAliasRegistry() };
  }
  const seen = new Set();
  for (const [i, entry] of input.aliases.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`aliases[${i}]_not_object`);
      continue;
    }
    const { canonical, alias, evidence, recordedAt } = entry;
    if (typeof canonical !== "string" || !HEX64.test(canonical)) {
      errors.push(`aliases[${i}].canonical_must_be_hex64`);
      continue;
    }
    if (typeof alias !== "string" || !HEX64.test(alias)) {
      errors.push(`aliases[${i}].alias_must_be_hex64`);
      continue;
    }
    if (alias === canonical) {
      errors.push(`aliases[${i}].alias_equals_canonical`);
      continue;
    }
    if (typeof evidence !== "string" || evidence.trim().length === 0) {
      errors.push(`aliases[${i}].evidence_required`);
      continue;
    }
    if (typeof recordedAt !== "string" || recordedAt.trim().length === 0) {
      errors.push(`aliases[${i}].recordedAt_required`);
      continue;
    }
    const key = `${canonical}>${alias}`;
    if (seen.has(key)) {
      errors.push(`aliases[${i}]_duplicate`);
      continue;
    }
    seen.add(key);
    registry.aliases.push({ canonical, alias, evidence, recordedAt });
  }
  return { valid: errors.length === 0, errors, registry };
}

/**
 * Read the registry for a store root. A missing file is the normal case and
 * yields an empty registry; an UNREADABLE or MALFORMED file fails closed to
 * "declared nothing" and reports why — it never guesses a lineage, because a
 * guessed lineage would merge two repositories' memory.
 *
 * @returns {{ ok: boolean, registry: object, reason: string|null }}
 */
export function readAliasRegistry(file) {
  if (!file || !existsSync(file)) return { ok: true, registry: emptyAliasRegistry(), reason: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, registry: emptyAliasRegistry(), reason: `alias_registry_unreadable:${String(e?.message ?? e).slice(0, 120)}` };
  }
  const v = validateAliasRegistry(parsed);
  if (!v.valid) {
    return { ok: false, registry: emptyAliasRegistry(), reason: `alias_registry_invalid:${v.errors.slice(0, 5).join(";")}` };
  }
  return { ok: true, registry: v.registry, reason: null };
}

/**
 * The lineage visible to `canonical`: the canonical identity first, then the
 * declared aliases in recorded order. Deprecated identities only — nothing is
 * inferred, and an alias declared for a DIFFERENT canonical is not included.
 */
export function repositoryLineageFor(registry, canonical) {
  if (typeof canonical !== "string" || !HEX64.test(canonical)) return [];
  const out = [canonical];
  for (const entry of registry?.aliases ?? []) {
    if (entry.canonical !== canonical) continue;
    if (out.includes(entry.alias)) continue;
    out.push(entry.alias);
  }
  return out;
}
