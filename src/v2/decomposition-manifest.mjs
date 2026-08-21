// src/v2/decomposition-manifest.mjs
//
// I1 (AUTOLOOP-DECOMP-OPT1-IMPL1) — Decomposition Manifest.
//
// Frozen design authority: Issue #6 `autoloop-decomp-opt1-design-inventory.md`
// Section 8/8b/8c (PASS / AUTOLOOP_DECOMP_OPT1_DESIGN_SPEC_REVIEWED_AND_IMPLEMENTATION_READY).
//
// `autoloop.decomposition-manifest/v1` turns the parent/decomposition
// invariants that every child would otherwise re-derive into ONE
// content-addressed, deterministic, durable authoritative artifact:
//   - produced exactly once per decomposition revision (caller: durable layer,
//     after DAG_ACCEPTED),
//   - payload fully deterministic (canonical JSON, IR declaration order),
//   - manifest_id = sha256(canonical payload) — identical bound inputs
//     produce identical payloads and identical digests,
//   - written through the existing evidence path (secret-scan + size bound +
//     journal + checkpoint) by the caller,
//   - resume re-derives the payload from frozen durable artifacts and
//     verifies the digest three ways (recomputed == artifact == checkpoint).
//
// This module is pure/CPU-only: no model calls, no git reads, no mutation.
// Repository identity (F3A) is provided by the caller from the run-level
// fingerprint observation plus one tree read; nothing is re-discovered here.
//
// Explicitly NOT implemented here (frozen non-goals for I1): child execution
// packet (I2), evidence repo-identity dedup (I3), verification layering (I4),
// durable CAS serialization (I5), recursive decomposition (I6), CBM.

import { canonicalJson, sha256Text } from "../evidence/run-evidence-store.mjs";

export const DECOMPOSITION_MANIFEST_FORMAT = "autoloop.decomposition-manifest/v1";
/** Serialized-size bound (fail-closed; same class as the evidence free-text budget). */
export const DECOMPOSITION_MANIFEST_MAX_BYTES = 64 * 1024;

export const DECOMPOSITION_MANIFEST_ERRORS = Object.freeze({
  MISSING_PARENT_IDENTITY: "DECOMPOSITION_MANIFEST_MISSING_PARENT_IDENTITY",
  MISSING_PARENT_REVISION: "DECOMPOSITION_MANIFEST_MISSING_PARENT_REVISION",
  MISSING_FINGERPRINTS: "DECOMPOSITION_MANIFEST_MISSING_FINGERPRINTS",
  MISSING_IR: "DECOMPOSITION_MANIFEST_MISSING_IR",
  MISSING_IR_HASHES: "DECOMPOSITION_MANIFEST_MISSING_IR_HASHES",
  MISSING_REPOSITORY_IDENTITY: "DECOMPOSITION_MANIFEST_MISSING_REPOSITORY_IDENTITY",
  MISSING_SOURCE_HASHES: "DECOMPOSITION_MANIFEST_MISSING_SOURCE_HASHES",
  MISSING_PROMPT_VERSION: "DECOMPOSITION_MANIFEST_MISSING_PROMPT_VERSION",
  OVERSIZE: "DECOMPOSITION_MANIFEST_OVERSIZE",
  BUILD_FAILED: "DECOMPOSITION_MANIFEST_BUILD_FAILED",
});

/**
 * Deterministic per-phase digest table (IR declaration order preserved).
 * Each digest binds the phase's full canonical payload (purpose/effects/
 * boundaries/covers/depends_on/verification_plan), so any phase-level change
 * invalidates exactly that phase's digest and its manifest revision.
 */
export function buildPhaseTableDigests(ir) {
  const phases = Array.isArray(ir?.phases) ? ir.phases : [];
  return phases.map((p) => ({
    phase_id: typeof p?.phase_id === "string" ? p.phase_id : "unknown",
    digest: sha256Text(canonicalJson(p)),
  }));
}

/**
 * Build the decomposition manifest.
 *
 * @param {object} opts
 * @param {string} opts.parentExecutionId — run execution id
 * @param {string} opts.chainId — run chain id
 * @param {string} opts.parentRevision — parent task content revision (the
 *   revision of the parent task the decomposition answers; distinct from the
 *   input fingerprint, which binds the full frozen execution input). For the
 *   STACK_A path: sha256(canonicalJson(source)) — the parent task definition
 *   (goal/requirements/authority). For the production graph path (caller-
 *   provided IR): sha256(canonicalJson(parent)).
 * @param {string} opts.inputFingerprint — frozen input fingerprint (source/parent/manifest)
 * @param {string} opts.configurationFingerprint — frozen configuration fingerprint
 * @param {object} opts.ir — validated decomposition IR (DECOMPOSED)
 * @param {string} opts.irSha — buildIrSha256(ir)
 * @param {string} opts.dagSha — buildDagFingerprint(ir)
 * @param {object} opts.repositoryIdentity — F3A snapshot:
 *   { repository_root_identity, expected_head, tree } (run-level observation;
 *   never re-discovered here)
 * @param {object} opts.sourceHashes — computeSourceHashes() map (relpath -> sha256)
 * @param {string} opts.promptBuilderVersion — PROMPT_BUILDER_VERSION used for this
 *   decomposition
 * @returns {{ok:true, manifest:object, payload:object, manifest_id:string, serialized:string, bytes:number}}
 *   | {ok:false, code:string, reason:string}
 */
export function buildDecompositionManifest({
  parentExecutionId,
  chainId,
  parentRevision,
  inputFingerprint,
  configurationFingerprint,
  ir,
  irSha,
  dagSha,
  repositoryIdentity,
  sourceHashes,
  promptBuilderVersion,
} = {}) {
  // ── Fail-closed presence gates (deterministic; no silent defaults) ──
  if (typeof parentExecutionId !== "string" || parentExecutionId.length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_PARENT_IDENTITY, reason: "parentExecutionId required" };
  }
  if (typeof parentRevision !== "string" || parentRevision.length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_PARENT_REVISION, reason: "parentRevision required (distinct from input fingerprint)" };
  }
  if (typeof inputFingerprint !== "string" || inputFingerprint.length === 0 ||
      typeof configurationFingerprint !== "string" || configurationFingerprint.length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_FINGERPRINTS, reason: "input/configuration fingerprint required" };
  }
  if (!ir || typeof ir !== "object" || Array.isArray(ir)) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_IR, reason: "ir required" };
  }
  if (typeof irSha !== "string" || irSha.length === 0 || typeof dagSha !== "string" || dagSha.length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_IR_HASHES, reason: "irSha and dagSha required" };
  }
  if (!repositoryIdentity || typeof repositoryIdentity !== "object" || Array.isArray(repositoryIdentity) ||
      typeof repositoryIdentity.repository_root_identity !== "string" ||
      typeof repositoryIdentity.expected_head !== "string" ||
      typeof repositoryIdentity.tree !== "string") {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_REPOSITORY_IDENTITY,
      reason: "repositoryIdentity (F3A: repository_root_identity/expected_head/tree) required" };
  }
  if (!sourceHashes || typeof sourceHashes !== "object" || Array.isArray(sourceHashes) ||
      Object.keys(sourceHashes).length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_SOURCE_HASHES, reason: "sourceHashes required" };
  }
  if (typeof promptBuilderVersion !== "string" || promptBuilderVersion.length === 0) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.MISSING_PROMPT_VERSION, reason: "promptBuilderVersion required" };
  }

  const phaseTable = buildPhaseTableDigests(ir);
  const phaseCount = phaseTable.length;

  const payload = {
    format_version: DECOMPOSITION_MANIFEST_FORMAT,
    parent: {
      execution_id: parentExecutionId,
      chain_id: typeof chainId === "string" ? chainId : null,
      revision: parentRevision,
    },
    input_fingerprint: inputFingerprint,
    configuration_fingerprint: configurationFingerprint,
    decomposition: {
      ir_sha256: irSha,
      dag_sha256: dagSha,
      prompt_builder_version: promptBuilderVersion,
      phase_count: phaseCount,
    },
    repository_identity: {
      repository_root_identity: repositoryIdentity.repository_root_identity,
      expected_head: repositoryIdentity.expected_head,
      tree: repositoryIdentity.tree,
    },
    source_hashes: { ...sourceHashes },
    phase_table: phaseTable,
  };

  // ── Content addressing ─────────────────────────────────────────────
  let serialized;
  try {
    serialized = canonicalJson(payload);
  } catch (e) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.BUILD_FAILED, reason: `canonical serialization failed: ${e?.message || e}` };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > DECOMPOSITION_MANIFEST_MAX_BYTES) {
    return { ok: false, code: DECOMPOSITION_MANIFEST_ERRORS.OVERSIZE,
      reason: `manifest exceeds size bound (${bytes} > ${DECOMPOSITION_MANIFEST_MAX_BYTES})` };
  }
  const manifest_id = sha256Text(serialized);
  const manifest = { ...payload, manifest_id, content_sha256: manifest_id };
  return { ok: true, manifest, payload, manifest_id, serialized, bytes };
}
