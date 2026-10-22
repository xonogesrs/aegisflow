#!/usr/bin/env node
// P05/P07 hardening: a forged ledger record must not be believed, and must not
// block a legitimate commit — measured against the DEPLOYED extension bytes and
// the deployed ledger-auth module, not the repository copy.
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/private/tmp/aegis-repair-1";
const OMP = "/Users/zhengfengqing/.local/bin/omp";
const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const {
  attestExtension, bindIdentity, commitFence, createControllerGrant, disposeControllerRoot,
  launchGovernedRuntime, prepareControllerRoot, probeLedgerForCommit,
} = await import(`${REPO}/src/control-plane/controller-client.mjs`);
const { verifyLedgerRecord } = await import(`${DEPLOYED}/lib/ledger-auth.mjs`);

const outArg = process.argv.indexOf("--out");
const outPath = outArg === -1 ? null : process.argv[outArg + 1];
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const root = mkdtempSync(join(tmpdir(), "aegis-forgery-"));
const cfg = join(root, "home", ".omp", "agent");
const observations = {};
const verdicts = [];
let runtime;
let controllerRoot;

function check(id, pass, detail) {
  verdicts.push(Boolean(pass));
  observations[id] = { pass: Boolean(pass), detail };
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail).slice(0, 800)}`);
}

const rawRecords = path => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; }; }).filter(Boolean)
  : [];

try {
  mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, "models.yml"), "providers:\n  s:\n    baseUrl: http://127.0.0.1:9/v1\n    api: openai-responses\n    apiKey: synthetic\n    models:\n    - id: s/fake\n      name: F\n      contextWindow: 100000\n      maxTokens: 4096\n      input:\n      - text\n");
  writeFileSync(join(cfg, "config.yml"), "modelRoles:\n  default: s/fake\nsymbolPreset: ascii\n");

  const primary = join(DEPLOYED, "no-poll-waits.js");
  const tree = attestExtension(primary, sha256(primary)).digests;
  controllerRoot = prepareControllerRoot({ root: join(root, "controller") });
  mkdirSync(join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });
  cpSync(cfg, join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });

  runtime = await launchGovernedRuntime({
    rpcBin: OMP, controllerRoot,
    grant: createControllerGrant({ controllerId: "forgery-denial", basis: "activation P05/P07 hardening" }),
    extensionPath: primary, extensionSha256: sha256(primary), extensionTree: tree,
    args: ["--no-session", "--no-skills", "--no-rules"],
    cwd: root,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", PI_CODING_AGENT_DIR: join(controllerRoot.childHome, ".omp", "agent") },
  });
  if (!runtime.ok) throw new Error(`launch refused: ${runtime.denial}`);
  const bound = await bindIdentity(runtime);
  if (!bound.ok) throw new Error(`bind refused: ${bound.reason}`);
  const identity = bound.identity;

  check("NOT_COMMITTED_BEFORE", probeLedgerForCommit(runtime, identity) === "NOT_COMMITTED", { witness: probeLedgerForCommit(runtime, identity) });

  // 1. perfectly shaped record, correct identity, NO mac.
  appendFileSync(runtime.ledgerPath, `${JSON.stringify({
    type: "commit", sessionId: identity.sessionId, runtimeInstanceId: identity.runtimeInstanceId,
    generation: identity.generation, allocationToken: null, status: "PASS",
    requestId: "forged-by-agent", at: Date.now(),
  })}\n`);
  const unsignedWitness = probeLedgerForCommit(runtime, identity);
  check("UNSIGNED_RECORD_NOT_BELIEVED", unsignedWitness !== "COMMITTED", { witness: unsignedWitness });

  // 2. same record signed with an attacker-chosen key.
  const wrongKey = randomBytes(32).toString("hex");
  appendFileSync(runtime.ledgerPath, `${JSON.stringify({
    type: "commit", sessionId: identity.sessionId, runtimeInstanceId: identity.runtimeInstanceId,
    generation: identity.generation, status: "PASS", requestId: "forged-wrong-key",
    at: Date.now(), mac: createHash("sha256").update(`${wrongKey}:forged`).digest("hex"),
  })}\n`);
  const wrongKeyWitness = probeLedgerForCommit(runtime, identity);
  check("WRONG_KEY_RECORD_NOT_BELIEVED", wrongKeyWitness !== "COMMITTED", { witness: wrongKeyWitness });

  // The deployed auth module must reject both records directly.
  const ledgerKey = readFileSync(runtime.ledgerKeyPath, "utf8").trim();
  const forged = rawRecords(runtime.ledgerPath).filter(r => r.requestId === "forged-by-agent" || r.requestId === "forged-wrong-key");
  const verifications = forged.map(r => {
    try {
      return verifyLedgerRecord(ledgerKey, r) === true ? "ACCEPTED" : "REJECTED";
    } catch {
      return "REJECTED";
    }
  });
  check("DEPLOYED_AUTH_REJECTS_FORGERY", verifications.every(v => v === "REJECTED"), { verifications });

  // 3. forgery must not deny the legitimate commit.
  const committed = await commitFence(runtime, { status: "PASS", expectation: identity });
  const records = rawRecords(runtime.ledgerPath);
  const matching = records.filter(r => r.type === "commit" && r.sessionId === identity.sessionId && r.runtimeInstanceId === identity.runtimeInstanceId && r.generation === identity.generation);
  // AUTHENTIC, not merely hex-shaped: the forged wrong-key record above is 64 hex
  // characters and must NOT be counted as signed. Verify with the deployed module
  // against the real ledger key.
  const authentic = r => {
    try {
      return verifyLedgerRecord(ledgerKey, r) === true;
    } catch {
      return false;
    }
  };
  const signed = matching.filter(authentic);
  const hexShaped = matching.filter(r => /^[0-9a-f]{64}$/.test(r.mac ?? "")).length;
  check("LEGITIMATE_COMMIT_UNAFFECTED", committed.state === "COMMITTED" && committed.result?.ledgerRecorded === true, {
    state: committed.state, ledgerRecorded: committed.result?.ledgerRecorded ?? null,
  });
  check("EXACTLY_ONE_AUTHENTIC_COMMIT", signed.length === 1 && probeLedgerForCommit(runtime, identity) === "COMMITTED", {
    authenticRecords: signed.length, hexShapedRecords: hexShaped, totalMatching: matching.length,
    witness: probeLedgerForCommit(runtime, identity),
  });
} catch (error) {
  observations.error = String(error?.stack ?? error);
  console.error(observations.error);
} finally {
  if (runtime?.ok) await runtime.stop();
  if (controllerRoot) disposeControllerRoot(controllerRoot);
  rmSync(root, { recursive: true, force: true });
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ card: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1", probe: "forgery-denial", observedAt: new Date().toISOString(), productionMutation: "NONE", isolatedRootRemoved: !existsSync(root), observations }, null, 2)}\n`);
  console.log(`FORGERY=${verdicts.length > 0 && verdicts.every(Boolean) ? "PASS" : "FAIL"}`);
}
process.exitCode = verdicts.length > 0 && verdicts.every(Boolean) ? 0 : 1;
