// test/v2/test-candidate-domain-policy.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2-FREEZE-R2 — E1-A classifier + H2 global evidence
// boundary + C1A semantic candidate identity. Uses real temp git repos.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { candidateDomain } from "../../src/governance/candidate-domain-policy.mjs";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";

function runGit(repo, args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function gitFor(repo) {
  return (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), "candp-"));
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.email", "t@t"]);
  runGit(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  runGit(repo, ["add", "base.txt"]);
  runGit(repo, ["commit", "-q", "-m", "init"]);
  runGit(repo, ["branch", "-M", "main"]);
  // candidate branch so committed changes remain visible against base "main"
  runGit(repo, ["checkout", "-q", "-b", "feat"]);
  return repo;
}

// ── E1-A classifier ──────────────────────────────────────────────────────

test("E1-A: default INCLUDE outside the canonical governance root", () => {
  assert.equal(candidateDomain("src/index.mjs"), "INCLUDE");
  assert.equal(candidateDomain("test/foo.mjs"), "INCLUDE");
  assert.equal(candidateDomain("docs/governance/card-implementation-spec.md"), "INCLUDE");
  // disguised source under src/ — filename alone must never exclude it
  assert.equal(candidateDomain("src/foo/review-findings.g0001.json"), "INCLUDE");
});

test("E1-A: EXCLUDE only under the canonical governance root (generated classes)", () => {
  assert.equal(candidateDomain("docs/pi-graph-output/de1/review-job.json"), "EXCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/de1/review-findings.g0001.json"), "EXCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/de1/review-verdict.g0001.json"), "EXCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/de1/card-closeout-bundle-20260807.txt"), "EXCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/de1/de1-bakeoff-results.json"), "EXCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/checkpoint-20260809/capability-health-inventory.md"), "EXCLUDE");
});

test("E1-A: human-authored card spec is positively preserved (INCLUDE)", () => {
  assert.equal(candidateDomain("docs/pi-graph-output/de1/DE-1R-card-spec.md"), "INCLUDE");
  assert.equal(candidateDomain("docs/pi-graph-output/ta1/TA-1-card-spec.md"), "INCLUDE");
});

// ── C1A semantic identity ────────────────────────────────────────────────

test("C1A: dirty → staged → committed (same bytes) keeps identical changedTreeIdentity", () => {
  const repo = setupRepo();
  try {
    const git = gitFor(repo);
    writeFileSync(join(repo, "new.txt"), "same content\n");
    const untracked = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });

    runGit(repo, ["add", "new.txt"]);
    const staged = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });

    runGit(repo, ["commit", "-q", "-m", "add"]);
    const committed = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });

    assert.equal(staged.changedTreeIdentity, untracked.changedTreeIdentity);
    assert.equal(committed.changedTreeIdentity, untracked.changedTreeIdentity);

    // real byte mutation changes identity
    writeFileSync(join(repo, "new.txt"), "different content\n");
    const mutated = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });
    assert.notEqual(mutated.changedTreeIdentity, untracked.changedTreeIdentity);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── H2 global evidence boundary ──────────────────────────────────────────

test("H2: generated evidence excluded from candidate identity; card-spec + source remain included", () => {
  const repo = setupRepo();
  try {
    const git = gitFor(repo);
    writeFileSync(join(repo, "src.txt"), "candidate\n");
    mkdirSync(join(repo, "docs", "pi-graph-output", "CARD"), { recursive: true });
    writeFileSync(join(repo, "docs", "pi-graph-output", "CARD", "review-findings.g0001.json"), "{}");
    writeFileSync(join(repo, "docs", "pi-graph-output", "CARD", "CARD-card-spec.md"), "spec\n");

    const noPolicy = buildChangeInventory({ git, cwd: repo, baseBranch: "main" });
    const withPolicy = buildChangeInventory({ git, cwd: repo, baseBranch: "main", candidateDomain });

    // no-policy sees all three untracked paths
    assert.equal(noPolicy.changedPaths.length, 3);
    // with-policy: evidence excluded; source + card-spec preserved
    assert.deepEqual(
      withPolicy.changedPaths.slice().sort(),
      ["docs/pi-graph-output/CARD/CARD-card-spec.md", "src.txt"].sort(),
    );
    assert.ok(!withPolicy.changedPaths.includes("docs/pi-graph-output/CARD/review-findings.g0001.json"));
    assert.notEqual(withPolicy.changedTreeIdentity, noPolicy.changedTreeIdentity);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("H2: committed evidence stays excluded (git diff <base>...HEAD path)", () => {
  const repo = setupRepo();
  try {
    const git = gitFor(repo);
    mkdirSync(join(repo, "docs", "pi-graph-output", "CARD"), { recursive: true });
    writeFileSync(join(repo, "docs", "pi-graph-output", "CARD", "review-verdict.g0001.json"), "PASS\n");
    writeFileSync(join(repo, "real.txt"), "real source\n");
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-q", "-m", "commit evidence + source"]);

    const withPolicy = buildChangeInventory({ git, cwd: repo, baseBranch: "main", candidateDomain });
    assert.deepEqual(withPolicy.changedPaths.slice().sort(), ["real.txt"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
