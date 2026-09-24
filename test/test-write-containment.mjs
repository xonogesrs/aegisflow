#!/usr/bin/env node
// test/test-write-containment.mjs
//
// Local Security Review M1 — SYMLINK WRITE CONTAINMENT regression.
//
// The defect: a write performed THROUGH a symlink that already exists in the
// worktree lands outside the repository while git reports NO changed path
// (the symlink blob is unchanged; the content went outside). The C3B scope
// gate iterates git's changed-path delta, so the write was not denied at all
// (`git diff`/`git ls-files` empty, gate ok, outside file written).
//
// This suite pins, on real git fixtures through the REAL production machinery:
//   A/C  the git-delta gate cannot see the write (reproduced, unchanged — it
//        remains the post-mutation git gate)
//   B    a declared scope entry whose path (or an existing component) is a
//        symlink — resolvable OR dangling — is DENIED
//   D    a pre-existing symlink: the mutation is refused BEFORE dispatch
//        (OUTSIDE_WRITTEN = NO)
//   E    create-then-write is refused (fail closed)
//   F    dangling symlink: denied, and stays denied once its target appears
//   G    swap-after-validation is refused by the git-INDEPENDENT layer
//   H    legal in-scope writes are untouched
//   I    the containment layer ADDS an authority boundary, it does not
//        replace the git gate
//
// Run: node --test test/test-write-containment.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

import {
  canonicalScopeEntry, canonicalScopeEntries, canonicalScopePath,
  captureScopeSnapshot, enforceScopeGate,
} from "../src/c2d/mutation-scope.mjs";
import { scanSymlinkEscapes, verifyWriteContainment, WRITE_CONTAINMENT_REASON } from "../src/c2d/write-containment.mjs";
import { runMutation } from "../src/c2d/mutation-run.mjs";
import { createMutationAuthorization } from "../src/c2d/mutation-authority.mjs";
import { collectFingerprint } from "../src/c2d/fingerprint.mjs";
import { initExecutionDir } from "../src/c2d/checkpoint-store.mjs";
import { mintExecutionId } from "../src/c2d/execution-id.mjs";
import { captureChangedPaths } from "../src/shared/git-diff-utils.mjs";

const SCRIPT_ROOT = mkdtempSync(join(tmpdir(), "wc-scripts-"));
const ROOTS = [SCRIPT_ROOT];
let scriptSeq = 0;

after(() => {
  for (const root of ROOTS) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freshDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `wc-${label}-`));
  ROOTS.push(dir);
  return dir;
}

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** Real git fixture with a committed `src/` subtree. */
function makeFixtureRepo(label) {
  const repo = freshDir(`repo-${label}`);
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "wc@test"]);
  git(repo, ["config", "user.name", "wc-fixture"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "keep.txt"), "keep\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

/** A mutation command script (exact-argv, no shell string). */
function mutationScript(body) {
  scriptSeq += 1;
  const path = join(SCRIPT_ROOT, `mut-${scriptSeq}.mjs`);
  writeFileSync(path, `import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";\n${body}\n`);
  return path;
}

/**
 * Drive the REAL C3B boundary: durable authorization artifact + isolated
 * worktree + optional mutation command + optional validation plan.
 */
async function runBoundaryMutation({ repo, script = null, allowedPaths = ["src/**"], validationPlan = null }) {
  const checkpointRoot = freshDir("ckpt");
  const fingerprint = collectFingerprint(repo);
  const executionId = mintExecutionId();
  const execDir = initExecutionDir(checkpointRoot, executionId);
  createMutationAuthorization(execDir, {
    execution_id: executionId,
    card_id: "card-write-containment",
    card_revision: "1",
    allowed_paths: allowedPaths,
    forbidden_paths: [".git/**"],
    validation_plan_id: "plan-write-containment",
    authorized_by: "test-operator",
    authorization_ref: "test://write-containment",
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  }, fingerprint);
  return runMutation({
    repoRoot: repo,
    checkpointRoot,
    actorId: "c3b-executor",
    sessionId: "sess-write-containment",
    sessionSecret: "sess-secret-write-containment",
    leaseSecret: "lease-secret-write-containment",
    executionId,
    validationPlanId: "plan-write-containment",
    validationPlan: validationPlan ?? { commands: [{ cmd: process.execPath, args: ["-e", "process.exit(0)"], timeout_ms: 30000 }] },
    mutationCommand: script ? { cmd: process.execPath, args: [script], timeout_ms: 30000 } : null,
    inputManifest: {},
  });
}

function gateEntry(evidence, gate) {
  return (evidence?.scope_checks ?? []).find((g) => g.gate === gate) ?? null;
}

function committedEscapingSymlink(repo, linkRel, targetAbs) {
  mkdirSync(dirname(join(repo, linkRel)), { recursive: true });
  symlinkSync(targetAbs, join(repo, linkRel), "dir");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", `add ${linkRel}`]);
}

// ─────────────────────────────────────────────────────────────────────────────
// A / C — the git-delta gate cannot see a write through a committed symlink
// ─────────────────────────────────────────────────────────────────────────────

test("A/C: a write through a committed symlink produces OUTSIDE_WRITTEN=YES with an EMPTY git delta and gate.ok=TRUE (reproduced)", () => {
  const repo = makeFixtureRepo("repro");
  const outside = freshDir("outside-repro");
  committedEscapingSymlink(repo, "src/escape", outside);

  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "src", "escape", "payload.txt"), "pwned\n"); // the "mutation"
  const post = captureScopeSnapshot(repo);

  assert.equal(readFileSync(join(outside, "payload.txt"), "utf8"), "pwned\n", "OUTSIDE_WRITTEN must reproduce");
  assert.equal(post.paths.size, 0, "GIT_DELTA must be EMPTY (git diff / ls-files see no changed path)");
  assert.equal(captureChangedPaths(repo).paths.size, 0, "changed-path inventory must stay empty");
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  assert.equal(gate.ok, true, "CURRENT_GATE must ALLOW (this is the defect, not the fix)");
  assert.deepEqual(gate.delta, [], "the git gate iterates an empty delta");
});

// ─────────────────────────────────────────────────────────────────────────────
// B — declared scope symlink (resolvable AND dangling) is DENIED
// ─────────────────────────────────────────────────────────────────────────────

/** HEAD's symlink-component walk (existsSync-first) — inlined so the dangling
 *  window is shown to be a real behaviour change, not asserted from memory. */
function legacySymlinkWalk(rawPath, repositoryRoot) {
  const normalized = canonicalScopePath(rawPath);
  if (!normalized) return null;
  const absolute = resolve(repositoryRoot, normalized);
  const contained = relative(repositoryRoot, absolute);
  if (!contained || contained.startsWith(".." + sep) || contained === ".." || isAbsolute(contained) || contained !== normalized) return null;
  let current = repositoryRoot;
  for (const segment of normalized.split("/")) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    try { if (lstatSync(current).isSymbolicLink()) return null; } catch { return null; }
  }
  return normalized;
}

test("B: declared scope entries with a symlink (resolvable or DANGLING) never canonicalize; canonical entries are unchanged", () => {
  const repo = makeFixtureRepo("declared");
  const outside = freshDir("outside-declared");
  committedEscapingSymlink(repo, "src/escape", outside);
  // A dangling link: its target does not exist.
  symlinkSync(join(outside, "not-yet.txt"), join(repo, "src", "dangling"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add dangling link"]);

  // Resolvable symlink: refused before and after the repair.
  assert.equal(canonicalScopeEntry("src/escape", repo), null, "resolvable symlink entry must not resolve");
  // Dangling symlink: the repair closes the existsSync-before-lstat window.
  assert.equal(canonicalScopeEntry("src/dangling", repo), null, "DANGLING symlink entry must not resolve");
  assert.equal(lstatSync(join(repo, "src", "dangling")).isSymbolicLink(), true, "fixture link is a real symlink");
  assert.equal(legacySymlinkWalk("src/dangling", repo), "src/dangling", "pre-repair (existsSync-first) ACCEPTED the dangling boundary — the regression is real");
  // Symlink as an existing COMPONENT of a deeper declared boundary.
  assert.equal(canonicalScopeEntry("src/escape/deeper", repo), null, "symlink component must not resolve");
  // The whole declared list fails closed when any entry is undecidable.
  assert.equal(canonicalScopeEntries(["src", "src/escape"], repo), null, "one symlink entry fails the whole list");
  // Legal boundary spellings are untouched.
  assert.equal(canonicalScopeEntry("src", repo), "src");
  assert.equal(canonicalScopeEntry("src/", repo), "src");
  assert.equal(canonicalScopeEntry("src/keep.txt", repo), "src/keep.txt");
  assert.equal(canonicalScopeEntry("src/not-yet-created.txt", repo), "src/not-yet-created.txt", "not-yet-existing legitimate path still resolves");
  assert.deepEqual(canonicalScopeEntries(["src", "docs"], repo), ["src", "docs"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// D — pre-existing symlink: DENIED BEFORE OUTSIDE WRITE
// ─────────────────────────────────────────────────────────────────────────────

test("D: a pre-existing (committed) symlink refuses the mutation before dispatch — OUTSIDE_WRITTEN = NO", async () => {
  const repo = makeFixtureRepo("preexisting");
  const outside = freshDir("outside-preexisting");
  committedEscapingSymlink(repo, "src/escape", outside);

  const result = await runBoundaryMutation({
    repo,
    script: mutationScript(`writeFileSync("src/escape/payload.txt", "pwned");`),
  });

  assert.equal(result.outcome_state, "SCOPE_VIOLATION", `mutation must be refused (got ${result.outcome_state})`);
  assert.equal(existsSync(join(outside, "payload.txt")), false, "OUTSIDE_WRITTEN must be NO — the command never ran");
  const pre = gateEntry(result.evidence, "pre_mutation_write_containment");
  assert.ok(pre, "the pre-execution containment gate must be recorded");
  assert.equal(pre.ok, false, "pre-execution containment must DENY");
  assert.ok(pre.violations.some((v) => v.reason === WRITE_CONTAINMENT_REASON.SYMLINK_ESCAPE && v.path === "src/escape"), `violation must name the escaping symlink: ${JSON.stringify(pre.violations)}`);
  assert.deepEqual(result.evidence.changed_paths, [], "no git delta is expected — the refusal is git-independent");
});

// ─────────────────────────────────────────────────────────────────────────────
// E — create-then-write
// ─────────────────────────────────────────────────────────────────────────────

test("E: a symlink created by the candidate and written through is refused (fail closed)", async () => {
  const repo = makeFixtureRepo("create");
  const outside = freshDir("outside-create");

  const result = await runBoundaryMutation({
    repo,
    script: mutationScript([
      `symlinkSync(${JSON.stringify(outside)}, "src/newdir", "dir");`,
      `writeFileSync("src/newdir/payload.txt", "pwned");`,
    ].join("\n")),
  });

  assert.equal(result.outcome_state, "SCOPE_VIOLATION", `create-then-write must be refused (got ${result.outcome_state})`);
  assert.notEqual(result.outcome_state, "READY_FOR_REVIEW");
  const post = gateEntry(result.evidence, "post_mutation");
  const contained = gateEntry(result.evidence, "post_mutation_write_containment");
  assert.ok(
    (post && post.ok === false) || (contained && contained.ok === false),
    `at least one post-execution layer must deny: ${JSON.stringify(result.evidence?.scope_checks)}`,
  );
  assert.ok(contained && contained.violations.some((v) => v.reason === WRITE_CONTAINMENT_REASON.SYMLINK_ESCAPE), "the filesystem layer independently names the escaping symlink");
});

// ─────────────────────────────────────────────────────────────────────────────
// F — dangling symlink
// ─────────────────────────────────────────────────────────────────────────────

test("F: a dangling symlink is denied — as a declaration, as a write target, and after its target appears", async () => {
  const repo = makeFixtureRepo("dangling");
  const outside = freshDir("outside-dangling");
  const target = join(outside, "gains-target.txt");
  symlinkSync(target, join(repo, "src", "dangle"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add dangling link"]);

  assert.equal(canonicalScopeEntry("src/dangle", repo), null, "dangling symlink declaration is DENIED");

  const first = await runBoundaryMutation({ repo, script: mutationScript(`writeFileSync("src/dangle", "pwned");`) });
  assert.equal(first.outcome_state, "SCOPE_VIOLATION", "write through the dangling link must be refused");
  assert.equal(existsSync(target), false, "the outside target must not be created");

  // The link now gains an external target — it still cannot escape.
  writeFileSync(target, "pre-existing\n");
  const second = await runBoundaryMutation({ repo, script: mutationScript(`writeFileSync("src/dangle", "pwned");`) });
  assert.equal(second.outcome_state, "SCOPE_VIOLATION", "the link stays denied once its target exists");
  assert.equal(readFileSync(target, "utf8"), "pre-existing\n", "outside content must be untouched");
});

// ─────────────────────────────────────────────────────────────────────────────
// G — TOCTOU: swap after validation
// ─────────────────────────────────────────────────────────────────────────────

test("G: a symlink swapped in after validation is caught by the git-independent layer, and the run fails closed", async () => {
  const repo = makeFixtureRepo("toctou");
  const outside = freshDir("outside-toctou");
  mkdirSync(join(repo, "src", "real"), { recursive: true });
  writeFileSync(join(repo, "src", "real", "keep.txt"), "keep\n");

  // validate: the tree is clean
  assert.equal(verifyWriteContainment({ root: repo, boundaries: ["src/**"] }).ok, true, "validation must pass on the clean tree");

  // swap: replace the leaf with a symlink pointing outside (an external actor)
  rmSync(join(repo, "src", "real"), { recursive: true, force: true });
  symlinkSync(outside, join(repo, "src", "real"), "dir");

  // the git inventory still reports NOTHING for the write path itself
  assert.equal(captureChangedPaths(repo).paths.has("src/real/payload.txt"), false, "git never names the write-through path");
  // the git-independent layer decides
  const after = verifyWriteContainment({ root: repo, boundaries: ["src/**"] });
  assert.equal(after.ok, false, "the swap must be denied after validation");
  assert.ok(after.violations.some((v) => v.reason === WRITE_CONTAINMENT_REASON.SYMLINK_ESCAPE && v.path === "src/real"));

  // end to end: a swap performed DURING the mutation is refused, never READY_FOR_REVIEW
  const swapped = makeFixtureRepo("toctou-run");
  mkdirSync(join(swapped, "src", "real"), { recursive: true });
  writeFileSync(join(swapped, "src", "real", "keep.txt"), "keep\n");
  git(swapped, ["add", "-A"]);
  git(swapped, ["commit", "-q", "-m", "add real dir"]);
  const outsideRun = freshDir("outside-toctou-run");
  const result = await runBoundaryMutation({
    repo: swapped,
    script: mutationScript([
      `rmSync("src/real", { recursive: true, force: true });`,
      `symlinkSync(${JSON.stringify(outsideRun)}, "src/real", "dir");`,
      `writeFileSync("src/real/payload.txt", "pwned");`,
    ].join("\n")),
  });
  assert.equal(result.outcome_state, "SCOPE_VIOLATION", `swap-in during mutation must fail closed (got ${result.outcome_state})`);
  assert.notEqual(result.outcome_state, "READY_FOR_REVIEW");
});

// ─────────────────────────────────────────────────────────────────────────────
// H — legal in-scope writes keep working
// ─────────────────────────────────────────────────────────────────────────────

test("H: existing/new/nested/not-yet-existing regular writes still reach READY_FOR_REVIEW", async () => {
  const repo = makeFixtureRepo("legal");
  const result = await runBoundaryMutation({
    repo,
    script: mutationScript([
      `writeFileSync("src/keep.txt", "keep-modified\\n");`,               // existing regular file
      `writeFileSync("src/new.txt", "new\\n");`,                          // new regular file
      `mkdirSync("src/a/b", { recursive: true });`,
      `writeFileSync("src/a/b/c.txt", "nested\\n");`,                     // new directory + nested file
      `mkdirSync("src/notyet", { recursive: true });`,
      `writeFileSync("src/notyet/deep.txt", "later\\n");`,                // not-yet-existing legitimate path
    ].join("\n")),
  });

  assert.equal(result.outcome_state, "READY_FOR_REVIEW", `legal in-scope writes must pass (got ${result.outcome_state}: ${JSON.stringify(result.evidence?.scope_checks)}`);
  assert.equal(gateEntry(result.evidence, "pre_mutation_write_containment").ok, true);
  assert.equal(gateEntry(result.evidence, "post_mutation_write_containment").ok, true);
  assert.equal(gateEntry(result.evidence, "post_mutation").ok, true);
  const paths = result.evidence.changed_paths.map((c) => c.path).sort();
  assert.deepEqual(paths, ["src/a/b/c.txt", "src/keep.txt", "src/new.txt", "src/notyet/deep.txt"].sort());
});

test("H: a symlink pointing INSIDE the worktree is not an escape and does not block a legal mutation", async () => {
  const repo = makeFixtureRepo("inside-link");
  symlinkSync("keep.txt", join(repo, "src", "inside-link")); // relative target, inside the worktree
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add inside link"]);

  const scan = scanSymlinkEscapes(repo);
  assert.equal(scan.ok, true, `an inside-pointing symlink is not an escape: ${JSON.stringify(scan.violations)}`);

  const result = await runBoundaryMutation({ repo, script: mutationScript(`writeFileSync("src/new.txt", "new\\n");`) });
  assert.equal(result.outcome_state, "READY_FOR_REVIEW", `legal write must pass (got ${result.outcome_state})`);
});

test("H: an ABSOLUTE inside-pointing symlink is not an escape, resolvable or dangling (OS alias normalization)", () => {
  // The root is realpath-resolved; a link target may be spelled through an OS
  // alias of the same tree (macOS: /var → /private/var, /tmp → /private/tmp).
  // Comparing the raw spellings would call an in-tree target an escape and
  // deny a legitimate mutation.
  const repo = makeFixtureRepo("inside-abs");
  mkdirSync(join(repo, "src", "sub"), { recursive: true });
  writeFileSync(join(repo, "src", "sub", "target.txt"), "t\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add sub"]);

  // Absolute, EXISTING in-tree target (spelled as the fixture path was given).
  symlinkSync(join(repo, "src", "sub", "target.txt"), join(repo, "src", "abs-link"));
  // Absolute, DANGLING in-tree target: the write that creates it stays inside.
  symlinkSync(join(repo, "src", "sub", "not-yet.txt"), join(repo, "src", "abs-dangling"));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "add absolute links"]);

  const scan = scanSymlinkEscapes(repo);
  assert.equal(
    scan.ok,
    true,
    `absolute in-tree targets (resolvable and dangling) must not be escapes: ${JSON.stringify(scan.violations)}`,
  );
  assert.equal(verifyWriteContainment({ root: repo, boundaries: ["src/**"] }).ok, true);
});

test("B/I: a declared boundary whose literal path IS a symlink is denied at the containment layer too", async () => {
  const repo = makeFixtureRepo("boundary-link");
  const outside = freshDir("outside-boundary");
  committedEscapingSymlink(repo, "src/escape", outside);

  const containment = verifyWriteContainment({ root: repo, boundaries: ["src/escape/**"] });
  assert.equal(containment.ok, false, "declared writable boundary behind a symlink must be denied");
  assert.ok(containment.violations.some((v) => v.reason === WRITE_CONTAINMENT_REASON.SYMLINK_SCOPE_COMPONENT && v.path === "src/escape"));
});

// ─────────────────────────────────────────────────────────────────────────────
// I — defense in depth: the git gate is retained, containment is additional
// ─────────────────────────────────────────────────────────────────────────────

test("I: the git-delta scope gate is unchanged and the containment layer is an ADDITIONAL denial", () => {
  const repo = makeFixtureRepo("layers");
  const outside = freshDir("outside-layers");
  committedEscapingSymlink(repo, "src/escape", outside);

  // The git gate keeps its own (blind) semantics for the empty delta...
  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "src", "escape", "payload.txt"), "pwned\n");
  const gate = enforceScopeGate(repo, baseline, captureScopeSnapshot(repo), ["src/**"], []);
  assert.equal(gate.ok, true, "git gate semantics are unchanged (it cannot see this)");

  // ...and the containment layer denies the same tree, independently.
  const containment = verifyWriteContainment({ root: repo, boundaries: ["src/**"] });
  assert.equal(containment.ok, false, "containment denies what git cannot see");

  // An omitted containment layer is never a grant: it only ever returns ok=false
  // (never a broader scope), and both gates run in the production boundary.
  assert.equal(typeof verifyWriteContainment, "function");
  assert.ok(containment.violations.every((v) => typeof v.reason === "string"));
});

// ─────────────────────────────────────────────────────────────────────────────
// Writer boundary — host-observed scope verification (no sandbox needed)
// ─────────────────────────────────────────────────────────────────────────────

test("I: the writer's host-observed scope decision denies a git-invisible symlink escape and leaves legal results clean", async () => {
  const { hostObservedScopeViolations } = await import("../src/subagent/subagent-writer-executor-adapter.mjs");

  // Legal writer result: an in-scope changed path, no symlinks anywhere.
  const legal = makeFixtureRepo("writer-legal");
  writeFileSync(join(legal, "src", "added.txt"), "ok\n");
  assert.deepEqual(
    hostObservedScopeViolations({ worktreePath: legal, mutationScope: ["src"], hostChangedPaths: ["src/added.txt"] }),
    [],
    "a legal in-scope writer result must stay clean",
  );
  // An out-of-scope changed path is still a violation (source 1).
  assert.deepEqual(
    hostObservedScopeViolations({ worktreePath: legal, mutationScope: ["src"], hostChangedPaths: ["outside.txt"] }),
    ["outside.txt"],
    "an out-of-scope changed path must remain a violation",
  );

  // Escape: a committed symlink in the worktree, with git reporting NOTHING.
  const escape = makeFixtureRepo("writer-escape");
  const outside = freshDir("outside-writer");
  committedEscapingSymlink(escape, "src/escape", outside);
  assert.equal(captureChangedPaths(escape).paths.size, 0, "git reports nothing for the writer worktree");
  const violations = hostObservedScopeViolations({ worktreePath: escape, mutationScope: ["src"], hostChangedPaths: [] });
  assert.equal(violations.length, 1, `the git-independent scan must be the one that denies: ${JSON.stringify(violations)}`);
  assert.match(violations[0], /^src\/escape \(symlink_escape\)$/);
});
