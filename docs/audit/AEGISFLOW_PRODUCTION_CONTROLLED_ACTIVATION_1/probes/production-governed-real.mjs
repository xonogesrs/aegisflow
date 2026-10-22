#!/usr/bin/env node
// AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1 — governed production-session proof.
//
// Unlike `production-smoke.mjs` (deterministic local provider, used to drive
// adversarial tool calls), this launch uses the PRODUCTION model config and the
// PRODUCTION provider credential, so the governed session is the real one an
// operator would get. It still runs in a throwaway OMP home and session dir; the
// production config, store and live sessions are only read.
//
//   node production-governed-real.mjs [--out <evidence.json>]
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/private/tmp/aegis-repair-1";
const OMP = "/Users/zhengfengqing/.local/bin/omp";
const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const PROD_AGENT = "/Users/zhengfengqing/.omp/agent";
const CHECKOUT = "/Volumes/NVM2T/Development/repos/autoloop";

const {
  attestExtension, bindIdentity, commitFence, createControllerGrant, disposeControllerRoot,
  launchGovernedRuntime, prepareControllerRoot, probeLedgerForCommit,
} = await import(`${REPO}/src/control-plane/controller-client.mjs`);

const outArg = process.argv.indexOf("--out");
const outPath = outArg === -1 ? null : process.argv[outArg + 1];
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");

const root = mkdtempSync(join(tmpdir(), "aegis-activation-real-"));
const paths = { config: join(root, "home", ".omp", "agent"), sessions: join(root, "sessions"), controller: join(root, "controller") };
const observations = {};
const verdicts = [];
let runtime;
let controllerRoot;

function check(id, pass, detail) {
  verdicts.push(Boolean(pass));
  observations[id] = { pass: Boolean(pass), detail };
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail).slice(0, 700)}`);
}

try {
  mkdirSync(paths.config, { recursive: true });
  mkdirSync(paths.sessions, { recursive: true });
  for (const name of ["config.yml", "models.yml", "mcp.json", ".env"]) {
    cpSync(join(PROD_AGENT, name), join(paths.config, name));
  }
  controllerRoot = prepareControllerRoot({ root: paths.controller });
  const childAgent = join(controllerRoot.childHome, ".omp", "agent");
  mkdirSync(childAgent, { recursive: true });
  cpSync(paths.config, childAgent, { recursive: true });

  const primary = join(DEPLOYED, "no-poll-waits.js");
  const extra = join(DEPLOYED, "cbm-query.js");
  const primarySha = sha256(primary);
  const tree = attestExtension(primary, primarySha).digests;

  runtime = await launchGovernedRuntime({
    rpcBin: OMP,
    controllerRoot,
    grant: createControllerGrant({ controllerId: "production-activation", basis: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1" }),
    extensionPath: primary, extensionSha256: primarySha, extensionTree: tree,
    additionalExtensions: [{ path: extra, sha256: sha256(extra), tree }],
    args: ["--session-dir", paths.sessions, "--no-skills", "--no-rules"],
    cwd: CHECKOUT,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PI_CODING_AGENT_DIR: childAgent,
      AEGISFLOW_REPO_ROOT: CHECKOUT,
    },
  });
  check("GOVERNED_LAUNCH_PRODUCTION_CONFIG", runtime.ok === true && runtime.sandbox?.active === true && runtime.capabilityProvisioned === true, {
    ok: runtime.ok, denial: runtime.denial ?? null, sandbox: runtime.sandbox?.active ?? null, capability: runtime.capabilityProvisioned ?? null,
  });
  if (!runtime.ok) throw new Error(`governed launch refused: ${runtime.denial}`);

  const bound = await bindIdentity(runtime);
  if (!bound.ok) throw new Error(`identity bind refused: ${bound.reason}`);
  const identity = bound.identity;

  // A real turn through the production provider.
  const before = runtime.frames.length;
  runtime.send({ id: `real-${randomBytes(4).toString("hex")}`, type: "prompt", message: "Reply with exactly: ACTIVATION_OK" });
  const deadline = Date.now() + 120_000;
  let settled = false;
  let assistantText = "";
  while (Date.now() < deadline) {
    const frames = runtime.frames.slice(before).map(entry => entry.frame);
    for (const frame of frames) {
      if (frame?.type === "message_end") assistantText += JSON.stringify(frame);
    }
    if (frames.some(frame => frame?.type === "session_settled")) { settled = true; break; }
    await new Promise(done => setTimeout(done, 50));
  }
  check("PRODUCTION_PROMPT", settled && assistantText.includes("ACTIVATION_OK"), {
    settled, provider: "production modelRoles.default", matched: assistantText.includes("ACTIVATION_OK"),
  });

  // P04 in the REAL-provider session: the tool call is chosen and issued by the
  // production model, not by a synthetic function_call frame.
  const beforeBash = runtime.frames.length;
  runtime.send({ id: `real-node-${randomBytes(4).toString("hex")}`, type: "prompt", message: "Use the bash tool to run exactly: command -v node; node --version; shasum -a 256 /usr/local/bin/node — then quote its raw output verbatim and nothing else." });
  const bashDeadline = Date.now() + 150_000;
  let bashText = "";
  let bashSettled = false;
  while (Date.now() < bashDeadline) {
    const frames = runtime.frames.slice(beforeBash).map(entry => entry.frame);
    bashText = frames
      .filter(frame => frame?.type === "tool_execution_end" && frame.toolName === "bash")
      .flatMap(frame => frame.result?.content ?? [])
      .filter(part => part?.type === "text").map(part => part.text).join("\n");
    if (bashText && frames.some(frame => frame?.type === "session_settled")) { bashSettled = true; break; }
    await new Promise(done => setTimeout(done, 50));
  }
  check("PRODUCTION_FIXED_NODE", bashSettled && bashText.includes("/usr/local/bin/node") && bashText.includes("v22.22.2") && bashText.includes("450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf"), {
    settled: bashSettled,
    toolOutput: bashText.slice(0, 600),
    modelChosen: true,
  });

  const committed = await commitFence(runtime, { status: "PASS", expectation: identity });
  const witness = probeLedgerForCommit(runtime, identity);
  const records = readFileSync(runtime.ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const matching = records.filter(record => record.type === "commit" && record.sessionId === identity.sessionId && record.runtimeInstanceId === identity.runtimeInstanceId && record.generation === identity.generation);
  const ledgerKey = readFileSync(runtime.ledgerKeyPath, "utf8").trim();
  const { verifyLedgerRecord } = await import(`${DEPLOYED}/lib/ledger-auth.mjs`);
  const record = matching[0] ?? null;
  const macVerified = record ? verifyLedgerRecord(ledgerKey, record) === true : false;
  check("PRODUCTION_CONTROLLER_COMMIT", committed.state === "COMMITTED" && committed.result?.ledgerRecorded === true && matching.length === 1 && witness === "COMMITTED" && macVerified, {
    state: committed.state,
    ledgerRecorded: committed.result?.ledgerRecorded ?? null,
    witness,
    matching: matching.length,
    boundIdentity: identity,
    controllerRequestId: committed.requestId ?? null,
    controllerResultFrame: committed.result ?? null,
    ledgerRecord: record,
    macVerifiedWithDeployedVerifier: macVerified,
    ledgerKeySha256: createHash("sha256").update(ledgerKey).digest("hex"),
  });
} catch (error) {
  observations.error = String(error?.stack ?? error);
  console.error(observations.error);
} finally {
  if (runtime?.ok) await runtime.stop();
  if (controllerRoot) disposeControllerRoot(controllerRoot);
  rmSync(root, { recursive: true, force: true });
  const evidence = {
    card: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1",
    observedAt: new Date().toISOString(),
    scope: "governed launch using the production model config and provider credential, throwaway HOME/session dir",
    productionMutation: "NONE",
    isolatedRootRemoved: !existsSync(root),
    observations,
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`REAL_GOVERNED=${verdicts.length > 0 && verdicts.every(Boolean) ? "PASS" : "FAIL"}`);
}
process.exitCode = verdicts.length > 0 && verdicts.every(Boolean) ? 0 : 1;
