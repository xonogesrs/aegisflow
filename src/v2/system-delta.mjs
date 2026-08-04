// src/v2/system-delta.mjs
//
// C4S — reviewer-visible system-observed delta evidence.
//
// C4R proved the read-only reviewer cannot verify content-level success
// criteria from the C4N bundle: the bundle carried path-level facts (changed
// paths, head/tree, exit codes) but never the actual repository delta, so
// the reviewer correctly answered NEEDS_SUPPLEMENT. C4S is the minimal
// repair: after the scope gate succeeds, the harness converts the
// already-computed, already-validated repository delta into a bounded,
// system-observed, identity-bound, durable, reviewer-visible textual diff
// and embeds it in the C4N bundle.
//
// Authority contract:
//   source      = "system_observed"   (git + working-tree observation)
//   authoritative = true
//   producer    = "harness"
//
// The diff NEVER comes from the executor final message, executor
// self-reporting, a model summary, JSON extraction, prompt-only evidence, or
// a P2 evidence call. Changing the executor final message must not change a
// single patch byte (C4S-2 / C4S-10). This module only REPRESENTS the
// existing system-observed scope delta for the reviewer; it grants the model
// no new authority.
//
// Deterministic fail-closed gates (in order):
//   1. identity binding      — contract_id must equal the phase execution id
//                              derived from (run, phase) (C4S-3)
//   2. baseline presence     — repository HEAD / tree must be observable
//   3. scope delta presence  — the formal scope-gate result must exist
//   4. path-count bound      — fixed maximum changed-path inventory
//   5. scope binding         — a fresh git observation must reproduce the
//                              scope gate's formal delta exactly (C4S-4)
//   6. per-path content      — binary / undecodable / unrepresentable files
//                              fail closed (C4S-8); before/after SHA-256
//                              cross-checks fail closed (C4S-5)
//   7. oversize bound        — full patch > cap ⇒ HOLD, never truncate (C4S-7)
//   8. undecodable patch     — replacement characters ⇒ fail closed
//   9. secret scan           — credential patterns block the artifact (C4S-9)
//
// The durable .patch / .json artifacts are persisted by the durable layer
// (see durable-execution onSystemDeltaReady). A persistence failure is a
// journaled HOLD before the reviewer is ever invoked (C4S-11).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";
import { computeDelta } from "../c2d/mutation-scope.mjs";
import { captureChangedPaths } from "../shared/git-diff-utils.mjs";
import { phaseExecutionId } from "./phase-task-card.mjs";

export const SYSTEM_DELTA_FORMAT_VERSION = "autoloop.system-delta/v1";
/** Fixed upper bound for the FULL textual patch. Exceeding it HOLDS (no truncation). */
export const SYSTEM_DELTA_MAX_PATCH_BYTES = 64 * 1024;
/** Defensive per-file read cap (patch bound governs output; this bounds memory). */
export const SYSTEM_DELTA_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const SYSTEM_DELTA_MAX_PATHS = 4096;
export const SYSTEM_DELTA_BINARY_PROBE_BYTES = 8000;

/** Deterministic fail-closed hold codes（exactly the card's concrete codes）. */
export const SYSTEM_DELTA_ERRORS = Object.freeze({
  IDENTITY_MISMATCH: "HARNESS_REVIEW_DELTA_IDENTITY_MISMATCH",
  TOO_LARGE: "REVIEWER_SYSTEM_DELTA_TOO_LARGE",
  SCOPE_MISMATCH: "C4S_REVIEW_DELTA_SCOPE_MISMATCH",
  SHA_MISMATCH: "C4S_REVIEW_DELTA_SHA_MISMATCH",
  GENERATION_FAILED: "C4S_SYSTEM_DELTA_GENERATION_FAILED",
  UNSUPPORTED_BINARY: "C4S_REVIEW_DELTA_UNSUPPORTED_BINARY",
  UNDECODABLE: "C4S_REVIEW_DELTA_UNDECODABLE",
  SECRET_DETECTED: "C4S_REVIEW_DELTA_SECRET_DETECTED",
  PERSISTENCE_FAILED: "C4S_REVIEW_DELTA_PERSISTENCE_FAILED",
});

function sha256Bytes(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** git's own binary heuristic: NUL byte within the first 8 KiB. */
function isBinaryBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) return false;
  return bytes.subarray(0, SYSTEM_DELTA_BINARY_PROBE_BYTES).includes(0);
}

function gitRun(cwd, args, maxBuffer = 8 * 1024 * 1024) {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error) return { ok: false, status: null, stdout: "", stderr: "", spawnError: r.error?.code ?? "error" };
    return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { ok: false, status: null, stdout: "", stderr: "", spawnError: e?.code ?? "error" };
  }
}

/** Raw bytes of `HEAD:<path>`（system-observed baseline blob）. */
function gitShowBytes(cwd, path) {
  try {
    const r = spawnSync("git", ["-C", cwd, "show", `HEAD:${path}`], {
      maxBuffer: SYSTEM_DELTA_MAX_FILE_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error) return { ok: false, reason: r.error?.code ?? "error" };
    if (r.status !== 0) return { ok: false, reason: "missing_in_head" };
    return { ok: true, bytes: r.stdout };
  } catch (e) {
    return { ok: false, reason: e?.code ?? "error" };
  }
}

function headHasPath(cwd, path) {
  return gitRun(cwd, ["cat-file", "-e", `HEAD:${path}`]).ok;
}

function readFileBounded(path, maxBytes = SYSTEM_DELTA_MAX_FILE_BYTES) {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, reason: "not_a_file" };
    if (st.size > maxBytes) return { ok: false, reason: "file_exceeds_read_bound" };
    return { ok: true, bytes: readFileSync(path) };
  } catch (e) {
    return { ok: false, reason: e?.code ?? "read_failed" };
  }
}

function err(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Build one unified-diff section for a single scope-gate delta path, with
 * before/after SHA-256 cross-checks.
 *
 * change semantics（scope gate classification）:
 *   added    — path present in the working tree, absent at HEAD
 *   modified — path present in the working tree, content changed（relative to
 *              HEAD when tracked; relative to phase baseline when untracked）
 *   deleted  — tracked path absent from the working tree
 *
 * Any git disagreement fails closed（SHA_MISMATCH / SCOPE_MISMATCH /
 * GENERATION_FAILED / UNSUPPORTED_BINARY）— never an omitted or fabricated
 * diff section.
 */
function buildSection(repoRoot, path, change) {
  const inHead = headHasPath(repoRoot, path);
  const disk = readFileBounded(join(repoRoot, path));
  const onDisk = disk.ok;

  if (change === "added") {
    if (inHead) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `scope gate says ${path} added but the path exists at HEAD`);
    if (!onDisk) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `scope gate says ${path} added but the path is absent from the working tree`);
    if (isBinaryBytes(disk.bytes)) return err(SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY, `changed path ${path} is binary`);
    const after = sha256Bytes(disk.bytes);
    const r = gitRun(repoRoot, ["diff", "--no-index", "/dev/null", path]);
    if (!r.ok && r.status !== 1) {
      return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git diff --no-index failed for ${path} (status ${r.status ?? r.spawnError})`);
    }
    if (!r.stdout.includes("diff --git")) {
      return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git produced no diff section for added path ${path}`);
    }
    return { ok: true, section: r.stdout, before_sha256: null, after_sha256: after };
  }

  if (change === "modified") {
    if (!onDisk) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `scope gate says ${path} modified but the path is absent from the working tree`);
    if (isBinaryBytes(disk.bytes)) return err(SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY, `changed path ${path} is binary`);
    const after = sha256Bytes(disk.bytes);
    if (inHead) {
      const show = gitShowBytes(repoRoot, path);
      if (!show.ok) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `modified ${path} has no recoverable HEAD blob (${show.reason})`);
      if (isBinaryBytes(show.bytes)) return err(SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY, `baseline content of ${path} is binary`);
      const before = sha256Bytes(show.bytes);
      if (before === after) {
        return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `modified ${path} content is identical to HEAD (before/after SHA-256 equal)`);
      }
      const r = gitRun(repoRoot, ["diff", "HEAD", "--", path]);
      if (!r.ok) return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git diff HEAD failed for ${path} (status ${r.status ?? r.spawnError})`);
      if (!r.stdout.includes("diff --git")) {
        // A scope-gate "modified" that git cannot represent as a diff against
        // the declared baseline（HEAD）is not representable content evidence.
        return err(SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH, `git produced no diff section for scope-gate-modified ${path}`);
      }
      return { ok: true, section: r.stdout, before_sha256: before, after_sha256: after };
    }
    // Untracked file created in an earlier phase and modified here: git
    // observes it as a full add（truthful, system-observed）.
    const r = gitRun(repoRoot, ["diff", "--no-index", "/dev/null", path]);
    if (!r.ok && r.status !== 1) {
      return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git diff --no-index failed for ${path} (status ${r.status ?? r.spawnError})`);
    }
    if (!r.stdout.includes("diff --git")) {
      return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git produced no diff section for modified untracked ${path}`);
    }
    return { ok: true, section: r.stdout, before_sha256: null, after_sha256: after };
  }

  if (change === "deleted") {
    if (!inHead) {
      // Untracked baseline file deleted: its baseline content was never
      // stored in git, so no honest unified diff is producible. Fail closed.
      return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `deleted ${path} is not tracked at HEAD; baseline content not recoverable`);
    }
    if (onDisk) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `scope gate says ${path} deleted but the path still exists`);
    const show = gitShowBytes(repoRoot, path);
    if (!show.ok) return err(SYSTEM_DELTA_ERRORS.SHA_MISMATCH, `deleted ${path} has no recoverable HEAD blob (${show.reason})`);
    if (isBinaryBytes(show.bytes)) return err(SYSTEM_DELTA_ERRORS.UNSUPPORTED_BINARY, `baseline content of deleted ${path} is binary`);
    const before = sha256Bytes(show.bytes);
    const r = gitRun(repoRoot, ["diff", "HEAD", "--", path]);
    if (!r.ok) return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `git diff HEAD failed for deleted ${path} (status ${r.status ?? r.spawnError})`);
    if (!r.stdout.includes("diff --git")) {
      return err(SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH, `git produced no deletion diff for ${path}`);
    }
    return { ok: true, section: r.stdout, before_sha256: before, after_sha256: null };
  }

  return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `unknown scope-gate change type "${change}" for ${path}`);
}

/**
 * Build the system-observed delta evidence for one phase.
 *
 * @param {object} opts
 * @param {string} opts.executionId — parent run execution id
 * @param {object} opts.taskCard — phase task card（executionId/parentExecutionId/
 *   phaseId/mutationScope/repositoryRoot）
 * @param {object} opts.scopeCheck — { ok, violations, delta }（formal scope gate result）
 * @param {object} [opts.limits] — { maxPatchBytes }
 * @returns {{ok:true, delta:object}} | {ok:false, code:string, reason:string}
 */
export function buildSystemObservedDelta({ executionId, taskCard, scopeCheck, limits = {} } = {}) {
  const maxPatchBytes = limits.maxPatchBytes ?? SYSTEM_DELTA_MAX_PATCH_BYTES;
  const phaseId = typeof taskCard?.phaseId === "string" ? taskCard.phaseId : null;
  const phaseExecId = typeof taskCard?.executionId === "string" ? taskCard.executionId : null;
  const parentExecId = typeof taskCard?.parentExecutionId === "string" ? taskCard.parentExecutionId : (executionId ?? null);
  const repoRoot = taskCard?.mutationScope?.repositoryRoot ?? taskCard?.repositoryRoot ?? null;

  // ── Gate 1: identity binding（C4S-3）───────────────────────────────
  if (!phaseId || !phaseExecId || !parentExecId) {
    return err(SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH, "phase task card lacks phase id / execution id / parent execution id");
  }
  if (phaseExecId !== phaseExecutionId(parentExecId, phaseId)) {
    return err(SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH, "taskCard.executionId does not match phaseExecutionId(run, phase)");
  }

  // ── Gate 2: baseline presence（fail-closed; never fabricate）────────
  if (!repoRoot) return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, "repository root unavailable");
  const head = gitRun(repoRoot, ["rev-parse", "HEAD"]);
  const tree = gitRun(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  if (!head.ok || !head.stdout.trim()) {
    return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, "repository baseline (HEAD) unavailable");
  }
  const baselineHead = head.stdout.trim();
  const baselineTree = (tree.ok && tree.stdout.trim()) ? tree.stdout.trim() : baselineHead;

  // ── Gate 3: scope delta presence（the formal scope-gate result）─────
  if (!scopeCheck || !Array.isArray(scopeCheck.delta)) {
    return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, "scope gate delta unavailable");
  }
  const deltaPaths = [...new Set(scopeCheck.delta.map((d) => d.path))].sort();

  // ── Gate 4: path-count bound ──────────────────────────────────────
  if (deltaPaths.length > SYSTEM_DELTA_MAX_PATHS) {
    return err(SYSTEM_DELTA_ERRORS.GENERATION_FAILED, `changed-path inventory exceeds the bound (${deltaPaths.length} > ${SYSTEM_DELTA_MAX_PATHS})`);
  }

  // ── Gate 5: scope binding（C4S-4）─────────────────────────────────
  // A fresh, independent git observation must reproduce the scope gate's
  // formal delta exactly（same paths AND same change classification）. One
  // extra, one missing, or one differently-classified path ⇒ HOLD.
  const baselineSnapshot = taskCard?.mutationScope?.baselineSnapshot ?? null;
  if (baselineSnapshot && baselineSnapshot.paths instanceof Set) {
    const reobserved = captureChangedPaths(repoRoot);
    const recomputed = computeDelta(baselineSnapshot, reobserved, repoRoot)
      .map((d) => `${d.path}:${d.change}`)
      .sort();
    const formal = scopeCheck.delta.map((d) => `${d.path}:${d.change}`).sort();
    if (JSON.stringify(recomputed) !== JSON.stringify(formal)) {
      return err(SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH,
        `fresh git observation does not reproduce the scope gate result (observed ${recomputed.length} entries, gate ${formal.length} entries)`);
    }
  } else if (scopeCheck.delta.length > 0) {
    return err(SYSTEM_DELTA_ERRORS.SCOPE_MISMATCH, "scope binding cannot be verified: baseline snapshot unavailable for a non-empty delta");
  }

  // ── Per-path sections（deterministic order = sorted path list）──────
  const byPath = new Map(scopeCheck.delta.map((d) => [d.path, d]));
  const sections = [];
  const changedPathRecords = [];
  for (const path of deltaPaths) {
    const d = byPath.get(path);
    const sec = buildSection(repoRoot, path, d?.change ?? "modified");
    if (!sec.ok) return sec;
    sections.push(sec.section);
    changedPathRecords.push({ path, change: d.change, before_sha256: sec.before_sha256, after_sha256: sec.after_sha256 });
  }

  const patchText = sections.join("");
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  const patchSha = sha256Text(patchText);

  // ── Gate 7: oversize bound（C4S-7; no silent truncation）───────────
  if (patchBytes > maxPatchBytes) {
    return err(SYSTEM_DELTA_ERRORS.TOO_LARGE, `full textual patch exceeds the bound (${patchBytes} > ${maxPatchBytes}); refusing to truncate or proceed`);
  }

  // ── Gate 8: undecodable patch（Node replaced invalid UTF-8 bytes）──
  if (patchText.includes("\uFFFD")) {
    return err(SYSTEM_DELTA_ERRORS.UNDECODABLE, "patch text contains non-UTF-8 replacement characters; content not stably decodable");
  }

  // ── Gate 9: secret scan（C4S-9; names only, never echoed）──────────
  const scan = scanForSecrets(patchText);
  if (!scan.safe) {
    return err(SYSTEM_DELTA_ERRORS.SECRET_DETECTED, `patch matched secret patterns: ${scan.matches.join(",")}; artifact blocked`);
  }

  const identity = {
    contract_id: phaseExecId,
    phase_id: phaseId,
    run_execution_id: parentExecId,
    parent_execution_id: parentExecId,
    baseline_head: baselineHead,
    baseline_tree: baselineTree,
    observed_at: new Date().toISOString(),
  };
  const patch = {
    text: patchText,
    byte_count: patchBytes,
    sha256: patchSha,
    truncated: false,
    generation_status: "ok",
    max_bytes: maxPatchBytes,
  };
  // Projection persisted as reviewer-system-delta.json（no self-referencing
  // artifacts bookkeeping; sha256 = sha of exactly the persisted bytes）.
  const persistableJson = {
    format_version: SYSTEM_DELTA_FORMAT_VERSION,
    source: "system_observed",
    authoritative: true,
    producer: "harness",
    identity,
    changed_paths: changedPathRecords,
    patch: {
      byte_count: patchBytes,
      sha256: patchSha,
      truncated: false,
      generation_status: "ok",
      max_bytes: maxPatchBytes,
      full_content_artifact: `phases/${phaseId}/reviewer-system-delta.patch`,
    },
  };
  const delta = {
    format_version: SYSTEM_DELTA_FORMAT_VERSION,
    source: "system_observed",
    authoritative: true,
    producer: "harness",
    identity,
    changed_paths: changedPathRecords,
    patch,
    artifacts: {
      json: {
        name: "reviewer-system-delta.json",
        path: `phases/${phaseId}/reviewer-system-delta.json`,
        sha256: sha256Text(canonicalJson(persistableJson) + "\n"),
      },
      patch: {
        name: "reviewer-system-delta.patch",
        path: `phases/${phaseId}/reviewer-system-delta.patch`,
        sha256: sha256Text(patchText),
      },
    },
    persistable_json: persistableJson,
  };
  return { ok: true, delta };
}
