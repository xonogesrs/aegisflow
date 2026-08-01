#!/usr/bin/env node
// normalize-reviewer-json.mjs
//
// Validates a parsed reviewer verdict object against the required schema.
// If the object is missing required fields or has invalid enum values,
// returns a HOLD verdict. NEVER converts invalid output into PASS.
//
// This file is within the separately authorized code-facing repair scope
// established by AURACORE-AUTOLOOP-CODE-FACING-REPAIR-READINESS-REVIEW-1.
// Exercised by existing tests via run-card.mjs subprocess invocation.
// Controlled single-file repairs follow the exact-command discipline.
//
// Usage:
//   npx node normalize-reviewer-json.mjs < parsed.json
//   echo '{...}' | npx node normalize-reviewer-json.mjs

import { readFileSync as _rfs } from "node:fs";

const VERDICTS = new Set(["PASS", "HOLD", "NEEDS_SUPPLEMENT", "REJECT"]);
const CONFIDENCE = new Set(["LOW", "MEDIUM", "HIGH"]);
const NEXT_ACTIONS = new Set(["STOP", "REPAIR", "HUMAN_REVIEW", "COMMIT_CANDIDATE"]);

const FAIL_CLOSED = {
  verdict: "HOLD",
  confidence: "LOW",
  model: "",
  summary: "reviewer output failed schema validation",
  blocking_issues: [],
  required_supplements: [],
  scope_violations: [],
  evidence_gaps: ["reviewer_output_schema_invalid"],
  recommended_next_action: "HUMAN_REVIEW"
};

function normalizeRepair(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (typeof input.blocker_id !== "string" || input.blocker_id.trim().length === 0) return null;
  if (typeof input.blocking_reason !== "string" || input.blocking_reason.trim().length === 0) return null;
  if (typeof input.repairable !== "boolean") return null;
  if (!Array.isArray(input.target_paths) || input.target_paths.length === 0 || !input.target_paths.every((path) => typeof path === "string" && path.trim().length > 0)) return null;
  if (input.requires_authority !== false || input.requires_target_expansion !== false || input.infrastructure_failure !== false) return null;
  return {
    blocker_id: input.blocker_id,
    blocking_reason: input.blocking_reason,
    repairable: input.repairable,
    target_paths: input.target_paths,
    requires_authority: false,
    requires_target_expansion: false,
    infrastructure_failure: false
  };
}

function normalize(input, expectedModel) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...FAIL_CLOSED, summary: "reviewer output is not an object" };
  }
  const issues = [];

  // Reviewer model provenance: if reviewer JSON model is empty but expected
  // model is known from runner invocation, normalize using expected model.
  // If model is non-empty and conflicts with expected, fail closed.
  let model = input.model || "";
  if (typeof model !== "string") model = String(model);
  if (model.length === 0 && expectedModel && expectedModel.length > 0) {
    model = expectedModel;
  } else if (model.length > 0 && expectedModel && expectedModel.length > 0 && model !== expectedModel) {
    issues.push("model_conflict_with_expected");
  }
  if (model.length === 0) {
    issues.push("model_missing_or_invalid");
  }

  if (typeof input.verdict !== "string" || !VERDICTS.has(input.verdict)) {
    issues.push("verdict_missing_or_invalid");
  }
  if (typeof input.confidence !== "string" || !CONFIDENCE.has(input.confidence)) {
    issues.push("confidence_missing_or_invalid");
  }
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    issues.push("summary_missing_or_empty");
  }
  if (
    typeof input.recommended_next_action !== "string" ||
    !NEXT_ACTIONS.has(input.recommended_next_action)
  ) {
    issues.push("recommended_next_action_missing_or_invalid");
  }

  if (issues.length > 0) {
    return {
      ...FAIL_CLOSED,
      summary: "reviewer output failed schema validation: " + issues.join(", "),
      evidence_gaps: ["reviewer_output_schema_invalid", ...issues]
    };
  }

  const out = {
    verdict: input.verdict,
    confidence: input.confidence,
    model: model,
    summary: input.summary,
    blocking_issues: Array.isArray(input.blocking_issues) ? input.blocking_issues.filter((x) => typeof x === "string") : [],
    required_supplements: Array.isArray(input.required_supplements) ? input.required_supplements.filter((x) => typeof x === "string") : [],
    scope_violations: Array.isArray(input.scope_violations) ? input.scope_violations.filter((x) => typeof x === "string") : [],
    evidence_gaps: Array.isArray(input.evidence_gaps) ? input.evidence_gaps.filter((x) => typeof x === "string") : [],
    recommended_next_action: input.recommended_next_action,
    repair: normalizeRepair(input.repair)
  };

  // PASS guard: PASS must be HIGH confidence and have no blocking issues or evidence gaps.
  if (out.verdict === "PASS") {
    if (out.confidence !== "HIGH") {
      return {
        ...FAIL_CLOSED,
        verdict: "HOLD",
        summary: "PASS suppressed: confidence must be HIGH",
        evidence_gaps: ["pass_confidence_not_high"],
        recommended_next_action: "HUMAN_REVIEW"
      };
    }
    if (out.blocking_issues.length > 0 || out.evidence_gaps.length > 0) {
      return {
        ...FAIL_CLOSED,
        verdict: "HOLD",
        summary: "PASS suppressed: blocking issues or evidence gaps present",
        evidence_gaps: ["pass_with_blocking_or_gap"],
        recommended_next_action: "HUMAN_REVIEW"
      };
    }
  }

  return out;
}

function readStdinSync() {
  try {
    return _rfs(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const args = process.argv.slice(2);
  let expectedModel = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--expected-model" && i + 1 < args.length) expectedModel = args[++i];
  }

  const raw = readStdinSync();
  if (!raw || !raw.trim()) {
    process.stdout.write(JSON.stringify({ ...FAIL_CLOSED, summary: "reviewer output empty on stdin" }) + "\n");
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stdout.write(JSON.stringify({ ...FAIL_CLOSED, summary: "reviewer stdin not valid JSON" }) + "\n");
    return;
  }
  const out = normalize(parsed, expectedModel);
  process.stdout.write(JSON.stringify(out) + "\n");
}

main();
