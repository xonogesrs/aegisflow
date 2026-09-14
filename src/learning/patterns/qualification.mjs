// src/learning/patterns/qualification.mjs
//
// R2 O5 — INDEPENDENT QUALIFICATION (Stage-F R2 chain; [CT §1 R5]).
//
// Produces the qualification RESULT (pure data) a PATTERN write-back
// candidate binds: root cause, mechanism, applicability, counterexamples,
// transfer potential, required lifecycle level — plus the independent
// reviewer identity and the blocking-findings list (PHASE-3 STEP 1b).
//
// Hard rules (frozen):
//   - V5 SELF-APPROVAL FENCE: the qualification identity MUST differ from the
//     executor identity. A qualification record minted by the executor (or by
//     any identity equal to the consolidation/candidate producer) is
//     REJECTED — retry NEVER launders the rejection (same candidate identity
//     ⇒ idempotent rejection; only a genuinely independent reviewer identity
//     is a legal retry input);
//   - blockingFindings list carried verbatim (non-empty ⇒ not qualified);
//   - required lifecycle level is DATA ONLY (the R14 admission-element input
//     N-2c will consume). NO §5 lifecycle edge exists in this module;
//   - deterministic: same inputs ⇒ same qualification digest;
//   - NON-AUTHORITATIVE: result is candidate input data, never authority.
//
// PROHIBITED HERE: activation · adoption · promotion · policy mutation ·
// harness/session/provider identity inputs.

import { createHash } from "node:crypto";
import { recursiveCanonicalJson } from "../../memory/canonical.mjs";

export const QUALIFICATION_SCHEMA = "autoloop.pattern-qualification/v1";

export const QUALIFICATION_REJECT = Object.freeze({
  SELF_APPROVAL: "QUALIFICATION_SELF_APPROVAL_REJECTED",
  MALFORMED: "QUALIFICATION_MALFORMED",
  BLOCKING_FINDINGS: "QUALIFICATION_BLOCKING_FINDINGS_PRESENT",
});

export const REQUIRED_LIFECYCLE_LEVELS = Object.freeze([
  "ADVISORY",
  "REQUIRED_QUESTION",
  "MANDATORY_GATE",
]);

export class QualificationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "QualificationError";
    this.code = code;
    this.details = details;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Canonical(value) {
  return createHash("sha256").update(recursiveCanonicalJson(value)).digest("hex");
}

/**
 * Build + validate the qualification result for a consolidated candidate.
 *
 * @param {object} o
 * @param {string} o.reviewerIdentity — hex64; the INDEPENDENT reviewer's
 *        canonical result identity (must differ from executorIdentity — V5)
 * @param {string} o.executorIdentity — hex64; the identity that produced the
 *        consolidated candidate / incidents
 * @param {string} o.rootCause
 * @param {string} o.mechanism — the qualified mechanism statement
 * @param {object} o.applicability — the applicability boundary (O6 shape;
 *        carried verbatim; machine-testability enforced by O6/applicability)
 * @param {string[]|string} o.counterexamples — known counterexamples or
 *        NOT_APPLICABLE
 * @param {string} o.transferPotential — bounded transfer statement
 * @param {"ADVISORY"|"REQUIRED_QUESTION"|"MANDATORY_GATE"} o.requiredLifecycleLevel
 *        — DATA ONLY (R14 admission-element input; N-2c decides later)
 * @param {Array<{finding: string, severity: string}>} [o.blockingFindings]
 * @returns qualification result (pure data; qualificationRecordId is minted
 *          by the CBM record layer when this result is journaled — here the
 *          digest is the identity this module contributes)
 */
export function qualifyCandidate({
  reviewerIdentity,
  executorIdentity,
  rootCause,
  mechanism,
  applicability,
  counterexamples = "NOT_APPLICABLE",
  transferPotential,
  requiredLifecycleLevel,
  blockingFindings = [],
}) {
  for (const [name, v] of [["reviewerIdentity", reviewerIdentity], ["executorIdentity", executorIdentity]]) {
    if (!HEX64.test(String(v ?? ""))) {
      throw new QualificationError(QUALIFICATION_REJECT.MALFORMED, `${name} must be hex64`);
    }
  }
  // V5 SELF-APPROVAL FENCE — the core O5 invariant. The qualification
  // identity MUST differ from the executor identity. This is the trust
  // SELF_PROMOTION analogue at the qualification layer.
  if (String(reviewerIdentity) === String(executorIdentity)) {
    throw new QualificationError(
      QUALIFICATION_REJECT.SELF_APPROVAL,
      "qualification identity equals executor identity — self-approval rejected (V5)",
      { reviewerIdentity, executorIdentity },
    );
  }
  if (typeof rootCause !== "string" || rootCause.length === 0
    || typeof mechanism !== "string" || mechanism.length === 0
    || typeof transferPotential !== "string" || transferPotential.length === 0) {
    throw new QualificationError(QUALIFICATION_REJECT.MALFORMED, "rootCause / mechanism / transferPotential are required non-empty strings");
  }
  if (!applicability || typeof applicability !== "object" || Array.isArray(applicability)) {
    throw new QualificationError(QUALIFICATION_REJECT.MALFORMED, "applicability boundary object required (carried verbatim; O6 enforces testability)");
  }
  if (!REQUIRED_LIFECYCLE_LEVELS.includes(requiredLifecycleLevel)) {
    throw new QualificationError(QUALIFICATION_REJECT.MALFORMED, `requiredLifecycleLevel must be one of ${REQUIRED_LIFECYCLE_LEVELS.join("|")}`);
  }
  if (!Array.isArray(blockingFindings)) {
    throw new QualificationError(QUALIFICATION_REJECT.MALFORMED, "blockingFindings must be an array");
  }

  const result = {
    schema: QUALIFICATION_SCHEMA,
    reviewerIdentity,
    executorIdentity,
    rootCause,
    mechanism,
    applicability: JSON.parse(JSON.stringify(applicability)),
    counterexamples,
    transferPotential,
    requiredLifecycleLevel,
    blockingFindings: blockingFindings.map((b) => ({ ...b })),
    qualified: blockingFindings.length === 0,
  };
  result.digest = sha256Canonical(JSON.parse(JSON.stringify(result)));
  return result;
}

/**
 * Retry semantics: the SAME inputs (including the same rejected identity)
 * reproduce the identical rejection — retry NEVER launders a V5 rejection.
 * Only a genuinely independent reviewer identity is a legal retry input.
 */
export function retryQualification(previousError, { reviewerIdentity, executorIdentity, ...rest }) {
  if (previousError instanceof QualificationError && previousError.code === QUALIFICATION_REJECT.SELF_APPROVAL
    && String(reviewerIdentity) === String(previousError.details.reviewerIdentity)) {
    // identical rejected input ⇒ identical rejection (idempotent, durable)
    throw new QualificationError(
      QUALIFICATION_REJECT.SELF_APPROVAL,
      "identical rejected qualification input re-submitted — rejection stands (retry never launders)",
      previousError.details,
    );
  }
  return qualifyCandidate({ reviewerIdentity, executorIdentity, ...rest });
}

/** Re-verify a stored qualification result (resume/replay path). */
export function verifyQualification(result) {
  const { digest, ...rest } = result;
  const rederived = sha256Canonical(JSON.parse(JSON.stringify(rest)));
  return { ok: rederived === digest, rederived, reason: rederived === digest ? null : "QUALIFICATION_IDENTITY_MISMATCH" };
}
