// decompose-task.mjs
//
// AutoLoop Card 2 — Shadow-mode task decomposer.
// Wraps provider output through Card 1 validator.
// Single provider call, no child execution, no filesystem mutation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateDecomposition } from "./validate-decomposition.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT = readFileSync(join(HERE, "prompts", "decompose-system.txt"), "utf8");

const MAX_RAW_SUMMARY_LENGTH = 200;

/**
 * @param {object} opts
 * @param {object} opts.parentCard
 * @param {object[]} opts.requirementManifest — [{ requirement_id, text }]
 * @param {{ generate: (opts: { systemPrompt: string, input: string }) => Promise<string|object> }} opts.provider
 * @returns {Promise<object>} structured result
 */
export async function decomposeTask({ parentCard, requirementManifest, provider }) {
  // --- Input validation ---
  const inputErrors = [];
  if (!parentCard || typeof parentCard !== "object") {
    inputErrors.push("parentCard must be a non-null object");
  }
  if (!requirementManifest || !Array.isArray(requirementManifest) || requirementManifest.length === 0) {
    inputErrors.push("requirementManifest must be a non-empty array");
  }
  if (!provider || typeof provider !== "object" || typeof provider.generate !== "function") {
    inputErrors.push("provider must have a generate(systemPrompt, input) function");
  }
  if (inputErrors.length > 0) {
    return {
      status: "INVALID_INPUT",
      reason_code: "DECOMPOSITION_INPUT_INVALID",
      errors: inputErrors
    };
  }

  // --- Build provider input ---
  const providerInput = JSON.stringify({
    parentCard,
    requirementManifest,
    repositoryContext: {
      worktreePath: parentCard.worktree_path || "(unspecified)",
      baseBranch: parentCard.base_branch || "main"
    }
  });

  // --- Single provider call ---
  let rawOutput;
  try {
    rawOutput = await provider.generate({
      systemPrompt: SYSTEM_PROMPT,
      input: providerInput
    });
  } catch (err) {
    return {
      status: "INVALID_PROVIDER_OUTPUT",
      reason_code: "DECOMPOSITION_PROVIDER_CALL_FAILED",
      raw_output_summary: truncate(String(err?.message || "provider error"))
    };
  }

  // --- Parse provider output ---
  let parsed;
  if (typeof rawOutput === "object" && rawOutput !== null && !Array.isArray(rawOutput)) {
    parsed = rawOutput;
  } else if (typeof rawOutput === "string") {
    const trimmed = rawOutput.trim();
    // Reject markdown fences, explanatory text, empty strings
    if (trimmed.startsWith("```")) {
      return {
        status: "INVALID_PROVIDER_OUTPUT",
        reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
        raw_output_summary: truncate(trimmed)
      };
    }
    // Reject if it contains explanatory text before/after JSON
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== 0 || lastBrace !== trimmed.length - 1) {
      return {
        status: "INVALID_PROVIDER_OUTPUT",
        reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
        raw_output_summary: truncate(trimmed)
      };
    }
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {
        status: "INVALID_PROVIDER_OUTPUT",
        reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
        raw_output_summary: truncate(trimmed)
      };
    }
  } else {
    return {
      status: "INVALID_PROVIDER_OUTPUT",
      reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
      raw_output_summary: truncate(String(rawOutput))
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "INVALID_PROVIDER_OUTPUT",
      reason_code: "DECOMPOSITION_PROVIDER_OUTPUT_INVALID_JSON",
      raw_output_summary: truncate(JSON.stringify(parsed))
    };
  }

  // --- Validate through Card 1 validator (only normalization: edge type default) ---
  // Apply edge type default before validation (Card 1 defined normalization)
  if (parsed.edges) {
    for (const e of parsed.edges) {
      if (!e.type) e.type = "depends_on";
    }
  }

  const validation = validateDecomposition({
    parentCard,
    requirementManifest,
    decomposition: parsed
  });

  if (!validation.valid) {
    return {
      status: "INVALID_DECOMPOSITION",
      reason_code: "DECOMPOSITION_VALIDATION_FAILED",
      validation
    };
  }

  return {
    status: "VALID",
    decomposition: parsed,
    validation
  };
}

function truncate(str) {
  if (!str) return "";
  return str.length <= MAX_RAW_SUMMARY_LENGTH ? str : str.slice(0, MAX_RAW_SUMMARY_LENGTH) + "...";
}
