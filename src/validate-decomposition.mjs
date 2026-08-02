// validate-decomposition.mjs
//
// AutoLoop Task Decomposition Validator — Card 1 (repaired)
// F1: parentCard/manifest required for DECOMPOSED
// F2: complete authority checks (mutation_allowed, forbidden_paths, path prefix)
// F3: fixed json-schema-validator (integer, minimum, default)
// F4: coverage role_id must exist, __any__ forbidden in production
// F5: card type vs mutation_allowed consistency
// F6: edge type default = "depends_on"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validate as validateJsonSchema } from "./shared/json-schema-validator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, "schema", "task-decomposition.schema.json");

let _schema = null;
function loadSchema() {
  if (!_schema) _schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  return _schema;
}

const MUTATION_TYPES = new Set(["IMPLEMENTATION", "REPAIR"]);
const NON_MUTATION_TYPES = new Set(["READ_ONLY_AUDIT", "RUNTIME_VALIDATION", "EXTERNAL_REVIEW"]);

/**
 * @param {object} opts
 * @param {object} opts.parentCard — REQUIRED for DECOMPOSED
 * @param {object[]} opts.requirementManifest — REQUIRED for DECOMPOSED; [{ requirement_id, text }]
 * @param {object} opts.decomposition
 * @returns {{ valid: boolean, errors: { rule: string, message: string }[] }}
 */
export function validateDecomposition({ parentCard, requirementManifest, decomposition }) {
  const errors = [];

  if (!decomposition || typeof decomposition !== "object") {
    return { valid: false, errors: [{ rule: "INVALID_INPUT", message: "decomposition must be an object" }] };
  }

  // 1. Schema validation (applies defaults including edge type)
  const schema = loadSchema();
  const schemaResult = validateJsonSchema(schema, decomposition);
  if (!schemaResult.valid) {
    errors.push(...schemaResult.errors.map(e => ({ rule: "SCHEMA", message: e })));
  }

  const verdict = decomposition.verdict;

  // 2. NOT_BENEFICIAL / BLOCKED
  if (verdict === "DECOMPOSITION_NOT_BENEFICIAL" || verdict === "DECOMPOSITION_BLOCKED") {
    if (decomposition.child_cards?.length > 0) {
      errors.push({ rule: "VERDICT_CHILD_CARDS", message: `${verdict} must not have child_cards` });
    }
    if (decomposition.edges?.length > 0) {
      errors.push({ rule: "VERDICT_EDGES", message: `${verdict} must not have edges` });
    }
    return finish(errors);
  }

  if (verdict !== "DECOMPOSED") {
    errors.push({ rule: "UNKNOWN_VERDICT", message: `Unknown verdict: ${verdict}` });
    return finish(errors);
  }

  // ---- F1: DECOMPOSED requires parentCard and manifest ----
  if (!parentCard || typeof parentCard !== "object") {
    errors.push({ rule: "MISSING_PARENT_CARD", message: "DECOMPOSED requires parentCard for authority and coverage checks" });
  }
  if (!requirementManifest || !Array.isArray(requirementManifest) || requirementManifest.length === 0) {
    errors.push({ rule: "MISSING_MANIFEST", message: "DECOMPOSED requires non-empty requirementManifest for coverage check" });
  }

  // 3. Execution policy lock
  const ep = decomposition.execution_policy;
  if (!ep || ep.executor !== "INHERIT_PARENT" || ep.reviewer !== "EXTERNAL_GPT" || ep.multi_model_orchestration !== false) {
    errors.push({ rule: "EXECUTION_POLICY_LOCKED",
      message: "execution_policy must be INHERIT_PARENT / EXTERNAL_GPT / false" });
  }

  // 4. Unique card_id / role_id
  const cardIds = new Set();
  const roleIds = new Set();
  for (const c of decomposition.child_cards) {
    if (!c.card_id || !c.role_id) continue;
    if (cardIds.has(c.card_id)) errors.push({ rule: "DUPLICATE_CARD_ID", message: `Duplicate card_id: ${c.card_id}` });
    if (roleIds.has(c.role_id)) errors.push({ rule: "DUPLICATE_ROLE_ID", message: `Duplicate role_id: ${c.role_id}` });
    // "__any__" is eval-only, forbidden in production decomposition
    if (c.role_id === "__any__") errors.push({ rule: "RESERVED_ROLE_ID", message: "__any__ is reserved for eval matching, not valid in production" });
    cardIds.add(c.card_id);
    roleIds.add(c.role_id);
  }

  // 5. Edge validation (apply type default first)
  for (const e of decomposition.edges) {
    if (!e.type) e.type = "depends_on";
    if (!roleIds.has(e.from)) errors.push({ rule: "UNKNOWN_ROLE_REF", message: `Edge from role not found: ${e.from}` });
    if (!roleIds.has(e.to)) errors.push({ rule: "UNKNOWN_ROLE_REF", message: `Edge to role not found: ${e.to}` });
    if (e.from === e.to) errors.push({ rule: "SELF_DEPENDENCY", message: `Self-dependency: ${e.from}→${e.to}` });
  }

  // Cycle detection
  const cycle = detectCycle(Array.from(roleIds), decomposition.edges);
  if (cycle) errors.push({ rule: "CYCLE_DETECTED", message: `Cycle: ${cycle.join(" → ")}` });

  // ---- F2: Complete authority ----
  if (parentCard) {
    const pCommit = parentCard?.limits?.commit_allowed === true;
    const pPush = parentCard?.limits?.push_allowed === true;
    const pMutation = parentCard?.limits?.mutation_allowed === true;
    const pPaths = parentCard?.scope?.allowed_paths || [];
    const pForbidden = parentCard?.scope?.forbidden_paths || [];

    for (const c of decomposition.child_cards) {
      const auth = c.authority_required || {};
      // commit / push invented
      if (auth.commit_allowed && !pCommit) {
        errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: commit_allowed invented` });
      }
      if (auth.push_allowed && !pPush) {
        errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: push_allowed invented` });
      }
      // mutation_allowed invented
      if (auth.mutation_allowed && !pMutation && c.card_type !== "REPAIR") {
        errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: mutation_allowed invented (parent: false)` });
      }
      // Path validation
      for (const path of (c.allowed_paths || [])) {
        const normalized = path.replace(/\/+$/, ""); // strip trailing slashes
        if (pPaths.length > 0 && !pPaths.some(p => {
          const np = p.replace(/\/+$/, "");
          return normalized === np || normalized.startsWith(np + "/");
        })) {
          errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: path "${path}" not in parent scope` });
        }
        // Check canonical path: no .., no backslash
        if (path.includes("..") || path.includes("\\")) {
          errors.push({ rule: "INVALID_PATH", message: `${c.role_id}: path "${path}" contains .. or backslash` });
        }
      }
      // Child allowed_paths must not intersect parent forbidden_paths
      for (const fp of pForbidden) {
        for (const cp of (c.allowed_paths || [])) {
          const nfp = fp.replace(/\/+$/, "");
          const ncp = cp.replace(/\/+$/, "");
          if (ncp === nfp || ncp.startsWith(nfp + "/")) {
            errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: allowed_path "${cp}" intersects parent forbidden_path "${fp}"` });
          }
        }
      }
    }
  }

  // ---- F5: Card type vs mutation_allowed ----
  for (const c of decomposition.child_cards) {
    const auth = c.authority_required || {};
    if (NON_MUTATION_TYPES.has(c.card_type) && auth.mutation_allowed) {
      errors.push({ rule: "TYPE_MUTATION_MISMATCH", message: `${c.role_id}: ${c.card_type} must not request mutation_allowed` });
    }
    if (MUTATION_TYPES.has(c.card_type) && !auth.mutation_allowed) {
      errors.push({ rule: "TYPE_MUTATION_MISMATCH", message: `${c.role_id}: ${c.card_type} must request mutation_allowed` });
    }
  }

  // ---- F4: Requirement disposition with manifest ----
  if (requirementManifest && requirementManifest.length > 0) {
    // Manifest IDs must be unique
    const manifestSet = new Set();
    for (const r of requirementManifest) {
      if (manifestSet.has(r.requirement_id)) {
        errors.push({ rule: "DUPLICATE_MANIFEST_ID", message: `Duplicate requirement_id in manifest: ${r.requirement_id}` });
      }
      manifestSet.add(r.requirement_id);
    }

    // Collect coverage by category (multiple coverage roles for same ID allowed)
    const coverageIds = new Set();
    const deferredIds = new Set();
    const unresolvedIds = new Set();

    for (const item of (decomposition.coverage_map || [])) {
      if (!item.requirement_id) continue;
      // Coverage role must be a real child card role
      if (!roleIds.has(item.role_id)) {
        errors.push({ rule: "COVERAGE_ORPHAN_ROLE", message: `${item.requirement_id}: role "${item.role_id}" not in child_cards` });
      }
      coverageIds.add(item.requirement_id);
    }
    for (const item of (decomposition.deferred_items || [])) {
      if (item.requirement_id) deferredIds.add(item.requirement_id);
    }
    for (const item of (decomposition.unresolved_items || [])) {
      if (item.requirement_id) unresolvedIds.add(item.requirement_id);
    }

    // Cross-category duplicates forbidden
    for (const id of coverageIds) {
      if (deferredIds.has(id)) errors.push({ rule: "CROSS_CATEGORY_DUPLICATE", message: `${id} in both coverage_map and deferred_items` });
      if (unresolvedIds.has(id)) errors.push({ rule: "CROSS_CATEGORY_DUPLICATE", message: `${id} in both coverage_map and unresolved_items` });
    }
    for (const id of deferredIds) {
      if (unresolvedIds.has(id)) errors.push({ rule: "CROSS_CATEGORY_DUPLICATE", message: `${id} in both deferred_items and unresolved_items` });
    }

    // Every manifest ID must be somewhere
    const allDispositioned = new Set([...coverageIds, ...deferredIds, ...unresolvedIds]);
    for (const id of manifestSet) {
      if (!allDispositioned.has(id)) {
        errors.push({ rule: "MISSING_DISPOSITION", message: `${id} not in coverage/deferred/unresolved` });
      }
    }
    // Unknown IDs (not in manifest)
    for (const id of allDispositioned) {
      if (!manifestSet.has(id)) {
        errors.push({ rule: "UNKNOWN_REQUIREMENT_ID", message: `${id} not in manifest` });
      }
    }
  }

  // 9. Card count
  const count = decomposition.child_cards.length;
  if (count < 1 || count > 7) {
    errors.push({ rule: "CARD_COUNT", message: `DECOMPOSED: 1-7 cards required, got ${count}` });
  }

  return finish(errors);
}

function finish(errors) {
  return { valid: errors.length === 0, errors };
}

function detectCycle(roleIds, edges) {
  const adj = new Map();
  for (const r of roleIds) adj.set(r, []);
  for (const e of edges) if (adj.has(e.from)) adj.get(e.from).push(e.to);
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const r of roleIds) color.set(r, WHITE);
  function dfs(node, path) {
    color.set(node, GRAY); path.push(node);
    for (const next of (adj.get(node) || [])) {
      const c = color.get(next);
      if (c === GRAY) { const s = path.indexOf(next); return [...path.slice(s), next]; }
      if (c === WHITE) { const result = dfs(next, path); if (result) return result; }
    }
    path.pop(); color.set(node, BLACK);
    return null;
  }
  for (const role of roleIds) {
    if (color.get(role) === WHITE) {
      const result = dfs(role, []);
      if (result) return result;
    }
  }
  return null;
}
