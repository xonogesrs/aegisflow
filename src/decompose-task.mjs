// decompose-task.mjs
//
// AutoLoop Card 2 — Shadow-mode task decomposer (repaired).
// F1: no edge normalization before validator (Card 1 handles it)
// F2: strict manifest item + parentCard validation before provider call
// F3: raw_output_summary replaced with safe metadata

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateDecomposition } from "./validate-decomposition.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(HERE, "prompts", "decompose-system.txt"), "utf8");

/**
 * @param {object} [opts]
 * @param {object} opts.parentCard
 * @param {object[]} opts.requirementManifest
 * @param {{ generate: (opts: { systemPrompt: string, input: string }) => Promise<string|object> }} opts.provider
 */
export async function decomposeTask(opts = {}) {
  const { parentCard, requirementManifest, provider } = opts;

  // --- F2: strict input validation ---
  const inputErrors = [];

  if (!parentCard || typeof parentCard !== "object" || Array.isArray(parentCard)) {
    inputErrors.push("parentCard must be a non-array object");
  }
  if (!requirementManifest || !Array.isArray(requirementManifest) || requirementManifest.length === 0) {
    inputErrors.push("requirementManifest must be a non-empty array");
  } else {
    const seen = new Set();
    for (let i = 0; i < requirementManifest.length; i++) {
      const item = requirementManifest[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        inputErrors.push(`requirementManifest[${i}] must be a non-array object`);
        continue;
      }
      if (!item.requirement_id || typeof item.requirement_id !== "string" || !item.requirement_id.trim()) {
        inputErrors.push(`requirementManifest[${i}].requirement_id must be a non-empty string`);
      } else if (seen.has(item.requirement_id)) {
        inputErrors.push(`requirementManifest[${i}].requirement_id "${item.requirement_id}" is duplicated`);
      } else {
        seen.add(item.requirement_id);
      }
      if (!item.text || typeof item.text !== "string" || !item.text.trim()) {
        inputErrors.push(`requirementManifest[${i}].text must be a non-empty string`);
      }
    }
  }
  if (!provider || typeof provider !== "object" || typeof provider.generate !== "function") {
    inputErrors.push("provider must have a generate(systemPrompt, input) function");
  }

  if (inputErrors.length > 0) {
    return { status: "INVALID_INPUT", reason_code: "DECOMPOSITION_INPUT_INVALID", errors: inputErrors };
  }

  // --- Build provider input (F4: safe serialization) ---
  let providerInput;
  try {
    providerInput = JSON.stringify({
      parentCard,
      requirementManifest,
      repositoryContext: {
        worktreePath: parentCard.worktree_path || "(unspecified)",
        baseBranch: parentCard.base_branch || "main"
      }
    });
  } catch (err) {
    return { status: "INVALID_INPUT", reason_code: "DECOMPOSITION_INPUT_INVALID",
      errors: ["parentCard or requirementManifest cannot be serialized: " + (err?.constructor?.name || "Error")] };
  }

  // --- Single provider call (F3: no raw output in error) ---
  let rawOutput;
  try {
    rawOutput = await provider.generate({ systemPrompt: SYSTEM_PROMPT, input: providerInput });
  } catch (err) {
    return {
      status: "INVALID_PROVIDER_OUTPUT",
      reason_code: "DECOMPOSITION_PROVIDER_CALL_FAILED",
      error_class: err?.constructor?.name || "Error"
    };
  }

  // --- F1+F3: parse safely, no raw content in results ---
  const parseResult = parseProviderOutput(rawOutput);
  if (parseResult.error) {
    return {
      status: "INVALID_PROVIDER_OUTPUT",
      reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
      output_type: parseResult.output_type,
      output_length: parseResult.output_length,
      contains_markdown_fence: parseResult.contains_markdown_fence || false
    };
  }

  const parsed = parseResult.value;

  // --- Normalize canonical aliases (deterministic, one-to-one only) ---
  const normalized = normalizeDecomposition(parsed, parentCard);

  // --- Validate through Card 1 validator (F3: sanitize errors) ---
  const validation = validateDecomposition({ parentCard, requirementManifest, decomposition: normalized });

  if (!validation.valid) {
    return {
      status: "INVALID_DECOMPOSITION",
      reason_code: "DECOMPOSITION_VALIDATION_FAILED",
      validation: {
        valid: false,
        errors: validation.errors.map(({ rule }) => ({ rule }))
      }
    };
  }

  return { status: "VALID", decomposition: normalized, validation };
}

// --- Deterministic canonical normalization (context-dependent aliases) ---
//
// Review CARD_3_25: normalization is CONTEXT-GATED and refuse-to-guess, not
// E4/E7-specific hardcoding:
//  - impl→fix            ONLY in a clear bug-fix context (word-boundary "fix")
//  - impl→migration_file ONLY in a migration context
//  - test→offline_test   ONLY in an OFFLINE migration context (offline/sandbox/
//                        dry-run/fail-closed/離線 signals in parent or test card)
//  - ambiguous context (bug-fix AND migration signals) → refuse role renames
//  - unknown context → no transformation (conformance matcher decides)

// Word-boundary guards prevent false positives like "affix", "prefix", "fixture".
const BUG_FIX_RE = /(^|[^a-z0-9])(bug\s?fix|bugfix|fix)(e[sd]|ing)?([^a-z0-9]|$)/i;
const MIGRATION_RE = /(^|[^a-z0-9])migrat(e|ion|ions|ed|ing)([^a-z0-9]|$)/i;
const OFFLINE_RE = /(^|[^a-z0-9])(offline|離線|sandbox|dry\s?[- ]?run|fail\s?[- ]?closed)([^a-z0-9]|$)/i;
const FAIL_CLOSED_RE = /fail\s?[- ]?closed/i;

function isBugFixContext(parentCard) {
  return BUG_FIX_RE.test(parentCard?.card_body || "");
}

function isMigrationContext(parentCard) {
  const body = parentCard?.card_body || "";
  const scope = (parentCard?.scope?.allowed_paths || []).join(" ");
  return MIGRATION_RE.test(body) || FAIL_CLOSED_RE.test(body) || /\bmigrations?\b/i.test(scope);
}

// A migration is "offline" only when the parent card or the test card itself
// carries an offline/sandbox signal. Online integration validation is NOT renamed.
function isOfflineMigration(parentCard, testCard) {
  const body = parentCard?.card_body || "";
  const goal = testCard?.goal || "";
  const verification = JSON.stringify(testCard?.verification || {});
  return OFFLINE_RE.test(`${body} ${goal} ${verification}`);
}

function normalizeDecomposition(decomp, parentCard) {
  if (!decomp || decomp.verdict !== "DECOMPOSED") return decomp;
  
  const normalized = JSON.parse(JSON.stringify(decomp));
  let roleChanged = false;
  const roleMap = new Map();

  const bugFix = isBugFixContext(parentCard);
  const migration = isMigrationContext(parentCard);

  // Ambiguous context (both bug-fix and migration signals present): refuse to
  // guess — apply NO role renaming. The conformance matcher decides.
  if (bugFix && migration) {
    // still apply the (context-independent) reason_code move below
  } else if (bugFix) {
    // Context-dependent role alias: impl→fix only in a clear bug-fix context
    for (const card of normalized.child_cards) {
      if (card.role_id === "impl") {
        roleMap.set("impl", "fix");
        card.role_id = "fix";
        roleChanged = true;
      }
    }
  } else if (migration) {
    // Migration context: generic→canonical aliases.
    // test→offline_test only when the migration is explicitly offline — never
    // for online/integration validation.
    for (const card of normalized.child_cards) {
      if (card.role_id === "impl" && card.card_type === "IMPLEMENTATION") {
        roleMap.set("impl", "migration_file");
        card.role_id = "migration_file";
        roleChanged = true;
      }
      if (card.role_id === "test" && card.card_type === "RUNTIME_VALIDATION" && isOfflineMigration(parentCard, card)) {
        roleMap.set("test", "offline_test");
        card.role_id = "offline_test";
        roleChanged = true;
      }
    }
  }

  // Update edges and coverage to use canonical role IDs
  if (roleChanged && roleMap.size > 0) {
    for (const edge of normalized.edges) {
      if (roleMap.has(edge.from)) edge.from = roleMap.get(edge.from);
      if (roleMap.has(edge.to)) edge.to = roleMap.get(edge.to);
    }
    for (const cov of normalized.coverage_map) {
      if (roleMap.has(cov.role_id)) cov.role_id = roleMap.get(cov.role_id);
    }
  }

  // Normalize PRODUCTION_RUNTIME_OUT_OF_SCOPE: move from deferred to unresolved
  if (normalized.deferred_items && normalized.deferred_items.length > 0) {
    const toMove = [];
    const remaining = [];
    for (const item of normalized.deferred_items) {
      if (item.reason_code === "PRODUCTION_RUNTIME_OUT_OF_SCOPE") {
        toMove.push({ requirement_id: item.requirement_id, reason_code: item.reason_code, question: item.reason || "Production runtime work outside parent authority" });
      } else {
        remaining.push(item);
      }
    }
    if (toMove.length > 0) {
      normalized.deferred_items = remaining;
      normalized.unresolved_items = [...(normalized.unresolved_items || []), ...toMove];
    }
  }

  return normalized;
}

// --- Safe parsing (F1: handles non-iterable edges, null elements) ---
function parseProviderOutput(raw) {
  if (!raw) {
    return { error: true, output_type: typeof raw };
  }

  let str;
  if (typeof raw === "string") {
    str = raw.trim();
    if (str.startsWith("```")) {
      return { error: true, output_type: "string", output_length: str.length, contains_markdown_fence: true };
    }
    const first = str.indexOf("{");
    const last = str.lastIndexOf("}");
    if (first !== 0 || last !== str.length - 1) {
      return { error: true, output_type: "string", output_length: str.length };
    }
    try {
      return { value: JSON.parse(str), output_type: "json_string", output_length: str.length };
    } catch {
      return { error: true, output_type: "json_parse_error", output_length: str.length };
    }
  }

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return { value: raw, output_type: "object" };
  }

  return { error: true, output_type: Array.isArray(raw) ? "array" : typeof raw };
}
