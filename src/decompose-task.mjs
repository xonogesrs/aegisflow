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

  // --- Validate through Card 1 validator (F3: sanitize errors) ---
  const validation = validateDecomposition({ parentCard, requirementManifest, decomposition: parsed });

  if (!validation.valid) {
    return {
      status: "INVALID_DECOMPOSITION",
      reason_code: "DECOMPOSITION_VALIDATION_FAILED",
      validation: {
        valid: false,
        errors: validation.errors.map(e => ({ rule: e.rule, message: sanitizeMessage(e.message) }))
      }
    };
  }

  return { status: "VALID", decomposition: parsed, validation };
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

// --- F3: strip actual values from error messages ---
function sanitizeMessage(msg) {
  if (!msg || typeof msg !== "string") return "";
  // Strip JSON data from schema error messages (const/enum contain actual values)
  return msg.replace(/got .+$/g, "got [REDACTED]").slice(0, 200);
}
