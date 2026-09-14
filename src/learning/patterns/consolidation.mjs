// src/learning/patterns/consolidation.mjs
//
// R2 O4 — INCIDENT CONSOLIDATION (Stage-F R2 chain; [CT §1 R4]).
//
// Consumes durable incident records (layer 1, R1 — sealed Stage-E authority)
// and produces a consolidation RESULT (pure data): the deduplicated
// constituent set + the canonical lineage digests a PATTERN write-back
// candidate binds (PHASE-3-CANDIDATE-BINDING STEP 1a).
//
// Hard rules (frozen):
//   - ≥2 independent incidents REQUIRED, or a documented single-high-severity
//     rationale (singleIncidentRationale !== null && severity === "high");
//   - dedup constituents by (logicalKey, contentHash) BEFORE admission —
//     duplicate inflation (V4: the same root incident counted twice) is
//     REJECTED, never silently collapsed;
//   - the consolidation cites EVERY constituent incident recordId VERBATIM
//     (re-verifiable from the CBM journal);
//   - deterministic: same incidents + same rationale ⇒ same consolidation
//     digest (canonical JSON; no timestamps in any digest input);
//   - NON-AUTHORITATIVE: the result is candidate input data, never authority;
//     no §5 lifecycle edge exists in this module (R2_MAY_PROMOTE = NO).
//
// PROHIBITED HERE: activation · adoption · promotion · policy mutation ·
// harness/session/provider identity inputs.

import { createHash } from "node:crypto";
import { recursiveCanonicalJson } from "../../memory/canonical.mjs";

export const CONSOLIDATION_SCHEMA = "autoloop.pattern-consolidation/v1";

export const CONSOLIDATION_REJECT = Object.freeze({
  TOO_FEW_INCIDENTS: "CONSOLIDATION_TOO_FEW_INCIDENTS",
  DUPLICATE_INFLATION: "CONSOLIDATION_DUPLICATE_INFLATION",
  INCIDENT_MALFORMED: "CONSOLIDATION_INCIDENT_MALFORMED",
  RATIONALE_REQUIRED: "CONSOLIDATION_SINGLE_INCIDENT_RATIONALE_REQUIRED",
});

export class ConsolidationError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "ConsolidationError";
    this.code = code;
    this.details = details;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

function sha256Canonical(value) {
  return createHash("sha256").update(recursiveCanonicalJson(value)).digest("hex");
}

/** Validate one constituent incident (minimal durable shape; R1 layer). */
function validateIncident(incident) {
  if (!incident || typeof incident !== "object" || Array.isArray(incident)) {
    throw new ConsolidationError(CONSOLIDATION_REJECT.INCIDENT_MALFORMED, "incident must be an object");
  }
  if (!HEX64.test(String(incident.recordId ?? ""))) {
    throw new ConsolidationError(CONSOLIDATION_REJECT.INCIDENT_MALFORMED, "incident.recordId must be hex64 (verbatim CBM recordId)");
  }
  if (typeof incident.logicalKey !== "string" || incident.logicalKey.length !== 64) {
    throw new ConsolidationError(CONSOLIDATION_REJECT.INCIDENT_MALFORMED, "incident.logicalKey must be hex64");
  }
  if (typeof incident.contentHash !== "string" || incident.contentHash.length !== 64) {
    throw new ConsolidationError(CONSOLIDATION_REJECT.INCIDENT_MALFORMED, "incident.contentHash must be hex64");
  }
}

/**
 * Consolidate independent incidents into a pattern-candidate lineage input.
 *
 * @param {object} o
 * @param {Array<{recordId, logicalKey, contentHash, severity?}>} o.incidents
 * @param {string|null} [o.singleIncidentRationale] — documented rationale when
 *        exactly ONE high-severity incident is claimed (O4 escape hatch;
 *        evidence-bound text recorded verbatim)
 * @param {string} [o.patternId] — stable pattern identity this lineage feeds
 * @returns {{ schema, patternId, constituents, constituentIncidentRecordIds,
 *            constituentIncidentSetDigest, distinctLogicalKeys, digest,
 *            inputIncidentCount, deduped: boolean }}
 */
export function consolidateIncidents({ incidents, singleIncidentRationale = null, patternId = null }) {
  if (!Array.isArray(incidents) || incidents.length === 0) {
    throw new ConsolidationError(CONSOLIDATION_REJECT.TOO_FEW_INCIDENTS, "incidents must be a non-empty array");
  }
  for (const inc of incidents) validateIncident(inc);

  // V4 dedup fence: dedup by (logicalKey, contentHash) BEFORE admission.
  // An exact duplicate pair (same logicalKey AND same contentHash) is the
  // same incident twice — duplicate inflation if counted as two (REJECTED,
  // per [CT §1 R4]/V4 and PHASE-3 STEP 1a: "duplicate inflation rejected").
  // Distinct logicalKeys with the same contentHash are DIFFERENT incidents
  // (different logical slots) and remain independent.
  const seen = new Map();
  for (const inc of incidents) {
    const key = `${inc.logicalKey}:${inc.contentHash}`;
    if (seen.has(key)) {
      throw new ConsolidationError(
        CONSOLIDATION_REJECT.DUPLICATE_INFLATION,
        `same (logicalKey, contentHash) contributed twice: ${inc.recordId} duplicates ${seen.get(key).recordId}`,
        { duplicateOf: seen.get(key).recordId, recordId: inc.recordId },
      );
    }
    seen.set(key, inc);
  }
  const constituents = [...seen.values()];

  // ≥2 independent incidents, or documented single-high-severity rationale.
  if (constituents.length < 2) {
    if (constituents.length === 1 && singleIncidentRationale !== null && constituents[0].severity === "high") {
      // legal path — rationale is carried verbatim into the digest input
    } else if (constituents.length === 1) {
      throw new ConsolidationError(
        CONSOLIDATION_REJECT.RATIONALE_REQUIRED,
        "single-incident consolidation requires a documented rationale AND high severity",
      );
    } else {
      throw new ConsolidationError(CONSOLIDATION_REJECT.TOO_FEW_INCIDENTS, `only ${constituents.length} independent incidents`);
    }
  }

  // Canonical constituent set: recordIds in the order contributed (array
  // order is semantic in the canonicalizer — the contribution order is the
  // only order the caller's evidence defines), digests computed canonically.
  const constituentIncidentRecordIds = constituents.map((c) => c.recordId);
  const constituentIncidentSetDigest = sha256Canonical({
    schema: CONSOLIDATION_SCHEMA,
    constituents: constituents.map((c) => ({ recordId: c.recordId, logicalKey: c.logicalKey, contentHash: c.contentHash })),
    singleIncidentRationale,
  });
  const digest = sha256Canonical({
    schema: CONSOLIDATION_SCHEMA,
    patternId,
    constituentIncidentSetDigest,
    inputIncidentCount: incidents.length,
  });
  return {
    schema: CONSOLIDATION_SCHEMA,
    patternId,
    constituents: constituents.map((c) => ({ ...c })),
    constituentIncidentRecordIds,
    constituentIncidentSetDigest,
    distinctLogicalKeys: constituents.length,
    digest,
    inputIncidentCount: incidents.length,
    singleIncidentRationale,
    deduped: true,
  };
}

/**
 * Re-verify a consolidation result against its cited constituents (provenance
 * re-verifiable from the journal — the resume/replay path and the O4 oracle
 * both use this). Same inputs ⇒ same digest; any divergence fails.
 */
export function verifyConsolidation(consolidation, incidents) {
  const rederived = consolidateIncidents({
    incidents,
    singleIncidentRationale: consolidation.singleIncidentRationale ?? null,
    patternId: consolidation.patternId ?? null,
  });
  const ok = rederived.constituentIncidentSetDigest === consolidation.constituentIncidentSetDigest
    && JSON.stringify(rederived.constituentIncidentRecordIds) === JSON.stringify(consolidation.constituentIncidentRecordIds);
  return { ok, rederived, reason: ok ? null : "CONSOLIDATION_PROVENANCE_MISMATCH" };
}

/**
 * Provenance CHECK-ONLY re-derivation (resume/replay path): recomputes the
 * constituent set digest from cited recordIds WITHOUT the admission gates
 * (a tampered/lost-constituent divergence is a MISMATCH result, never an
 * admission rejection — the caller decides REJECT/HOLD from the verdict).
 */
export function rederiveConstituentSetDigest(consolidation, incidents) {
  if (!Array.isArray(incidents)) return { ok: false, reason: "CONSOLIDATION_PROVENANCE_MISMATCH" };
  for (const inc of incidents) validateIncident(inc);
  const constituents = [...incidents];
  const constituentIncidentSetDigest = sha256Canonical({
    schema: CONSOLIDATION_SCHEMA,
    constituents: constituents.map((c) => ({ recordId: c.recordId, logicalKey: c.logicalKey, contentHash: c.contentHash })),
    singleIncidentRationale: consolidation.singleIncidentRationale ?? null,
  });
  const idsMatch = JSON.stringify(constituents.map((c) => c.recordId)) === JSON.stringify(consolidation.constituentIncidentRecordIds ?? []);
  const digestMatch = constituentIncidentSetDigest === consolidation.constituentIncidentSetDigest;
  return {
    ok: idsMatch && digestMatch,
    constituentIncidentSetDigest,
    reason: idsMatch && digestMatch ? null : "CONSOLIDATION_PROVENANCE_MISMATCH",
  };
}
