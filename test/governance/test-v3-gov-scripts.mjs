// test/governance/test-v3-gov-scripts.mjs
//
// AUTOLOOP-REVART-LC1-B2 — mandatory acceptance T3: lifecycle-authorization
// /v3 + closeout_metadata must flow through the REAL governance script
// validators (not just direct module tests).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { makeGitRepo, projectBinding } from "./review-lifecycle-fixture.mjs";

function plantArchive(bundleDir, cardId) {
  // prepare-round derives prior_bundle_sha256 from the latest archived bundle
  // file containing the card id; bundleDigestFromFile always yields a valid
  // sha256 of the file content.
  const archiveDir = join(bundleDir, "archive");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, `prior-${cardId}.txt`), "PRIOR BUNDLE CONTENT\n", "utf8");
}

const cleanups = [];
test.after(() => {
  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

const HERE = resolve(import.meta.dirname ?? process.cwd(), "..", "..");

function v3Record(repo, { asV2 = false } = {}) {
  const { record } = projectBinding(repo);
  const rec = JSON.parse(JSON.stringify(record));
  // Consistent repair caps (both finite and equal) so the round-5
  // repair-cap conflict check passes through the script.
  rec.lifecycle_authorization.bounded_repair.max_rounds = 1;
  rec.lifecycle_authorization.review_unit.maximum_repair_rounds = 1;
  if (asV2) {
    rec.schema = "autoloop.lifecycle-authorization/v2";
    delete rec.closeout_metadata;
  }
  return rec;
}

test("T3: lifecycle-authorization/v3 + closeout_metadata accepted by gov-controller-prepare-round (real script validator)", () => {
  const repo = makeGitRepo("t3v3"); cleanups.push(repo);
  const record = v3Record(repo);
  const dir = mkdtempSync(join(tmpdir(), "revart-b2-t3-")); cleanups.push(dir);
  const authorityFile = join(dir, "authority-v3.json");
  writeFileSync(authorityFile, JSON.stringify(record, null, 2));
  const findingsFile = join(dir, "findings.json");
  writeFileSync(findingsFile, JSON.stringify([{ finding: "none" }]));
  const bundleDir = join(dir, "review");
  plantArchive(bundleDir, record.card_id);

  const out = execFileSync("node", [
    "scripts/gov-controller-prepare-round.mjs",
    "--authority-file", authorityFile,
    "--card-id", record.card_id,
    "--findings-file", findingsFile,
    "--bundle-dir", bundleDir,
    "--review-round", "1",
    "--repair-round", "0",
  ], { cwd: HERE, encoding: "utf8" });
  assert.ok(out.includes("effective_repair_cap"), out.slice(0, 300));
});

test("T3: v2 record (no closeout_metadata) still accepted by the same script (backward compat)", () => {
  const repo = makeGitRepo("t3v2"); cleanups.push(repo);
  const record = v3Record(repo, { asV2: true });
  const dir = mkdtempSync(join(tmpdir(), "revart-b2-t3v2-")); cleanups.push(dir);
  const authorityFile = join(dir, "authority-v2.json");
  writeFileSync(authorityFile, JSON.stringify(record, null, 2));
  const findingsFile = join(dir, "findings.json");
  writeFileSync(findingsFile, JSON.stringify([{ finding: "none" }]));
  const bundleDir = join(dir, "review");
  plantArchive(bundleDir, record.card_id);

  const out = execFileSync("node", [
    "scripts/gov-controller-prepare-round.mjs",
    "--authority-file", authorityFile,
    "--card-id", record.card_id,
    "--findings-file", findingsFile,
    "--bundle-dir", bundleDir,
    "--review-round", "1",
    "--repair-round", "0",
  ], { cwd: HERE, encoding: "utf8" });
  assert.ok(out.includes("effective_repair_cap"), out.slice(0, 300));
});

test("T3: v3 record flows through gov-effective-authority (parent ∩ child ∩ runtime)", () => {
  const repo = makeGitRepo("t3eff"); cleanups.push(repo);
  const record = v3Record(repo);
  const dir = mkdtempSync(join(tmpdir(), "revart-b2-t3eff-")); cleanups.push(dir);
  const authorityFile = join(dir, "authority-v3.json");
  writeFileSync(authorityFile, JSON.stringify(record, null, 2));
  // runtime must be a valid authority block/record — use the same v3 record.
  const runtimeFile = join(dir, "runtime.json");
  writeFileSync(runtimeFile, JSON.stringify(record, null, 2));

  const out = execFileSync("node", [
    "scripts/gov-effective-authority.mjs",
    "--parent", authorityFile,
    "--child", authorityFile,
    "--runtime", runtimeFile,
  ], { cwd: HERE, encoding: "utf8" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.effective?.review_unit?.allowed, true, "v3 block capabilities participate in effective authority");
});
