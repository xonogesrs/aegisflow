// src/memory/writeback/graph.mjs
//
// CBM-4 — Stage 13: production Graph write-back integration.
//
// Runs ONLY after the graph is final（post-closeout, post-verification）and
// derives write-back candidates from STRUCTURED graph fields:
//   - EXECUTION memory: the final task verdict（graph/closeout authority）
//   - CODE memory: verifier/reviewer-backed affected paths（never writer
//     self-claims）— requires the independent review identity binding
// DECISION memory is never auto-derived（Controller-only）.
//
// The gate is the single enforcement point; every outcome is structured and
// every failure degrades WITHOUT changing the graph outcome（write-back is an
// evidence-governed side effect, not a task authority）.

import { createWritebackCandidate } from "./candidate.mjs";
import { runWritebackGate } from "./gate.mjs";
import { recordWritebackTelemetry } from "./telemetry.mjs";
import { writebackSourceMap } from "./source-map.mjs";

export const GRAPH_WRITEBACK_SCHEMA = "autoloop.memory-graph-writeback/v1";

// Canonical evidence result identities are sha256 digests（64-hex）. The
// graph only attests identities it actually produced: closeout bundle digest,
// node phase/result identities, verifier node result identities and review
// result identities. An identity NOT in this inventory（forged / from another
// graph）cannot grant VERIFIED/REVIEWED trust.
const RESULT_IDENTITY_RE = /^[0-9a-f]{64}$/;

/**
 * Derive the graph/task's canonical evidence inventory from a FINAL graph
 * result — the ONLY identities the gate may bind verifier/reviewer claims to.
 * @returns {{ schema, graphRunId, taskCardIds: string[], resultIdentities: string[], verifierIdentities: string[], reviewIdentities: string[] }}
 */
export function canonicalEvidenceForGraph(graphResult) {
  const graphRunId = graphResult?.executionId ?? null;
  const taskCardIds = new Set(["graph-closeout", "graph-run"]);
  const resultIdentities = new Set();
  const verifierIdentities = new Set();
  const reviewIdentities = new Set();
  const addHex = (set, v) => { if (typeof v === "string" && RESULT_IDENTITY_RE.test(v)) set.add(v); };
  addHex(resultIdentities, graphResult?.closeout?.bundle?.identity);
  for (const n of graphResult?.nodeResults ?? []) {
    if (typeof n?.taskType === "string" && n.taskType) taskCardIds.add(n.taskType);
    addHex(resultIdentities, n?.phaseExecutionId);
    const isVerifierNode = /^SA-V/.test(n?.nodeId ?? "") || /verif/i.test(n?.taskType ?? "");
    if (typeof n?.resultIdentity === "string") {
      addHex(resultIdentities, n.resultIdentity);
      if (isVerifierNode) verifierIdentities.add(n.resultIdentity);
    }
    const ri = n?.reviewResult?.resultIdentity;
    if (typeof ri === "string" && RESULT_IDENTITY_RE.test(ri)) {
      resultIdentities.add(ri);
      reviewIdentities.add(ri);
    }
  }
  return {
    schema: "autoloop.memory-canonical-evidence/v1",
    graphRunId,
    taskCardIds: [...taskCardIds],
    resultIdentities: [...resultIdentities],
    verifierIdentities: [...verifierIdentities],
    reviewIdentities: [...reviewIdentities],
  };
}

/**
 * Run governed write-back for a FINAL graph result.
 * @param {object} opts
 * @param {object} opts.graphResult - runColimaGraph result（final; closeout done）
 * @param {object} opts.store - LocalMemoryStore（open; WRITE access）
 * @param {object} [opts.telemetryStore] - COST-1 store（memory.writeback events）
 * @param {string} [opts.reviewIdentity] - independent review identity binding
 * @param {string} [opts.verifierIdentity] - verifier evidence identity binding
 * @param {string} [opts.expectedRepository] - repo the graph ran over
 * @param {object} [opts.canonicalEvidence] - canonical evidence inventory
 *   override; derived from graphResult when absent（the graph attests its own
 *   node / review / closeout result identities — forged or foreign verifier /
 *   reviewer identities fail the gate）
 * @param {string} [opts.now]
 * @returns {Promise<{ok, outcomes, statusCounts, telemetry}>}
 */
export async function runGraphWriteback({ graphResult, store, telemetryStore = null, reviewIdentity = null, verifierIdentity = null, expectedRepository = null, canonicalEvidence = null, now = new Date().toISOString() } = {}) {
  const graphRunId = graphResult?.executionId ?? null;
  const finalVerdict = graphResult?.final ?? "HOLD";
  const closeout = graphResult?.closeout ?? {};
  const t0 = Date.now();
  const outcomes = [];
  const failed = (status, reason, extra = {}) => outcomes.push({ status, candidateId: null, reason, ...extra });

  // Canonical evidence inventory: the gate binds verifier/reviewer identities
  // to THIS graph's attested result identities（never a bare hex64 check）.
  const canonical = canonicalEvidence ?? canonicalEvidenceForGraph(graphResult);

  if (!graphRunId || !store || typeof store.explicitImport !== "function") {
    failed("WRITEBACK_STORE_INVALID", "graph_or_store_missing");
    return { ok: false, outcomes, statusCounts: counts(outcomes), telemetry: null };
  }

  // ── EXECUTION memory（final verdict; graph/closeout authority）───────────
  // Trust ladder（honest evidence ceiling）:
  //   REVIEWED  only when an independent review identity is bound + closeout PASS
  //   VERIFIED  when a verifier identity is bound（verifier-backed execution fact）
  //   UNVERIFIED otherwise — execution HISTORY with no higher claim（never a
  //   fabricated verification）. A HOLD graph still records execution history
  //   but unproven CODE truth never enters.
  const executionTrust = reviewIdentity && closeout.final === "PASS" ? "REVIEWED" : (verifierIdentity ? "VERIFIED" : "UNVERIFIED");
  const manifestRef = closeout.bundle?.identity ? `manifest:${closeout.bundle.identity}` : `manifest:${graphRunId}`;
  try {
    const execCandidate = createWritebackCandidate({
      graphRunId,
      taskCardId: graphResult?.closeout?.bundle ? "graph-closeout" : "graph-run",
      originatingNode: "graph",
      sourceResultIdentity: `graph:${graphRunId}`,
      proposedRecordType: "EXECUTION",
      proposedIdentity: {
        repositoryIdentity: expectedRepository ?? "0".repeat(64),
        treeSha: graphResult?.treeSha ?? null,
        resultStatus: finalVerdict,
      },
      proposedSubjectStatement: `graph ${graphRunId} final ${finalVerdict}${closeout.final === "PASS" ? " (closeout PASS)" : ""}`,
      proposedContent: { kind: "TEXT", text: `graph ${graphRunId} final ${finalVerdict}` },
      proposedScope: { repository: expectedRepository ?? "0".repeat(64), graphRun: graphRunId },
      evidenceReferences: [manifestRef, ...(verifierIdentity ? [`verifier:${verifierIdentity}`] : []), ...(reviewIdentity ? [`review:${reviewIdentity}`] : [])],
      proposedTrust: executionTrust,
      proposedRelationships: [],
      lifecycleIntent: "CREATE",
      origin: reviewIdentity ? "independent_reviewer" : "graph_closeout",
    });
    outcomes.push(await runWritebackGate({ candidate: execCandidate, store, reviewIdentity, verifierIdentity, expectedRepository, canonicalEvidence: canonical, telemetryStore: null, now }));
  } catch (e) {
    failed("WRITEBACK_REJECTED", `execution_candidate_error:${String(e?.message ?? e).slice(0, 120)}`);
  }

  // ── CODE memory（verifier/reviewer-backed affected paths ONLY）───────────
  // writer self-claims never become CODE memory（trust gate rejects）.
  if (closeout.final === "PASS") {
    for (const n of graphResult?.nodeResults ?? []) {
      const review = n?.reviewResult;
      const reviewPass = review?.recommendedAction === "PASS" && Array.isArray(review?.blockingFindings) && review.blockingFindings.length === 0;
      // reviewer is the trust gate for writer-derived CODE facts（stage 13）:
      // a non-PASS review means the writer's claims are unproven -> no CODE
      if (!reviewPass) continue;
      const output = n?.worktreeIdentity?.output;
      const files = Array.isArray(output?.files) ? output.files : [];
      const changedPaths = files
        .map((f) => typeof f === "string" ? f : (f?.path ?? null))
        .filter((p) => p && /\.(mjs|js|ts|json|md)$/.test(p));
      if (changedPaths.length === 0) continue;
      const codeTrust = reviewIdentity ? "REVIEWED" : (verifierIdentity ? "VERIFIED" : null);
      if (!codeTrust) continue; // no evidence identity -> no CODE write-back
      for (const path of changedPaths.slice(0, 20)) {
        try {
          const codeCandidate = createWritebackCandidate({
            graphRunId,
            taskCardId: n?.taskType ?? "subagent",
            originatingNode: n?.nodeId ?? "SA-W1",
            sourceResultIdentity: `node:${graphRunId}:${n?.nodeId ?? "SA-W1"}`,
            proposedRecordType: "CODE",
            proposedIdentity: {
              repositoryIdentity: expectedRepository ?? "0".repeat(64),
              commitSha: graphResult?.commitSha ?? "0".repeat(40),
              treeSha: graphResult?.treeSha ?? null,
              path,
              knowledgeKind: "FILE",
            },
            proposedSubjectStatement: `path ${path} affected in graph ${graphRunId}; evidence-verified`,
            proposedContent: { kind: "TEXT", text: `path ${path} modified and verified in graph ${graphRunId}` },
            proposedScope: { repository: expectedRepository ?? "0".repeat(64), tree: graphResult?.treeSha ?? null, path },
            evidenceReferences: [
              manifestRef,
              ...(verifierIdentity ? [`verifier:${verifierIdentity}`] : []),
              ...(reviewIdentity ? [`review:${reviewIdentity}`] : []),
              n?.phaseExecutionId ?? graphRunId,
            ],
            proposedTrust: codeTrust,
            proposedRelationships: [],
            lifecycleIntent: "CREATE",
            origin: reviewPass ? "independent_reviewer" : "verifier",
          });
          outcomes.push(await runWritebackGate({ candidate: codeCandidate, store, reviewIdentity, verifierIdentity, expectedRepository, canonicalEvidence: canonical, telemetryStore: null, now }));
        } catch (e) {
          failed("WRITEBACK_REJECTED", `code_candidate_error:${String(e?.message ?? e).slice(0, 120)}`);
        }
      }
    }
  }

  const bytesWritten = estimateBytes(store);
  const durationMs = Date.now() - t0;
  const telemetry = recordWritebackTelemetry({ telemetryStore, graphRunId, outcomes, bytesWritten, durationMs });
  return { ok: true, outcomes, statusCounts: counts(outcomes), telemetry, sourceMap: writebackSourceMap() };
}

function counts(outcomes) {
  const c = {};
  for (const o of outcomes) c[o.status] = (c[o.status] ?? 0) + 1;
  return c;
}

function estimateBytes(store) {
  try {
    if (typeof store.byteCount === "function") return store.byteCount();
  } catch { /* best effort */ }
  return null;
}
