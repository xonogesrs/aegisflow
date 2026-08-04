// src/governance/review-history.mjs
//
// Persistent review-history artifact (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 round 3 finding 4). The review round, accumulated repair
// round, prior bundle/findings digests and remaining budget are DERIVED from
// this Controller-maintained artifact — never from Agent-supplied flags.
//
// The artifact lives at <bundleDir>/governance/review-history.json (outside
// the executor's writable scope). It is written ONLY by the Controller
// ingestion entry (scripts/controller/prepare-review-round.mjs); the agent
// production path has no writer.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GOV_HOLD, hold } from "./holds.mjs";
import { validateAgainstSchema } from "./lifecycle-authorization.mjs";
import { assertNotSymlink } from "../c2d/fs-atomic.mjs";

export const REVIEW_HISTORY_SCHEMA = "autoloop.review-history/v1";

export const REVIEW_HISTORY_SCHEMA_JSON = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "schema", "card_id", "review_round", "repair_round",
    "prior_bundle_sha256", "prior_findings_digest", "prior_findings_text",
    "remaining_budget", "updated_at",
  ],
  properties: {
    schema: { type: "string", const: REVIEW_HISTORY_SCHEMA },
    card_id: { type: "string", minLength: 1, maxLength: 128 },
    review_round: { type: "integer", minimum: 1 },
    repair_round: { type: "integer", minimum: 0 },
    prior_bundle_sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    prior_findings_digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
    prior_findings_text: { type: "string", minLength: 1 },
    remaining_budget: { type: "integer", minimum: 0 },
    updated_at: { type: "string", format: "date-time" },
  },
});

export function reviewHistoryPath(bundleDir) {
  return join(bundleDir, "governance", "review-history.json");
}

export function validateReviewHistory(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, errors: ["history:type"] };
  }
  const errors = validateAgainstSchema(REVIEW_HISTORY_SCHEMA_JSON, raw, "history");
  return { valid: errors.length === 0, errors };
}

/** Read + validate the review-history artifact. Missing → null (round 1). */
export function readReviewHistory(bundleDir) {
  const p = reviewHistoryPath(bundleDir);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch {
    throw hold(GOV_HOLD.REVIEW_HISTORY_INVALID, "review-history.json unreadable");
  }
  const check = validateReviewHistory(raw);
  if (!check.valid) throw hold(GOV_HOLD.REVIEW_HISTORY_INVALID, check.errors.join(","));
  return raw;
}

/**
 * Derive the current round context from the history artifact.
 * - no history          → round 1, repair 0, no prior (first review)
 * - history present     → the recorded round is the CURRENT round being
 *   prepared; repair round and prior digests come from the artifact
 */
export function deriveRoundContext(history) {
  if (!history) {
    return {
      review_round: 1,
      repair_round: 0,
      prior_bundle_sha256: "",
      prior_findings_digest: "",
      prior_findings_text: "",
      remaining_budget: 0,
    };
  }
  return {
    review_round: history.review_round,
    repair_round: history.repair_round,
    prior_bundle_sha256: history.prior_bundle_sha256,
    prior_findings_digest: history.prior_findings_digest,
    prior_findings_text: history.prior_findings_text,
    remaining_budget: history.remaining_budget,
  };
}
