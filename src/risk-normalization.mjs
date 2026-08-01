// risk-normalization.mjs
//
// Single shared canonical-risk authority for all AutoLoop ingress points
// (manual candidate creation, candidate producer, run-card.mjs card-input
// validation, isHighRiskCard routing). Card
// AURACORE-AUTOLOOP-C4A-TASK-UNDERSTANDING-IMPLEMENTATION-1 §7/§16.
//
// Canonical enum is exactly four values. "MED" is the only accepted alias.
// Anything else (including producer-internal classification labels like
// "GOVERNANCE" or "UNKNOWN") is rejected — callers must fail closed, never
// guess a mapping.

export const CANONICAL_RISK = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

const ALIAS_MAP = Object.freeze({
  LOW: "LOW",
  MED: "MEDIUM",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

export class RiskNormalizationError extends Error {
  constructor(rawValue) {
    super(`unknown risk value: ${JSON.stringify(rawValue)}`);
    this.name = "RiskNormalizationError";
    this.rawValue = rawValue;
  }
}

/**
 * Normalize a raw risk value to one of CANONICAL_RISK. Throws
 * RiskNormalizationError on anything unrecognized — callers must fail
 * closed (HOLD), never substitute a default.
 */
export function normalizeRisk(raw) {
  if (typeof raw !== "string") throw new RiskNormalizationError(raw);
  const key = raw.trim().toUpperCase();
  const v = ALIAS_MAP[key];
  if (!v) throw new RiskNormalizationError(raw);
  return v;
}

/**
 * True if `raw` normalizes to a canonical risk value without throwing.
 */
export function isValidRisk(raw) {
  try {
    normalizeRisk(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * HIGH and CRITICAL both require strict-reviewer routing. Expects an
 * already-canonical value (caller is responsible for normalizing first);
 * returns false for anything not exactly "HIGH" or "CRITICAL", including
 * non-canonical input — never throws.
 */
export function isStrictReviewRisk(risk) {
  return risk === "HIGH" || risk === "CRITICAL";
}
