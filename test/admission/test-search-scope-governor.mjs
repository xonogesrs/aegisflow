// test/admission/test-search-scope-governor.mjs
//
// RB-SSG — regression suite for the SEARCH-SCOPE / RECURSIVE-TRAVERSAL
// GOVERNOR (src/admission/search-scope-governor.mjs).
//
// Reproduces the incident class SEARCH_SCOPE_EXPANSION /
// UNBOUNDED_RECURSIVE_TRAVERSAL and proves invariants A–G:
//
//   1. `find /Users/<user> -name foo`            -> REJECT UNBOUNDED_HOME_TRAVERSAL
//   2. `find /Users/<user> -name foo | head`     -> still REJECT (| head is not a boundary)
//   3. HOME-wide failed `find foo`, then `find bar` -> REPLAN_REQUIRED;
//      a third equivalent attempt -> SEARCH_STRATEGY_FAILED (mechanical block)
//   4. failed HOME-wide `find`, then recursive `rg`/`grep` -> still recognized as the same failed strategy
//   5. narrow known repo subtree with exclusions -> ADMIT
//   6. `git grep` / tracked-file lookup          -> ADMIT
//   7. bounded miss then smaller/replanned authoritative lookup -> ADMIT

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  governSearch,
  createFailedStrategyRegistry,
  classifySearchRoot,
  parseSearchCommand,
  strategyFingerprint,
  assertAuthorizedPathsBounded,
  SEARCH_HOLDS,
  SEARCH_CLASSIFICATIONS,
  ROOT_KINDS,
  DEFAULT_EXCLUSIONS,
} from "../../src/admission/search-scope-governor.mjs";

const HOME = "/Users/testuser";
const REPO = "/repo";
const CWD = "/repo";

// ── 1 & 2: unbounded HOME traversal is rejected; filtering / output limits
// are not boundaries ──────────────────────────────────────────────────────
test("find over HOME is rejected as UNBOUNDED_HOME_TRAVERSAL", () => {
  const d = governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD });
  assert.equal(d.admit, false);
  assert.equal(d.decision, "REJECT");
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("find over HOME piped to head is STILL rejected (| head is not a boundary)", () => {
  const d = governSearch({ command: `find ${HOME} -name foo | head`, home: HOME, cwd: CWD });
  assert.equal(d.admit, false);
  assert.equal(d.decision, "REJECT");
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── 3: repeated HOME-wide find with a different filename ────────────────
test("HOME-wide failed find foo then HOME-wide find bar => REPLAN_REQUIRED then SEARCH_STRATEGY_FAILED", () => {
  const registry = createFailedStrategyRegistry();
  const first = governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD, registry });
  assert.equal(first.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
  assert.equal(first.classification, SEARCH_CLASSIFICATIONS.NON_REWRITABLE_UNSAFE);
  assert.equal(registry.size, 1);

  const second = governSearch({ command: `find ${HOME} -name bar`, home: HOME, cwd: CWD, registry });
  assert.equal(second.admit, false);
  assert.equal(second.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(second.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
  assert.equal(second.replanRequired, true);

  const third = governSearch({ command: `find ${HOME} -name baz`, home: HOME, cwd: CWD, registry });
  assert.equal(third.admit, false);
  assert.equal(third.holdCode, SEARCH_HOLDS.SEARCH_STRATEGY_FAILED);
  assert.equal(third.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
});

// ── 4: tool switch (find → rg → grep) must NOT reset a failed strategy ──
test("failed HOME-wide find then HOME-wide recursive rg => REPLAN_REQUIRED", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD, registry });
  const d = governSearch({ command: `rg foo ${HOME}`, home: HOME, cwd: CWD, registry });
  assert.equal(d.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
});

test("failed HOME-wide find then HOME-wide recursive grep => REPLAN_REQUIRED", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD, registry });
  const d = governSearch({ command: `grep -rls foo ${HOME}`, home: HOME, cwd: CWD, registry });
  assert.equal(d.holdCode, SEARCH_HOLDS.REPLAN_REQUIRED);
  assert.equal(d.classification, SEARCH_CLASSIFICATIONS.SEARCH_STRATEGY_FAILED);
});

test("rg with no path from a HOME cwd is an unbounded HOME traversal", () => {
  const d = governSearch({ command: "rg foo", home: HOME, cwd: HOME });
  assert.equal(d.admit, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

// ── 5: narrow known subtree WITH exclusions is admitted ─────────────────
test("narrow repo subtree with exclusions => ADMIT", () => {
  const d = governSearch({ command: `find ${REPO}/src -name '*.mjs' -not -path '*/node_modules/*' -not -path '*/.git/*'`, home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
  assert.equal(d.decision, "ADMIT");
  assert.equal(d.holdCode, null);
});

test("narrow repo subtree with -maxdepth is admitted (maxdepth is a boundary)", () => {
  const d = governSearch({ command: `find ${REPO}/src -maxdepth 2 -name foo`, home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
});

test("rg with --max-depth over a narrow subtree is admitted", () => {
  const d = governSearch({ command: `rg --max-depth 3 foo ${REPO}/src`, home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
});

test("grep -r with --exclude-dir over a narrow subtree is admitted", () => {
  const d = governSearch({ command: `grep -r --exclude-dir node_modules foo ${REPO}/src`, home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
});

// ── 6: tracked / indexed lookups are admitted ───────────────────────────
test("git grep inside the repo => ADMIT (tracked-indexed)", () => {
  const d = governSearch({ command: "git grep foo -- src/", home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
  assert.equal(d.segments[0].boundaryKind, "tracked-indexed");
});

test("git ls-files => ADMIT (tracked-indexed)", () => {
  const d = governSearch({ command: "git ls-files -- 'src/**'", home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
  assert.equal(d.segments[0].boundaryKind, "tracked-indexed");
});

// ── 7: bounded miss then smaller / replanned authoritative lookup ───────
test("bounded miss followed by a smaller authoritative lookup is admitted (never blocks)", () => {
  const registry = createFailedStrategyRegistry();
  const first = governSearch({ command: `rg --max-depth 2 foo ${REPO}/src`, home: HOME, cwd: CWD, registry });
  assert.equal(first.admit, true);
  assert.equal(registry.size, 0); // bounded misses are NOT failed strategies

  const replan = governSearch({ command: `git grep foo -- ${REPO}/src/`, home: HOME, cwd: CWD, registry });
  assert.equal(replan.admit, true);
  assert.equal(registry.size, 0);
});

// ── Extra invariant coverage ────────────────────────────────────────────
test("find over the filesystem root is rejected", () => {
  const d = governSearch({ command: "find / -name foo", home: HOME, cwd: CWD });
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_FILESYSTEM_ROOT);
});

test("find over Desktop-as-a-whole is rejected", () => {
  const d = governSearch({ command: `find ${HOME}/Desktop -name foo`, home: HOME, cwd: CWD });
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_DESKTOP_TRAVERSAL);
});

test("find over the multi-user parent (/Users) is rejected", () => {
  const d = governSearch({ command: "find /Users -name foo", home: HOME, cwd: CWD });
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_USER_DIR_TRAVERSAL);
});

test("another user's home dir is rejected as HOME traversal", () => {
  const d = governSearch({ command: "find /Users/otheruser -name foo", home: HOME, cwd: CWD });
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("recursive find over a narrow subtree WITHOUT boundary/declaration => MISSING_SEARCH_DECLARATION", () => {
  const d = governSearch({ command: `find ${REPO}/src -name foo`, home: HOME, cwd: CWD });
  assert.equal(d.admit, false);
  assert.equal(d.holdCode, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION);
});

test("recursive find with a valid pre-execution declaration => ADMIT", () => {
  const d = governSearch({
    command: `find ${REPO}/src -name foo`,
    home: HOME,
    cwd: CWD,
    declaration: {
      root: `${REPO}/src`,
      why: "authoritative repo subtree (the only known implementation surface)",
      boundary: "exclusions: node_modules, .git",
    },
  });
  assert.equal(d.admit, true);
  assert.equal(d.segments[0].boundaryKind, "declaration");
});

test("recursive find whose declaration names the wrong root is rejected", () => {
  const d = governSearch({
    command: `find ${REPO}/src -name foo`,
    home: HOME,
    cwd: CWD,
    declaration: { root: "/elsewhere", why: "wrong", boundary: "none" },
  });
  assert.equal(d.holdCode, SEARCH_HOLDS.MISSING_SEARCH_DECLARATION);
});

test("explicit subtree allowlist admits a recursive search under an approved root", () => {
  const d = governSearch({
    command: `find ${REPO}/src -name foo`,
    home: HOME,
    cwd: CWD,
    authorizedRoots: [`${REPO}/src`],
  });
  assert.equal(d.admit, true);
  assert.equal(d.segments[0].boundaryKind, "allowlist");
});

test("a non-search command is not governed (NOT_A_SEARCH_COMMAND)", () => {
  const d = governSearch({ command: "node --test test/x.mjs", home: HOME, cwd: CWD });
  assert.equal(d.admit, true);
  assert.equal(d.decision, "NOT_A_SEARCH_COMMAND");
});

// ── Fingerprint semantics (invariant E) ─────────────────────────────────
test("fingerprint ignores filename (foo vs bar) and tool (find vs rg)", () => {
  const a = governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD });
  const b = governSearch({ command: `find ${HOME} -name bar`, home: HOME, cwd: CWD });
  const c = governSearch({ command: `rg bar ${HOME}`, home: HOME, cwd: CWD });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, c.fingerprint);
});

test("different traversal root => different fingerprint", () => {
  const a = governSearch({ command: `find ${HOME} -name foo`, home: HOME, cwd: CWD });
  const b = governSearch({ command: `find ${REPO}/src -name foo`, home: HOME, cwd: CWD });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("strategyFingerprint + parseSearchCommand round-trip", () => {
  const parsed = parseSearchCommand(`find ${HOME} -name foo`, { home: HOME, cwd: CWD });
  assert.equal(parsed.family, "find");
  assert.equal(parsed.recursive, true);
  assert.deepEqual(parsed.roots, [HOME]);
  const fp = strategyFingerprint(parsed, { home: HOME, cwd: CWD });
  assert.match(fp, /^[0-9a-f]{64}$/);
});

// ── classification + envelope helper ────────────────────────────────────
test("classifySearchRoot maps the forbidden root classes", () => {
  assert.equal(classifySearchRoot(HOME, { home: HOME }).kind, ROOT_KINDS.HOME);
  assert.equal(classifySearchRoot(`${HOME}/Desktop`, { home: HOME }).kind, ROOT_KINDS.DESKTOP);
  assert.equal(classifySearchRoot("/", { home: HOME }).kind, ROOT_KINDS.FILESYSTEM_ROOT);
  assert.equal(classifySearchRoot("/Users", { home: HOME }).kind, ROOT_KINDS.USER_DIR);
  assert.equal(classifySearchRoot(`${REPO}/src`, { home: HOME }).kind, ROOT_KINDS.BOUNDED);
});

test("assertAuthorizedPathsBounded rejects unbounded absolute envelope paths, allows bounded/relative", () => {
  assert.equal(assertAuthorizedPathsBounded([`${HOME}`, "/"], { home: HOME }).ok, false);
  const ok = assertAuthorizedPathsBounded(["/src", "/scratch", "src/a.mjs", `${REPO}/src`], { home: HOME });
  assert.equal(ok.ok, true);
});

test("DEFAULT_EXCLUSIONS covers the incident's generated/transient trees", () => {
  for (const e of [".git", "node_modules", "target", "dist", "build", "cache", "tmp"]) {
    assert.ok(DEFAULT_EXCLUSIONS.includes(e), `missing default exclusion ${e}`);
  }
});

// ── Review hardening: bypass vectors + lifecycle ─────────────────────────
test("declaration cannot authorize a forbidden broad root", () => {
  const d = governSearch({
    command: `find ${HOME} -name foo`,
    home: HOME,
    cwd: CWD,
    declaration: { root: HOME, why: "claimed authoritative", boundary: "maxdepth 1" },
  });
  assert.equal(d.decision, "REJECT");
  assert.equal(d.holdCode, SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL);
});

test("../ and /. traversal collapse onto the forbidden root", () => {
  assert.equal(
    governSearch({ command: "find /Users/foo/.. -name x", home: HOME, cwd: CWD }).holdCode,
    SEARCH_HOLDS.UNBOUNDED_USER_DIR_TRAVERSAL,
  );
  assert.equal(
    governSearch({ command: "find /Users/foo/. -name x", home: HOME, cwd: CWD }).holdCode,
    SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL,
  );
});

test("failed-strategy registry has a reset lifecycle (no indefinite poisoning)", () => {
  const registry = createFailedStrategyRegistry();
  governSearch({ command: `find ${HOME} -name a`, home: HOME, cwd: CWD, registry });
  assert.equal(registry.size, 1);
  assert.equal(
    governSearch({ command: `find ${HOME} -name b`, home: HOME, cwd: CWD, registry }).holdCode,
    SEARCH_HOLDS.REPLAN_REQUIRED,
  );
  registry.reset();
  assert.equal(registry.size, 0);
  assert.equal(
    governSearch({ command: `find ${HOME} -name c`, home: HOME, cwd: CWD, registry }).holdCode,
    SEARCH_HOLDS.UNBOUNDED_HOME_TRAVERSAL,
  );
});

test("bounded ADMIT decisions never record a failed strategy (no false poisoning)", () => {
  const registry = createFailedStrategyRegistry();
  const d = governSearch({ command: `find ${REPO}/src -maxdepth 2 -name x`, home: HOME, cwd: CWD, registry });
  assert.equal(d.admit, true);
  assert.equal(registry.size, 0);
});
