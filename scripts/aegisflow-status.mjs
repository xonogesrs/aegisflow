#!/usr/bin/env node
// scripts/aegisflow-status.mjs
//
// "What needs my attention?" — read-only, except for the explicit --ack.
//
//   node scripts/aegisflow-status.mjs [--check] [--detail] [--json] [--ack]
//        [--evolution-store <abs>] [--checkpoint-root <abs> ...] [--state-dir <abs>]
//
//   (default)  print the banner when something needs attention, else a one-line "all clear"
//   --check    print the banner ONLY when there is an alert, otherwise print nothing.
//              Built for session-start hooks / skill preambles: silent when quiet.
//   --detail   list every item, including informational ones and acknowledged ones
//   --json     machine-readable report (aegisflow.attention-report/v1)
//   --ack      mark the currently raised alerts as seen (writes only attention-state.json
//              in --state-dir); new or changed situations raise a fresh alert
//
// Defaults: --evolution-store from AEGISFLOW_EVOLUTION_STORE_ROOT, and
// --checkpoint-root from AEGISFLOW_EVOLUTION_CHECKPOINT_ROOT. --state-dir defaults to
// the evolution store. All paths must be absolute.

import { isAbsolute } from "node:path";
import { readConfigEnv } from "../src/shared/autoloop-paths.mjs";
import { acknowledge, collectAttention, renderBanner } from "../src/attention/attention.mjs";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/aegisflow-status.mjs [--check] [--detail] [--json] [--ack] [--evolution-store <abs>] [--checkpoint-root <abs> ...] [--state-dir <abs>]");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flags = new Set();
const opts = { "--evolution-store": null, "--state-dir": null };
const checkpointRoots = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (["--check", "--detail", "--json", "--ack"].includes(a)) flags.add(a);
  else if (a === "--checkpoint-root") { if (!argv[i + 1]) usage("--checkpoint-root needs a value"); checkpointRoots.push(argv[++i]); }
  else if (a in opts) { if (!argv[i + 1]) usage(`${a} needs a value`); opts[a] = argv[++i]; }
  else usage(`unknown argument: ${a}`);
}

const env = process.env;
const evolutionStoreRoot = opts["--evolution-store"] ?? readConfigEnv(env, "AEGISFLOW_EVOLUTION_STORE_ROOT")?.value ?? null;
const envCheckpoint = readConfigEnv(env, "AEGISFLOW_EVOLUTION_CHECKPOINT_ROOT")?.value ?? null;
const roots = checkpointRoots.length > 0 ? checkpointRoots : (envCheckpoint ? [envCheckpoint] : []);
const stateDir = opts["--state-dir"] ?? evolutionStoreRoot;

for (const p of [evolutionStoreRoot, stateDir, ...roots]) {
  if (p && !isAbsolute(p)) usage(`paths must be absolute: ${p}`);
}

const report = collectAttention({ evolutionStoreRoot, checkpointRoots: roots, stateDir, env });

if (flags.has("--ack")) {
  const keys = report.items.filter((it) => it.severity === "ALERT" && !it.acknowledged).map((it) => it.key);
  if (keys.length === 0) { console.log("沒有需要確認的項目。"); process.exit(0); }
  if (!stateDir) usage("--ack needs --state-dir (or a configured evolution store)");
  const r = acknowledge({ stateDir, keys });
  console.log(`已確認 ${r.acknowledged} 項(${r.at})。`);
  process.exit(0);
}

if (flags.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const banner = renderBanner(report, { detail: flags.has("--detail") });
if (banner) console.log(banner);
else if (!flags.has("--check")) console.log("AegisFlow:目前沒有需要你注意的事項。");
