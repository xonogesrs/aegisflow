// src/v2/decomposition-inheritance.mjs
//
// DECOMP-OPT1-PC1 — Parent→Child context & evidence inheritance core.
//
// Single authoritative Parent/Run inheritance artifact
//（autoloop.decomposition-inheritance/v1）+ deterministic Child Execution
// Packet（autoloop.child-execution-packet/v1）+ three-way fact disposition
//（REUSE / REVALIDATE / RECOMPUTE）+ F3A run-level repository identity
// binding（R1-C: per-child guard = single `git rev-parse HEAD`, tree implied
// by commit identity）+ fail-closed invalidation.
//
// Contract (frozen in docs/governance/autoloop-decomp-opt1-design-inventory.md
// §8, extended by DECOMP-OPT1-PC1 §E/§F/§G/§J/§K):
//   - identical（parentCardId, parentGeneration, graphRunId, repository
//     identity, inputFingerprint, irSha, dagSha, phase table）⇒ identical
//     manifestSha256（deterministic identity; U-1 regression）.
//   - wall-clock fields（createdAt / observedAt）are MANIFEST METADATA — they
//     never enter the digest, so a resumed run rebuilds the same identity.
//   - every inherited fact has a mechanical disposition; ambiguity fails
//     closed（HOLD / INHERITED_CONTEXT_FRESHNESS_UNPROVEN）.
//   - child inheritance NEVER widens scope: the packet carries the child's
//     own authorized/unauthorized scope + mutation authority derived from the
//     IR phase + parent scope; the phase-task-card hard gates still run
//     per child（containment re-check stays per child）.
//
// This module is PURE / deterministic: no git, no fs, no wall clock in the
// digest core. The only external seam is guardRepositoryIdentity（one
// bounded `git rev-parse HEAD`）.

import { execFileSync } from "node:child_process";
import { canonicalJson, sha256Text } from "../evidence/run-evidence-store.mjs";

export const DECOMPOSITION_INHERITANCE_SCHEMA = "autoloop.decomposition-inheritance/v1";
export const DECOMPOSITION_INHERITANCE_FORMAT_VERSION = "1.0.0";
export const CHILD_EXECUTION_PACKET_SCHEMA = "autoloop.child-execution-packet/v1";
export const CHILD_EXECUTION_PACKET_FORMAT_VERSION = "1.0.0";

// ── Hold / disposition codes ─────────────────────────────────────────────

export const INHERITANCE_HOLD = Object.freeze({
  IDENTITY_DRIFT: "DECOMPOSITION_INHERITANCE_IDENTITY_DRIFT",
  FRESHNESS_UNPROVEN: "INHERITED_CONTEXT_FRESHNESS_UNPROVEN",
  AUTHORITY_AMBIGUOUS: "PARENT_CHILD_INHERITANCE_AUTHORITY_AMBIGUOUS",
  CHILD_SCOPE_EXPANDED: "CHILD_SCOPE_EXPANDED_BY_INHERITANCE",
  STALE_EVIDENCE_REUSED: "STALE_EVIDENCE_REUSED",
  CBM_WRITEBACK_GAP: "CBM_DECOMP_INHERITANCE_WRITEBACK_GAP",
  REPOSITORY_DRIFT: "REPOSITORY_IDENTITY_DRIFT",
});

export const DISPOSITIONS = Object.freeze(["REUSE", "REVALIDATE", "RECOMPUTE", "HOLD"]);

// Fact kinds（the DECOMP-OPT1 fact taxonomy F1–F8, projected to this card）.
export const FACT_KINDS = Object.freeze([
  "PARENT_SPEC",        // F1 — parent input / requirements / scope
  "DECOMPOSITION_IR",   // F2 — decomposition revision（irSha / dagSha）
  "REPOSITORY_IDENTITY",// F3A — root / HEAD / tree（immutable artifact identity）
  "REF_METADATA",       // F3B — branch / origin / dirty digest（run-level context）
  "AUTHORITY_CONTRACT", // parent scope + repair/reviewer/tool policy
  "DEPENDENCY",         // IR dependency edges（depends_on）
  "EVIDENCE_REF",       // prior evidence location + sha256（reference, never copy）
  "VERIFICATION_OUTCOME", // prior verification outcomes（immutable by digest）
]);

// Invalidation condition predicates（mechanical; every fact declares which
// apply）. Values are the fixed vocabulary from §J.
export const INVALIDATION_CONDITIONS = Object.freeze({
  HEAD_CHANGED: "head_changed",
  TREE_SHA_CHANGED: "tree_sha_changed",
  WORKTREE_IDENTITY_CHANGED: "worktree_identity_changed",
  FILE_DIGEST_CHANGED: "file_digest_changed",
  AUTHORITY_IDENTITY_CHANGED: "authority_identity_changed",
  DEPENDENCY_IDENTITY_CHANGED: "dependency_identity_changed",
  RUNTIME_GENERATION_CHANGED: "runtime_generation_changed",
  EVIDENCE_MISSING_OR_CORRUPT: "evidence_missing_or_corrupt",
  MANIFEST_DIGEST_MISMATCH: "manifest_digest_mismatch",
  PARENT_GENERATION_SUPERSEDED: "parent_generation_superseded",
});

export const FRESHNESS_POLICIES = Object.freeze({
  IMMUTABLE: "immutable",                       // content-digest stable ⇒ REUSE
  RUN_SNAPSHOT: "run_snapshot",                 // frozen at run start; cheap guard
  FILE_DIGEST: "file_digest",                   // bound to a file's sha256
  TIME_SENSITIVE: "time_sensitive",             // runtime/time-sensitive ⇒ REVALIDATE
  CHILD_LOCAL: "child_local",                   // never inherited (RECOMPUTE always)
});

const FACT_CORE_FIELDS = Object.freeze([
  "factId", "kind", "value", "reference", "sourceAuthority", "sourceIdentity",
  "freshnessPolicy", "invalidationConditions", "defaultDisposition",
]);

/**
 * Build one inherited fact（deterministic identity-relevant core; observedAt
 * is metadata and never enters the manifest digest）.
 */
export function createInheritedFact({
  factId,
  kind,
  value = null,
  reference = null,
  sourceAuthority,
  sourceIdentity,
  observedAt,
  freshnessPolicy,
  invalidationConditions = [],
  defaultDisposition = "REUSE",
  filePaths = [],
  contentHash = null,
}) {
  if (!factId || !FACT_KINDS.includes(kind)) {
    throw new TypeError(`invalid fact id/kind: ${factId}/${kind}`);
  }
  if (!FRESHNESS_POLICIES[freshnessPolicy.toUpperCase()] && !Object.values(FRESHNESS_POLICIES).includes(freshnessPolicy)) {
    throw new TypeError(`invalid freshnessPolicy: ${freshnessPolicy}`);
  }
  if (!DISPOSITIONS.includes(defaultDisposition)) {
    throw new TypeError(`invalid defaultDisposition: ${defaultDisposition}`);
  }
  const fact = {
    factId,
    kind,
    value: value ?? null,
    reference: reference ?? null,
    sourceAuthority,
    sourceIdentity,
    observedAt: observedAt ?? null,
    freshnessPolicy,
    invalidationConditions: Array.isArray(invalidationConditions) ? [...invalidationConditions] : [],
    defaultDisposition,
    // Optional child-local binding: the paths whose content digest this fact
    // is bound to（FILE_DIGEST freshness）. Paths are repository-relative.
    ...(Array.isArray(filePaths) && filePaths.length > 0 ? { filePaths: [...filePaths] } : {}),
    ...(contentHash ? { contentHash } : {}),
  };
  return fact;
}

/** The digest-relevant core of a fact（observedAt / filePaths metadata excluded）. */
function factCore(fact) {
  const out = {};
  for (const k of FACT_CORE_FIELDS) {
    if (fact[k] !== undefined && fact[k] !== null) out[k] = fact[k];
  }
  return out;
}

// ── Manifest identity ────────────────────────────────────────────────────

export function deriveManifestIdentity(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError(`manifestSha256 must be a 64-hex digest, got ${String(sha256).slice(0, 16)}…`);
  return `decompInherit_${sha256.slice(0, 16)}`;
}

/** The digest-relevant manifest core（createdAt / manifestIdentity / manifestSha256
 * and per-fact observedAt excluded — wall-clock metadata never enters the
 * identity, so a resumed run rebuilds the same digest）.
 */
export function manifestDigestCore(manifest) {
  const out = {};
  for (const k of [
    "schema", "formatVersion", "parentCardId", "parentGeneration", "graphRunId",
    "repositoryIdentity", "inputFingerprint", "irSha", "dagSha",
    "authorityRefs", "contractRefs", "dependencyRefs", "evidenceRefs",
  ]) {
    if (manifest[k] !== undefined) out[k] = manifest[k];
  }
  out.facts = (manifest.facts || []).map(factCore);
  return out;
}

export function computeManifestSha256(manifest) {
  return sha256Text(canonicalJson(manifestDigestCore(manifest)));
}

/**
 * Build the decomposition-inheritance manifest. Deterministic identity:
 * same（parentCardId, parentGeneration, graphRunId, repositoryIdentity,
 * inputFingerprint, irSha, dagSha, phase table, refs）⇒ same manifestSha256.
 *
 * @param {object} opts
 * @param {string} opts.parentCardId — parent card identity
 * @param {number} [opts.parentGeneration = 1] — parent generation（supersede check）
 * @param {string} opts.graphRunId — run identity（executionId）
 * @param {object} opts.repositoryIdentity — F3A/F3B snapshot:
 *   { repository_root_identity, worktree_identity, git_common_dir_identity,
 *     expected_head, expected_tree, expected_ref, origin_url, origin_master,
 *     expected_worktree_state }
 * @param {string} opts.inputFingerprint — frozen input digest
 * @param {string} opts.irSha — decomposition IR sha256
 * @param {string} opts.dagSha — DAG fingerprint
 * @param {string[]} opts.phaseIds — declared phase ids（dependency table）
 * @param {string[]} [opts.authorityRefs] — parent authority refs（e.g. scope digest）
 * @param {object[]} [opts.contractRefs] — harness contract refs（repair budget /
 *   reviewer model / tool policy digest）
 * @param {string[]} [opts.dependencyRefs] — dependency identities
 * @param {string[]} [opts.evidenceRefs] — prior evidence identities（sha256 refs）
 * @param {Array<{path: string, sha256: string|null}>} [opts.specFileDigests] —
 *   parent-spec file content digests（observed once; FILE_DIGEST freshness —
 *   a per-child digest re-check is a REVALIDATE obligation, never full rediscovery）
 * @param {string} [opts.createdAt] — wall-clock metadata（never in the digest）
 * @returns {{ manifest: object, manifestSha256: string, manifestIdentity: string }}
 */
export function buildInheritanceManifest({
  parentCardId,
  parentGeneration = 1,
  graphRunId,
  repositoryIdentity,
  inputFingerprint,
  irSha,
  dagSha,
  phaseIds = [],
  authorityRefs = [],
  contractRefs = [],
  dependencyRefs = [],
  evidenceRefs = [],
  specFileDigests = [],
  createdAt = null,
} = {}) {
  for (const [k, v] of Object.entries({
    parentCardId, graphRunId, inputFingerprint, irSha, dagSha,
  })) {
    if (typeof v !== "string" || v.length === 0) throw new TypeError(`${k} is required`);
  }
  if (!repositoryIdentity || typeof repositoryIdentity !== "object" || Array.isArray(repositoryIdentity)) {
    throw new TypeError("repositoryIdentity is required (F3A snapshot object)");
  }
  if (!repositoryIdentity.expected_head || !repositoryIdentity.expected_tree) {
    throw new TypeError("repositoryIdentity.expected_head / expected_tree are required (F3A)");
  }
  if (!Array.isArray(phaseIds)) throw new TypeError("phaseIds must be an array");
  if (!/^[0-9a-f]{64}$/.test(irSha)) throw new TypeError(`irSha must be 64-hex, got ${String(irSha).slice(0, 16)}…`);
  if (!/^[0-9a-f]{64}$/.test(dagSha)) throw new TypeError(`dagSha must be 64-hex, got ${String(dagSha).slice(0, 16)}…`);
  if (!/^[0-9a-f]{64}$/.test(inputFingerprint)) throw new TypeError(`inputFingerprint must be 64-hex, got ${String(inputFingerprint).slice(0, 16)}…`);

  const now = createdAt ?? new Date().toISOString();

  const facts = [];

  // F1 — parent input（bound to the frozen input fingerprint）.
  facts.push(createInheritedFact({
    factId: "f1:parent-input",
    kind: "PARENT_SPEC",
    value: inputFingerprint,
    sourceAuthority: "autoLoopHarness",
    sourceIdentity: graphRunId,
    observedAt: now,
    freshnessPolicy: FRESHNESS_POLICIES.IMMUTABLE,
    invalidationConditions: [
      INVALIDATION_CONDITIONS.MANIFEST_DIGEST_MISMATCH,
      INVALIDATION_CONDITIONS.PARENT_GENERATION_SUPERSEDED,
    ],
    defaultDisposition: "REUSE",
  }));

  // F2 — decomposition revision（immutable per decomposition revision）.
  facts.push(createInheritedFact({
    factId: "f2:decomposition-ir",
    kind: "DECOMPOSITION_IR",
    value: irSha,
    reference: dagSha,
    sourceAuthority: "autoLoopHarness",
    sourceIdentity: graphRunId,
    observedAt: now,
    freshnessPolicy: FRESHNESS_POLICIES.IMMUTABLE,
    invalidationConditions: [INVALIDATION_CONDITIONS.MANIFEST_DIGEST_MISMATCH],
    defaultDisposition: "REUSE",
  }));

  // F3A — immutable artifact identity（per-child guard before reuse）.
  facts.push(createInheritedFact({
    factId: "f3a:repository-identity",
    kind: "REPOSITORY_IDENTITY",
    value: repositoryIdentity.expected_head,
    reference: repositoryIdentity.expected_tree,
    sourceAuthority: "gitObservation",
    sourceIdentity: graphRunId,
    observedAt: now,
    freshnessPolicy: FRESHNESS_POLICIES.RUN_SNAPSHOT,
    invalidationConditions: [
      INVALIDATION_CONDITIONS.HEAD_CHANGED,
      INVALIDATION_CONDITIONS.TREE_SHA_CHANGED,
      INVALIDATION_CONDITIONS.WORKTREE_IDENTITY_CHANGED,
    ],
    defaultDisposition: "REUSE",
  }));

  // F3B — external/ref metadata（run-level context; validated at run start /
  // resume only; never claimed fresh in child evidence）.
  facts.push(createInheritedFact({
    factId: "f3b:ref-metadata",
    kind: "REF_METADATA",
    value: {
      expected_ref: repositoryIdentity.expected_ref ?? null,
      origin_url: repositoryIdentity.origin_url ?? null,
      origin_master: repositoryIdentity.origin_master ?? null,
      expected_worktree_state: repositoryIdentity.expected_worktree_state ?? null,
    },
    sourceAuthority: "gitObservation",
    sourceIdentity: graphRunId,
    observedAt: now,
    freshnessPolicy: FRESHNESS_POLICIES.RUN_SNAPSHOT,
    invalidationConditions: [
      INVALIDATION_CONDITIONS.AUTHORITY_IDENTITY_CHANGED,
      INVALIDATION_CONDITIONS.WORKTREE_IDENTITY_CHANGED,
    ],
    defaultDisposition: "REUSE",
  }));

  // AUTHORITY_CONTRACT — parent scope + harness contract refs.
  facts.push(createInheritedFact({
    factId: "f4:authority-contract",
    kind: "AUTHORITY_CONTRACT",
    value: {
      authorityRefs: [...authorityRefs],
      contractRefs: [...contractRefs],
    },
    sourceAuthority: "parentCard",
    sourceIdentity: parentCardId,
    observedAt: now,
    freshnessPolicy: FRESHNESS_POLICIES.IMMUTABLE,
    invalidationConditions: [
      INVALIDATION_CONDITIONS.AUTHORITY_IDENTITY_CHANGED,
      INVALIDATION_CONDITIONS.PARENT_GENERATION_SUPERSEDED,
    ],
    defaultDisposition: "REUSE",
  }));

  // DEPENDENCY — IR dependency edges（structure-bound; unchanged ⇒ REUSE）.
  for (const pid of phaseIds) {
    facts.push(createInheritedFact({
      factId: `f5:dep:${pid}`,
      kind: "DEPENDENCY",
      value: pid,
      reference: null,
      sourceAuthority: "decompositionRevision",
      sourceIdentity: irSha,
      observedAt: now,
      freshnessPolicy: FRESHNESS_POLICIES.IMMUTABLE,
      invalidationConditions: [INVALIDATION_CONDITIONS.DEPENDENCY_IDENTITY_CHANGED],
      defaultDisposition: "REUSE",
    }));
  }

  // EVIDENCE_REF — prior evidence by identity（reference, never copy）.
  for (const ref of evidenceRefs) {
    facts.push(createInheritedFact({
      factId: `f6:evidence:${String(ref).slice(0, 16)}`,
      kind: "EVIDENCE_REF",
      value: ref,
      sourceAuthority: "harnessEvidence",
      sourceIdentity: graphRunId,
      observedAt: now,
      freshnessPolicy: FRESHNESS_POLICIES.IMMUTABLE,
      invalidationConditions: [
        INVALIDATION_CONDITIONS.EVIDENCE_MISSING_OR_CORRUPT,
        INVALIDATION_CONDITIONS.MANIFEST_DIGEST_MISMATCH,
      ],
      defaultDisposition: "REUSE",
    }));
  }

  // Parent-spec file digests — FILE_DIGEST freshness（relevant drift only;
  // irrelevant drift preserves every other fact）.
  for (const sd of specFileDigests || []) {
    if (!sd || typeof sd.path !== "string" || sd.path.length === 0) continue;
    facts.push(createInheritedFact({
      factId: `f1:spec-file:${sd.path}`,
      kind: "PARENT_SPEC",
      value: sd.sha256 ?? null,
      sourceAuthority: "gitObservation",
      sourceIdentity: graphRunId,
      observedAt: now,
      freshnessPolicy: FRESHNESS_POLICIES.FILE_DIGEST,
      invalidationConditions: [INVALIDATION_CONDITIONS.FILE_DIGEST_CHANGED],
      defaultDisposition: "REUSE",
      filePaths: [sd.path],
      contentHash: sd.sha256 ?? null,
    }));
  }

  const payload = {
    schema: DECOMPOSITION_INHERITANCE_SCHEMA,
    formatVersion: DECOMPOSITION_INHERITANCE_FORMAT_VERSION,
    parentCardId,
    parentGeneration: Number(parentGeneration) || 1,
    graphRunId,
    repositoryIdentity: {
      repository_root_identity: repositoryIdentity.repository_root_identity ?? null,
      worktree_identity: repositoryIdentity.worktree_identity ?? null,
      git_common_dir_identity: repositoryIdentity.git_common_dir_identity ?? null,
      expected_head: repositoryIdentity.expected_head,
      expected_tree: repositoryIdentity.expected_tree,
      expected_ref: repositoryIdentity.expected_ref ?? null,
      origin_url: repositoryIdentity.origin_url ?? null,
      origin_master: repositoryIdentity.origin_master ?? null,
      expected_worktree_state: repositoryIdentity.expected_worktree_state ?? null,
    },
    inputFingerprint,
    irSha,
    dagSha,
    authorityRefs: [...authorityRefs],
    contractRefs: [...contractRefs],
    dependencyRefs: [...dependencyRefs],
    evidenceRefs: [...evidenceRefs],
    facts,
    createdAt: now,
  };

  const manifestSha256 = computeManifestSha256(payload);
  const manifest = {
    ...payload,
    manifestIdentity: deriveManifestIdentity(manifestSha256),
    manifestSha256,
  };
  return { manifest, manifestSha256, manifestIdentity: manifest.manifestIdentity };
}

/**
 * Verify manifest integrity（digest + identity consistency）.
 * @returns {{ ok: true, manifestSha256: string } | { ok: false, code: string, reason: string }}
 */
export function verifyManifestIntegrity(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, code: INHERITANCE_HOLD.IDENTITY_DRIFT, reason: "manifest is not a non-null object" };
  }
  if (manifest.schema !== DECOMPOSITION_INHERITANCE_SCHEMA) {
    return { ok: false, code: INHERITANCE_HOLD.IDENTITY_DRIFT, reason: `schema mismatch: ${manifest.schema}` };
  }
  const recomputed = computeManifestSha256(manifest);
  if (recomputed !== manifest.manifestSha256) {
    return { ok: false, code: INHERITANCE_HOLD.IDENTITY_DRIFT, reason: "manifest sha256 does not match its content (tampered/corrupt)" };
  }
  const expectedIdentity = deriveManifestIdentity(recomputed);
  if (manifest.manifestIdentity !== expectedIdentity) {
    return { ok: false, code: INHERITANCE_HOLD.IDENTITY_DRIFT, reason: "manifestIdentity does not match manifestSha256" };
  }
  return { ok: true, manifestSha256: recomputed };
}

// ── Invalidation + disposition ───────────────────────────────────────────

/**
 * Per-fact invalidation decision. `live` carries the observable facts the
 * child must check before reuse:
 *   { head, treeSha, worktreeIdentity, generation, manifestIntegrity,
 *     relevantFileDigests: { path: sha256 }, runtimeGeneration }
 *
 * Deterministic: same（fact, live）⇒ same disposition.
 *
 * @returns {{ disposition: "REUSE"|"REVALIDATE"|"RECOMPUTE"|"HOLD", reason: string }}
 */
export function resolveFactDisposition({ fact, live = {} }) {
  if (!fact || !fact.factId) {
    return { disposition: "HOLD", reason: INHERITANCE_HOLD.FRESHNESS_UNPROVEN };
  }
  // A corrupt / tampered manifest can never justify REUSE.
  if (live.manifestIntegrity === false) {
    return { disposition: "HOLD", reason: INHERITANCE_HOLD.FRESHNESS_UNPROVEN };
  }
  const conds = Array.isArray(fact.invalidationConditions) ? fact.invalidationConditions : [];

  // Fail-closed HOLD conditions（cannot decide → HOLD）.
  if (conds.includes(INVALIDATION_CONDITIONS.PARENT_GENERATION_SUPERSEDED) && live.supersededGeneration) {
    return { disposition: "HOLD", reason: INHERITANCE_HOLD.IDENTITY_DRIFT };
  }
  if (conds.includes(INVALIDATION_CONDITIONS.EVIDENCE_MISSING_OR_CORRUPT) && live.evidenceMissing === true) {
    return { disposition: "HOLD", reason: INHERITANCE_HOLD.STALE_EVIDENCE_REUSED };
  }
  if (conds.includes(INVALIDATION_CONDITIONS.MANIFEST_DIGEST_MISMATCH) && live.manifestIntegrity === false) {
    return { disposition: "HOLD", reason: INHERITANCE_HOLD.FRESHNESS_UNPROVEN };
  }

  // F3A-family drift（head / tree / worktree identity changed）⇒ RECOMPUTE the
  // identity fact（frozen design R1-C: in-run HEAD change is forbidden for
  // phases ⇒ fail closed）.
  if (conds.includes(INVALIDATION_CONDITIONS.HEAD_CHANGED) && live.head && live.head !== (fact.value ?? null)) {
    return { disposition: live.allowRecompute === true ? "RECOMPUTE" : "HOLD", reason: INHERITANCE_HOLD.REPOSITORY_DRIFT };
  }
  if (conds.includes(INVALIDATION_CONDITIONS.TREE_SHA_CHANGED) && live.treeSha && live.treeSha !== (fact.reference ?? null)) {
    return { disposition: live.allowRecompute === true ? "RECOMPUTE" : "HOLD", reason: INHERITANCE_HOLD.REPOSITORY_DRIFT };
  }
  if (conds.includes(INVALIDATION_CONDITIONS.WORKTREE_IDENTITY_CHANGED) && live.worktreeIdentityChanged === true) {
    return { disposition: live.allowRecompute === true ? "RECOMPUTE" : "HOLD", reason: INHERITANCE_HOLD.REPOSITORY_DRIFT };
  }

  // FILE_DIGEST freshness（relevant drift only; irrelevant drift preserves）.
  const filePaths = Array.isArray(fact.filePaths) ? fact.filePaths : [];
  const boundPaths = filePaths.filter((p) => live.relevantFileDigests && p in live.relevantFileDigests);
  if (fact.freshnessPolicy === FRESHNESS_POLICIES.FILE_DIGEST) {
    // No digest observed for this child ⇒ freshness unproven ⇒ bounded
    // revalidate（never silent REUSE）.
    if (boundPaths.length === 0) {
      return { disposition: "REVALIDATE", reason: "file_digest_unobserved_this_child" };
    }
    const changed = boundPaths.filter((p) => live.relevantFileDigests[p] !== fact.contentHash);
    if (changed.length > 0) {
      return { disposition: "REVALIDATE", reason: `file_digest_changed:${changed.join(",")}` };
    }
    return { disposition: "REUSE", reason: "file_digest_unchanged" };
  }

  // TIME_SENSITIVE ⇒ bounded revalidate（never silent REUSE）.
  if (fact.freshnessPolicy === FRESHNESS_POLICIES.TIME_SENSITIVE) {
    return { disposition: "REVALIDATE", reason: "time_sensitive_fact" };
  }

  // RUN_SNAPSHOT with no drift signal ⇒ REUSE（the per-child guard is the
  // revalidation obligation; it already passed before this decision）.
  if (fact.freshnessPolicy === FRESHNESS_POLICIES.IMMUTABLE || fact.freshnessPolicy === FRESHNESS_POLICIES.RUN_SNAPSHOT) {
    return { disposition: "REUSE", reason: "identity_unchanged" };
  }

  // CHILD_LOCAL ⇒ never inherited.
  if (fact.freshnessPolicy === FRESHNESS_POLICIES.CHILD_LOCAL) {
    return { disposition: "RECOMPUTE", reason: "child_local_fact" };
  }

  return { disposition: fact.defaultDisposition ?? "REVALIDATE", reason: "default_disposition" };
}

/**
 * Evaluate invalidation conditions for a manifest against the live run
 * snapshot（per-fact granularity — irrelevant drift preserves reusable facts）.
 * @param {object} opts
 * @param {object} opts.manifest
 * @param {object} opts.live — { head, treeSha, worktreeIdentity, generation,
 *   manifestIntegrity, relevantFileDigests, evidencePresent }
 * @returns {Array<{ factId: string, kind: string, disposition: string, reason: string }>}
 */
export function evaluateInvalidations({ manifest, live = {} }) {
  if (!manifest || !Array.isArray(manifest.facts)) return [];
  const integrity = verifyManifestIntegrity(manifest);
  const liveFull = {
    ...live,
    manifestIntegrity: live.manifestIntegrity ?? integrity.ok,
  };
  return manifest.facts.map((fact) => {
    const d = resolveFactDisposition({ fact, live: liveFull });
    return {
      factId: fact.factId,
      kind: fact.kind,
      disposition: d.disposition,
      reason: d.reason,
    };
  });
}

// ── Child Execution Packet ───────────────────────────────────────────────

/**
 * Build the deterministic Child Execution Packet（G）. The packet NEVER
 * widens scope: authorized/unauthorized scope and mutation authority are
 * derived from the IR phase + parent scope exactly as the phase-task-card
 * hard gates derive them（containment re-checks stay per child）.
 *
 * @param {object} opts
 * @param {string} opts.childCardId — phase id
 * @param {object} opts.manifest — verified inheritance manifest
 * @param {object} opts.phase — IR phase（depends_on / effects / covers）
 * @param {Array<{factId, disposition, reason}>} opts.dispositions — per-fact
 * @param {string[]} [opts.inheritedEvidenceRefs] — evidence refs by identity
 * @param {string[]} [opts.childLocalEvidenceRequirements] — fresh obligations
 * @param {string[]} opts.authorizedScope — allowed paths（child-local derivation）
 * @param {string[]} opts.unauthorizedScope — forbidden paths
 * @param {string} opts.mutationAuthority — "none" | "writer-lease"
 * @param {string[]} opts.dependencyBoundary — dependency phase ids
 * @returns {{ packet: object, packetSha256: string }}
 */
export function buildChildExecutionPacket({
  childCardId,
  manifest,
  phase,
  dispositions = [],
  inheritedEvidenceRefs = [],
  childLocalEvidenceRequirements = [],
  authorizedScope = [],
  unauthorizedScope = [],
  mutationAuthority = "none",
  dependencyBoundary = [],
  explicitInvalidationConditions = [],
}) {
  if (!childCardId || !manifest || !phase) throw new TypeError("childCardId / manifest / phase required");
  if (mutationAuthority !== "none" && mutationAuthority !== "writer-lease") {
    throw new TypeError(`mutationAuthority must be "none" | "writer-lease", got ${mutationAuthority}`);
  }
  const integrity = verifyManifestIntegrity(manifest);
  if (!integrity.ok) {
    throw new Error(`${INHERITANCE_HOLD.IDENTITY_DRIFT}: packet cannot be built from a corrupt manifest`);
  }

  const reused = (dispositions || []).filter((d) => d.disposition === "REUSE").map((d) => d.factId);
  const revalidations = (dispositions || []).filter((d) => d.disposition === "REVALIDATE").map((d) => d.factId);
  const recomputes = (dispositions || []).filter((d) => d.disposition === "RECOMPUTE").map((d) => d.factId);

  const packet = {
    schema: CHILD_EXECUTION_PACKET_SCHEMA,
    formatVersion: CHILD_EXECUTION_PACKET_FORMAT_VERSION,
    childCardId,
    parentCardId: manifest.parentCardId,
    graphRunId: manifest.graphRunId,
    inheritanceManifestIdentity: manifest.manifestIdentity,
    inheritanceManifestSha256: manifest.manifestSha256,
    reusedFacts: reused,
    revalidationObligations: revalidations,
    recomputeObligations: recomputes,
    inheritedEvidenceRefs: [...inheritedEvidenceRefs],
    childLocalEvidenceRequirements: [...childLocalEvidenceRequirements],
    authorizedScope: [...authorizedScope],
    unauthorizedScope: [...unauthorizedScope],
    mutationAuthority,
    dependencyBoundary: [...dependencyBoundary],
    explicitInvalidationConditions: [...explicitInvalidationConditions],
    // Child-local containment proof（never inherited）: the phase's artifact
    // boundaries re-derived from the IR（same source the task-card gates use）.
    containment: {
      artifactBoundaries: Array.isArray(phase?.effects?.boundaries?.artifact)
        ? phase.effects.boundaries.artifact.map((p) => String(p))
        : [],
      covers: Array.isArray(phase?.covers) ? phase.covers.map((c) => ({ ...c })) : [],
    },
  };
  const packetSha256 = sha256Text(canonicalJson(packet));
  return { packet, packetSha256 };
}

// ── F3A baseline projection（evidence repository_baseline）────────────────

/**
 * Project the frozen F3A/F3B repository baseline for child evidence.
 * F3B values are the RUN-LEVEL SNAPSHOT（validated at run start / resume
 * only）— never claimed fresh per child（R1-C）. The marker block makes the
 * freshness claim explicit and machine-checkable.
 */
export function deriveF3ABaseline(manifest) {
  const integrity = verifyManifestIntegrity(manifest);
  if (!integrity.ok) return null;
  const ri = manifest.repositoryIdentity ?? {};
  const baseline = {
    repository: typeof ri.repository_root_identity === "string" && ri.repository_root_identity.length > 0
      ? ri.repository_root_identity.split("/").pop() ?? "repository"
      : "repository",
    branch: ri.expected_ref ?? "HEAD",
    head: ri.expected_head,
    origin_ref: "",
    origin_head: "0000000000000000000000000000000000000000",
    ahead: 0,
    behind: 0,
    expected_worktree_state: ri.expected_worktree_state ?? "clean",
    permitted_dirty_paths: [],
    captured_at: manifest.createdAt ?? null,
    __inheritance: {
      manifest_identity: manifest.manifestIdentity,
      manifest_sha256: manifest.manifestSha256,
      fact_id: "f3a:repository-identity",
      freshness: "run-level-snapshot",
      no_per_child_freshness_claim: true,
      guard_command: "git rev-parse HEAD",
      observed_via: "parent-run-frozen-observation",
    },
  };
  return baseline;
}

// ── Per-child guard（the ONLY per-child identity git spawn）───────────────

/**
 * F3A per-child guard（R1-C）: ONE `git rev-parse HEAD` compared against the
 * frozen expected head. Tree is implied by commit identity — no second spawn.
 * Any failure（not a git repo / mismatch / git error）fails closed.
 *
 * @returns {{ ok: true, head: string, tree_implied: string } | { ok: false, code: string, reason: string }}
 */
export function guardRepositoryIdentity({ cwd, expectedHead }) {
  if (typeof cwd !== "string" || cwd.length === 0) {
    return { ok: false, code: INHERITANCE_HOLD.REPOSITORY_DRIFT, reason: "cwd required" };
  }
  let head;
  try {
    head = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024,
    }).trim();
  } catch (e) {
    return { ok: false, code: INHERITANCE_HOLD.REPOSITORY_DRIFT, reason: `git rev-parse HEAD failed: ${e?.code ?? e?.name ?? "error"}` };
  }
  if (!/^[0-9a-f]{40}$/.test(head)) {
    return { ok: false, code: INHERITANCE_HOLD.REPOSITORY_DRIFT, reason: "git rev-parse HEAD returned a malformed object id" };
  }
  if (expectedHead && head !== expectedHead) {
    return { ok: false, code: INHERITANCE_HOLD.REPOSITORY_DRIFT, reason: `HEAD drifted from the frozen inheritance identity (expected ${expectedHead.slice(0, 12)}…, got ${head.slice(0, 12)}…)` };
  }
  return { ok: true, head, tree_implied: head };
}

/**
 * Probe the run-level F3A identity（once per run, NOT per child）: head + tree
 * + root. Used by the orchestrator when the caller did not supply a frozen
 * repository identity（durable layers pass their own fingerprint）.
 */
export function probeRepositoryIdentity(cwd) {
  const git = (args) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 }).trim();
    } catch (e) {
      return null;
    }
  };
  const head = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const root = git(["rev-parse", "--show-toplevel"]);
  if (!head || !tree || !root) {
    return { ok: false, code: INHERITANCE_HOLD.REPOSITORY_DRIFT, reason: "cwd is not a resolvable git worktree (F3A probe failed)" };
  }
  return {
    ok: true,
    identity: {
      repository_root_identity: root,
      worktree_identity: root,
      git_common_dir_identity: null,
      expected_head: head,
      expected_tree: tree,
      expected_ref: null,
      origin_url: null,
      origin_master: null,
      expected_worktree_state: "clean",
    },
  };
}

/**
 * Merge a durable-layer fingerprint（collectFingerprint shape）with the F3A
 * probe（which supplies the tree the fingerprint lacks）. Deterministic merge.
 */
export function mergeFingerprintIntoRepositoryIdentity(fingerprint, probeIdentity) {
  const base = probeIdentity ?? {};
  return {
    repository_root_identity: fingerprint?.repository_root_identity ?? base.repository_root_identity ?? null,
    worktree_identity: fingerprint?.worktree_identity ?? base.worktree_identity ?? null,
    git_common_dir_identity: fingerprint?.git_common_dir_identity ?? base.git_common_dir_identity ?? null,
    expected_head: fingerprint?.expected_head ?? base.expected_head ?? null,
    expected_tree: base.expected_tree ?? null,
    expected_ref: fingerprint?.expected_ref ?? base.expected_ref ?? null,
    origin_url: fingerprint?.origin_url ?? base.origin_url ?? null,
    origin_master: fingerprint?.origin_master ?? base.origin_master ?? null,
    expected_worktree_state: fingerprint?.expected_worktree_state ?? base.expected_worktree_state ?? null,
  };
}

// ── Telemetry shapes（O / N）──────────────────────────────────────────────

export function emptyInheritanceTelemetry() {
  return {
    parentFactsObservedOnce: 0,
    inheritedFactCount: 0,
    reuseCount: 0,
    revalidateCount: 0,
    recomputeCount: 0,
    duplicateContextReconstructionAvoided: 0,
    duplicateEvidenceGenerationAvoided: 0,
    duplicateVerificationAvoided: 0,
    identityObservationsPerChild: { frozen: 0, guard: 0 },
    invalidationTriggerCount: 0,
    inheritanceHoldCount: 0,
    childPacketCount: 0,
    cbm: emptyCbmMetrics(),
  };
}

export function emptyCbmMetrics() {
  return {
    queryCount: 0,
    hitCount: 0,
    missCount: 0,
    staleCount: 0,
    conflictCount: 0,
    factsReused: 0,
    staleFacts: 0,
    boundedFallbackCount: 0,
    writebackGap: false,
    writebackGapReason: null,
  };
}
