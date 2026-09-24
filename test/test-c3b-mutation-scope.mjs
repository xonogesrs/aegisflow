#!/usr/bin/env node
// C3B mutation scope enforcer tests — card §12 "Scope" items 8-17.

import { mkdirSync, writeFileSync, unlinkSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const C2D = resolve(HERE, "..", "src", "c2d");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL: ${name} — ${e.message}\n${e.stack}`); }
}
function assert(c, m) { if (!c) throw new Error(m || "assert"); }

const { canonicalRepositoryPath, canonicalScopeEntries, canonicalScopeEntry, enforceScopeGate, isWithinCanonicalScope, captureScopeSnapshot } = await import(join(C2D, "mutation-scope.mjs"));

function mkTemp(name) {
  const r = join(tmpdir(), `c3b-scope-${name}-${randomBytes(3).toString("hex")}`);
  mkdirSync(r, { recursive: true });
  return r;
}
function mkGit(dir) {
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src", "sub", "dir"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "a\n");
  writeFileSync(join(dir, "outside.txt"), "o\n");
  writeFileSync(join(dir, "will-delete.txt"), "d\n");
  writeFileSync(join(dir, "will-rename.txt"), "r\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "i"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function violationReasons(v) { return v.map((x) => x.reason); }

test("8 allowlist-internal modification passes", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "src", "a.txt"), "a2\n");
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  assert(gate.ok, "expected in-scope modification to pass");
  rmSync(repo, { recursive: true, force: true });
});

test("9 allowlist-external modification is deterministic HOLD", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "outside.txt"), "o2\n");
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  assert(!gate.ok, "expected out-of-scope modification to be rejected");
  assert(violationReasons(gate.violations).includes("outside_allowlist"));
  rmSync(repo, { recursive: true, force: true });
});

test("10 untracked file included in inventory", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "src", "new.txt"), "n\n");
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  assert(gate.delta.some((d) => d.path === "src/new.txt" && d.change === "added"));
  rmSync(repo, { recursive: true, force: true });
});

test("11 delete included in inventory", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  unlinkSync(join(repo, "will-delete.txt"));
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, [], []);
  assert(gate.delta.some((d) => d.path === "will-delete.txt" && d.change === "deleted"));
  rmSync(repo, { recursive: true, force: true });
});

test("12 rename correctly identified (as delete + add pair)", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  renameSync(join(repo, "will-rename.txt"), join(repo, "src", "renamed.txt"));
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  const paths = gate.delta.map((d) => d.path);
  assert(paths.includes("will-rename.txt"), "old path must appear as deleted");
  assert(paths.includes("src/renamed.txt"), "new path must appear as added");
  // old path (will-rename.txt) is outside allowlist -> violation on the deletion endpoint
  assert(!gate.ok);
  rmSync(repo, { recursive: true, force: true });
});

test("13 nested path canonical comparison correct", () => {
  const repo = mkGit(mkTemp("repo"));
  const baseline = captureScopeSnapshot(repo);
  writeFileSync(join(repo, "src", "sub", "dir", "deep.txt"), "d\n");
  const post = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, baseline, post, ["src/**"], []);
  assert(gate.ok, "deeply nested allowed path must match src/**");
  assert(canonicalRepositoryPath("src/sub/dir/deep.txt", repo) === "src/sub/dir/deep.txt");
  assert(canonicalRepositoryPath("../outside", repo) === null);
  assert(canonicalRepositoryPath("/abs/path", repo) === null);
  rmSync(repo, { recursive: true, force: true });
});

test("14 symlink pointing outside repository is blocked", () => {
  const repo = mkGit(mkTemp("repo"));
  const outsideTarget = mkTemp("outside-target");
  symlinkSync(outsideTarget, join(repo, "escape-link"));
  assert(canonicalRepositoryPath("escape-link", repo) === null, "symlink path must be rejected");
  rmSync(repo, { recursive: true, force: true });
  rmSync(outsideTarget, { recursive: true, force: true });
});

test("15 .git mutation is blocked", () => {
  const repo = mkGit(mkTemp("repo"));
  assert(canonicalRepositoryPath(".git/config", repo) === null);
  assert(canonicalRepositoryPath(".git", repo) === null);
  assert(canonicalRepositoryPath("src/.git/hooks/pre-commit", repo) === null);
  rmSync(repo, { recursive: true, force: true });
});

test("16 validation-caused extra modification is blocked (zero-tolerance gate)", () => {
  const repo = mkGit(mkTemp("repo"));
  const postMutation = captureScopeSnapshot(repo);
  // simulate a "validation" step touching a file even though it is inside
  // the mutation's own allowlist — the post-validation gate must still
  // reject it, because validation must not mutate at all.
  writeFileSync(join(repo, "src", "a.txt"), "touched-by-validation\n");
  const postValidation = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, postMutation, postValidation, [], []);
  assert(!gate.ok, "any change during validation must be rejected regardless of allowlist");
  rmSync(repo, { recursive: true, force: true });
});

test("17 background mutation caught at final gate", () => {
  const repo = mkGit(mkTemp("repo"));
  const postValidation1 = captureScopeSnapshot(repo);
  // simulate a background process writing after validation observed clean
  writeFileSync(join(repo, "background.txt"), "bg\n");
  const finalSnapshot = captureScopeSnapshot(repo);
  const gate = enforceScopeGate(repo, postValidation1, finalSnapshot, [], []);
  assert(!gate.ok, "background mutation must be caught at the final gate");
  rmSync(repo, { recursive: true, force: true });
});

// ── F1 — SCOPE PROJECTION CANONICALIZATION（single canonical seam）────────
// The projection（admission/policy-projection.mjs）, the writer-result
// validation（subagent/subagent-contract.mjs）and this enforcer resolve scope
// paths through the SAME canonicalizer. These items pin the seam's semantics:
// declared entries are canonicalized（never prefix-matched）, and containment
// is component-wise over canonical paths.
// Full projection/enforcement parity corpus:
// test/admission/test-scope-projection-canonicalization.mjs.

test("18 canonical scope entries: only already-canonical repo-relative entries resolve", () => {
  assert(canonicalScopeEntry("src") === "src", "canonical entry resolves");
  assert(canonicalScopeEntry("src/") === "src", "trailing separator is stripped (H5 equivalence)");
  assert(canonicalScopeEntry("src/a.txt") === "src/a.txt", "file-shaped entry resolves");
  for (const bad of ["src/../../etc", "../outside.txt", "/etc", "src/./a.txt", "src//a.txt", "src/**", ".git", ".git/config", "", " ", "src\\a.txt", 42, null, undefined]) {
    assert(canonicalScopeEntry(bad) === null, `entry ${JSON.stringify(bad)} must not resolve`);
  }
  assert(canonicalScopeEntries(["src/", "src/"]).join(",") === "src", "duplicate canonical entries collapse");
  assert(canonicalScopeEntries(["src", "docs"]).join(",") === "src,docs", "canonical entries keep order");
  assert(canonicalScopeEntries(["src/../../etc"]) === null, "an escaping entry never resolves");
  assert(canonicalScopeEntries(["src", null]) === null, "one undecidable entry fails the whole list");
});

test("19 canonical containment is component-wise, never a lexical prefix", () => {
  assert(isWithinCanonicalScope("src/a.txt", ["src"]) === true, "subtree membership");
  assert(isWithinCanonicalScope("src", ["src"]) === true, "equality");
  assert(isWithinCanonicalScope("srcx/a.txt", ["src"]) === false, "sibling sharing a prefix is outside");
  assert(isWithinCanonicalScope("src", ["src/a.txt"]) === false, "parent is outside a narrower entry");
  assert(isWithinCanonicalScope("src/a.txt", []) === false, "empty boundary set authorizes nothing");
  assert(isWithinCanonicalScope("", ["src"]) === false, "empty candidate authorizes nothing");
});

test("20 declared escape fixtures: projection and enforcement agree", () => {
  const scope = ["src"];
  const canonicalScope = canonicalScopeEntries(scope);
  assert(canonicalScope !== null);
  for (const boundary of ["src/a.txt", "src/sub/dir/deep.txt", "src/"]) {
    const canonical = canonicalScopeEntry(boundary);
    assert(canonical !== null && isWithinCanonicalScope(canonical, canonicalScope), `${boundary} must stay authorized`);
  }
  for (const boundary of ["../outside.txt", "src/../../outside.txt", "src/./a.txt", "/etc/passwd", "src/**", "src/.git/config", ""]) {
    assert(canonicalScopeEntry(boundary) === null, `${boundary} must not canonicalize into the scope`);
  }
});

console.log(`C3B mutation scope: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
