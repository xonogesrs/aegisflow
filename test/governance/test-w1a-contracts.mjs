// test/governance/test-w1a-contracts.mjs
//
// VCA-1 W1A — regression guards that the dedup/timing contracts do not
// silently regress:
//   S3  — the V17 verify gates no longer execute the 3 governance sub-suite
//         entries（review-bundle / graph-closeout / external-review-delivery
//         are subsets of test:governance）;
//   S4  — the independent review performs contract cross-checks only（no
//         suite re-execution; IR-4 reads verification.regression）;
//   S5  — collect-test-accounting defaults fail-closed（no mode -> exit 2）
//         and --reuse renders completed results without executing tests;
//   S10 — no synthetic hardcoded timestamps remain in self-closeout scripts;
//   S2  — the verify gates record real startedAt/completedAt/wallMs in the
//         verification summary.
//
// Run: node --test test/governance/test-w1a-contracts.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/Volumes/NVM2T/Development/repos/autoloop";
const read = (p) => readFileSync(join(REPO, p), "utf8");

const VERIFY_SCRIPTS = ["scripts/ta2-verify.mjs", "scripts/ta2r-verify.mjs", "scripts/ta3-verify.mjs", "scripts/rld2-verify.mjs"];
const SUBSET_SUITES = ["test:review-bundle", "test:graph-closeout", "test:external-review-delivery"];

test("S3: verify gates no longer execute the 3 governance sub-suite entries", () => {
  for (const script of VERIFY_SCRIPTS) {
    const src = read(script);
    for (const suite of SUBSET_SUITES) {
      // a bare `{ name: "test:review-bundle", cmd: [...] }` suite entry must
      // not exist（prose mentions elsewhere are fine — assert on the cmd form）.
      const entry = src.match(new RegExp(`\\{\\s*name: "${suite}",\\s*cmd:`));
      assert.equal(entry, null, `${script} must not run ${suite} as a suite entry`);
    }
    assert.ok(src.includes("test:governance"), `${script} keeps test:governance`);
  }
  // self-closeout SUITE_LINES / regression claims must not re-present the
  // governance sub-suites as separate suites（audit: SUITE_LINES lie）.
  for (const script of readdirSync(join(REPO, "scripts")).filter((f) => f.endsWith("-self-closeout.mjs"))) {
    const src = read(`scripts/${script}`);
    for (const suite of SUBSET_SUITES) {
      assert.equal(!!src.match(new RegExp(`SUITE_LINE\(\"${suite}\"\)`)), false, `${script} must not render ${suite} as a separate SUITE_LINE`);
      assert.equal(!!src.match(new RegExp(`npm run ${suite.replace(":", ":")}`)), false, `${script} must not claim ${suite} as a separate regression entry`);
    }
  }
});

test("S3: test:governance npm script covers the 3 sub-suites", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["test:governance"], "node --test test/governance/*.mjs");
  for (const f of ["test-review-bundle.mjs", "test-graph-closeout.mjs", "test-git-status-parsing.mjs", "test-external-review-delivery.mjs"]) {
    assert.ok(readFileSync(join(REPO, "test/governance", f), "utf8").length > 0, `${f} lives under test/governance/`);
  }
});

test("S4: ta3 independent review performs no suite re-execution", () => {
  const src = read("scripts/ta3-independent-review.mjs");
  // no execFileSync targeting a test suite（the only execFileSync left is the
  // IR-8 git-status parse — independent re-derivation, not a suite re-run）.
  const suiteExec = src.match(/execFileSync\([^)]*--test/);
  assert.equal(suiteExec, null, "IR must not exec a node --test suite");
  // IR-4 cross-checks the recorded accounting instead
  assert.ok(src.includes("IR-4.neg_suite_accounting_cross_check"), "IR-4 renamed to a contract cross-check");
  assert.ok(src.includes("not re-run by IR"), "IR-4 explicitly records no re-run");
  // IR-10 expects >= 6 distinct suites（no sub-suite entries）
  assert.ok(src.includes("regression.length >= 6"), "IR-10 expects distinct suites only");
});

test("S5: collect-test-accounting defaults fail-closed（no mode -> exit 2, no execution）", () => {
  const r = spawnSync("node", ["scripts/collect-test-accounting.mjs"], { cwd: REPO, encoding: "utf8" });
  assert.equal(r.status, 2, "bare invocation exits 2 without executing anything");
  assert.ok(r.stderr.includes("usage"), "usage printed");
});

test("S5: --reuse renders completed verification results WITHOUT executing tests", () => {
  const dir = mkdtempSync(join(tmpdir(), "vca1-s5-"));
  const fixture = {
    schema: "autoloop.taX-verification/v1",
    ok: true,
    regression: [
      { suite: "test:admission", tests: 76, passed: 76, failed: 0, ok: true, wallMs: 46430 },
      { suite: "test:governance", tests: 309, passed: 309, failed: 0, ok: true, wallMs: 7140 },
      { suite: "test:v2", tests: 372, passed: 372, failed: 0, ok: true, wallMs: 84860 },
    ],
  };
  const vPath = join(dir, "verification.json");
  writeFileSync(vPath, JSON.stringify(fixture));
  try {
    const r = spawnSync("node", ["scripts/collect-test-accounting.mjs", "--reuse", vPath], { cwd: REPO, encoding: "utf8" });
    assert.equal(r.status, 0, `reuse exit 0 (${r.stderr})`);
    assert.ok(r.stdout.includes('"mode":"REUSE"'));
    assert.ok(r.stdout.includes('"executed":false'));
    assert.ok(r.stdout.includes('"total":757'), "sum of completed totals reused, not re-measured");
    assert.ok(r.stdout.includes("MEASURED (by verify gate)"), "wallMs is attributed to the verify gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S10: no synthetic hardcoded timestamps remain in self-closeout scripts", () => {
  const closeouts = readdirSync(join(REPO, "scripts")).filter((f) => f.endsWith("-self-closeout.mjs"));
  assert.ok(closeouts.length >= 10, "closeout scripts present");
  for (const f of closeouts) {
    const src = read(`scripts/${f}`);
    const synthetic = src.match(/startedAt:\s*178\d{9,10}|completedAt:\s*178\d{9,10}/);
    assert.equal(synthetic, null, `${f} must not hardcode synthetic timestamps`);
  }
});

test("S2: verify gates record real startedAt/completedAt/wallMs in the summary", () => {
  for (const script of VERIFY_SCRIPTS) {
    const src = read(script);
    assert.ok(src.includes("VERIFY_STARTED_AT"), `${script} measures a real start instant`);
    assert.ok(/\.\.\.timingFields\(VERIFY_STARTED_AT, Date\.now\(\)\)/.test(src), `${script} writes timingFields into the summary`);
    assert.ok(src.includes("wallMs: r.wallMs"), `${script} records per-suite wallMs`);
    assert.ok(src.includes("timingSource: r.timingSource"), `${script} tags per-suite timing as MEASURED`);
  }
  // ta1-verify（no regression suites）records the same measured shape inline
  const ta1 = read("scripts/ta1-verify.mjs");
  assert.ok(ta1.includes("VERIFY_STARTED_AT") && ta1.includes("wallMs: Date.now() - VERIFY_STARTED_AT") && ta1.includes('timingSource: "MEASURED"'), "ta1-verify records measured timing");
});
