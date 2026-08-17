// src/v2/review-evidence.mjs
//
// C4N — system-assembled reviewer evidence bundle.
//
// The read-only reviewer is invoked with ONLY the task card today; the
// executor's validated implementation evidence never reaches it, so the
// reviewer cannot independently review anything and correctly answers
// NEEDS_SUPPLEMENT (C4M: REVIEWER_EVIDENCE_GAP). This module builds the
// missing piece: a bounded, credential-safe, content-addressed review
// bundle assembled by AutoLoop code (never by the model) and delivered to
// the reviewer inside its adapter request.
//
// Design contract:
//   - The bundle is assembled ONLY from system facts (task card, execution
//     identity, mutation-scope delta, read-only git state) and the
//     implementation-evidence object assembled by the AutoLoop harness
//     (C4Q: harness-owned; the executor final message is non-authoritative).
//     The evidence has already passed schema validation in the harness
//     builder before it reaches this bundle.
//   - Deterministic fail-closed gates (in order): evidence presence,
//     contract identity correspondence, test-result internal coherence,
//     serialized size bound, secret-pattern scan. A failing gate blocks
//     review and HOLDS the run; it never rewrites the executor verdict and
//     never emits partial/truncated gate-relevant content.
//   - The bundle never carries credentials, environment values, raw
//     unrestricted stdout/stderr, or unscanned diagnostic text.
//   - Objective execution facts (repository head/tree, changed paths,
//     mutation state, authorized paths) are SYSTEM-observed; executor-
//     reported test executions are carried with an explicit source marker
//     so the reviewer can compare claims against facts and HOLD on any
//     inconsistency.

import { execFileSync } from "node:child_process";
import { canonicalJson, scanForSecrets, sha256Text } from "../evidence/run-evidence-store.mjs";
import { SYSTEM_DELTA_ERRORS, SYSTEM_DELTA_FORMAT_VERSION } from "./system-delta.mjs";

export const REVIEW_EVIDENCE_FORMAT_VERSION = "autoloop.review-evidence/v1";

// C4S: the bundle now carries the bounded, system-observed textual diff
//（inline patch ≤ SYSTEM_DELTA_MAX_PATCH_BYTES = 64 KiB）. The serialized-size
// bound is raised to accommodate that inline evidence while staying
// fail-closed（OVERSIZE still blocks delivery; no truncation ever）.
/** Serialized-size bound for the review bundle（fail-closed; no truncation）. */
export const REVIEW_EVIDENCE_MAX_SERIALIZED_BYTES = 192 * 1024;

/** Deterministic fail-closed gate codes（never free text from evidence）. */
export const REVIEW_EVIDENCE_ERRORS = Object.freeze({
  MISSING: "REVIEW_EVIDENCE_MISSING",
  IDENTITY_MISMATCH: "REVIEW_EVIDENCE_IDENTITY_MISMATCH",
  TEST_INCONSISTENCY: "REVIEW_EVIDENCE_TEST_INCONSISTENCY",
  OVERSIZE: "REVIEW_EVIDENCE_OVERSIZE",
  SECRET_RISK: "REVIEW_EVIDENCE_SECRET_RISK",
  BUILD_FAILED: "REVIEW_EVIDENCE_BUILD_FAILED",
});

/** Read-only git observation（committed head/tree）; null on any failure. */
function gitHeadTree(repositoryRoot) {
  const run = (args) => {
    try {
      const out = execFileSync("git", ["-C", repositoryRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.trim();
    } catch {
      return null;
    }
  };
  return { head: run(["rev-parse", "HEAD"]), tree: run(["rev-parse", "HEAD^{tree}"]) };
}

function testCoherenceError(evidence) {
  const results = Array.isArray(evidence?.test_results) ? evidence.test_results : [];
  for (const tr of results) {
    if (!tr || typeof tr !== "object") continue;
    const outcome = tr.outcome;
    const exitCode = tr.exit_code;
    if (typeof exitCode !== "number") continue; // optional per schema
    if (outcome !== "passed" && outcome !== "failed") continue; // skipped/ignored etc.
    if ((outcome === "passed") !== (exitCode === 0)) {
      return { test_identifier: typeof tr.test_identifier === "string" ? tr.test_identifier.slice(0, 200) : null, outcome, exit_code: exitCode };
    }
  }
  return null;
}

/**
 * Build the reviewer evidence bundle.
 *
 * @param {object} opts
 * @param {string} opts.executionId — parent run execution id
 * @param {object} opts.taskCard — phase task card（executionId/phaseId/allowedPaths/repositoryRoot）
 * @param {number} opts.attempt
 * @param {object} opts.evidence — executor implementation evidence（already
 *   passed strict JSON.parse + schema validation）
 * @param {string[]} opts.observedChangedPaths — system-observed changed
 *   paths（mutation-scope delta）; default []
 * @param {object} [opts.systemDelta] — C4S system-observed delta（produced by
 *   buildSystemObservedDelta）; identity-bound and SHA-verified before it is
 *   embedded. Optional for legacy callers（no delta ⇒ no content evidence）.
 * @param {object} [opts.limits] — { maxSerializedBytes }
 * @returns {{ok:true, bundle:object, serialized:string, bytes:number, sha256:string}}
 *   | {ok:false, code:string, reason:string}
 */
export function buildReviewEvidenceBundle({
  executionId,
  taskCard,
  attempt,
  evidence,
  observedChangedPaths = [],
  toolExecutionCount = null,
  systemDelta = null,
  limits = {},
} = {}) {
  const maxSerializedBytes = limits.maxSerializedBytes ?? REVIEW_EVIDENCE_MAX_SERIALIZED_BYTES;

  // ── Gate 1: evidence presence（strict object）────────────────────────
  if (evidence === undefined || evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { ok: false, code: REVIEW_EVIDENCE_ERRORS.MISSING, reason: "executor implementation evidence is not a non-null object" };
  }

  const phaseExecutionIdValue = typeof taskCard?.executionId === "string" ? taskCard.executionId : null;
  const phaseId = typeof taskCard?.phaseId === "string" ? taskCard.phaseId : "unknown";

  // ── Gate 2: contract identity correspondence ─────────────────────────
  // The executor evidence must bind to the exact phase contract the system
  // issued（phaseExecutionId = sha256(run:id:phase)）. A fabricated or stale
  // contract id fails closed before any review.
  if (!phaseExecutionIdValue || evidence.contract_id !== phaseExecutionIdValue) {
    return {
      ok: false,
      code: REVIEW_EVIDENCE_ERRORS.IDENTITY_MISMATCH,
      reason: "evidence.contract_id does not match the phase execution id issued by AutoLoop",
    };
  }

  // ── Gate 2b: C4S system delta identity + patch identity ──────────────
  // A stale / cross-phase / cross-run / erroneous delta must be rejected
  // before it reaches the reviewer（C4S-3）; the declared patch SHA must
  // match the actual patch bytes（C4S-5 patch identity）. The full patch
  // bound was already enforced at generation time（C4S-7）; a truncated
  // delta is rejected here as a second line of defense.
  if (systemDelta !== undefined && systemDelta !== null) {
    if (systemDelta.identity?.contract_id !== phaseExecutionIdValue) {
      return {
        ok: false,
        code: SYSTEM_DELTA_ERRORS.IDENTITY_MISMATCH,
        reason: "system delta contract_id does not match the phase execution id issued by AutoLoop",
      };
    }
    const patchText = systemDelta.patch?.text;
    const patchSha = systemDelta.patch?.sha256;
    const patchBytes = systemDelta.patch?.byte_count;
    if (typeof patchText !== "string" || typeof patchSha !== "string" || !Number.isInteger(patchBytes)) {
      return { ok: false, code: SYSTEM_DELTA_ERRORS.SHA_MISMATCH, reason: "system delta patch record is incomplete" };
    }
    if (patchSha !== sha256Text(patchText)) {
      return { ok: false, code: SYSTEM_DELTA_ERRORS.SHA_MISMATCH, reason: "system delta patch sha256 does not match the patch bytes" };
    }
    if (patchBytes !== Buffer.byteLength(patchText, "utf8")) {
      return { ok: false, code: SYSTEM_DELTA_ERRORS.SHA_MISMATCH, reason: "system delta patch byte_count does not match the patch bytes" };
    }
    if (systemDelta.patch.truncated === true || systemDelta.patch.generation_status !== "ok") {
      return { ok: false, code: SYSTEM_DELTA_ERRORS.TOO_LARGE, reason: "system delta patch is truncated or failed to generate; delivery blocked" };
    }
  }

  // ── Gate 3: test-result internal coherence ───────────────────────────
  // A claim of "passed" with a non-zero exit code (or "failed" with exit 0)
  // is internally incoherent and cannot be trusted for review.
  const incoherent = testCoherenceError(evidence);
  if (incoherent) {
    return { ok: false, code: REVIEW_EVIDENCE_ERRORS.TEST_INCONSISTENCY, reason: "executor test_results are internally inconsistent (outcome vs exit_code)" };
  }

  // ── Objective facts（system-observed）─────────────────────────────────
  const sortedChanged = [...observedChangedPaths].sort();
  // DECOMP-OPT1-PC1: the frozen F3A snapshot（verified by the per-child
  // guard）replaces the per-child `rev-parse HEAD`/`HEAD^{tree}` re-read;
  // without inheritance the legacy observation runs unchanged.
  const inherited = taskCard?.inheritedBaseline;
  const gitFacts = inherited
    ? { head: inherited.head, tree: inherited.tree ?? inherited.head }
    : (taskCard?.repositoryRoot ? gitHeadTree(taskCard.repositoryRoot) : { head: null, tree: null });
  const bundle = {
    format_version: REVIEW_EVIDENCE_FORMAT_VERSION,
    execution_identity: {
      run_execution_id: executionId ?? null,
      phase_execution_id: phaseExecutionIdValue,
      phase_id: phaseId,
      attempt: Number.isInteger(attempt) ? attempt : null,
    },
    executor_implementation_evidence: {
      schema_version: typeof evidence.schema_version === "string" ? evidence.schema_version : null,
      contract_id: typeof evidence.contract_id === "string" ? evidence.contract_id : null,
      original: evidence,
    },
    objective_facts: {
      repository_root: taskCard?.repositoryRoot ?? null,
      repository_head: gitFacts.head,
      repository_tree: gitFacts.tree,
      authorized_paths: Array.isArray(taskCard?.allowedPaths) ? [...taskCard.allowedPaths].sort() : [],
      actual_changed_paths: sortedChanged,
      mutation_state: sortedChanged.length > 0 ? "mutated" : "unchanged",
      tool_execution_count: Number.isInteger(toolExecutionCount) ? toolExecutionCount : null,
      observed_at: new Date().toISOString(),
      // System-observed test executions（harness verification-command process
      // records; never executor self-reporting）. The reviewer treats them as
      // objective facts, cross-checked against the rest of the bundle.
      test_executions: (Array.isArray(evidence.test_results) ? evidence.test_results : []).map((tr) => ({
        test_identifier: typeof tr?.test_identifier === "string" ? tr.test_identifier : null,
        command: typeof tr?.command === "string" ? tr.command : null,
        exit_code: typeof tr?.exit_code === "number" ? tr.exit_code : null,
        outcome: typeof tr?.outcome === "string" ? tr.outcome : null,
        source: "system_observed",
      })),
    },
    durable_references: {
      evidence_artifact_path: `phases/${phaseId}/implementation-evidence-${attempt ?? 0}.json`,
      evidence_artifact_sha256: sha256Text(canonicalJson(evidence) + "\n"),
      executor_completed_event: {
        event_type: "EXECUTOR_COMPLETED",
        evidence_hash: sha256Text(canonicalJson(evidence)),
      },
    },
    // C4S: reviewer-visible system-observed delta（bounded inline diff +
    // durable artifact references）. source=system_observed / authoritative
    // / producer=harness — assembled by AutoLoop from baseline + sandbox
    // state, never from model text.
    system_delta: systemDelta ? {
      format_version: systemDelta.format_version ?? SYSTEM_DELTA_FORMAT_VERSION,
      source: "system_observed",
      authoritative: true,
      producer: "harness",
      identity: {
        contract_id: systemDelta.identity?.contract_id ?? null,
        phase_id: systemDelta.identity?.phase_id ?? null,
        run_execution_id: systemDelta.identity?.run_execution_id ?? null,
        parent_execution_id: systemDelta.identity?.parent_execution_id ?? null,
        baseline_head: systemDelta.identity?.baseline_head ?? null,
        baseline_tree: systemDelta.identity?.baseline_tree ?? null,
        observed_at: systemDelta.identity?.observed_at ?? null,
      },
      changed_paths: Array.isArray(systemDelta.changed_paths) ? systemDelta.changed_paths : [],
      patch: {
        text: typeof systemDelta.patch?.text === "string" ? systemDelta.patch.text : "",
        byte_count: systemDelta.patch?.byte_count ?? null,
        sha256: systemDelta.patch?.sha256 ?? null,
        truncated: false,
        generation_status: systemDelta.patch?.generation_status ?? null,
        max_bytes: systemDelta.patch?.max_bytes ?? null,
      },
      durable_references: {
        artifact_json: systemDelta.artifacts?.json ?? null,
        artifact_patch: systemDelta.artifacts?.patch ?? null,
      },
    } : null,
    review_scope: {
      reviewer_tools: "none",
      reviewer_read_only: true,
      mutation_authority: false,
      commit_authority: false,
      push_authority: false,
      seal_authority: false,
      verdict_basis: "task card facts + reviewEvidence bundle only; never fabricated",
    },
  };

  // ── Gate 4: serialized size bound（fail-closed; no silent truncation）──
  let serialized;
  try {
    serialized = JSON.stringify(bundle);
  } catch {
    return { ok: false, code: REVIEW_EVIDENCE_ERRORS.BUILD_FAILED, reason: "review evidence bundle could not be serialized" };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxSerializedBytes) {
    return {
      ok: false,
      code: REVIEW_EVIDENCE_ERRORS.OVERSIZE,
      reason: `review evidence bundle exceeds serialized size bound (${bytes} > ${maxSerializedBytes}); refusing to truncate gate-relevant fields`,
    };
  }

  // ── Gate 5: secret-pattern scan（defense in depth; names only, no echo）─
  const scan = scanForSecrets(serialized);
  if (!scan.safe) {
    return {
      ok: false,
      code: REVIEW_EVIDENCE_ERRORS.SECRET_RISK,
      reason: `review evidence bundle matched secret patterns: ${scan.matches.join(",")}; delivery blocked`,
    };
  }

  return { ok: true, bundle, serialized, bytes, sha256: sha256Text(serialized) };
}
