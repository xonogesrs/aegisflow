// src/telemetry/location.mjs
//
// S16 — telemetry authority/location/retention contract: code-frozen subset.
//
// Card: AUTOLOOP_S16_TELEMETRY_AUTHORITY_RESEARCH_AND_CONTRACT_LARGE_1.
// Contract record:
// docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md
//
// This module freezes ONLY the location + retention-classification surface:
//   - the canonical telemetry namespace (a SIBLING of the authoritative
//     evidence root, never inside it — namespace separation is the
//     authority fence: everything under the telemetry namespace is
//     observability (R1/R2); the authoritative evidence root is R3/R4)
//   - the retention classes and the per-surface assignment (data mirror of
//     the contract's Phase B/F tables)
//   - the fail-closed state-root resolver for future telemetry
//     instrumentation (R-06 stays open; instrumentation MUST adopt this).
//
// Invariants (mirror of the frozen contract):
//   - telemetry is NEVER a task authority: resolution failure is an ordinary
//     error the caller surfaces as TELEMETRY_UNAVAILABLE — it cannot change
//     any task semantic.
//   - run-scoped state roots only: the resolver rejects $HOME itself, repo
//     worktrees, and non-absolute paths; identity binding (graphRunId) is
//     mandatory so stores never collide across runs or generations.
//   - no data is moved or deleted by this module. Retention/GC execution
//     stays behind S16 (AUTOLOOP_GC_RETENTION_LARGE_IMPLEMENTATION_AND_CLOSEOUT_1).

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  TELEMETRY_ROOT_ENV as AUTOLOOP_TELEMETRY_ROOT_ENV,
  assertStateRootAllowed,
  resolveEvidenceRoot,
  resolveTelemetryRoot,
} from "../shared/autoloop-paths.mjs";

// Canonical telemetry namespace: a SIBLING of the authoritative evidence root,
// never inside it. Separation is the authority fence, not aesthetics: the two
// namespaces have disjoint retention classes.
//
// Portable default: <AUTOLOOP_HOME>/evidence/autoloop-telemetry (see
// src/shared/autoloop-paths.mjs). Set AUTOLOOP_TELEMETRY_ROOT explicitly to
// place it anywhere else; a value inside the evidence namespace fails closed.
export const TELEMETRY_ROOT = resolveTelemetryRoot();

/** Name of the env var that relocates the telemetry namespace. */
export const TELEMETRY_ROOT_ENV = AUTOLOOP_TELEMETRY_ROOT_ENV;

/** The authoritative evidence namespace this root must stay separate from. */
export function telemetryEvidenceRoot({ env = process.env } = {}) {
  return resolveEvidenceRoot({ env });
}

// Env override for the exact store root (tests / CI isolation), mirroring
// AUTOLOOP_MEMORY_STATE_ROOT. Never a fallback creator: when the env var is
// unset the canonical namespace is used as the PARENT of the run-scoped child.
export const TELEMETRY_STATE_ROOT_ENV = "AUTOLOOP_TELEMETRY_STATE_ROOT";

// Retention classes (contract Phase F).
export const RETENTION_CLASSES = Object.freeze(["R0", "R1", "R2", "R3", "R4"]);

// Per-surface retention assignment — the code mirror of contract Phase B
// (exactly one class per persistent surface; GC_PROTECTED classes R3/R4 must
// never live under the telemetry namespace).
export const TELEMETRY_RETENTION_ASSIGNMENT = Object.freeze({
  telemetryEventStore: "R1", // active stream; rotated chunks are R2
  telemetryRotatedChunks: "R2",
  writebackTelemetryEvents: "R1",
  searchGovernorTelemetryAnnotation: "R3", // rides the authority record
  rolloverTelemetryToken: "R3", // rides the authority record
  durableEvidenceStore: "R3",
  checkpointStore: "R3",
  budgetLedger: "R3",
  closeoutState: "R3",
  graphCloseoutEvidence: "R3",
  externalReviewInbox: "R3",
  externalReviewArchive: "R4",
  executionReviewSurface: "R3",
  executionReviewArchive: "R4",
  probeEvidenceHistory: "R3",
  memoryStore: "R3",
  lifecycleEventJournal: "R3",
  transferMetricsLog: "R2",
  ownedScratch: "R0", // results/ subtree is CONTINUATION_REQUIRED until real terminal
  ownedScratchResults: "R3", // WP1 continuation truth — GC_PROTECTED until release
  probeScratchLeftovers: "R0", // orphaned; GC_AMBIGUOUS until adjudicated
  legacyHomeTelemetryDirs: "R2", // orphaned; GC_AMBIGUOUS until adjudicated
  colimaRuntimeHome: null, // environmental — outside AutoLoop retention authority
  rrcForensics: "R4",
  providerUsageObservationRows: "R3", // rides the authority journal (replay-safe)
  harnessSystemDeltaReviewArtifacts: "R3",
  scratchOwnershipArtifact: "R3",
  telemetryMeasurementEvidence: "R3",
});

/** Retention class for one surface; unknown surfaces fail closed. */
export function retentionClassFor(surface) {
  if (!Object.prototype.hasOwnProperty.call(TELEMETRY_RETENTION_ASSIGNMENT, surface)) {
    throw new Error(`S16 retention: unknown telemetry surface: ${String(surface)}`);
  }
  return TELEMETRY_RETENTION_ASSIGNMENT[surface];
}

/** True when the class is GC_PROTECTED (never GC'd by telemetry retention). */
export function isGcProtected(retentionClass) {
  return retentionClass === "R3" || retentionClass === "R4";
}

/**
 * Reject $HOME ITSELF as a run-scoped root.
 *
 * The namespace boundary is the telemetry root, not the home directory: the
 * portable default lives at ~/.autoloop/evidence/autoloop-telemetry, so a
 * blanket "$HOME subtree is forbidden" rule would reject the default. This
 * keeps the original refusal of the worst case (state landing directly in
 * $HOME) while `resolveTelemetryRoot` enforces the namespace boundary itself.
 */
function rejectHomeNamespace(resolved) {
  const home = resolve(homedir());
  if (resolved === home) {
    throw new Error(`S16 telemetry location: $HOME itself is not a telemetry root: ${resolved}`);
  }
}

/**
 * Resolve the run-scoped telemetry state root for one graphRunId.
 *
 * Precedence: exact env override (tests/CI) -> canonical namespace child.
 * Fail-closed: requires a non-empty absolute graphRunId; rejects $HOME,
 * repo-relative and traversal paths. NEVER creates directories and NEVER
 * falls back — a resolution failure is an ordinary error the caller surfaces
 * as TELEMETRY_UNAVAILABLE (telemetry is never a task authority).
 */
export function resolveTelemetryStateRoot({ graphRunId, env = process.env } = {}) {
  if (typeof graphRunId !== "string" || graphRunId.trim().length === 0) {
    throw new Error("S16 telemetry location: graphRunId required (identity binding is mandatory)");
  }
  if (graphRunId.includes("/") || graphRunId.includes("\\") || graphRunId.includes("..")) {
    throw new Error(`S16 telemetry location: graphRunId must be a flat identity: ${graphRunId}`);
  }
  const override = env?.[TELEMETRY_STATE_ROOT_ENV];
  if (typeof override === "string" && override.trim().length > 0) {
    if (!isAbsolute(override)) {
      throw new Error(`S16 telemetry location: ${TELEMETRY_STATE_ROOT_ENV} must be absolute: ${override}`);
    }
    let resolved;
    try {
      resolved = assertStateRootAllowed(override, { env });
    } catch (e) {
      throw new Error(`S16 telemetry location: ${TELEMETRY_STATE_ROOT_ENV} rejected (${e.code}): ${override}`);
    }
    rejectHomeNamespace(resolved);
    return resolved;
  }
  // The namespace root is re-resolved from THIS env (not the import-time
  // constant) so an explicit AUTOLOOP_TELEMETRY_ROOT is honored per call.
  const namespace = resolveTelemetryRoot({ env });
  const resolved = join(namespace, graphRunId);
  rejectHomeNamespace(resolved);
  return resolved;
}
