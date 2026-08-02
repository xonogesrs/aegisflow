// validate-decomposition.mjs
//
// AutoLoop Task Decomposition Validator — Card 1
// Validates decomposition output against schema + governance rules.
//
// Interface:
//   validateDecomposition({ parentCard, requirementManifest, decomposition })
//
// Returns { valid: boolean, errors: [{ rule, message }] }

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

export function validateDecomposition({ parentCard, requirementManifest, decomposition }) {
  const errors = [];

  if (!decomposition || typeof decomposition !== "object") {
    return { valid: false, errors: [{ rule: "INVALID_INPUT", message: "decomposition must be an object" }] };
  }

  // 1. Schema validation
  const schema = loadSchema();
  const schemaResult = validateJsonSchema(schema, decomposition);
  if (!schemaResult.valid) {
    errors.push(...schemaResult.errors.map(e => ({ rule: "SCHEMA", message: e })));
  }

  const verdict = decomposition?.verdict;

  // 2. NOT_BENEFICIAL / BLOCKED must not have child_cards or edges
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

  // 3. Execution policy lock
  const ep = decomposition.execution_policy;
  if (!ep || ep.executor !== "INHERIT_PARENT" || ep.reviewer !== "EXTERNAL_GPT" || ep.multi_model_orchestration !== false) {
    errors.push({ rule: "EXECUTION_POLICY_LOCKED",
      message: "execution_policy must be { executor: INHERIT_PARENT, reviewer: EXTERNAL_GPT, multi_model_orchestration: false }" });
  }

  // 4. Unique card_id / role_id
  const cardIds = new Set();
  const roleIds = new Set();
  for (const c of decomposition.child_cards) {
    if (cardIds.has(c.card_id)) errors.push({ rule: "DUPLICATE_CARD_ID", message: `Duplicate card_id: ${c.card_id}` });
    if (roleIds.has(c.role_id)) errors.push({ rule: "DUPLICATE_ROLE_ID", message: `Duplicate role_id: ${c.role_id}` });
    cardIds.add(c.card_id);
    roleIds.add(c.role_id);
  }

  // 5. Edge validation
  for (const e of decomposition.edges) {
    if (!roleIds.has(e.from)) errors.push({ rule: "UNKNOWN_ROLE_REF", message: `Edge from role not found: ${e.from}` });
    if (!roleIds.has(e.to)) errors.push({ rule: "UNKNOWN_ROLE_REF", message: `Edge to role not found: ${e.to}` });
    if (e.from === e.to) errors.push({ rule: "SELF_DEPENDENCY", message: `Self-dependency: ${e.from}→${e.to}` });
  }

  // Cycle detection
  const cycle = detectCycle(Array.from(roleIds), decomposition.edges);
  if (cycle) errors.push({ rule: "CYCLE_DETECTED", message: `Cycle: ${cycle.join(" → ")}` });

  // 6. Authority: child ≤ parent
  if (parentCard) {
    const pCommit = parentCard?.limits?.commit_allowed === true;
    const pPush = parentCard?.limits?.push_allowed === true;
    const pPaths = parentCard?.scope?.allowed_paths || [];

    for (const c of decomposition.child_cards) {
      const auth = c.authority_required || {};
      if (auth.commit_allowed && !pCommit) {
        errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: commit_allowed invented` });
      }
      if (auth.push_allowed && !pPush) {
        errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: push_allowed invented` });
      }
      for (const path of (c.allowed_paths || [])) {
        if (pPaths.length && !pPaths.some(p => path === p || path.startsWith(p + "/"))) {
          errors.push({ rule: "AUTHORITY_EXPANSION", message: `${c.role_id}: path "${path}" not in parent scope` });
        }
      }
    }
  }

  // 7. EXTERNAL_REVIEW must not request mutation authority
  for (const c of decomposition.child_cards) {
    if (c.card_type === "EXTERNAL_REVIEW") {
      const a = c.authority_required || {};
      if (a.mutation_allowed) errors.push({ rule: "REVIEW_MUTATION", message: `${c.role_id}: EXTERNAL_REVIEW must not request mutation` });
      if (a.commit_allowed) errors.push({ rule: "REVIEW_MUTATION", message: `${c.role_id}: EXTERNAL_REVIEW must not request commit` });
    }
  }

  // 8. Requirement disposition (with manifest)
  if (requirementManifest?.length) {
    const manifestIds = new Set(requirementManifest.map(r => r.requirement_id));
    const seen = new Map();

    for (const item of (decomposition.coverage_map || [])) {
      if (item.requirement_id) {
        if (seen.has(item.requirement_id)) {
          errors.push({ rule: "DUPLICATE_DISPOSITION", message: `${item.requirement_id} in coverage_map already in ${seen.get(item.requirement_id)}` });
        } else seen.set(item.requirement_id, "coverage_map");
      }
    }
    for (const item of (decomposition.deferred_items || [])) {
      if (item.requirement_id) {
        if (seen.has(item.requirement_id)) {
          errors.push({ rule: "DUPLICATE_DISPOSITION", message: `${item.requirement_id} in deferred already in ${seen.get(item.requirement_id)}` });
        } else seen.set(item.requirement_id, "deferred_items");
      }
    }
    for (const item of (decomposition.unresolved_items || [])) {
      if (item.requirement_id) {
        if (seen.has(item.requirement_id)) {
          errors.push({ rule: "DUPLICATE_DISPOSITION", message: `${item.requirement_id} in unresolved already in ${seen.get(item.requirement_id)}` });
        } else seen.set(item.requirement_id, "unresolved_items");
      }
    }

    for (const id of manifestIds) {
      if (!seen.has(id)) errors.push({ rule: "MISSING_DISPOSITION", message: `${id} not in coverage/deferred/unresolved` });
    }
    for (const [id, loc] of seen) {
      if (!manifestIds.has(id)) errors.push({ rule: "UNKNOWN_REQUIREMENT_ID", message: `${id} in ${loc} not in manifest` });
    }
  }

  // 9. Card count
  const count = decomposition.child_cards.length;
  if (count < 1 || count > 7) {
    errors.push({ rule: "CARD_COUNT", message: `DECOMPOSED: 1-7 cards required, got ${count}` });
  }

  return finish(errors);
}

// --- Helpers ---

function finish(errors) {
  return { valid: errors.length === 0, errors };
}

function detectCycle(roleIds, edges) {
  const adj = new Map();
  for (const r of roleIds) adj.set(r, []);
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const r of roleIds) color.set(r, WHITE);

  function dfs(node, path) {
    color.set(node, GRAY);
    path.push(node);
    for (const next of (adj.get(node) || [])) {
      const c = color.get(next);
      if (c === GRAY) {
        const start = path.indexOf(next);
        return [...path.slice(start), next];
      }
      if (c === WHITE) {
        const result = dfs(next, path);
        if (result) return result;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const r of roleIds) {
    if (color.get(r) === WHITE) {
      const result = dfs(r, []);
      if (result) return result;
    }
  }
  return null;
}
