// test/memory/test-r2-helpers.mjs
//
// R2 shared fixtures/helpers — built FROM helpers-cbm3.mjs / helpers.mjs
// (existing helpers NOT modified; TEST-MATRIX family table). Deterministic;
// no wall clock in any identity-bearing field.

import { MEMORY_RECORD_SCHEMA, NOT_APPLICABLE, deriveContentHash, deriveMemoryRecordId, deriveLogicalKey } from "../../src/memory/index.mjs";

export const T = "2026-09-08T00:00:00.000Z";
export const hex64 = (c) => c.repeat(64);
export const hex40 = (c) => c.repeat(40);

export const REPO = hex64("1");
export const REPO_OTHER = hex64("2");
export const RUN = "r2-chain-run-1";
export const CARD = "AUTOLOOP-V1-STAGE-F-R2-IMPLEMENTATION-1";
export const NODE = "SA-P1";

export function sourceResultIdentity(run = RUN, node = NODE) {
  return `node:${run}:${node}`;
}

/** Canonical evidence inventory for the R2 fixture graph (EVID-shaped). */
export function canonicalEvidence(o = {}) {
  const verifier = hex64("b");
  const review = hex64("c");
  return {
    graphRunId: RUN,
    taskCardIds: [CARD],
    resultIdentities: [verifier, review],
    verifierIdentities: [verifier],
    reviewIdentities: [review],
    ...o,
  };
}
export const VERIFIER_ID = hex64("b");
export const REVIEW_ID = hex64("c");
export const EXECUTOR_ID = hex64("a");

/**
 * A verified constituent INCIDENT (layer 1; RAW/UNVERIFIED, journalable).
 * This is the two-layer model's layer-1 record: incident provenance.
 */
export function incidentRecord(o = {}) {
  const seq = o.seq ?? "1";
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "EXECUTION",
    identity: {
      graphRunId: o.graphRunId ?? RUN,
      taskIdentity: o.taskIdentity ?? CARD,
      nodeId: o.nodeId ?? NODE,
      attempt: seq,
      executorKind: "writer-subagent",
    },
    subject: {
      resultKind: "TASK_RESULT",
      status: o.status ?? "HOLD",
      startedAt: T,
      completedAt: T,
      evidenceManifestDigest: hex64("e"),
      summary: `incident ${seq}: retry loop livelock under backoff-missing condition`,
    },
    content: { kind: "STRUCTURED", data: { incident_class: "livelock", root_event: `root-${seq}` } },
    source: { source: "EXECUTION", identity: sourceResultIdentity() },
    scope: { repository: REPO, graphRun: o.graphRunId ?? RUN, task: o.taskIdentity ?? CARD },
    trust: "UNVERIFIED",
    validity: { status: "CURRENT", validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: { manifestDigest: hex64("e"), items: [] },
    security: { scanResult: "clean", ingestionSource: "r2-fixture" },
    metadata: {},
  };
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

/** Machine-testable applicability boundary (O6 shape). */
export function patternBoundary(o = {}) {
  return {
    appliesWhen: o.appliesWhen ?? [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
    doesNotApplyWhen: o.doesNotApplyWhen ?? [],
    mechanismSignature: o.mechanismSignature ?? { errorClass: "livelock" },
  };
}

/** The canonical PATTERN content document (D2/D4). */
export function patternContent(o = {}) {
  return {
    kind: "STRUCTURED",
    data: {
      mechanismDigest: o.mechanismDigest ?? hex64("1"),
      applicabilityDigest: o.applicabilityDigest ?? hex64("2"),
      constituentIncidentSetDigest: o.constituentIncidentSetDigest ?? hex64("3"),
      constituentIncidentRecordIds: o.constituentIncidentRecordIds ?? [hex64("4")],
      qualificationRecordId: o.qualificationRecordId ?? hex64("5"),
      publicationGeneration: o.publicationGeneration ?? 1,
      counterexamples: o.counterexamples ?? NOT_APPLICABLE,
      transferPotential: o.transferPotential ?? "high within memory subsystem",
      requiredLifecycleLevel: o.requiredLifecycleLevel ?? "ADVISORY",
      rootCause: o.rootCause ?? "missing backoff in retry loop",
      mechanism: o.mechanism ?? "retry without exponential backoff livelocks the executor",
      applicability: o.applicability ?? patternBoundary(),
    },
  };
}

/** A direct PATTERN record (validation/retrieval fixtures). */
export function patternRecord(o = {}, contentO = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "PATTERN",
    identity: { patternId: o.patternId ?? "pat-r2-1", repositoryIdentity: o.repositoryIdentity ?? REPO },
    subject: { statement: o.statement ?? "PATTERN: retry loop without backoff livelocks", contentHash: null, language: NOT_APPLICABLE },
    content: patternContent(contentO),
    source: { source: "EXECUTION", identity: o.sourceIdentity ?? sourceResultIdentity() },
    scope: o.scope ?? { repository: REPO },
    trust: o.trust ?? "UNVERIFIED",
    validity: { status: o.validityStatus ?? "CURRENT", validityTree: NOT_APPLICABLE },
    lifecycle: { events: [] },
    timestamps: { createdAt: T, updatedAt: T },
    evidence: o.evidence ?? (o.trust === "VERIFIED" || o.trust === "REVIEWED"
      ? { manifestDigest: hex64("8"), verifierResultIdentity: VERIFIER_ID, items: [] }
      : { manifestDigest: hex64("8"), items: [] }),
    security: { scanResult: "clean", ingestionSource: "r2-fixture" },
    metadata: o.metadata ?? {},
  };
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  return rec;
}

/** A PATTERN write-back candidate (CBM-4 contract, PATTERN proposed type). */
export async function patternCandidate(o = {}) {
  const { createWritebackCandidate } = await import("../../src/memory/writeback/candidate.mjs");
  return createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: CARD,
    originatingNode: NODE,
    sourceResultIdentity: sourceResultIdentity(),
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-r2-1", repositoryIdentity: REPO },
    proposedSubjectStatement: "PATTERN: retry loop without backoff livelocks",
    proposedContent: patternContent(),
    proposedScope: { repository: REPO },
    evidenceReferences: o.evidenceReferences ?? [`manifest:${hex64("f")}`, `verifier:${VERIFIER_ID}`],
    proposedTrust: o.proposedTrust ?? "VERIFIED",
    proposedRelationships: o.proposedRelationships ?? [],
    lifecycleIntent: o.lifecycleIntent ?? "CREATE",
    origin: o.origin ?? "independent_reviewer",
    ...o,
  });
}

/** Silent log sink for store construction in tests. */
export function silentLog() {
  return { info() {}, warn() {}, error() {} };
}

/** Open an isolated LocalMemoryStore under a tracked OS-temp root. */
export async function openTempStore(label = "r2") {
  const { LocalMemoryStore } = await import("../../src/memory/index.mjs");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `r2-${label}-`));
  const store = new LocalMemoryStore({ stateRoot: root, log: silentLog() });
  store.open();
  return { store, root, fs, path };
}
