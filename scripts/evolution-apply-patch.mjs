#!/usr/bin/env node
// scripts/evolution-apply-patch.mjs
//
// AUTOLOOP_AUTONOMOUS_EVOLUTION_LOOP_COMPLETION_1 — Section E helper.
//
// Applies ONE candidate patch inside the C3B isolated worktree. The patch
// bytes are delivered through a temp file whose path is passed in argv (the
// mutation pipeline writes the file before dispatch; the command line never
// carries patch content). The script:
//   1. reads the patch file (bounded size),
//   2. fails closed on secret-pattern matches / control characters,
//   3. applies with `git apply --check` first (dry-run) — a patch that does
//      not apply cleanly NEVER touches the worktree,
//   4. applies for real and re-verifies with `git apply --check --reverse`
//      (the applied state must be exactly reversible),
//   5. exits 0 only when all steps succeeded.
//
// Fail-closed: any check failure exits nonzero — the C3B runner records
// MUTATION_FAILED and the candidate is rejected/repaired, never half-applied.

import { readFileSync, existsSync, statSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MAX_PATCH_BYTES = 256 * 1024;
const SECRET_PATTERNS = [
  { name: "sk_key", re: /sk-[A-Za-z0-9]{16,}/ },
  { name: "github_token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "aws_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer_auth", re: /Authorization\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._-]{16,}/i },
];

function die(msg) {
  console.error(`EVOLUTION_APPLY_PATCH_FAIL: ${msg}`);
  process.exit(1);
}

const patchFile = process.argv[2];
if (!patchFile) die("patch file argument required");
if (!existsSync(patchFile) || !statSync(patchFile).isFile()) die("patch file missing");
const st = statSync(patchFile);
if (st.size > MAX_PATCH_BYTES) die(`patch exceeds ${MAX_PATCH_BYTES} bytes`);
let patch;
try { patch = readFileSync(patchFile, "utf8"); } catch (e) { die(`unreadable: ${e.message}`); }
if (/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(patch)) die("patch contains control characters");
for (const { name, re } of SECRET_PATTERNS) {
  if (re.test(patch)) die(`patch matched secret pattern: ${name}`);
}
if (!patch.startsWith("--- ") && !patch.startsWith("diff --git ")) die("patch does not look like a unified diff");

function git(args, opts = {}) {
  const r = spawnSync("git", args, { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 3. dry-run: the patch must apply cleanly or nothing happens.
const check = git(["apply", "--check", "--whitespace=warn", resolve(patchFile)]);
if (check.status !== 0) die(`patch does not apply cleanly: ${check.stderr.trim().slice(0, 400)}`);

// 4. apply for real, then prove reversibility.
const apply = git(["apply", "--whitespace=warn", resolve(patchFile)]);
if (apply.status !== 0) die(`patch apply failed: ${apply.stderr.trim().slice(0, 400)}`);
const reverse = git(["apply", "--check", "--reverse", resolve(patchFile)]);
if (reverse.status !== 0) die(`applied patch is not cleanly reversible: ${reverse.stderr.trim().slice(0, 400)}`);

// cleanup the delivered patch file (best-effort)
try { unlinkSync(patchFile); } catch { /* caller may clean */ }

console.log("EVOLUTION_APPLY_PATCH_OK");
