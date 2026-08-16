#!/usr/bin/env node
// scripts/collect-test-accounting.mjs
//
// Test accounting for closeout evidence.
//
// VCA-1 W1A (S5) — per-file RE-EXECUTION mode is DISABLED as the default.
// The R1/R2 audit（G14）found this script re-executing every test file in a
// separate process（e.g. memory 23 files -> 23 separate runs）at closeout
// time — duplicating suites V1 already ran. Its original anti-tamper
// purpose（CBM-2R finding 3: no invented test counts）is now served by the
// structured verification.json accounting the verify gates persist.
//
// New contract（fail-closed, no execution by default）:
//
//   node scripts/collect-test-accounting.mjs --reuse <verification.json>
//       REUSE mode — renders per-suite accounting from the completed
//       `regression[]` entries recorded by a *-verify gate. NEVER executes
//       any test. Exit 0 iff every suite is green.
//
//   node scripts/collect-test-accounting.mjs --execute <file.mjs ...>
//       FORENSIC mode — legacy per-file re-execution（explicit opt-in only,
//       for one-off tamper investigations, never a routine closeout step）.
//
//   no mode flag -> usage + exit 2（fail-closed; a bare invocation must not
//       re-run suites by accident）.
//
// Output: one JSON line per suite/file + a final aggregate line carrying
// `mode`, `executed: true|false`, and（in reuse mode）the recorded wallMs.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(
    "usage:\n" +
    "  node scripts/collect-test-accounting.mjs --reuse <verification.json>   (REUSE completed results; no execution)\n" +
    "  node scripts/collect-test-accounting.mjs --execute <file.mjs ...> | --dir <dir>   (forensic re-execution; explicit opt-in)\n" +
    "no mode -> exit 2 (fail-closed; default never re-executes tests)",
  );
}

// ── REUSE mode ────────────────────────────────────────────────────────────
function reuseMode(jsonPath) {
  if (!jsonPath) {
    console.error("--reuse requires <verification.json>");
    usage();
    process.exit(2);
  }
  let verification;
  try {
    verification = JSON.parse(readFileSync(resolve(jsonPath), "utf8"));
  } catch (e) {
    console.error(`--reuse unreadable: ${resolve(jsonPath)}: ${e.message}`);
    process.exit(2);
  }
  const regression = Array.isArray(verification.regression) ? verification.regression : [];
  if (regression.length === 0) {
    console.error(`--reuse: ${jsonPath} has no regression[] accounting`);
    process.exit(2);
  }
  let allGreen = true;
  let sumPass = 0;
  let sumFail = 0;
  let sumTotal = 0;
  let sumWallMs = 0;
  for (const r of regression) {
    const ok = r.ok === true && Number(r.failed) === 0 && Number(r.tests) > 0;
    if (!ok) allGreen = false;
    const pass = Number(r.passed ?? 0);
    const fail = Number(r.failed ?? 0);
    const tests = Number(r.tests ?? 0);
    sumPass += pass;
    sumFail += fail;
    sumTotal += tests;
    if (Number.isFinite(r.wallMs)) sumWallMs += r.wallMs;
    console.log(JSON.stringify({
      suite: r.suite,
      pass,
      fail,
      total: tests,
      ok,
      // S2: the wall time was MEASURED by the verify gate that ran the suite
      //（reuse mode never re-measures）.
      wallMs: Number.isFinite(r.wallMs) ? r.wallMs : null,
      timingSource: Number.isFinite(r.wallMs) ? "MEASURED (by verify gate)" : "UNKNOWN",
    }));
  }
  console.log(JSON.stringify({
    mode: "REUSE",
    executed: false,
    source: jsonPath,
    suite: { pass: sumPass, fail: sumFail, total: sumTotal, wallMs: sumWallMs },
    sumMatches: sumPass + sumFail === sumTotal,
    allGreen,
  }));
  process.exit(allGreen && sumPass + sumFail === sumTotal ? 0 : 1);
}

// ── FORENSIC（execute）mode ────────────────────────────────────────────────
function executeMode(files) {
  if (files.length === 0) {
    console.error("--execute requires <file.mjs ...> or --dir <dir>");
    usage();
    process.exit(2);
  }
  let allPassed = true;
  let sumPass = 0;
  let sumFail = 0;
  let sumTotal = 0;
  for (const f of files) {
    const startedAt = Date.now();
    const r = spawnSync(process.execPath, ["--test", f], { encoding: "utf8" });
    const out = `${r.stdout}\n${r.stderr}`;
    const num = (label) => {
      const m = out.match(new RegExp(`^ℹ ${label} (\\d+)`, "m"));
      return m ? Number(m[1]) : 0;
    };
    const tests = num("tests");
    const pass = num("pass");
    const fail = num("fail");
    const wallMs = Date.now() - startedAt;
    const ok = r.status === 0 && fail === 0 && (pass > 0 || tests === 0);
    if (!ok) allPassed = false;
    sumPass += pass;
    sumFail += fail;
    sumTotal += tests;
    console.log(JSON.stringify({ file: f.replace(process.cwd() + "/", ""), pass, fail, total: tests, ok, wallMs, timingSource: "MEASURED" }));
  }
  console.log(JSON.stringify({
    mode: "EXECUTE",
    executed: true,
    warning: "forensic per-file re-execution — not a routine closeout step (VCA-1 W1A S5)",
    suite: { pass: sumPass, fail: sumFail, total: sumTotal },
    sumMatches: sumPass + sumFail === sumTotal,
  }));
  process.exit(allPassed && sumPass + sumFail === sumTotal ? 0 : 1);
}

// ── mode dispatch ─────────────────────────────────────────────────────────
const reuseIdx = args.indexOf("--reuse");
const execIdx = args.indexOf("--execute");
if (reuseIdx >= 0) {
  reuseMode(args[reuseIdx + 1]);
} else if (execIdx >= 0) {
  const rest = args.slice(execIdx + 1);
  const files = [];
  const dirIdx = rest.indexOf("--dir");
  if (dirIdx >= 0 && rest[dirIdx + 1]) {
    const dir = resolve(rest[dirIdx + 1]);
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith(".mjs") && !f.startsWith("helpers")) files.push(join(dir, f));
    }
  } else {
    for (const a of rest) {
      if (a.startsWith("--")) continue;
      files.push(resolve(a));
    }
  }
  executeMode(files);
} else {
  usage();
  process.exit(2);
}
