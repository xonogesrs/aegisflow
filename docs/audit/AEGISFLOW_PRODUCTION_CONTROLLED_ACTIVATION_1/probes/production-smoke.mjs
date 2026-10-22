#!/usr/bin/env node
// AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1 — Phase 3 production smoke.
//
// Runs against the DEPLOYED extension bytes in ~/.omp/agent/extensions, with the
// pinned Node PATH, in a fresh isolated OMP session. It creates its own OMP HOME,
// session directory, controller root and CBM cache; it never writes the
// production store, config, or any live session.
//
//   P04 fixed node executable       (agent bash resolves /usr/local/bin/node)
//   P05 authority isolation         (agent cannot reach commit authority)
//   P06 controller commit           (fresh session, COMMITTED + durable)
//   P07 ledger witness              (authenticated record matches bound identity)
//
//   node production-smoke.mjs [--out <evidence.json>]
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "/private/tmp/aegis-repair-1";
const OMP = "/Users/zhengfengqing/.local/bin/omp";
const NODE = "/usr/local/bin/node";
const NODE_SHA = "450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf";
const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const CHECKOUT = "/Volumes/NVM2T/Development/repos/autoloop";
const CBM_BIN = "/Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp";

const {
  attestExtension, bindIdentity, commitFence, createControllerGrant, disposeControllerRoot,
  launchGovernedRuntime, prepareControllerRoot, probeLedgerForCommit,
} = await import(`${REPO}/src/control-plane/controller-client.mjs`);

const outArg = process.argv.indexOf("--out");
const outPath = outArg === -1 ? null : process.argv[outArg + 1];
// A retained verification witness, OUTSIDE the repository and mode 0700. The
// ledger key stays private here so a reviewer with read access can RECOMPUTE the
// record MAC; publishing only a key digest cannot verify anything.
const witnessArg = process.argv.indexOf("--witness-dir");
const witnessDir = witnessArg === -1 ? null : process.argv[witnessArg + 1];

const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const root = mkdtempSync(join(tmpdir(), "aegis-activation-smoke-"));
const paths = {
  ompConfig: join(root, "omp-home", ".omp", "agent"),
  sessionDir: join(root, "sessions"),
  controllerRoot: join(root, "controller"),
  workRepo: join(root, "work-repo"),
  cbmCache: join(root, "cbm-cache"),
  cbmRuntime: join(root, "cbm-runtime"),
};
const observations = {};
let runtime;
let controllerRoot;
let server;

const verdicts = [];
function check(id, pass, detail) {
  verdicts.push(Boolean(pass));
  observations[id] = { pass: Boolean(pass), detail };
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail).slice(0, 900)}`);
}

async function turn(prompt, { tool = null, args = {} } = {}) {
  const before = runtime.frames.length;
  mode = { tool, args, issued: false };
  runtime.send({ id: `smoke-${randomBytes(5).toString("hex")}`, type: "prompt", message: prompt });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const frames = runtime.frames.slice(before).map(entry => entry.frame);
    if (frames.some(frame => frame?.type === "session_settled")) return frames;
    await new Promise(done => setTimeout(done, 40));
  }
  throw new Error(`turn timeout: ${tool ?? "prompt"}`);
}

let mode = { tool: null, args: {}, issued: false };

function toolResult(frames, name) {
  const starts = frames.filter(frame => frame?.type === "tool_execution_start" && frame.toolName === name);
  const ends = frames.filter(frame => frame?.type === "tool_execution_end" && frame.toolName === name);
  const text = ends.flatMap(frame => frame.result?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
  return { starts: starts.length, ends: ends.length, text };
}

function rawRecords(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

try {
  for (const dir of [paths.ompConfig, paths.sessionDir, paths.cbmRuntime, paths.workRepo]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(paths.workRepo, "src"), { recursive: true });
  writeFileSync(join(paths.workRepo, "src", "activation.js"), "export function activationSmoke() { return 1; }\n");
  execFileSync("git", ["init", "-q"], { cwd: paths.workRepo });
  execFileSync("git", ["add", "src/activation.js"], { cwd: paths.workRepo });
  execFileSync("git", ["-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke", "commit", "-q", "-m", "activation smoke fixture"], { cwd: paths.workRepo });

  // Deterministic local provider: real OMP, real tools, no external credential.
  server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (!/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const wantsTool = mode.tool && !mode.issued;
      if (wantsTool) mode.issued = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id: "resp_act", status: "in_progress" } });
      if (wantsTool) {
        const item = { type: "function_call", id: "fc_act", call_id: "call_act", name: mode.tool, arguments: JSON.stringify(mode.args) };
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
        send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
        send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
        send({ type: "response.output_item.done", output_index: 0, item });
      } else {
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_act", role: "assistant", content: [] } });
        send({ type: "response.output_text.delta", item_id: "msg_act", output_index: 0, content_index: 0, delta: "SMOKE_OK" });
        send({ type: "response.output_text.done", item_id: "msg_act", output_index: 0, content_index: 0, text: "SMOKE_OK" });
        send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_act", role: "assistant", content: [{ type: "output_text", text: "SMOKE_OK" }] } });
      }
      send({ type: "response.completed", response: { id: "resp_act", status: "completed", output: [] } });
      res.end();
    });
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  writeFileSync(join(paths.ompConfig, "models.yml"), `providers:\n  smoke:\n    baseUrl: http://127.0.0.1:${port}/v1\n    api: openai-responses\n    apiKey: synthetic-not-a-credential\n    models:\n    - id: smoke/fake\n      name: Smoke Fake\n      contextWindow: 100000\n      maxTokens: 4096\n      input:\n      - text\n`);
  writeFileSync(join(paths.ompConfig, "config.yml"), "modelRoles:\n  default: smoke/fake\nsymbolPreset: ascii\n");
  writeFileSync(join(paths.ompConfig, "mcp.json"), JSON.stringify({ mcpServers: { "codebase-memory": {
    type: "stdio", command: CBM_BIN, args: [],
    env: { CBM_CACHE_DIR: paths.cbmCache, CBM_RUNTIME_DIR: paths.cbmRuntime, CBM_LOG_LEVEL: "warn" }, timeout: 120000,
  } } }, null, 2));

  // ── The DEPLOYED bytes are what is attested: this is production's own tree.
  const primary = join(DEPLOYED, "no-poll-waits.js");
  const extra = join(DEPLOYED, "cbm-query.js");
  const primarySha = sha256(primary);
  const extraSha = sha256(extra);
  const tree = attestExtension(primary, primarySha).digests;
  const treeRecheck = attestExtension(primary, primarySha, { expectedTree: tree });
  check("ATTEST_DEPLOYED_TREE", treeRecheck.ok === true && treeRecheck.treeVerified === true, {
    primarySha,
    extraSha: sha256(extra),
    siblingDigests: tree,
    siblingCount: Object.keys(tree).length,
    treeVerified: treeRecheck.treeVerified,
    entryRealpath: treeRecheck.path,
  });

  controllerRoot = prepareControllerRoot({ root: paths.controllerRoot });
  mkdirSync(join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });
  cpSync(paths.ompConfig, join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });

  runtime = await launchGovernedRuntime({
    rpcBin: OMP,
    controllerRoot,
    grant: createControllerGrant({ controllerId: "production-activation-smoke", basis: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1" }),
    extensionPath: primary, extensionSha256: primarySha, extensionTree: tree,
    additionalExtensions: [{ path: extra, sha256: extraSha, tree }],
    args: ["--session-dir", paths.sessionDir, "--no-skills", "--no-rules"],
    cwd: paths.workRepo,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      PI_CODING_AGENT_DIR: join(controllerRoot.childHome, ".omp", "agent"),
      AEGISFLOW_REPO_ROOT: CHECKOUT,
    },
  });
  const sandboxProfile = runtime.sandbox?.profile ?? "";
  check("GOVERNED_LAUNCH", runtime.ok === true && runtime.sandbox?.active === true && runtime.capabilityProvisioned === true, {
    ok: runtime.ok,
    denial: runtime.denial ?? null,
    sandbox: runtime.sandbox?.active ?? null,
    sandboxMechanism: runtime.sandbox?.mechanism ?? null,
    sandboxProfileSha256: sandboxProfile ? createHash("sha256").update(sandboxProfile).digest("hex") : null,
    sandboxDenyWriteRules: (sandboxProfile.match(/\(deny file-write\*/g) ?? []).length,
    sandboxDenyReadRules: (sandboxProfile.match(/\(deny file-read\*/g) ?? []).length,
    sandboxAllowWriteRules: (sandboxProfile.match(/\(allow file-write\*/g) ?? []).length,
    capability: runtime.capabilityProvisioned ?? null,
    ledgerFdSlot: 3,
    ledgerKeyFdSlot: 4,
    childExecutable: runtime.executablePath ?? null,
    attestedBinary: runtime.attestation?.path ?? null,
  });
  if (!runtime.ok) throw new Error(`governed launch refused: ${runtime.denial}`);

  const bound = await bindIdentity(runtime);
  if (!bound.ok) throw new Error(`identity bind refused: ${bound.reason}`);
  const identity = bound.identity;

  // ── P04 fixed node executable, measured from inside the governed agent.
  const nodeProbe = toolResult(await turn("Run the bash tool.", {
    tool: "bash",
    args: { command: "command -v node; node --version; shasum -a 256 /usr/local/bin/node; realpath \"$(command -v node)\"", i: "verify pinned node" },
  }), "bash");
  check("P04_FIXED_NODE", nodeProbe.starts === 1 && nodeProbe.ends === 1 && nodeProbe.text.includes("/usr/local/bin/node") && nodeProbe.text.includes("v22.22.2") && nodeProbe.text.includes(NODE_SHA), { text: nodeProbe.text.slice(0, 400) });

  // ── P05 authority isolation, attacked from the agent's own bash.
  const attackScript = [
    "for v in OMP_TERMINAL_FENCE_AUTHORITY OMP_TERMINAL_FENCE_LEDGER_FD OMP_CONTROLLER_LEDGER_KEY_FD; do",
    '  eval "val=\\$$v";',
    '  if [ -n "$val" ]; then echo "PRESENT $v=$val"; else echo "ABSENT $v"; fi;',
    "done;",
    "for n in 3 4; do",
    '  if eval "echo x >&$n" 2>/dev/null; then echo "FD_OPEN $n"; else echo "FD_CLOSED $n"; fi;',
    "done;",
    'if [ -n "$OMP_CONTROLLER_RESULT_KEY_FILE" ] && [ -r "$OMP_CONTROLLER_RESULT_KEY_FILE" ]; then echo RESULT_KEY_READABLE; else echo RESULT_KEY_UNREADABLE; fi;',
    `printf "{}\\n" >> ${JSON.stringify(runtime.ledgerPath)} 2>&1 && echo LEDGER_WRITE_OK || echo LEDGER_WRITE_DENIED;`,
    `printf "x" >> ${JSON.stringify(join(controllerRoot.childHome, ".omp", "agent", "extensions", "no-poll-waits.js"))} 2>&1 && echo EXT_WRITE_OK || echo EXT_WRITE_DENIED;`,
    `cat ${JSON.stringify(runtime.ledgerKeyPath)} 2>&1 | head -c 80; echo; echo KEY_READ_ATTEMPT_DONE;`,
    "echo PROBE_END",
  ].join(" ");
  const attack = toolResult(await turn("Run the bash tool.", { tool: "bash", args: { command: `sh -c '${attackScript}'`, i: "authority isolation probe" } }), "bash");
  const attackText = attack.text;
  const isolation = {
    markerAbsent: /ABSENT OMP_TERMINAL_FENCE_AUTHORITY/.test(attackText),
    ledgerFdClosed: /FD_CLOSED 3/.test(attackText),
    keyFdClosed: /FD_CLOSED 4/.test(attackText),
    resultKeyUnreadable: /RESULT_KEY_UNREADABLE/.test(attackText),
    ledgerWriteDenied: /LEDGER_WRITE_DENIED/.test(attackText),
    extensionWriteDenied: /EXT_WRITE_DENIED/.test(attackText),
    ledgerKeyNotReadable: !/[0-9a-f]{64}/.test(attackText),
    probeCompleted: /PROBE_END/.test(attackText) && /KEY_READ_ATTEMPT_DONE/.test(attackText),
  };

  // A nested OMP given the retired marker AND the live state dir must not commit.
  const nested = toolResult(await turn("Run the bash tool.", {
    tool: "bash",
    args: {
      command: [
        `HOME=${JSON.stringify(runtime.childHome)}`,
        "OMP_TERMINAL_FENCE_AUTHORITY=nested-agent",
        `OMP_TERMINAL_FENCE_STATE_DIR=${JSON.stringify(runtime.stateDir)}`,
        `OMP_TERMINAL_FENCE_LOCK_DIR=${JSON.stringify(runtime.lockDir)}`,
        `${JSON.stringify(OMP)} --mode rpc --no-session --no-skills --no-rules -e ${JSON.stringify(primary)} --no-extensions`,
        `<<< '{"id":"n1","type":"prompt","message":"/fence-generation PASS request=n1"}'`,
      ].join(" "),
      i: "nested authority attempt",
    },
  }), "bash");
  const commitsBefore = rawRecords(runtime.ledgerPath).filter(record => record.type === "commit").length;
  // The EXACT denial token, not a family of words: a generic help/command listing
  // must not be able to satisfy this predicate.
  const nestedDenialLine = (nested.text.match(/[^\n]*CONTROLLER_AUTHORITY_ABSENT[^\n]*/) ?? [null])[0];
  isolation.nestedDenialTokenPresent = nestedDenialLine !== null;
  isolation.nestedCommitDenied = commitsBefore === 0;
  const p05 = Object.values(isolation).every(Boolean);
  check("P05_AUTHORITY_ISOLATION", p05, {
    ...isolation,
    nestedDenialLine,
    nestedCommitRecords: commitsBefore,
    nestedOutputTail: nested.text.slice(-1500),
  });

  // ── P06 controller commit in this fresh, isolated production session.
  const committed = await commitFence(runtime, { status: "PASS", expectation: identity });
  const records = rawRecords(runtime.ledgerPath);
  const matching = records.filter(record => record.type === "commit" && record.sessionId === identity.sessionId && record.runtimeInstanceId === identity.runtimeInstanceId && record.generation === identity.generation);
  check("P06_CONTROLLER_COMMIT", committed.state === "COMMITTED" && committed.result?.committed === true && committed.result?.ledgerRecorded === true && matching.length === 1, {
    state: committed.state,
    ledgerRecorded: committed.result?.ledgerRecorded ?? null,
    matchingRecords: matching.length,
    requestId: committed.requestId ?? null,
    controllerResultFrame: committed.result ?? null,
    boundIdentity: identity,
  });

  // ── P07 ledger witness: the durable record must authenticate and match.
  const witness = probeLedgerForCommit(runtime, identity);
  const record = matching[0] ?? null;
  // Authenticate with the DEPLOYED verifier, not with "is 64 hex characters".
  const ledgerKey = readFileSync(runtime.ledgerKeyPath, "utf8").trim();
  const { verifyLedgerRecord } = await import(`${DEPLOYED}/lib/ledger-auth.mjs`);
  const macVerified = record ? verifyLedgerRecord(ledgerKey, record) === true : false;
  const witnessMatch = {
    witness,
    macPresent: /^[0-9a-f]{64}$/.test(record?.mac ?? ""),
    macVerifiedWithDeployedVerifier: macVerified,
    sessionMatch: record?.sessionId === identity.sessionId && committed.result?.sessionId === identity.sessionId,
    runtimeMatch: record?.runtimeInstanceId === identity.runtimeInstanceId && committed.result?.runtimeInstanceId === identity.runtimeInstanceId,
    generationMatch: record?.generation === identity.generation && committed.result?.generation === identity.generation,
    exactlyOne: matching.length === 1,
    // Reviewable material. The ledger KEY is deliberately NOT retained: only its
    // digest, so a reviewer can confirm the record was produced under the key the
    // harness held without the key itself entering version control.
    ledgerRecord: record,
    ledgerKeySha256: createHash("sha256").update(ledgerKey).digest("hex"),
    ledgerRecordCount: records.length,
    ledgerRecordTypes: records.map(entry => entry.type),
  };
  if (witnessDir) {
    mkdirSync(witnessDir, { recursive: true, mode: 0o700 });
    const bundle = {
      card: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1",
      writtenAt: new Date().toISOString(),
      note: "Retained so the commit MAC can be independently recomputed. The key is per-launch and test-only; it authorises nothing outside this isolated ledger.",
      ledgerPath: runtime.ledgerPath,
      ledgerSha256: createHash("sha256").update(readFileSync(runtime.ledgerPath)).digest("hex"),
      ledgerKeyPath: runtime.ledgerKeyPath,
      ledgerKeySha256: createHash("sha256").update(ledgerKey).digest("hex"),
      boundIdentity: identity,
      // The frame itself carries no requestId and no allocationToken; those live in
      // the harness's request id and the bound identity. Recorded separately so the
      // three-way comparison is exact rather than implied.
      controllerRequestId: committed.requestId ?? null,
      controllerResultFrame: committed.result ?? null,
      deployedExtensionDir: DEPLOYED,
      attestedEntrySha256: primarySha,
    };
    writeFileSync(join(witnessDir, "ledger.jsonl"), readFileSync(runtime.ledgerPath), { mode: 0o600 });
    writeFileSync(join(witnessDir, "ledger.key"), `${ledgerKey}\n`, { mode: 0o600 });
    writeFileSync(join(witnessDir, "witness.json"), `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    observations.witnessBundle = { dir: witnessDir, ledgerSha256: bundle.ledgerSha256, ledgerKeySha256: bundle.ledgerKeySha256 };
  }

  check("P07_LEDGER_WITNESS", witness === "COMMITTED" && Object.entries(witnessMatch).every(([k, v]) => k === "witness" || k === "ledgerRecord" || k === "ledgerKeySha256" || k === "ledgerRecordCount" || k === "ledgerRecordTypes" || v === true), witnessMatch);

  observations.context = { sessionDir: paths.sessionDir, ledgerPath: runtime.ledgerPath };
} catch (error) {
  observations.error = String(error?.stack ?? error);
  console.error(observations.error);
} finally {
  if (runtime?.ok) await runtime.stop();
  if (server) await new Promise(done => server.close(done));
  if (controllerRoot) disposeControllerRoot(controllerRoot);
  rmSync(root, { recursive: true, force: true });
  const evidence = {
    card: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1",
    observedAt: new Date().toISOString(),
    deployedExtensionDir: DEPLOYED,
    pinnedPath: "/usr/local/bin:/usr/bin:/bin",
    nodeSha256: NODE_SHA,
    productionMutation: "NONE",
    isolatedRootRemoved: !existsSync(root),
    observations,
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`SMOKE=${verdicts.length > 0 && verdicts.every(Boolean) ? "PASS" : "FAIL"}`);
}
process.exitCode = verdicts.length > 0 && verdicts.every(Boolean) ? 0 : 1;
