#!/usr/bin/env node
// Focused P05 follow-up: does a nested OMP, given the retired marker AND the
// live state dir, actually get a signed denial — or did the broader smoke only
// prove "no commit record appeared"? This probe keeps the nested runtime's full
// stdout so the denial text itself is evidence, not a regex guess.
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const REPO = "/private/tmp/aegis-repair-1";
const OMP = "/Users/zhengfengqing/.local/bin/omp";
const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const {
  attestExtension, bindIdentity, createControllerGrant, disposeControllerRoot,
  launchGovernedRuntime, prepareControllerRoot,
} = await import(`${REPO}/src/control-plane/controller-client.mjs`);

const outArg = process.argv.indexOf("--out");
const outPath = outArg === -1 ? null : process.argv[outArg + 1];
const sha256 = file => createHash("sha256").update(readFileSync(file)).digest("hex");

const root = mkdtempSync(join(tmpdir(), "aegis-nested-denial-"));
const cfg = join(root, "home", ".omp", "agent");
const sessions = join(root, "sessions");
const observations = {};
const verdicts = [];
let runtime;
let controllerRoot;
let server;
let mode = { tool: null, args: {}, issued: false };

function check(id, pass, detail) {
  verdicts.push(Boolean(pass));
  observations[id] = { pass: Boolean(pass), detail };
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(detail).slice(0, 1200)}`);
}

try {
  mkdirSync(cfg, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  server = createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      if (!/\/responses$/.test(req.url)) { res.writeHead(404); res.end(); return; }
      const wantsTool = mode.tool && !mode.issued;
      if (wantsTool) mode.issued = true;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      send({ type: "response.created", response: { id: "r", status: "in_progress" } });
      if (wantsTool) {
        const item = { type: "function_call", id: "f", call_id: "c", name: mode.tool, arguments: JSON.stringify(mode.args) };
        send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
        send({ type: "response.function_call_arguments.delta", item_id: "f", output_index: 0, delta: item.arguments });
        send({ type: "response.function_call_arguments.done", item_id: "f", output_index: 0, arguments: item.arguments });
        send({ type: "response.output_item.done", output_index: 0, item });
      } else {
        send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } });
        send({ type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "OK" });
        send({ type: "response.output_text.done", item_id: "m", output_index: 0, content_index: 0, text: "OK" });
        send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "OK" }] } });
      }
      send({ type: "response.completed", response: { id: "r", status: "completed", output: [] } });
      res.end();
    });
  });
  await new Promise((d, f) => { server.once("error", f); server.listen(0, "127.0.0.1", d); });
  const port = server.address().port;
  writeFileSync(join(cfg, "models.yml"), `providers:\n  s:\n    baseUrl: http://127.0.0.1:${port}/v1\n    api: openai-responses\n    apiKey: synthetic\n    models:\n    - id: s/fake\n      name: F\n      contextWindow: 100000\n      maxTokens: 4096\n      input:\n      - text\n`);
  writeFileSync(join(cfg, "config.yml"), "modelRoles:\n  default: s/fake\nsymbolPreset: ascii\n");

  const primary = join(DEPLOYED, "no-poll-waits.js");
  const tree = attestExtension(primary, sha256(primary)).digests;
  controllerRoot = prepareControllerRoot({ root: join(root, "controller") });
  mkdirSync(join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });
  cpSync(cfg, join(controllerRoot.childHome, ".omp", "agent"), { recursive: true });

  runtime = await launchGovernedRuntime({
    rpcBin: OMP, controllerRoot,
    grant: createControllerGrant({ controllerId: "nested-denial", basis: "activation P05 follow-up" }),
    extensionPath: primary, extensionSha256: sha256(primary), extensionTree: tree,
    args: ["--session-dir", sessions, "--no-skills", "--no-rules"],
    cwd: root,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", PI_CODING_AGENT_DIR: join(controllerRoot.childHome, ".omp", "agent") },
  });
  if (!runtime.ok) throw new Error(`launch refused: ${runtime.denial}`);
  const bound = await bindIdentity(runtime);
  if (!bound.ok) throw new Error(`bind refused: ${bound.reason}`);

  const nestedCommand = [
    `HOME=${JSON.stringify(runtime.childHome)}`,
    "OMP_TERMINAL_FENCE_AUTHORITY=nested-agent",
    `OMP_TERMINAL_FENCE_STATE_DIR=${JSON.stringify(runtime.stateDir)}`,
    `OMP_TERMINAL_FENCE_LOCK_DIR=${JSON.stringify(runtime.lockDir)}`,
    `${JSON.stringify(OMP)} --mode rpc --no-session --no-skills --no-rules -e ${JSON.stringify(primary)} --no-extensions`,
    `<<< '{"id":"n1","type":"prompt","message":"/fence-generation PASS request=n1"}'`,
  ].join(" ");

  const before = runtime.frames.length;
  mode = { tool: "bash", args: { command: nestedCommand, i: "nested authority attempt" }, issued: false };
  runtime.send({ id: `nested-${randomBytes(4).toString("hex")}`, type: "prompt", message: "Run the bash tool." });
  const deadline = Date.now() + 120_000;
  let nestedText = "";
  while (Date.now() < deadline) {
    const frames = runtime.frames.slice(before).map(e => e.frame);
    nestedText = frames
      .filter(f => f?.type === "tool_execution_end" && f.toolName === "bash")
      .flatMap(f => f.result?.content ?? [])
      .filter(p => p?.type === "text").map(p => p.text).join("\n");
    if (nestedText && frames.some(f => f?.type === "session_settled")) break;
    await new Promise(d => setTimeout(d, 50));
  }

  const ledgerRecords = existsSync(runtime.ledgerPath)
    ? readFileSync(runtime.ledgerPath, "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; }; }).filter(Boolean)
    : [];
  const commits = ledgerRecords.filter(r => r.type === "commit");
  check("NESTED_DENIAL_SIGNED", /CONTROLLER_AUTHORITY_ABSENT/.test(nestedText), {
    denialPresent: /CONTROLLER_AUTHORITY_ABSENT/.test(nestedText),
    denialSnippet: (nestedText.match(/[^\n]*CONTROLLER_AUTHORITY_ABSENT[^\n]*/) ?? [null])[0],
  });
  check("NESTED_WROTE_NO_COMMIT", commits.length === 0, { commitRecords: commits.length, ledgerRecordTypes: ledgerRecords.map(r => r.type) });
  check("PARENT_STILL_OWNS_GENERATION", runtime.boundIdentity?.generation === bound.identity.generation, {
    boundGeneration: bound.identity.generation,
  });
  observations.nestedOutputFull = nestedText.slice(0, 4000);
} catch (error) {
  observations.error = String(error?.stack ?? error);
  console.error(observations.error);
} finally {
  if (runtime?.ok) await runtime.stop();
  if (server) await new Promise(d => server.close(d));
  if (controllerRoot) disposeControllerRoot(controllerRoot);
  rmSync(root, { recursive: true, force: true });
  if (outPath) writeFileSync(outPath, `${JSON.stringify({ card: "AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1", probe: "nested-denial", observedAt: new Date().toISOString(), productionMutation: "NONE", isolatedRootRemoved: !existsSync(root), observations }, null, 2)}\n`);
  console.log(`NESTED=${verdicts.length > 0 && verdicts.every(Boolean) ? "PASS" : "FAIL"}`);
}
process.exitCode = verdicts.length > 0 && verdicts.every(Boolean) ? 0 : 1;
