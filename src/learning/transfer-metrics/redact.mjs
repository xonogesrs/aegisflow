// src/learning/transfer-metrics/redact.mjs
//
// Mandatory redaction order over C3 evidence scanners ∪ COST-1 telemetry scanners.
//
// P7 SUBTRACTION (M37 → OPTIONAL_ORCHESTRATION) — COMPATIBILITY SHIM: the
// telemetry SECURITY module is resolved through a load-time try/catch
// dynamic import. When the optional telemetry layer is ABSENT the telemetry
// scan layer degrades to "absent" (no telemetry-shaped patterns are added to
// the match list) while the MANDATORY evidence scanner layer
// (scanForSecrets / hasUnsafeControlChars / redactObject — EVIDENCE
// GOVERNANCE, KEEP_CORE) runs UNCHANGED and still fails closed with
// SECRET_RISK / PAYLOAD_UNSAFE. Telemetry scanning is a second, additive
// privacy layer over observability events; its absence never weakens the
// evidence secret gate and never changes any authority decision.

import {
  SECRET_PATTERNS as EVIDENCE_SECRET_PATTERNS,
  scanForSecrets,
  hasUnsafeControlChars,
  redactObject,
  DEFAULT_MAX_FREE_TEXT_BYTES,
  EvidenceHoldError,
} from "../../evidence/run-evidence-store.mjs";
let TELEMETRY_SECURITY = null;
try {
  TELEMETRY_SECURITY = await import("../../telemetry/security.mjs");
} catch {
  TELEMETRY_SECURITY = null; // optional telemetry layer absent — evidence scan layer unaffected
}
import {
  MAX_EVENT_BYTES,
  MAX_STRING_BYTES_PER_FIELD,
  TRANSFER_CODES,
  TransferMetricsError,
  canonical,
} from "./schema.mjs";

export function scanTransferPayload(serialized) {
  const evidence = scanForSecrets(serialized);
  // M37 shim: telemetry scan layer only when the optional layer is present.
  const telemetry = TELEMETRY_SECURITY?.scanTelemetryEvent
    ? TELEMETRY_SECURITY.scanTelemetryEvent(serialized)
    : { safe: true, matches: [] };
  const names = [];
  if (!evidence.safe) names.push(...evidence.matches);
  if (!telemetry.safe) {
    for (const src of telemetry.matches) names.push(`telemetry:${src}`);
  }
  return { safe: names.length === 0, matches: names };
}

function walkStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) walkStrings(child, visit);
  }
}

export function redactTransferEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new TransferMetricsError(TRANSFER_CODES.PAYLOAD_MALFORMED, "event must be an object");
  }
  walkStrings(event, (text) => {
    if (hasUnsafeControlChars(text)) {
      throw new TransferMetricsError(TRANSFER_CODES.PAYLOAD_UNSAFE, "unsafe control characters");
    }
  });
  let redacted;
  try {
    redacted = redactObject(event, { maxBytes: MAX_STRING_BYTES_PER_FIELD });
  } catch (e) {
    if (e instanceof EvidenceHoldError) {
      throw new TransferMetricsError(TRANSFER_CODES.SECRET_RISK, e.message);
    }
    throw e;
  }
  const serialized = canonical(redacted.value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    throw new TransferMetricsError(
      TRANSFER_CODES.PAYLOAD_MALFORMED,
      `canonical event ${bytes} bytes exceeds ${MAX_EVENT_BYTES}`,
    );
  }
  const scan = scanTransferPayload(serialized);
  if (!scan.safe) {
    throw new TransferMetricsError(
      TRANSFER_CODES.SECRET_RISK,
      `secret pattern(s): ${scan.matches.join(",")}`,
    );
  }
  return {
    event: redacted.value,
    truncated: Boolean(redacted.metadata?.truncated),
    byte_length: bytes,
    serialized,
  };
}

export { EVIDENCE_SECRET_PATTERNS, DEFAULT_MAX_FREE_TEXT_BYTES };
