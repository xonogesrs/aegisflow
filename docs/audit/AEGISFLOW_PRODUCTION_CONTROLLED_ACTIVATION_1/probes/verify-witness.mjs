#!/usr/bin/env node
// Independent MAC recomputation over a retained witness bundle.
//
// The evidence JSON deliberately does NOT publish the ledger key, so a reviewer
// cannot recompute an HMAC from it. This script takes the retained bundle
// (ledger.jsonl + ledger.key + witness.json, mode 0700, outside the repository)
// and recomputes the commit MAC with the DEPLOYED verifier, so the claim
// "the commit is authenticated" becomes something a reviewer checks rather than
// something a harness asserts.
//
//   node verify-witness.mjs <witness-dir> [--json]
//
// Exit 0 = every retained record that claims a MAC verifies AND exactly one
// commit matches the retained identity.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const asJson = process.argv.includes("--json");
if (!dir) {
  console.error("usage: node verify-witness.mjs <witness-dir> [--json]");
  process.exit(2);
}

const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const { verifyLedgerRecord } = await import(`${DEPLOYED}/lib/ledger-auth.mjs`);

const sha256 = buf => createHash("sha256").update(buf).digest("hex");
const ledgerBytes = readFileSync(join(dir, "ledger.jsonl"));
const key = readFileSync(join(dir, "ledger.key"), "utf8").trim();
const witness = JSON.parse(readFileSync(join(dir, "witness.json"), "utf8"));
const records = ledgerBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));

const identity = witness.boundIdentity;
const commits = records.filter(r => r.type === "commit");
const matching = commits.filter(r =>
  r.sessionId === identity.sessionId &&
  r.runtimeInstanceId === identity.runtimeInstanceId &&
  r.generation === identity.generation);

const verified = records.filter(r => typeof r.mac === "string").map(r => ({
  type: r.type,
  requestId: r.requestId ?? null,
  macVerified: verifyLedgerRecord(key, r) === true,
}));

const result = {
  witnessDir: dir,
  ledgerSha256: sha256(ledgerBytes),
  ledgerSha256Recorded: witness.ledgerSha256,
  ledgerIntegrityMatches: sha256(ledgerBytes) === witness.ledgerSha256,
  // The harness digests the TRIMMED key, so the verifier must too. Hashing
  // `${key}\n` here produced a spurious mismatch on the first run.
  keySha256: sha256(key),
  keySha256Recorded: witness.ledgerKeySha256,
  keyIntegrityMatches: sha256(key) === witness.ledgerKeySha256,
  verifierModule: `${DEPLOYED}/lib/ledger-auth.mjs`,
  recordTypes: records.map(r => r.type),
  macBearingRecords: verified,
  allMacsVerify: verified.length > 0 && verified.every(v => v.macVerified),
  commitRecords: commits.length,
  matchingIdentity: matching.length,
  controllerResultMatchesIdentity:
    witness.controllerResultFrame?.sessionId === identity.sessionId &&
    witness.controllerResultFrame?.runtimeInstanceId === identity.runtimeInstanceId &&
    witness.controllerResultFrame?.generation === identity.generation &&
    witness.controllerResultFrame?.committed === true,
};

result.ok = result.ledgerIntegrityMatches && result.keyIntegrityMatches &&
  result.allMacsVerify && result.commitRecords === 1 &&
  result.matchingIdentity === 1 && result.controllerResultMatchesIdentity;

if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
else {
  console.log(`WITNESS = ${result.ok ? "VERIFIED" : "FAILED"}`);
  for (const [k, v] of Object.entries(result)) if (k !== "ok" && k !== "macBearingRecords") console.log(`  ${k} = ${JSON.stringify(v)}`);
  for (const v of result.macBearingRecords) console.log(`  record ${v.type}/${v.requestId}: macVerified=${v.macVerified}`);
}
process.exitCode = result.ok ? 0 : 1;
