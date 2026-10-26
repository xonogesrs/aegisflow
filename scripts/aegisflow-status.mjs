#!/usr/bin/env node
// scripts/aegisflow-status.mjs
//
// "What needs my attention?" — read-only, except for the explicit --ack / --on / --off.
//
//   node scripts/aegisflow-status.mjs [--check] [--detail] [--json] [--ack]
//        [--evolution-store <abs>] [--checkpoint-root <abs> ...] [--state-dir <abs>]
//   node scripts/aegisflow-status.mjs --off | --on | --toggle | --switch
//
//   (default)  print the banner when something needs attention, else a one-line "all clear"
//   --check    print the banner ONLY when there is an alert, otherwise print nothing.
//              Built for session-start hooks / skill preambles: silent when quiet,
//              and silent when the automatic reminder is switched off.
//   --detail   list every item, including informational ones and acknowledged ones
//   --json     machine-readable report (aegisflow.attention-report/v1)
//   --ack      mark the currently raised alerts as seen (writes only attention-state.json
//              in --state-dir); new or changed situations raise a fresh alert
//   --off/--on switch the AUTOMATIC reminder (--check) off/on. Manual runs, --detail and
//              --json still work; evolution and execution are not affected (the evolution
//              kill switch is scripts/evolution-kill-switch.mjs). AEGISFLOW_ATTENTION=off
//              overrides the persisted switch.
//   --toggle   flip the switch (one press, no need to remember on/off)
//   --switch   show the switch state
//
// Defaults: --evolution-store from AEGISFLOW_EVOLUTION_STORE_ROOT; --checkpoint-root from
// AEGISFLOW_EVOLUTION_CHECKPOINT_ROOT, else <AEGISFLOW_HOME>/durable. --state-dir defaults to
// the evolution store. All paths must be absolute.

import { isAbsolute, join } from "node:path";
import { autoloopHome, readConfigEnv } from "../src/shared/autoloop-paths.mjs";
import { acknowledge, collectAttention, renderBanner } from "../src/attention/attention.mjs";
import { readAttentionSwitch, setAttentionSwitch } from "../src/attention/switch.mjs";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/aegisflow-status.mjs [--check] [--detail] [--json] [--ack] [--on|--off|--toggle|--switch] [--evolution-store <abs>] [--checkpoint-root <abs> ...] [--state-dir <abs>]");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flags = new Set();
const opts = { "--evolution-store": null, "--state-dir": null };
const checkpointRoots = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (["--check", "--detail", "--json", "--ack", "--on", "--off", "--switch", "--toggle"].includes(a)) flags.add(a);
  else if (a === "--checkpoint-root") { if (!argv[i + 1]) usage("--checkpoint-root needs a value"); checkpointRoots.push(argv[++i]); }
  else if (a in opts) { if (!argv[i + 1]) usage(`${a} needs a value`); opts[a] = argv[++i]; }
  else usage(`unknown argument: ${a}`);
}
if ([flags.has("--on"), flags.has("--off"), flags.has("--toggle")].filter(Boolean).length > 1) usage("--on, --off and --toggle are mutually exclusive");

const env = process.env;

if (flags.has("--toggle")) {
  // flip the persisted switch relative to the EFFECTIVE state, so one press always changes what you see
  flags.add(readAttentionSwitch({ env }).enabled ? "--off" : "--on");
}

if (flags.has("--on") || flags.has("--off")) {
  const r = setAttentionSwitch({ enabled: flags.has("--on"), env });
  console.log(r.enabled ? "自動提醒已開啟。" : "自動提醒已關閉(手動執行、--detail、--json 仍可使用;用 --on 重新開啟)。");
  const effective = readAttentionSwitch({ env });
  if (effective.source === "env" && effective.enabled !== r.enabled) console.log(`注意:環境變數 AEGISFLOW_ATTENTION 目前覆蓋了這個設定(實際為${effective.enabled ? "開啟" : "關閉"})。`);
  process.exit(0);
}
if (flags.has("--switch")) {
  const s = readAttentionSwitch({ env });
  console.log(`自動提醒:${s.enabled ? "開啟" : "關閉"}(來源:${s.source}${s.changedAt ? `,${s.changedAt}` : ""})`);
  process.exit(0);
}

const evolutionStoreRoot = opts["--evolution-store"] ?? readConfigEnv(env, "AEGISFLOW_EVOLUTION_STORE_ROOT")?.value ?? null;
const envCheckpoint = readConfigEnv(env, "AEGISFLOW_EVOLUTION_CHECKPOINT_ROOT")?.value ?? null;
const roots = checkpointRoots.length > 0 ? checkpointRoots : [envCheckpoint ?? join(autoloopHome({ env }), "durable")];
const stateDir = opts["--state-dir"] ?? evolutionStoreRoot ?? autoloopHome({ env });

for (const p of [evolutionStoreRoot, stateDir, ...roots]) {
  if (p && !isAbsolute(p)) usage(`paths must be absolute: ${p}`);
}

// The automatic path stays completely silent while switched off.
if (flags.has("--check") && !readAttentionSwitch({ env }).enabled) process.exit(0);

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
  console.log(JSON.stringify({ ...report, switch: readAttentionSwitch({ env }) }, null, 2));
  process.exit(0);
}

const banner = renderBanner(report, { detail: flags.has("--detail") });
if (banner) console.log(banner);
else if (!flags.has("--check")) console.log("AegisFlow:目前沒有需要你注意的事項。");
