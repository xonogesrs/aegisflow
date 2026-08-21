// src/governance/pass-oracle.mjs
//
// AUTOLOOP-P4 — THE authoritative PASS oracle.
//
// ONE canonical decision boundary for every terminal verification PASS:
//
//   declared success contract
//   + execution generation / lineage identity
//   + attributable verification evidence
//   + applicable global invariants
//   + authority state
//   ↓ evaluatePassOracle()
//   PASS | NOT_PASS (+ machine-readable failure taxonomy)
//
// Invariants of this module:
//   - PURE and dependency-free（node:crypto only）. No I/O, no clocks beyond
//     the caller-supplied `now`. Callers gather facts; the oracle decides.
//   - FAIL-CLOSED: missing / stale / contradictory / wrongly-attributed /
//     malformed evidence can never produce PASS. "No failure observed" is
//     never "PASS".
//   - CLAIM ≠ PROOF: an executor self-report is evidence with role
//     "executor"; a check that requiresIndependent is satisfied ONLY by
//     producer.role === "independent".
//   - Deterministic checks stay mechanical: kind "deterministic" evidence is
//     evaluated on its structured result alone; semantic evidence (kind
//     "semantic") may never override a deterministic FAIL because both are
//     just records here and ANY accepted required FAIL blocks PASS.
//   - No second verdict vocabulary: decisions are PASS | NOT_PASS; the
//     failure taxonomy codes map onto existing AutoLoop terminal semantics
//     (HOLD / REPAIR) at the call sites. This module never mints HOLD/REPAIR
//     itself.
//
// Generation fencing: evidence whose generation differs from the contract's
// generation is rejected — a generation-N verification can never certify
// generation N+1.
// Lineage fencing: evidence bound to another cardId is rejected.
// Freshness: a check declaring freshness "repo" must carry binding.head AND
// binding.treeSha equal to the contract's current head/treeSha; freshness
// "content" must carry binding.artifactSha256 equal to the check's expected
// artifact digest. A MISSING binding is stale（fail-closed）, never fresh.

import { createHash } from "node:crypto";

export const PASS_ORACLE_SCHEMA = "autoloop.pass-oracle/v1";
export const ORACLE_EVIDENCE_SCHEMA = "autoloop.oracle-evidence/v1";

export const ORACLE_DECISIONS = Object.freeze(["PASS", "NOT_PASS"]);
export const ORACLE_EVIDENCE_KINDS = Object.freeze(["deterministic", "semantic"]);
export const ORACLE_PRODUCER_ROLES = Object.freeze(["executor", "independent"]);
export const ORACLE_FRESHNESS_MODES = Object.freeze(["repo", "content", "none"]);
export const ORACLE_CHECK_KINDS = Object.freeze(["regression-suite", "verifier", "review-bundle-valid", "independent-review"]);

export const ORACLE_REJECTIONS = Object.freeze({
  AUTHORITY_REVOKED: "ORACLE_AUTHORITY_REVOKED",
  EVIDENCE_REVOKED: "ORACLE_EVIDENCE_REVOKED",
  MALFORMED_EVIDENCE: "ORACLE_EVIDENCE_MALFORMED",
  UNATTRIBUTABLE: "ORACLE_EVIDENCE_UNATTRIBUTABLE",
  LINEAGE_MISMATCH: "ORACLE_EVIDENCE_LINEAGE_MISMATCH",
  GENERATION_FENCED: "ORACLE_EVIDENCE_GENERATION_FENCED",
  UNDECLARED_CHECK: "ORACLE_EVIDENCE_UNDECLARED_CHECK",
  STALE: "ORACLE_EVIDENCE_STALE",
  SELF_CERTIFIED: "ORACLE_REQUIRED_EVIDENCE_SELF_CERTIFIED",
  MISSING_REQUIRED: "ORACLE_REQUIRED_EVIDENCE_MISSING",
  REQUIRED_FAILED: "ORACLE_REQUIRED_CHECK_FAILED",
  CONTRADICTORY: "ORACLE_REQUIRED_EVIDENCE_CONTRADICTORY",
  INVARIANT_VIOLATED: "ORACLE_INVARIANT_VIOLATED",
});

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const HEAD_SHA_RE = /^[0-9a-f]{40,64}$/;

export function sha256OracleText(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/**
 * Validate + freeze one attributable verification evidence record.
 * Returns { ok: true, record } or { ok: false, errors } — the caller decides
 * whether rejection blocks (required) or is ignored (optional).
 */
export function validateOracleEvidence(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["evidence_absent_or_not_object"] };
  }
  if (input.schema !== ORACLE_EVIDENCE_SCHEMA) errors.push(`schema_mismatch:${input.schema ?? "absent"}`);
  if (typeof input.evidenceId !== "string" || input.evidenceId.length === 0) errors.push("evidence_id_required");
  if (typeof input.cardId !== "string" || input.cardId.length === 0) errors.push("card_id_required");
  if (!Number.isInteger(input.generation) || input.generation < 0) errors.push("generation_invalid");
  if (typeof input.checkId !== "string" || input.checkId.length === 0) errors.push("check_id_required");
  if (!ORACLE_EVIDENCE_KINDS.includes(input.kind)) errors.push(`kind_invalid:${input.kind ?? "absent"}`);
  const producer = input.producer;
  if (!producer || typeof producer !== "object" || Array.isArray(producer)) {
    errors.push("producer_required");
  } else {
    if (typeof producer.identity !== "string" || producer.identity.length === 0) errors.push("producer_identity_required");
    if (!ORACLE_PRODUCER_ROLES.includes(producer.role)) errors.push(`producer_role_invalid:${producer?.role ?? "absent"}`);
  }
  if (input.result !== "PASS" && input.result !== "FAIL") errors.push(`result_invalid:${input.result ?? "absent"}`);
  if (typeof input.at !== "string" || !ISO_TS.test(input.at)) errors.push("timestamp_invalid");
  if (typeof input.command !== "string" || input.command.length === 0) errors.push("command_identity_required");
  const binding = input.binding ?? {};
  if (typeof binding !== "object" || Array.isArray(binding)) errors.push("binding_invalid");
  else {
    for (const [field, ok] of [
      ["head", binding.head == null || HEAD_SHA_RE.test(binding.head)],
      ["treeSha", binding.treeSha == null || HEAD_SHA_RE.test(binding.treeSha)],
      ["artifactSha256", binding.artifactSha256 == null || SHA256_RE.test(binding.artifactSha256)],
    ]) {
      if (!ok) errors.push(`binding_${field}_invalid`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    record: Object.freeze({
      schema: ORACLE_EVIDENCE_SCHEMA,
      evidenceId: input.evidenceId,
      cardId: input.cardId,
      generation: input.generation,
      checkId: input.checkId,
      kind: input.kind,
      producer: Object.freeze({ identity: input.producer.identity, role: input.producer.role }),
      result: input.result,
      at: input.at,
      command: input.command,
      binding: Object.freeze({
        head: input.binding?.head ?? null,
        treeSha: input.binding?.treeSha ?? null,
        artifactSha256: input.binding?.artifactSha256 ?? null,
      }),
      summary: typeof input.summary === "string" ? input.summary.slice(0, 500) : null,
    }),
  };
}

/**
 * Normalize a DECLARED task success contract（the frozen verification plan）.
 * Shape:
 *   {
 *     requiredChecks: [{ id, freshness?: "repo"|"content"|"none",
 *                        requiresIndependent?: bool,
 *                        expectedArtifactSha256?: <sha256> }],
 *     optionalChecks?: [{ id }],
 *     authority?: { revoked?: bool, reason?: string },
 *     generation?, head?, treeSha?
 *   }
 * The implicit checks "review-bundle-valid" and "independent-review" are
 * ALWAYS required and cannot be removed or weakened by the contract — a
 * caller may only ADD task-specific requirements.
 */
export function normalizeSuccessContract(input) {
  if (input == null) {
    return {
      ok: true,
      contract: Object.freeze({
        requiredChecks: Object.freeze([
          Object.freeze({ id: "review-bundle-valid", freshness: "repo", requiresIndependent: true }),
          Object.freeze({ id: "independent-review", freshness: "repo", requiresIndependent: true }),
        ]),
        optionalChecks: Object.freeze([]),
        authority: Object.freeze({ revoked: false }),
        generation: null,
        head: null,
        treeSha: null,
      }),
    };
  }
  const errors = [];
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["contract_not_object"] };
  if (input.requiredChecks != null && !Array.isArray(input.requiredChecks)) errors.push("required_checks_array_required");
  const optional = Array.isArray(input.optionalChecks) ? input.optionalChecks : [];
  const seen = new Set();
  const req = [];
  if (Array.isArray(input.requiredChecks)) {
    for (const c of input.requiredChecks) {
      if (!c || typeof c !== "object" || Array.isArray(c)) { errors.push("required_check_not_object"); continue; }
      if (c.id === "review-bundle-valid" || c.id === "independent-review") {
        errors.push(`implicit_check_redeclare:${c.id}`);
        continue;
      }
      if (typeof c.id !== "string" || c.id.length === 0) { errors.push("check_id_required"); continue; }
      if (seen.has(c.id)) { errors.push(`duplicate_check:${c.id}`); continue; }
      seen.add(c.id);
      const freshness = c.freshness ?? "repo";
      if (!ORACLE_FRESHNESS_MODES.includes(freshness)) { errors.push(`freshness_invalid:${c.id}:${freshness}`); continue; }
      if (freshness === "content" && !(typeof c.expectedArtifactSha256 === "string" && SHA256_RE.test(c.expectedArtifactSha256))) {
        errors.push(`expected_artifact_sha_required:${c.id}`);
        continue;
      }
      const kind = c.kind ?? "regression-suite";
      if (!ORACLE_CHECK_KINDS.includes(kind)) { errors.push(`check_kind_invalid:${c.id}:${kind}`); continue; }
      if (kind === "regression-suite" && c.suite != null && typeof c.suite !== "string") { errors.push(`suite_invalid:${c.id}`); continue; }
      req.push(Object.freeze({
        id: c.id,
        kind,
        suite: typeof c.suite === "string" ? c.suite : null,
        freshness,
        requiresIndependent: c.requiresIndependent === true,
        expectedArtifactSha256: c.expectedArtifactSha256 ?? null,
      }));
    }
  }
  // Optional checks: declared so evidence for them is ACCEPTED（counted,
  // reported）but they can never block.
  for (const c of optional) {
    if (!c || typeof c !== "object" || typeof c.id !== "string" || c.id.length === 0) { errors.push("optional_check_id_required"); continue; }
    if (seen.has(c.id)) { errors.push(`duplicate_check:${c.id}`); continue; }
    seen.add(c.id);
  }
  if (input.authority != null && (typeof input.authority !== "object" || Array.isArray(input.authority))) {
    errors.push("authority_not_object");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    contract: Object.freeze({
      requiredChecks: Object.freeze([
        Object.freeze({ id: "review-bundle-valid", freshness: "repo", requiresIndependent: true, expectedArtifactSha256: null }),
        Object.freeze({ id: "independent-review", freshness: "repo", requiresIndependent: true, expectedArtifactSha256: null }),
        ...req,
      ]),
      optionalChecks: Object.freeze(optional.map((c) => Object.freeze({ id: c.id }))),
      authority: Object.freeze({ revoked: input.authority?.revoked === true, reason: input.authority?.reason ?? null }),
      generation: Number.isInteger(input.generation) ? input.generation : null,
      head: typeof input.head === "string" ? input.head : null,
      treeSha: typeof input.treeSha === "string" ? input.treeSha : null,
    }),
  };
}

function detailOf(code, checkId, extra) {
  return { code, checkId: checkId ?? null, ...(extra ? { detail: extra } : {}) };
}

/**
 * THE decision function. All PASS-producing paths MUST converge here.
 *
 * @param {
 *   contract:   normalized success contract（normalizeSuccessContract）
 *   evidence:   array of raw attributable evidence records
 *               （validateOracleEvidence shape）
 *   invariants: array of { id, ok, detail? } — applicable registered global
 *               invariant results（only violations block; absent = not
 *               applicable）
 *   revocations: optional { evidenceIds: [..], artifactShas: [..] } —
 *               CURRENT-AUTHORITY revocation facts（Truth Revocation Cascade,
 *               truth-revocation.mjs computeCascade → revocationFactsForOracle）.
 *               Evidence whose id is revoked, or whose content binding pins a
 *               revoked artifact, is REJECTED（ORACLE_EVIDENCE_REVOKED）— it
 *               can never satisfy any check again. Historical records are NOT
 *               rewritten; only the current decision loses their weight.
 *   now:        ISO timestamp of the evaluation
 * } input
 * @returns {{
 *   schema, decision: "PASS"|"NOT_PASS", pass, failures, acceptedEvidence,
 *   rejectedEvidence, evaluatedAt
 * }}
 */
export function evaluatePassOracle({ contract, evidence = [], invariants = [], revocations = null, now }) {
  const evaluatedAt = typeof now === "string" && ISO_TS.test(now) ? now : new Date().toISOString();

  // 0) contract validity — fail closed before anything else.
  if (!contract || !contract.ok || !contract.contract) {
    return fail(contract?.errors ?? ["contract_absent"], [], [], evaluatedAt, [
      detailOf(ORACLE_REJECTIONS.CONTRACT_INVALID, null, (contract?.errors ?? ["contract_absent"]).join(",")),
    ]);
  }
  const C = contract.contract;
  const failures = [];
  const rejected = [];

  // 1) authority revocation — a revoked authority may never terminalize PASS.
  if (C.authority.revoked) {
    failures.push(detailOf(ORACLE_REJECTIONS.AUTHORITY_REVOKED, null, C.authority.reason ?? "authority_revoked"));
    return fail([], [], rejected, evaluatedAt, failures);
  }

  // 2) partition evidence: reject malformed / unattributable / fenced first.
  const accepted = [];
  const declared = new Map(C.requiredChecks.map((c) => [c.id, c]));
  for (const c of C.optionalChecks) declared.set(c.id, { ...c, optional: true });
  for (const e of (Array.isArray(evidence) ? evidence : [])) {
    const v = validateOracleEvidence(e);
    if (!v.ok) {
      rejected.push({ evidenceId: e?.evidenceId ?? null, code: ORACLE_REJECTIONS.MALFORMED_EVIDENCE, detail: v.errors.join(",") });
      continue;
    }
    const r = v.record;
    if (typeof r.evidenceId !== "string" || r.evidenceId.length === 0 || !r.producer?.identity) {
      rejected.push({ evidenceId: r.evidenceId ?? null, code: ORACLE_REJECTIONS.UNATTRIBUTABLE });
      continue;
    }
    if (C.cardId != null && r.cardId !== C.cardId) {
      rejected.push({ evidenceId: r.evidenceId, code: ORACLE_REJECTIONS.LINEAGE_MISMATCH, detail: `evidence card ${r.cardId} != contract card ${C.cardId}` });
      continue;
    }
    if (C.generation != null && r.generation !== C.generation) {
      rejected.push({ evidenceId: r.evidenceId, code: ORACLE_REJECTIONS.GENERATION_FENCED, detail: `evidence generation ${r.generation} != contract generation ${C.generation}` });
      continue;
    }
    // 2b) CURRENT-AUTHORITY revocation（Truth Revocation Cascade）— revoked
    //     evidence can never satisfy any check; a revoked artifact poisons
    //     every evidence record still bound to it; evidence produced by a
    //     revoked AUTHORITY（reviewer/verifier identity）is rejected too.
    //     Fail-closed BEFORE freshness: revocation is stronger than staleness.
    if (revocations) {
      const evRevoked = Array.isArray(revocations.evidenceIds) && revocations.evidenceIds.includes(r.evidenceId);
      const artRevoked = r.binding.artifactSha256 != null
        && Array.isArray(revocations.artifactShas) && revocations.artifactShas.includes(r.binding.artifactSha256);
      const authRevoked = r.producer?.identity != null
        && Array.isArray(revocations.authorityIds) && revocations.authorityIds.includes(r.producer.identity);
      if (evRevoked || artRevoked || authRevoked) {
        rejected.push({
          evidenceId: r.evidenceId,
          code: ORACLE_REJECTIONS.EVIDENCE_REVOKED,
          detail: evRevoked ? "evidence_revoked" : authRevoked ? `authority_revoked:${r.producer.identity}` : `artifact_revoked:${r.binding.artifactSha256}`,
        });
        continue;
      }
    }
    if (!declared.has(r.checkId)) {
      rejected.push({ evidenceId: r.evidenceId, code: ORACLE_REJECTIONS.UNDECLARED_CHECK, detail: r.checkId });
      continue;
    }
    // 3) freshness — stale evidence never certifies a later state.
    const spec = declared.get(r.checkId);
    let stale = null;
    if (!spec.optional) {
      if (spec.freshness === "repo") {
        // A contract that declares NO repo identity cannot be freshness-
        // checked against one; the caller then holds only the weaker non-
        // terminal authority（REVIEW_ACCEPTED, never CLOSEOUT_ELIGIBLE）.
        // Where a repo identity exists, a missing/mismatched binding is
        // STALE（fail-closed）, never fresh.
        if (C.head != null || C.treeSha != null) {
          if ((C.head != null && r.binding.head !== C.head) || (C.treeSha != null && r.binding.treeSha !== C.treeSha)) {
            stale = `binding(${r.binding.head ?? "-"},${r.binding.treeSha ?? "-"}) != current(${C.head ?? "-"},${C.treeSha ?? "-"})`;
          }
        }
      } else if (spec.freshness === "content") {
        if (r.binding.artifactSha256 !== spec.expectedArtifactSha256) {
          stale = `artifact(${r.binding.artifactSha256 ?? "-"}) != expected(${spec.expectedArtifactSha256 ?? "-"})`;
        }
      }
    }
    if (stale) {
      rejected.push({ evidenceId: r.evidenceId, code: ORACLE_REJECTIONS.STALE, detail: stale });
      continue;
    }
    accepted.push(r);
  }

  // 4) per-required-check satisfaction（contradiction fails closed）.
  for (const spec of C.requiredChecks) {
    const evs = accepted.filter((e) => e.checkId === spec.id);
    const passes = evs.filter((e) => e.result === "PASS");
    const fails = evs.filter((e) => e.result === "FAIL");
    if (fails.length > 0) {
      failures.push(detailOf(
        passes.length > 0 ? ORACLE_REJECTIONS.CONTRADICTORY : ORACLE_REJECTIONS.REQUIRED_FAILED,
        spec.id,
        `${passes.length} PASS vs ${fails.length} FAIL`,
      ));
      continue;
    }
    if (passes.length === 0) {
      // Revoked candidates count like stale ones: a required check whose
      // only candidates were revoked is reported as MISSING with rejected
      // candidate context（never silently "no evidence ever existed"）.
      const anyRejected = rejected.some((r) => r.detail?.includes(spec.id)
        || r.code === ORACLE_REJECTIONS.STALE
        || r.code === ORACLE_REJECTIONS.EVIDENCE_REVOKED);
      failures.push(detailOf(ORACLE_REJECTIONS.MISSING_REQUIRED, spec.id, anyRejected ? "candidate_evidence_rejected" : undefined));
      continue;
    }
    // 5) anti-self-certification — executor-only PASS cannot satisfy a check
    //    that requires independent production.
    if (spec.requiresIndependent && !passes.some((e) => e.producer.role === "independent")) {
      failures.push(detailOf(ORACLE_REJECTIONS.SELF_CERTIFIED, spec.id, "only executor-role PASS evidence"));
    }
  }
  // 6) applicable global invariants — any violation blocks PASS even when
  //    every local happy-path check succeeded.
  for (const inv of (Array.isArray(invariants) ? invariants : [])) {
    if (!inv || typeof inv !== "object" || typeof inv.id !== "string" || inv.id.length === 0) {
      failures.push(detailOf(ORACLE_REJECTIONS.INVARIANT_VIOLATED, null, "malformed invariant record treated as violated"));
      continue;
    }
    if (inv.ok !== true) {
      failures.push(detailOf(ORACLE_REJECTIONS.INVARIANT_VIOLATED, inv.id, typeof inv.detail === "string" ? inv.detail.slice(0, 200) : undefined));
    }
  }

  if (failures.length > 0) return fail(accepted, [], rejected, evaluatedAt, failures);
  return {
    schema: PASS_ORACLE_SCHEMA,
    decision: "PASS",
    pass: true,
    failures: [],
    acceptedEvidence: accepted.map((e) => e.evidenceId),
    rejectedEvidence: rejected,
    evaluatedAt,
  };

  function fail(acceptedList, _unused, rejectedList, at, fails) {
    return {
      schema: PASS_ORACLE_SCHEMA,
      decision: "NOT_PASS",
      pass: false,
      failures: fails,
      acceptedEvidence: acceptedList.map((e) => e.evidenceId),
      rejectedEvidence: rejectedList,
      evaluatedAt: at,
    };
  }
}
