// test/admission/test-rb-ssg4-fr4-foundation.mjs
//
// RB-SSG4-FR4 — BOUNDED SEARCH EXECUTION FOUNDATION (coarse model).
//
// Proves the frozen RC1 model:
//   Phase A — structured-search explicit-root policy (ELIGIBLE/REJECT/INDETERMINATE)
//   Phase B — coarse Bash guard (bounded eligible, forbidden reject,
//             unknown-root fail-closed incl. `~user`, complex-form restate,
//             non-recursive compatibility)
//   Phase D — failed-strategy ladder + registry hydrate/persist round-trip
//
// Supersedes (RETIRED_BY_RC1_BOUNDARY_CHANGE): test-rb-ssg4-fr2-default-deny,
// test-rb-ssg4-r1-indirection, test-rb-ssg4-r3-indirection,
// test-rb-ssg4-r5-positional-cwd, test-rb-ssg4-r7-quote-aware-positional.

import { test } from "node:test";
import assert from "node:assert/strict";
import { governPiCommand, governStructuredSearch } from "../../src/admission/pi-command-admission.mjs";
import { createFailedStrategyRegistry, SEARCH_HOLDS } from "../../src/admission/search-scope-governor.mjs";

const HOME = "/Users/zhengfengqing";
const REPO = "/Volumes/NVM2T/Development/autoloop";

const decide = (command, cwd = REPO, registry) =>
  governPiCommand({ command, cwd, home: HOME, registry });

// ── Phase A — structured-search explicit-root policy ─────────────────────
test("A1. structured root `.` and `src` are ELIGIBLE under the repo cwd", () => {
  for (const p of [".", "src", `${REPO}/src`]) {
    const d = governStructuredSearch({ path: p, cwd: REPO, home: HOME });
    assert.equal(d.admit, true, `${p}: ${d.reason}`);
    assert.equal(d.decision, "ELIGIBLE");
  }
});

test("A2. structured root forbidden (HOME / root / user-dir) REJECTS", () => {
  for (const p of [HOME, "/", "/Users", `${HOME}/Desktop`]) {
    const d = governStructuredSearch({ path: p, cwd: REPO, home: HOME });
    assert.equal(d.admit, false, `${p}: ${d.reason}`);
    assert.equal(d.decision, "REJECT");
  }
});

test("A3. structured root that is not statically concrete is INDETERMINATE", () => {
  for (const p of ["~root", "~zhengfengqing", "$ROOT", "${ROOT}", "$(pwd)"]) {
    const d = governStructuredSearch({ path: p, cwd: REPO, home: HOME });
    assert.equal(d.admit, false, `${p}: ${d.reason}`);
    assert.equal(d.decision, "INDETERMINATE");
    assert.equal(d.holdCode, SEARCH_HOLDS.INDETERMINATE_SEARCH_ROOT);
  }
});

test("A4. structured root outside authorized scope REJECTS", () => {
  const d = governStructuredSearch({ path: `${HOME}/Downloads`, cwd: REPO, home: HOME });
  assert.equal(d.admit, false, d.reason);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_RECURSIVE_TRAVERSAL);
});

// ── Phase B — coarse Bash guard ──────────────────────────────────────────
test("B1. explicit bounded recursive search is ELIGIBLE", () => {
  for (const cmd of [
    "rg pattern src",
    "grep -R pattern test",
    "find src -name x",
    `grep -R pattern ${REPO}/src/admission`,
    "git grep foo -- src/",
  ]) {
    const d = decide(cmd);
    assert.equal(d.spawnAllowed, true, `${cmd}: ${d.reason}`);
  }
});

test("B2. explicit forbidden roots REJECT", () => {
  for (const [cmd, hold] of [
    ["grep -R x /", SEARCH_HOLDS.UNBOUNDED_FILESYSTEM_ROOT],
    [`grep -R x ${HOME}`, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL],
    ["grep -R x /Users", SEARCH_HOLDS.UNBOUNDED_USER_DIR_TRAVERSAL],
    [`find ${HOME}/Desktop -name x`, SEARCH_HOLDS.UNBOUNDED_DESKTOP_TRAVERSAL],
  ]) {
    const d = decide(cmd);
    assert.equal(d.spawnAllowed, false, `${cmd}: ${d.reason}`);
    assert.equal(d.holdCode, hold, cmd);
  }
});

test("B3. FR3 unknown-root bypasses fail closed (no ADMIT lane)", () => {
  for (const cmd of [
    "grep -R x ~root",
    "grep -R x ~zhengfengqing",
    "grep -R x ~zhengfengqing/Downloads",
    "grep -R x $ROOT",
    "grep -R x ${ROOT}",
    "grep -R x `echo /tmp`",
    "grep -R x src*",
  ]) {
    const d = decide(cmd);
    assert.equal(d.spawnAllowed, false, `${cmd}: ${d.reason}`);
    assert.notEqual(d.classification, "SAFE_BOUNDED", cmd);
  }
});

test("B4. complex indirection is REJECT/RESTATE, never reconstructed", () => {
  for (const cmd of [
    "timeout 5 grep -R x src",
    'bash -c "grep -r x src"',
    "env grep -R x src",
    "sudo grep -R x src",
    "xargs grep -R x",
    "find . -name '*.js' -exec grep -R x {} \\;",
    "echo $(find . -name foo)",
  ]) {
    const d = decide(cmd);
    assert.equal(d.spawnAllowed, false, `${cmd}: ${d.reason}`);
    assert.equal(d.holdCode, SEARCH_HOLDS.UNRESOLVED_EXECUTION_STRUCTURE, cmd);
  }
});

test("B5. non-recursive / non-search commands are not over-governed", () => {
  for (const cmd of [
    "grep -n foo file.txt",
    "ls -la",
    "echo $HOME",
    'bash -c "ls"',
    "git status",
    "cat package.json",
  ]) {
    const d = decide(cmd);
    assert.equal(d.spawnAllowed, true, `${cmd}: ${d.reason}`);
  }
});

test("B6. cd-tracking resolves literal cd but taints indeterminate cd", () => {
  assert.equal(decide(`cd ${REPO} && grep -R x .`).spawnAllowed, true);
  assert.equal(decide(`cd ${HOME} && grep -R x .`).spawnAllowed, false);
  assert.equal(decide(`cd ~otheruser && grep -R x .`).spawnAllowed, false);
  assert.equal(decide(`cd $SOMEDIR && grep -R x .`).spawnAllowed, false);
});

// ── Phase D — failed-strategy ladder + hydrate/persist ───────────────────
test("D1. failure → record → equivalent retry → REPLAN → 3rd → BLOCK", () => {
  const reg = createFailedStrategyRegistry();
  const d1 = decide("grep -R x /Users/zhengfengqing", REPO, reg);
  assert.equal(d1.spawnAllowed, false);
  assert.equal(d1.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);

  const d2 = decide("rg x /Users/zhengfengqing", REPO, reg); // same root, different tool
  assert.equal(d2.spawnAllowed, false);
  assert.equal(d2.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED, d2.reason);

  const d3 = decide("find /Users/zhengfengqing -name x", REPO, reg); // same root, different tool
  assert.equal(d3.spawnAllowed, false);
  assert.equal(d3.holdCode, SEARCH_HOLDS.SEARCH_STRATEGY_FAILED, d3.reason);
});

test("D2. a materially different bounded strategy remains usable after failure", () => {
  const reg = createFailedStrategyRegistry();
  decide("grep -R x /Users/zhengfengqing", REPO, reg); // record HOME failure
  const bounded = decide("grep -R x src", REPO, reg);
  assert.equal(bounded.spawnAllowed, true, bounded.reason);
});

test("D3. registry hydrate round-trips persisted entries", () => {
  const src = createFailedStrategyRegistry();
  src.recordFailure("fp-a", { reason: "timeout", toolFamily: "bash" });
  src.recordFailure("fp-a", { reason: "timeout", toolFamily: "bash" });

  const dst = createFailedStrategyRegistry();
  dst.hydrate(src.entries());
  assert.equal(dst.countFor("fp-a"), 2);
  assert.equal(dst.isFailed("fp-a"), true);
});
