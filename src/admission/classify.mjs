// src/admission/classify.mjs
//
// TA-2 — pure Task Classifier（AUTOLOOP-TA2 section D）.
//
// DETERMINISTIC / SIDE-EFFECT-FREE / LOCAL / TESTABLE classification:
//   size  = pure function of 10 dimension scores（0..3 each, rubric-scored）
//   risk  = canonical enum LOW/MEDIUM/HIGH/CRITICAL via the single existing
//           risk authority（src/risk-normalization.mjs）— no second enum
//   profile = the (size × risk) cell of the TA-1 admission decision matrix
//
// No LLM-only hidden judgment is an authority: classification evidence
//（dimension scores + risk signals）is INPUT; the classifier only projects
// and verifies it. A deterministic keyword scanner（task-statement evidence
// extraction）is provided as one optional evidence source — it is still pure
// and local. Token-count-only heuristics are never used as a classifier.
//
// Fail-closed（A3）: insufficient evidence -> under_classified -> risk >=
// MEDIUM（never LOW）; unknown risk signal -> escalate; risk NEVER lowered by
// size（A2; monotonic escalation E）.

import { normalizeRisk, isStrictReviewRisk } from "../risk-normalization.mjs";

export const CLASSIFIER_VERSION = "1.0.0";

export const SIZE_TIERS = Object.freeze(["XS", "S", "M", "L", "XL"]);
export const RISK_TIERS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const PROFILES = Object.freeze(["FAST_PATH", "STANDARD", "MEDIUM", "MEDIUM_LARGE", "LARGE_LOW", "HIGH", "CRITICAL"]);

// ── Size model（TA-1 ta1-task-size-model.json）───────────────────────────
export const SIZE_DIMENSIONS = Object.freeze([
  "affected_files",
  "affected_subsystems",
  "dependency_depth",
  "ambiguity",
  "expected_execution_steps",
  "verification_burden",
  "external_dependencies",
  "concurrency_potential",
  "statefulness",
  "rollback_complexity",
]);

const SIZE_TIER_RANGES = Object.freeze([
  { tier: "XS", min: 0, max: 4, maxDim: 1 },
  { tier: "S", min: 5, max: 9, maxDim: 2 },
  { tier: "M", min: 10, max: 15, maxDim: 3 },
  { tier: "L", min: 16, max: 22, maxDim: 3 },
  { tier: "XL", min: 23, max: 30, maxDim: 3 },
]);

// ── Risk signal model（TA-1 ta1-risk-tier-model.json）────────────────────
export const RISK_SIGNALS = Object.freeze([
  { id: "RS.DESTRUCTIVE_WRITE", class: "CRITICAL" },
  { id: "RS.SECRETS", class: "CRITICAL" },
  { id: "RS.CREDENTIALS", class: "CRITICAL" },
  { id: "RS.NETWORK_REMOTE", class: "HIGH" },
  { id: "RS.PRODUCTION_RUNTIME", class: "CRITICAL" },
  { id: "RS.PERSISTENCE", class: "HIGH" },
  { id: "RS.DATABASE_MUTATION", class: "CRITICAL" },
  { id: "RS.SECURITY_BOUNDARY", class: "HIGH" },
  { id: "RS.CONCURRENCY", class: "HIGH" },
  { id: "RS.LIFECYCLE_GOVERNANCE", class: "HIGH" },
  { id: "RS.SELF_MODIFICATION", class: "CRITICAL" },
  { id: "RS.MEMORY_WRITEBACK", class: "CRITICAL" },
  { id: "RS.IRREVERSIBLE", class: "CRITICAL" },
  { id: "RS.EXTERNAL_PUBLISHING", class: "CRITICAL" },
  { id: "RS.COMMIT_PUSH_MERGE", class: "CRITICAL" },
]);

/**
 * Deterministic keyword scanner over the FULL task statement（never a
 * summary）— one optional evidence source. Output is a list of signals with
 * triggered + reason. Pure / local / no LLM.
 */
const SIGNAL_PATTERNS = Object.freeze([
  { id: "RS.DESTRUCTIVE_WRITE", patterns: [/\brm\s+-rf\b/, /\btruncate\b/i, /\bdestructive migration\b/i, /\boverwrite (production|artifact)\b/i, /\bdelete (all|everything)\b/i] },
  { id: "RS.SECRETS", patterns: [/\bsecret\b/i, /\brotate (key|token|secret)\b/i, /\bcredentials?\b/i, /\bapi[ _-]?key\b/i, /\bpassword\b/i, /\btoken\b/i] },
  { id: "RS.CREDENTIALS", patterns: [/\benv(?:ironment)? file\b/i, /\b\.npmrc\b/, /\bcloud key\b/i, /\bssh key\b/i] },
  { id: "RS.NETWORK_REMOTE", patterns: [/\bgit push\b/, /\bgit pull\b/, /\bgit fetch\b/, /\bgit merge\b/, /\bcurl\b/i, /\bwget\b/i, /\bfetch from remote\b/i, /\bexternal api\b/i, /\bhttps?:\/\//i] },
  { id: "RS.PRODUCTION_RUNTIME", patterns: [/\bproduction (scheduler|runtime|service)\b/i, /\blive service\b/i, /\bdeploy to\b/i] },
  { id: "RS.PERSISTENCE", patterns: [/\bmigration\b/i, /\bschema change\b/i, /\bcheckpoint format\b/i, /\bdurable store\b/i, /\bsqlite\b/i, /\bjournal\b/i] },
  { id: "RS.DATABASE_MUTATION", patterns: [/\bdelete (a |one |rows? )?\s*(row|rows|record|records)\b/i, /\bupdate .*database\b/i, /\binsert into\b/i, /\bdrop table\b/i, /\bupdate\s+\w+\s+set\b/i, /\bmemory store\b/i] },
  { id: "RS.SECURITY_BOUNDARY", patterns: [/\bauth[ntz]+/i, /\bsandbox\b/i, /\bpermission model\b/i, /\bsecret scan\b/i, /\btool policy\b/i, /\bsecurity\b/i] },
  { id: "RS.CONCURRENCY", patterns: [/\blease\b/i, /\block\b/i, /\bparallel worker\b/i, /\bwriter serialization\b/i, /\brace condition\b/i, /\bconcurr\w+\b/i] },
  { id: "RS.LIFECYCLE_GOVERNANCE", patterns: [/\blifecycle[- ]authorization\b/i, /\breview[- ]unit\b/i, /\bcloseout\b/i, /\bdelivery\b/i, /\breview[- ]bundle\b/i, /\bgovernance\b/i, /\binventory\b/i] },
  { id: "RS.SELF_MODIFICATION", patterns: [/\bmodify (its own )?(admission|scheduler|authority|governance)\b/i, /\bself[- ]modification\b/i, /\bedit (its own )?admission\b/i] },
  { id: "RS.MEMORY_WRITEBACK", patterns: [/\bmemory write[- ]back\b/i, /\bwrite[- ]back\b/i, /\bpersist (memory|record)s?\b/i] },
  { id: "RS.IRREVERSIBLE", patterns: [/\birreversible\b/i, /\bone[- ]way migration\b/i, /\bno rollback\b/i] },
  { id: "RS.EXTERNAL_PUBLISHING", patterns: [/\brelease\b/i, /\bpublish\b/i, /\bdeploy\b/i, /\bnpm publish\b/i] },
  { id: "RS.COMMIT_PUSH_MERGE", patterns: [/\bcommit\b/i, /\bpush\b/i, /\bmerge\b/i, /\btag\b/i, /\bseal\b/i] },
]);

/**
 * Extract risk signal evidence from the full task statement（deterministic）.
 * Returns the canonical signal inventory with triggered flags + reasons.
 */
export function scanRiskSignals(taskText) {
  const text = String(taskText ?? "");
  return RISK_SIGNALS.map((s) => {
    const pats = SIGNAL_PATTERNS.find((p) => p.id === s.id)?.patterns ?? [];
    const hits = pats.filter((p) => p.test(text)).map((p) => p.source);
    return {
      signal_id: s.id,
      class: s.class,
      triggered: hits.length > 0,
      reason: hits.length ? `matched ${hits.join(", ")}` : "no matching wording",
    };
  });
}

/**
 * Classify SIZE from per-dimension evidence.
 *
 * @param {object} dimensionScores — { [dimension]: { score: 0..3, reasons:
 *        string[] } }; missing dimensions contribute 0 AND set
 *        under_classified=true（never silently assumed — fail-closed）.
 * @returns {{ size: string, total_score: number, under_classified: boolean,
 *            dimensions: object, tierRange: string }}
 */
export function classifySize(dimensionScores = {}) {
  const dimensions = {};
  let total = 0;
  let underClassified = false;
  for (const dim of SIZE_DIMENSIONS) {
    const ev = dimensionScores?.[dim];
    const score = ev && typeof ev === "object" && Number.isInteger(ev.score) && ev.score >= 0 && ev.score <= 3 ? ev.score : 0;
    const reasons = ev && Array.isArray(ev.reasons) && ev.reasons.length > 0 ? ev.reasons : [];
    if (!ev || !Number.isInteger(ev.score) || reasons.length === 0) underClassified = true;
    total += score;
    dimensions[dim] = { score, reasons };
  }
  let size = null;
  let tierRange = "";
  const maxDimScore = Math.max(...Object.values(dimensions).map((d) => d.score));
  for (const t of SIZE_TIER_RANGES) {
    if (total >= t.min && total <= t.max) {
      if (t.maxDim === 3 || maxDimScore <= t.maxDim) {
        size = t.tier;
        tierRange = `${t.min}..${t.max}`;
        break;
      }
      // Score range matches this tier but a dimension exceeds its per-
      // dimension cap（e.g. total 7 with one dimension = 3）— fail-closed
      // escalate to the next tier rather than mislabel S.
      size = t.tier === "XS" ? "S" : t.tier === "S" ? "M" : "L";
      tierRange = `${t.min}..${t.max} (dimension-cap escalated)`;
      break;
    }
  }
  // Total beyond 30 is impossible（10 × 3）; guard anyway.
  if (!size) size = "XL";
  return { size, total_score: total, under_classified: underClassified, dimensions, tierRange };
}

/**
 * Classify RISK from signal evidence（canonical enum; monotonic escalation;
 * fail-closed）.
 *
 * @param {Array<{signal_id, class, triggered, reason?}>} signals — canonical
 *        signal inventory; class must be a canonical risk tier.
 * @param {object} [opts] — { evidenceSufficient: bool } — when false ->
 *        minimum MEDIUM（NEG12）.
 * @returns {{ risk: string, signals: object[], escalation_log: string[],
 *            strict_reviewer_routing: boolean }}
 */
export function classifyRisk(signals = [], { evidenceSufficient = true } = {}) {
  const escalationLog = [];
  const canonical = [];
  for (const s of signals ?? []) {
    if (!s || typeof s !== "object") continue;
    const klass = normalizeRisk(s.class); // throws on unknown — fail closed
    canonical.push({
      signal_id: String(s.signal_id ?? ""),
      class: klass,
      triggered: s.triggered === true,
      reason: typeof s.reason === "string" ? s.reason : "",
    });
  }
  const criticalCount = canonical.filter((s) => s.triggered && s.class === "CRITICAL").length;
  const highCount = canonical.filter((s) => s.triggered && s.class === "HIGH").length;
  const mediumCount = canonical.filter((s) => s.triggered && s.class === "MEDIUM").length;

  let risk = "LOW";
  const apply = (tier, why) => {
    if (RISK_TIERS.indexOf(tier) > RISK_TIERS.indexOf(risk)) {
      risk = tier;
      escalationLog.push(why);
    }
  };

  // Monotonic escalation ladder（TA-1 escalation rules）.
  if (criticalCount >= 1) apply("CRITICAL", `any CRITICAL signal -> CRITICAL (${criticalCount})`);
  if (highCount >= 2) apply("CRITICAL", `>=2 HIGH signals -> CRITICAL (${highCount})`);
  if (highCount >= 1) apply("HIGH", `>=1 HIGH signal -> HIGH (${highCount})`);
  if (mediumCount >= 2) apply("HIGH", `>=2 MEDIUM signals -> HIGH (${mediumCount})`);
  if (mediumCount >= 1) apply("MEDIUM", `>=1 MEDIUM signal -> MEDIUM (${mediumCount})`);
  if (!evidenceSufficient) apply("MEDIUM", "insufficient evidence -> minimum MEDIUM, never LOW (NEG12 fail-closed)");

  return {
    risk,
    signals: canonical,
    escalation_log: escalationLog,
    strict_reviewer_routing: isStrictReviewRisk(risk),
  };
}

/**
 * Profile cell from (size, risk) — TA-1 admission decision matrix. Risk is
 * primary; size refines weight within the tier.
 */
export function profileFor({ size, risk }) {
  const r = normalizeRisk(risk); // fail-closed on unknown risk
  if ((size === "XS" || size === "S") && r === "LOW") return "FAST_PATH";
  if (r === "CRITICAL") return "CRITICAL";
  if (r === "HIGH") return "HIGH";
  if (r === "MEDIUM") return size === "L" || size === "XL" ? "MEDIUM_LARGE" : "MEDIUM";
  // LOW
  if (size === "M") return "STANDARD";
  return "LARGE_LOW"; // L / XL low
}

/**
 * FAST_PATH eligibility（TA-1 ta1-small-task-fast-path.json）: size XS/S AND
 * risk LOW AND evidence sufficient AND no triggered signal at all.
 */
export function isFastPathEligible({ size, risk, under_classified = false, signals = [] }) {
  if (under_classified) return false;
  if (!(size === "XS" || size === "S")) return false;
  if (risk !== "LOW") return false;
  if ((signals ?? []).some((s) => s.triggered)) return false;
  return true;
}

/**
 * Fail-closed profile escalation（TA-1 small-task fast path + escalation
 * ladder）: under_classified evidence with ambiguity >= 1 escalates off the
 * fast path / light path — never default-allow（NEG12）.
 */
export function escalateProfile(profile, { under_classified = false, ambiguityScore = 0 }) {
  if (!under_classified || ambiguityScore < 1) return profile;
  // FAST_PATH/STANDARD/MEDIUM -> at least MEDIUM; research-first is
  // triggered by ambiguity (TA-1 research gate).
  if (profile === "FAST_PATH") return "STANDARD";
  if (profile === "STANDARD") return "MEDIUM";
  return profile;
}

/**
 * One-shot classification（size + risk + profile + fast-path eligibility）.
 * Evidence is INPUT（dimension scores + risk signal inventory）— the
 * classifier never invents it.
 */
export function classify({ dimensionScores = {}, riskSignals = [], evidenceSufficient = true } = {}) {
  const sizeResult = classifySize(dimensionScores);
  const riskResult = classifyRisk(riskSignals, { evidenceSufficient });
  const baseProfile = profileFor({ size: sizeResult.size, risk: riskResult.risk });
  const profile = escalateProfile(baseProfile, { under_classified: sizeResult.under_classified, ambiguityScore: sizeResult.dimensions.ambiguity?.score ?? 0 });
  return {
    classifier_version: CLASSIFIER_VERSION,
    size: sizeResult.size,
    size_details: sizeResult,
    risk: riskResult.risk,
    risk_details: riskResult,
    profile,
    fast_path_eligible: isFastPathEligible({ size: sizeResult.size, risk: riskResult.risk, under_classified: sizeResult.under_classified, signals: riskResult.signals }),
    reasons: [
      `size=${sizeResult.size} (score ${sizeResult.total_score})`,
      `risk=${riskResult.risk} (${riskResult.signals.filter((s) => s.triggered).length} triggered signals)`,
      `profile=${profile}${profile === baseProfile ? "" : ` (escalated from ${baseProfile}: under-classified + ambiguity)`}`,
    ],
  };
}
