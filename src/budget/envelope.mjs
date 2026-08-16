// src/budget/envelope.mjs
//
// AUTOLOOP-TA3 — budget ENVELOPE（the immutable authority）.
//
// The envelope is the frozen, admission-bound budget authority:
//
//   deriveBudgetEnvelope(admission) → envelope
//     - derives the effective contract from the FROZEN admission
//       （profile defaults ∪ admission.extensions.budget overrides）;
//     - binds envelopeId = sha256(canonical({admission_id, contract})) —
//       the runtime cannot widen the envelope without changing the id, and
//       the ledger verifies the id on every resume/merge（B1/B2/NEG2）;
//     - deep-freezes the envelope（immutable by construction）.
//
// The envelope is the ONLY budget authority a production run may read. The
// runtime never re-derives a looser one; a child/sub-graph envelope is a
// MONOTONIC projection of the parent's REMAINING budget（projectChildEnvelope
// in enforcement.mjs — child ≤ remaining parent, B2）.

import { createHash } from "node:crypto";
import {
  BUDGET_CONTRACT_SCHEMA,
  BUDGET_CONTRACT_VERSION,
  ENFORCED_DIMENSIONS,
  DIMENSION_UNITS,
  effectiveBudgetContract,
  deepFreeze,
} from "./contract.mjs";

export const BUDGET_ENVELOPE_SCHEMA = "autoloop.budget-envelope/v1";

export function sha256Hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

function canonical(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * Derive the immutable budget envelope from a FROZEN admission record.
 *
 * @param {object} admission — frozen admission（admission_id present）
 * @param {object} [opts] — { parentEnvelopeId, parentLedgerId } for child
 *        envelopes（monotonic restriction metadata; the child limits are
 *        still derived from the parent's REMAINING budget by the caller —
 *        see projectChildEnvelope）.
 * @returns {{ ok: true, envelope: object } | { ok: false, holdCode: string,
 *            reason: string }} — fail-closed.
 */
export function deriveBudgetEnvelope(admission, opts = {}) {
  if (!admission || typeof admission !== "object") {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: envelope requires a frozen admission record" };
  }
  if (typeof admission.admission_id !== "string" || !/^[0-9a-f]{64}$/.test(admission.admission_id)) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: admission is not frozen (no valid admission_id)" };
  }
  const contractResult = effectiveBudgetContract(admission);
  if (!contractResult.ok) {
    return {
      ok: false,
      holdCode: "BUDGET_AUTHORITY_INVALID",
      reason: `BUDGET_AUTHORITY_INVALID: budget contract invalid — ${contractResult.errors.slice(0, 4).join("; ")}`,
    };
  }
  const contract = contractResult.contract;
  const envelope = {
    schema: BUDGET_ENVELOPE_SCHEMA,
    version: BUDGET_CONTRACT_VERSION,
    contractSchema: BUDGET_CONTRACT_SCHEMA,
    admissionId: admission.admission_id,
    admissionProfile: admission.profile ?? null,
    admissionSize: admission.size ?? null,
    admissionRisk: admission.risk ?? null,
    contractSource: contract.source,
    approachingRatio: contract.approachingRatio,
    closeoutAuthorized: contract.closeoutAuthorized,
    dimensions: Object.fromEntries(
      ENFORCED_DIMENSIONS.map((d) => [
        d,
        {
          limit: contract.dimensions[d]?.limit ?? null,
          unit: DIMENSION_UNITS[d],
        },
      ]),
    ),
    parentEnvelopeId: opts.parentEnvelopeId ?? null,
    parentLedgerId: opts.parentLedgerId ?? null,
  };
  envelope.envelopeId = sha256Hex(canonical({
    admissionId: envelope.admissionId,
    contractSchema: envelope.contractSchema,
    dimensions: envelope.dimensions,
    approachingRatio: envelope.approachingRatio,
    closeoutAuthorized: envelope.closeoutAuthorized,
    parentEnvelopeId: envelope.parentEnvelopeId,
  }));
  return { ok: true, envelope: deepFreeze(envelope) };
}

/**
 * Verify an envelope is intact: schema, id re-derivation, admission binding.
 * Fail-closed — a tampered envelope is BUDGET_AUTHORITY_INVALID（NEG12）.
 */
export function assertEnvelopeUntampered(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: no envelope" };
  }
  if (envelope.schema !== BUDGET_ENVELOPE_SCHEMA) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: `BUDGET_AUTHORITY_INVALID: envelope schema ${String(envelope.schema)}` };
  }
  const expected = sha256Hex(canonical({
    admissionId: envelope.admissionId,
    contractSchema: envelope.contractSchema,
    dimensions: envelope.dimensions,
    approachingRatio: envelope.approachingRatio,
    closeoutAuthorized: envelope.closeoutAuthorized,
    parentEnvelopeId: envelope.parentEnvelopeId,
  }));
  if (expected !== envelope.envelopeId) {
    return { ok: false, holdCode: "BUDGET_AUTHORITY_INVALID", reason: "BUDGET_AUTHORITY_INVALID: envelope tampered (id re-derivation mismatch)" };
  }
  return { ok: true };
}
