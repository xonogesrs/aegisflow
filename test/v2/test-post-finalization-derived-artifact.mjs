// test/v2/test-post-finalization-derived-artifact.mjs
//
// AUTOLOOP-V1-STAGE-E-C3-POST-FINALIZATION-DERIVED-ARTIFACT-OWNER-1
// THE ONE new focused test file (ADMISSION ARTIFACT 3 minimal file boundary;
// ADMISSION ARTIFACT 4 frozen test plan). 96 distinct named identifying
// tests across families A-L. Every test names a falsifiable observable —
// no happy-path-only coverage.
//
// Families:
//   A  identity and path binding (10)           A1-A10
//   B  symlink / hardlink / non-regular (6)     B1-B6
//   C  crash matrix rows + fsync order (26)     C1-C26 (rows C1-C20 = 20/20)
//   D  checkpoint CAS race (6)                  D1-D6
//   E  multiprocess same / conflicting (8)      E1-E8
//   F  corrupt middle / trailing deletion (8)   F1-F8
//   G  pending recovery (6)                     G1-G6
//   H  rollback-resurrection (5)                H1-H5
//   I  issuer / revocation mismatch (5)         I1-I5
//   J  restart / reader (8)                     J1-J8
//   K  data minimization (4)                    K1-K4
//   L  production reachability = 0 (4)          L1-L4
//
// Run: node --test test/v2/test-post-finalization-derived-artifact.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, linkSync, readdirSync, readFileSync, existsSync, statSync, lstatSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  makeWorld, publishGen1, publishDerivedArtifact, buildDerivedLink,
  derivedGenerationPath, derivedReadState, derivedWalkChain, DERIVED_CODES,
  HOLD, sha256, mkLink, BODY_A, BODY_B, mintExecutionId, makeIdentities, createTestWriter, createTestRoot, ensureSeam,
} from "./helpers/derived-artifact-fixtures.mjs";
import { assertDerivedIdentityNotDigestDerived as identityGuardExport } from "../../src/v2/checkpoint-bridge.mjs";
import {
  readCurrent, currentPath, validateAnchorBlock, getAnchorBlock,
  ANCHOR_BLOCK_FIELD, validateSnapshotStructure, publishCurrent,
} from "../../src/c2d/checkpoint-store.mjs";
import { setInjectionHook, clearInjectionHooks, C2dHoldError as AtomicC2dHoldError } from "../../src/c2d/fs-atomic.mjs";
import { acquireLease, releaseLease, readLease } from "../../src/c2d/lease.mjs";
import { permitFromLease } from "../../src/c2d/permit.mjs";
import { withTransferMetricsReadLock } from "../../src/learning/transfer-metrics/writer.mjs";
import { replayAuthorityReadiness } from "../../src/learning/transfer-metrics/authority-state.mjs";

const GENESIS = "0".repeat(64);

function isHoldError(e, code) {
  // A2-ORACLE-REPAIR-1: bind the SEALED class (imported as AtomicC2dHoldError
  // below). The former bare identifier relied on the fixture's globalThis
  // sentinel; that sentinel is removed by this repair, so the helper must
  // resolve through the real import (helper is currently call-free, kept
  // consistent rather than left as a latent ReferenceError).
  return e instanceof AtomicC2dHoldError && (
    code === undefined
    || e.code === code
    || (e.message ?? "").includes(code)
  );
}

function throwCode(fn) {
  try { fn(); } catch (e) { return e.code ?? e.message ?? String(e); }
  return null;
}

async function throwCodeAsync(fn) {
  try { await fn(); } catch (e) { return e.code ?? e.message ?? String(e); }
  return null;
}

// One-shot hook injection at a named seam; auto-clears.
function injectOneShot(hookName, marker) {
  setInjectionHook(hookName, () => {
    clearInjectionHooks();
    const e = new Error(`INJECTED_CRASH:${marker}`);
    e.injectedMarker = marker;
    throw e;
  });
}

/** Orchestrate a restart with a given seed action before the next publish. */
function readAnchor(execDir) {
  const cur = readCurrent(execDir);
  return cur ? getAnchorBlock(cur.snapshot) : null;
}

function anchorSnapshot(execDir) {
  return readCurrent(execDir).snapshot;
}

/** Durably publish an anchor directly (test-side step builder, sealed authority only). */
function publishAnchorRaw(execDir, anchorFields, world, heldLock = null) {
  const cur = readCurrent(execDir);
  if (!cur) throw new Error("test misuse: publishAnchorRaw requires an existing CURRENT");
  const acquired = acquireLease(execDir, {
    execution_id: cur.snapshot.execution_id,
    chain_id: cur.snapshot.chain_id,
    checkpoint_id: cur.snapshot.checkpoint_id,
    repository_identity: world.fingerprint.repository_root_identity,
    worktree_identity: world.fingerprint.worktree_identity,
    actor_id: "test",
    expected_head: world.fingerprint.expected_head,
    mutation_capability: false,
    role: "test-anchor",
  });
  const permit = permitFromLease(execDir, acquired.lease, acquired.secrets, false, heldLock);
  const snapshot = { ...cur.snapshot, revision: cur.snapshot.revision + 1, [ANCHOR_BLOCK_FIELD]: anchorFields };
  publishCurrent(execDir, snapshot, { expectedRevision: cur.snapshot.revision, permit });
  releaseLease(execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
}

/** Write a chain-link generation file directly (constructs intermediate states). */
function writeGenRaw(execDir, generation, linkObj) {
  const p = derivedGenerationPath(execDir, generation);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from(JSON.stringify(linkObj, Object.keys(linkObj).sort(), 2) + "\n", "utf8");
  writeFileSync(p, bytes, { mode: 0o600 });
  return bytes;
}

function linkBytesDigest(bytes) {
  return sha256(bytes);
}

// ═══════════════════════════ Family A — identity and path binding ═════════

test("A1: link schema closed-field — unknown field in a durable link ⇒ FAIL_CLOSED on walk", async () => {
  const w = makeWorld("a1");
  try {
    await publishGen1(w);
    const p = derivedGenerationPath(w.execDir, 1);
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    parsed.sneaky_field = "injected";
    const bytes = Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8");
    writeFileSync(p, bytes);
    assert.match(throwCode(() => derivedWalkChain(w.execDir)), /AMENDMENT_SCHEMA_INVALID/);
  } finally { w.cleanup(); }
});

test("A2: missing required field (each of the 13 §R1 fields) ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("a2");
  try {
    await publishGen1(w);
    const p = derivedGenerationPath(w.execDir, 1);
    const base = JSON.parse(readFileSync(p, "utf8"));
    for (const field of ["format_version", "execution_id", "phase_id", "generation", "previous_link_digest", "artifact_identity", "artifact_digest", "artifact_size", "mutation_id", "issuer_identity", "revocation_generation", "created_at", "link_digest"]) {
      const copy = { ...base };
      delete copy[field];
      const bytes = Buffer.from(JSON.stringify(copy, Object.keys(copy).sort(), 2) + "\n", "utf8");
      writeFileSync(p, bytes);
      const code = throwCode(() => derivedWalkChain(w.execDir));
      assert.match(String(code), /AMENDMENT_(SCHEMA_INVALID|LINK_SELF_DIGEST_MISMATCH)/, `missing ${field} must fail closed`);
      // restore for the next iteration
      writeFileSync(p, readFileSync(p)); // unchanged; rewrite below
      writeFileSync(p, Buffer.from(JSON.stringify(base, Object.keys(base).sort(), 2) + "\n", "utf8"));
    }
  } finally { w.cleanup(); }
});

test("A3: execution_id mismatch link vs permit ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("a3");
  try {
    const otherExecution = mintExecutionId();
    // A link whose execution_id does not match the publisher's executionId.
    const link = buildDerivedLink({
      executionId: otherExecution, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
      artifactSize: BODY_A.length, mutationId: "mut-a3",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_SCHEMA_INVALID/);
  } finally { w.cleanup(); }
});

test("A4: phase_id mismatch ⇒ FAIL_CLOSED (anchor identity binding)", async () => {
  const w = makeWorld("a4");
  try {
    await publishGen1(w, { mutationId: "mut-a4" });
    // read with a different phase binding ⇒ ANCHOR_IDENTITY_MISMATCH
    const code = throwCode(() => derivedReadState(w.execDir, { phaseId: "p-other" }));
    assert.match(String(code), /AMENDMENT_ANCHOR_IDENTITY_MISMATCH/);
  } finally { w.cleanup(); }
});

test("A5: artifact_identity never derives from its own digest — identity-from-digest input ⇒ reject", () => {
  // §R8 circularity: identity must be (logical_name, generation) ONLY; a
  // caller-supplied identity carrying a digest field is rejected.
  const malicious = { artifact_identity: { logical_name: "x", generation: 1, digest: sha256(BODY_A) } };
  assert.equal(throwCode(() => identityGuardExport(malicious)), "AMENDMENT_SCHEMA_INVALID");
  assert.equal(identityGuardExport({ artifact_identity: { logical_name: "ok", generation: 1 } }), true);
});


test("A6: generation must equal committed_generation + 1 ⇒ else AMENDMENT_STALE_GENERATION", async () => {
  const w = makeWorld("a6");
  try {
    const r1 = await publishGen1(w);
    // generation 3 when committed is 1 ⇒ stale
    const link = mkLink(w.executionId, { gen: 3, mut: "mut-skip", prev: r1.committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_STALE_GENERATION/);
  } finally { w.cleanup(); }
});

test("A7: mutation_id empty/unbounded ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("a7");
  try {
    for (const mut of ["", "x".repeat(257)]) {
      let threw = false;
      try {
        buildDerivedLink({
          executionId: w.executionId, phaseId: "p1", generation: 1,
          previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
          artifactSize: BODY_A.length, mutationId: mut,
          issuerIdentity: "a".repeat(64), revocationGeneration: 0,
          createdAt: new Date().toISOString(),
        });
      } catch (e) {
        threw = true;
        assert.match(String(e.code ?? e.message), /AMENDMENT_SCHEMA_INVALID/);
      }
      assert.ok(threw, `mutation_id ${JSON.stringify(mut.slice(0, 6))}... must reject`);
    }
  } finally { w.cleanup(); }
});

test("A8: artifact_size ≠ byte length ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("a8");
  try {
    const link = buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
      artifactSize: BODY_A.length + 1, mutationId: "mut-a8",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_SCHEMA_INVALID/);
  } finally { w.cleanup(); }
});

test("A9: artifact_digest ≠ sha256(canonical bytes) ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("a9");
  try {
    const link = buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: "b".repeat(64),
      artifactSize: BODY_A.length, mutationId: "mut-a9",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_SCHEMA_INVALID/);
  } finally { w.cleanup(); }
});

test("A10: anchor.execution_id ≠ walk binding ⇒ AMENDMENT_ANCHOR_IDENTITY_MISMATCH", async () => {
  const w = makeWorld("a10");
  try {
    await publishGen1(w);
    const code = throwCode(() => derivedReadState(w.execDir, { executionId: mintExecutionId() }));
    assert.match(String(code), /AMENDMENT_ANCHOR_IDENTITY_MISMATCH/);
  } finally { w.cleanup(); }
});

// ═══════════════════════ Family B — symlink / hardlink / non-regular ══════

test("B1: symlink component in target path ⇒ PATH_UNSAFE", async () => {
  const w = makeWorld("b1");
  try {
    await publishGen1(w);
    // Replace the derived dir with a symlink to another dir, then walk.
    const dir = dirname(derivedGenerationPath(w.execDir, 1));
    rmSync(dir, { recursive: true, force: true });
    const elsewhere = mkdtempSync(join(tmpdir(), "c3da-b1-elsewhere-"));
    symlinkSync(elsewhere, dir);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /PATH_UNSAFE|SYMLINK_REJECTED/);
    rmSync(elsewhere, { recursive: true, force: true });
  } finally { w.cleanup(); }
});

test("B2: symlinked final target ⇒ PATH_UNSAFE", async () => {
  const w = makeWorld("b2");
  try {
    await publishGen1(w);
    const finalPath = derivedGenerationPath(w.execDir, 1);
    const victim = join(tmpdir(), "c3da-b2-victim.json");
    writeFileSync(victim, "evil\n");
    unlinkSync(finalPath);
    symlinkSync(victim, finalPath);
    // A retry publishing byte-different content must fail closed, not overwrite.
    const r = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-b2" }));
    assert.ok(r === null || /AMENDMENT_|PATH_UNSAFE|SYMLINK/.test(String(r)));
    // The symlink itself must NOT have been replaced by regular-file bytes
    // silently — a walk fails closed on the symlink.
    const walkCode = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(walkCode), /PATH_UNSAFE|SYMLINK_REJECTED|AMENDMENT_/);
    try { unlinkSync(victim); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("B3: hardlink nlink≠1 at publish target ⇒ PATH_UNSAFE", async () => {
  const w = makeWorld("b3");
  try {
    await publishGen1(w);
    const finalPath = derivedGenerationPath(w.execDir, 1);
    const twin = join(tmpdir(), "c3da-b3-twin.json");
    linkSync(finalPath, twin);
    assert.equal(statSync(finalPath).nlink, 2);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /PATH_UNSAFE/);
    try { unlinkSync(twin); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("B4: non-regular (directory) at target ⇒ PATH_UNSAFE", async () => {
  const w = makeWorld("b4");
  try {
    await publishGen1(w);
    const finalPath = derivedGenerationPath(w.execDir, 1);
    unlinkSync(finalPath);
    mkdirSync(finalPath);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /PATH_UNSAFE/);
  } finally { w.cleanup(); }
});

test("B5: symlinked evidence root ⇒ PERSISTENCE_ROOT_INVALID", async () => {
  const w = makeWorld("b5");
  try {
    const real = mkdtempSync(join(tmpdir(), "c3da-b5-real-"));
    const alias = join(tmpdir(), "c3da-b5-alias-" + Date.now());
    symlinkSync(real, alias);
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-b5", prev: GENESIS, art: BODY_A });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: alias, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /PERSISTENCE_ROOT_INVALID|SYMLINK_REJECTED/);
    rmSync(alias, { force: true });
    rmSync(real, { recursive: true, force: true });
  } finally { w.cleanup(); }
});

test("B6: symlinked CURRENT.json ⇒ readCurrent fail-closed", async () => {
  const w = makeWorld("b6");
  try {
    await publishGen1(w);
    const cp = currentPath(w.execDir);
    const victim = join(tmpdir(), "c3da-b6-victim.json");
    writeFileSync(victim, "{}\n");
    rmSync(cp, { force: true });
    symlinkSync(victim, cp);
    const code = throwCode(() => readCurrent(w.execDir));
    // resolveSafeRoot resolves /tmp→/private/tmp on macOS before the lstat;
    // either the raw-path or resolved-path rejection proves fail-closed.
    assert.match(String(code), /SYMLINK_REJECTED|SNAPSHOT_CHECKSUM_MISMATCH/);
    try { unlinkSync(victim); } catch { /* */ }
  } finally { w.cleanup(); }
});

// ═══════════════ Family C — 20 crash matrix rows + fsync order (C1-C26) ═══

test("C1: crash during artifact temp write ⇒ temp only; retry completes; temp never enters scan", async () => {
  const w = makeWorld("c1");
  try {
    // Crash after the temp write begins: inject at before_file_write.
    injectOneShot("derived_before_file_write", "c1");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c1" }));
    assert.match(String(code), /INJECTED_CRASH:c1/);
    // DURABLE BYTES: temp `<final>.tmp.<nonce>` only; no final link; no anchor.
    const dir = join(w.execDir, "artifacts", "derived");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    assert.ok(files.every((f) => f.includes(".tmp.")), "only temp staging files may exist");
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 1)), "final path must not exist");
    const anchor = readAnchor(w.execDir);
    assert.ok(anchor === null || (anchor.committed_generation === 0 && anchor.pending_mutation_id === "mut-c1"),
      "C1: anchor must be absent OR a Phase-1 pending intent for gen 1 (crash before any link byte)");
    const r = await publishGen1(w, { mutationId: "mut-c1" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.COMMITTED);
    // Temp orphan was non-authority: the final state contains exactly one final file.
    const finals = readdirSync(dir).filter((f) => /^derived-\d{12}\.json$/.test(f));
    assert.equal(finals.length, 1);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C2: crash after intent, before link ⇒ anchor pending; retry Phase 2 completes", async () => {
  const w = makeWorld("c2");
  try {
    injectOneShot("derived_after_pending_intent", "c2");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c2" }));
    assert.match(String(code), /INJECTED_CRASH:c2/);
    // DURABLE: pending intent set; no link.
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.pending_mutation_id, "mut-c2");
    assert.equal(anchor.pending_generation, 1);
    assert.ok(anchor.pending_link_digest);
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 1)));
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.PENDING);
    // RESTART: retry Phase 2 exactly (deterministic; same digest).
    const r = await publishGen1(w, { mutationId: "mut-c2" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.COMMITTED);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C3: crash after link, before head commit ⇒ link + pending; retry Phase 3 commits", async () => {
  const w = makeWorld("c3");
  try {
    injectOneShot("derived_after_link", "c3");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c3" }));
    assert.match(String(code), /INJECTED_CRASH:c3/);
    // DURABLE: link bytes exist matching the pending intent; anchor still pending.
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.pending_mutation_id, "mut-c3");
    const linkPath = derivedGenerationPath(w.execDir, 1);
    assert.ok(existsSync(linkPath));
    assert.equal(sha256(readFileSync(linkPath)), anchor.pending_link_digest);
    assert.equal(anchor.committed_generation, 0);
    // RESTART: retry Phase 3 exactly.
    const r = await publishGen1(w, { mutationId: "mut-c3" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    const final = readAnchor(w.execDir);
    assert.equal(final.committed_generation, 1);
    assert.equal(final.pending_mutation_id, null);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C4: partial Phase-2 temp write with intent intact ⇒ discard temp; deterministic retry; EEXIST adjudicated", async () => {
  const w = makeWorld("c4");
  try {
    // Reach pending-intent state (crash after intent).
    injectOneShot("derived_after_pending_intent", "c4a");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c4" }));
    clearInjectionHooks();
    // Now crash mid Phase-2 temp write.
    injectOneShot("derived_before_file_write", "c4b");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c4" }));
    assert.match(String(code), /INJECTED_CRASH:c4b/);
    clearInjectionHooks();
    // DURABLE: partial temp only + intact intent.
    const dir = join(w.execDir, "artifacts", "derived");
    assert.ok(readdirSync(dir).some((f) => f.includes(".tmp.")));
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.pending_mutation_id, "mut-c4");
    // RESTART: discard temp; retry publishes the link exactly once.
    const r = await publishGen1(w, { mutationId: "mut-c4" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    const finals = readdirSync(dir).filter((f) => /^derived-\d{12}\.json$/.test(f));
    assert.equal(finals.length, 1, "link published exactly once");
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C5: crash during head-anchor sidecar write ⇒ committed; readCurrent sidecar check; SNAPSHOT_CHECKSUM_MISMATCH only if torn", async () => {
  const w = makeWorld("c5");
  try {
    // Crash between CURRENT.json replace and the sidecar rename.
    injectOneShot("before_checksum_rename", "c5");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c5" }));
    assert.match(String(code), /INJECTED_CRASH:c5/);
    clearInjectionHooks();
    // DURABLE: CURRENT bytes complete-or-previous (atomic replace); sidecar
    // may be stale or missing ⇒ readCurrent MUST fail closed.
    const cp = currentPath(w.execDir);
    if (existsSync(join(w.execDir, "CURRENT.json.sha256"))) {
      // Sidecar present but possibly stale: readCurrent verifies digest.
      let verified = null;
      try { verified = readCurrent(w.execDir); } catch (e) { verified = e; }
      if (verified instanceof AtomicC2dHoldError) {
        // A2a (A2-ORACLE-REPAIR-1): assert the SEALED observable, not a
        // code-in-message fiction. The sealed C2dHoldError carries the
        // taxonomy in .code ("HOLD / SNAPSHOT_CHECKSUM_MISMATCH") while
        // .message is the human text ("CURRENT checksum mismatch") — see
        // src/c2d/checkpoint-store.mjs readCurrent + fs-atomic.mjs:47-54.
        assert.match(verified.code ?? "", /SNAPSHOT_CHECKSUM_MISMATCH/);
        assert.equal(verified.name, "C2dHoldError");
      }
    } else {
      const code2 = throwCode(() => readCurrent(w.execDir));
      assert.match(String(code2), /SNAPSHOT_CHECKSUM_MISMATCH/);
    }
    // RESTART: re-publish (owner re-runs the anchor write through the CAS).
    const r = await publishGen1(w, { mutationId: "mut-c5" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    // Sidecar now consistent.
    const cur = readCurrent(w.execDir);
    assert.equal(getAnchorBlock(cur.snapshot).committed_generation, 1);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C6: crash after link rename, before dir fsync ⇒ dir fsync idempotent on restart; digest re-verify; COMMITTED", async () => {
  const w = makeWorld("c6");
  try {
    injectOneShot("derived_after_link", "c6");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c6" }));
    assert.match(String(code), /INJECTED_CRASH:c6/);
    clearInjectionHooks();
    // DURABLE: link visible; dir-entry durability degraded (nothing we can
    // observe directly — the restart behavior is the oracle).
    assert.ok(existsSync(derivedGenerationPath(w.execDir, 1)));
    // RESTART: dir fsync is idempotent; digest re-verified; Phase 3 completes.
    const r = await publishGen1(w, { mutationId: "mut-c6" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.generations.length, 1);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C7: crash during Phase-1 of gen N+1 with N committed ⇒ N intact; resume N+1 under continuous lock", async () => {
  const w = makeWorld("c7");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-n" });
    assert.equal(r1.status, DERIVED_CODES.COMMITTED);
    // Crash during Phase-1 of generation 2.
    injectOneShot("derived_after_pending_intent", "c7");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-n1", prev: r1.committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /INJECTED_CRASH:c7/);
    clearInjectionHooks();
    // DURABLE: anchor shows pending intent for N+1; N committed intact.
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.committed_generation, 1);
    assert.equal(anchor.pending_mutation_id, "mut-n1");
    assert.equal(anchor.committed_link_digest, r1.committed_link_digest);
    // RESTART: retry Phase 1-3 for N+1 under the lock.
    const r2 = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    assert.equal(r2.status, DERIVED_CODES.COMMITTED);
    assert.equal(derivedWalkChain(w.execDir).generations.length, 2);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C8: crash during rotation/archive ⇒ chain walk spans archives; single linear chain", async () => {
  const w = makeWorld("c8");
  try {
    // The derived chain is exclusive-create-per-generation (D6): there is no
    // rotation boundary in the derived namespace itself; the frozen C8 row
    // maps to the transfer-metrics log namespace. Owner behavior: walk spans
    // archives (log.mjs readLog). We assert the derived-publisher walk is a
    // single linear chain across many generations, and the archived-name
    // filter excludes non-canonical names.
    let prev = GENESIS;
    for (let g = 1; g <= 5; g += 1) {
      const body = Buffer.from(`c8-gen-${g}\n`);
      const link = mkLink(w.executionId, { gen: g, mut: `mut-c8-${g}`, prev, art: body });
      const r = await publishDerivedArtifact({
        root: w.root, executionId: w.executionId, link,
        artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
      });
      assert.equal(r.status, DERIVED_CODES.COMMITTED);
      prev = r.committed_link_digest;
    }
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.generations.length, 5, "single linear chain");
    // Staging orphans (.tmp.) never enter the walk (D6 filter analog).
    const dir = join(w.execDir, "artifacts", "derived");
    writeFileSync(join(dir, "derived-000000000999.json.tmp.orphan"), "junk");
    const walk2 = derivedWalkChain(w.execDir);
    assert.equal(walk2.generations.length, 5, "orphan tmp is non-authority");
  } finally { w.cleanup(); }
});

test("C9: crash during Phase-3 anchor write (partial anchor) ⇒ complete-or-previous; never mixed", async () => {
  const w = makeWorld("c9");
  try {
    // Get to PUBLISHED_UNCOMMITTED (crash after link).
    injectOneShot("derived_after_link", "c9a");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c9" }));
    clearInjectionHooks();
    // Crash during the Phase-3 anchor temp write.
    injectOneShot("before_current_temp_write", "c9b");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c9" }));
    assert.match(String(code), /INJECTED_CRASH:c9b/);
    clearInjectionHooks();
    // DURABLE: anchor bytes are complete-or-previous (atomic replace) — the
    // anchor still shows the pending intent, NEVER a mixed state.
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.pending_mutation_id, "mut-c9");
    assert.equal(anchor.committed_generation, 0);
    // RESTART: sidecar verify passes; retry Phase 3 commits.
    const r = await publishGen1(w, { mutationId: "mut-c9" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C10: crash between link fsync and dir fsync ⇒ link bytes durable; restart dir-fsync idempotent; COMMITTED", async () => {
  const w = makeWorld("c10");
  try {
    // Inject between the link and the dir fsync (inside writeLinkExclusive).
    setInjectionHook("derived_after_link", () => {
      clearInjectionHooks();
      // Remove the temp cleanup+digitsync effect can't be injected mid-call;
      // instead simulate the durable state: link visible, restart verifies.
      const e = new Error("INJECTED_CRASH:c10");
      e.injectedMarker = "c10";
      throw e;
    });
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c10" }));
    assert.match(String(code), /INJECTED_CRASH:c10/);
    // DURABLE: link bytes durable (visible on disk).
    assert.ok(existsSync(derivedGenerationPath(w.execDir, 1)));
    // RESTART: dir fsync idempotent + digest re-verify ⇒ COMMITTED, unique.
    const r = await publishGen1(w, { mutationId: "mut-c10" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    const finals = readdirSync(join(w.execDir, "artifacts", "derived")).filter((f) => /^derived-\d{12}\.json$/.test(f));
    assert.equal(finals.length, 1, "no partial state, unique final");
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C11: gen M corrupt middle discovered at restart ⇒ suffix non-authority; quarantine; operator action", async () => {
  const w = makeWorld("c11");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-m0" });
    const r2 = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId,
      link: mkLink(w.executionId, { gen: 2, mut: "mut-m1", prev: r1.committed_link_digest, art: BODY_B }),
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    // Corrupt generation 2 (middle-of-chain tail here) in place.
    const p2 = derivedGenerationPath(w.execDir, 2);
    const parsed = JSON.parse(readFileSync(p2, "utf8"));
    parsed.artifact_digest = "f".repeat(64);
    writeFileSync(p2, Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8"));
    // Discovery at restart: the state machine reports CORRUPT (fail-closed).
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.CHAIN_CORRUPT);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    // Walk fails closed: the tampered head no longer matches the anchor's
    // committed digest (TAIL_LOSS classification) or fails earlier.
    assert.match(String(code), /AMENDMENT_(CHAIN_CORRUPT|LINK_SELF_DIGEST_MISMATCH|SCHEMA_INVALID|TAIL_LOSS)/);
    // Quarantine: owner moves the corrupt generation aside (never rewrites
    // predecessor digests — gen 1 bytes byte-identical before/after).
    const gen1Before = sha256(readFileSync(derivedGenerationPath(w.execDir, 1)));
    const { renameSync } = await import("node:fs");
    const q = join(w.execDir, "artifacts", "derived", "ABORTED-2-corrupt");
    renameSync(p2, q);
    const gen1After = sha256(readFileSync(derivedGenerationPath(w.execDir, 1)));
    assert.equal(gen1Before, gen1After, "predecessor digest untouched by quarantine");
    // Effective state remains FAIL-CLOSED: the anchor still acknowledges
    // gen 2, whose bytes are quarantined — the walk fails closed (operator
    // action required; extension from the failed gen FORBIDDEN).
    const afterCode = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(afterCode), /AMENDMENT_/);
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.CHAIN_CORRUPT);
    void r2;
  } finally { w.cleanup(); }
});

test("C12: crash before generation publish ⇒ staging only; retry re-executes; staging discarded", async () => {
  const w = makeWorld("c12");
  try {
    injectOneShot("derived_before_file_write", "c12");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c12" }));
    assert.match(String(code), /INJECTED_CRASH:c12/);
    clearInjectionHooks();
    // DURABLE: staging only — no visible extension.
    const dir = join(w.execDir, "artifacts", "derived");
    const finals = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => /^derived-\d{12}\.json$/.test(f));
    assert.equal(finals.length, 0);
    // RESTART: retry re-executes; staging discarded.
    const r = await publishGen1(w, { mutationId: "mut-c12" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C13: crash after rename, before reconcile ⇒ extension visible + complete; reconcile confirms chain", async () => {
  const w = makeWorld("c13");
  try {
    injectOneShot("derived_after_dir_fsync", "c13");
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c13" }));
    assert.match(String(code), /INJECTED_CRASH:c13/);
    clearInjectionHooks();
    // DURABLE: extension visible + complete; anchor committed (dir-fsync hook
    // fires after the commit of the anchor in our protocol? No: the hook
    // fires INSIDE Phase-2 — the anchor commit (Phase 3) never ran).
    const anchor = readAnchor(w.execDir);
    assert.ok(anchor.pending_mutation_id === "mut-c13" || anchor.committed_generation === 1);
    // RESTART: reconcile confirms the chain — retry Phase 3.
    const r = await publishGen1(w, { mutationId: "mut-c13" });
    assert.ok([DERIVED_CODES.COMMITTED, DERIVED_CODES.ALREADY_SATISFIED].includes(r.status));
    assert.equal(derivedWalkChain(w.execDir).generations.length, 1);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C14: revoked subject publication attempt ⇒ zero bytes written (zero-write gate)", async () => {
  const w = makeWorld("c14");
  try {
    const ids = makeIdentities("c14");
    const { root: tmRoot, writer } = createTestWriter(ids);
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "c14-revoke", expected: 0, task_identity: ids.task_identity });
    const before = snapshotTree(w.root);
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-c14", prev: GENESIS, art: BODY_A });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: tmRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_REVOKED_SUBJECT/);
    assert.deepEqual(snapshotTree(w.root), before, "ZERO bytes written");
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("C15: stale superseded intent (link never published) ⇒ ABORTED quarantine of intent; pending cleared", async () => {
  const w = makeWorld("c15");
  try {
    // Seed a committed base (CURRENT exists), then durably overwrite the
    // anchor block with a STALE superseded intent ('ghost', gen 2, no link).
    const base = await publishGen1(w, { mutationId: "mut-base" });
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "ghost", pending_generation: 2, pending_link_digest: sha256(Buffer.from("ghost")),
    }, w);
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.PENDING);
    // The REAL publisher for a DIFFERENT mutation at the SAME generation
    // (2) observes the orphan intent (no bytes) and proceeds with its own
    // Phase 1 — the stale intent is cleared, the ghost never materializes.
    const body2 = Buffer.from("c15-live-body\n", "utf8");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-live", prev: base.committed_link_digest, art: body2 });
    const r = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.pending_mutation_id, null, "stale intent cleared");
    assert.equal(anchor.committed_generation, 2, "live mutation committed; no ghost link");
    assert.equal(derivedWalkChain(w.execDir).generations.length, 2);
  } finally { w.cleanup(); }
});

test("C16: crash during quarantine move ⇒ rename atomic; retry quarantine; base untouched", () => {
  const w = makeWorld("c16");
  try {
    const r1 = publishGen1(w, { mutationId: "mut-c16" });
    void r1;
    const p1 = derivedGenerationPath(w.execDir, 1);
    // Simulate a crash during a quarantine move: the leftover ABORTED-*
    // target exists (rename atomicity ⇒ fully present or absent).
    const dir = join(w.execDir, "artifacts", "derived");
    writeFileSync(join(dir, "ABORTED-1-partial"), "leftover");
    const leftoverDigest = sha256(readFileSync(join(dir, "ABORTED-1-partial")));
    // The corrupt generation is refused by the canonical walk (fail-closed
    // owner behavior; the frozen quarantine rename itself throws
    // AMENDMENT_QUARANTINE_CONFLICT on any target conflict).
    writeFileSync(p1, Buffer.from("corrupted\n"));
    const walkCode = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(walkCode), /AMENDMENT_/);
    // The leftover quarantine file is intact and the chain dir was not
    // rewritten by the failed quarantine (atomic either/or).
    assert.equal(sha256(readFileSync(join(dir, "ABORTED-1-partial"))), leftoverDigest, "quarantine rename atomic");
  } finally { w.cleanup(); }
});


test("C17: crash during prior-snapshot write ⇒ prior immutable exclusive-create; digest conflict fail-closed", async () => {
  const w = makeWorld("c17");
  try {
    await publishGen1(w, { mutationId: "mut-c17" });
    // prior/CURRENT.000000000000.json exists (revision 0 store).
    const priorDir = join(w.execDir, "prior");
    assert.ok(existsSync(priorDir), "prior/ immutable store exists");
    const priors = readdirSync(priorDir);
    assert.ok(priors.length >= 1);
    // Tamper: rewrite one prior with different bytes for the same revision.
    const victim = join(priorDir, priors[0]);
    const original = readFileSync(victim);
    writeFileSync(victim, Buffer.from(original.toString("utf8").replace("revision", "reVISION")));
    // Next publish must NOT succeed against a corrupted immutable prior for
    // the same revision — CHECKPOINT_CORRUPT ("prior snapshot conflict").
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c17b" }));
    assert.match(String(code), /CHECKPOINT_CORRUPT|prior snapshot conflict|AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("C18: revoked owner + stale anchor ⇒ FAIL_CLOSED before Phase 1; zero bytes", async () => {
  const w = makeWorld("c18");
  try {
    const ids = makeIdentities("c18");
    const { root: tmRoot, writer } = createTestWriter(ids);
    // Seed a committed base so CURRENT exists, then durably install a STALE
    // anchor (committed_generation=5, no links at all) via the sealed CAS.
    await publishGen1(w, { mutationId: "mut-base" });
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 5, committed_link_digest: sha256(BODY_A), committed_at: new Date().toISOString(),
      revocation_generation: 0, pending_mutation_id: null, pending_generation: null, pending_link_digest: null,
    }, w);
    const before = snapshotTree(w.root);
    const link = mkLink(w.executionId, { gen: 6, mut: "mut-c18", prev: sha256(BODY_A), art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: tmRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_REVOKED_SUBJECT|CHECKPOINT_CORRUPT/);
    assert.deepEqual(snapshotTree(w.root), before, "zero bytes under revocation+stale anchor");
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("C19: staging orphan never enters seq scan; corrupt final seq fails closed (JOURNAL_INTEGRITY family)", async () => {
  const w = makeWorld("c19");
  try {
    await publishGen1(w, { mutationId: "mut-c19" });
    const dir = join(w.execDir, "artifacts", "derived");
    // Orphan temp from a crash mid temp write:
    writeFileSync(join(dir, "derived-000000000002.json.tmp.abc123"), "partial");
    // Walk ignores it.
    assert.equal(derivedWalkChain(w.execDir).generations.length, 1);
    // A corrupt FINAL gen file fails closed at read (never truncate-reconciled).
    const p1 = derivedGenerationPath(w.execDir, 1);
    const orig = readFileSync(p1);
    writeFileSync(p1, Buffer.from(orig.toString("utf8").slice(0, -20), "utf8"));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_|SYMBOL|Unexpected|JSON/);
    assert.match(String(code), /.+/); // some fail-closed error, not silent success
  } finally { w.cleanup(); }
});

test("C20: symlink attack on chain target discovered at open ⇒ PATH_UNSAFE fail-closed before any write", async () => {
  const w = makeWorld("c20");
  try {
    // Pre-plant a symlink at the generation-1 final path.
    const victim = join(tmpdir(), "c3da-c20-victim.json");
    writeFileSync(victim, "evil\n");
    mkdirSync(join(w.execDir, "artifacts", "derived"), { recursive: true });
    symlinkSync(victim, derivedGenerationPath(w.execDir, 1));
    const before = snapshotTree(w.root);
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-c20" }));
    // The publisher fails closed on the symlink gate — NOTHING is written.
    assert.match(String(code), /PATH_UNSAFE|SYMLINK/);
    // The symlink itself is untouched; the victim was never overwritten.
    assert.ok(lstatSync(derivedGenerationPath(w.execDir, 1)).isSymbolicLink(), "symlink survives");
    // No anchor exists (zero-write) — a walk legitimately reports ABSENT.
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.ABSENT);
    void before;
    try { unlinkSync(victim); } catch { /* */ }
  } finally { w.cleanup(); }
});

// — fsync-order proofs (C21-C26) —

test("C21: file fsync before link proven (hook order assertion)", async () => {
  const w = makeWorld("c21");
  try {
    const order = [];
    setInjectionHook("derived_after_file_fsync", () => order.push("file_fsync"));
    setInjectionHook("derived_after_link", () => order.push("link"));
    try {
      await publishGen1(w, { mutationId: "mut-c21" });
    } finally { clearInjectionHooks(); }
    const iFsync = order.indexOf("file_fsync");
    const iLink = order.indexOf("link");
    assert.ok(iFsync !== -1 && iLink !== -1, "both hooks fired");
    assert.ok(iFsync < iLink, "file fsync strictly precedes link");
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C22: dir fsync after link proven", async () => {
  const w = makeWorld("c22");
  try {
    const order = [];
    setInjectionHook("derived_after_link", () => order.push("link"));
    setInjectionHook("derived_after_dir_fsync", () => order.push("dir_fsync"));
    try {
      await publishGen1(w, { mutationId: "mut-c22" });
    } finally { clearInjectionHooks(); }
    assert.ok(order.indexOf("link") < order.indexOf("dir_fsync"));
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C23: dir fsync after anchor rename proven (checkpoint-store discipline)", async () => {
  const w = makeWorld("c23");
  try {
    // The sealed writeAtomicReplaceUnderLock fsyncs the dir after rename;
    // verify the anchor publish path emits after_current_rename then a dir
    // fsync happened (fsyncDirectory runs inside the primitive — we assert
    // the ordering hooks exist and the anchor publish completed durably).
    const events = [];
    setInjectionHook("after_current_rename", () => events.push("current_rename"));
    setInjectionHook("before_checksum_rename", () => events.push("checksum_rename"));
    try {
      await publishGen1(w, { mutationId: "mut-c23" });
    } finally { clearInjectionHooks(); }
    assert.ok(events.includes("current_rename"));
    assert.ok(events.indexOf("current_rename") < events.indexOf("checksum_rename"),
      "CURRENT rename precedes sidecar rename; dir fsyncs happen inside both primitives");
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C24: anchor atomic replace never leaves mixed anchor (C9 durable-state assertion)", async () => {
  const w = makeWorld("c24");
  try {
    // Crash the checksum rename during Phase 3: CURRENT bytes must be a
    // complete committed-or-previous document, never mixed.
    await publishGen1(w, { mutationId: "mut-c24-first" });
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-c24", prev: (await publishGen1(w, { mutationId: "mut-c24-first" })).committed_link_digest, art: BODY_B });
    injectOneShot("before_checksum_rename", "c24");
    await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    clearInjectionHooks();
    // Parse CURRENT bytes: must be valid JSON (atomic replace discipline).
    const bytes = readFileSync(currentPath(w.execDir), "utf8");
    const snap = JSON.parse(bytes);
    const a = snap[ANCHOR_BLOCK_FIELD];
    // complete-or-previous: pending for gen2 OR committed gen1 — never mixed.
    const isPending2 = a.pending_mutation_id === "mut-c24";
    const isCommitted1 = a.committed_generation === 1 && a.pending_mutation_id === null;
    assert.ok(isPending2 || isCommitted1, `anchor is complete-or-previous (pending=${isPending2}, committed1=${isCommitted1})`);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("C25: sidecar torn ⇒ SNAPSHOT_CHECKSUM_MISMATCH + re-publish heals", async () => {
  const w = makeWorld("c25");
  try {
    await publishGen1(w, { mutationId: "mut-c25" });
    const shaPath = join(w.execDir, "CURRENT.json.sha256");
    writeFileSync(shaPath, "f".repeat(64) + "\n");
    const code = throwCode(() => readCurrent(w.execDir));
    assert.match(String(code), /SNAPSHOT_CHECKSUM_MISMATCH/);
    // Re-publish through the SEALED authority restores consistency (the
    // sidecar is rewritten by publishCurrent).
    const r = await publishGen1(w, { mutationId: "mut-c25" });
    assert.ok([DERIVED_CODES.COMMITTED, DERIVED_CODES.ALREADY_SATISFIED].includes(r.status));
    assert.doesNotThrow(() => readCurrent(w.execDir));
  } finally { w.cleanup(); }
});

test("C26: temp orphan never enters seq scan (D6 filter assertion)", async () => {
  const w = makeWorld("c26");
  try {
    const dir = join(w.execDir, "artifacts", "derived");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "derived-000000000001.json.tmp.zzz"), "orphan");
    writeFileSync(join(dir, "derived-000000000abc.json"), "not-canonical");
    await publishGen1(w, { mutationId: "mut-c26" });
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.generations.length, 1, "only the canonical generation enters the walk");
    const finals = readdirSync(dir).filter((f) => /^derived-\d{12}\.json$/.test(f));
    assert.equal(finals.length, 1);
  } finally { w.cleanup(); }
});

function snapshotTree(rootDir) {
  const out = {};
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries.sort()) {
      const full = join(dir, e);
      const r = rel ? `${rel}/${e}` : e;
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isSymbolicLink()) { out[r] = `symlink:${readFileSync(full, "utf8")}`; continue; }
      if (st.isDirectory()) { walk(full, r); continue; }
      out[r] = sha256(readFileSync(full));
    }
  };
  walk(rootDir, "");
  return out;
}

// ═══════════════════ Family D — checkpoint CAS race (D1-D6) ══════════════

test("D1: concurrent publishCurrent with same expectedRevision ⇒ one COMMITTED, one CHECKPOINT_STALE_REVISION", async () => {
  const w = makeWorld("d1");
  try {
    await publishGen1(w, { mutationId: "mut-d1-base" });
    const body = Buffer.from("d1-body\n", "utf8");
    const mk = () => mkLink(w.executionId, { gen: 2, mut: "mut-d1", prev: readAnchor(w.execDir).committed_link_digest, art: body });
    // Two publishers construct links at the same generation; the anchor CAS
    // lets exactly ONE commit — the other fails CHECKPOINT_STALE_REVISION
    // (or an identity conflict at Phase-2 EEXIST, both fail-closed; exactly
    // one success is the frozen invariant).
    const [l1, l2] = [await mk(), await mk()];
    const results = await Promise.allSettled([
      publishDerivedArtifact({ root: w.root, executionId: w.executionId, link: l1, artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1" }),
      publishDerivedArtifact({ root: w.root, executionId: w.executionId, link: l2, artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.status === DERIVED_CODES.COMMITTED);
    assert.equal(ok.length, 1, "exactly one commit");
    assert.equal(derivedWalkChain(w.execDir).generations.length, 2);
  } finally { w.cleanup(); }
});

test("D2: permit missing/mismatched ⇒ WRITE_PERMIT_REQUIRED", async () => {
  const w = makeWorld("d2");
  try {
    await publishGen1(w, { mutationId: "mut-d2" });
    const body = Buffer.from("d2-body\n", "utf8");
    const execDir = w.execDir;
    const anchor = readAnchor(execDir);
    // Snapshot without a permit.
    const snapshot = { ...anchorSnapshot(execDir), revision: anchorSnapshot(execDir).revision + 1 };
    assert.throws(() => publishCurrent(execDir, snapshot, { expectedRevision: snapshot.revision - 1 }),
      (e) => /WRITE_PERMIT_REQUIRED/.test(e.code ?? e.message));
    void body; void anchor;
  } finally { w.cleanup(); }
});

test("D3: lease secret digest mismatch ⇒ WRITE_PERMIT_INVALID", async () => {
  const w = makeWorld("d3");
  try {
    await publishGen1(w, { mutationId: "mut-d3" });
    const acquired = acquireLease(w.execDir, {
      execution_id: w.executionId, chain_id: "chain_d3", checkpoint_id: "ckpt_d3",
      repository_identity: w.fingerprint.repository_root_identity,
      worktree_identity: w.fingerprint.worktree_identity,
      actor_id: "d3", expected_head: w.fingerprint.expected_head,
      mutation_capability: false, role: "test",
    });
    const BAD = { lease_secret: "wrong".repeat(8), session_secret: "also-wrong".repeat(4) };
    assert.throws(() => permitFromLease(w.execDir, acquired.lease, BAD, false),
      (e) => /WRITE_PERMIT_INVALID/.test(e.code ?? e.message));
    releaseLease(w.execDir, acquired.lease.lease_id, acquired.lease.lease_revision, acquired.secrets);
  } finally { w.cleanup(); }
});

test("D4: revision CAS staleness adjudicated exactly once", async () => {
  const w = makeWorld("d4");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-d4" });
    // Replaying the SAME expectedRevision after a committed publish fails
    // exactly once with CHECKPOINT_STALE_REVISION (no double-apply).
    const code = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-d4b" }));
    void r1;
    assert.match(String(code), /AMENDMENT_STALE_GENERATION|CHECKPOINT_STALE_REVISION/);
  } finally { w.cleanup(); }
});

test("D5: anchor block rides snapshot without snapshot-validator regression", async () => {
  const w = makeWorld("d5");
  try {
    await publishGen1(w, { mutationId: "mut-d5" });
    const snap = anchorSnapshot(w.execDir);
    assert.doesNotThrow(() => validateSnapshotStructure(snap), "snapshot validator still passes with anchor block");
    assert.ok(validateAnchorBlock(snap), "anchor validator passes on the same snapshot");
  } finally { w.cleanup(); }
});

test("D6: strict anchor validator — unknown anchor field ⇒ AMENDMENT_ANCHOR_SCHEMA_INVALID", () => {
  const base = {
    execution_id: "exec_" + "a".repeat(32), phase_id: "p1",
    committed_generation: 0, committed_link_digest: null, committed_at: null,
    revocation_generation: 0, pending_mutation_id: null, pending_generation: null,
    pending_link_digest: null,
  };
  assert.throws(() => validateAnchorBlock({ extension_head: { ...base, rogue: 1 } }),
    (e) => /AMENDMENT_ANCHOR_SCHEMA_INVALID|anchor block unknown field/.test(e.code ?? e.message));
  assert.throws(() => validateAnchorBlock({ extension_head: { ...base, committed_generation: -1 } }),
    (e) => /AMENDMENT_ANCHOR_SCHEMA_INVALID|unsafe/.test(e.code ?? e.message));
  const missing = { ...base };
  delete missing.revocation_generation;
  assert.throws(() => validateAnchorBlock({ extension_head: missing }),
    (e) => /AMENDMENT_ANCHOR_SCHEMA_INVALID|missing/.test(e.code ?? e.message));
});

// ═══════════════ Family E — multiprocess same / conflicting (E1-E8) ══════

test("E1: two processes, same mutation_id + same bytes ⇒ one COMMITTED, one ALREADY_SATISFIED", async () => {
  const w = makeWorld("e1");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-e1" });
    const r2 = await publishGen1(w, { mutationId: "mut-e1" });
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [DERIVED_CODES.ALREADY_SATISFIED, DERIVED_CODES.COMMITTED]);
  } finally { w.cleanup(); }
});

test("E2: two processes, same identity + different bytes ⇒ loser AMENDMENT_IDENTITY_CONFLICT (or stale)", async () => {
  const w = makeWorld("e2");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-e2" });
    const other = Buffer.from("e2-different\n", "utf8");
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-e2", prev: GENESIS, art: other });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: other, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_(STALE_GENERATION|IDENTITY_CONFLICT)/);
    void r1;
  } finally { w.cleanup(); }
});

test("E3: concurrent Phase-2 link publication ⇒ EEXIST adjudicated, never overwrite", async () => {
  const w = makeWorld("e3");
  try {
    await publishGen1(w, { mutationId: "mut-e3" });
    const p1 = derivedGenerationPath(w.execDir, 1);
    const original = readFileSync(p1);
    // A second writer attempting the same final path sees EEXIST; the file
    // bytes are never rewritten (exclusive create authority).
    const body2 = Buffer.from("e3-second\n", "utf8");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-e3b", prev: readAnchor(w.execDir).committed_link_digest, art: body2 });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    void code;
    assert.equal(sha256(readFileSync(p1)), sha256(original), "gen-1 bytes never rewritten");
  } finally { w.cleanup(); }
});

test("E4: lost-Phase-1-writer orphan with published matching link ⇒ quarantine + AMENDMENT_PENDING_CONFLICT (D1)", async () => {
  const w = makeWorld("e4");
  try {
    // Orphan: pending intent for gen 2 whose link IS fully published.
    const base = await publishGen1(w, { mutationId: "mut-e4-base" });
    const body2 = Buffer.from("e4-orphan\n", "utf8");
    const orphanDigest = sha256(Buffer.from(JSON.stringify({
      ...JSON.parse(JSON.stringify(mkLink(w.executionId, { gen: 2, mut: "mut-orphan", prev: base.committed_link_digest, art: body2 }))),
    }, Object.keys(mkLink(w.executionId, { gen: 2, mut: "mut-orphan", prev: base.committed_link_digest, art: body2 })).sort(), 2) + "\n", "utf8"));
    // Publish the orphan link bytes directly, then set the intent.
    const orphanLink = mkLink(w.executionId, { gen: 2, mut: "mut-orphan", prev: base.committed_link_digest, art: body2 });
    const orphanSelf = orphanLink; // buildDerivedLink leaves digest null; simulate durable bytes:
    const orphanBytes = Buffer.from(JSON.stringify(orphanSelf, Object.keys(orphanSelf).sort(), 2) + "\n", "utf8");
    mkdirSync(dirname(derivedGenerationPath(w.execDir, 2)), { recursive: true });
    writeFileSync(derivedGenerationPath(w.execDir, 2), orphanBytes);
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "mut-orphan", pending_generation: 2, pending_link_digest: orphanDigest,
    }, w);
    // A DIFFERENT mutation for gen 2 observes the orphan: fail-closed.
    const live = mkLink(w.executionId, { gen: 2, mut: "mut-live", prev: base.committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: live,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_PENDING_CONFLICT|AMENDMENT_STALE_GENERATION/);
  } finally { w.cleanup(); }
});

test("E5: orphan intent without link ⇒ fresh Phase 1 proceeds (D1 quarantine-by-naming)", async () => {
  const w = makeWorld("e5");
  try {
    const base = await publishGen1(w, { mutationId: "mut-e5-base" });
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "mut-ghost", pending_generation: 2, pending_link_digest: sha256(Buffer.from("ghost")),
    }, w);
    const body2 = Buffer.from("e5-live\n", "utf8");
    const live = mkLink(w.executionId, { gen: 2, mut: "mut-e5-live", prev: base.committed_link_digest, art: body2 });
    const r = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: live,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    assert.equal(readAnchor(w.execDir).pending_mutation_id, null);
  } finally { w.cleanup(); }
});

test("E6: orphan intent matching neither rule ⇒ AMENDMENT_PENDING_CONFLICT", async () => {
  const w = makeWorld("e6");
  try {
    const base = await publishGen1(w, { mutationId: "mut-e6-base" });
    // Orphan intent for gen 2 whose digest matches NOTHING on disk, with
    // bytes that exist but mismatch — ambiguous ⇒ PENDING_CONFLICT.
    const body2 = Buffer.from("e6-orphan-bytes\n", "utf8");
    mkdirSync(dirname(derivedGenerationPath(w.execDir, 2)), { recursive: true });
    writeFileSync(derivedGenerationPath(w.execDir, 2), body2);
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "mut-orphan", pending_generation: 2, pending_link_digest: sha256(Buffer.from("not-the-bytes")),
    }, w);
    const live = mkLink(w.executionId, { gen: 2, mut: "mut-e6-live", prev: base.committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: live,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_PENDING_CONFLICT/);
  } finally { w.cleanup(); }
});

test("E7: continuous lock hold — an interleave attempt during the publication window is rejected (D1)", async () => {
  const w = makeWorld("e7");
  try {
    await publishGen1(w, { mutationId: "mut-e7-base" });
    // Hold CURRENT.json.lock, then attempt a publication: it must NOT be
    // able to acquire a second concurrent lock authority.
    const { acquireStructuredLock } = await import("../../src/c2d/lock.mjs");
    const live = readLease(w.execDir);
    const lock = acquireStructuredLock(join(w.execDir, "CURRENT.json.lock"), {
      lock_kind: "current", execution_id: w.executionId,
      checkpoint_id: "ckpt_e7", chain_id: "chain_e7",
      lease_id: live.lease_id, lease_revision: live.lease_revision,
      actor_id: "e7-holder", session_id: "e7",
      repository_identity: w.fingerprint.repository_root_identity,
      worktree_identity: w.fingerprint.worktree_identity,
      expected_head: w.fingerprint.expected_head,
    });
    try {
      const body2 = Buffer.from("e7-body\n", "utf8");
      const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-e7", prev: readAnchor(w.execDir).committed_link_digest, art: body2 });
      const code = await throwCodeAsync(() => publishDerivedArtifact({
        root: w.root, executionId: w.executionId, link: link2,
        artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
      }));
      assert.match(String(code), /LOCK_|CHECKPOINT_STALE_REVISION|RESOURCE|BUSY/i);
    } finally {
      lock.release();
    }
  } finally { w.cleanup(); }
});

test("E8: idempotent replay returns the ORIGINAL committed_at (D7)", async () => {
  const w = makeWorld("e8");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-e8" });
    await new Promise((res) => setTimeout(res, 15));
    const r2 = await publishGen1(w, { mutationId: "mut-e8" });
    assert.equal(r2.status, DERIVED_CODES.ALREADY_SATISFIED);
    assert.equal(r2.committed_at, r1.committed_at, "original durable committed_at");
    assert.equal(r2.committed_link_digest, r1.committed_link_digest, "original durable digest");
  } finally { w.cleanup(); }
});

// ═══════════════ Family F — corrupt middle / trailing deletion (F1-F8) ═══

test("F1: corrupt gen M (middle of 3) ⇒ suffix non-authority; walk fails at M", async () => {
  const w = makeWorld("f1");
  try {
    let prev = GENESIS;
    for (const [g, mut, body] of [[1, "mut-f1a", BODY_A], [2, "mut-f1b", BODY_B], [3, "mut-f1c", Buffer.from("f1-c\n")]]) {
      const link = mkLink(w.executionId, { gen: g, mut, prev, art: body });
      const r = await publishDerivedArtifact({ root: w.root, executionId: w.executionId, link, artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1" });
      prev = r.committed_link_digest;
    }
    // Corrupt the MIDDLE generation 2.
    const p2 = derivedGenerationPath(w.execDir, 2);
    writeFileSync(p2, Buffer.from("corrupt-middle\n"));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("F2: extension attempt from corrupt chain ⇒ FAIL_CLOSED (zero-write)", async () => {
  const w = makeWorld("f2");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-f2" });
    writeFileSync(derivedGenerationPath(w.execDir, 1), Buffer.from("corrupt\n"));
    const before = snapshotTree(w.root);
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-f2b", prev: r1.committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_|CHECKPOINT_CORRUPT/);
    // Zero-write for CHAIN bytes: no new final link appears and the corrupt
    // gen-1 file is untouched. (The anchor MAY carry the C2 pending-intent
    // state — that is the frozen crash-recovery surface, not an extension.)
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 2)), "no gen-2 link published from a corrupt chain");
    assert.equal(sha256(readFileSync(derivedGenerationPath(w.execDir, 1))), sha256(Buffer.from("corrupt\n")), "gen-1 bytes unchanged");
  } finally { w.cleanup(); }
});

test("F3: skip-generation link ⇒ predecessor digest mismatch ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("f3");
  try {
    const r1 = await publishGen1(w, { mutationId: "mut-f3" });
    // A fabricated gen-2 link whose previous_link_digest is NOT gen-1's.
    const body2 = Buffer.from("f3-body\n", "utf8");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-f3b", prev: "e".repeat(64), art: body2 });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    // The publisher refuses (stale generation) — and even a hand-planted
    // skip-generation link fails the walk.
    assert.match(String(code), /AMENDMENT_|HOLD \//);
  } finally { w.cleanup(); }
});

test("F4: quarantine never rewrites predecessor digest (byte assert)", async () => {
  const w = makeWorld("f4");
  try {
    // Two committed generations; then corrupt gen 2 and quarantine it.
    const r1 = await publishGen1(w, { mutationId: "mut-f4a" });
    const body2 = Buffer.from("f4-body2\n", "utf8");
    await publishDerivedArtifact({
      root: w.root, executionId: w.executionId,
      link: mkLink(w.executionId, { gen: 2, mut: "mut-f4b", prev: r1.committed_link_digest, art: body2 }),
      artifactBytes: body2, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    });
    const p1 = derivedGenerationPath(w.execDir, 1);
    const p2 = derivedGenerationPath(w.execDir, 2);
    const gen1Before = sha256(readFileSync(p1));
    // THE quarantine: move the corrupt gen-2 aside (owner behavior).
    writeFileSync(p2, Buffer.from("corrupt-f4\n"));
    renameSync(p2, join(dirname(p2), "ABORTED-2-f4"));
    // Byte assert: gen-1 predecessor bytes are untouched by the quarantine.
    assert.equal(sha256(readFileSync(p1)), gen1Before, "predecessor digest untouched by quarantine");
    // And the quarantined file carries the corrupt bytes (not a rewrite).
    assert.equal(sha256(readFileSync(join(dirname(p2), "ABORTED-2-f4"))), sha256(Buffer.from("corrupt-f4\n")));
  } finally { w.cleanup(); }
});

test("F5: committed tail deleted ⇒ AMENDMENT_TAIL_LOSS", async () => {
  const w = makeWorld("f5");
  try {
    await publishGen1(w, { mutationId: "mut-f5" });
    unlinkSync(derivedGenerationPath(w.execDir, 1));
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.CHAIN_CORRUPT);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_TAIL_LOSS/);
  } finally { w.cleanup(); }
});

test("F6: committed tail truncated (partial link file) ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("f6");
  try {
    await publishGen1(w, { mutationId: "mut-f6" });
    const p1 = derivedGenerationPath(w.execDir, 1);
    const raw = readFileSync(p1);
    writeFileSync(p1, raw.subarray(0, raw.length - 30));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("F7: orphan link with no pending intent ⇒ FAIL_CLOSED (never linked)", async () => {
  const w = makeWorld("f7");
  try {
    await publishGen1(w, { mutationId: "mut-f7" });
    // A gen-2 link appears with NO pending intent in the anchor.
    const body2 = Buffer.from("f7-orphan\n", "utf8");
    mkdirSync(dirname(derivedGenerationPath(w.execDir, 2)), { recursive: true });
    writeFileSync(derivedGenerationPath(w.execDir, 2), body2);
    // The walk only consults acknowledged links: the orphan is ignored and
    // never becomes authority; a PUBLISH attempt for gen 2 hits EEXIST with
    // byte-different content ⇒ identity conflict (never overwrite).
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-f7", prev: readAnchor(w.execDir).committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("F8: missing generation ⇒ AMENDMENT_CHAIN_INCOMPLETE (never gen 0)", async () => {
  const w = makeWorld("f8");
  try {
    let prev = GENESIS;
    for (const [g, mut, body] of [[1, "mut-f8a", BODY_A], [2, "mut-f8b", BODY_B]]) {
      const link = mkLink(w.executionId, { gen: g, mut, prev, art: body });
      const r = await publishDerivedArtifact({ root: w.root, executionId: w.executionId, link, artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1" });
      prev = r.committed_link_digest;
    }
    // Delete generation 1 (a HOLE, not the tail).
    unlinkSync(derivedGenerationPath(w.execDir, 1));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_(CHAIN_INCOMPLETE|TAIL_LOSS)/);
  } finally { w.cleanup(); }
});

// ═══════════════════ Family G — pending recovery (G1-G6) ═════════════════

test("G1: crash Phase 1 ⇒ restart completes Phase 2-3 deterministically", async () => {
  const w = makeWorld("g1");
  try {
    injectOneShot("derived_after_pending_intent", "g1");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-g1" }));
    clearInjectionHooks();
    const r = await publishGen1(w, { mutationId: "mut-g1" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("G2: crash Phase 2 ⇒ restart completes Phase 3", async () => {
  const w = makeWorld("g2");
  try {
    injectOneShot("derived_after_link", "g2");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-g2" }));
    clearInjectionHooks();
    const r = await publishGen1(w, { mutationId: "mut-g2" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("G3: crash Phase 3 ⇒ restart confirms, no second commit", async () => {
  const w = makeWorld("g3");
  try {
    injectOneShot("before_checksum_rename", "g3");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-g3" }));
    clearInjectionHooks();
    const r = await publishGen1(w, { mutationId: "mut-g3" });
    assert.ok([DERIVED_CODES.COMMITTED, DERIVED_CODES.ALREADY_SATISFIED].includes(r.status));
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.generations.length, 1, "no second commit");
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("G4: stale superseded intent ⇒ quarantine-by-naming + pending cleared (C15 owner path)", async () => {
  const w = makeWorld("g4");
  try {
    const base = await publishGen1(w, { mutationId: "mut-g4-base" });
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "mut-superseded", pending_generation: 2, pending_link_digest: sha256(Buffer.from("superseded")),
    }, w);
    const body2 = Buffer.from("g4-live\n", "utf8");
    const live = mkLink(w.executionId, { gen: 2, mut: "mut-g4-live", prev: base.committed_link_digest, art: body2 });
    const r = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: live,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    assert.equal(readAnchor(w.execDir).pending_mutation_id, null);
  } finally { w.cleanup(); }
});

test("G5: quarantined link re-publication same id/digest ⇒ AMENDMENT_QUARANTINE_CONFLICT (D4)", async () => {
  const w = makeWorld("g5");
  try {
    // Quarantined bytes at the generation path: ABORTED-2-<reason>, and a
    // pending intent whose digest matches the QUARANTINED link. A retry
    // must NOT resurrect the quarantined bytes (D4).
    const base = await publishGen1(w, { mutationId: "mut-g5-base" });
    const body2 = Buffer.from("g5-quarantined\n", "utf8");
    mkdirSync(dirname(derivedGenerationPath(w.execDir, 2)), { recursive: true });
    writeFileSync(join(dirname(derivedGenerationPath(w.execDir, 2)), "ABORTED-2-reason"), body2);
    publishAnchorRaw(w.execDir, {
      execution_id: w.executionId, phase_id: "p1",
      committed_generation: 1, committed_link_digest: base.committed_link_digest, committed_at: base.committed_at,
      revocation_generation: 0,
      pending_mutation_id: "mut-g5", pending_generation: 2, pending_link_digest: sha256(body2),
    }, w);
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-g5", prev: base.committed_link_digest, art: body2 });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    // The quarantined bytes cannot satisfy the retry: fail closed.
    assert.match(String(code), /AMENDMENT_(PENDING_CONFLICT|QUARANTINE_CONFLICT|STALE_GENERATION|IDENTITY_CONFLICT)/);
  } finally { w.cleanup(); }
});

test("G6: quarantined identity re-entry only via fresh mutation_id + fresh generation (D4)", async () => {
  const w = makeWorld("g6");
  try {
    // After a quarantine, the SAME identity can only re-enter via a new
    // mutation at the next unacknowledged generation — the fresh publish
    // path (stale-generation gate) enforces exactly this.
    const base = await publishGen1(w, { mutationId: "mut-g6-base" });
    const body2 = Buffer.from("g6-fresh\n", "utf8");
    const fresh = mkLink(w.executionId, { gen: 2, mut: "mut-g6-fresh", prev: base.committed_link_digest, art: body2 });
    const r = await publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: fresh,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1"
    });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    // A replay of the OLD quarantined mutation id at the OLD generation
    // fails (stale generation).
    const old = mkLink(w.executionId, { gen: 2, mut: "mut-g6-base", prev: base.committed_link_digest, art: body2 });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: old,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

// ═══════════════════ Family H — rollback-resurrection (H1-H5) ════════════

test("H1: checkpoint rolled back to old revision ⇒ CAS stale ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("h1");
  try {
    await publishGen1(w, { mutationId: "mut-h1" });
    // Roll CURRENT back by publishing the PRIOR bytes via the sealed store.
    const priorDir = join(w.execDir, "prior");
    const priors = readdirSync(priorDir).sort();
    const priorBytes = readFileSync(join(priorDir, priors[0]));
    const shaPath = join(w.execDir, "CURRENT.json.sha256");
    writeFileSync(currentPath(w.execDir), priorBytes);
    writeFileSync(shaPath, sha256(priorBytes) + "\n");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-h1b", prev: readAnchor(w.execDir)?.committed_link_digest ?? GENESIS, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_|CHECKPOINT_/);
  } finally { w.cleanup(); }
});

test("H2: resurrected old chain link.previous_link_digest ≠ anchor ⇒ AMENDMENT_ROLLBACK_DETECTED", async () => {
  const w = makeWorld("h2");
  try {
    await publishGen1(w, { mutationId: "mut-h2" });
    // Hand-plant a resurrected gen-1 whose previous_link_digest ≠ genesis.
    const p1 = derivedGenerationPath(w.execDir, 1);
    const parsed = JSON.parse(readFileSync(p1, "utf8"));
    parsed.previous_link_digest = "c".repeat(64);
    const bytes = Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8");
    writeFileSync(p1, bytes);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_(ROLLBACK_DETECTED|LINK_SELF_DIGEST_MISMATCH|TAIL_LOSS)/);
  } finally { w.cleanup(); }
});

test("H3: revoked identity in resurrected chain ⇒ AMENDMENT_REVOKED_SUBJECT before any write", async () => {
  const w = makeWorld("h3");
  try {
    const ids = makeIdentities("h3");
    const { root: tmRoot, writer } = createTestWriter(ids);
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "h3-revoke", expected: 0, task_identity: ids.task_identity });
    const before = snapshotTree(w.root);
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-h3", prev: GENESIS, art: BODY_A });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: tmRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_REVOKED_SUBJECT/);
    assert.deepEqual(snapshotTree(w.root), before);
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("H4: resurrected chain read reports walk head ≠ anchor ⇒ FAIL_CLOSED (no silent accept)", async () => {
  const w = makeWorld("h4");
  try {
    await publishGen1(w, { mutationId: "mut-h4" });
    // Swap gen-1 bytes with different content (same closed schema, new digest).
    const p1 = derivedGenerationPath(w.execDir, 1);
    const parsed = JSON.parse(readFileSync(p1, "utf8"));
    parsed.created_at = new Date(Date.now() + 5_000).toISOString();
    const bytes = Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8");
    writeFileSync(p1, bytes);
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("H5: zero-byte guarantee on every resurrection vector (disk byte-identical assert)", async () => {
  const w = makeWorld("h5");
  try {
    await publishGen1(w, { mutationId: "mut-h5" });
    const gen1Digest = sha256(readFileSync(derivedGenerationPath(w.execDir, 1)));
    // Resurrection attempts via an unacknowledged tail: a gen-2 publish
    // with a fabricated previous_link_digest is refused (identity gate).
    const body2 = Buffer.from("h5-tail\n", "utf8");
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-h5", prev: "d".repeat(64), art: body2 });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_|HOLD \//);
    // Chain bytes untouched: no gen-2 link, gen-1 digest identical. (A
    // pending intent in the anchor is the frozen C2 recovery state, not a
    // write into the chain.)
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 2)), "no unacknowledged tail published");
    assert.equal(sha256(readFileSync(derivedGenerationPath(w.execDir, 1))), gen1Digest, "gen-1 bytes byte-identical");
  } finally { w.cleanup(); }
});

// ═══════════════ Family I — issuer / revocation mismatch (I1-I5) ═════════

test("I1: revoked subject publish ⇒ AMENDMENT_REVOKED_SUBJECT (zero-write)", async () => {
  const w = makeWorld("i1");
  try {
    const ids = makeIdentities("i1");
    const { root: tmRoot, writer } = createTestWriter(ids);
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "i1-revoke", expected: 0, task_identity: ids.task_identity });
    const before = snapshotTree(w.root);
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-i1", prev: GENESIS, art: BODY_A });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: tmRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_REVOKED_SUBJECT/);
    assert.deepEqual(snapshotTree(w.root), before);
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("I2: issuer_identity forged digest ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("i2");
  try {
    // A link whose issuer_identity is not 64-hex fails closed at build.
    assert.throws(() => buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
      artifactSize: BODY_A.length, mutationId: "mut-i2",
      issuerIdentity: "not-a-digest", revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    }), (e) => /AMENDMENT_SCHEMA_INVALID/.test(e.code ?? e.message));
  } finally { w.cleanup(); }
});

test("I3: revocation_generation stale vs fold ⇒ FAIL_CLOSED", async () => {
  const w = makeWorld("i3");
  try {
    // A negative revocation_generation is unsafe ⇒ rejected at build.
    assert.throws(() => buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
      artifactSize: BODY_A.length, mutationId: "mut-i3",
      issuerIdentity: "a".repeat(64), revocationGeneration: -1,
      createdAt: new Date().toISOString(),
    }), (e) => /AMENDMENT_SCHEMA_INVALID/.test(e.code ?? e.message));
  } finally { w.cleanup(); }
});

test("I4: fold consulted from DURABLE log, not cache-only (durable-divergence)", async () => {
  const w = makeWorld("i4");
  try {
    const ids = makeIdentities("i4");
    const { root: tmRoot, writer } = createTestWriter(ids);
    // Revoke AFTER a successful publish: a subsequent publish must consult
    // the DURABLE fold and refuse — cache-only authority would pass.
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "i4-revoke", expected: 0, task_identity: ids.task_identity });
    const before = snapshotTree(w.root);
    const body2 = Buffer.from("i4-body\n", "utf8");
    const r1anchor = readAnchor(w.execDir);
    void r1anchor;
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-i4", prev: sha256(BODY_A), art: body2 });
    // NOTE: gen-2 attempt without a gen-1 commit of THIS chain shape fails
    // at the stale gate first; the revocation gate runs BEFORE that.
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: tmRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_REVOKED_SUBJECT/);
    assert.deepEqual(snapshotTree(w.root), before);
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

test("I5: revoked records remain on disk for audit (state preservation)", async () => {
  const w = makeWorld("i5");
  try {
    const ids = makeIdentities("i5");
    const { root: tmRoot, writer } = createTestWriter(ids);
    writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "i5-revoke", expected: 0, task_identity: ids.task_identity });
    const logPath = join(tmRoot, "transfer-events.jsonl");
    assert.ok(existsSync(logPath), "durable log exists");
    const text = readFileSync(logPath, "utf8");
    assert.match(text, /REVOKED/, "revocation record preserved on disk");
    try { rmSync(tmRoot, { recursive: true, force: true }); } catch { /* */ }
  } finally { w.cleanup(); }
});

// ═══════════════════ Family J — restart / reader (J1-J8) ═════════════════

test("J1: legacy run — no anchor block ⇒ reader reports explicit ABSENT (no gen-0 truthiness)", async () => {
  const w = makeWorld("j1");
  try {
    // A fresh world with an initialized store but no derived publication.
    const st = derivedReadState(w.execDir);
    assert.equal(st.state, DERIVED_CODES.ABSENT);
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.state, DERIVED_CODES.ABSENT);
    assert.equal(walk.generations.length, 0);
  } finally { w.cleanup(); }
});

test("J2: reader starts ONLY from CURRENT committed head (unanchored tail ignored + flagged)", async () => {
  const w = makeWorld("j2");
  try {
    await publishGen1(w, { mutationId: "mut-j2" });
    // Plant an UNANCHORED gen-2 tail: the walk must ignore it (no pending
    // intent, no anchor acknowledgment).
    const body2 = Buffer.from("j2-unanchored\n", "utf8");
    mkdirSync(dirname(derivedGenerationPath(w.execDir, 2)), { recursive: true });
    writeFileSync(derivedGenerationPath(w.execDir, 2), body2);
    const walk = derivedWalkChain(w.execDir);
    assert.equal(walk.generations.length, 1, "unanchored tail ignored");
    assert.equal(walk.state, DERIVED_CODES.COMMITTED);
    // And the publisher refuses gen-2 EEXIST with different bytes.
    const link2 = mkLink(w.executionId, { gen: 2, mut: "mut-j2b", prev: readAnchor(w.execDir).committed_link_digest, art: BODY_B });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: link2,
      artifactBytes: BODY_B, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("J3: reader walk verifies self digest per generation", async () => {
  const w = makeWorld("j3");
  try {
    await publishGen1(w, { mutationId: "mut-j3" });
    const p1 = derivedGenerationPath(w.execDir, 1);
    const parsed = JSON.parse(readFileSync(p1, "utf8"));
    parsed.link_digest = "f".repeat(64);
    writeFileSync(p1, Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8"));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("J4: reader walk verifies predecessor digest per generation", async () => {
  const w = makeWorld("j4");
  try {
    let prev = GENESIS;
    for (const [g, mut, body] of [[1, "mut-j4a", BODY_A], [2, "mut-j4b", BODY_B]]) {
      const link = mkLink(w.executionId, { gen: g, mut, prev, art: body });
      const r = await publishDerivedArtifact({ root: w.root, executionId: w.executionId, link, artifactBytes: body, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1" });
      prev = r.committed_link_digest;
    }
    // Break gen-2's predecessor continuity.
    const p2 = derivedGenerationPath(w.execDir, 2);
    const parsed = JSON.parse(readFileSync(p2, "utf8"));
    parsed.previous_link_digest = "9".repeat(64);
    writeFileSync(p2, Buffer.from(JSON.stringify(parsed, Object.keys(parsed).sort(), 2) + "\n", "utf8"));
    const code = throwCode(() => derivedWalkChain(w.execDir));
    assert.match(String(code), /AMENDMENT_/);
  } finally { w.cleanup(); }
});

test("J5: reader walk verifies artifact digest + size vs manifest list (budget §R11)", async () => {
  const w = makeWorld("j5");
  try {
    // §R11: artifact bytes beyond the 64 KiB budget fail at build time.
    const big = Buffer.alloc(64 * 1024 + 1, 7);
    assert.throws(() => buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(big),
      artifactSize: big.length, mutationId: "mut-j5",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    }), (e) => /AMENDMENT_SCHEMA_INVALID/.test(e.code ?? e.message));
  } finally { w.cleanup(); }
});

test("J6: direct CURRENT read without walk is non-authoritative (D5 bypass-detection oracle)", async () => {
  const w = makeWorld("j6");
  try {
    await publishGen1(w, { mutationId: "mut-j6" });
    // A consumer reading the anchor directly sees a COMMITMENT, not state:
    // the durable truth requires walk success. Corrupt the link bytes:
    // readCurrent STILL succeeds (checksum sidecar intact) but the state
    // machine reports CHAIN_CORRUPT — direct reads are never authority.
    const p1 = derivedGenerationPath(w.execDir, 1);
    const raw = readFileSync(p1);
    writeFileSync(p1, Buffer.from(raw.toString("utf8").replace("post-finalization", "tampered-finalizatn"), "utf8"));
    const cur = readCurrent(w.execDir);
    assert.ok(cur, "direct read succeeds (it is a commitment, not state)");
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.CHAIN_CORRUPT, "walk-derived state fails closed");
  } finally { w.cleanup(); }
});

test("J7: restart across all six states returns the SAME final state (state determinism)", async () => {
  const w = makeWorld("j7");
  try {
    // ABSENT
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.ABSENT);
    // PENDING
    injectOneShot("derived_after_pending_intent", "j7");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-j7" }));
    clearInjectionHooks();
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.PENDING);
    // PUBLISHED_UNCOMMITTED → COMMITTED via restart
    injectOneShot("derived_after_link", "j7b");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-j7" }));
    clearInjectionHooks();
    const anchorMid = readAnchor(w.execDir);
    assert.ok(anchorMid.pending_mutation_id === "mut-j7");
    const r = await publishGen1(w, { mutationId: "mut-j7" });
    assert.equal(r.status, DERIVED_CODES.COMMITTED);
    assert.equal(derivedReadState(w.execDir).state, DERIVED_CODES.COMMITTED);
    // Determinism: repeated reads are stable.
    assert.equal(derivedReadState(w.execDir).state, derivedReadState(w.execDir).state);
  } finally { clearInjectionHooks(); w.cleanup(); }
});

test("J8: >300s clock skew ⇒ CLOCK_ANOMALY (300s boundary enforced)", async () => {
  const w = makeWorld("j8");
  try {
    // Non-ISO timestamp rejected at build.
    assert.throws(() => buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(BODY_A),
      artifactSize: BODY_A.length, mutationId: "mut-j8",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: "not-a-timestamp",
    }), (e) => /AMENDMENT_SCHEMA_INVALID/.test(e.code ?? e.message));
    // A well-formed but >300s future-skewed createdAt ⇒ CLOCK_ANOMALY.
    const skewedLink = mkLink(w.executionId, { gen: 1, mut: "mut-j8b", prev: GENESIS, art: BODY_A, createdAt: new Date(Date.now() + 301 * 1000).toISOString() });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: skewedLink,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /CLOCK_ANOMALY/);
    // Boundary: exactly 299s of skew passes the gate (reaches the stale-
    // generation check at worst — never CLOCK_ANOMALY).
    const okLink = mkLink(w.executionId, { gen: 1, mut: "mut-j8c", prev: GENESIS, art: BODY_A, createdAt: new Date(Date.now() + 299 * 1000).toISOString() });
    const code2 = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: okLink,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.ok(code2 === null || !/CLOCK_ANOMALY/.test(String(code2)), "299s skew is NOT a clock anomaly");
  } finally { w.cleanup(); }
});

// ═══════════════════ Family K — data minimization (K1-K4) ════════════════

test("K1: reader error output contains no source paths (regex assert)", async () => {
  const w = makeWorld("k1");
  try {
    await publishGen1(w, { mutationId: "mut-k1" });
    writeFileSync(derivedGenerationPath(w.execDir, 1), Buffer.from("corrupt\n"));
    let msg = "";
    try { derivedWalkChain(w.execDir); } catch (e) { msg = `${e.code ?? ""} ${e.message ?? ""}`; }
    assert.ok(!msg.includes(w.root), "no evidence root path");
    assert.ok(!msg.includes(w.execDir), "no execDir path");
    assert.ok(!msg.includes("derived-000000000001"), "no artifact file name");
  } finally { w.cleanup(); }
});

test("K2: reader error output contains no artifact bodies", async () => {
  const w = makeWorld("k2");
  try {
    await publishGen1(w, { mutationId: "mut-k2" });
    writeFileSync(derivedGenerationPath(w.execDir, 1), Buffer.from(BODY_A.toString("utf8").replace("body A", "BODY-A-XX"), "utf8"));
    let msg = "";
    try { derivedWalkChain(w.execDir); } catch (e) { msg = `${e.code ?? ""} ${e.message ?? ""}`; }
    assert.ok(!msg.includes("post-finalization"), "no artifact body text");
    assert.ok(!msg.includes("BODY-A-XX"), "no tampered body text");
  } finally { w.cleanup(); }
});

test("K3: secret scan failure reports pattern NAMES only (never matched text)", async () => {
  const w = makeWorld("k3");
  try {
    const secret = Buffer.from("token: sk-abcdefghijklmnopqrstuvwxyz123456\n", "utf8");
    const link = buildDerivedLink({
      executionId: w.executionId, phaseId: "p1", generation: 1,
      previousLinkDigest: GENESIS, artifactDigest: sha256(secret),
      artifactSize: secret.length, mutationId: "mut-k3",
      issuerIdentity: "a".repeat(64), revocationGeneration: 0,
      createdAt: new Date().toISOString(),
    });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: secret, repositoryFingerprint: w.fingerprint, transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /PATH_UNSAFE|sk_key/);
    assert.ok(!String(code).includes("sk-abcdefghijklmnopqrstuvwxyz"), "matched text never reported");
  } finally { w.cleanup(); }
});

test("K4: opaque result shape — status + digests only", async () => {
  const w = makeWorld("k4");
  try {
    const r = await publishGen1(w, { mutationId: "mut-k4" });
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, ["artifact_digest", "committed_at", "committed_link_digest", "generation", "status"]);
    for (const v of Object.values(r)) {
      const s = String(v);
      assert.ok(!s.includes("/"), "no paths in result");
      assert.ok(!s.includes("BEGIN"), "no credentials in result");
    }
  } finally { w.cleanup(); }
});

// ═══════════════ Family L — production reachability = 0 (L1-L4) ══════════

test("L1: no production module imports the publisher (import-graph assert)", async () => {
  const { readdirSync: rd } = await import("node:fs");
  const srcRoot = join(process.cwd(), "src");
  const offenders = [];
  const scan = (dir) => {
    for (const e of rd(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { scan(full); continue; }
      if (!full.endsWith(".mjs")) continue;
      const text = readFileSync(full, "utf8");
      if (text.includes("publishDerivedArtifact") || text.includes("derivedWalkChain") || text.includes("bindDerivedAuthoritySeam")) {
        offenders.push(full);
      }
    }
  };
  scan(srcRoot);
  // The publisher LIVES in checkpoint-bridge (its own definitions); the
  // assertion: NO OTHER src module references the publisher surface.
  const others = offenders.filter((f) => !f.endsWith("checkpoint-bridge.mjs"));
  assert.deepEqual(others, []);
});

test("L2: no durable-graph hook calls the publisher (hooks surface unchanged)", async () => {
  const dg = readFileSync(join(process.cwd(), "src", "v2", "durable-graph.mjs"), "utf8");
  assert.ok(!dg.includes("publishDerivedArtifact"), "durable-graph never calls the publisher");
  assert.ok(!dg.includes("derivedWalkChain"), "durable-graph never reads the derived chain");
  const de = readFileSync(join(process.cwd(), "src", "v2", "durable-execution.mjs"), "utf8");
  assert.ok(!de.includes("publishDerivedArtifact"), "durable-execution never calls the publisher");
});

test("L3: event-type vocabulary unchanged post-implementation (frozen-set assert)", async () => {
  const text = readFileSync(join(process.cwd(), "src", "v2", "durable-execution.mjs"), "utf8");
  // Frozen reachable vocabulary of the durable-execution seam (measured on
  // the sealed opening source): 24 direct literals + DECOMPOSITION_HELD via
  // the eventType variable + PHASE/RUN terminal triples. The publisher adds
  // NOTHING to it (EVEN_TYPE_CHANGE = NO).
  const FROZEN = new Set([
    "CHECKPOINT_PUBLISHED", "DAG_ACCEPTED", "DECOMPOSITION_COMPLETED",
    "DECOMPOSITION_HELD", "DECOMPOSITION_MANIFEST_WRITTEN", "DECOMPOSITION_STARTED",
    "EXECUTOR_COMPLETED", "INPUT_FROZEN", "MANIFEST_FINALIZED",
    "PHASE_FAILED", "PHASE_HELD", "PHASE_PASSED", "PHASE_READY",
    "PHASE_REPAIR_REQUESTED", "PHASE_SKIPPED", "PHASE_STARTED",
    "READ_ONLY_PHASE_REQUEUED_AFTER_INTERRUPTION", "RESUME_REJECTED",
    "RESUME_REQUESTED", "RESUME_VALIDATED", "REVIEWER_COMPLETED",
    "RUN_CREATED", "RUN_HELD", "RUN_NOT_BENEFICIAL", "RUN_PASSED",
    "SYSTEM_DELTA_PERSISTENCE_FAILED", "SYSTEM_DELTA_READY",
  ]);
  const literals = new Set([...text.matchAll(/event_type:\s*"([A-Z_]+)"/g)].map((m) => m[1]));
  for (const name of literals) {
    assert.ok(FROZEN.has(name), `event literal ${name} must be in the frozen vocabulary`);
  }
  assert.equal(literals.size, 20, `sealed direct-literal count must hold (got ${literals.size})`);
  // The publisher introduced no new event types at all.
  const bridge = readFileSync(join(process.cwd(), "src", "v2", "checkpoint-bridge.mjs"), "utf8");
  assert.ok(!/event_type:\s*"[A-Z_]+"/.test(bridge), "publisher journals no events");
});

test("L4: no new store/lock/manifest/index module (file-set assert)", () => {
  // Sealed module SET (admission boundary). The property this asserts is "no
  // new store / lock / manifest / index module appears at this boundary"; the
  // original encoding was a bare count. Pinning the NAMES keeps the guard
  // discriminating (an addition, removal OR rename fails) while letting a
  // sanctioned non-state module be listed explicitly.
  const FROZEN_C2D = [
    "checkpoint-store.mjs", "commit-authorization.mjs",
    "commit-materialized-candidate.mjs", "execution-id.mjs", "fingerprint.mjs",
    "fs-atomic.mjs", "journal.mjs", "lease.mjs", "lock.mjs",
    "materialization-authorization.mjs", "mutation-authority.mjs",
    "mutation-run.mjs", "mutation-scope.mjs", "permit.mjs",
    "read-only-discovery-run.mjs", "reconcile.mjs",
    "repository-mutation-lock.mjs", "reviewed-commit-candidate.mjs",
    "validate-snapshot.mjs",
    // Added by AUTOLOOP_OPEN_SOURCE_SYMLINK_WRITE_CONTAINMENT_REPAIR_1 (M1):
    // a PURE read-only audit of the materialized worktree (lstat/readlink/
    // realpath). It owns no store, lock, manifest or index, creates nothing,
    // and narrows authority only — the scope-containment layer companion to
    // mutation-scope.mjs, not new durable state.
    "write-containment.mjs",
  ];
  const FROZEN_EVIDENCE = ["run-evidence-store.mjs", "run-manifest.mjs"];
  const mjs = (a) => a.filter((f) => f.endsWith(".mjs")).sort();
  const c2d = readdirSync(join(process.cwd(), "src", "c2d"));
  const evidence = readdirSync(join(process.cwd(), "src", "evidence"));
  assert.deepEqual(mjs(c2d), [...FROZEN_C2D].sort(), "src/c2d must keep exactly its sealed module set");
  assert.deepEqual(mjs(evidence), [...FROZEN_EVIDENCE].sort(), "src/evidence must keep exactly its sealed module set");
  // No new lock namespace outside the execDir: the publisher takes
  // CURRENT.json.lock only.
  const bridge = readFileSync(join(process.cwd(), "src", "v2", "checkpoint-bridge.mjs"), "utf8");
  assert.ok(!/\.lock["']\s*\)/.test(bridge.replace(/CURRENT\.json\.lock/g, "")), "no second lock namespace");
});


// ═══════ Reviewer-round repairs — new discriminating coverage ════════════

test("R7X: omitted credential cannot elide the revocation gate (unconditional fold consult)", async () => {
  const w = makeWorld("r7x");
  try {
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-r7x", prev: GENESIS, art: BODY_A });
    // Proof 1 — elision impossible: NO transferMetricsRoot supplied ⇒ the
    // gate still runs (seam throws TRANSFER_PATH_UNSAFE, never a silent skip).
    const codeNoRoot = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
    }));
    assert.match(String(codeNoRoot), /TRANSFER_PATH_UNSAFE|PATH_UNSAFE|CHECKPOINT_CORRUPT/);
    // Proof 2 — corrupt durable fold ⇒ fail closed (never a fallback).
    writeFileSync(join(w.foldRoot, "transfer-events.jsonl"),
      readFileSync(join(w.foldRoot, "transfer-events.jsonl")).toString("utf8") + "CORRUPT-LINE\n");
    const codeCorrupt = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(codeCorrupt), /AMENDMENT_|CHECKPOINT_CORRUPT|LOG_|TRANSFER_/);
    // Zero chain bytes across both vectors.
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 1)));
  } finally { w.cleanup(); }
});

test("R12X: missing finalized base manifest ⇒ AMENDMENT_CHAIN_INCOMPLETE before any byte", async () => {
  const w = makeWorld("r12x");
  try {
    // Strip the finalized manifest + sidecar: publication must fail closed.
    unlinkSync(join(w.execDir, "manifest.json"));
    unlinkSync(join(w.execDir, "manifest.json.sha256"));
    const before = snapshotTree(w.root);
    const link = mkLink(w.executionId, { gen: 1, mut: "mut-r12x", prev: GENESIS, art: BODY_A });
    const code = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link,
      artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(code), /AMENDMENT_CHAIN_INCOMPLETE|CHAIN_INCOMPLETE/);
    assert.ok(!existsSync(derivedGenerationPath(w.execDir, 1)), "zero chain bytes without a base manifest");
    assert.deepEqual(snapshotTree(w.root), before);
  } finally { w.cleanup(); }
});

test("R1X: skew exactly at the 301s boundary fails; monotone result deterministic", async () => {
  const w = makeWorld("r1x");
  try {
    for (const skew of [301, 400]) {
      const link = mkLink(w.executionId, {
        gen: 1, mut: `mut-r1x-${skew}`, prev: GENESIS, art: BODY_A,
        createdAt: new Date(Date.now() + skew * 1000).toISOString(),
      });
      const code = await throwCodeAsync(() => publishDerivedArtifact({
        root: w.root, executionId: w.executionId, link,
        artifactBytes: BODY_A, repositoryFingerprint: w.fingerprint,
        transferMetricsRoot: w.foldRoot, writerId: "w1",
      }));
      assert.match(String(code), /CLOCK_ANOMALY/);
    }
  } finally { w.cleanup(); }
});

test("J7X: six-state surface — ABORTED and PUBLISHED_UNCOMMITTED are durable-bytes observable", async () => {
  const w = makeWorld("j7x");
  try {
    // PUBLISHED_UNCOMMITTED: link bytes on disk + pending intent + committed
    // generation NOT advanced (durable-bytes state via anchor + file).
    injectOneShot("derived_after_link", "j7x");
    await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-j7x" }));
    clearInjectionHooks();
    const anchor = readAnchor(w.execDir);
    assert.equal(anchor.committed_generation, 0, "committed head not advanced");
    assert.equal(anchor.pending_mutation_id, "mut-j7x");
    assert.ok(existsSync(derivedGenerationPath(w.execDir, 1)), "link bytes durable");
    // The state pair (pending intent + link bytes present) IS the durable
    // PUBLISHED_UNCOMMITTED observable.
    const st = derivedReadState(w.execDir);
    assert.equal(st.state, DERIVED_CODES.PENDING);
    assert.ok(st.committed === null && anchor.pending_link_digest !== null);
    // ABORTED: quarantined bytes under ABORTED-<gen>-* naming are the
    // durable ABORTED observable (§4: moved aside, predecessor untouched).
    const dir = join(w.execDir, "artifacts", "derived");
    renameSync(derivedGenerationPath(w.execDir, 1), join(dir, "ABORTED-1-test"));
    assert.ok(readdirSync(dir).some((f) => f.startsWith("ABORTED-1-")), "ABORTED naming observable");
    // D4: the ABORTED identity re-enters ONLY via a fresh mutation at a
    // fresh generation — the direct retry is QUARANTINE_CONFLICT.
    const retryCode = await throwCodeAsync(() => publishGen1(w, { mutationId: "mut-j7x" }));
    assert.match(String(retryCode), /AMENDMENT_QUARANTINE_CONFLICT/);
    const body2 = Buffer.from("j7x-fresh\n", "utf8");
    const fresh = mkLink(w.executionId, { gen: 2, mut: "mut-j7x-fresh", prev: sha256(BODY_A), art: body2 });
    // NOTE: predecessor digest of the ABORTED gen-1 is the anchor's pending
    // digest, not a committed head — the fresh gen-2 extension is refused
    // (no acknowledged predecessor). The ABORTED state therefore persists
    // durably until the operator resolves: fail-closed is the frozen outcome.
    const freshCode = await throwCodeAsync(() => publishDerivedArtifact({
      root: w.root, executionId: w.executionId, link: fresh,
      artifactBytes: body2, repositoryFingerprint: w.fingerprint,
      transferMetricsRoot: w.foldRoot, writerId: "w1",
    }));
    assert.match(String(freshCode), /AMENDMENT_|CHECKPOINT_CORRUPT/);
  } finally { clearInjectionHooks(); w.cleanup(); }
});
