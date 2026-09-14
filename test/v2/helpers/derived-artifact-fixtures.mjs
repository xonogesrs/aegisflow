// test/v2/helpers/derived-artifact-fixtures.mjs
//
// AUTOLOOP-V1-STAGE-F-P5-SOAK-E1-DERIVED-ARTIFACT-FIXTURE-REIMPLEMENTATION-2
// Bounded re-implementation of the missing fixture helper for the C3
// post-finalization derived-artifact owner suite.
//
// Consumers:
//   - test/v2/test-post-finalization-derived-artifact.mjs   (C3 owner suite)
//   - test/learning/test-pattern-candidate-projection-1.mjs (projection suite)
//
// Authority boundaries:
//   * The frozen 12-step publication protocol, the six-state machine, the
//     closed-field §R1 link schema, and the walk discipline live in
//     src/v2/checkpoint-bridge.mjs. This helper NEVER re-implements them —
//     it re-exports the sealed primitives verbatim.
//   * The checkpoint snapshot / anchor block / manifest machinery lives in
//     src/c2d/checkpoint-store.mjs and src/evidence/run-manifest.mjs and is
//     consumed, not copied.
//   * The learning identity/writer fixtures are reused from
//     src/learning/transfer-metrics/fixtures.mjs so the writer identities
//     match the rest of the learning suite.
//   * This module only BUILDS fixtures: temp evidence roots, a finalized
//     base manifest, a durable authority fold root, generation-1
//     publications, and §R1 link documents for hand-constructed states.
//   * No success result, error code, or state transition is hard-coded here;
//     every assertion oracle is the sealed production code itself.
//
// Exports (contract extracted from both consumers):
//   makeWorld, publishGen1, publishDerivedArtifact, buildDerivedLink,
//   derivedGenerationPath, derivedReadState, derivedWalkChain, DERIVED_CODES,
//   HOLD, sha256, mkLink, BODY_A, BODY_B, mintExecutionId, makeIdentities,
//   createTestWriter, createTestRoot, ensureSeam, resolveExecDir

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Sealed production primitives (re-exported verbatim; never re-implemented)
import {
  publishDerivedArtifact,
  buildDerivedLink,
  derivedGenerationPath,
  derivedReadState,
  derivedWalkChain,
  DERIVED_CODES,
  DERIVED_ARTIFACT_FORMAT_VERSION,
  collectRepositoryFingerprint,
  bindDerivedAuthoritySeam,
} from "../../../src/v2/checkpoint-bridge.mjs";
import {
  resolveExecDir,
  initExecutionDir,
  createInitialSnapshot,
  publishCurrent,
} from "../../../src/c2d/checkpoint-store.mjs";
import { HOLD } from "../../../src/c2d/fs-atomic.mjs";
import {
  mintExecutionId as mintExecutionIdSealed,
  mintChainId,
  mintCheckpointId,
} from "../../../src/c2d/execution-id.mjs";
import { deriveChainId, deriveCheckpointId } from "../../../src/v2/checkpoint-bridge.mjs";
import { acquireLease, releaseLease } from "../../../src/c2d/lease.mjs";
import { permitFromLease } from "../../../src/c2d/permit.mjs";
import { buildRunManifest, finalizeRunManifest } from "../../../src/evidence/run-manifest.mjs";
import { withTransferMetricsReadLock } from "../../../src/learning/transfer-metrics/writer.mjs";
import { replayAuthorityReadiness } from "../../../src/learning/transfer-metrics/authority-state.mjs";
// Learning-suite fixture reuse (same identity shapes as the writer tests).
import {
  makeIdentities as makeLearningIdentities,
  makeBinder as makeLearningBinder,
  createTestWriter as createLearningTestWriter,
  createTestRoot as createLearningTestRoot,
  makeEvent as makeLearningEvent,
  writeRawLog as writeLearningRawLog,
} from "../../../src/learning/transfer-metrics/fixtures.mjs";

// ═══════════════════════════════ Constants ═══════════════════════════════

/**
 * Repo-external scratch parent for the world evidence root. It lives on the
 * SAME volume as os.tmpdir() because the C3 consumer hard-links generation
 * files against tmpdir()-based twins (B3) — cross-device link would fail
 * EXDEV before the PATH_UNSAFE oracle is even reached. The evidence root is
 * still outside the repository worktree (assertValidEvidenceRoot).
 */
export const TMP_PARENT = join(tmpdir(), "derived-artifact-fixtures-1");

/** Deterministic generation fixture artifact bytes (never a result authority). */
export const BODY_A = Buffer.from(
  "post-finalization derived artifact fixture body A — AUTOLOOP C3 owner suite\n",
  "utf8",
);
export const BODY_B = Buffer.from(
  "post-finalization derived artifact fixture body B — AUTOLOOP C3 owner suite\n",
  "utf8",
);

/** §R1 genesis predecessor digest (canonical all-zero hex64). */
const DERIVED_GENESIS = "0".repeat(64);

// ═══════════════════════════ Digest / id helpers ══════════════════════════

/** sha256 hex over Buffer|string (consumer shorthand). */
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Deterministic sha256-hex seed helper (same shape as learning fixtures.hex). */
export function hex(seed) {
  return createHash("sha256").update(String(seed), "utf8").digest("hex");
}

/** Fresh exec_<32hex> execution id — the SEALED minter (validated everywhere). */
export function mintExecutionId() {
  return mintExecutionIdSealed();
}

// ═══════════════════════ Identity / writer / root fixtures ════════════════

export function makeIdentities(label = "t") {
  return makeLearningIdentities(label);
}

export function makeBinder(ids, extra = {}) {
  return makeLearningBinder(ids, extra);
}

export function createTestWriter(ids, extra = {}) {
  return createLearningTestWriter(ids, extra);
}

export function createTestRoot(label = "run") {
  return createLearningTestRoot(label);
}

// A2-ORACLE-REPAIR-1: the fixture-local C2dHoldError sentinel
// (globalThis.C2dHoldError = FixtureC2dHoldErrorSentinel) is REMOVED by this
// repair. It existed only to keep the C3 consumer's bare `C2dHoldError`
// identifier resolvable while guaranteeing `verified instanceof C2dHoldError`
// was false — which silently skipped C5's A2a fail-closed assertion (the
// sealed readCurrent error never matched the old message-based assertion).
// The consumer now asserts against the SEALED class via its own import
// (AtomicC2dHoldError) and the sealed observable (taxonomy in .code), so no
// global binding is needed and none may shadow the real class.

// ═══════════════════════ Authority seam (R7X contract) ════════════════════
// The §R7 revocation gate is UNCONDITIONAL: every publication consults the
// durable authority fold through the sealed seam. Omitted transferMetricsRoot
// is NOT an elision — the seam's withReadLock fails closed with
// TRANSFER_PATH_UNSAFE, and a corrupt durable fold fails closed as CORRUPT.
// Binding is idempotent and module-load safe.

let __seamBound = false;

export function ensureSeam() {
  if (__seamBound) return;
  bindDerivedAuthoritySeam({
    withReadLock: (root, fn) => withTransferMetricsReadLock(root, fn),
    replayReadiness: (root) => replayAuthorityReadiness({ transferMetricsRoot: root }),
  });
  __seamBound = true;
}

// Bind at import: consumers import publishDerivedArtifact from HERE and call
// it without touching ensureSeam (the export is a completeness surface).
ensureSeam();

// ═══════════════════════ §R1 link construction ════════════════════════════

/**
 * §R1 canonical link bytes: sorted keys, 2-space indent, trailing newline
 * (the sealed canonical-opening byte form). `excludeDigest` removes the
 * link_digest field — the self-exclusion is exact (mirrors the bridge's
 * private canonicalization; byte-compatible by construction).
 */
function canonicalLinkBytes(link, { excludeDigest = false } = {}) {
  const source = excludeDigest
    ? Object.fromEntries(Object.entries(link).filter(([k]) => k !== "link_digest"))
    : link;
  const sorted = Object.keys(source).sort().map((k) => [k, source[k]]);
  return Buffer.from(`${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`, "utf8");
}

function linkSelfDigest(link) {
  return sha256(canonicalLinkBytes(link, { excludeDigest: true }));
}

/**
 * Fixture link factory: a COMPLETE durable link document (link_digest set to
 * the exact §R1 self digest; committed_at stays null — commit time lives in
 * the anchor, never the link body). Identity is (logical_name, generation)
 * ONLY — never digest-derived (§R8 circularity fence).
 *
 * @param {string} executionId
 * @param {{gen: number, mut: string, prev: string,
 *          art: Buffer|string, phaseId?: string,
 *          issuerIdentity?: string, revocationGeneration?: number,
 *          createdAt?: string}} opts
 * @returns {object} the closed-field link document
 */
export function mkLink(executionId, { gen, mut, prev, art, phaseId = "p1", issuerIdentity, revocationGeneration = 0, createdAt } = {}) {
  const bytes = Buffer.isBuffer(art) ? art : Buffer.from(String(art ?? ""), "utf8");
  const link = buildDerivedLink({
    executionId,
    phaseId,
    generation: gen,
    previousLinkDigest: prev,
    artifactDigest: sha256(bytes),
    artifactSize: bytes.length,
    mutationId: mut,
    issuerIdentity: issuerIdentity ?? sha256(`issuer:${executionId}`),
    revocationGeneration,
    createdAt: createdAt ?? new Date().toISOString(),
  });
  // Seal the self digest EXACTLY as the owner's Phase-2 would: the link the
  // walk later verifies must satisfy parsed.link_digest === selfDigest.
  link.link_digest = linkSelfDigest(link);
  return link;
}

// ═══════════════════════════ The world fixture ════════════════════════════

let __worldSeq = 0;

/**
 * Build a repo-external evidence world whose execDir satisfies the owner's
 * STEP-1 gate (finalized base manifest) and whose foldRoot satisfies the
 * §R7 zero-write revocation gate (durable GEN-2 authority fold, READY,
 * subject w1 live at generation 0).
 *
 * world = { label, root, execDir, executionId, phaseId, fingerprint,
 *           foldRoot, chainId, checkpointId, cleanup }
 *
 * cleanup removes ONLY the directories this world created (root + foldRoot).
 */
export function makeWorld(label = "world") {
  __worldSeq += 1;
  mkdirSync(TMP_PARENT, { recursive: true, mode: 0o700 });

  const executionId = mintExecutionId();
  // The owner's Phase-1/Phase-3 CAS derives chain/checkpoint ids from the
  // execution id; the seeded CURRENT must carry the SAME identity or the
  // anchor publish would see a snapshot/permit identity mismatch.
  const chainId = deriveChainId(executionId);
  const checkpointId = deriveCheckpointId(executionId);
  const phaseId = "p1";

  // Evidence root: outside the repo, 0700, no symlink (assertValidEvidenceRoot
  // enforces; initExecutionDir is the sealed initializer).
  const root = join(TMP_PARENT, `${label}-${process.pid}-${Date.now()}-${__worldSeq}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });

  // Fixture repository fingerprint (lease/permit identity): the canonical
  // FIELD SHAPE of collectFingerprint with deterministic fixture values. The
  // worktree identity points at the fixture root itself — a lease/permit
  // namespace, not a claim about the real repository.
  const fingerprint = {
    repository_root_identity: root,
    git_common_dir_identity: join(root, ".git"),
    worktree_identity: root,
    expected_head: "f".repeat(40),
    expected_ref: "refs/heads/fixture",
    origin_url: "",
    origin_master: "",
    expected_worktree_state: "clean",
    dirty: false,
    dirty_digest_is_content_affinity: false,
  };

  // Sealed store initializer: journal/, prior/ (0700) per checkpoint-store.
  initExecutionDir(root, executionId);
  const execDir = resolveExecDir(root, executionId);

  // FINALIZED BASE MANIFEST (owner STEP-1 gate): R12X proves publication
  // without it fails closed — every world carries a finalized manifest.
  finalizeRunManifest(execDir, buildRunManifest({
    executionId,
    chainId,
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    final_verdict: "PASS",
    final_reason: "fixture",
    phase_results: [],
    artifact_inventory: [],
    secret_scan_result: { scanned: true, matches: [] },
    format_versions: {},
  }));

  // Initial CURRENT snapshot (revision 1) WITHOUT an anchor block: the
  // owner's Phase-1 CAS rides the anchor on later revisions (publishAnchor
  // uses publishCurrent with the sealed revision discipline). This gives J1
  // its "legacy run — no anchor ⇒ ABSENT" observable.
  const snapshot = {
    ...createInitialSnapshot({
      checkpoint_id: checkpointId,
      execution_id: executionId,
      chain_id: chainId,
      repository_fingerprint: fingerprint,
      repository_root_identity: fingerprint.repository_root_identity,
      git_common_dir_identity: fingerprint.git_common_dir_identity,
      expected_head: fingerprint.expected_head,
      expected_ref: fingerprint.expected_ref,
      expected_worktree_state: fingerprint.expected_worktree_state,
      origin_url: fingerprint.origin_url,
      origin_master: fingerprint.origin_master,
    }),
    revision: 1,
  };
  const acquired = acquireLease(execDir, {
    execution_id: executionId,
    chain_id: chainId,
    checkpoint_id: checkpointId,
    repository_identity: fingerprint.repository_root_identity,
    worktree_identity: fingerprint.worktree_identity,
    actor_id: "autoloop-derived-fixture",
    expected_head: fingerprint.expected_head,
    mutation_capability: false,
    role: "autoloop-derived-fixture",
  });
  const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false);
  publishCurrent(execDir, snapshot, { expectedRevision: 0, permit });
  releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);

  // Durable authority fold root: a GEN-2 raw log with one fixture event →
  // replayAuthorityReadiness reports READY (fold present), subject w1 is NOT
  // revoked and defaults to generation 0. R7X Proof 2 corrupts these bytes
  // and the gate must fail closed.
  const foldRoot = createLearningTestRoot(`${label}-fold`);
  writeLearningRawLog(foldRoot, {
    generation: 2,
    events: [makeLearningEvent("INCIDENT_OBSERVED", makeLearningIdentities(`${label}-fold`))],
  });

  const cleanup = () => {
    for (const dir of [root, foldRoot]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* owned dirs only */ }
    }
  };

  return {
    label,
    root,
    execDir,
    executionId,
    phaseId,
    fingerprint,
    foldRoot,
    chainId,
    checkpointId,
    cleanup,
  };
}

// ═══════════════════════ Generation-1 publication ═════════════════════════

/**
 * Publish generation 1 through the REAL frozen 12-step owner.
 *
 * @param {object} world — makeWorld output
 * @param {{mutationId?: string, body?: Buffer|string,
 *          createdAt?: string, issuerIdentity?: string,
 *          revocationGeneration?: number, phaseId?: string,
 *          actorId?: string}} [opts]
 * @returns {Promise<{status, generation, committed_link_digest, committed_at,
 *                    artifact_digest}>} — the owner's OPAQUE result
 */
export async function publishGen1(world, opts = {}) {
  const body = opts.body ?? BODY_A;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
  const link = mkLink(world.executionId, {
    gen: 1,
    mut: opts.mutationId ?? "mut-gen-1",
    prev: DERIVED_GENESIS,
    art: bytes,
    phaseId: opts.phaseId ?? world.phaseId,
    issuerIdentity: opts.issuerIdentity,
    revocationGeneration: opts.revocationGeneration,
    createdAt: opts.createdAt,
  });
  return publishDerivedArtifact({
    root: world.root,
    executionId: world.executionId,
    link,
    artifactBytes: bytes,
    repositoryFingerprint: world.fingerprint,
    transferMetricsRoot: world.foldRoot,
    writerId: "w1",
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
  });
}

// ═══════════════ Re-exports of the sealed production surface ══════════════

export {
  publishDerivedArtifact,
  buildDerivedLink,
  derivedGenerationPath,
  derivedReadState,
  derivedWalkChain,
  DERIVED_CODES,
  DERIVED_ARTIFACT_FORMAT_VERSION,
  resolveExecDir,
  HOLD,
};
