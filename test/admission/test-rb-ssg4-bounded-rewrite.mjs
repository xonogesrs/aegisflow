// test/admission/test-rb-ssg4-bounded-rewrite.mjs
//
// RB-SSG4 — BOUNDED SEARCH REWRITE / PROGRESSIVE WIDENING CONVERGENCE.
//
// Mechanical proof of the hard invariant:
//
//   UNSAFE_SEARCH_REQUEST != DEAD_END
//
// while preserving:
//
//   UNBOUNDED / UNSAFE RECURSIVE TRAVERSAL MUST NOT SPAWN
//
// The governor must NOT merely deny a recursive search that is too broad; it
// must, when a safe bounded equivalent can be mechanically derived, route to
// that bounded strategy (rewrite), and only fail closed (REPLAN) when no safe
// equivalent exists. A materially equivalent repeated strategy must transition
// SEARCH_STRATEGY_FAILED -> REPLAN_REQUIRED -> mechanical block, never an
// infinite denial/retry loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { governPiCommand } from "../../src/admission/pi-command-admission.mjs";
import {
  governSearch,
  createFailedStrategyRegistry,
  deriveSafeSearchReplacement,
  buildSearchGovernorTelemetry,
  SEARCH_HOLDS,
  SEARCH_CLASSIFICATIONS,
  WIDENING_LEVELS,
  REWRITE_STRATEGIES,
} from "../../src/admission/search-scope-governor.mjs";

const HOME = "/Users/zhengfengqing";
const REPO = "/Volumes/NVM2T/Development/autoloop";
const DEV = "/Volumes/NVM2T/Development";

/** Mirror the Pi extension pre-spawn seam: govern, then spawn only what is admitted. */
function simulateSpawn(command, opts = {}) {
  const decision = governPiCommand({ command, cwd: REPO, home: HOME, ...opts });
  const spawned = [];
  // The extension mutates event.input.command to the re-admitted rewrite and
  // lets it spawn; the unsafe original is never spawned.
  if (decision.rewrittenCommand) spawned.push(decision.rewrittenCommand);
  else if (decision.spawnAllowed) spawned.push(command);
  return { decision, spawned };
}

// ── A / B / C / D / E: rewrite derivation + boundary containment ─────────
test("A. grep -R over HOME does not spawn", () => {
  const d = governPiCommand({ command: `grep -R foo ${HOME}`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE);
});

test("B. grep -R over Development does not spawn", () => {
  const { decision, spawned } = simulateSpawn(`grep -R symbol ${DEV}`);
  assert.equal(decision.spawnAllowed, false, decision.reason);
  assert.equal(decision.holdCode, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION);
  // the unsafe original must not spawn; only the rewrite may
  assert.ok(!spawned.includes(`grep -R symbol ${DEV}`), "unsafe original spawned");
});

test("C. unsafe recursive search with a known authoritative repo is rewritten to a bounded equivalent", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.equal(d.decision, "REJECT");
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE);
  assert.equal(d.replacement.strategy, REWRITE_STRATEGIES.BOUNDED_GREP);
  assert.equal(d.replacement.wideningLevel, WIDENING_LEVELS.BOUNDED_SURFACE);
  assert.match(d.replacement.command, /^grep /);
  assert.equal(d.replacementAdmitted, true);
});

test("C2. find over Development is rewritten to a bounded find", () => {
  const d = governPiCommand({ command: `find ${DEV} -name foo`, cwd: REPO, home: HOME });
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE);
  assert.equal(d.replacement.strategy, REWRITE_STRATEGIES.BOUNDED_FIND);
  assert.equal(d.replacement.wideningLevel, WIDENING_LEVELS.BOUNDED_SURFACE);
  assert.equal(d.replacementAdmitted, true);
});

test("D. rewritten command stays inside the authoritative root", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.equal(d.replacement.authoritativeRoot, REPO);
  assert.ok(d.replacement.command.includes(REPO), d.replacement.command);
});

test("E. rewritten command applies required exclusions", () => {
  const d = governPiCommand({ command: `find ${DEV} -name foo`, cwd: REPO, home: HOME });
  assert.ok(d.replacement.exclusions.includes("node_modules"));
  assert.ok(d.replacement.command.includes("node_modules"), d.replacement.command);
  assert.ok(d.replacement.command.includes("-not -path"), d.replacement.command);
});

// ── F / G / H: admission classes ─────────────────────────────────────────
test("F. git grep bounded authoritative repo is admitted", () => {
  const d = governPiCommand({ command: `git -C ${REPO} grep -n foo`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SAFE_BOUNDED);
});

test("G. bounded rg is admitted", () => {
  const d = governPiCommand({ command: `rg --max-depth 3 foo ${REPO}/src`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SAFE_BOUNDED);
});

test("H. no known safe root -> fail closed, not guessed", () => {
  const d = governPiCommand({ command: `grep -R foo ${HOME}`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE);
  assert.equal(d.replacement, null);
  assert.equal(d.rewrittenCommand, null);
});

// ── I / J / K / W: progressive widening ladder ───────────────────────────
test("I. progressive widening starts narrow (LEVEL 3 bounded filesystem search for content search)", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.equal(d.replacement.wideningLevel, WIDENING_LEVELS.BOUNDED_SURFACE);
  assert.ok(d.replacement.wideningLevel < WIDENING_LEVELS.NEIGHBORING_SCOPE);
});

test("J. widening requires a known authoritative root (evidence), never fabricated", () => {
  // No candidate under HOME -> no rewrite is derived at all.
  const r = deriveSafeSearchReplacement(
    { family: "grep", recursive: true, roots: [HOME], pattern: "x", raw: `grep -R x ${HOME}` },
    { cwd: REPO, home: HOME, authoritativeRoots: [REPO] },
  );
  assert.equal(r.ok, false);
  assert.match(r.reason, /no_safe_narrowing_target|no_authoritative_root_known/);
});

test("K. widening does not jump directly to HOME/Development", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.notEqual(d.replacement.authoritativeRoot, DEV);
  assert.notEqual(d.replacement.authoritativeRoot, HOME);
  assert.equal(d.replacement.authoritativeRoot, REPO);
});

test("W. failed rewrite does not silently broaden scope (narrowing only)", () => {
  // When the requested root is a SUBDIRECTORY of the authoritative root,
  // rewriting to the authoritative root would be WIDENING — the governor must
  // NOT do it; it fails closed instead of broadening.
  const d = governSearch({
    command: `grep -R symbol ${REPO}/src`,
    cwd: REPO,
    home: HOME,
    authoritativeRoots: [REPO],
  });
  assert.equal(d.decision, "REJECT");
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE);
  assert.equal(d.replacement, null);
});

// ── L / M / N / O / P: repeated-strategy / no-progress governor ──────────
test("L. first failed recursive strategy records a failure", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name a`, home: HOME, cwd: REPO, registry });
  assert.equal(registry.size, 1);
  const fp = governSearch({ command: `find ${HOME} -name a`, home: HOME, cwd: REPO, registry: createFailedStrategyRegistry() }).fingerprint;
  assert.ok(fp);
});

test("M. second overlapping strategy requires REPLAN", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name a`, home: HOME, cwd: REPO, registry });
  const d = governSearch({ command: `find ${HOME} -name b`, home: HOME, cwd: REPO, registry });
  assert.equal(d.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
  assert.equal(d.replanRequired, true);
});

test("N. third equivalent traversal is mechanically blocked", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name a`, home: HOME, cwd: REPO, registry });
  governSearch({ command: `find ${HOME} -name b`, home: HOME, cwd: REPO, registry });
  const d = governSearch({ command: `find ${HOME} -name c`, home: HOME, cwd: REPO, registry });
  assert.equal(d.holdCode, SEARCH_HOLDS.SEARCH_STRATEGY_FAILED);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
});

test("O. superficial query change does not evade repeated-strategy detection", () => {
  const registry = createFailedStrategyRegistry();
  const a = governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: REPO, registry });
  const b = governSearch({ command: `rg bar ${HOME}`, home: HOME, cwd: REPO, registry });
  const c = governSearch({ command: `grep -rls baz ${HOME}`, home: HOME, cwd: REPO, registry });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(b.fingerprint, c.fingerprint);
  assert.equal(b.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(c.holdCode, SEARCH_HOLDS.SEARCH_STRATEGY_FAILED);
});

test("P. a different legitimate bounded search remains allowed after a failure", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name x`, home: HOME, cwd: REPO, registry });
  const d = governSearch({ command: `rg --max-depth 3 x ${REPO}/src`, home: HOME, cwd: REPO, registry });
  assert.equal(d.admit, true);
  assert.equal(registry.size, 1); // bounded ADMIT does not poison the registry
});

// ── Q / R: hidden traversal vectors ──────────────────────────────────────
test("Q. pipeline-hidden recursive traversal is intercepted", () => {
  const d = governPiCommand({ command: `echo hi | grep -r foo ${HOME}`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("R. bash -c recursive traversal cannot bypass the governor", () => {
  // FR4 — nested shell execution is REJECT/RESTATE (UNRESOLVED_EXECUTION_STRUCTURE),
  // not descended into and reconstructed.
  const d1 = governPiCommand({ command: `bash -c "grep -r foo ${HOME}"`, cwd: REPO, home: HOME });
  assert.equal(d1.spawnAllowed, false, d1.reason);
  assert.equal(d1.holdCode, SEARCH_HOLDS.UNRESOLVED_EXECUTION_STRUCTURE);

  const d2 = governPiCommand({ command: `sh -c "find ${DEV} -name foo"`, cwd: REPO, home: HOME });
  assert.equal(d2.spawnAllowed, false, d2.reason);
  assert.equal(d2.holdCode, SEARCH_HOLDS.UNRESOLVED_EXECUTION_STRUCTURE);
});

// ── S / T / U / V: pre-spawn rewrite acceptance ──────────────────────────
test("S. replacement command itself is re-admitted before spawn", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.equal(d.replacementAdmitted, true);
  const recheck = governPiCommand({ command: d.replacement.command, cwd: REPO, home: HOME });
  assert.equal(recheck.spawnAllowed, true, recheck.reason);
});

test("T. unsafe original command never reaches the spawn spy", () => {
  const { decision, spawned } = simulateSpawn(`grep -R symbol ${DEV}`);
  assert.equal(decision.spawnAllowed, false);
  assert.ok(!spawned.includes(`grep -R symbol ${DEV}`), "unsafe original reached spawn");
  assert.equal(decision.rewrittenCommand, decision.replacement.command);
});

test("U. bounded replacement reaches the spawn spy exactly once", () => {
  const { decision, spawned } = simulateSpawn(`grep -R symbol ${DEV}`);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0], decision.rewrittenCommand);
});

test("V. search intent/context survives the rewrite", () => {
  const d = governPiCommand({ command: `grep -R "Phase R" ${DEV}`, cwd: REPO, home: HOME });
  assert.ok(d.replacement.command.includes("Phase R"), d.replacement.command);
});

// ── X: existing safe-search behavior does not regress ────────────────────
test("X. narrow repo-root recursive grep under the session cwd is still admitted", () => {
  const d = governPiCommand({ command: `grep -rl "Phase R" ${REPO}/src/admission`, cwd: REPO, home: HOME });
  assert.equal(d.spawnAllowed, true, d.reason);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SAFE_BOUNDED);
});

// ── Telemetry (section 12) ───────────────────────────────────────────────
test("telemetry records classification + rewrite + widening without raw payload", () => {
  const d = governPiCommand({ command: `grep -R symbol ${DEV}`, cwd: REPO, home: HOME });
  assert.equal(d.telemetry.schema, "autoloop.search-governor-telemetry/v1");
  assert.equal(d.telemetry.classification, SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE);
  assert.equal(d.telemetry.rewriteStrategy, REWRITE_STRATEGIES.BOUNDED_GREP);
  assert.equal(d.telemetry.wideningLevel, WIDENING_LEVELS.BOUNDED_SURFACE);
  assert.equal(d.telemetry.executionOutcome, "rewritten");
  assert.equal(d.telemetry.commandFamily, "grep");
  assert.ok(!JSON.stringify(d.telemetry).includes("symbol"), "raw pattern leaked into telemetry");
});

test("buildSearchGovernorTelemetry is a pure structured envelope", () => {
  const t = buildSearchGovernorTelemetry(
    { intent: "find owner of runStateDrivenCloseout" },
    { admit: false, decision: "REJECT", classification: "NON_REWRITABLE_UNSAFE", holdCode: "UNBOUNDED_HOME_TRAVERSAL", segments: [{ family: "grep", roots: [HOME] }], replacement: null, wideningLevel: null, replanRequired: true, repeatedStrategyCount: 2 },
  );
  assert.equal(t.intent, "find owner of runStateDrivenCloseout");
  assert.equal(t.executionOutcome, "rejected");
  assert.equal(t.replanTrigger, true);
  assert.equal(t.repeatedStrategyCount, 2);
});

// ── Section 11: real Pi-path acceptance (production-equivalent seam) ─────
test("real Pi-path: unsafe search intercepted, bounded alternative derived, admitted, and it alone spawns", () => {
  // 1. Pi proposes an unsafe recursive search.
  const proposed = `grep -R "runStateDrivenCloseout" ${DEV}`;
  const { decision, spawned } = simulateSpawn(proposed);

  // 2. intercepted before spawn.
  assert.equal(decision.spawnAllowed, false);
  // 3. safe bounded alternative derived.
  assert.equal(decision.classification, SEARCH_CLASSIFICATIONS.REWRITABLE_UNSAFE);
  assert.ok(decision.rewrittenCommand);
  // 4. alternative passes admission.
  assert.equal(decision.replacementAdmitted, true);
  // 5. alternative is the only command reaching spawn.
  assert.deepEqual(spawned, [decision.rewrittenCommand]);
  // 6. Agent receives structured result sufficient to continue.
  assert.equal(decision.replacement.authoritativeRoot, REPO);
  assert.ok(decision.reason.length > 0);
  assert.ok(decision.replacement.reason.length > 0);
});

test("real Pi-path: repeated unsafe search transitions SEARCH_STRATEGY_FAILED -> REPLAN_REQUIRED (no infinite retry)", () => {
  const registry = createFailedStrategyRegistry();
  const run = (cmd) => governPiCommand({ command: cmd, cwd: REPO, home: HOME, registry });

  const first = run(`grep -R foo ${HOME}`);
  assert.equal(first.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
  assert.equal(first.classification, SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE);

  const second = run(`rg foo ${HOME}`);
  assert.equal(second.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(second.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
  assert.equal(second.replanRequired, true);

  const third = run(`grep -rls bar ${HOME}`);
  assert.equal(third.holdCode, SEARCH_HOLDS.SEARCH_STRATEGY_FAILED);
  assert.equal(third.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
});
