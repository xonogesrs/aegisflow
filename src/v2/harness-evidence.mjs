// src/v2/harness-evidence.mjs
//
// C4Q — harness-owned implementation evidence.
//
// Removes the executor final assistant message as the authoritative source of
// implementation evidence. After the executor completes tool work, AutoLoop
// collects objective execution facts (repository baseline, mutation-scope
// delta, verification-command process records, tool counters, execution
// identity) and ASSEMBLES the implementation-evidence object itself. The
// model never authors identity or objective facts; contract_id is bound
// mechanically to the phase execution id.
//
// System-authoritative fields (never overridden by model text):
//   schema_version / contract_id / execution ids / phase id /
//   repository_baseline / authorized_paths / actual_changed_paths /
//   mutation_state / commands / test_results (system-observed) /
//   mutation_evidence / scope_deviations / negative_evidence /
//   known_failures / artifact hashes / journal references / timestamps /
//   integrity.
//
// Semantic fields are generated deterministically from the task card, phase
// contract, and objective execution results — never from the executor's
// final JSON, and never via a second model call. If a required field cannot
// be produced, the builder fails closed (HOLD).
//
// Fail-closed gates (deterministic): facts presence, contract identity,
// writer-phase test evidence presence, schema validation, serialized size
// bound, secret-pattern scan.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";
import { validateImplementationEvidence } from "../validate-role-artifacts.mjs";
import { phaseExecutionId } from "./phase-task-card.mjs";

export const HARNESS_EVIDENCE_FORMAT = "autoloop.implementation-evidence/v1";
export const HARNESS_EVIDENCE_MAX_SERIALIZED_BYTES = 64 * 1024;
export const HARNESS_TEST_TIMEOUT_MS = 120_000;
export const HARNESS_OUTPUT_DIAGNOSTIC_BYTES = 2 * 1024;
export const HARNESS_STDERR_TAIL_BYTES = 4 * 1024;

export const HARNESS_EVIDENCE_ERRORS = Object.freeze({
  MISSING_FACTS: "HARNESS_EVIDENCE_MISSING_FACTS",
  IDENTITY_MISMATCH: "HARNESS_EVIDENCE_IDENTITY_MISMATCH",
  TEST_EVIDENCE_MISSING: "HARNESS_TEST_EVIDENCE_MISSING",
  TEST_RUN_UNAVAILABLE: "HARNESS_TEST_RUN_UNAVAILABLE",
  SCHEMA_INVALID: "HARNESS_EVIDENCE_SCHEMA_INVALID",
  OVERSIZE: "HARNESS_EVIDENCE_OVERSIZE",
  SECRET_RISK: "HARNESS_EVIDENCE_SECRET_RISK",
  BUILD_FAILED: "HARNESS_EVIDENCE_BUILD_FAILED",
});

/** Read-only git observation with bounded output; null on failure. */
function gitRun(cwd, args, maxBytes = 8 * 1024) {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: maxBytes });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Collect the repository baseline facts（system-observed, read-only git）.
 * Returns null when the worktree is not a git repository（fail-closed caller）.
 */
export function collectGitBaseline(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const head = gitRun(cwd, ["rev-parse", "HEAD"]);
  if (!head) return null;
  const tree = gitRun(cwd, ["rev-parse", "HEAD^{tree}"]);
  const branch = gitRun(cwd, ["branch", "--show-current"]);
  const originRef = gitRun(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]) || "";
  const originHead = gitRun(cwd, ["rev-parse", "@{upstream}"]) || "";
  const ahead = gitRun(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  const behind = gitRun(cwd, ["rev-list", "--count", "HEAD..@{upstream}"]);
  const remoteCount = gitRun(cwd, ["remote", "-v"]);
  return {
    repository: gitRun(cwd, ["rev-parse", "--show-toplevel"])?.split("/").pop() ?? "repository",
    branch: branch || "master",
    head,
    tree,
    origin_ref: originRef,
    origin_head: originHead,
    ahead: ahead !== null ? Number(ahead) : 0,
    behind: behind !== null ? Number(behind) : 0,
    expected_worktree_state: "clean",
    permitted_dirty_paths: [],
    captured_at: new Date().toISOString(),
    remote_count: remoteCount === null ? 0 : remoteCount.length > 0 ? 1 : 0,
  };
}

/**
 * Run the verification command as a system-observed process（bounded）.
 * The command comes from harness configuration（taskCard.verificationCommand),
 * never from model text. Returns { ok:true, exit_code, stdout, stderr,
 * duration_ms, truncated } or { ok:false, code, reason }.
 */
export function runVerificationCommand({ command, cwd, environmentAllowlist = [], timeoutMs = HARNESS_TEST_TIMEOUT_MS, limits = {} } = {}) {
  if (!Array.isArray(command) || command.length === 0 || typeof command[0] !== "string") {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.TEST_RUN_UNAVAILABLE, reason: "no verification command configured" };
  }
  const maxStdout = limits.maxStdoutBytes ?? (256 * 1024);
  const maxStderr = limits.maxStderrBytes ?? (64 * 1024);
  const env = {};
  for (const key of environmentAllowlist) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const startedAt = Date.now();
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      if (stdout.length < maxStdout) {
        stdout += c.slice(0, maxStdout - stdout.length);
        if (Buffer.byteLength(stdout, "utf8") >= maxStdout) stdoutTruncated = true;
      } else {
        stdoutTruncated = true;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      if (stderr.length < maxStderr) {
        stderr += c.slice(0, maxStderr - stderr.length);
        if (Buffer.byteLength(stderr, "utf8") >= maxStderr) stderrTruncated = true;
      } else {
        stderrTruncated = true;
      }
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.on("error", (e) => {
      finish({ ok: false, code: HARNESS_EVIDENCE_ERRORS.TEST_RUN_UNAVAILABLE, reason: `verification command failed to start: ${e.message}` });
    });
    child.on("exit", (code, signal) => {
      const timedOut = signal === "SIGKILL";
      if (timedOut) {
        finish({ ok: false, code: HARNESS_EVIDENCE_ERRORS.TEST_RUN_UNAVAILABLE, reason: "verification command timed out" });
        return;
      }
      finish({
        ok: true,
        exit_code: code ?? -1,
        stdout,
        stderr,
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        duration_ms: Date.now() - startedAt,
      });
    });
  });
}

function headBytes(text, maxBytes) {
  if (typeof text !== "string" || text.length === 0) return { value: "", truncated: false, original_bytes: 0 };
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { value: text, truncated: false, original_bytes: buf.length };
  return { value: buf.subarray(0, maxBytes).toString("utf8"), truncated: true, original_bytes: buf.length };
}

/**
 * Bounded, non-authoritative executor output diagnostic（acceptance: saved but
 * never the evidence authority; never pollutes run-result verdicts）.
 */
export function buildExecutorOutputDiagnostic(executorResult, limits = {}) {
  const stdout = executorResult?.stdout ?? "";
  const stderr = executorResult?.stderr ?? "";
  const metadata = executorResult?.metadata ?? {};
  const text = headBytes(stdout, limits.maxFinalTextBytes ?? HARNESS_OUTPUT_DIAGNOSTIC_BYTES);
  const tail = headBytes(stderr.slice(-(limits.maxStderrTailBytes ?? HARNESS_STDERR_TAIL_BYTES)), limits.maxStderrTailBytes ?? HARNESS_STDERR_TAIL_BYTES);
  let parseInfo = null;
  try {
    JSON.parse(stdout || "");
    parseInfo = { valid_json: true };
  } catch (e) {
    parseInfo = { valid_json: false, error: String(e?.message ?? e).slice(0, 2048) };
  }
  const eventCounts = metadata.protocolEventTypeCounts ?? {};
  return {
    format_version: "1.0.0",
    kind: "executor_output_diagnostic",
    authoritative: false,
    final_assistant_text: {
      stored: text.value,
      original_length: text.original_bytes,
      stored_length: Buffer.byteLength(text.value, "utf8"),
      truncated: text.truncated,
      max_bytes: text.original_bytes > (limits.maxFinalTextBytes ?? HARNESS_OUTPUT_DIAGNOSTIC_BYTES) ? (limits.maxFinalTextBytes ?? HARNESS_OUTPUT_DIAGNOSTIC_BYTES) : (limits.maxFinalTextBytes ?? HARNESS_OUTPUT_DIAGNOSTIC_BYTES),
    },
    parse_info: parseInfo,
    protocol: {
      rpc_completion_status: executorResult?.status ?? null,
      terminal_reason: metadata.terminalReason ?? null,
      assistant_message_count: eventCounts.message_end ?? 0,
      tool_call_count: metadata.toolCallCount ?? 0,
      raw_jsonl_line_count: Object.values(eventCounts).reduce((a, b) => a + (Number(b) || 0), 0),
      stderr_byte_count: tail.original_bytes,
      adapter_extraction_path: "pi-rpc-adapter get_last_assistant_text -> response.data.text -> adapter.stdout",
    },
    stderr_tail: { stored: tail.value, original_length: tail.original_bytes, truncated: tail.truncated },
  };
}

function mutationEvidenceFromDelta(delta) {
  return (delta || []).map((d) => ({ path: d.path, change_type: d.change }));
}

function scopeDeviationsFromViolations(violations) {
  return (violations || []).map((v) => ({
    path: v.path ?? v.canonical_path ?? "unknown",
    reason: v.reason ?? "scope_violation",
    authorized: false,
  }));
}

/**
 * Assemble the harness-owned implementation-evidence object.
 *
 * @param {object} opts
 * @param {string} opts.executionId — parent run execution id
 * @param {object} opts.taskCard — phase task card（executionId/phaseId/
 *   allowedPaths/repositoryRoot/verificationCommand/expectedExecutorModel/
 *   expectedExecutorProvider）
 * @param {number} opts.attempt
 * @param {object} opts.scopeCheck — { ok, violations, delta }（mutation gate）
 * @param {object|null} opts.baseline — collectGitBaseline(cwd) result
 * @param {object|null} opts.testRun — runVerificationCommand result
 * @param {string} opts.phaseStartedAt / opts.phaseCompletedAt — ISO timestamps
 * @param {object} opts.executorResult — adapter result（metadata counts）
 * @param {object} [opts.systemDelta] — C4S system-observed delta; when
 *   present, patch_sha256 binds to the real textual patch（C4S-5 consistency）
 * @param {object} [opts.limits]
 * @returns {{ok:true, evidence:object, serialized:string, bytes:number, sha256:string}}
 *   | {ok:false, code:string, reason:string}
 */
export function buildHarnessOwnedEvidence({
  executionId,
  taskCard,
  attempt,
  scopeCheck,
  baseline,
  testRun,
  phaseStartedAt,
  phaseCompletedAt,
  executorResult,
  systemDelta = null,
  limits = {},
} = {}) {
  const maxSerializedBytes = limits.maxSerializedBytes ?? HARNESS_EVIDENCE_MAX_SERIALIZED_BYTES;
  // Tool counters are surfaced through the C4N review bundle（objective_facts
  // is an AutoLoop-owned structure, not the closed evidence schema）.
  const phaseId = typeof taskCard?.phaseId === "string" ? taskCard.phaseId : null;
  const phaseExecutionIdValue = typeof taskCard?.executionId === "string" ? taskCard.executionId : null;
  if (!phaseId || !phaseExecutionIdValue) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.MISSING_FACTS, reason: "task card lacks phase id or execution id" };
  }

  // ── Gate: contract identity（mechanically bound）─────────────────────
  if (phaseExecutionIdValue !== phaseExecutionId(executionId, phaseId)) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.IDENTITY_MISMATCH, reason: "taskCard.executionId does not match phaseExecutionId(run, phase)" };
  }

  // ── Gate: facts presence ─────────────────────────────────────────────
  if (!baseline || typeof baseline.head !== "string" || baseline.head.length === 0) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.MISSING_FACTS, reason: "repository baseline facts unavailable" };
  }
  if (!scopeCheck || !Array.isArray(scopeCheck.delta)) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.MISSING_FACTS, reason: "mutation-scope delta unavailable" };
  }

  const isWriter = Array.isArray(taskCard.allowedPaths) && taskCard.allowedPaths.length > 0;
  const delta = scopeCheck.delta;
  const changedPaths = delta.map((d) => d.path).sort();
  const mutationState = changedPaths.length > 0 ? "mutated" : "unchanged";
  // C4S: when the system-observed delta was generated, bind the evidence's
  // patch identity to the real textual patch（sha256 of the unified diff）.
  // Fallback（legacy callers without a delta）keeps the deterministic
  // path-level pseudo-hash — the value is always a valid sha256 either way.
  const realPatchSha = (systemDelta?.patch?.sha256 && /^[0-9a-f]{64}$/.test(systemDelta.patch.sha256))
    ? systemDelta.patch.sha256
    : null;

  // ── Gate: writer phases require system-observed test evidence ─────────
  if (isWriter && (!testRun || testRun.ok !== true)) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.TEST_EVIDENCE_MISSING, reason: "writer phase requires system-observed verification process record" };
  }
  const testExitCode = testRun && testRun.ok ? testRun.exit_code : null;
  const testFailure = testRun && testRun.ok && testExitCode !== 0;

  const startedAt = phaseStartedAt ?? new Date().toISOString();
  const completedAt = phaseCompletedAt ?? new Date().toISOString();
  const attemptId = `${phaseId}-attempt-${Number.isInteger(attempt) ? attempt : 0}`;

  const commandRecords = [];
  // DECOMP-OPT1-PC1: when the repository baseline is inherited from the
  // frozen run snapshot, the recorded observation is the F3A per-child guard
  //（single `git rev-parse HEAD`）— never a fabricated full re-observation.
  commandRecords.push({
    command: baseline?.__inheritance?.guard_command ?? "git rev-parse HEAD && git rev-parse HEAD^{tree} && git branch --show-current",
    status: "ok",
    exit_code: 0,
  });
  if (testRun && testRun.ok) {
    commandRecords.push({
      command: Array.isArray(taskCard.verificationCommand) ? taskCard.verificationCommand.join(" ") : "verification command",
      status: testExitCode === 0 ? "ok" : "failed",
      exit_code: testExitCode ?? -1,
    });
  }

  const evidence = {
    schema_version: HARNESS_EVIDENCE_FORMAT,
    contract_id: phaseExecutionIdValue, // harness-bound; never model-authored
    design_revision_id: phaseId,
    design_contract_hash: createHash("sha256").update(`autoloop:phase-contract:${phaseId}:${phaseExecutionIdValue}`).digest("hex"),
    implementation_attempt_id: attemptId,
    parent_attempt_id: executionId ?? "",
    executor_invocation: {
      schema_version: "autoloop.model-invocation/v1",
      invocation_id: phaseExecutionIdValue,
      attempt_id: attemptId,
      role: "executor",
      provider: taskCard.expectedExecutorProvider ?? "deepseek",
      configured_model: taskCard.expectedExecutorModel ?? "",
      requested_model: taskCard.expectedExecutorModel ?? "",
      effective_model: "NOT_REPORTED_BY_PROVIDER",
      provider_request_id: "NOT_REPORTED",
      started_at: startedAt,
      completed_at: completedAt,
      result_status: "SUCCEEDED",
    },
    repository_baseline: {
      repository: baseline.repository,
      branch: baseline.branch,
      head: baseline.head,
      origin_ref: baseline.origin_ref ?? "",
      origin_head: (baseline.origin_head && /^[0-9a-f]{40}$/.test(baseline.origin_head)) ? baseline.origin_head : "0000000000000000000000000000000000000000",
      ahead: baseline.ahead ?? 0,
      behind: baseline.behind ?? 0,
      expected_worktree_state: "clean",
      permitted_dirty_paths: [],
      captured_at: baseline.captured_at ?? startedAt,
      // DECOMP-OPT1-PC1: inherited run-level snapshot marker — makes the
      // freshness claim explicit and machine-checkable（F3A by digest; F3B
      // never claimed fresh per child, R1-C）. The schema validator accepts
      // the extra block（repository_baseline shape is required-fields-only）.
      ...(baseline.__inheritance ? { inheritance: baseline.__inheritance } : {}),
    },
    initial_integrity: baseline.tree ?? baseline.head,
    final_integrity: baseline.tree ?? baseline.head,
    authorized_paths: Array.isArray(taskCard.allowedPaths) ? [...taskCard.allowedPaths].sort() : [],
    actual_changed_paths: changedPaths,
    patch_sha256: realPatchSha ?? sha256Text(JSON.stringify(changedPaths) + ":" + mutationState),
    commands: commandRecords,
    compile_results: [],
    test_results: (() => {
      if (!testRun || !testRun.ok) return [];
      const entry = {
        test_identifier: "harness-verification-command",
        outcome: testExitCode === 0 ? "passed" : "failed",
        command: Array.isArray(taskCard.verificationCommand) ? taskCard.verificationCommand.join(" ") : "verification command",
        exit_code: testExitCode ?? -1,
      };
      if (Number.isInteger(testRun.duration_ms)) entry.duration_ms = testRun.duration_ms;
      return [entry];
    })(),
    negative_evidence: changedPaths.length > 0
      ? [{ claim: `git status --short reports exactly ${changedPaths.length} modified path(s); no other repository artifact changed`, evidence_type: "git_status_output" }]
      : [{ claim: "no repository artifact was modified during this phase", evidence_type: "git_status_output" }],
    mutation_evidence: mutationEvidenceFromDelta(delta),
    skipped_evidence: [],
    known_failures: testFailure ? [{ description: `verification command exited ${testExitCode}`, severity: "HIGH" }] : [],
    environment_limits: { max_command_results: 0, max_path_length: 0, max_test_results: 0, notes: "harness-owned bounded observation" },
    scope_deviations: scopeDeviationsFromViolations(scopeCheck.violations),
    executor_verdict: (scopeCheck.ok && !testFailure) ? "PASS" : "FAIL", // system-derived disposition
    timestamps: { started_at: startedAt, completed_at: completedAt },
    integrity: sha256Text(`autoloop:harness-evidence:${phaseExecutionIdValue}:${attemptId}:${JSON.stringify(changedPaths)}:${testExitCode}`),
  };

  // ── Gate: schema validation（deterministic; never guessed fields）─────
  const schemaCheck = validateImplementationEvidence(evidence);
  if (!schemaCheck.valid) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.SCHEMA_INVALID, reason: `harness-owned evidence failed schema validation: ${(schemaCheck.errors || []).slice(0, 3).join("; ")}` };
  }

  // ── Gate: serialized size bound ──────────────────────────────────────
  let serialized;
  try {
    serialized = JSON.stringify(evidence);
  } catch {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.BUILD_FAILED, reason: "harness evidence could not be serialized" };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxSerializedBytes) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.OVERSIZE, reason: `harness evidence exceeds size bound (${bytes} > ${maxSerializedBytes})` };
  }

  // ── Gate: secret-pattern scan（names only, no echo）──────────────────
  const scan = scanForSecrets(serialized);
  if (!scan.safe) {
    return { ok: false, code: HARNESS_EVIDENCE_ERRORS.SECRET_RISK, reason: `harness evidence matched secret patterns: ${scan.matches.join(",")}` };
  }

  return { ok: true, evidence, serialized, bytes, sha256: sha256Text(serialized) };
}
