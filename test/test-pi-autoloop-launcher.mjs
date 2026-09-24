// test/test-pi-autoloop-launcher.mjs
//
// R-03 — canonical AutoLoop interactive-entrypoint contract.
//
// scripts/pi-autoloop.sh is THE supported interactive Pi entrypoint for
// AutoLoop work: it establishes the repository cwd BEFORE pi starts (so
// AGENTS.md auto-discovery loads the operative instructions with no manual
// trust prompt) and passes --approve for the same reason. These tests pin that
// contract so a future edit cannot silently turn the launcher into a bare-pi
// passthrough, make it depend on one machine's absolute checkout path, or make
// it mutate the operator's global shell environment.
//
// PORTABILITY (scope of this test): the launcher must work from ANY clone
// location. It derives the repo root from its own file location, with
// AUTOLOOP_REPO_ROOT as an explicit override. The behavioral tests therefore
// run the REAL launcher with a stub `pi` first on PATH and assert the cwd it
// lands in — no path rewriting, no dependency on where this checkout lives.
//
// Boundary (explicit): this is launcher-contract enforcement for the SUPPORTED
// AutoLoop entrypoint — NOT OS-wide `pi` prevention. Executing a globally
// installed `pi` binary outside AutoLoop is outside scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/[\/]$/, "");
const LAUNCHER = join(REPO_ROOT, "scripts", "pi-autoloop.sh");

/** Create a PATH dir holding a `pi` stub that reports the cwd it was invoked from. */
function piStubDir() {
  const dir = mkdtempSync(join(tmpdir(), "r03-pi-stub-"));
  const stub = join(dir, "pi");
  writeFileSync(stub, `#!/usr/bin/env bash\necho "PI_CWD=$(pwd)"\necho "PI_ARGV=$*"\n`);
  chmodSync(stub, 0o755);
  return dir;
}

function runLauncher({ cwd, env = {} }) {
  const stubDir = piStubDir();
  try {
    return spawnSync("bash", [LAUNCHER], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, ...env },
    });
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

test("R-03: launcher exists, is executable, and derives the repo root from its own location", () => {
  const st = statSync(LAUNCHER);
  assert.equal(st.isFile(), true, "launcher must be a regular file");
  assert.equal(st.mode & 0o111 ? true : false, true, "launcher must be executable");
  const text = readFileSync(LAUNCHER, "utf8");

  // Portable root resolution: no absolute checkout path may be baked in.
  assert.doesNotMatch(text, /^REPO_ROOT="\/[^"]*"/m, "launcher must not hardcode an absolute checkout path");
  assert.match(text, /SCRIPT_DIR=/, "launcher must derive its own directory");
  assert.match(text, /AUTOLOOP_REPO_ROOT:-/, "launcher must honor the AUTOLOOP_REPO_ROOT override");
  assert.match(text, /^cd "\$REPO_ROOT"$/m, "launcher must establish repo cwd before execution");
  assert.match(text, /exec pi --approve/, "launcher must pass --approve (project-local trust without interactive prompt)");

  // guard limits: no global mutation — the launcher must not touch PATH,
  // aliases, the pi binary, or shell profiles
  assert.doesNotMatch(text, /PATH=/, "launcher must not modify PATH");
  assert.doesNotMatch(text, /alias /, "launcher must not define aliases");
  assert.doesNotMatch(text, /zprofile|zshrc|zshenv|\.profile/, "launcher must not touch shell profiles");
  assert.doesNotMatch(text, / npm-global| \/usr\/local\/bin| ln -s /, "launcher must not install or wrap the global pi binary");
});

test("R-03: launcher establishes repo cwd from an arbitrary start cwd (wrong-cwd fence)", () => {
  const r = runLauncher({ cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n")[0], `PI_CWD=${REPO_ROOT}`, `from ${tmpdir()} the launcher resolves cwd to this checkout`);
});

test("R-03: launcher sets cwd to a git worktree root (not just any directory)", () => {
  const r = runLauncher({ cwd: tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const cwd = r.stdout.trim().split("\n")[0].replace("PI_CWD=", "");
  const inside = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  assert.equal(inside.status, 0, `launcher cwd ${cwd} must be inside a git worktree`);
  assert.equal(inside.stdout.trim(), cwd, "launcher cwd must be the worktree root");
});

test("R-03: launcher from an unrelated repository still resolves this checkout (wrong-repo fence)", () => {
  const other = mkdtempSync(join(tmpdir(), "r03-other-repo-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "main", other], { encoding: "utf8" });
    const r = runLauncher({ cwd: other });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n")[0], `PI_CWD=${REPO_ROOT}`, "from an unrelated repo the launcher still lands on THIS checkout");
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("R-03: AUTOLOOP_REPO_ROOT override wins; a non-directory override fails rather than silently using the default", () => {
  const target = mkdtempSync(join(tmpdir(), "r03-override-"));
  try {
    const ok = runLauncher({ cwd: tmpdir(), env: { AUTOLOOP_REPO_ROOT: target } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim().split("\n")[0], `PI_CWD=${target}`, "explicit override is honored");

    const missing = join(target, "does-not-exist");
    const bad = runLauncher({ cwd: tmpdir(), env: { AUTOLOOP_REPO_ROOT: missing } });
    assert.notEqual(bad.status, 0, "a nonexistent override must fail (set -e via cd), never silently fall back");

    // …and it must not have run pi against the wrong directory either.
    assert.doesNotMatch(bad.stdout, /PI_CWD=/, "pi must not start when the configured root is unusable");
    mkdirSync(target, { recursive: true });
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("R-03: canonical launcher passes arguments through to pi (exec passthrough)", () => {
  const stubDir = piStubDir();
  try {
    const r = spawnSync("bash", [LAUNCHER, "--version"], {
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PI_ARGV=.*--version/, "arguments reach pi through the launcher");
    assert.match(r.stdout, /PI_ARGV=.*--approve/, "the launcher adds --approve");
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
});
