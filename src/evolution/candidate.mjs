// src/evolution/candidate.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section B: improvement
// candidate derivation. Completes the not-yet-wired `candidate_derivation`
// seam (src/generation-manifest.mjs MATERIAL_CHANGE_PATTERNS) with a real
// production derivation path.
//
// Input:  a fired, gated, provenance-bound improvement trigger event
//         (src/evolution/trigger.mjs) + the run's durable evidence.
// Output: an improvement candidate carrying AT LEAST (card §B):
//   candidate_id, problem_signature, evidence_refs, baseline_revision,
//   affected_scope, expected_improvement, measurement_plan, risk_class,
//   rollback_plan
//
// Hard rules:
//   - Deterministic identity: candidate_id = sha256 over the canonical
//     trigger + derivation facts. Same trigger ⇒ same candidate (dedup at
//     the identity level; a re-fired identical trigger re-derives the SAME
//     candidate, never a duplicate stream).
//   - Same problem_signature cannot infinitely regenerate: the candidate
//     store records derivation per (signature, baseline) pair; a repeat at
//     the SAME baseline is a no-op (already derived), a repeat at a NEW
//     baseline (the previous candidate was promoted/rejected) is legal.
//   - Evidence provenance: every candidate carries the trigger's durable
//     evidence_refs (journal event ids) — never an unanchored observation.
//   - The derivation NEVER mutates the repository: it produces candidate
//     DATA plus a bounded mutation PLAN (the concrete file edits / commands
//     the mutation stage will execute inside the isolated worktree). The
//     plan itself is data; executing it is the mutation stage's job under
//     policy authority.
//   - NON-AUTHORITATIVE: a candidate is a proposal. Risk classification,
//     policy authorization, mutation, fitness, review and promotion are
//     separate downstream stages with their own gates.

import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { C2dHoldError, writeJsonExclusiveCreate, assertNotSymlink } from "../c2d/fs-atomic.mjs";
import { canonicalize, digestOf } from "../canonical-digest.mjs";
import { classifyCandidateRisk } from "./policy.mjs";

export const EVOLUTION_CANDIDATE_SCHEMA = "autoloop.evolution-candidate/v1";
export const EVOLUTION_CANDIDATE_HOLD = Object.freeze({
  TRIGGER_INVALID: "HOLD / EVOLUTION_CANDIDATE_TRIGGER_INVALID",
  DERIVATION_UNSUPPORTED: "HOLD / EVOLUTION_CANDIDATE_DERIVATION_UNSUPPORTED",
  ALREADY_DERIVED: "HOLD / EVOLUTION_CANDIDATE_ALREADY_DERIVED",
  MALFORMED: "HOLD / EVOLUTION_CANDIDATE_MALFORMED",
  // PROPOSAL-ONLY REPAIR (G2): the durable write could not be proven. A
  // proposal that is not on disk is never reported as created.
  PERSIST_FAILED: "HOLD / EVOLUTION_CANDIDATE_PERSIST_FAILED",
  // TARGETED REMEDIATION 2 (F4): the candidate ARTIFACT is durable but its
  // derivation-index entry could not be written. Distinct from PERSIST_FAILED
  // on purpose — it tells the operator the proposal exists and only the index
  // needs repair, so a retry is safe and nothing is claimed lost.
  INDEX_WRITE_FAILED: "HOLD / EVOLUTION_CANDIDATE_INDEX_WRITE_FAILED",
  // LOW-RISK HARDENING 1 (N1): two DIFFERENT candidates claim one identity
  // (same family + signature + baseline, or one artifact id with different
  // content). An identity conflict is NOT an index I/O failure: the index was
  // readable and writable, it simply refused to repoint an owner. Reporting it
  // as INDEX_WRITE_FAILED sent the operator to inspect storage instead of the
  // competing proposal.
  CANDIDATE_CONFLICT: "HOLD / EVOLUTION_CANDIDATE_CONFLICT",
});

// Deterministic repair strategies the derivation can plan for a trigger
// signature. Each strategy is a BOUNDED, REVIEWABLE transform — the v1 set
// is intentionally small (card §B: no speculative framework). A trigger
// whose signature matches no strategy fails closed DERIVATION_UNSUPPORTED
// (recorded, never silently dropped) so new strategies are added by card,
// not improvised.
export const DERIVATION_STRATEGIES = Object.freeze([
  "BOUNDED_CONSTANT_TUNING",       // adjust a bounded numeric threshold/config constant
  "DETERMINISTIC_BUG_REPAIR",      // narrow, evidence-cited code fix (patch text carried by evidence)
  "TELEMETRY_EFFICIENCY_REPAIR",   // reduce measured waste (retry backoff, redundant work)
]);

function fail(code, message, details) {
  throw new C2dHoldError(code, message, details);
}

// ── Candidate store (durable, exclusive-create, digest-bound) ──────────────

export function candidateStorePath(policyRoot) {
  return join(policyRoot, "evolution-candidates");
}

export function candidateFilePath(policyRoot, candidateId) {
  return join(candidateStorePath(policyRoot), `${candidateId}.json`);
}

export function derivationIndexPath(policyRoot) {
  return join(policyRoot, "evolution-derivation-index.json");
}

/** The two candidate families the loop derives (never one index namespace). */
export const CANDIDATE_FAMILIES = Object.freeze(["SOURCE", "AGENT_STRATEGY"]);

/** The family of an existing artifact. Absent `candidate_kind` means SOURCE
 *  (every candidate written before the strategy family existed). */
export function candidateFamily(candidate) {
  return candidate?.candidate_kind === "AGENT_STRATEGY" ? "AGENT_STRATEGY" : "SOURCE";
}

/**
 * The derivation-index key for ONE candidate family.
 *
 * TARGETED REMEDIATION 2 / F3: the SOURCE family keeps the historical
 * unqualified `<signature>@<head>` key (so existing stores keep working with no
 * migration), and every OTHER family namespaces its key. Sharing one key meant
 * a persisted strategy proposal became the "already derived" answer for a later
 * SOURCE derivation of the same signature@baseline (and vice versa): the loop
 * returned CANDIDATE_EXISTS for a candidate of the WRONG family and never
 * derived the one it was asked for.
 */
export function derivationKey(family, signature, baselineHead) {
  const base = `${signature}@${baselineHead}`;
  return family === "SOURCE" ? base : `${family}:${base}`;
}

function readDerivationIndex(policyRoot) {
  const p = derivationIndexPath(policyRoot);
  if (!existsSync(p)) return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (raw?.schema !== EVOLUTION_CANDIDATE_SCHEMA) return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} };
    return raw;
  } catch { return { schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations: {} }; }
}

function writeDerivationIndex(policyRoot, index) {
  const p = derivationIndexPath(policyRoot);
  const tmp = `${p}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, JSON.stringify(index, null, 2) + "\n", "utf8");
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best-effort */ }
    // TARGETED REMEDIATION 2 / F4: a failed INDEX write is its own controlled
    // classification. The candidate artifact may already be durable — the
    // caller must be able to say exactly that and retry the index, instead of
    // reporting PERSIST_FAILED (which reads as "nothing was persisted").
    throw new C2dHoldError(EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED,
      `derivation index write failed: ${String(e?.code ?? "").trim()}${e?.code ? ": " : ""}${String(e?.message ?? e).slice(0, 200)}`,
      { errno: e?.code ?? null, path: p });
  }
}

export function readCandidate(policyRoot, candidateId) {
  const p = candidateFilePath(policyRoot, candidateId);
  if (!existsSync(p)) return null;
  assertNotSymlink(p);
  try {
    const c = JSON.parse(readFileSync(p, "utf8"));
    if (c?.schema !== EVOLUTION_CANDIDATE_SCHEMA) return null;
    return c;
  } catch { return null; }
}

/**
 * The IMMUTABLE content digest of a candidate: everything except its own
 * digest and the wall-clock `created_at`.
 *
 * `created_at` is deliberately excluded: a candidate identity is deterministic
 * over its facts, so a retried event re-derives the SAME proposal at a later
 * instant. Two artifacts that differ only in `created_at` are the same
 * proposal (first write wins), never an identity conflict.
 */
export function proposalContentDigest(candidate) {
  return digestOf({ ...candidate, candidate_digest: undefined, created_at: undefined });
}

/**
 * Record one derivation in the store's index under its OWN family key, and
 * report whether the index accepted it.
 *
 * TARGETED REMEDIATION 2 (F3/F4):
 *   - the key is FAMILY-QUALIFIED (`derivationKey`), so a strategy proposal and
 *     a source candidate for the same signature@baseline are two independent
 *     entries and neither can alias the other;
 *   - a family entry already owned by the SAME candidate is a no-op (retry);
 *   - an entry owned by a DIFFERENT candidate is a conflict and fails closed —
 *     the index never silently repoints an identity. The conflict is reported
 *     as CANDIDATE_CONFLICT (N1), never as a write failure: nothing was
 *     unwritable.
 *   - an index WRITE failure surfaces as INDEX_WRITE_FAILED, never as
 *     PERSIST_FAILED: the caller still holds a durable artifact.
 *
 * @returns {{ indexed: boolean, status: "INDEXED"|"ALREADY_INDEXED"|"CONFLICT"|"WRITE_FAILED", key: string, error: string|null, code: string|null }}
 */
export function indexDerivation(storeRoot, candidate) {
  const family = candidateFamily(candidate);
  const key = derivationKey(family, candidate.problem_signature, candidate.baseline_head);
  const index = readDerivationIndex(storeRoot);
  const derivations = (index.derivations && typeof index.derivations === "object") ? index.derivations : {};
  const existing = derivations[key];
  if (existing !== undefined && existing !== candidate.candidate_id) {
    // A key is owned by its FAMILY, so an entry pointing at a candidate of a
    // DIFFERENT family is not an owner — it is the residue of the shared-key
    // build (before F3 namespaced the strategy family). The genuine owner
    // reclaims it and the legacy artifact stays on disk, untouched.
    const priorPath = candidateFilePath(storeRoot, String(existing));
    const priorOwner = readCandidate(storeRoot, String(existing));
    if (!priorOwner && existsSync(priorPath)) {
      // The artifact exists but cannot be read: an integrity anomaly, not
      // legacy residue. Never repoint an identity over an unreadable record.
      return {
        indexed: false, status: "CONFLICT", key,
        error: `${family} derivation ${key} points at unreadable artifact ${String(existing)}`,
        code: EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT,
        conflict: { kind: "unreadable_owner", owner_id: String(existing), family, key },
      };
    }
    if (priorOwner && candidateFamily(priorOwner) === family) {
      return {
        indexed: false, status: "CONFLICT", key,
        error: `${family} derivation ${key} is already owned by ${String(existing)}`,
        code: EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT,
        conflict: { kind: "different_candidate", owner_id: String(existing), family, key },
      };
    }
    // fall through: the entry belongs to another family (or its artifact is
    // gone), so this family takes its own key.
  }
  if (existing === candidate.candidate_id) return { indexed: true, status: "ALREADY_INDEXED", key, error: null, code: null, conflict: null };
  derivations[key] = candidate.candidate_id;
  try {
    writeDerivationIndex(storeRoot, { ...index, schema: EVOLUTION_CANDIDATE_SCHEMA, version: 1, derivations });
  } catch (e) {
    return {
      indexed: false, status: "WRITE_FAILED", key,
      error: String(e?.message ?? e).slice(0, 300),
      code: e instanceof C2dHoldError && typeof e.code === "string" ? e.code : EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED,
      conflict: null,
    };
  }
  return { indexed: true, status: "INDEXED", key, error: null, code: null, conflict: null };
}

/**
 * Build the hold for a derivation index that refused the entry.
 *
 * Two DISTINCT facts (N1), never merged:
 *   - CANDIDATE_CONFLICT — the index is healthy and refused to repoint an
 *     identity it already owns. Nothing is unwritable; the operator must look
 *     at the competing candidate, not at storage.
 *   - INDEX_WRITE_FAILED — the index could not be written. The artifact is
 *     durable and a retry repairs the index.
 *
 * Neither carries `artifact_durable:true` semantics accidentally: the conflict
 * DOES carry it (the artifact landed) together with `conflict`, and the loop
 * classifies by CODE before it reads `artifact_durable`.
 */
function derivationIndexHold(index, candidate, path) {
  if (index.code === EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT) {
    return new C2dHoldError(EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT,
      `candidate ${candidate.candidate_id} conflicts with the derivation it would claim: ${index.error}`,
      {
        candidate_id: candidate.candidate_id, candidate_path: path, artifact_durable: true,
        index_key: index.key, conflict: index.conflict ?? null,
      });
  }
  return new C2dHoldError(index.code ?? EVOLUTION_CANDIDATE_HOLD.INDEX_WRITE_FAILED,
    `candidate ${candidate.candidate_id} is durable but not indexed: ${index.error}`,
    { candidate_id: candidate.candidate_id, candidate_path: path, artifact_durable: true, index_key: index.key });
}

/**
 * THE durable candidate write (PROPOSAL-ONLY REPAIR §G2).
 *
 * Writes one already-derived candidate into the EXISTING governed candidate
 * store — same directory, same schema, same derivation index, same
 * exclusive-create semantics as `deriveImprovementCandidate`. There is no
 * second store and no new file format: a strategy proposal lands exactly where
 * the operator view (`listCandidatesSafe`) and crash recovery
 * (`reconcileEvolutionState`) already look.
 *
 * Idempotency: a candidate identity is deterministic, so a repeat write is an
 * `EXISTING` no-op — the same event retried can never fan out into duplicate
 * proposals. An existing artifact with a DIFFERENT immutable content digest is
 * an identity conflict and fails closed as CANDIDATE_CONFLICT (N1): identity
 * must not silently alias two different proposals, and the operator must not be
 * told that a write failed when what happened is a COMPETING proposal.
 *
 * Failure is never silent AND never misclassified (TARGETED REMEDIATION 2/F4,
 * LOW-RISK HARDENING 1/N1): the artifact write, the read-back and the index
 * write are separate facts. A failure before the artifact lands throws
 * PERSIST_FAILED; an index that REFUSES an identity throws CANDIDATE_CONFLICT;
 * an index that cannot be written throws INDEX_WRITE_FAILED. The two
 * post-artifact holds both carry `artifact_durable: true`, so the caller can
 * say exactly what exists and a retry is provably safe.
 *
 * @param {string} storeRoot — the evolution store root
 * @param {object} candidate — an `autoloop.evolution-candidate/v1` record
 * @returns {{ status: "CREATED"|"EXISTING", candidate: object, path: string,
 *             candidate_kind: string, index: object }}
 */
export function persistCandidate(storeRoot, candidate) {
  if (!storeRoot || typeof storeRoot !== "string") {
    fail(EVOLUTION_CANDIDATE_HOLD.PERSIST_FAILED, "no evolution store root for the candidate write");
  }
  if (candidate?.schema !== EVOLUTION_CANDIDATE_SCHEMA) {
    fail(EVOLUTION_CANDIDATE_HOLD.MALFORMED, "candidate is not autoloop.evolution-candidate/v1");
  }
  if (typeof candidate.candidate_id !== "string" || !/^ecand_[0-9a-f]{40}$/.test(candidate.candidate_id)) {
    fail(EVOLUTION_CANDIDATE_HOLD.MALFORMED, `candidate id is not deterministic: ${String(candidate.candidate_id)}`);
  }
  const recorded = candidate.candidate_digest;
  if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) {
    fail(EVOLUTION_CANDIDATE_HOLD.MALFORMED, "candidate carries no content digest");
  }
  if (digestOf({ ...candidate, candidate_digest: undefined }) !== recorded) {
    fail(EVOLUTION_CANDIDATE_HOLD.MALFORMED, "candidate content does not re-derive its own digest");
  }

  const path = candidateFilePath(storeRoot, candidate.candidate_id);
  let status = "CREATED";
  try {
    writeJsonExclusiveCreate(path, candidate);
  } catch (e) {
    const existing = readCandidate(storeRoot, candidate.candidate_id);
    if (!existing) throw e;
    if (proposalContentDigest(existing) !== proposalContentDigest(candidate)) {
      fail(EVOLUTION_CANDIDATE_HOLD.CANDIDATE_CONFLICT,
        `candidate id ${candidate.candidate_id} already exists with different content (identity conflict)`,
        {
          candidate_id: candidate.candidate_id, candidate_path: path, artifact_durable: true,
          conflict: { kind: "different_content", owner_id: candidate.candidate_id, family: candidateFamily(existing), key: null },
        });
    }
    status = "EXISTING";
  }

  // The artifact that is on disk is the authority from here on: a retry keeps
  // the FIRST write's `created_at`, so a replayed proposal never rewrites the
  // durable record it already produced.
  const persisted = readCandidate(storeRoot, candidate.candidate_id);
  if (!persisted) {
    fail(EVOLUTION_CANDIDATE_HOLD.PERSIST_FAILED,
      `candidate ${candidate.candidate_id} was not durably readable after the write`);
  }
  if (proposalContentDigest(persisted) !== proposalContentDigest(candidate)) {
    fail(EVOLUTION_CANDIDATE_HOLD.PERSIST_FAILED,
      `candidate ${candidate.candidate_id} on disk does not match the derived proposal`);
  }
  if (digestOf({ ...persisted, candidate_digest: undefined }) !== persisted.candidate_digest) {
    fail(EVOLUTION_CANDIDATE_HOLD.PERSIST_FAILED,
      `candidate ${candidate.candidate_id} does not re-derive its own stored digest`);
  }

  // Index the derivation under THIS candidate's family so the same-baseline
  // dedup and the operator generation count see the proposal — without ever
  // rewriting another family's entry for the same signature@baseline.
  const index = indexDerivation(storeRoot, persisted);
  if (!index.indexed) throw derivationIndexHold(index, persisted, path);
  return { status, candidate: persisted, path, candidate_kind: candidateFamily(persisted), index };
}

// ── Derivation ──────────────────────────────────────────────────────────────

/**
 * Select the derivation strategy for a fired trigger. Deterministic over
 * the trigger facts. Returns null when no strategy applies (caller fails
 * closed with DERIVATION_UNSUPPORTED).
 */
export function selectDerivationStrategy({ signalClass, observation, signature }) {
  switch (signalClass) {
    case "REPEATED_EQUIVALENT_FAILURE":
    case "RECURRING_HOLD_PATTERN":
      // A recurring HOLD/failure with a code-level cause is a deterministic
      // bug repair candidate; the affected scope + patch plan must be
      // carried by the observation (evidence-bound), otherwise unsupported.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : null;
    case "REPEATED_REPAIR_REQUIREMENT":
      // Repeated repairs on the same phase indicate an efficiency/robustness
      // defect in that phase's bounded configuration — constant tuning first
      // (the smallest safe transform), behavioral repair only with a patch.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : "BOUNDED_CONSTANT_TUNING";
    case "ABNORMAL_RETRY_FREQUENCY":
      return "TELEMETRY_EFFICIENCY_REPAIR";
    case "LATENCY_REGRESSION":
    case "TOKEN_INEFFICIENCY":
      return "TELEMETRY_EFFICIENCY_REPAIR";
    case "QUALIFIED_PATTERN_EVIDENCE":
      // A qualified pattern proposes a bounded improvement; it must carry a
      // concrete patch plan to be actionable.
      return observation?.patchPlan ? "DETERMINISTIC_BUG_REPAIR" : null;
    default:
      return null;
  }
}

/**
 * Derive the affected scope + mutation plan for one strategy. The plan is
 * DATA: exact relative paths + bounded edits/commands. Scope comes from the
 * trigger observation when present (evidence-bound), otherwise the strategy
 * default (config/constant surfaces only — never authority code).
 */
export function deriveMutationPlan({ strategy, observation, scopeHints = [] }) {
  const scope = (scopeHints.length ? scopeHints : (observation?.affectedScope ?? []))
    .filter((p) => typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.split("/").includes(".."));
  if (!scope.length) return null;
  const edits = [];
  if (strategy === "BOUNDED_CONSTANT_TUNING") {
    // One bounded numeric adjustment per affected file, cited to evidence.
    for (const p of scope) {
      edits.push({
        path: p,
        kind: "constant_adjustment",
        target: observation?.constantTarget ?? null,
        adjustment: observation?.constantAdjustment ?? null,
        evidence_refs: observation?.evidenceRefs ?? [],
      });
    }
  } else if (strategy === "DETERMINISTIC_BUG_REPAIR") {
    edits.push({
      path: scope[0],
      kind: "patch_apply",
      patch: observation.patchPlan.patch ?? null,
      evidence_refs: observation?.evidenceRefs ?? [],
    });
  } else if (strategy === "TELEMETRY_EFFICIENCY_REPAIR") {
    for (const p of scope) {
      edits.push({
        path: p,
        kind: "efficiency_adjustment",
        metric: observation?.metric ?? null,
        evidence_refs: observation?.evidenceRefs ?? [],
      });
    }
  }
  return { strategy, affected_scope: scope, edits };
}

/**
 * THE candidate derivation entry. Consumes one gated trigger event and
 * produces (or idempotently returns) the durable improvement candidate.
 *
 * @param {object} p
 * @param {object} p.triggerEvent — buildTriggerEvent output (gated)
 * @param {string} p.baselineHead — frozen baseline HEAD (40-hex)
 * @param {string} p.baselineRevision — durable checkpoint revision at trigger time
 * @param {string} p.storeRoot — durable store root for candidates
 * @param {string[]} [p.scopeHints] — evidence-derived affected paths
 * @param {object} [p.measurement] — { metric, baselineValue, direction } measurement plan override
 * @returns {{ status: "CREATED"|"EXISTING"|"UNSUPPORTED", candidate?: object, reason?: string }}
 */
export function deriveImprovementCandidate({ triggerEvent, baselineHead, baselineRevision, storeRoot, scopeHints = [], measurement = null }) {
  if (!triggerEvent || triggerEvent.schema !== "autoloop.evolution-trigger/v1") {
    fail(EVOLUTION_CANDIDATE_HOLD.TRIGGER_INVALID, "trigger event missing or wrong schema");
  }
  if (!/^[0-9a-f]{40}$/.test(baselineHead || "")) {
    fail(EVOLUTION_CANDIDATE_HOLD.TRIGGER_INVALID, "baseline HEAD invalid");
  }
  const strategy = selectDerivationStrategy({
    signalClass: triggerEvent.signal_class,
    observation: triggerEvent.observation,
    signature: triggerEvent.signature,
  });
  if (!strategy) {
    return { status: "UNSUPPORTED", reason: `no derivation strategy for ${triggerEvent.signal_class} (recorded; add a strategy by card, never improvised)` };
  }
  const plan = deriveMutationPlan({ strategy, observation: triggerEvent.observation, scopeHints });
  if (!plan || !plan.affected_scope.length || plan.edits.some((e) => e.kind === "patch_apply" && !e.patch)) {
    return { status: "UNSUPPORTED", reason: `strategy ${strategy} lacks a concrete bounded plan (affected scope / patch missing)` };
  }

  // Deterministic identity over trigger + baseline + plan facts.
  const identityFacts = {
    trigger_id: triggerEvent.trigger_id,
    signal_class: triggerEvent.signal_class,
    signature: triggerEvent.signature,
    baseline_head: baselineHead,
    strategy,
    affected_scope: [...plan.affected_scope].sort(),
  };
  const candidateId = `ecand_${digestOf(identityFacts).slice(0, 40)}`;

  // Same-signature dedup at the SAME baseline, WITHIN the SOURCE family: an
  // already derived SOURCE candidate is a no-op. A legacy unqualified index
  // entry that points at another family's artifact (written before the family
  // namespace existed) is NOT a SOURCE derivation — treating it as one would
  // hand the loop a strategy proposal and skip the source candidate entirely
  // (TARGETED REMEDIATION 2 / F3).
  const index = readDerivationIndex(storeRoot);
  const key = derivationKey("SOURCE", triggerEvent.signature, baselineHead);
  const indexedId = index.derivations?.[key];
  if (indexedId) {
    const existing = readCandidate(storeRoot, indexedId);
    if (existing && candidateFamily(existing) === "SOURCE") return { status: "EXISTING", candidate: existing };
  }

  // Risk classification (Section C) — recorded on the candidate; the
  // downstream policy gate re-derives it and never trusts this field alone.
  const classification = classifyCandidateRisk({
    affected_scope: plan.affected_scope,
    declared_risk_markers: triggerEvent.observation?.declaredRiskMarkers ?? [],
  });

  // Measurement plan: what the fitness stage must compare (card §F).
  const measurementPlan = measurement ?? {
    metric: triggerEvent.signal_class === "LATENCY_REGRESSION" ? "wall_duration_ms"
      : triggerEvent.signal_class === "TOKEN_INEFFICIENCY" ? "provider_occupancy"
      : "failure_or_repair_count",
    baselineValue: triggerEvent.observation?.currentAvg ?? triggerEvent.count ?? null,
    direction: "decrease", // an improvement lowers the trigger metric
    regressionGate: "zero_regression", // correctness suites must not regress
  };

  const candidate = {
    schema: EVOLUTION_CANDIDATE_SCHEMA,
    version: 1,
    candidate_id: candidateId,
    created_at: new Date().toISOString(),
    problem_signature: triggerEvent.signature,
    signal_class: triggerEvent.signal_class,
    trigger_id: triggerEvent.trigger_id,
    evidence_refs: [...triggerEvent.evidence_refs].sort(),
    baseline_revision: baselineRevision,
    baseline_head: baselineHead,
    affected_scope: [...plan.affected_scope].sort(),
    derivation_strategy: strategy,
    mutation_plan: plan,
    expected_improvement: {
      kind: strategy === "DETERMINISTIC_BUG_REPAIR" ? "correctness" : "efficiency",
      metric: measurementPlan.metric,
      direction: measurementPlan.direction,
      cited_observation: triggerEvent.observation ?? {},
    },
    measurement_plan: measurementPlan,
    risk_class: classification.riskClass,
    risk_reasons: classification.reasons,
    rollback_plan: {
      kind: "worktree_discard", // isolated worktree: discard = complete rollback
      baseline_head: baselineHead,
      note: "mutation runs in an isolated C3B worktree; failure/rejection discards the worktree — the production checkout is never touched",
    },
    status: "DERIVED",
  };
  candidate.candidate_digest = digestOf({ ...candidate, candidate_digest: undefined });

  // Persist (exclusive-create) + record the derivation index under the SOURCE
  // key. The artifact is already durable here, so an index failure carries its
  // own classification (F4) instead of the generic persist failure.
  mkdirSync(candidateStorePath(storeRoot), { recursive: true });
  const p = candidateFilePath(storeRoot, candidateId);
  try {
    writeJsonExclusiveCreate(p, candidate);
  } catch (e) {
    const existing = readCandidate(storeRoot, candidateId);
    if (existing) return { status: "EXISTING", candidate: existing };
    throw e;
  }
  const indexed = indexDerivation(storeRoot, candidate);
  if (!indexed.indexed) throw derivationIndexHold(indexed, candidate, p);
  return { status: "CREATED", candidate };
}

/** List candidates (bounded, newest last) for the operator surface. */
export function listCandidates(storeRoot, { limit = 32 } = {}) {
  const dir = candidateStorePath(storeRoot);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(-limit);
  const out = [];
  for (const f of files) {
    try {
      const c = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (c?.schema === EVOLUTION_CANDIDATE_SCHEMA) out.push(c);
    } catch { /* skip unreadable */ }
  }
  return out;
}
