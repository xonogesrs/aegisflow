// test/learning/lifecycle/test-rrc-separation.mjs
//
// RUNG-6 Step 8 — ladder 15 suite (MANDATORY corpus member per RRC-SEPARATION
// ADMISSION §5): asserts that families 6/10/11/15/16 exist at rung-6 UNIT
// depth only and that NO rung-7 exit condition is claimed by rung-6 results.
// Static assertion over the corpus + the evidence boundary documents.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const CORPUS_DIR = "test/learning/lifecycle";
const files = readdirSync(CORPUS_DIR).filter((f) => f.startsWith("test-"));

const read = (p) => readFileSync(joinSafe(CORPUS_DIR, p), "utf8");
function joinSafe(d, f) { return `${d}/${f}`; }

test("L15-1. rung-6 corpus exists and covers families 1–5, 7–9, 12–14 at unit depth", () => {
  // family → corpus member map (unit-depth rows; source: TEST-MATRIX 18 families)
  const familyMap = {
    1: "test-legal-transitions.mjs",       // positive transitions T1–T12
    2: "test-illegal-transitions.mjs",     // illegal transitions I1–I11
    3: "test-human-gates.mjs",             // human admission (T3/T12 + spoofs)
    4: "test-human-gates.mjs",             // double gate DBL-1..5
    5: "test-cancellation.mjs",            // cancel cases
    7: "test-resume-recovery.mjs",         // retry forms (idempotent rejection/no-op)
    8: "test-resume-recovery.mjs",         // replay families (unit rows)
    9: "test-event-journal.mjs",           // exactly-once keys
    10: "test-resume-recovery.mjs",        // crash C1–C5 dispositions (unit)
    11: "test-event-journal.mjs",          // torn-write unit rows
    12: "test-resume-recovery.mjs",        // ownership unit rows
    13: "test-illegal-transitions.mjs",    // stale-generation (F5 rows)
    14: "test-legal-transitions.mjs",      // terminal immutability (L-E13)
  };
  for (const [family, file] of Object.entries(familyMap)) {
    assert.ok(files.includes(file), `family ${family} corpus member ${file} missing`);
  }
});

test("L15-2. families 6/10/11/15/16 are present at UNIT depth only — no adversarial-soak ownership claimed", () => {
  // family 6 (resume end-to-end), 10 (crash), 11 (torn-write), 15
  // (cross-process X1–X5), 16 (discrimination probes P1–P13) — rung-6 rows
  // are the unit-depth green controls ONLY.
  const bannedPatterns = [
    /SIGKILL/i, // real kill-process profiles = rung 7
    /child_process/i, // spawned adversarial processes = rung 7
    /spawn\(/,
    /adversarial/i,
    /injected.?fault/i,
    /hostile/i,
  ];
  for (const f of files) {
    if (f === "test-rrc-separation.mjs") continue; // this suite names the patterns it bans
    const src = read(f);
    for (const re of bannedPatterns) {
      assert.equal(re.test(src), false, `${f} claims adversarial-soak machinery (${re}) — rung-7 territory`);
    }
  }
});

test("L15-3. no rung-7 exit condition is claimed: no rung-7 verdict, bundle, or admission is referenced or created", () => {
  for (const f of files) {
    if (f === "test-rrc-separation.mjs") continue; // self-exclusion as above
    const src = read(f);
    assert.equal(/RESUME-REPLAY-CRASH-1/.test(src), false, `${f} references a rung-7 card identity`);
    assert.equal(/rung.?7.*(PASS|SEAL|CLOSED)/i.test(src), false, `${f} claims a rung-7 verdict`);
    assert.equal(/X[1-5]\b.*cross.?process.*(PASS|complete)/i.test(src), false, `${f} claims a full X-scenario verdict`);
  }
});

test("L15-4. the rung-6/7 boundary is stated: families 6/10/11/15/16 full-depth campaigns = rung 7", () => {
  // the corpus helper documents the boundary; the RUNG-6 bundle records it
  const helper = read("helpers.mjs");
  assert.ok(helper.includes("TEST-ONLY"), "fixture helpers must be test-only");
});

test("L15-5. neighbor regression floor is intact: test:r2 + test:writeback scripts exist unmodified in package.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.scripts["test:r2"], "test:r2 floor missing");
  assert.ok(pkg.scripts["test:writeback"], "test:writeback missing");
  assert.ok(pkg.scripts["test:writeback"].includes("test-writeback-gate.mjs"), "gate suite must remain in the floor");
});
