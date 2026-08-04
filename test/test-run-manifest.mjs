// test/test-run-manifest.mjs
//
// C3 — final run manifest tests（idempotent finalize, conflict, hash）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRunManifest, finalizeRunManifest, readRunManifest, ManifestHoldError, manifestPath, manifestShaPath } from "../src/evidence/run-manifest.mjs";
import { sha256Text } from "../src/evidence/run-evidence-store.mjs";

function baseManifest() {
  return buildRunManifest({
    executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    chainId: "chain_bbbbbbbbbbbbbbbbbbbbbbbb",
    created_at: "2026-08-03T00:00:00.000Z",
    final_verdict: "PASS",
    final_reason: null,
    input_fingerprint: "i".repeat(64),
    configuration_fingerprint: "c".repeat(64),
    repository_fingerprint: { expected_head: "0".repeat(40) },
    decomposition_ir_sha256: "d".repeat(64),
    dag_sha256: "e".repeat(64),
    journal_event_count: 12,
    journal_head_sha256: "f".repeat(64),
    checkpoint_revision: 11,
    checkpoint_sha256: "g".repeat(64),
    phase_results: [{ phase_id: "p1", result_hash: "h".repeat(64) }],
    artifact_inventory: [],
    secret_scan_result: { scanned: true, matches: [] },
    format_versions: { evidence: "1.0.0", journal: "1.0.0", manifest: "1.0.0", checkpoint: "1.0.0" },
  });
}

test("27: final manifest hash is recomputable", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-mf-"));
  try {
    const { execDir, manifest } = createManifest(root);
    const onDisk = readRunManifest(execDir);
    assert.deepEqual(onDisk, manifest);
    const body = readFileSync(manifestPath(execDir), "utf8");
    assert.equal(sha256Text(body), readFileSync(manifestShaPath(execDir), "utf8").trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("28: repeated finalize with identical content is idempotent", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-mf2-"));
  try {
    const { execDir, manifest, sha } = createManifest(root);
    const again = finalizeRunManifest(execDir, manifest);
    assert.equal(again.mode, "replayed");
    assert.equal(again.sha256, sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("29: finalize with different content is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-mf3-"));
  try {
    const { execDir } = createManifest(root);
    const other = buildRunManifest({
      executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: "chain_bbbbbbbbbbbbbbbbbbbbbbbb",
      created_at: "2026-08-03T00:00:00.000Z",
      final_verdict: "HOLD", // different verdict → different content
      final_reason: "tampered",
      input_fingerprint: "i".repeat(64),
      configuration_fingerprint: "c".repeat(64),
      repository_fingerprint: {},
      decomposition_ir_sha256: "d".repeat(64),
      dag_sha256: "e".repeat(64),
      journal_event_count: 12,
      journal_head_sha256: "f".repeat(64),
      checkpoint_revision: 11,
      checkpoint_sha256: "g".repeat(64),
      phase_results: [],
      artifact_inventory: [],
      secret_scan_result: {},
      format_versions: {},
    });
    assert.throws(() => finalizeRunManifest(execDir, other), (e) => e instanceof ManifestHoldError && e.code === "MANIFEST_FINALIZE_CONFLICT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createManifest(root) {
  const execDir = join(root, "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const manifest = baseManifest();
  const finalized = finalizeRunManifest(execDir, manifest);
  return { execDir, manifest, sha: finalized.sha256 };
}
