#!/usr/bin/env node
// scripts/pi-rpc-usage-probe.mjs
//
// AUTOLOOP-V1-P3-U1 — bounded usage-source reachability probe.
//
// P3-U1's job is to restore the sanctioned Pi execution seam and prove that
// the authoritative structured usage source is reachable on the SAME real
// execution wire — NOT to wire token telemetry into AutoLoop (that remains
// the original P3 phase, after this unblock).
//
// This probe reuses the exact adapter spawn contract
// (src/adapter/pi-rpc-adapter.mjs buildArgs + DEFAULT_ENV_ALLOWLIST:
// PATH/HOME/TMPDIR/LANG/LC_ALL/TERM — no API key in the child env) and
// records the raw JSONL protocol stream to a file, so the usage fields
// carried by the current protocol generation are observed at the source
// rather than invented by this harness (N6: no fake usage injection).
//
// It is self-guarded behind ALLOW_REAL_PI_USAGE_PROBE so an accidental
// `node --test` or CI glob can never trigger a real model invocation.
//
// Exit codes: 0 = usage source reachable and observed; 1 = probe failure.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const ALLOWED_ENV = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM"];

if (!process.env.ALLOW_REAL_PI_USAGE_PROBE) {
  console.log("SKIPPED: set ALLOW_REAL_PI_USAGE_PROBE=1 to run the real Pi usage-source probe.");
  process.exit(0);
}

const PROMPT = "Reply with exactly USAGE_PROBE_OK and do not add any other text.";
const ARGS = [
  "--mode", "rpc",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--provider", "deepseek",
  "--model", "deepseek-v4-flash",
];

function buildChildEnv() {
  const env = {};
  for (const key of ALLOWED_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const evidenceDir = mkdtempSync(join(tmpdir(), "autoloop-pi-usage-probe-"));
  const rawLogPath = join(evidenceDir, "raw-protocol.jsonl");
  const cwd = mkdtempSync(join(tmpdir(), "autoloop-pi-usage-cwd-"));

  const child = spawn("pi", ARGS, { cwd, env: buildChildEnv(), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const startedAt = Date.now();
  let raw = "";
  let stderrBuf = "";
  let finalText = null;
  let sawAgentSettled = false;
  let sawResponse = false;
  let exitedEarly = null;

  const usageSamples = [];
  const eventTypeCounts = new Map();
  const completion = new Promise((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      raw += chunk;
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue; // partial line boundary; not counted
        }
        const etype = evt.type || "unknown";
        eventTypeCounts.set(etype, (eventTypeCounts.get(etype) || 0) + 1);
        if (evt.type === "message_update" && evt.usage && typeof evt.usage === "object") {
          usageSamples.push({ event: "message_update", usage: evt.usage });
        }
        if (evt.type === "message_end" && evt.message && evt.message.usage && typeof evt.message.usage === "object") {
          usageSamples.push({ event: "message_end", usage: evt.message.usage });
        }
        if (evt.type === "agent_settled") {
          sawAgentSettled = true;
          try {
            child.stdin.write(JSON.stringify({ id: "final-text", type: "get_last_assistant_text" }) + "\n");
          } catch { /* child gone */ }
        }
        if (evt.type === "response" && evt.command === "get_last_assistant_text") {
          sawResponse = true;
          finalText = (evt.data && evt.data.text) ?? "";
          resolve();
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    child.on("error", (err) => {
      exitedEarly = `spawn_error: ${err.message}`;
      resolve();
    });
    child.on("exit", (code, signal) => {
      if (!sawResponse) {
        exitedEarly = `process_exit_before_response: code=${code} signal=${signal}`;
        resolve();
      }
    });
    try {
      child.stdin.write(JSON.stringify({ type: "prompt", message: PROMPT }) + "\n");
    } catch { /* child gone */ }
  });

  const done = await Promise.race([
    completion,
    new Promise((resolve) => setTimeout(() => resolve("probe-timeout"), 60000)),
  ]);
  if (done === "probe-timeout") {
    exitedEarly = "probe-timeout";
  }

  // Bounded termination, mirroring the adapter (grace 1000ms, then group kill).
  try { child.stdin.end(); } catch { /* best-effort */ }
  await new Promise((r) => setTimeout(r, 1000));
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* best-effort */ } }
  }
  const elapsedMs = Date.now() - startedAt;

  writeFileSync(rawLogPath, raw);
  writeFileSync(join(evidenceDir, "raw-protocol.sha256"), sha256(raw) + "\n");
  writeFileSync(join(evidenceDir, "probe-request.json"), JSON.stringify({
    executor: "pi",
    executablePath: process.env.PATH ? "resolved via PATH" : null,
    args: ARGS,
    envAllowlist: ALLOWED_ENV,
    prompt: PROMPT,
    timeoutMs: 60000,
  }, null, 2));

  // Dedupe usage samples: message_update carries cumulative usage; keep last.
  const lastUsage = usageSamples.length > 0 ? usageSamples[usageSamples.length - 1] : null;

  const report = {
    executor: { name: "pi", binary: "pi (PATH)", version: null }, // version resolved below
    request: { prompt: PROMPT, provider: "deepseek", model: "deepseek-v4-flash" },
    protocol: {
      generation: "pi-coding-agent JSONL RPC (--mode rpc)",
      eventTypeCounts: Object.fromEntries(eventTypeCounts),
      sawAgentSettled,
      sawGetLastAssistantTextResponse: sawResponse,
    },
    completion: {
      terminalText: (finalText || "").trim(),
      elapsedMs,
      earlyFailure: exitedEarly,
    },
    usage: {
      USAGE_PRESENT: lastUsage !== null,
      USAGE_SOURCE: lastUsage ? `protocol event "${lastUsage.event}" .usage (pi-ai Usage, authoritative AssistantMessage.usage source)` : null,
      STRUCTURED: lastUsage ? typeof lastUsage.usage === "object" : false,
      AUTHORITATIVE: lastUsage !== null,
      FIELDS_PRESENT: lastUsage
        ? Object.keys(lastUsage.usage).filter((k) => lastUsage.usage[k] !== undefined).sort()
        : [],
      cost_present: lastUsage ? typeof lastUsage.usage.cost === "object" && lastUsage.usage.cost !== null : false,
      reasoning_present: lastUsage ? lastUsage.usage.reasoning !== undefined : false,
      samples: usageSamples,
      sample_count: usageSamples.length,
    },
  };

  // Resolve pi version from the same restricted env.
  try {
    const { execFileSync } = await import("node:child_process");
    report.executor.version = execFileSync("pi", ["--version"], { env: buildChildEnv() }).toString().trim();
  } catch {
    report.executor.version = "unresolved";
  }

  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence dir: ${evidenceDir}`);

  if (exitedEarly) {
    console.error(`PROBE FAILED: ${exitedEarly}`);
    process.exit(1);
  }
  if (!lastUsage) {
    console.error("PROBE FAILED: no usage observed on the protocol wire");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:");
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
