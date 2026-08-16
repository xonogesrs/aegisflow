// test/memory/test-cbm-live-query-cli.mjs
//
// AUTOLOOP-CBM-LIVE-INTEGRATION-1 — harness query surface acceptance
// (A2/A6/A7/A8/A9/A15): the CLI returns valid autoloop.memory-query/v1 data,
// repository isolation holds (no cross-repo leakage), population makes an
// empty identity queryable, check-at-use freshness detects a changed tree,
// re-indexed state becomes fresh again, and a corrupt store fails closed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../../src/memory/index.mjs";
import { codeRecord } from "./helpers-cbm3.mjs";

const CLI = new URL("../../scripts/autoloop-memory-query.mjs", import.meta.url).pathname;

const roots = [];
function tmpRoot() {
  const d = mkdtempSync(join(tmpdir(), "cbm-live-cli-"));
  roots.push(d);
  return d;
}
after(() => {
  for (const d of roots) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeRepo() {
  const dir = tmpRoot();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "r1"], { cwd: dir });
  return dir;
}
function treeOf(dir) {
  return execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, encoding: "utf8" }).trim();
}
function commitFile(dir, name, text) {
  writeFileSync(join(dir, name), text);
  execFileSync("git", ["add", name], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `add ${name}`], { cwd: dir });
}
function runCli(args) {
  try {
    const out = execFileSync("node", [CLI, ...args], { encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") };
  }
}
function store(stateRoot) {
  const s = new LocalMemoryStore({ stateRoot, log: { info() {}, warn() {}, error() {} } });
  s.open();
  return s;
}

test("A2: CLI returns valid autoloop.memory-query/v1 data", () => {
  const repo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);
  const s = store(stateRoot);
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: treeOf(repo),
    path: "src/parse.mjs",
    symbol: "parseMemoryRecord",
    statement: "parseMemoryRecord validates memory records deterministically",
  }));
  s.close();

  const { code, out } = runCli(["--repo", repo, "--state-root", stateRoot, "--terms", "parseMemoryRecord", "--json"]);
  assert.equal(code, 0, out);
  const r = JSON.parse(out);
  assert.equal(r.schema, "autoloop.memory-query/v1");
  assert.equal(r.state, "AVAILABLE");
  assert.equal(r.repository.repositoryIdentity, id.repositoryIdentity);
  assert.equal(r.retrieval.schema, "autoloop.memory-retrieval-result/v1");
  assert.ok(r.retrieval.selectedRecords.length >= 1, "expected the imported record");
  assert.equal(r.retrieval.selectedRecords[0].scope.path, "src/parse.mjs");
  assert.ok(r.retrieval.retrievalDigest.match(/^[0-9a-f]{64}$/));
  assert.equal(r.freshness.indexed, true);
  assert.equal(r.freshness.stale, false);
});

test("A6: wrong repository identity -> zero results, no cross-repo leakage", () => {
  const repo = makeRepo();
  const otherRepo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);
  const s = store(stateRoot);
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: treeOf(repo),
    path: "src/parse.mjs",
    statement: "parseMemoryRecord validates memory records",
  }));
  s.close();

  const { code, out } = runCli(["--repo", otherRepo, "--state-root", stateRoot, "--terms", "parseMemoryRecord", "--json"]);
  assert.equal(code, 0, out);
  const r = JSON.parse(out);
  assert.equal(r.state, "AVAILABLE");
  assert.equal(r.retrieval.selectedRecords.length, 0, "other-repo records must never surface");
  assert.ok(r.retrieval.excludedSummary.repository >= 1, "exclusion must be attributable to the repository hard boundary");
});

test("A7: unpopulated identity -> EMPTY_MEMORY; population makes it queryable", () => {
  const repo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);

  const empty = JSON.parse(runCli(["--repo", repo, "--state-root", stateRoot, "--json"]).out);
  assert.equal(empty.state, "EMPTY_MEMORY");
  assert.equal(empty.freshness.indexed, false);
  assert.equal(empty.freshness.stale, null);

  const s = store(stateRoot);
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: treeOf(repo),
    path: "src/import.mjs",
    statement: "explicitImport is the governed write path",
  }));
  s.close();

  const { code, out } = runCli(["--repo", repo, "--state-root", stateRoot, "--terms", "explicitImport", "--json"]);
  assert.equal(code, 0, out);
  const r = JSON.parse(out);
  assert.equal(r.state, "AVAILABLE");
  assert.ok(r.retrieval.selectedRecords.length >= 1, "populated identity must be queryable");
});

test("A8/A9: stale index detected; refreshed index becomes queryable with provenance", () => {
  const repo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);
  const t1 = treeOf(repo);

  const s = store(stateRoot);
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: t1,
    path: "src/version.mjs",
    statement: "version module indexed at tree one",
  }));
  s.close();

  // fresh at T1
  const fresh = JSON.parse(runCli(["--repo", repo, "--state-root", stateRoot, "--terms", "version", "--json"]).out);
  assert.equal(fresh.freshness.stale, false);
  assert.deepEqual(fresh.freshness.indexedTrees, [t1]);
  assert.ok(fresh.retrieval.selectedRecords.length >= 1);

  // advance the tree -> stale, and the T1-bound record is never labeled current
  commitFile(repo, "new.txt", "x");
  const t2 = treeOf(repo);
  assert.notEqual(t1, t2);
  const stale = JSON.parse(runCli(["--repo", repo, "--state-root", stateRoot, "--terms", "version", "--json"]).out);
  assert.equal(stale.freshness.stale, true, "index does not cover the current tree");
  assert.deepEqual(stale.freshness.indexedTrees, [t1]);
  assert.equal(stale.retrieval.selectedRecords.length, 0, "tree-stale records must be excluded under CURRENT validity");
  assert.ok(stale.retrieval.excludedSummary.validity >= 1, "exclusion attributable to tree-baseline staleness");

  // governed refresh: import at the new tree -> fresh again, both trees indexed
  const s2 = store(stateRoot);
  s2.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    tree: t2,
    path: "src/version.mjs",
    statement: "version module re-indexed at tree two",
  }));
  s2.close();
  const refreshed = JSON.parse(runCli(["--repo", repo, "--state-root", stateRoot, "--terms", "version", "--json"]).out);
  assert.equal(refreshed.freshness.stale, false);
  assert.deepEqual(refreshed.freshness.indexedTrees, [t1, t2]);
  assert.ok(refreshed.retrieval.selectedRecords.length >= 1);
});

test("A15: corrupt store -> INVALID, fail-closed, never treated as empty", () => {
  const repo = makeRepo();
  const stateRoot = tmpRoot();
  const id = resolveRepositoryIdentity(repo);
  const s = store(stateRoot);
  s.explicitImport(codeRecord({
    repo: id.repositoryIdentity,
    commit: id.commitSha,
    tree: treeOf(repo),
    path: "src/parse.mjs",
    statement: "parseMemoryRecord validates memory records",
  }));
  s.close();

  // corrupt the journal (the canonical authority) — open must fail closed
  writeFileSync(join(stateRoot, "journal.jsonl"), "this is not a journal event\n");

  const { code, out } = runCli(["--repo", repo, "--state-root", stateRoot, "--json"]);
  assert.equal(code, 2, out);
  const r = JSON.parse(out);
  assert.equal(r.state, "INVALID");
  assert.ok(r.reason.includes("MEMORY_STORE_INVALID"), r.reason);
});
