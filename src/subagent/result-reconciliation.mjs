// src/subagent/result-reconciliation.mjs
//
// CEDF Foundation — child-result reconciliation.
//
// Pure, deterministic reconciliation over ALREADY-PERSISTED dependency child
// results（the shared results dir entries already consumed through
// dependencyResultsDigest / dependencyResultIdentities）. Before a downstream
// phase binds its dependencies' persisted results as frozen prerequisite
// context, their claims are checked pairwise:
//
//   - CONTRADICTORY_OUTCOME: two children claim OPPOSITE outcomes over the
//     same subject（same `covers` requirement_id or the same file path via
//     writer `filesChanged`）— one PASS, one REPAIR/HOLD/CANCELLED/error.
//   - DUPLICATE_CLAIM: the same subject is claimed COMPLETE（PASS）by two
//     distinct non-join children（a join verifier re-observing a subject is
//     NOT a duplicate claim）.
//
// Fail-closed: any detected conflict yields verdict CONFLICT; the caller
// injects the rendered findings into the EXISTING buildSubagentEnvelope
// blockingFindings channel so the downstream reviewer / lifecycle HOLDs —
// a valid dependencyResultsDigest never upgrades a CONFLICT into a clean
// prerequisite. No IO, no randomness, no authority of its own: this module
// is consumed by the existing subagent-graph-runner onPhaseStart seam.
//
// Subject surface note（shape alignment）: the persisted structured result
// schemas（autoloop.subagent.structured-result/v1,
// autoloop.subagent.writer-result/v1）have NO findings/`covers` field today —
// subjects are derived ONLY from fields that actually exist:
//   - `filesChanged`（writer schema — the mutation/completion claim surface）
//   - `covers` requirement ids（consumed when a generation declares them;
//     absent in the current schemas and simply contributing no subjects）
// `filesInspected` is deliberately excluded: inspecting a path is an
// observation record, not an outcome claim about it.

/** Statuses that mean the child did NOT cleanly complete its outcome claim. */
const FAILED_OUTCOMES = new Set(["REPAIR", "HOLD", "CANCELLED", "error"]);

/**
 * Classify a persisted child result's overall outcome.
 * Returns "PASS" | "FAILED" | null（unknown/absent status carries no claim）.
 */
function outcomeOf(result) {
  const status = result?.status;
  if (status === "PASS") return "PASS";
  if (typeof status === "string" && FAILED_OUTCOMES.has(status)) return "FAILED";
  return null;
}

/**
 * Extract the claim subjects of one persisted child result:
 * canonical `covers` requirement ids（when present）+ writer `filesChanged`
 * paths（trailing-slash normalized）. Deduplicated, deterministic order.
 */
function claimSubjects(result) {
  const subjects = [];
  if (Array.isArray(result?.covers)) {
    for (const c of result.covers) {
      const id = typeof c === "string" ? c : c?.requirement_id;
      if (typeof id === "string" && id.length > 0) subjects.push(`requirement:${id}`);
    }
  }
  if (Array.isArray(result?.filesChanged)) {
    for (const f of result.filesChanged) {
      if (typeof f === "string" && f.length > 0) subjects.push(String(f).replace(/\/+$/, ""));
    }
  }
  return [...new Set(subjects)];
}

function isJoinRole(role) {
  return role === "join";
}

/**
 * Reconcile persisted dependency child results（fail-closed, pure）.
 *
 * @param {Array<{phaseId: string, role?: string|null, result: object|null}>}
 *   dependencyResults — one record per persisted dependency child result, in
 *   a fixed order（callers mirror the dependencyResultIdentities load order）.
 *   `role === "join"` marks join-verifier children（excluded from
 *   DUPLICATE_CLAIM）; `result` is the parsed persisted JSON（null when
 *   unparseable — contributes no claims）.
 * @returns {{verdict: "COHERENT"|"CONFLICT", conflicts: Array<{kind: string, leftPhaseId: string, rightPhaseId: string, subject: string}>}}
 */
export function reconcileChildResults(dependencyResults) {
  if (!Array.isArray(dependencyResults)) {
    throw new TypeError("reconcileChildResults: dependencyResults must be an array");
  }
  const records = dependencyResults.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("reconcileChildResults: each dependency record must be an object");
    }
    if (typeof entry.phaseId !== "string" || entry.phaseId.length === 0) {
      throw new TypeError("reconcileChildResults: dependency record missing phaseId");
    }
    if (entry.result !== null && (typeof entry.result !== "object" || Array.isArray(entry.result))) {
      throw new TypeError(`reconcileChildResults: dependency ${entry.phaseId} result must be an object or null`);
    }
    return { phaseId: entry.phaseId, role: typeof entry.role === "string" ? entry.role : null, result: entry.result };
  });

  // Pre-extract per-record subjects/outcomes once（deterministic）.
  const extracted = records.map((r) => ({
    phaseId: r.phaseId,
    isJoin: isJoinRole(r.role),
    subjects: new Set(claimSubjects(r.result)),
    outcome: outcomeOf(r.result),
  }));

  const conflicts = [];
  const pushConflict = (kind, left, right, subject) => {
    conflicts.push({ kind, leftPhaseId: left.phaseId, rightPhaseId: right.phaseId, subject });
  };

  for (let i = 0; i < extracted.length; i++) {
    for (let j = i + 1; j < extracted.length; j++) {
      const left = extracted[i];
      const right = extracted[j];
      for (const subject of [...left.subjects].sort()) {
        if (!right.subjects.has(subject)) continue;
        const lo = left.outcome;
        const ro = right.outcome;
        if ((lo === "PASS" && ro === "FAILED") || (lo === "FAILED" && ro === "PASS")) {
          pushConflict("CONTRADICTORY_OUTCOME", left, right, subject);
        } else if (lo === "PASS" && ro === "PASS" && !left.isJoin && !right.isJoin) {
          pushConflict("DUPLICATE_CLAIM", left, right, subject);
        }
      }
    }
  }

  // Deterministic conflict ordering（kind, then endpoints, then subject）.
  conflicts.sort((a, b) =>
    a.kind.localeCompare(b.kind) ||
    a.leftPhaseId.localeCompare(b.leftPhaseId) ||
    a.rightPhaseId.localeCompare(b.rightPhaseId) ||
    a.subject.localeCompare(b.subject)
  );

  return { verdict: conflicts.length > 0 ? "CONFLICT" : "COHERENT", conflicts };
}

/**
 * Render one conflict as a blockingFindings entry（single definition of the
 * finding format injected into buildSubagentEnvelope's existing
 * blockingFindings channel）. Space-free codes so the review agent's
 * busybox-sh word-splitting consumes them verbatim.
 */
export function reconciliationFinding(conflict) {
  return `DEPENDENCY_CONFLICT:${conflict.kind}:${conflict.leftPhaseId}!${conflict.rightPhaseId}:${conflict.subject}`;
}
