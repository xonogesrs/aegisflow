// src/learning/transfer-metrics/formulas.mjs
//
// transfer-metrics-formulas/v1 — 15 canonical metrics + M1C/M2C/M12C.
// Reducer-only. Never mutates the raw log.

import { FORMULA_VERSION } from "./schema.mjs";

export { FORMULA_VERSION };

export const METRIC_IDS = Object.freeze([
  "M1", "M1C", "M2", "M2C", "M3", "M3v", "M4", "M4v",
  "M5", "M6", "M7", "M8", "M9", "M10",
  "M11", "M12", "M12C", "M13", "M14", "M15",
]);

export const CANONICAL_METRICS = Object.freeze([
  "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10",
  "M11", "M12", "M13", "M14", "M15",
]);

export const COMPANION_METRICS = Object.freeze(["M1C", "M2C", "M12C"]);
export const HEADLINE_SUCCESS = Object.freeze(["M1", "M3v", "M4v", "M5", "M6", "M11", "M12"]);

export function metricResult({
  status,
  numerator = 0,
  denominator = 0,
  value = null,
  excluded_event_ids = [],
  event_ids = [],
  reason = null,
} = {}) {
  return {
    status,
    numerator,
    denominator,
    value: status === "MEASURED" ? value : null,
    excluded_event_ids: [...excluded_event_ids].sort(),
    event_ids: [...event_ids].sort(),
    ...(reason ? { reason } : {}),
  };
}

export function notMeasurable(reason, extra = {}) {
  return metricResult({ status: "NOT_MEASURABLE", value: null, reason, ...extra });
}

export function unknown(reason, extra = {}) {
  return metricResult({ status: "UNKNOWN", value: null, reason, ...extra });
}

export function measured(numerator, denominator, extra = {}) {
  if (denominator === 0) return notMeasurable("denominator_zero", extra);
  return metricResult({
    status: "MEASURED",
    numerator,
    denominator,
    value: numerator / denominator,
    ...extra,
  });
}

export function measuredValue(value, extra = {}) {
  return metricResult({
    status: "MEASURED",
    numerator: extra.numerator ?? null,
    denominator: extra.denominator ?? 1,
    value,
    ...extra,
  });
}

export function unitKey(parts) {
  return parts.map((p) => String(p ?? "")).join("\u001f");
}

export function overlayApplicability(retrieved, adjudicationsBySubject) {
  const overlays = adjudicationList(adjudicationsBySubject, retrieved.event_id)
    .map((row) => row?.payload?.overlay_applicability)
    .filter((value) => value === "APPLICABLE" || value === "NOT_APPLICABLE");
  const unique = [...new Set(overlays)];
  if (unique.length === 0) return retrieved.applicability_decision;
  if (unique.length > 1) return "UNKNOWN";
  return unique[0];
}

export function isVerifiedGrade(grade) {
  return grade === "C" || grade === "D";
}

export function adjudicationList(adjudicationsBySubject, subjectId) {
  const value = adjudicationsBySubject.get(subjectId);
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function allAdjudications(adjudicationsBySubject) {
  const out = [];
  for (const value of adjudicationsBySubject.values()) {
    if (Array.isArray(value)) out.push(...value);
    else out.push(value);
  }
  return out;
}

export function adjudicationFor(subjectId, adjudicationsBySubject) {
  const rows = adjudicationList(adjudicationsBySubject, subjectId);
  return rows.find((row) => isVerifiedGrade(row?.payload?.attribution_grade)) ?? rows[0] ?? null;
}

export function hasVerifiedAdjudication(subjectId, adjudicationsBySubject) {
  return adjudicationList(adjudicationsBySubject, subjectId)
    .some((row) => isVerifiedGrade(row?.payload?.attribution_grade));
}

export function hasVerifiedForExecution(executionId, adjudicationsBySubject) {
  return allAdjudications(adjudicationsBySubject).some((row) =>
    row.attempt_identity?.execution_id === executionId
    && isVerifiedGrade(row?.payload?.attribution_grade));
}

export function m11AlwaysNotMeasurable() {
  return notMeasurable("ISSUE_5_15_UNPINNED_AND_PATTERN_TYPE_ABSENT");
}

export function m14AlwaysNotMeasurable() {
  return notMeasurable("PATTERN_GENERATION_OWNER_ABSENT");
}
