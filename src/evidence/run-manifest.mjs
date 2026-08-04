// src/evidence/run-manifest.mjs
//
// C3 — AutoLoop final run manifest.
//
// Terminal artifact pinning every durable artifact of a run. Written
// atomically with an external .sha256 sidecar. Never overwritten; repeated
// finalize with identical content is idempotent success, different content
// is a fail-closed HOLD.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  C2dHoldError, HOLD, sha256Hex, writeExclusiveCreate, assertNotSymlink,
} from "../c2d/fs-atomic.mjs";
import { canonicalJson, sha256Text } from "./run-evidence-store.mjs";

export const MANIFEST_FORMAT_VERSION = "1.0.0";
export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SHA_FILE = "manifest.json.sha256";
export const FINAL_REPORT_FILE = "final-report.json";

export class ManifestHoldError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.name = "ManifestHoldError";
  }
}

export function manifestPath(execDir) {
  return join(execDir, MANIFEST_FILE);
}
export function manifestShaPath(execDir) {
  return join(execDir, MANIFEST_SHA_FILE);
}
export function finalReportPath(execDir) {
  return join(execDir, FINAL_REPORT_FILE);
}

/**
 * Build the final manifest object（bounded; no secrets; no raw reasoning）.
 */
export function buildRunManifest({
  executionId,
  chainId,
  created_at,
  completed_at,
  final_verdict,
  final_reason,
  input_fingerprint,
  configuration_fingerprint,
  repository_fingerprint,
  decomposition_ir_sha256,
  dag_sha256,
  journal_event_count,
  journal_head_sha256,
  checkpoint_revision,
  checkpoint_sha256,
  phase_results,
  artifact_inventory,
  secret_scan_result,
  format_versions,
}) {
  return {
    format_version: MANIFEST_FORMAT_VERSION,
    execution_id: executionId,
    chain_id: chainId,
    created_at,
    completed_at: completed_at || new Date().toISOString(),
    final_verdict,
    final_reason: final_reason ?? null,
    input_fingerprint,
    configuration_fingerprint,
    repository_fingerprint,
    decomposition_ir_sha256,
    dag_sha256,
    journal_event_count,
    journal_head_sha256,
    checkpoint_revision,
    checkpoint_sha256,
    phase_results: phase_results || [],
    artifact_inventory: artifact_inventory || [],
    artifact_sha256: null, // set by the caller when known（inventory digest）
    excluded_files: ["journal/*.tmp.*", "*.lock", "lease.json", "CURRENT.json.lock", "*.sha256.tmp.*"],
    secret_scan_result: secret_scan_result || { scanned: true, matches: [] },
    format_versions: format_versions || {},
  };
}

/**
 * Finalize the manifest once. Idempotent for identical content; conflict for
 * different content; verifies the .sha256 sidecar on subsequent calls.
 *
 * @param {string} execDir
 * @param {object} manifest
 * @returns {{manifest: object, sha256: string, mode: "created"|"replayed"}}
 */
export function finalizeRunManifest(execDir, manifest) {
  const path = manifestPath(execDir);
  const shaPath = manifestShaPath(execDir);
  const body = canonicalJson(manifest) + "\n";
  const digest = sha256Text(body);

  if (existsSync(path)) {
    assertNotSymlink(path);
    assertNotSymlink(shaPath);
    const existingBytes = readFileSync(path);
    const existingSha = readFileSync(shaPath, "utf8").trim();
    if (sha256Hex(existingBytes) !== existingSha || !/^[0-9a-f]{64}$/.test(existingSha)) {
      throw new ManifestHoldError("MANIFEST_SHA_MISMATCH", "existing manifest sha256 sidecar does not match content");
    }
    if (sha256Hex(existingBytes) === digest && existingSha === digest) {
      return { manifest, sha256: digest, mode: "replayed" };
    }
    throw new ManifestHoldError("MANIFEST_FINALIZE_CONFLICT", "manifest already finalized with different content");
  }

  // Atomic exclusive create（never overwrites）.
  try {
    writeExclusiveCreate(path, body);
    writeExclusiveCreate(shaPath, digest + "\n");
  } catch (e) {
    if (e instanceof C2dHoldError && e.code === HOLD.JOURNAL_OUT_OF_ORDER) {
      // Lost the create race: another process finalized first — verify.
      return finalizeRunManifest(execDir, manifest);
    }
    throw e;
  }
  return { manifest, sha256: digest, mode: "created" };
}

/**
 * Read a finalized manifest（verifies sidecar）.
 * @returns {object|null} null when not yet finalized.
 */
export function readRunManifest(execDir) {
  const path = manifestPath(execDir);
  if (!existsSync(path)) return null;
  assertNotSymlink(path);
  assertNotSymlink(manifestShaPath(execDir));
  const bytes = readFileSync(path);
  const sha = readFileSync(manifestShaPath(execDir), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(sha) || sha256Hex(bytes) !== sha) {
    throw new ManifestHoldError("MANIFEST_SHA_MISMATCH", "manifest sha256 sidecar mismatch");
  }
  return JSON.parse(bytes.toString("utf8"));
}

/**
 * Write the bounded final report（never a substitute for the manifest）.
 */
export function writeFinalReport(execDir, report) {
  const path = finalReportPath(execDir);
  const body = canonicalJson(report) + "\n";
  writeExclusiveCreate(path, body);
  return { path, sha256: sha256Text(body) };
}
