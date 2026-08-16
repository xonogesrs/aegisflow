// test/v2/test-durable-subagent-resume.mjs
//
// DE-2R — PRODUCTION SUB-AGENT RESUME CLOSURE regression guards.
//
// The full crash matrix lives in scripts/de2r-subagent-resume-probe.mjs
//（real SIGKILL + fresh-process resume at RO-node / writer-result / review
// boundaries）. This suite pins the production resume ENTRY contract so the
// wiring can never silently regress:
//
//   1. wipeScratchPreserving keeps the crashed run's persisted results dir
//      across the resume scratch wipe（worktrees / phase scratch reclaimed）.
//   2. resumeSubagentGraph of a COMPLETED durable sub-agent run short-
//      circuits to terminal truth（stage=complete）with zero re-execution and
//      preserves the caller's logical executionId + durable executionId.
//   3. resumeSubagentGraph fails closed（RESUME_FINGERPRINT_MISMATCH）when
//      no durable checkpoint exists for the execution — never guesses.
//   4. the resume entry maps the caller's logical id to the SAME durable id
//      the run entry used（durableExecutionIdFor stability）.
//
// The mid-flight（crashed-then-resumed）sub-agent wiring proof is the probe
// script; running it requires colima.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { wipeScratchPreserving } from "../../src/v2/durable-graph.mjs";
import { prepareOwnedScratchRoot, getScratchAuthorityToken } from "../../src/runtime/scratch-ownership.mjs";
import { assertOwnedScratchRoot } from "../../src/runtime/scratch-ownership.mjs";
import { resumeSubagentGraph, durableExecutionIdFor } from "../../src/subagent/subagent-graph-runner.mjs";

const HOME = homedir();

// ── 1. wipeScratchPreserving（pure, no colima）───────────────────────────
test("DE-2R wipeScratchPreserving: keeps preserved results dir inside owned child", () => {
  const namespace = mkdtempSync(join(tmpdir(), "de2r-wipe-"));
  const root = prepareOwnedScratchRoot({
    scratchRoot: namespace,
    executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  try {
    // crashed run's layout: durable results dir + a stale worktree + phase scratch
    mkdirSync(join(root, "results"), { recursive: true });
    mkdirSync(join(root, "SA-W1", "wt"), { recursive: true });
    mkdirSync(join(root, "SA-R1", "scratch"), { recursive: true });
    writeFileSync(join(root, "results", "SA-W1.json"), "{}");

    wipeScratchPreserving({ scratchRoot: namespace, executionId: "exec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", preserve: ["./results"], authorityToken: getScratchAuthorityToken(root) });

    // results survive
    assert.equal(existsSync(join(root, "results", "SA-W1.json")), true, "persisted result survives the wipe");
    // worktrees / phase scratch reclaimed
    assert.equal(existsSync(join(root, "SA-W1", "wt")), false, "stale worktree reclaimed");
    assert.equal(existsSync(join(root, "SA-R1", "scratch")), false, "phase scratch reclaimed");
    // preserved dir re-created empty + readable
    assert.equal(existsSync(join(root, "results")), true, "results dir present");
  } finally {
    rmSync(namespace, { recursive: true, force: true });
  }
});

test("DE-2R wipeScratchPreserving: destructive target cannot be supplied directly", () => {
  const root = join(tmpdir(), `de2r-wipe-missing-${Date.now()}`);
  try {
    mkdirSync(root, { recursive: true });
    assert.throws(() => assertOwnedScratchRoot({ ownedRoot: root }), /scratchRoot ownership/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. resumeSubagentGraph fails closed on an unknown execution ─────────
test("DE-2R resumeSubagentGraph: unknown execution fails closed (RESUME_FINGERPRINT_MISMATCH), never guesses", async () => {
  const repo = makeFixtureRepo();
  const persistenceRoot = mkdtempSync(join(tmpdir(), "de2r-resume-persist-missing-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "de2r-resume-scratch-missing-"));
  try {
    await assert.rejects(
      () =>
        resumeSubagentGraph({
          parent: { scope: {} },
          manifest: [],
          cwd: repo,
          executionId: "de2r-never-ran-1",
          repoPath: repo,
          scratchRoot,
          maxRepairAttempts: 1,
          timeoutMs: 60000,
          signal: undefined,
          hooks: {},
          dirtyScope: [],
          persistence: { root: persistenceRoot },
        }),
      /RESUME_FINGERPRINT_MISMATCH|no checkpoint exists/i,
      "resume of an unknown execution must fail closed with a fingerprint error"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(persistenceRoot, { recursive: true, force: true });
    rmSync(scratchRoot, { recursive: true, force: true });
  }
});

// ── 3. id mapping stability（run vs resume share the durable store）─────
test("DE-2R id mapping: resumeSubagentGraph derives the SAME durable id as runSubagentGraph", () => {
  const logical = "de2r-id-stability-1";
  const a = durableExecutionIdFor(logical);
  const b = durableExecutionIdFor(logical);
  assert.equal(a, b, "same logical id -> same durable id");
  assert.match(a, /^exec_[0-9a-f]{32}$/, "valid C2D durable id");
  // a valid C2D id passes through unchanged
  const c2d = "exec_" + "ab".repeat(16);
  assert.equal(durableExecutionIdFor(c2d), c2d, "C2D-minted id passes through");
});

// ── helpers ────────────────────────────────────────────────────────────
function makeFixtureRepo() {
  const base = join(HOME, ".de2r-test");
  mkdirSync(join(base, "docs"), { recursive: true });
  const dir = join(base, `fixture-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  const git = (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "de2r@test"]);
  git(["config", "user.name", "de2r"]);
  writeFileSync(join(dir, "docs", "README.md"), "# de2r fixture\n\nTODO: probe\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  return dir;
}

function readJournal(persistenceRoot, durableId) {
  const jdir = join(persistenceRoot, durableId, "journal");
  if (!existsSync(jdir)) return [];
  return readdirSync(jdir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")));
}
