#!/opt/homebrew/bin/node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Buffer } from "node:buffer";

import {
  comparePaths,
  normalizeRelativePath,
  parsePorcelain,
  readInventory,
  run,
  semanticRecords,
  sha256,
} from "../../scripts/evidence/canonical-opening.mjs";

const NODE = process.execPath;
const RUNNER = path.resolve(import.meta.dirname, "../../scripts/evidence/canonical-opening.mjs");

function temporaryRoot(label) {
  const root = path.join(os.tmpdir(), `canonical-opening-test-${label}-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

function git(repo, arguments_) {
  const result = spawnSync("/usr/bin/git", arguments_, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, PATH: "", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function initializeFixture(label, files = {}, options = {}) {
  const root = temporaryRoot(label);
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--initial-branch", "fixture-branch"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["commit", "--allow-empty", "-m", "fixture"]);
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = path.join(repo, relativePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  git(repo, ["add", "."]);
  if (options.commitFiles) {
    git(repo, ["commit", "-m", "fixture-files"]);
  }
  return { root, repo, head: git(repo, ["rev-parse", "HEAD"]).trim() };
}

function predecessorFile(fixture, relativePaths, delimiter = "") {
  const parent = path.dirname(fixture.repo);
  const inventoryPath = path.join(parent, `predecessor${delimiter ? `-${Buffer.from(delimiter).toString("hex")}` : ""}.json`);
  const records = relativePaths.map((relativePath) => {
    const digest = sha256(readFileSync(path.join(fixture.repo, relativePath)));
    return `${digest}${delimiter}${relativePath}`;
  });
  writeFileSync(inventoryPath, JSON.stringify({ records }, null, 2));
  return inventoryPath;
}

function outputPaths(fixture) {
  const evidenceParent = path.join(path.dirname(fixture.repo), "evidence");
  return { evidenceParent, final: path.join(evidenceParent, "opening") };
}

function successfulRun(fixture, relativePaths, options = {}) {
  const { final } = outputPaths(fixture);
  return run([
    "--repo-root", fixture.repo,
    "--expected-branch", "fixture-branch",
    "--expected-head", fixture.head,
    "--predecessor-inventory", predecessorFile(fixture, relativePaths, options.delimiter),
    "--output-evidence-root", final,
    "--expected-path-count", String(relativePaths.length),
    "--allowed-evidence-prefix", path.dirname(final),
  ]);
}

function assertFailure(fixture, relativePaths, messagePart, options = {}) {
  const { final } = outputPaths(fixture);
  assert.throws(() => run([
    "--repo-root", options.repoRoot ?? fixture.repo,
    "--expected-branch", options.branch ?? "fixture-branch",
    "--expected-head", options.head ?? fixture.head,
    "--predecessor-inventory", options.inventory ?? predecessorFile(fixture, relativePaths),
    "--output-evidence-root", final,
    "--expected-path-count", String(options.count ?? relativePaths.length),
    "--allowed-evidence-prefix", path.dirname(final),
  ]), (error) => error.message.includes(messagePart));
  assert.equal(existsSync(final), false);
}

test("rejects absolute and escaping paths", () => {
  assert.throws(() => normalizeRelativePath("/absolute/path"), /absolute path/);
  assert.throws(() => normalizeRelativePath("../escape"), /path escape/);
  assert.throws(() => normalizeRelativePath("a/../../escape"), /path escape/);
  assert.throws(() => normalizeRelativePath("AuraCore/file"), /AuraCore path/);
});

test("parses NUL porcelain and rejects malformed records", () => {
  const buffer = Buffer.concat([
    Buffer.from("?? non-lexical/B\0"),
    Buffer.from("?? non-lexical/a\0"),
  ]);
  const records = parsePorcelain(buffer);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.source.toString()), ["non-lexical/B", "non-lexical/a"]);
  const rename = Buffer.concat([
    Buffer.from("R  new\0old\0"),
  ]);
  const parsedRename = parsePorcelain(rename)[0];
  assert.equal(parsedRename.source.toString(), "new");
  assert.equal(parsedRename.target.toString(), "old");
  assert.throws(() => parsePorcelain(Buffer.from("RX old\0")), /missing rename\/copy target/);
  assert.throws(() => parsePorcelain(Buffer.from("R  old\0")), /missing rename\/copy target/);
  assert.throws(() => parsePorcelain(Buffer.from("MMX path\0")), /invalid porcelain status/);
  assert.throws(() => parsePorcelain(Buffer.from("M? path\0")), /invalid porcelain status/);
});

test("sorts by UTF-8 bytes rather than locale lexical order", () => {
  assert.deepEqual(["b", "A", "a"].sort(comparePaths), ["A", "a", "b"]);
});

test("parses zero, one, two, and multiple whitespace delimiters", () => {
  const fixture = initializeFixture("delimiters", { "a.txt": "a\n", "b.txt": "b\n" });
  try {
    const paths = ["a.txt", "b.txt"];
    for (const delimiter of ["", " ", "  ", "   \t"]) {
      const inventoryPath = predecessorFile(fixture, paths, delimiter);
      const parsed = readInventory(inventoryPath);
      assert.equal(parsed.size, 2);
      assert.equal(parsed.get("a.txt"), sha256(readFileSync(path.join(fixture.repo, "a.txt"))));
    }
  } finally {
    cleanup(fixture.root);
  }
});

test("rejects duplicate predecessor paths and semantically invalid records", () => {
  const fixture = initializeFixture("invalid-inventory", { "a.txt": "a\n" });
  try {
    const inventoryPath = path.join(path.dirname(fixture.repo), "duplicate.json");
    const digest = sha256(Buffer.from("a"));
    writeFileSync(inventoryPath, JSON.stringify({ records: [`${digest} a.txt`, `${digest} a.txt`] }));
    assert.throws(() => readInventory(inventoryPath), /duplicate predecessor path/);
  } finally {
    cleanup(fixture.root);
  }
});

test("captures 134 unique untracked paths with byte-stable output", () => {
  const fixture = initializeFixture("134-paths");
  try {
    const paths = Array.from({ length: 134 }, (_, index) => `file-${String(index).padStart(3, "0")}.txt`);
    for (const relativePath of paths) {
      writeFileSync(path.join(fixture.repo, relativePath), `${relativePath}\n`);
    }
    const first = successfulRun(fixture, paths);
    const { final } = outputPaths(fixture);
    assert.equal(first.pathCount, 134);
    assert.equal(first.pathSetDrift, 0);
    assert.equal(first.contentDigestDrift, 0);
    assert.equal(JSON.parse(readFileSync(path.join(final, "opening-file-digests.json"), "utf8")).count, 134);
    assert.equal(readFileSync(path.join(final, DETACHED()), "utf8"), `${first.manifestSelfHash}\n`);

    assert.throws(() => successfulRun(fixture, paths), /final evidence root already exists/);
  } finally {
    cleanup(fixture.root);
  }
});

test("supports duplicate digests across distinct paths and rejects duplicate status paths", () => {
  const fixture = initializeFixture("duplicate-digests");
  try {
    writeFileSync(path.join(fixture.repo, "same-a"), "same\n");
    writeFileSync(path.join(fixture.repo, "same-b"), "same\n");
    const result = successfulRun(fixture, ["same-a", "same-b"]);
    assert.equal(result.pathCount, 2);
    assert.throws(() => semanticRecords(parsePorcelain(Buffer.from("?? same\0?? same\0"))), /duplicate status/);
  } finally {
    cleanup(fixture.root);
  }
});

test("captures untracked files, deleted records, and rejects symlinks and non-regular files", () => {
  const fixture = initializeFixture("file-kinds", {
    "tracked.txt": "tracked\n",
    "doomed.txt": "doomed\n",
  }, { commitFiles: true });
  try {
    const inventoryPath = path.join(path.dirname(fixture.repo), "inventory.json");
    const records = [`${sha256(Buffer.from("untracked\n"))} untracked.txt`];
    writeFileSync(inventoryPath, JSON.stringify({ records }));
    git(fixture.repo, ["rm", "-f", "doomed.txt"]);
    writeFileSync(path.join(fixture.repo, "untracked.txt"), "untracked\n");
    const { final } = outputPaths(fixture);
    const result = run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", inventoryPath,
      "--output-evidence-root", final,
      "--expected-path-count", "1",
      "--allowed-evidence-prefix", path.dirname(final),
    ]);
    const expanded = JSON.parse(readFileSync(path.join(final, "expanded-inventory.json"), "utf8"));
    assert.equal(expanded.count, 2);
    assert.ok(expanded.records.some((record) => record.path === "doomed.txt" && record.status.includes("D")));
    assert.ok(expanded.records.some((record) => record.path === "untracked.txt"));

    const symlinkFinal = `${final}-symlink`;
    symlinkSync("untracked.txt", path.join(fixture.repo, "linked.txt"));
    assert.throws(() => run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", path.join(path.dirname(fixture.repo), "inventory.json"),
      "--output-evidence-root", symlinkFinal,
      "--expected-path-count", "1",
      "--allowed-evidence-prefix", path.dirname(final),
    ]), /non-regular repository file/);
  } finally {
    cleanup(fixture.root);
  }
});

test("rejects wrong identity, count, final root, stale staging, and output escape", () => {
  const fixture = initializeFixture("fail-closed", { "file.txt": "value\n" });
  try {
    assertFailure(fixture, ["file.txt"], "branch mismatch", { branch: "wrong" });
    assertFailure(fixture, ["file.txt"], "HEAD mismatch", { head: "0".repeat(40) });
    assertFailure(fixture, ["file.txt"], "path count mismatch", { count: 2 });
    assertFailure(fixture, [], "repo root is not a Git repository", { repoRoot: fixture.root });

    const { evidenceParent, final } = outputPaths(fixture);
    mkdirSync(evidenceParent, { recursive: true });
    mkdirSync(final);
    assert.throws(() => run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", predecessorFile(fixture, ["file.txt"]),
      "--output-evidence-root", final,
      "--expected-path-count", "1",
      "--allowed-evidence-prefix", path.dirname(final),
    ]), /final evidence root already exists/);
    assert.ok(existsSync(final));
    rmSync(final, { recursive: true, force: true });

    const expectedStaging = path.join(evidenceParent, `.${path.basename(final)}.staging-${sha256(process.execPath + final).slice(0, 12)}`);
    mkdirSync(expectedStaging);
    assertFailure(fixture, ["file.txt"], "staging evidence root already exists");
    rmSync(expectedStaging, { recursive: true, force: true });

    const staleStaging = `${expectedStaging}-stale`;
    mkdirSync(staleStaging);
    writeFileSync(path.join(staleStaging, "keep.txt"), "keep\n");
    const successful = run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", predecessorFile(fixture, ["file.txt"]),
      "--output-evidence-root", final,
      "--expected-path-count", "1",
      "--allowed-evidence-prefix", path.dirname(final),
    ]);
    assert.equal(successful.status, "PASS");
    assert.equal(readFileSync(path.join(staleStaging, "keep.txt"), "utf8"), "keep\n");

    assert.throws(() => run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", predecessorFile(fixture, ["file.txt"]),
      "--output-evidence-root", path.join(fixture.root, "outside"),
      "--expected-path-count", "1",
      "--allowed-evidence-prefix", path.join(fixture.root, "forbidden"),
    ]), /outside the allowed prefix/);
  } finally {
    cleanup(fixture.root);
  }
});

test("preserves failure evidence as ABORTED and never publishes partial final roots", () => {
  const fixture = initializeFixture("aborted", { "file.txt": "value\n" });
  try {
    const { final } = outputPaths(fixture);
    assertFailure(fixture, ["file.txt"], "path count mismatch", { count: 2 });
    const aborted = readdirSync(path.dirname(final)).find((name) => name.includes("ABORTED"));
    assert.ok(aborted);
    assert.equal(existsSync(final), false);
  } finally {
    cleanup(fixture.root);
  }
});

test("keeps fixture repository bytes unchanged and works with empty PATH from both shells", () => {
  const fixture = initializeFixture("empty-path", { "file.txt": "value\n" });
  try {
    const before = git(fixture.repo, ["status", "--porcelain=v1", "-z", "-uall"]);
    const evidenceParent = path.join(path.dirname(fixture.repo), "evidence");
  const command = `${JSON.stringify(NODE)} ${JSON.stringify(RUNNER)} --repo-root ${JSON.stringify(fixture.repo)} --expected-branch fixture-branch --expected-head ${fixture.head} --predecessor-inventory ${JSON.stringify(predecessorFile(fixture, ["file.txt"]))} --output-evidence-root ${JSON.stringify(path.join(evidenceParent, "opening"))} --expected-path-count 1 --allowed-evidence-prefix ${JSON.stringify(evidenceParent)}`;
    for (const shell of ["/bin/bash", "/bin/zsh"]) {
      const result = spawnSync(shell, ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, PATH: "", LC_ALL: "C" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /"status": "PASS"/);
      rmSync(evidenceParent, { recursive: true, force: true });
    }
    const after = git(fixture.repo, ["status", "--porcelain=v1", "-z", "-uall"]);
    assert.equal(after, before);
  } finally {
    cleanup(fixture.root);
  }
});

test("captures unstaged worktree states and staged renames with current-path digests", () => {
  const fixture = initializeFixture("worktree-states", {
    "mod.txt": "v1\n",
    "gone.txt": "gone\n",
    "renamed.txt": "moved\n",
  }, { commitFiles: true });
  try {
    writeFileSync(path.join(fixture.repo, "mod.txt"), "v2\n");
    git(fixture.repo, ["rm", "-f", "gone.txt"]);
    git(fixture.repo, ["mv", "renamed.txt", "moved.txt"]);
    const records = [
      `${sha256(Buffer.from("v2\n"))} mod.txt`,
      `${sha256(Buffer.from("moved\n"))} moved.txt`,
    ];
    const inventoryPath = path.join(path.dirname(fixture.repo), "inventory.json");
    writeFileSync(inventoryPath, JSON.stringify({ records }, null, 2));
    const { final } = outputPaths(fixture);
    const result = run([
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", inventoryPath,
      "--output-evidence-root", final,
      "--expected-path-count", "2",
      "--allowed-evidence-prefix", path.dirname(final),
    ]);
    assert.equal(result.status, "PASS");
    const expanded = JSON.parse(readFileSync(path.join(final, "expanded-inventory.json"), "utf8"));
    const renameRecord = expanded.records.find((record) => record.status.startsWith("R"));
    assert.equal(renameRecord.path, "moved.txt");
    assert.equal(renameRecord.old, "renamed.txt");
  } finally {
    cleanup(fixture.root);
  }
});

test("rejects detached HEAD, in-repo output roots, symlinked prefixes, and leading-whitespace paths", () => {
  const fixture = initializeFixture("hardening", { "file.txt": "value\n" });
  try {
    const base = [
      "--repo-root", fixture.repo,
      "--expected-branch", "fixture-branch",
      "--expected-head", fixture.head,
      "--predecessor-inventory", predecessorFile(fixture, ["file.txt"]),
      "--expected-path-count", "1",
    ];
    const { evidenceParent, final } = outputPaths(fixture);
    const detachedHead = git(fixture.repo, ["rev-parse", "HEAD"]).trim();
    git(fixture.repo, ["checkout", "-q", "--detach", detachedHead]);
    assert.throws(() => run([...base, "--output-evidence-root", final, "--allowed-evidence-prefix", evidenceParent]), /detached HEAD/);
    git(fixture.repo, ["checkout", "-q", "fixture-branch"]);
    assert.throws(() => run([...base, "--output-evidence-root", path.join(fixture.repo, "evidence"), "--allowed-evidence-prefix", fixture.root]), /outside the repository/);
    const symlinked = path.join(fixture.root, "linked-prefix");
    mkdirSync(path.join(fixture.root, "real-prefix"), { recursive: true });
    symlinkSync(path.join(fixture.root, "real-prefix"), symlinked);
    const digest = sha256(readFileSync(path.join(fixture.repo, "file.txt")));
    const whitespaceInventory = path.join(path.dirname(fixture.repo), "whitespace.json");
    writeFileSync(whitespaceInventory, JSON.stringify({ records: [`${digest}  file.txt`] }, null, 2));
    const parsed = readInventory(whitespaceInventory);
    assert.equal(parsed.get("file.txt"), digest);
    assert.throws(() => run(["--repo-root", "--expected-branch", "fixture-branch", "--expected-head", fixture.head, "--predecessor-inventory", predecessorFile(fixture, ["file.txt"]), "--output-evidence-root", final, "--expected-path-count", "1", "--allowed-evidence-prefix", evidenceParent]), /invalid argument/);
  } finally {
    cleanup(fixture.root);
  }
});

function DETACHED() {
  return "OPENING-MANIFEST.sha256.sha256";
}
