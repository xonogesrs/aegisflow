#!/usr/bin/env node
// scripts/gov-execution-review.mjs
//
// RSL2 — Domain A execution-review surface CLI（LATEST_EXECUTION_REVIEW）.
//
// The fixed human-facing entrypoint for the most recent formal execution's
// review:
//   <review surface>/Latest/review.txt
// Historical execution reviews rotate into:
//   <review surface>/Latest/archive/
// This surface is INDEPENDENT of the external-review inbox
//（the review surface + archive）— a pending external review
// never blocks an execution review, and this CLI never touches the inbox.
//
// Env overrides（tests / CI isolation）: AUTOLOOP_EXECUTION_REVIEW_SURFACE,
// AUTOLOOP_EXECUTION_REVIEW_ARCHIVE.
//
//   --publish <source.json> [--repo <path>] [--surface <dir>] [--archive <dir>]
//       Validate + render + secret-scan + rotate previous Latest + atomically
//       publish the execution review to Latest/review.txt; rereads + recomputes
//       the content hash and verifies the identity. Prints identity/sha/path/
//       archived. Exit 0 iff published（fail-closed otherwise）.
//
//   --status [--surface <dir>]
//       Print the current Latest state（present / execution / card / identity /
//       sha）.
//
//   --verify [--surface <dir>] [--expected-identity <hex>]
//       [--expected-sha <hex>] [--expected-execution <id>] [--expected-card <id>]
//       Reread + recompute the published artifact. Exit 0 iff verified.
//
// Local-only, deterministic, no network. Never commits/pushes/seals.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  EXECUTION_REVIEW_SOURCE_SCHEMA,
  latestReviewDir,
  latestReviewArchiveDir,
  publishExecutionReview,
  verifyLatestExecutionReview,
  latestExecutionReviewStatus,
} from "../src/governance/execution-review.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  return process.argv[idx + 1];
}

const mode = process.argv.includes("--publish") ? "publish"
  : process.argv.includes("--status") ? "status"
    : process.argv.includes("--verify") ? "verify" : null;

if (!mode) {
  console.error("usage:");
  console.error("  node scripts/gov-execution-review.mjs --publish <source.json> [--repo <path>] [--surface <dir>] [--archive <dir>]");
  console.error("  node scripts/gov-execution-review.mjs --status [--surface <dir>]");
  console.error("  node scripts/gov-execution-review.mjs --verify [--surface <dir>] [--expected-identity <hex>] [--expected-sha <hex>]");
  process.exit(2);
}

if (mode === "publish") {
  const sourcePath = arg("--publish", null);
  const repoPath = arg("--repo", null);
  const surfaceDir = arg("--surface", null);
  const archiveDir = arg("--archive", null);
  if (!sourcePath || !existsSync(sourcePath)) {
    console.error(`source_missing: ${sourcePath ?? "(none)"}`);
    process.exit(2);
  }
  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (e) {
    console.error(`cannot_read_source: ${String(e?.message ?? e).slice(0, 200)}`);
    process.exit(2);
  }
  if (source.schema !== EXECUTION_REVIEW_SOURCE_SCHEMA) {
    console.error(`schema_mismatch: ${source.schema} (expected ${EXECUTION_REVIEW_SOURCE_SCHEMA})`);
    process.exit(2);
  }
  const r = publishExecutionReview(source, {
    surfaceDir: surfaceDir ?? null,
    archiveDir: archiveDir ?? null,
    repoPath,
  });
  const surface = surfaceDir ?? latestReviewDir();
  const archive = archiveDir ?? latestReviewArchiveDir();
  console.log(`surface=${surface}`);
  console.log(`archive=${archive}`);
  if (!r.ok) {
    console.error(`publish_failed holdCode=${r.holdCode}`);
    console.error(`reason: ${r.reason}`);
    process.exit(1);
  }
  console.log(`published=${r.idempotent ? "idempotent" : "true"} path=${r.path}`);
  console.log(`reviewExecutionIdentity: ${r.identity}`);
  console.log(`reviewExecutionSha256: ${r.sha256}`);
  if (r.previousIdentity) console.log(`previousIdentity: ${r.previousIdentity}`);
  if (r.archivedPath) console.log(`archived: ${r.archivedPath}`);
  process.exit(0);
}

if (mode === "status") {
  const surfaceDir = arg("--surface", null);
  const s = latestExecutionReviewStatus({ surfaceDir: surfaceDir ?? null });
  console.log(`surface=${s.path}`);
  if (!s.present) {
    console.log("files: (none)");
    process.exit(0);
  }
  console.log("files: review.txt");
  console.log(`executionId: ${s.executionId ?? "?"}`);
  console.log(`cardId: ${s.cardId ?? "?"}`);
  console.log(`outcome: ${s.outcome ?? "?"}`);
  console.log(`reviewExecutionIdentity: ${s.identity ?? "?"}`);
  console.log(`reviewExecutionSha256: ${s.sha256 ?? "?"}`);
  process.exit(0);
}

if (mode === "verify") {
  const surfaceDir = arg("--surface", null);
  const expected = {
    identity: arg("--expected-identity", null),
    sha256: arg("--expected-sha", null),
    executionId: arg("--expected-execution", null),
    cardId: arg("--expected-card", null),
  };
  const v = verifyLatestExecutionReview({ surfaceDir: surfaceDir ?? null, expected });
  console.log(`valid=${v.ok} path=${v.path}`);
  for (const e of v.errors ?? []) console.log(`  error: ${e}`);
  if (v.parsed) {
    console.log(`executionId: ${v.parsed.executionId ?? "?"}`);
    console.log(`cardId: ${v.parsed.cardId ?? "?"}`);
    console.log(`reviewExecutionIdentity: ${v.parsed.identity ?? "?"}`);
    console.log(`reviewExecutionSha256: ${v.parsed.sha256 ?? "?"}`);
  }
  process.exit(v.ok ? 0 : 1);
}
