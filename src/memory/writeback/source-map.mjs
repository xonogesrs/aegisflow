// src/memory/writeback/source-map.mjs
//
// CBM-4 — Stage 1: write-back source / authority map
//（autoloop.memory-writeback-source-map/v1）.
//
// Machine-readable audit of every Graph data source that could form memory:
//   source            where the data comes from（graph result field）
//   authority         who produced it（executor / writer / verifier /
//                     independent reviewer / controller / graph）
//   trustCeiling      the highest trust this source may reach（no source can
//                     exceed its authority — CONFIRMED is Controller-only）
//   requiredEvidence  what must bind before write-back is permitted
//   allowedRecordType EXECUTION | CODE | DECISION
//   allowedScope      graphRun-bound by default; CODE facts additionally
//                     repo/tree/path-bound
//   deterministic     whether the derived identity is repeat-stable
//   failureSemantics  what happens when the evidence is missing/invalid
//   writebackPermitted whether automatic write-back is allowed for this class
//
// Trust ceiling rule（card stage 4）: writer/executor propose（max RAW /
// UNVERIFIED candidate）; verifier-backed facts reach VERIFIED; independent
// reviewer PASS + zero blocking findings + verifiable identity reach REVIEWED;
// CONFIRMED is reserved for Controller / the highest defined authority —
// CBM-4 never auto-generates CONFIRMED.

export const WRITEBACK_SOURCE_MAP_SCHEMA = "autoloop.memory-writeback-source-map/v1";

export const WRITEBACK_SOURCE_MAP = [
  // ── EXECUTION memory ─────────────────────────────────────────────────────
  { source: "executor result（status / error / timeout / aborted）", authority: "executor", trustCeiling: "VERIFIED", requiredEvidence: "executor result identity + task/graph identity", allowedRecordType: "EXECUTION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "missing identity -> candidate rejected（no partial write）", writebackPermitted: true },
  { source: "writer result（filesChanged / testsExecuted / testResults）", authority: "writer", trustCeiling: "UNVERIFIED", requiredEvidence: "writer result identity + mutation scope + dependency result identities", allowedRecordType: "EXECUTION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "writer claims alone never reach VERIFIED/REVIEWED", writebackPermitted: true },
  { source: "final task verdict（PASS / REPAIR / HOLD）", authority: "graph/closeout", trustCeiling: "REVIEWED", requiredEvidence: "closeout gate result + review identity", allowedRecordType: "EXECUTION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "bundle gate not PASS -> no trusted write-back", writebackPermitted: true },
  { source: "repair history（attempts / repair count / reason）", authority: "graph lifecycle", trustCeiling: "VERIFIED", requiredEvidence: "lifecycle transitions", allowedRecordType: "EXECUTION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "repair history is provenance, never current CODE truth", writebackPermitted: true },
  { source: "verifier result（scope / diff / tests verification）", authority: "verifier", trustCeiling: "VERIFIED", requiredEvidence: "verifier identity + verified outcome", allowedRecordType: "EXECUTION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "unverified -> candidate only", writebackPermitted: true },

  // ── CODE memory（verifier/reviewer evidence required）────────────────────
  { source: "verified affected symbol / path（worktree diff）", authority: "verifier", trustCeiling: "VERIFIED", requiredEvidence: "verifier evidence identity + scope/diff verification", allowedRecordType: "CODE", allowedScope: "repo/tree/path-bound", deterministic: true, failureSemantics: "no verifier evidence -> rejected（writer self-claim insufficient）", writebackPermitted: true },
  { source: "independent reviewer fact（blockingFindings=[] + review PASS）", authority: "independent reviewer", trustCeiling: "REVIEWED", requiredEvidence: "review result identity + PASS + zero blocking findings", allowedRecordType: "CODE", allowedScope: "repo/tree/path-bound", deterministic: true, failureSemantics: "missing/fake review identity -> rejected", writebackPermitted: true },
  { source: "confirmed fix location / regression boundary / disproven hypothesis", authority: "independent reviewer", trustCeiling: "REVIEWED", requiredEvidence: "review evidence references + scope/tests verified", allowedRecordType: "CODE", allowedScope: "repo/tree/path-bound", deterministic: true, failureSemantics: "evidence references absent -> rejected", writebackPermitted: true },
  { source: "writer self-claim（any code fact without evidence）", authority: "writer", trustCeiling: "UNVERIFIED", requiredEvidence: "none — NOT eligible for promotion", allowedRecordType: "CODE", allowedScope: "graphRun-bound only", deterministic: true, failureSemantics: "writer self-claims are candidates at most; never trusted CODE memory", writebackPermitted: false },

  // ── DECISION memory（Controller-only; most conservative）────────────────
  { source: "controller-confirmed choice / governance-approved decision", authority: "controller", trustCeiling: "CONFIRMED", requiredEvidence: "controller ruling identity + explicit authority marker", allowedRecordType: "DECISION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "no controller authority -> candidate retained, never promoted", writebackPermitted: false },
  { source: "agent-proposed decision（no controller authority）", authority: "agent", trustCeiling: "UNVERIFIED", requiredEvidence: "none — retained as candidate only", allowedRecordType: "DECISION", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "cannot become trusted DECISION memory without authority", writebackPermitted: false },

  // ── PATTERN memory（R2; qualified learning candidates ONLY）────────────
  { source: "qualified pattern candidate（consolidated incidents + independent qualification + testable applicability boundary）", authority: "independent reviewer", trustCeiling: "VERIFIED", requiredEvidence: "consolidation lineage（constituent incident recordIds verbatim）+ qualification record id（independent identity）+ canonical-inventory-attested evidence identities + machine-testable applicability boundary", allowedRecordType: "PATTERN", allowedScope: "repository-bound", deterministic: true, failureSemantics: "missing lineage/qualification/boundary -> SCHEMA_INVALID（boundary_vacuous / missing_required）; unattested identity -> fence-3 rejection; R2 never promotes（trust ceiling VERIFIED; no §5 lifecycle edge in R2）", writebackPermitted: true },
  { source: "unqualified pattern candidate（self-claimed mechanism, no independent qualification）", authority: "executor", trustCeiling: "UNVERIFIED", requiredEvidence: "none — retained as candidate only", allowedRecordType: "PATTERN", allowedScope: "graphRun-bound", deterministic: true, failureSemantics: "unqualified patterns are candidates at most; never trusted PATTERN memory; V5 self-approval rejected", writebackPermitted: false },
];

export function writebackSourceMap() {
  return WRITEBACK_SOURCE_MAP.map((e) => ({ ...e }));
}

export function writebackSourceMapSummary() {
  const permitted = WRITEBACK_SOURCE_MAP.filter((e) => e.writebackPermitted).length;
  const ceilings = {};
  for (const e of WRITEBACK_SOURCE_MAP) ceilings[e.trustCeiling] = (ceilings[e.trustCeiling] ?? 0) + 1;
  return { total: WRITEBACK_SOURCE_MAP.length, permitted, ceilings };
}
