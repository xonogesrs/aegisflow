import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readAttentionSwitch, setAttentionSwitch } from "../../src/attention/switch.mjs";
import { collectAttention } from "../../src/attention/attention.mjs";
import { mintExecutionId } from "../../src/c2d/execution-id.mjs";

const mk = () => realpathSync(mkdtempSync(join(tmpdir(), "attn-sw-")));
const SCRIPT = new URL("../../scripts/aegisflow-status.mjs", import.meta.url).pathname;

test("switch defaults ON, persists OFF/ON, and the env var overrides the file", () => {
  const home = mk();
  const env = { AEGISFLOW_HOME: home };
  assert.deepEqual(readAttentionSwitch({ env }), { enabled: true, source: "default", changedAt: null });

  setAttentionSwitch({ enabled: false, env });
  assert.equal(readAttentionSwitch({ env }).enabled, false);
  assert.equal(readAttentionSwitch({ env }).source, "file");
  assert.deepEqual(readdirSync(home), ["attention-switch.json"], "only the switch file is written");

  assert.equal(readAttentionSwitch({ env: { ...env, AEGISFLOW_ATTENTION: "on" } }).enabled, true, "env ON wins over file OFF");
  setAttentionSwitch({ enabled: true, env });
  assert.equal(readAttentionSwitch({ env: { ...env, AEGISFLOW_ATTENTION: "off" } }).enabled, false, "env OFF wins over file ON");
});

test("a corrupt or oversized switch file falls back to the default (ON)", () => {
  const home = mk();
  writeFileSync(join(home, "attention-switch.json"), "{not json");
  assert.equal(readAttentionSwitch({ env: { AEGISFLOW_HOME: home } }).enabled, true);
});

test("CLI: --check is silent while OFF, speaks while ON; manual run still reports", () => {
  const home = mk();
  const root = mk();
  const id = mintExecutionId();
  // nested persistence-root layout: <root>/<exec>/<exec>/CURRENT.json
  const dir = join(root, id, id);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ active_phase: "writer" }));
  writeFileSync(join(dir, "CURRENT.json"), bytes);
  writeFileSync(join(dir, "CURRENT.json.sha256"), createHash("sha256").update(bytes).digest("hex"));
  const old = new Date(Date.now() - 3 * 3_600_000);
  utimesSync(join(dir, "CURRENT.json"), old, old);

  const env = { PATH: process.env.PATH, AEGISFLOW_HOME: home };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, "--checkpoint-root", root, ...args], { env, encoding: "utf8" });

  assert.match(run("--check").stdout, /需要你注意/, "nested-layout stale run raises an alert while ON");

  assert.match(run("--off").stdout, /已關閉/);
  assert.equal(run("--check").stdout, "", "automatic path is silent while OFF");
  assert.match(run().stdout, /需要你注意/, "an explicit manual run still reports");
  assert.equal(JSON.parse(run("--json").stdout).switch.enabled, false);

  assert.match(run("--on").stdout, /已開啟/);
  assert.match(run("--check").stdout, /需要你注意/);
});

test("nested persistence-root layout is scanned", () => {
  const root = mk();
  const id = mintExecutionId();
  const dir = join(root, id, id);
  mkdirSync(dir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ active_phase: "p" }));
  writeFileSync(join(dir, "CURRENT.json"), bytes);
  writeFileSync(join(dir, "CURRENT.json.sha256"), createHash("sha256").update(bytes).digest("hex"));
  const r = collectAttention({ checkpointRoots: [root] });
  assert.ok(r.items.some((i) => i.kind === "EXECUTION_INTERRUPTED" && i.summary.includes(id)));
});
