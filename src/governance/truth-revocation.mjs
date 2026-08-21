// src/governance/truth-revocation.mjs
//
// AUTOLOOP POST-P4 — TRUTH REVOCATION CASCADE（pure core）.
//
// Authority: docs/pi-graph-output/checkpoint-20260809/roadmap-revalidation.md
//   ("Truth Revocation Cascade — DO_LATER: depends on structured acceptance
//   oracle, state authority, and evidence revocation semantics"). The P4 PASS
//   oracle (src/governance/pass-oracle.mjs) satisfied the structured-acceptance
//   prerequisite; this module supplies the revocation semantics.
//
// Doctrine:
//   - HISTORY IS IMMUTABLE. Revocation NEVER deletes or rewrites a historical
//     record (bundle, journal, evidence file). It adds durable CURRENT-
//     AUTHORITY state: OBSERVED_AT_TIME_T stays true; CURRENTLY_AUTHORITATIVE
//     can become false.
//   - FAIL-CLOSED. A revoked required piece of truth can never satisfy a
//     current PASS. Revocation of optional/unrelated truth never invalidates
//     unrelated required proof (cascade follows ACTUAL dependency edges only).
//   - FENCED. A revocation event carries lineage (cardId) + generation +
//     issuer authority. Wrong-generation, wrong-lineage and unauthorized
//     revocations are REJECTED, not applied. Duplicate revocation is
//     idempotent.
//   - PURE. No I/O, no clocks beyond caller-supplied `now`. Durable ledger is
//     a separate concern (truth-revocation-store.mjs); this module decides.

export const TRUTH_REVOCATION_SCHEMA = "autoloop.truth-revocation/v1";

/** Explicit revocable truth classes（Part 3 — do not treat all data as truth）. */
export const REVOCABLE_TRUTH_CLASSES = Object.freeze([
  "evidence", // an oracle evidence record（identity = evidenceId）
  "artifact", // content-addressed proof input（identity = sha256）
  "authority", // a verification/decision authority（identity = authority id）
]);

/** Only triggers supported by current architecture（Part 7 — no hypothetical mechanisms）. */
export const REVOCATION_TRIGGERS = Object.freeze([
  "source-mutation", // repo head/treeSha moved → bound evidence stale/revoked
  "authority-revoked", // the issuing authority itself was revoked
  "generation-superseded", // a successor generation supersedes this one's truth
  "artifact-hash-changed", // artifact digest no longer matches its binding
  "invariant-violated", // a global invariant now evaluates violated
  "verifier-retraction", // independent verifier retracts prior evidence
  "contract-superseded", // task success contract superseded by a new generation
]);

/**
 * Who may issue a revocation（Part 11 — UNAUTHORIZED_REVOCATION = REJECTED）.
 * The executor role is deliberately ABSENT: an executor must never be able to
 * revoke independently-produced truth（that would enable laundering: revoke the
 * independent proof, re-run with executor-only self-certification）. Executor-
 * produced evidence may be revoked by any authorized issuer.
 */
export const REVOCATION_ISSUER_ROLES = Object.freeze(["operator", "reviewer", "system"]);

const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * Validate + freeze one revocation event.
 * Returns { ok: true, event } | { ok: false, errors } — malformed events are
 * REJECTED, never partially applied（TR16）.
 *
 * {
 *   schema, revocationId, truthClass, truthId,
 *   trigger, reason, at,
 *   issuedBy: { identity, role },       // role ∈ REVOCATION_ISSUER_ROLES
 *   cardId?: <lineage binding>,         // when known: MUST match truth lineage
 *   generation?: <int>,                 // when known: MUST match truth generation
 * }
 */
export function validateRevocationEvent(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["revocation_absent_or_not_object"] };
  }
  if (input.schema !== TRUTH_REVOCATION_SCHEMA) errors.push(`schema_mismatch:${input.schema ?? "absent"}`);
  if (typeof input.revocationId !== "string" || input.revocationId.length === 0) errors.push("revocation_id_required");
  if (!REVOCABLE_TRUTH_CLASSES.includes(input.truthClass)) errors.push(`truth_class_invalid:${input.truthClass ?? "absent"}`);
  if (typeof input.truthId !== "string" || input.truthId.length === 0) {
    errors.push("truth_id_required");
  } else if (input.truthClass === "artifact" && !SHA256_RE.test(input.truthId)) {
    errors.push("artifact_truth_id_must_be_sha256");
  }
  if (!REVOCATION_TRIGGERS.includes(input.trigger)) errors.push(`trigger_invalid:${input.trigger ?? "absent"}`);
  if (typeof input.reason !== "string" || input.reason.length === 0) errors.push("reason_required");
  if (typeof input.at !== "string" || !ISO_TS.test(input.at)) errors.push("timestamp_invalid");
  const issuedBy = input.issuedBy;
  if (!issuedBy || typeof issuedBy !== "object" || Array.isArray(issuedBy)) {
    errors.push("issued_by_required");
  } else {
    if (typeof issuedBy.identity !== "string" || issuedBy.identity.length === 0) errors.push("issuer_identity_required");
    if (!REVOCATION_ISSUER_ROLES.includes(issuedBy.role)) errors.push(`issuer_role_unauthorized:${issuedBy?.role ?? "absent"}`);
  }
  if (input.cardId != null && (typeof input.cardId !== "string" || input.cardId.length === 0)) errors.push("card_id_invalid");
  if (input.generation != null && !(Number.isInteger(input.generation) && input.generation >= 0)) errors.push("generation_invalid");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    event: Object.freeze({
      schema: TRUTH_REVOCATION_SCHEMA,
      revocationId: input.revocationId,
      truthClass: input.truthClass,
      truthId: input.truthId,
      trigger: input.trigger,
      reason: String(input.reason).slice(0, 500),
      at: input.at,
      issuedBy: Object.freeze({ identity: input.issuedBy.identity, role: input.issuedBy.role }),
      cardId: input.cardId ?? null,
      generation: Number.isInteger(input.generation) ? input.generation : null,
    }),
  };
}

/**
 * Fencing: apply one validated event against the KNOWN truth record it
 * targets（when the caller has it）. Returns { ok: true } or
 * { ok: false, code, detail }. Unknown truths（event only）are fenced at
 * cascade time via the same field comparisons when records become available.
 *
 * Codes:
 *   WRONG_GENERATION_REVOCATION / WRONG_LINEAGE_REVOCATION /
 *   UNAUTHORIZED_REVOCATION
 */
export const REVOCATION_FENCING_CODES = Object.freeze({
  WRONG_GENERATION: "WRONG_GENERATION_REVOCATION",
  WRONG_LINEAGE: "WRONG_LINEAGE_REVOCATION",
  UNAUTHORIZED: "UNAUTHORIZED_REVOCATION",
});

export function fenceRevocationAgainstTruth(event, truth) {
  if (!event || typeof event !== "object") return { ok: false, code: "MALFORMED_EVENT", detail: "event_absent" };
  if (truth && typeof truth === "object") {
    // STRICT fencing: when the truth record declares a field, the event MUST
    // carry the matching value — omitting cardId/generation is NOT a way
    // around the fence（fail-closed, red-team finding）.
    if (Number.isInteger(truth.generation)) {
      if (!Number.isInteger(event.generation)) {
        return { ok: false, code: REVOCATION_FENCING_CODES.WRONG_GENERATION, detail: `event generation missing; truth gen ${truth.generation}` };
      }
      if (event.generation !== truth.generation) {
        return { ok: false, code: REVOCATION_FENCING_CODES.WRONG_GENERATION, detail: `event gen ${event.generation} != truth gen ${truth.generation}` };
      }
    }
    if (typeof truth.cardId === "string" && truth.cardId.length > 0) {
      if (typeof event.cardId !== "string" || event.cardId.length === 0) {
        return { ok: false, code: REVOCATION_FENCING_CODES.WRONG_LINEAGE, detail: `event cardId missing; truth card ${truth.cardId}` };
      }
      if (event.cardId !== truth.cardId) {
        return { ok: false, code: REVOCATION_FENCING_CODES.WRONG_LINEAGE, detail: `event card ${event.cardId} != truth card ${truth.cardId}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Deterministic cascade（Part 6 — minimal dependency representation）.
 *
 * Inputs:
 *   events      — validated revocation events（duplicates by revocationId are
 *                 idempotent; conflicting duplicates by truthId collapse to
 *                 one revocation — set semantics）
 *   evidence    — oracle evidence RECORDS（validateOracleEvidence output shape）
 *                 whose bindings make implicit dependencies explicit:
 *                   evidence → artifact（binding.artifactSha256）
 *                   evidence → authority? none: authority flows through the
 *                   contract seam（pass-oracle §1）, reported here for callers.
 *   dependencies— explicit edges [{ dependentId, dependsOnId }] for any
 *                 caller-known derivation chain（derived truth B ← truth A）.
 *
 * Output:
 *   revokedEvidenceIds / revokedArtifactIds / revokedAuthorityIds — flat sets
 *   cascade — ordered derivation: each newly-revoked id with the reason edge
 *   duplicates — revocationIds seen more than once（applied once）
 *   rejectedEvents — events failing FULL validation（never applied）
 *
 * Only ACTUAL dependents are touched（TR14）: an id enters the revoked set
 * only through a root event or a real dependency edge.
 */
export function computeCascade({ events = [], evidence = [], dependencies = [] } = {}) {
  const validEvents = [];
  const rejected = [];
  const seen = new Set();
  const duplicates = [];
  for (const e of (Array.isArray(events) ? events : [])) {
    // FULL validation on EVERY path（red-team finding: schema-presence-only
    // checks let executor-role / malformed events revoke arbitrary truth）.
    const v = validateRevocationEvent(e);
    if (!v.ok) {
      rejected.push({ revocationId: e?.revocationId ?? null, detail: v.errors.join(",") });
      continue;
    }
    if (seen.has(v.event.revocationId)) { duplicates.push(v.event.revocationId); continue; }
    seen.add(v.event.revocationId);
    validEvents.push(v.event);
  }

  // roots per class
  const rootEvidence = new Set();
  const rootArtifact = new Set();
  const rootAuthority = new Set();
  for (const e of validEvents) {
    if (e.truthClass === "evidence") rootEvidence.add(e.truthId);
    else if (e.truthClass === "artifact") rootArtifact.add(e.truthId);
    else if (e.truthClass === "authority") rootAuthority.add(e.truthId);
  }

  // implicit structural edges from evidence bindings（evidence → artifact）
  const edges = [];
  for (const r of (Array.isArray(evidence) ? evidence : [])) {
    if (r && typeof r === "object" && typeof r.evidenceId === "string" && r.evidenceId.length > 0
      && typeof r.binding?.artifactSha256 === "string") {
      edges.push({ dependentId: r.evidenceId, dependsOnId: r.binding.artifactSha256 });
    }
  }
  for (const d of (Array.isArray(dependencies) ? dependencies : [])) {
    if (d && typeof d.dependentId === "string" && typeof d.dependsOnId === "string") {
      edges.push({ dependentId: d.dependentId, dependsOnId: d.dependsOnId });
    }
  }

  // Deterministic BFS closure over dependents of revoked roots. Seed =
  // evidence-class roots + every evidence bound to a revoked ARTIFACT root
  // （an artifact revocation invalidates its dependents even when no
  // evidence-class root exists — TR4）. Then derived-truth edges propagate.
  const revokedEvidence = new Set(rootEvidence);
  const cascade = [];
  let frontier = [];
  for (const ed of edges) {
    if (rootArtifact.has(ed.dependsOnId) && !revokedEvidence.has(ed.dependentId)) {
      revokedEvidence.add(ed.dependentId);
      cascade.push({ revokedId: ed.dependentId, via: `artifact:${ed.dependsOnId}` });
      frontier.push(ed.dependentId);
    }
  }
  frontier.push(...rootEvidence);
  while (frontier.length > 0) {
    const next = [];
    for (const ed of edges) {
      if (frontier.includes(ed.dependsOnId) && !revokedEvidence.has(ed.dependentId)) {
        // derived-truth chain（A revoked → B invalidated where dependency exists）
        revokedEvidence.add(ed.dependentId);
        cascade.push({ revokedId: ed.dependentId, via: `depends-on:${ed.dependsOnId}` });
        next.push(ed.dependentId);
      }
    }
    frontier = next;
  }
  for (const a of rootArtifact) cascade.push({ revokedId: a, via: "root:artifact" });

  return Object.freeze({
    revokedEvidenceIds: Object.freeze([...revokedEvidence]),
    revokedArtifactIds: Object.freeze([...rootArtifact]),
    revokedAuthorityIds: Object.freeze([...rootAuthority]),
    cascade: Object.freeze(cascade),
    duplicates: Object.freeze(duplicates),
    rejectedEvents: Object.freeze(rejected),
  });
}

/**
 * Shape cascade facts for THE PASS ORACLE（evaluatePassOracle `revocations`
 * input）. The oracle remains the ONLY PASS decision boundary; revocation
 * integrates through it, never around it.
 */
export function revocationFactsForOracle(cascade) {
  if (!cascade || typeof cascade !== "object") return { evidenceIds: [], artifactShas: [], authorityIds: [] };
  return Object.freeze({
    evidenceIds: Object.freeze([...(cascade.revokedEvidenceIds ?? [])]),
    artifactShas: Object.freeze([...(cascade.revokedArtifactIds ?? [])]),
    // Revoked AUTHORITY identities: the oracle rejects any evidence produced
    // by one（red-team finding: authority revocations were computed then dropped）.
    authorityIds: Object.freeze([...(cascade.revokedAuthorityIds ?? [])]),
  });
}
