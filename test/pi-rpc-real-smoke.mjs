#!/usr/bin/env node
// pi-rpc-real-smoke.mjs
//
// The ONE authorized real-Pi-prompt smoke test for
// AUTOLOOP_PI_RPC_ADAPTER_BY_CLAUDE. Not part of `node --test` discovery
// semantics for any other script in this repo, and self-guards behind
// ALLOW_REAL_PI_SMOKE so an accidental `node --test test/` glob (or a
// future CI job) can never trigger a real Pi invocation by surprise.
//
// This script calls adapter.runAdapter() exactly once. There is no retry
// loop anywhere in this file, by design: ADAPTER_REAL_PI_PROMPT_COUNT for
// one execution of this script is structurally <= 1. §16.5 requires that a
// first failure HOLD rather than retry -- this script exits nonzero and
// prints HOLD on any failure; it never calls runAdapter() a second time.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { createPiRpcAdapter, DEFAULT_ENV_ALLOWLIST } from "../src/adapter/pi-rpc-adapter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

if (!process.env.ALLOW_REAL_PI_SMOKE) {
  console.log("SKIPPED: set ALLOW_REAL_PI_SMOKE=1 to run the one authorized real Pi RPC smoke test.");
  process.exit(0);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inventory(dir) {
  const out = {};
  function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        out[p] = { size: st.size, mode: st.mode, sha256: sha256File(p) };
      }
    }
  }
  if (existsSync(dir)) walk(dir);
  return out;
}

function sessionDirInventory() {
  const dir = join(homedir(), ".pi", "agent", "sessions");
  if (!existsSync(dir)) return [];
  const out = [];
  function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  }
  walk(dir);
  return out;
}

async function main() {
  const evidenceDir = mkdtempSync(join(tmpdir(), "autoloop-pi-smoke-evidence-"));
  const tempCwd = mkdtempSync(join(tmpdir(), "autoloop-pi-smoke-cwd-"));
  console.log(`Evidence dir: ${evidenceDir}`);
  console.log(`Temp cwd: ${tempCwd}`);

  const sessionsBefore = sessionDirInventory();
  const cwdBefore = inventory(tempCwd);

  const PROMPT = "Return exactly AUTOLOOP_PI_RPC_SMOKE_OK and do not add any other text.";

  const adapter = createPiRpcAdapter({
    piExecutable: "pi",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    environmentAllowlist: DEFAULT_ENV_ALLOWLIST, // PATH, HOME, TMPDIR, LANG, LC_ALL, TERM -- no API key copied
    graceMs: 1000,
  });

  const executionId = `pi-rpc-real-smoke-${Date.now()}`;
  console.log("Invoking the ONE authorized real Pi RPC prompt now...");
  const result = await adapter.runAdapter({
    executionId,
    cwd: tempCwd,
    taskCard: PROMPT,
    phase: "executor",
    attempt: 0,
    timeoutMs: 60000,
  });
  console.log("ADAPTER_REAL_PI_PROMPT_COUNT = 1 (this script never retries)");

  const sessionsAfter = sessionDirInventory();
  const cwdAfter = inventory(tempCwd);

  const sessionDiff = {
    added: sessionsAfter.filter((p) => !sessionsBefore.includes(p)),
    removed: sessionsBefore.filter((p) => !sessionsAfter.includes(p)),
  };
  const cwdMutations = Object.keys({ ...cwdBefore, ...cwdAfter }).filter(
    (p) => JSON.stringify(cwdBefore[p]) !== JSON.stringify(cwdAfter[p]),
  );

  const trimmedStdout = (result.stdout || "").trim();
  const expectedText = "AUTOLOOP_PI_RPC_SMOKE_OK";

  const checks = {
    status_completed: result.status === "completed",
    output_exact: trimmedStdout === expectedText,
    zero_tool_calls: result.metadata.toolCallCount === 0,
    no_new_sessions: sessionDiff.added.length === 0,
    no_removed_sessions: sessionDiff.removed.length === 0,
    zero_cwd_mutations: cwdMutations.length === 0,
  };
  const allPassed = Object.values(checks).every(Boolean);

  writeFileSync(join(evidenceDir, "normalized-result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(evidenceDir, "session-diff.json"), JSON.stringify(sessionDiff, null, 2));
  writeFileSync(join(evidenceDir, "cwd-inventory-before.json"), JSON.stringify(cwdBefore, null, 2));
  writeFileSync(join(evidenceDir, "cwd-inventory-after.json"), JSON.stringify(cwdAfter, null, 2));
  writeFileSync(join(evidenceDir, "checks.json"), JSON.stringify(checks, null, 2));

  rmSync(tempCwd, { recursive: true, force: true });

  console.log("=== Checks ===");
  for (const [k, v] of Object.entries(checks)) console.log(`${k}: ${v ? "PASS" : "FAIL"}`);
  console.log(`Assistant output (trimmed): ${JSON.stringify(trimmedStdout)}`);
  console.log(`Terminal reason: ${result.metadata.terminalReason}`);
  console.log(`Tool call count: ${result.metadata.toolCallCount}`);
  console.log(`Session diff: +${sessionDiff.added.length} / -${sessionDiff.removed.length}`);
  console.log(`Temp cwd mutations: ${cwdMutations.length}`);
  console.log(`Evidence written to: ${evidenceDir}`);

  if (!allPassed) {
    console.log("HOLD / AUTOLOOP_PI_REAL_SMOKE_GATE_BLOCKED");
    console.log("First real-smoke attempt failed one or more checks. This script does not retry.");
    process.exit(1);
  }
  console.log("PASS / AUTOLOOP_PI_RPC_SMOKE_OK_CONFIRMED");
}

main().catch((e) => {
  console.error("HOLD / AUTOLOOP_PI_REAL_SMOKE_GATE_BLOCKED");
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
