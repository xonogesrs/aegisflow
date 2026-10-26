#!/usr/bin/env node
// Audit-only focused smoke. Uses real OMP RPC and controller client; fake local
// provider removes external credentials while still driving real agent tools.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attestExtension, bindIdentity, commitFence, createControllerGrant,
  disposeControllerRoot, launchGovernedRuntime, prepareControllerRoot,
  probeLedgerForCommit,
} from "../../../../src/control-plane/controller-client.mjs";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../../../../src/memory/index.mjs";
import { codeRecord } from "../../../../test/memory/helpers-cbm3.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const root = mkdtempSync(join(tmpdir(), "aegis-fixed-node-governed-"));
const paths = {
  ompHome: join(root, "omp-home"), ompConfig: join(root, "omp-home", ".omp", "agent"),
  extensionDir: join(root, "extensions"), sessionDir: join(root, "sessions"),
  stateDir: join(root, "memory-state"), ledgerDir: join(root, "controller", "state"),
  testAuthority: join(root, "controller"), workRepo: join(root, "work-repo"),
  cbmCache: join(root, "cbm-cache"), cbmRuntime: `/private/tmp/cbm-sm-${process.pid}-${randomBytes(3).toString("hex")}`,
};
const observations = {};
let runtime;
let controllerRoot;
let server;
let serverPort;
let mode = { tool: null, args: {} };
let toolIssued = false;

function check(name, passed, detail) {
  observations[name] = { pass: Boolean(passed), detail };
  console.log(`${passed ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
}

async function turn(tool, args, prompt) {
  mode = { tool, args };
  toolIssued = false;
  const before = runtime.frames.length;
  runtime.send({ id: `smoke-${randomBytes(5).toString("hex")}`, type: "prompt", message: prompt });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const frames = runtime.frames.slice(before).map(entry => entry.frame);
    if (frames.some(frame => frame?.type === "session_settled")) return frames;
    await new Promise(done => setTimeout(done, 40));
  }
  throw new Error(`turn timeout: ${tool ?? "prompt"}; frames=${JSON.stringify(runtime.frames.slice(before).map(entry => entry.frame?.type).slice(-30))}`);
}

function toolResult(frames, name) {
  const starts = frames.filter(frame => frame?.type === "tool_execution_start" && frame.toolName === name);
  const ends = frames.filter(frame => frame?.type === "tool_execution_end" && frame.toolName === name);
  const text = ends.flatMap(frame => frame.result?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
  return { starts: starts.length, ends: ends.length, text, details: ends.map(frame => frame.result?.details ?? null) };
}

try {
  mkdirSync(paths.ompConfig, { recursive: true });
  mkdirSync(paths.sessionDir, { recursive: true });
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.cbmRuntime, { mode: 0o700 });
  mkdirSync(paths.workRepo, { recursive: true });
  mkdirSync(join(paths.workRepo, "src"), { recursive: true });
  writeFileSync(join(paths.workRepo, "src", "smoke.js"), "export function fixedNodeSmoke() { return 1; }\n");
  cpSync(join(repo, "integrations", "omp", "extensions"), paths.extensionDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: paths.workRepo });
  execFileSync("git", ["add", "src/smoke.js"], { cwd: paths.workRepo });
  execFileSync("git", ["-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke", "commit", "-q", "-m", "smoke fixture"], { cwd: paths.workRepo });
  const identity = resolveRepositoryIdentity(paths.workRepo);
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: paths.workRepo, encoding: "utf8" }).trim();
  const store = new LocalMemoryStore({ stateRoot: paths.stateDir, log: { info() {}, warn() {}, error() {} } });
  store.open();
  store.explicitImport(codeRecord({ repo: identity.repositoryIdentity, commit: identity.commitSha, tree, path: "src/smoke.mjs", symbol: "fixedNodeSmoke", statement: "fixedNodeSmoke proves isolated governed memory query", text: "fixedNodeSmoke proves isolated governed memory query" }));
  store.close();

  server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      if (!/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const useTool = mode.tool && !toolIssued;
      if (useTool) toolIssued = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id: "resp_smoke", status: "in_progress" } });
      if (useTool) {
        const item = { type: "function_call", id: "fc_smoke", call_id: "call_smoke", name: mode.tool, arguments: JSON.stringify(mode.args) };
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
        send({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
        send({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
        send({ type: "response.output_item.done", output_index: 0, item });
      } else {
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_smoke", role: "assistant", content: [] } });
        send({ type: "response.output_text.delta", item_id: "msg_smoke", output_index: 0, content_index: 0, delta: "SMOKE_OK" });
        send({ type: "response.output_text.done", item_id: "msg_smoke", output_index: 0, content_index: 0, text: "SMOKE_OK" });
        send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_smoke", role: "assistant", content: [{ type: "output_text", text: "SMOKE_OK" }] } });
      }
      send({ type: "response.completed", response: { id: "resp_smoke", status: "completed", output: [] } });
      res.end();
    });
  });
  await new Promise((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  serverPort = server.address().port;
  writeFileSync(join(paths.ompConfig, "models.yml"), `providers:\n  smoke:\n    baseUrl: http://127.0.0.1:${serverPort}/v1\n    api: openai-responses\n    apiKey: synthetic-not-a-credential\n    models:\n    - id: smoke/fake\n      name: Smoke Fake\n      contextWindow: 100000\n      maxTokens: 4096\n      input:\n      - text\n`);
  writeFileSync(join(paths.ompConfig, "config.yml"), "modelRoles:\n  default: smoke/fake\nsymbolPreset: ascii\n");
  writeFileSync(join(paths.ompConfig, "mcp.json"), JSON.stringify({ mcpServers: { "codebase-memory": {
    type: "stdio", command: "/Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp",
    args: [], env: { CBM_CACHE_DIR: paths.cbmCache, CBM_RUNTIME_DIR: paths.cbmRuntime, CBM_LOG_LEVEL: "warn" }, timeout: 120000,
  } } }, null, 2));

  controllerRoot = prepareControllerRoot({ root: paths.testAuthority });
  // Controller client selects its own isolated child HOME, never production HOME.
  mkdirSync(join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });
  cpSync(paths.ompConfig, join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });
  const primary = join(paths.extensionDir, "no-poll-waits.js");
  const extra = join(paths.extensionDir, "cbm-query.js");
  const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
  runtime = await launchGovernedRuntime({
    rpcBin: "/Users/zhengfengqing/.local/bin/omp", controllerRoot,
    grant: createControllerGrant({ controllerId: "fixed-node-smoke", basis: "isolated audit smoke" }),
    extensionPath: primary, extensionSha256: sha(primary), extensionTree: attestExtension(primary, sha(primary)).digests,
    additionalExtensions: [{ path: extra, sha256: sha(extra), tree: attestExtension(extra, sha(extra)).digests }],
    args: ["--session-dir", paths.sessionDir, "--no-skills", "--no-rules"], cwd: paths.workRepo,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", PI_CODING_AGENT_DIR: join(controllerRoot.childHome, ".omp", "agent"), AEGISFLOW_REPO_ROOT: repo, AEGISFLOW_MEMORY_STATE_ROOT: paths.stateDir },
  });
  check("S02_GOVERNED_LAUNCH", runtime.ok && runtime.sandbox?.active === true && runtime.capabilityProvisioned === true, { ok: runtime.ok, sandbox: runtime.sandbox?.active, capability: runtime.capabilityProvisioned, denial: runtime.denial ?? null });
  if (!runtime.ok) throw new Error(`governed launch refused: ${runtime.denial}`);
  const bound = await bindIdentity(runtime);
  if (!bound.ok) throw new Error(`identity bind refused: ${bound.reason}`);

  const prompt = await turn(null, {}, "Reply SMOKE_OK.");
  check("S03_NORMAL_PROMPT", prompt.some(frame => frame?.type === "message_end" && JSON.stringify(frame).includes("SMOKE_OK")) || prompt.some(frame => frame?.type === "agent_end" && JSON.stringify(frame).includes("SMOKE_OK")), { frameTypes: prompt.map(frame => frame?.type) });
  const bash = toolResult(await turn("bash", { command: "command -v node; node --version; shasum -a 256 /usr/local/bin/node", i: "verify fixed node" }, "Run bash tool."), "bash");
  check("S04_BASH_TOOL", bash.starts === 1 && bash.ends === 1 && bash.text.includes("v22.22.2"), { starts: bash.starts, ends: bash.ends, text: bash.text });
  check("S01_FIXED_NODE", bash.text.includes("/usr/local/bin/node") && bash.text.includes("450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf"), { text: bash.text });
  const cbmIndex = toolResult(await turn("write", { path: "xd://mcp__codebase_memory_index_repository", content: JSON.stringify({ repo_path: paths.workRepo, mode: "fast", name: "fixed-node-smoke" }), i: "Index isolated smoke fixture" }, "Index isolated CBM fixture."), "write");
  const cbm = toolResult(await turn("write", { path: "xd://mcp__codebase_memory_search_code", content: JSON.stringify({ project: "fixed-node-smoke", pattern: "fixedNodeSmoke" }), i: "Query isolated CBM fixture" }, "Search isolated CBM fixture."), "write");
  check("S05_CBM_QUERY", cbmIndex.starts === 1 && cbmIndex.ends === 1 && !/No such tool|isError|error|failed|unavailable/i.test(cbmIndex.text) && cbm.starts === 1 && cbm.ends === 1 && cbm.text.includes("fixedNodeSmoke") && !/No such tool|isError|error|failed|unavailable/i.test(cbm.text), { index: cbmIndex.text.slice(0, 500), query: cbm.text.slice(0, 700), stderr: runtime.stderrOf().slice(-500) });
  const memoryFrames = await turn("ekm_query", { terms: "fixedNodeSmoke", maxRecords: 5 }, "Query engineering knowledge memory.");
  const memory = toolResult(memoryFrames, "ekm_query");
  check("S06_EKM_MEMORY", memory.starts === 1 && memory.ends === 1 && memory.text.includes('"state": "AVAILABLE"') && memory.text.includes("fixedNodeSmoke proves isolated governed memory query") && memory.text.includes('"active": true'), { starts: memory.starts, ends: memory.ends, details: memory.details, matchingRecord: memory.text.includes("fixedNodeSmoke proves isolated governed memory query"), isolated: memory.text.includes('"active": true'), selected: /"selected": 1/.test(memory.text) });

  const committed = await commitFence(runtime, { status: "PASS", expectation: bound.identity });
  const witness = probeLedgerForCommit(runtime, bound.identity);
  const records = readFileSync(runtime.ledgerPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  const matching = records.filter(record => record.type === "commit" && record.sessionId === bound.identity.sessionId && record.runtimeInstanceId === bound.identity.runtimeInstanceId && record.generation === bound.identity.generation);
  const sessionMatch = committed.result?.sessionId === bound.identity.sessionId && matching[0]?.sessionId === bound.identity.sessionId;
  const runtimeMatch = committed.result?.runtimeInstanceId === bound.identity.runtimeInstanceId && matching[0]?.runtimeInstanceId === bound.identity.runtimeInstanceId;
  const generationMatch = committed.result?.generation === bound.identity.generation && matching[0]?.generation === bound.identity.generation;
  check("S09_CONTROLLER_COMMIT", committed.state === "COMMITTED" && committed.result?.committed === true && witness === "COMMITTED" && matching.length === 1 && sessionMatch && runtimeMatch && generationMatch && /^[0-9a-f]{64}$/.test(matching[0]?.mac ?? ""), { controllerResult: committed.state, ledgerWitness: witness, sessionMatch, runtimeMatch, generationMatch, signed: Boolean(matching[0]?.mac) });
} catch (error) {
  observations.error = String(error?.stack ?? error);
  console.error(observations.error);
} finally {
  if (runtime?.ok) await runtime.stop();
  if (server) await new Promise(done => server.close(done));
  if (controllerRoot) disposeControllerRoot(controllerRoot);
  const childExited = !runtime?.ok || runtime.exited() !== null;
  rmSync(root, { recursive: true, force: true });
  rmSync(paths.cbmRuntime, { recursive: true, force: true });
  check("S10_CLOSEOUT", !existsSync(root) && !existsSync(paths.cbmRuntime) && childExited, { isolatedRootGone: !existsSync(root), cbmRuntimeGone: !existsSync(paths.cbmRuntime), authorityGone: !existsSync(paths.testAuthority), ledgerGone: !existsSync(paths.ledgerDir), childExited });
  const evidence = { card: "AEGISFLOW_FIXED_NODE_GOVERNED_LAUNCH_SMOKE_1", observations, fixedPath: "/usr/local/bin:/usr/bin:/bin", nodeSha256: "450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf", productionMutation: "NONE" };
  const evidenceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "evidence");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(join(evidenceDir, "governed-smoke.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`EVIDENCE=${join(evidenceDir, "governed-smoke.json")}`);
  console.log(`SMOKE=${Object.values(observations).every(entry => entry?.pass === true) ? "PASS" : "FAIL"}`);
}
process.exitCode = Object.values(observations).every(entry => entry?.pass === true) ? 0 : 1;
