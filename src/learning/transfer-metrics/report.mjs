// src/learning/transfer-metrics/report.mjs
//
// Read-only renderer. Cannot PASS a task, promote a pattern, or write the raw log.

import { CANONICAL_METRICS, COMPANION_METRICS } from "./formulas.mjs";
import { canonical } from "./schema.mjs";

export function renderTransferMetricsReport(doc) {
  const lines = [];
  lines.push(`formula_version=${doc.formula_version}`);
  lines.push(`window=[${doc.window.start}, ${doc.window.end})`);
  lines.push(`input_digest=${doc.input_digest}`);
  lines.push(`event_count=${doc.event_ids.length}`);
  lines.push("metrics:");
  for (const id of [...CANONICAL_METRICS, ...COMPANION_METRICS]) {
    const m = doc.metrics[id];
    if (!m) continue;
    const value = m.status === "MEASURED" ? String(m.value) : "null";
    lines.push(`  ${id} status=${m.status} numerator=${m.numerator} denominator=${m.denominator} value=${value}`);
  }
  return lines.join("\n") + "\n";
}

export function renderCanonical(doc) {
  return canonical(doc);
}
