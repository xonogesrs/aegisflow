// test/admission/test-pi-command-admission.mjs
//
// RB-SSG2 — regression suite for the Pi command-execution admission bridge
// (src/admission/pi-command-admission.mjs) and the `cd` tracking added to
// src/admission/search-scope-governor.mjs.
//
// Proves the coverage repair for the exact incident:
//
//   cwd=/Users/<USER>
//   grep -rl "Phase R" .
//
// which must be REJECTED as UNBOUNDED_HOME_TRAVERSAL and must never reach a
// subprocess spawn. Also covers the bypass vectors the governor must close:
// `cd $HOME && grep -rl pattern .`, `find .`, `rg pattern .`, command
// substitutions, pipelines, and cwd-relative roots — while confirming a
// narrow repo-root search remains admitted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { governPiCommand } from "../../src/admission/pi-command-admission.mjs";
import { governSearch, SEARCH_HOLDS } from "../../src/admission/search-scope-governor.mjs";

const HOME = "/Users/zhengfengqing";
const REPO = "/Volumes/NVM2T/Development/autoloop";

// ── The exact incident ───────────────────────────────────────────────────
test("exact incident: cd $HOME && grep -rl \"Phase R\" . from a HOME cwd is REJECTED", () => {
  const d = governPiCommand({ command: `cd ${HOME} && grep -rl "Phase R" .`, cwd: HOME, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.decision, "REJECT");
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
  assert.equal(d.blockReason, `search_scope_governor:${SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL}:unbounded traversal from ${HOME}: home directory`);
});

test("exact incident: grep -rl \"Phase R\" . from a HOME cwd is REJECTED", () => {
  const d = governPiCommand({ command: `grep -rl "Phase R" .`, cwd: HOME, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── cd bypass vector (invariant B) ───────────────────────────────────────
test("cd $HOME && grep -rl pattern . is REJECTED even from a bounded repo cwd", () => {
  const d = governPiCommand({ command: `cd ${HOME} && grep -rl "Phase R" .`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("cd ~ && find . is REJECTED even from a bounded repo cwd", () => {
  const d = governPiCommand({ command: "cd ~ && find .", cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── Tool-agnostic unbounded roots from a HOME cwd ────────────────────────
for (const [label, command] of [
  ["find .", "find ."],
  ["find . -name foo", "find . -name foo"],
  ["rg pattern .", "rg pattern ."],
  ["grep -r pattern .", "grep -r pattern ."],
  ["grep -rl pattern .", "grep -rl pattern ."],
]) {
  test(`from a HOME cwd, "${command}" is REJECTED as UNBOUNDED_HOME_TRAVERSAL`, () => {
    const d = governPiCommand({ command, cwd: HOME, home: HOME });
    assert.equal(d.spawnAllowed, false, d.reason);
    assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
    assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL, label);
  });
}

// ── Command substitution / backtick / pipeline vectors ───────────────────
test("command substitution $(find . ...) from a HOME cwd is REJECTED", () => {
  const d = governPiCommand({ command: "echo $(find . -name foo)", cwd: HOME, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("backtick substitution `find .` from a HOME cwd is REJECTED", () => {
  const d = governPiCommand({ command: "FILES=`find . -name foo`", cwd: HOME, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("pipeline grep -rl pattern . | head from a HOME cwd is REJECTED (| head is not a boundary)", () => {
  const d = governPiCommand({ command: "grep -rl pattern . | head", cwd: HOME, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── cwd-relative roots resolve against the post-`cd` directory ───────────
test("cwd-relative root `.` after `cd $HOME` resolves to HOME and is REJECTED", () => {
  const d = governPiCommand({ command: `cd ${HOME} && grep -rl pattern .`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── Narrow repo-root search remains admitted ─────────────────────────────
test("narrow repo-root recursive grep under the session cwd is ADMITTED", () => {
  const d = governPiCommand({ command: `grep -rl "Phase R" ${REPO}/src/admission`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
  assert.equal(d.decision, "ADMIT");
});

test("cwd-relative recursive grep from a repo cwd is ADMITTED (bounded by the repo root)", () => {
  const d = governPiCommand({ command: "grep -rl pattern .", cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
});

test("find with an exclusion boundary in the repo is ADMITTED", () => {
  const d = governPiCommand({
    command: `find ${REPO}/src -name '*.mjs' -not -path '*/node_modules/*'`,
    cwd: REPO,
    home: HOME,
  });
  assert.equal(d.spawnAllowed, true, d.reason);
});

test("rg --max-depth bounded search in the repo is ADMITTED", () => {
  const d = governPiCommand({ command: `rg --max-depth 3 foo ${REPO}/src`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
});

// ── Non-search commands are untouched ────────────────────────────────────
for (const command of ["ls -la", "git status", "node --test test/admission/test-search-scope-governor.mjs", "cat package.json", "cd src && pwd"]) {
  test(`non-search command "${command}" is admitted (NOT_A_SEARCH_COMMAND)`, () => {
    const d = governPiCommand({ command, cwd: HOME, home: HOME });
    assert.equal(d.spawnAllowed, true, d.reason);
  });
}

// ── Rejected commands never reach spawn ──────────────────────────────────
test("the admission seam blocks rejected commands BEFORE any spawn (spawn counter)", () => {
  // Mirrors the extension seam: govern first, then spawn only if admitted.
  let spawnCount = 0;
  const spawn = () => { spawnCount += 1; };
  const rejectedCommands = [
    `cd ${HOME} && grep -rl "Phase R" .`,
    "find .",
    "rg pattern .",
    "grep -rl pattern .",
    "echo $(find . -name foo)",
  ];
  for (const command of rejectedCommands) {
    const d = governPiCommand({ command, cwd: HOME, home: HOME });
    assert.equal(d.spawnAllowed, false, `${command}: ${d.reason}`);
    if (d.spawnAllowed) spawn(); // would only run if the gate admitted
  }
  assert.equal(spawnCount, 0, "no rejected command may reach spawn");

  const admitted = governPiCommand({ command: "grep -rl pattern .", cwd: REPO, home: HOME });
  assert.equal(admitted.spawnAllowed, true);
  if (admitted.spawnAllowed) spawn();
  assert.equal(spawnCount, 1, "an admitted command may spawn");
});

// ── cd tracking is deterministic and does not leak across calls ──────────
test("governSearch cd tracking is per-invocation (no state leak)", () => {
  const first = governSearch({ command: `cd ${HOME} && grep -rl x .`, cwd: REPO, home: HOME, authorizedRoots: [REPO] });
  const second = governSearch({ command: "grep -rl x .", cwd: REPO, home: HOME, authorizedRoots: [REPO] });
  assert.equal(first.decision, "REJECT");
  assert.equal(second.decision, "ADMIT");
});
