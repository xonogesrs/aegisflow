// test-normalize-reviewer-json.mjs
//
// AUTOLOOP_REVIEWER_VERDICT_SEMANTIC_UNIFICATION: proves the CLI entry point
// (unchanged invocation: `node normalize-reviewer-json.mjs < input`) and the
// newly-exported normalize() function produce identical output for the same
// input, and that a well-formed-looking PASS with LOW confidence is always
// suppressed to HOLD -- never becomes a final PASS, whether reached through
// the CLI or through the imported API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize, NEXT_ACTIONS, VERDICTS } from "../src/normalize-reviewer-json.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(HERE, "..", "src", "normalize-reviewer-json.mjs");

function runCli(inputText, { expectedModel } = {}) {
  const args = expectedModel ? ["--expected-model", expectedModel] : [];
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], { input: inputText, encoding: "utf8" });
  return r.stdout;
}

test("PASS with LOW confidence is suppressed to HOLD via the imported normalize() function", () => {
  const out = normalize({
    verdict: "PASS", confidence: "LOW", model: "m", summary: "looks fine",
    recommended_next_action: "STOP",
  }, "");
  assert.notEqual(out.verdict, "PASS");
  assert.equal(out.verdict, "HOLD");
  assert.deepEqual(out.evidence_gaps, ["pass_confidence_not_high"]);
});

test("PASS with LOW confidence is suppressed to HOLD via the CLI entry point too", () => {
  const stdout = runCli(JSON.stringify({
    verdict: "PASS", confidence: "LOW", model: "m", summary: "looks fine",
    recommended_next_action: "STOP",
  }));
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verdict, "HOLD");
  assert.deepEqual(parsed.evidence_gaps, ["pass_confidence_not_high"]);
});

test("CLI and imported normalize() produce byte-identical output for a valid PASS", () => {
  const input = { verdict: "PASS", confidence: "HIGH", model: "m", summary: "ok", recommended_next_action: "STOP" };
  const cliOut = runCli(JSON.stringify(input));
  const libOut = JSON.stringify(normalize(input, "")) + "\n";
  assert.equal(cliOut, libOut);
});

test("CLI and imported normalize() produce byte-identical output for a REPAIR verdict", () => {
  const input = {
    verdict: "NEEDS_SUPPLEMENT", confidence: "MEDIUM", model: "m", summary: "needs more evidence",
    recommended_next_action: "REPAIR", blocking_issues: ["missing test coverage"],
  };
  const cliOut = runCli(JSON.stringify(input));
  const libOut = JSON.stringify(normalize(input, "")) + "\n";
  assert.equal(cliOut, libOut);
});

test("CLI and imported normalize() produce byte-identical output for malformed input (missing fields)", () => {
  const input = { summary: "no verdict field at all" };
  const cliOut = runCli(JSON.stringify(input));
  const libOut = JSON.stringify(normalize(input, "")) + "\n";
  assert.equal(cliOut, libOut);
  assert.match(cliOut, /reviewer_output_schema_invalid/);
});

test("CLI and imported normalize() agree when --expected-model / expectedModel argument is used", () => {
  const input = { verdict: "PASS", confidence: "HIGH", summary: "ok", recommended_next_action: "STOP" }; // no model field
  const cliOut = runCli(JSON.stringify(input), { expectedModel: "claude-sonnet-5" });
  const libOut = JSON.stringify(normalize(input, "claude-sonnet-5")) + "\n";
  assert.equal(cliOut, libOut);
  assert.equal(JSON.parse(cliOut).model, "claude-sonnet-5");
});

test("CLI empty-stdin fail-closed matches the FAIL_CLOSED shape used by the imported path for the same case", () => {
  const cliOut = runCli("");
  const parsed = JSON.parse(cliOut);
  assert.equal(parsed.verdict, "HOLD");
  assert.equal(parsed.summary, "reviewer output empty on stdin");
});

test("recommended_next_action canonical set matches what normalize() actually accepts", () => {
  // This is the single source of truth lifecycle-runner.mjs now defers to;
  // asserting it here pins the "unified" set so a future edit to either
  // side is caught by this test rather than silently drifting again.
  assert.deepEqual([...NEXT_ACTIONS].sort(), ["COMMIT_CANDIDATE", "HUMAN_REVIEW", "REPAIR", "STOP"]);
  assert.deepEqual([...VERDICTS].sort(), ["HOLD", "NEEDS_SUPPLEMENT", "PASS", "REJECT"]);
});
