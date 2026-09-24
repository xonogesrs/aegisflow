#!/usr/bin/env node
// scripts/evolution-kill-switch.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_PRODUCTION_ACTIVATION_1 — Section H: the
// operational kill switch CLI.
//
//   node scripts/evolution-kill-switch.mjs --store <dir> --suspend [--reason "..."]
//   node scripts/evolution-kill-switch.mjs --store <dir> --resume
//   node scripts/evolution-kill-switch.mjs --store <dir> --status
//
// SUSPENDED: prevents NEW evolution cycles. Does NOT affect
// NORMAL_OPERATION, does NOT touch telemetry, does NOT cancel in-flight
// graph execution, and requires NO source modification. The env override
// AUTO_EVOLUTION=SUSPENDED takes precedence over the durable marker.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { suspendEvolution, resumeEvolution, readEvolutionSuspension } from "../src/evolution/kill-switch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

const usage = () => {
  console.error("usage:");
  console.error("  node scripts/evolution-kill-switch.mjs --store <dir> --suspend [--reason <text>]");
  console.error("  node scripts/evolution-kill-switch.mjs --store <dir> --resume");
  console.error("  node scripts/evolution-kill-switch.mjs --store <dir> --status");
  process.exit(2);
};

if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
const store = arg("--store");
if (!store) usage();
const root = resolve(store);

if (process.argv.includes("--suspend")) {
  const r = suspendEvolution(root, { reason: arg("--reason") ?? "operator suspension" });
  console.log(`AUTO_EVOLUTION = SUSPENDED (at ${r.suspended_at}, reason: ${r.reason})`);
  process.exit(0);
}
if (process.argv.includes("--resume")) {
  const r = resumeEvolution(root);
  console.log(r.already_enabled ? "AUTO_EVOLUTION = ENABLED (was not suspended)" : "AUTO_EVOLUTION = ENABLED");
  process.exit(0);
}
if (process.argv.includes("--status")) {
  const envSuspended = String(process.env.AUTO_EVOLUTION ?? "").toUpperCase() === "SUSPENDED";
  const marker = readEvolutionSuspension(root);
  if (envSuspended) console.log(`AUTO_EVOLUTION = SUSPENDED (env AUTO_EVOLUTION=SUSPENDED)`);
  else if (marker) console.log(`AUTO_EVOLUTION = SUSPENDED (marker: ${marker.reason}, at ${marker.suspended_at})`);
  else console.log("AUTO_EVOLUTION = ENABLED");
  process.exit(0);
}
usage();
