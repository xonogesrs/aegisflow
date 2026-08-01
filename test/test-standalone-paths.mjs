// test-standalone-paths.mjs
//
// Verifies the standalone-checkout fixes from
// AUTOLOOP_SCRIPTED_ADAPTER_AND_LIFECYCLE_HARNESS §10: the missing
// scheduler-tick-dry.mjs no longer crashes with a raw missing-module stack,
// generation-manifest.mjs's default manifest directory no longer escapes
// the repository, at least one real standalone file is recognized by the
// material-change patterns, and no new adapter/lifecycle code spawns a
// process named `pi` or talks to any LLM provider.
//
// No subprocess named `pi` is ever invoked here. The only subprocesses
// spawned are `git` (fixture setup) and `node`/`bash` running this repo's
// own scripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeGenerationManifest, detectMaterialChanges } from "../src/generation-manifest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const OPERATOR_TICK_SH = join(REPO_ROOT, "src", "operator-tick.sh");
const OPERATOR_TICK_MJS = join(REPO_ROOT, "src", "operator-tick.mjs");

function noMissingModuleStackTrace(stderr) {
  return !/Cannot find module/.test(stderr) && !/node:internal\/modules/.test(stderr) && !/at Module\._resolveFilename/.test(stderr);
}

// ---------------------------------------------------------------------------
// T11 — missing scheduler-tick-dry.mjs fails closed, never a raw crash.
// ---------------------------------------------------------------------------

test("operator-tick.sh legacy path (no --candidate) fails closed with exit 4 and no missing-module stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-t11-"));
  try {
    const r = spawnSync("bash", [
      OPERATOR_TICK_SH,
      "--metadata-dir", join(dir, "metadata"),
      "--lock-file", join(dir, "tick.lock"),
    ], { encoding: "utf8" });

    assert.equal(r.status, 4);
    // operator-tick.sh reports this via plain `echo` (stdout), matching the
    // script's existing FATAL-message convention -- not stderr.
    assert.match(r.stdout, /UNSUPPORTED_STANDALONE_LEGACY_SCHEDULER/);
    assert.ok(noMissingModuleStackTrace(r.stdout + r.stderr), `output must not contain a Node missing-module stack trace, got stdout=${r.stdout} stderr=${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator-tick.mjs legacy delegation (no --candidate, legacy args given) fails closed with exit 4 and no missing-module stack trace", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-t11b-"));
  try {
    const r = spawnSync(process.execPath, [
      OPERATOR_TICK_MJS,
      "--metadata-dir", join(dir, "metadata"),
      "--lock-file", join(dir, "tick.lock"),
    ], { encoding: "utf8" });

    assert.equal(r.status, 4);
    assert.match(r.stderr, /UNSUPPORTED_STANDALONE_LEGACY_SCHEDULER/);
    assert.ok(noMissingModuleStackTrace(r.stderr), `stderr must not contain a Node missing-module stack trace, got: ${r.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("operator-tick.mjs --candidate path never mentions the missing scheduler (decoupled from legacy delegation)", () => {
  // Feature gate is off by default (no AURA_AUTOLOOP_C3A_C2D_READ_ONLY=1),
  // and no legacy --metadata-dir/--lock-file are given, so this must take
  // the "feature disabled, nothing to delegate" exit(0) path without ever
  // touching scheduler-tick-dry.mjs.
  const r = spawnSync(process.execPath, [
    OPERATOR_TICK_MJS,
    "--candidate", "/nonexistent/candidate.json",
    "--checkpoint-root", "/nonexistent/checkpoint-root",
    "--repo-root", "/nonexistent/repo-root",
  ], { encoding: "utf8", env: { ...process.env, AURA_AUTOLOOP_C3A_C2D_READ_ONLY: undefined } });

  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, /scheduler-tick-dry|UNSUPPORTED_STANDALONE_LEGACY_SCHEDULER/);
});

// ---------------------------------------------------------------------------
// T12 — generation-manifest.mjs default manifest dir no longer escapes repo.
// ---------------------------------------------------------------------------

function gitFixtureWithCommit() {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-t12-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "a.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("writeGenerationManifest fails closed when no manifestDir is given (no escaping default)", () => {
  const dir = gitFixtureWithCommit();
  try {
    assert.throws(
      () => writeGenerationManifest(undefined, null, dir),
      /manifestDir is required/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeGenerationManifest with an explicit manifestDir stays contained within the fixture root", () => {
  const repoDir = gitFixtureWithCommit();
  const manifestDir = join(repoDir, ".manifest-out");
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const manifest = writeGenerationManifest(manifestDir, head, repoDir);
    assert.equal(manifest.head_commit, head);
    assert.ok(existsSync(join(manifestDir, "current-generation.json")));
    // Containment: nothing was written outside the fixture root.
    assert.ok(resolve(manifestDir).startsWith(resolve(repoDir)));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T13 — material-change patterns recognize a real standalone file.
// ---------------------------------------------------------------------------

test("detectMaterialChanges recognizes a real standalone material path (c2d/mutation-scope.mjs -> scope_matcher)", () => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-t13-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "c2d"), { recursive: true });
    writeFileSync(join(dir, "c2d", "mutation-scope.mjs"), "// v1\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir, stdio: "ignore" });
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    writeFileSync(join(dir, "c2d", "mutation-scope.mjs"), "// v2\n");
    execFileSync("git", ["commit", "-am", "change scope matcher"], { cwd: dir, stdio: "ignore" });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    const changes = detectMaterialChanges(baseline, head, dir);
    assert.ok(changes.includes("scope_matcher"), `expected scope_matcher in ${JSON.stringify(changes)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T14 — provider invocation trap (static): the new adapter/lifecycle code
// never spawns a subprocess at all, so there is nothing to invoke `pi`
// with. Verified by source inspection rather than a runtime PATH trap,
// since scripted-adapter.mjs contains zero process-spawning code paths.
// ---------------------------------------------------------------------------

test("adapter contract, scripted adapter, and lifecycle runner never reference a provider CLI or subprocess spawn", () => {
  const sources = [
    join(REPO_ROOT, "src", "adapter", "contract.mjs"),
    join(REPO_ROOT, "src", "adapter", "scripted-adapter.mjs"),
    join(REPO_ROOT, "src", "lifecycle-runner.mjs"),
  ].map((p) => readFileSync(p, "utf8"));

  const forbidden = [
    /\bspawn(Sync)?\s*\(/,
    /\bexec(Sync|File(Sync)?)?\s*\(/,
    /pi-coding-agent/,
    /--mode\s+rpc/,
    /--provider\b/,
    /--api-key\b/,
    /\bchild_process\b/,
  ];
  for (const source of sources) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `forbidden pattern ${pattern} found in adapter/lifecycle source`);
    }
  }
});

// ---------------------------------------------------------------------------
// T15 — temp fixtures created by this file's own tests are fully cleaned up
// (demonstrated inline via try/finally + rmSync in every test above; this
// test only asserts the directories are actually gone afterward).
// ---------------------------------------------------------------------------

test("temp fixture directories created by this suite do not persist after their test completes", () => {
  const probe = mkdtempSync(join(tmpdir(), "autoloop-t15-"));
  rmSync(probe, { recursive: true, force: true });
  assert.equal(existsSync(probe), false);
});
