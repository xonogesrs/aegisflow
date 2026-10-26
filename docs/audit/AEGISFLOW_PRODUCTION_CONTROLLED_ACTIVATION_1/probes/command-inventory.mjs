#!/usr/bin/env node
// P01/P03 helper: enumerate the commands and tools the DEPLOYED extension
// registers, from a real OMP process in RPC mode (no TUI, no session).
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OMP = "/Users/zhengfengqing/.local/bin/omp";
const DEPLOYED = "/Users/zhengfengqing/.omp/agent/extensions";
const root = mkdtempSync(join(tmpdir(), "aegis-p01-"));
const cfg = join(root, ".omp", "agent");
mkdirSync(cfg, { recursive: true });
cpSync(join("/Users/zhengfengqing/.omp/agent", "models.yml"), join(cfg, "models.yml"));
cpSync(join("/Users/zhengfengqing/.omp/agent", "config.yml"), join(cfg, "config.yml"));
// The DEPLOYED extension tree, exactly as production discovery sees it.
cpSync(DEPLOYED, join(cfg, "extensions"), { recursive: true });

const child = spawn(OMP, ["--mode", "rpc", "--no-session", "--no-skills", "--no-rules"], {
  env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: cfg, PATH: "/usr/local/bin:/usr/bin:/bin" },
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
});
let buf = "";
let commands = null;
let tools = null;
let stderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.type === "available_commands_update") commands = frame.commands;
    if (frame.type === "available_tools_update" || frame.type === "tools_update") tools = frame;
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", chunk => { stderr += chunk; });

const deadline = Date.now() + 40_000;
while (Date.now() < deadline && (!commands || !tools)) await new Promise(r => setTimeout(r, 100));
child.kill("SIGTERM");
await new Promise(r => setTimeout(r, 500));
rmSync(root, { recursive: true, force: true });

const names = (commands ?? []).map(c => c.name).sort();
const toolNames = (tools?.tools ?? []).map(t => t.name).sort();
const out = {
  commandCount: names.length,
  fenceCommands: names.filter(n => /fence|release-final/.test(n)),
  hasEkmQuery: toolNames.includes("ekm_query"),
  hasCbmQuery: toolNames.includes("cbm_query"),
  memoryTools: toolNames.filter(n => /ekm|cbm|memory/.test(n)),
  stderrTail: stderr.slice(-400),
};
writeFileSync(join(import.meta.dirname, "..", "evidence", "command-and-tool-inventory.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
