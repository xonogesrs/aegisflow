// test/governance/test-git-status-parsing.mjs
//
// RB-1R — Repair B: repository path identity parsing.
//
// Regression for the RB-1 defect where `package.json` was recorded as
// `ackage.json`（a trimmed porcelain first-line + fixed `slice(3)` dropped
// the first character of the first path）.
//
// Uses a REAL scratch git repo（init / commit / modify / stage / untrack /
// delete / rename）and asserts the NUL-delimited parser
// (parseGitStatusPorcelainZ + collectRepoFacts) keeps every path intact:
// modified, untracked, spaces, Unicode, nested, rename, deleted, staged +
// unstaged, mixed, NUL boundaries, first character, deterministic digest.
//
// Run: node --test test/governance/test-git-status-parsing.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGitStatusPorcelainZ,
  collectRepoFacts,
  canonicalStatusRecord,
} from "../../src/governance/review-bundle.mjs";

const REPO = join(tmpdir(), `rb1r-porcelain-${process.pid}`);
const git = (args, opts = {}) => spawnSync("git", args, { cwd: REPO, encoding: "utf8", ...opts });

before(() => {
  rmSync(REPO, { recursive: true, force: true });
  mkdirSync(REPO, { recursive: true });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["config", "core.quotepath", "false"]);
  // baseline committed tree
  mkdirSync(join(REPO, "dir with space"), { recursive: true });
  mkdirSync(join(REPO, "uni"), { recursive: true });
  mkdirSync(join(REPO, "nested/deep"), { recursive: true });
  writeFileSync(join(REPO, "package.json"), "v1\n");
  writeFileSync(join(REPO, "dir with space/file 1.txt"), "a\n");
  writeFileSync(join(REPO, "uni/日本語.txt"), "b\n");
  writeFileSync(join(REPO, "nested/deep/file.txt"), "c\n");
  writeFileSync(join(REPO, "oldname.txt"), "d\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
});

after(() => {
  rmSync(REPO, { recursive: true, force: true });
});

test("1. first character never lost: modified package.json parses intact", { timeout: 30000 }, () => {
  writeFileSync(join(REPO, "package.json"), "v2\n");
  writeFileSync(join(REPO, "dir with space/file 1.txt"), "a2\n");
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("package.json"), `package.json present (${JSON.stringify(facts.dirtyPaths)})`);
  assert.ok(!facts.dirtyPaths.includes("ackage.json"), "ackage.json absent (RB-1 defect fixed)");
  assert.ok(!facts.dirtyPaths.includes("ackage.json".replace(/^a/, "")), "no first-char drop");
});

test("2. untracked file（nested + spaces）parsed intact", { timeout: 30000 }, () => {
  mkdirSync(join(REPO, "new dir/sub"), { recursive: true });
  writeFileSync(join(REPO, "new dir/sub/untracked file.txt"), "u\n");
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.untrackedFiles.includes("new dir/sub/untracked file.txt"), `untracked file intact (${JSON.stringify(facts.untrackedFiles)})`);
  assert.ok(facts.dirtyPaths.includes("new dir/sub/untracked file.txt"), "dirty path includes untracked file");
});

test("3. Unicode path stays unquoted and intact", { timeout: 30000 }, () => {
  writeFileSync(join(REPO, "uni/日本語.txt"), "b2\n");
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("uni/日本語.txt"), `unicode path intact (${JSON.stringify(facts.dirtyPaths.filter((p) => p.includes("日本語")))})`);
  assert.ok(!facts.dirtyPaths.some((p) => p.includes("\\3")), "no octal quoting leaked");
});

test("4. nested path intact", { timeout: 30000 }, () => {
  writeFileSync(join(REPO, "nested/deep/file.txt"), "c2\n");
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("nested/deep/file.txt"), "nested path intact");
});

test("5. rename: both source and destination recorded; direction correct", { timeout: 30000 }, () => {
  git(["mv", "oldname.txt", "newname with space.txt"]);
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("oldname.txt"), "rename source in dirty paths");
  assert.ok(facts.dirtyPaths.includes("newname with space.txt"), "rename destination in dirty paths");
  const rec = parseGitStatusPorcelainZ(git(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout)
    .find((r) => r.rename);
  assert.ok(rec, "rename record present");
  assert.equal(rec.source, "oldname.txt", "rename source field (git status -z: second field)");
  assert.equal(rec.destination, "newname with space.txt", "rename destination field (first field)");
  assert.match(canonicalStatusRecord(rec), /oldname\.txt -> newname with space\.txt/, "canonical form matches human-readable direction");
});

test("6. deleted file intact", { timeout: 30000 }, () => {
  const p = join(REPO, "nested/deep/delete-me.txt");
  writeFileSync(p, "x\n");
  git(["add", "nested/deep/delete-me.txt"]); // staged A, then removed in worktree -> AD
  rmSync(p);
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("nested/deep/delete-me.txt"), "deleted path intact");
});

test("7. staged AND unstaged states both parse", { timeout: 30000 }, () => {
  const p = join(REPO, "staged.txt");
  writeFileSync(p, "s1\n");
  git(["add", "staged.txt"]);
  writeFileSync(p, "s2\n"); // staged v1, then unstaged v2
  const facts = collectRepoFacts(REPO);
  assert.ok(facts.dirtyPaths.includes("staged.txt"), "staged+unstaged path intact");
  const recs = parseGitStatusPorcelainZ(git(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout);
  const st = recs.find((r) => r.path === "staged.txt");
  assert.ok(st, "staged.txt record present");
  // staged new file（A in index）then modified in worktree（M）
  assert.equal(st.status, "AM", "index A + worktree M recorded");
});

test("8. mixed status set parses completely（no dropped records）", { timeout: 30000 }, () => {
  const facts = collectRepoFacts(REPO);
  // every expected path from tests 1-7 must be present
  for (const p of [
    "package.json",
    "dir with space/file 1.txt",
    "uni/日本語.txt",
    "nested/deep/file.txt",
    "oldname.txt",
    "newname with space.txt",
    "nested/deep/delete-me.txt",
    "staged.txt",
    "new dir/sub/untracked file.txt",
  ]) {
    assert.ok(facts.dirtyPaths.includes(p), `mixed status keeps ${p} intact`);
  }
  // no empty / null path entries（would indicate a slice/trim bug）
  assert.ok(facts.dirtyPaths.every((p) => typeof p === "string" && p.length > 0), "no empty paths");
});

test("9. NUL-delimited boundary handling: trailing NUL and empty fields", { timeout: 30000 }, () => {
  const raw = " M package.json\0?? uni.txt\0"; // trailing NUL present
  const recs = parseGitStatusPorcelainZ(raw);
  assert.equal(recs.length, 2);
  assert.equal(recs[0].path, "package.json");
  assert.equal(recs[1].path, "uni.txt");
  // no trailing NUL（defensive）
  const recs2 = parseGitStatusPorcelainZ(" M a.txt\0?? b.txt");
  assert.equal(recs2.length, 2);
  assert.equal(recs2[0].path, "a.txt");
  assert.equal(recs2[1].path, "b.txt");
  // empty raw -> no records, no throw
  assert.deepEqual(parseGitStatusPorcelainZ(""), []);
  // malformed record flagged（fail-closed, never silently truncated）
  const malformed = parseGitStatusPorcelainZ("??\0"); // 2-char record
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].malformed, true);
});

test("10. dirty digest deterministic for identical state; differs when state changes", { timeout: 30000 }, () => {
  const d1 = collectRepoFacts(REPO).baselineDirtyDigest;
  const d2 = collectRepoFacts(REPO).baselineDirtyDigest;
  assert.equal(d1, d2, "same state -> same digest");
  assert.match(d1, /^dirty:[0-9a-f]{64}$/, "dirty digest shape");
  // introduce a NEW record（untracked file）-> state changed -> digest changes
  writeFileSync(join(REPO, "digest-probe.txt"), "new\n");
  const d3 = collectRepoFacts(REPO).baselineDirtyDigest;
  assert.notEqual(d1, d3, "different state -> different digest");
});

test("11. clean repo -> clean digest, empty lists", { timeout: 30000 }, () => {
  git(["add", "-A"]);
  git(["commit", "-qm", "settle"]);
  const facts = collectRepoFacts(REPO);
  assert.equal(facts.worktreeClean, true);
  assert.equal(facts.baselineDirtyDigest, "clean");
  assert.deepEqual(facts.dirtyPaths, []);
  assert.deepEqual(facts.untrackedFiles, []);
});

test("12. real repo A: package.json is no longer truncated（live regression）", { timeout: 30000 }, () => {
  const facts = collectRepoFacts("/Volumes/NVM2T/Development/autoloop");
  assert.ok(facts.dirtyPaths.includes("package.json"), `repo A dirty paths keep package.json (${JSON.stringify(facts.dirtyPaths.slice(0, 3))})`);
  assert.ok(!facts.dirtyPaths.includes("ackage.json"), "no ackage.json anywhere");
});
