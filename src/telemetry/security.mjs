// src/telemetry/security.mjs
//
// COST-1 — telemetry security / privacy boundary（allowlist）.
//
// Telemetry stores ONLY identities + counters + timings + bounded structured
// metadata. Everything else is DENIED at two layers:
//   1. schema allowlist（validateTelemetryEventV1 rejects unknown fields,
//      including any prompt/response/stdout/body/content field）
//   2. content scan（scanTelemetryEvent re-scans the serialized event for
//      secret-shaped patterns before anything reaches disk — same fail-closed
//      principle as the review-bundle secret gate）
//
// Denied by design（card stage 3）: secrets, credentials, private keys, env
// secret values, full prompts, full model responses, memory record bodies,
// source-code blobs, arbitrary stdout/stderr, database contents, user data.
// Telemetry is NEVER a second evidence dump.

const SECRET_PATTERNS = [
  // private keys / certificates
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /-----BEGIN CERTIFICATE-----/,
  // common credential shapes
  /\bAKIA[0-9A-Z]{16}\b/,                    // AWS access key id
  /(?:ghp|gho|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub tokens
  /sk-[A-Za-z0-9]{20,}/,                      // openai-style keys
  /xox[baprs]-[A-Za-z0-9-]{10,}/,             // slack tokens
  /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*[^\s,;}"']+/i,
  /\b(?:BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|AKIA|sk-live-)/,
  // connection strings with credentials
  /(?:mongodb|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@\/]+:[^\s@]+@/,
];

export const TELEMETRY_DENYLIST = Object.freeze([
  "secrets", "credentials", "private keys", "environment secret values",
  "full prompts by default", "full model responses by default",
  "memory record bodies", "source-code blobs", "arbitrary stdout/stderr",
  "database contents", "user private data",
]);

export const TELEMETRY_ALLOWLIST = Object.freeze([
  "identities", "counters", "timings", "bounded structured metadata",
  "digests (retrievalDigest / storeSnapshotDigest / eventId)",
  "budget limits (no actual token values)",
]);

/**
 * Scan a serialized telemetry event for secret-shaped content.
 * Fail-closed: any match rejects the event before it can reach the store.
 */
export function scanTelemetryEvent(serialized) {
  const matches = [];
  for (const re of SECRET_PATTERNS) {
    const m = String(serialized).match(re);
    if (m) {
      matches.push(re.source.slice(0, 60));
      if (matches.length >= 5) break;
    }
  }
  return { safe: matches.length === 0, matches };
}

/**
 * Defensive sanitizer: returns a copy of the event guaranteed to carry no
 * denylisted top-level content fields（schema validation already rejects
 * unknown fields; this is a second net for anything that slips through）.
 */
export function sanitizeTelemetryEvent(event) {
  if (!event || typeof event !== "object") return null;
  const copy = { ...event };
  for (const k of Object.keys(copy)) {
    if (["prompt", "response", "stdout", "stderr", "body", "content", "secret", "password", "tokenValue"].includes(String(k).toLowerCase())) {
      copy[k] = null;
    }
  }
  return copy;
}

/** Classify a verification run（canonical/full vs targeted）from its suite name. */
export function classifyVerification(suiteName) {
  const s = String(suiteName ?? "").toLowerCase();
  if (s.includes("colima-all") || s === "test:governance") return "canonical";
  if (s.includes("memory") || s.includes("telemetry") || s.includes("v2") || s.includes("c2") || s.includes("c3")) return "full";
  return "focused";
}
