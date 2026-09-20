// test/test-pi-autoloop-launcher.mjs
//
// R-03 — canonical AutoLoop interactive-entrypoint contract.
//
// scripts/pi-autoloop.sh is THE supported interactive Pi entrypoint for
// AutoLoop work: it establishes the canonical repository cwd BEFORE pi
// starts (so AGENTS.md auto-discovery loads the operative instructions
// with no manual trust prompt) and passes --approve for the same reason.
// These tests pin that contract so a future edit cannot silently turn the
// launcher into a bare-pi passthrough or point it at a stale repo path.
//
// Boundary (explicit): this is launcher-contract enforcement for the
// SUPPORTED AutoLoop entrypoint — NOT OS-wide `pi` prevention. Executing
// a globally installed `pi` binary outside AutoLoop is outside scope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = "/Volumes/NVM2T/Development/repos/autoloop";
const LAUNCHER = join(REPO_ROOT, "scripts", "pi-autoloop.sh");

test("R-03: canonical launcher exists, is executable, and targets the canonical repo", () => {
  const st = statSync(LAUNCHER);
  assert.equal(st.isFile(), true, "launcher must be a regular file");
  assert.equal(st.mode & 0o111 ? true : false, true, "launcher must be executable");
  const text = readFileSync(LAUNCHER, "utf8");
  assert.match(text, /^REPO_ROOT="\/Volumes\/NVM2T\/Development\/repos\/autoloop"$/m, "launcher must cd into THE canonical repo path");
  assert.match(text, /^cd "\$REPO_ROOT"$/m, "launcher must establish repo cwd before execution");
  assert.match(text, /exec pi --approve/, "launcher must pass --approve (project-local trust without interactive prompt)");
  // guard limits: no global mutation — the launcher must not touch PATH, aliases, the pi binary, or shell profiles
  assert.doesNotMatch(text, /PATH=/, "launcher must not modify PATH");
  assert.doesNotMatch(text, /alias /, "launcher must not define aliases");
  assert.doesNotMatch(text, /zprofile|zshrc|zshenv|\.profile/, "launcher must not touch shell profiles");
  assert.doesNotMatch(text, / npm-global| \/usr\/local\/bin| ln -s /, "launcher must not install or wrap the global pi binary");
});

test("R-03: launcher establishes repo cwd from an arbitrary start cwd (wrong-cwd fence)", () => {
  // Extract the cd target by sourcing the cd lines with exec stubbed out —
  // proves the script's cwd resolution independent of the caller's cwd.
  const script = readFileSync(LAUNCHER, "utf8")
    .replace(/^exec /m, "echo CWD_REACHED=$(pwd); exit 0; # ");
  const tmp = mkdtempSync(join(tmpdir(), "r03-launcher-"));
  const probe = join(tmp, "probe.sh");
  writeFileSync(probe, script);
  chmodSync(probe, 0o755);
  const r = spawnSync("bash", [probe], { cwd: "/tmp", encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `CWD_REACHED=${REPO_ROOT}`, "from /tmp the launcher resolves cwd to the canonical repo");
});

test("R-03: launcher from an unrelated repository still resolves the canonical repo (wrong-repo fence)", () => {
  const script = readFileSync(LAUNCHER, "utf8")
    .replace(/^exec /m, "echo CWD_REACHED=$(pwd); git -C \"$(pwd)\" rev-parse --show-toplevel >/dev/null 2>&1; echo IN_GIT=$?; exit 0; # ");
  const other = mkdtempSync(join(tmpdir(), "r03-other-repo-"));
  const probe = join(tmpdir(), "r03-probe-other.sh");
  writeFileSync(probe, script.replace(/^REPO_ROOT=.*/m, `REPO_ROOT="${REPO_ROOT}"`));
  chmodSync(probe, 0o755);
  const r = spawnSync("bash", [probe], { cwd: other, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split("\n");
  assert.equal(out[0], `CWD_REACHED=${REPO_ROOT}`, "from an unrelated repo the launcher still lands on the canonical repo");
});

test("R-03: canonical launcher passes arguments through to pi (exec passthrough)", () => {
  const r = spawnSync("bash", [LAUNCHER, "--version"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\d+\.\d+/, "pi --version via the launcher prints a version (real end-to-end path: cd -> exec pi --approve)");
});
