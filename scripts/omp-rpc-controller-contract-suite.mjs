#!/usr/bin/env node
// scripts/omp-rpc-controller-contract-suite.mjs
//
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — runs every
// real-transport case and asserts the card's acceptance facts.
//
//   node scripts/omp-rpc-controller-contract-suite.mjs [--json]
//
// Each case is a separate `omp --mode rpc` child driven by
// omp-rpc-controller-contract-probe.mjs. This file only decides PASS/FAIL from
// the observed record: no fact is assumed, and a missing field is a failure, not
// a skip.
//
// Exit: 0 all acceptance facts hold, 1 a fact failed, 2 a case could not run.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = join(REPO_ROOT, "scripts", "omp-rpc-controller-contract-probe.mjs");
const SCRATCH_ROOT = process.env.AEGIS_RPC_PROBE_ROOT || join(process.env.TMPDIR || "/tmp", "aegis-controller-contract");
const EVIDENCE = join(SCRATCH_ROOT, "evidence");

const CASES = ["commit", "resume", "no-ui", "concurrent", "injection", "no-authority"];

function runCase(name) {
  const result = spawnSync(process.execPath, [PROBE, name, "--json"], { encoding: "utf8", timeout: 180_000 });
  const path = join(EVIDENCE, `${name}.json`);
  const record = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  return { name, exit: result.status, stdout: result.stdout, stderr: result.stderr, record };
}

const facts = [];
function fact(name, ok, detail) {
  facts.push({ name, ok: Boolean(ok), detail });
}

const runs = {};
for (const name of CASES) {
  const run = runCase(name);
  runs[name] = run;
  if (run.exit !== 0 || !run.record) {
    fact(`${name}:RAN`, false, { exit: run.exit, stderr: run.stderr?.slice(0, 400) });
  }
}

const { commit, resume, "no-ui": noUi, concurrent, injection, "no-authority": noAuthority } = runs;

// ── isolation ───────────────────────────────────────────────────────────────
// The probe's own claim is "never write outside its own scratch root". That was
// false while children inherited the operator's HOME; every case now reports the
// HOME it ran under, so the claim is measured rather than asserted.
for (const [name, run] of Object.entries(runs)) {
  if (!run.record) continue;
  const iso = run.record.homeIsolation;
  fact(`${name}:private-home`, iso?.isolated === true, iso ?? "NO_EVIDENCE");
}

// ── R1 ──────────────────────────────────────────────────────────────────────
if (commit?.record) {
  const record = commit.record;
  fact("R1:identity-is-composite", Boolean(record.identity?.sessionId && record.identity?.runtimeInstanceId && record.identity?.generation), record.identity);
  fact("R1:identity-durable", record.firstFrame?.result?.identityState === "ALLOCATED", record.firstFrame?.result?.identityState);
  fact("R1:ledger-written", record.ledgerFilePresent === true, record.ledgerFilePresent);
  // The pinned second result must be CRYPTOGRAPHICALLY verified, not merely
  // self-describing. Measured in review: with request `probe-2` signed by the
  // wrong key, the probe recorded `secondVerified: MAC_MISMATCH` and this suite
  // still reported PASS, because it read only `targetVerified` off the frame.
  fact("R1:pinned-target-verified", record.secondVerified?.ok === true, record.secondVerified?.reason ?? null);
  fact("R1:pinned-generation-honored", record.secondFrame?.result?.generation === (record.firstFrame?.result?.generation ?? -1) + 1, {
    first: record.firstFrame?.result?.generation,
    second: record.secondFrame?.result?.generation,
  });
}
if (resume?.record) {
  const record = resume.record;
  // Resume claims are gated on the recorded cryptographic verdicts, not on the
  // probe's own booleans: a frame that fails verification proves nothing about
  // cross-process identity.
  const resumeVerified = record.first?.verified?.ok === true && record.second?.verified?.ok === true;
  fact("R1:resume-frames-verified", resumeVerified, {
    first: record.first?.verified?.reason ?? null,
    second: record.second?.verified?.reason ?? null,
  });
  fact("R1:same-session-id", resumeVerified && record.sameSessionId === true, record.sameSessionId);
  fact("R1:distinct-runtime-across-resume", resumeVerified && record.distinctRuntime === true, record.distinctRuntime);
  fact("R1:generation-advances-across-resume", resumeVerified && record.generationAdvanced === true, {
    first: record.first?.generation,
    second: record.second?.generation,
  });
  fact("R1:cross-process-target-refused", record.crossProcessTargetRefused === "TARGET_RUNTIME_MISMATCH", record.crossProcessTargetRefused);
}

// ── R2 ──────────────────────────────────────────────────────────────────────
if (commit?.record) {
  const record = commit.record;
  fact("R2:result-frame-signed-and-verified", record.firstVerified?.ok === true, record.firstVerified?.reason ?? null);
  fact("R2:command-vs-commit-distinguished", record.firstFrame?.result?.commandAccepted === true && record.firstFrame?.result?.commitExecuted === true, {
    commandAccepted: record.firstFrame?.result?.commandAccepted,
    commitExecuted: record.firstFrame?.result?.commitExecuted,
  });
  fact("R2:committed-is-extension-truth", record.firstFrame?.result?.committed === true && record.logAgrees === true, {
    committed: record.firstFrame?.result?.committed,
    logAgrees: record.logAgrees,
  });
  fact("R2:rpc-response-is-not-the-result", record.rpcResponseCarriesCommit === false, record.rpcResponseShape);
  fact("R2:key-not-left-on-disk", record.keyFileUnlinked === true, record.keyFileUnlinked);
}
if (noUi?.record) {
  const record = noUi.record;
  fact("R2:result-survives-no-ui", record.resultFrameAvailable === true && record.notifyAvailable === false, {
    resultFrame: record.resultFrameAvailable,
    notify: record.notifyAvailable,
  });
  fact("R2:no-ui-result-verifies", record.verdict?.ok === true, record.verdict?.reason ?? null);
}
if (commit?.record) {
  // Delivery invalidation is a separate outcome from the terminal transition, and
  // `suppressed` cannot express it (it counts queued deliveries, normally 0).
  fact(
    "R2:delivery-invalidation-reported",
    commit.record.firstFrame?.result?.deliveryFenceSucceeded === true &&
      commit.record.firstFrame?.result?.deliveryFenceError === null,
    {
      deliveryFenceSucceeded: commit.record.firstFrame?.result?.deliveryFenceSucceeded,
      deliveryFenceError: commit.record.firstFrame?.result?.deliveryFenceError,
    },
  );
}
if (noAuthority?.record) {
  const record = noAuthority.record;
  fact("R2:denial-observable", record.denial === "CONTROLLER_AUTHORITY_ABSENT" && record.verdict?.ok === true, record.denial);
  fact("R2:denial-claims-no-commit", record.committed === false && record.commitExecuted === false, {
    committed: record.committed,
    commitExecuted: record.commitExecuted,
  });
  fact("R2:denied-commit-writes-no-ledger", record.ledgerWritten === false, record.ledgerWritten);
}

// ── R5 ──────────────────────────────────────────────────────────────────────
if (commit?.record) {
  fact("R5:request-id-echoed", commit.record.firstFrame?.requestId === "probe-1", commit.record.firstFrame?.requestId);
}
if (concurrent?.record) {
  const record = concurrent.record;
  fact("R5:every-answer-attributed", record.acceptedCount === record.sentRequestIds.length, {
    accepted: record.acceptedCount,
    sent: record.sentRequestIds.length,
  });
  fact("R5:no-request-left-pending", record.pendingAfter?.length === 0, record.pendingAfter);
  fact("R5:generations-distinct-and-monotonic", record.generationsDistinct === true && record.generationsMonotonic === true, record.generations);
}
if (injection?.record) {
  const record = injection.record;
  fact("R5:forged-frame-visible-on-wire", record.injectedFrameVisibleOnWire === true, record.injectedFrameVisibleOnWire);
  fact("R5:forged-frame-refused", record.injectedVerdict?.ok === false, record.injectedVerdict);
  fact("R5:genuine-frame-still-accepted", record.genuineVerdict?.ok === true, record.genuineVerdict);
}

const ok = facts.every((entry) => entry.ok);
const report = {
  card: "AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1",
  cases: Object.fromEntries(CASES.map((name) => [name, { exit: runs[name]?.exit ?? null }])),
  facts,
  failed: facts.filter((entry) => !entry.ok),
  ok,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("CONTROLLER_RPC_CONTRACT_SUITE");
  for (const entry of facts) {
    console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}  ${entry.ok ? "" : JSON.stringify(entry.detail)}`);
  }
  console.log(`CONTROLLER_RPC_CONTRACT_SUITE=${ok ? "PASS" : "FAIL"} facts=${facts.length}`);
}

process.exit(ok ? 0 : 1);
