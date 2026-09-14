// src/learning/transfer-metrics/reducer.mjs
//
// Pure recomputation of derived metrics. AUTHORITY=NONE.
// Must not write, truncate, or patch the raw log.

import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  AUTHORITY_EVENT_TYPE,
  FORMULA_VERSION,
  SCHEMA_VERSION,
  SCHEMA_VERSION_V2,
  TRANSFER_CODES,
  TransferMetricsError,
  canonical,
  digestOf,
  parseIsoMs,
  validateAuthorityRecord,
  MAX_DERIVED_BYTES,
  MAX_REDUCER_EVENTS,
} from "./schema.mjs";
import {
  CANONICAL_METRICS,
  COMPANION_METRICS,
  metricResult,
  notMeasurable,
  unknown,
  measured,
  measuredValue,
  overlayApplicability,
  isVerifiedGrade,
  m11AlwaysNotMeasurable,
  m14AlwaysNotMeasurable,
  adjudicationFor,
  allAdjudications,
  hasVerifiedAdjudication,
  hasVerifiedForExecution,
} from "./formulas.mjs";

function fail(code, message, details) {
  throw new TransferMetricsError(code, message, details);
}

function inWindow(event, window) {
  const t = parseIsoMs(event.occurred_at);
  const start = parseIsoMs(window.start);
  const end = parseIsoMs(window.end);
  return t >= start && t < end;
}

function producerAllowed(event, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(Array.isArray(allowed) ? allowed : [allowed]);
  return set.has(event.producer_kind);
}

function indexByType(events) {
  const map = new Map();
  for (const e of events) {
    if (!map.has(e.event_type)) map.set(e.event_type, []);
    map.get(e.event_type).push(e);
  }
  return map;
}

function adjudicationsBySubject(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "TRANSFER_ADJUDICATED" && e.subject_event_id) {
      if (!map.has(e.subject_event_id)) map.set(e.subject_event_id, []);
      map.get(e.subject_event_id).push(e);
    }
  }
  return map;
}

function markIneligible(event, revokedWriterIds) {
  if (revokedWriterIds.has(event.writer?.writer_id)) return "writer_revoked";
  if (event.missing_predecessor === true) return "missing_predecessor";
  if (event.evidence_complete !== true) return "evidence_incomplete";
  return null;
}

function unique(arr) {
  return [...new Set(arr)];
}

function usedFor(retrievedId, usedEvents, kind) {
  return usedEvents.filter((u) => u.retrieval_event_id === retrievedId && (kind ? u.event_type === kind : true));
}

function hasExplicitCitation(retrievedId, usedEvents) {
  return usedEvents.some((u) => u.retrieval_event_id === retrievedId && u.payload?.citation_kind === "explicit_reference");
}

function outcomeByExecution(events) {
  const map = new Map();
  for (const e of events) {
    if (e.event_type === "OUTCOME_OBSERVED") {
      map.set(e.attempt_identity.execution_id, e);
    }
  }
  return map;
}

function reduceM1(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const used = [
    ...(ctx.byType.get("PATTERN_USED_IN_PLANNING") ?? []),
    ...(ctx.byType.get("PATTERN_USED_IN_VERIFICATION") ?? []),
  ];
  const seen = new Map();
  const excluded = [];
  let unknownUnit = false;
  const denomUnits = [];
  const numerUnits = [];
  const eventIds = [];
  for (const ev of retrieved) {
    const inelig = markIneligible(ev, ctx.revokedWriterIds);
    if (inelig) {
      excluded.push(ev.event_id);
      unknownUnit = true;
      continue;
    }
    const key = `${ev.payload.retrievalDigest}|${ev.pattern_identity.pattern_id}|${ev.pattern_identity.generation}`;
    if (seen.has(key)) continue;
    seen.set(key, ev);
    eventIds.push(ev.event_id);
    const appl = overlayApplicability(ev, ctx.adjudications);
    if (appl === "UNKNOWN") {
      unknownUnit = true;
      continue;
    }
    denomUnits.push(ev);
    const adj = adjudicationFor(ev.event_id, ctx.adjudications);
    const truePositive = adj?.payload?.benefit_claimed === true || adj?.payload?.overlay_applicability === "APPLICABLE"
      || hasVerifiedAdjudication(ev.event_id, ctx.adjudications);
    const cited = hasExplicitCitation(ev.event_id, used);
    if (appl === "APPLICABLE" && (cited || truePositive)) numerUnits.push(ev);
  }
  if (retrieved.length === 0 && excluded.length === 0) return notMeasurable("denominator_zero");
  if (unknownUnit) {
    return unknown("unknown_applicability_or_incomplete", {
      numerator: numerUnits.length,
      denominator: denomUnits.length,
      excluded_event_ids: excluded,
      event_ids: eventIds,
    });
  }
  return measured(numerUnits.length, denomUnits.length, {
    excluded_event_ids: excluded,
    event_ids: eventIds,
  });
}

function reduceM1C(ctx) {
  if (!ctx.applicableUniverse) {
    return notMeasurable("applicable_universe_absent");
  }
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  let numer = 0;
  let denom = 0;
  const eventIds = [];
  const episodes = ctx.applicableUniverse.episodes ?? [];
  if (episodes.length === 0) return notMeasurable("applicable_universe_empty");
  for (const episode of episodes) {
    const applicable = episode.pattern_ids ?? [];
    denom += applicable.length;
    for (const pid of applicable) {
      const hit = retrieved.find((e) =>
        e.pattern_identity?.pattern_id === pid
        && e.payload?.retrievalDigest === episode.retrievalDigest,
      );
      if (hit) {
        numer += 1;
        eventIds.push(hit.event_id);
      }
    }
  }
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceM2(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const rejected = ctx.byType.get("PATTERN_REJECTED") ?? [];
  const stale = ctx.byType.get("STALE_PATTERN_REJECTED") ?? [];
  const numerEvents = [...rejected, ...stale];
  const denomEvents = [...retrieved, ...rejected, ...stale];
  return measured(numerEvents.length, denomEvents.length, {
    event_ids: denomEvents.map((e) => e.event_id),
  });
}

function reduceM2C(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const used = [
    ...(ctx.byType.get("PATTERN_USED_IN_PLANNING") ?? []),
    ...(ctx.byType.get("PATTERN_USED_IN_VERIFICATION") ?? []),
  ];
  const outcomes = ctx.outcomes;
  const incidents = ctx.byType.get("INCIDENT_OBSERVED") ?? [];
  const episodes = new Map();
  for (const inc of incidents) {
    const exec = inc.attempt_identity.execution_id;
    if (!episodes.has(exec)) episodes.set(exec, { incident: inc, retrieved: [], used: [] });
  }
  for (const r of retrieved) {
    const exec = r.attempt_identity.execution_id;
    if (!episodes.has(exec)) episodes.set(exec, { incident: null, retrieved: [], used: [] });
    episodes.get(exec).retrieved.push(r);
  }
  for (const u of used) {
    const exec = u.attempt_identity.execution_id;
    if (!episodes.has(exec)) episodes.set(exec, { incident: null, retrieved: [], used: [] });
    episodes.get(exec).used.push(u);
  }
  let numer = 0;
  let denom = 0;
  let unknownCount = 0;
  const eventIds = [];
  for (const [exec, ep] of episodes) {
    const applicableHit = [...ep.retrieved, ...ep.used].some((e) => overlayApplicability(e, ctx.adjudications) === "APPLICABLE")
      || (ctx.applicableUniverse?.episodes ?? []).some((u) => u.execution_id === exec);
    if (!applicableHit && !ctx.applicableUniverse) continue;
    if (!applicableHit) continue;
    const outcome = outcomes.get(exec);
    if (!outcome) {
      unknownCount += 1;
      continue;
    }
    denom += 1;
    eventIds.push(outcome.event_id);
    const usedApplicable = ep.used.some((u) => overlayApplicability(u, ctx.adjudications) === "APPLICABLE" || u.payload?.citation_kind === "explicit_reference");
    const retrievedApplicable = ep.retrieved.some((r) => overlayApplicability(r, ctx.adjudications) === "APPLICABLE");
    if (!usedApplicable && !retrievedApplicable && outcome.payload.final === "HOLD") numer += 1;
  }
  if (denom === 0 && unknownCount === 0) return notMeasurable("denominator_zero");
  if (denom === 0) return unknown("missing_outcome", { event_ids: eventIds });
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceImpact(ctx, usedType, verified) {
  const retrievedEps = new Map();
  for (const r of ctx.byType.get("PATTERN_RETRIEVED") ?? []) {
    const digest = r.payload.retrievalDigest;
    if (!retrievedEps.has(digest)) retrievedEps.set(digest, []);
    retrievedEps.get(digest).push(r);
  }
  const used = ctx.byType.get(usedType) ?? [];
  const denom = retrievedEps.size;
  if (denom === 0) return notMeasurable("denominator_zero");
  let missingUsed = false;
  let numer = 0;
  const eventIds = [];
  const excluded = [];
  for (const [digest, recs] of retrievedEps) {
    eventIds.push(...recs.map((r) => r.event_id));
    const uses = used.filter((u) => recs.some((r) => r.event_id === u.retrieval_event_id));
    if (uses.length === 0) {
      missingUsed = true;
      continue;
    }
    if (verified) {
      const ok = uses.some((u) => hasVerifiedAdjudication(u.event_id, ctx.adjudications)
        || hasVerifiedAdjudication(u.retrieval_event_id, ctx.adjudications));
      if (ok) numer += 1;
    } else if (uses.some((u) => u.payload.citation_kind === "explicit_reference")) {
      numer += 1;
    }
  }
  if (missingUsed) {
    return unknown("missing_used_event", { numerator: numer, denominator: denom, event_ids: eventIds, excluded_event_ids: excluded });
  }
  return measured(numer, denom, { event_ids: eventIds, excluded_event_ids: excluded });
}

function reduceM5(ctx) {
  const incidents = ctx.byType.get("INCIDENT_OBSERVED") ?? [];
  const byIncident = new Map();
  for (const inc of incidents) {
    const id = inc.incident_identity?.incident_id;
    if (!id) continue;
    if (!byIncident.has(id)) byIncident.set(id, []);
    byIncident.get(id).push(inc);
  }
  let numer = 0;
  let denom = 0;
  let unknownPair = false;
  const eventIds = [];
  for (const [, rows] of byIncident) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => parseIsoMs(a.occurred_at) - parseIsoMs(b.occurred_at));
    const earlier = rows[0];
    const later = rows[rows.length - 1];
    const o1 = ctx.outcomes.get(earlier.attempt_identity.execution_id);
    const o2 = ctx.outcomes.get(later.attempt_identity.execution_id);
    if (!o1 || !o2) {
      unknownPair = true;
      continue;
    }
    denom += 1;
    eventIds.push(earlier.event_id, later.event_id);
    const adj = adjudicationFor(later.event_id, ctx.adjudications)
      || allAdjudications(ctx.adjudications).find((a) => a.attempt_identity.execution_id === later.attempt_identity.execution_id);
    if (adj && isVerifiedGrade(adj.payload.attribution_grade) && adj.payload.detected_earlier === true && adj.payload.counterfactual_digest) {
      numer += 1;
    }
  }
  if (denom === 0 && !unknownPair) return notMeasurable("denominator_zero");
  if (unknownPair) return unknown("missing_paired_outcome", { numerator: numer, denominator: denom, event_ids: eventIds });
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceM6(ctx) {
  const incidents = ctx.byType.get("INCIDENT_OBSERVED") ?? [];
  const byKey = new Map();
  for (const inc of incidents) {
    const id = inc.incident_identity?.incident_id;
    if (!id) continue;
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(inc);
  }
  let numer = 0;
  let denom = 0;
  let unknownOut = false;
  const eventIds = [];
  for (const [, rows] of byKey) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => parseIsoMs(a.occurred_at) - parseIsoMs(b.occurred_at));
    const later = rows[rows.length - 1];
    const earlier = rows[0];
    if (later.attempt_identity.execution_id === earlier.attempt_identity.execution_id) continue;
    const outcome = ctx.outcomes.get(later.attempt_identity.execution_id);
    if (!outcome) {
      unknownOut = true;
      continue;
    }
    denom += 1;
    eventIds.push(later.event_id, outcome.event_id);
    const adj = allAdjudications(ctx.adjudications).find((a) => a.attempt_identity.execution_id === later.attempt_identity.execution_id);
    if (outcome.payload.final === "PASS" && adj && isVerifiedGrade(adj.payload.attribution_grade) && adj.payload.counterfactual_digest) {
      numer += 1;
    }
  }
  if (denom === 0 && !unknownOut) return notMeasurable("denominator_zero");
  if (unknownOut) return unknown("missing_outcome", { numerator: numer, denominator: denom, event_ids: eventIds });
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceM7(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const used = [
    ...(ctx.byType.get("PATTERN_USED_IN_PLANNING") ?? []),
    ...(ctx.byType.get("PATTERN_USED_IN_VERIFICATION") ?? []),
  ];
  const stale = ctx.byType.get("STALE_PATTERN_REJECTED") ?? [];
  const seen = new Map();
  const units = [];
  for (const ev of [...retrieved, ...used]) {
    const pid = ev.pattern_identity?.pattern_id;
    const exec = ev.attempt_identity.execution_id;
    const key = `${pid}|${exec}`;
    if (seen.has(key)) continue;
    const appl = overlayApplicability(ev, ctx.adjudications);
    if (appl === "UNKNOWN") continue;
    seen.set(key, ev);
    units.push({ ev, appl });
  }
  let numer = 0;
  const eventIds = [];
  for (const { ev, appl } of units) {
    eventIds.push(ev.event_id);
    const adj = adjudicationFor(ev.event_id, ctx.adjudications);
    const staleHit = stale.some((s) => s.pattern_identity?.pattern_id === ev.pattern_identity?.pattern_id
      && s.pattern_identity?.generation === ev.pattern_identity?.generation);
    if (appl === "NOT_APPLICABLE" || adj?.payload?.benefit_claimed === false || staleHit) numer += 1;
  }
  return measured(numer, units.length, { event_ids: eventIds });
}

function reduceM8(ctx) {
  const gated = [];
  for (const type of ["PATTERN_RETRIEVED", "PATTERN_USED_IN_PLANNING", "PATTERN_USED_IN_VERIFICATION"]) {
    for (const ev of ctx.byType.get(type) ?? []) {
      const state = ev.payload?.lifecycle_state;
      if (state === "MANDATORY_GATE" || state === "REQUIRED_QUESTION") gated.push(ev);
    }
  }
  if (gated.length === 0) return notMeasurable("mandatory_gate_not_authorized");
  let numer = 0;
  let denom = 0;
  const eventIds = [];
  for (const ev of gated) {
    const appl = overlayApplicability(ev, ctx.adjudications);
    if (appl === "UNKNOWN") continue;
    denom += 1;
    eventIds.push(ev.event_id);
    const adj = adjudicationFor(ev.event_id, ctx.adjudications);
    const outcome = ctx.outcomes.get(ev.attempt_identity.execution_id);
    if (adj?.payload?.unnecessary_gate === true || (outcome?.payload.final === "PASS" && appl === "NOT_APPLICABLE")) numer += 1;
  }
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceM9(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const episodes = new Map();
  for (const r of retrieved) {
    const d = r.payload.retrievalDigest;
    if (!episodes.has(d)) episodes.set(d, r);
  }
  const values = [];
  let unknownCost = false;
  const eventIds = [];
  for (const [digest, ev] of episodes) {
    eventIds.push(ev.event_id);
    const cost = ctx.costByRetrieval?.get(digest);
    if (cost == null || cost.tokenSource === "NOT_REPORTED") {
      unknownCost = true;
      continue;
    }
    values.push((cost.tokens ?? 0) + (cost.byteCount ?? 0));
  }
  const execCosts = [];
  for (const [exec, cost] of ctx.costByExecution ?? []) {
    if (cost == null || cost.tokenSource === "NOT_REPORTED") unknownCost = true;
    else execCosts.push((cost.tokens ?? 0) + (cost.byteCount ?? 0));
  }
  const all = [...values, ...execCosts];
  if (all.length === 0) return notMeasurable("no_reported_cost");
  if (unknownCost) return unknown("tokenSource_NOT_REPORTED", { event_ids: eventIds });
  const sum = all.reduce((a, b) => a + b, 0);
  return measuredValue(sum, { numerator: sum, denominator: all.length, event_ids: eventIds });
}

function reduceM10(ctx) {
  const outcomes = [...ctx.outcomes.values()];
  if (outcomes.length === 0) return notMeasurable("no_task_runs");
  const values = [];
  let unknownDur = false;
  const eventIds = [];
  for (const o of outcomes) {
    eventIds.push(o.event_id);
    const provided = ctx.durationByExecution?.get(o.attempt_identity.execution_id);
    if (provided != null) {
      values.push(provided);
      continue;
    }
    const first = ctx.events
      .filter((e) => e.attempt_identity.execution_id === o.attempt_identity.execution_id)
      .sort((a, b) => parseIsoMs(a.occurred_at) - parseIsoMs(b.occurred_at))[0];
    if (!first) {
      unknownDur = true;
      continue;
    }
    const dur = parseIsoMs(o.recorded_at) - parseIsoMs(first.occurred_at);
    if (!Number.isFinite(dur) || dur < 0) {
      unknownDur = true;
      continue;
    }
    values.push(dur);
  }
  if (values.length === 0) return notMeasurable("unmeasured_duration");
  if (unknownDur) return unknown("unmeasured_duration", { event_ids: eventIds });
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return measuredValue(mean, { numerator: values.reduce((a, b) => a + b, 0), denominator: values.length, event_ids: eventIds });
}

function reduceM12(ctx) {
  const retrieved = ctx.byType.get("PATTERN_RETRIEVED") ?? [];
  const execs = new Map();
  for (const r of retrieved) {
    const appl = overlayApplicability(r, ctx.adjudications);
    if (appl !== "APPLICABLE") continue;
    const id = r.attempt_identity.execution_id;
    if (!execs.has(id)) execs.set(id, []);
    execs.get(id).push(r);
  }
  if (execs.size === 0) return notMeasurable("denominator_zero");
  let numer = 0;
  let missing = false;
  const eventIds = [];
  for (const [exec, recs] of execs) {
    eventIds.push(...recs.map((r) => r.event_id));
    const outcome = ctx.outcomes.get(exec);
    if (!outcome) {
      missing = true;
      continue;
    }
    eventIds.push(outcome.event_id);
    const adjVerified = hasVerifiedForExecution(exec, ctx.adjudications);
    if (outcome.payload.final === "PASS" && adjVerified) numer += 1;
  }
  if (missing) return unknown("missing_outcome", { numerator: numer, denominator: execs.size, event_ids: eventIds });
  return measured(numer, execs.size, { event_ids: eventIds });
}

function reduceM12C(ctx) {
  const execs = new Set(ctx.events.map((e) => e.attempt_identity.execution_id));
  let numer = 0;
  let denom = 0;
  let missing = 0;
  const eventIds = [];
  for (const exec of execs) {
    const outcome = ctx.outcomes.get(exec);
    if (!outcome) {
      missing += 1;
      continue;
    }
    denom += 1;
    eventIds.push(outcome.event_id);
    const used = [
      ...(ctx.byType.get("PATTERN_USED_IN_PLANNING") ?? []),
      ...(ctx.byType.get("PATTERN_USED_IN_VERIFICATION") ?? []),
    ].filter((u) => u.attempt_identity.execution_id === exec);
    const retrieved = (ctx.byType.get("PATTERN_RETRIEVED") ?? []).filter((r) => r.attempt_identity.execution_id === exec);
    const applicableExisted = retrieved.some((r) => overlayApplicability(r, ctx.adjudications) === "APPLICABLE");
    const usedApplicable = used.some((u) => u.payload.citation_kind === "explicit_reference");
    const falsePositive = used.some((u) => overlayApplicability(u, ctx.adjudications) === "NOT_APPLICABLE");
    const rework = outcome.payload.final === "HOLD" && (outcome.payload.repair_attempts > 0)
      && ((applicableExisted && !usedApplicable) || falsePositive);
    if (rework) numer += 1;
  }
  if (denom === 0) return notMeasurable("denominator_zero");
  return measured(numer, denom, { event_ids: eventIds });
}

function reduceM13(ctx) {
  const rollbacks = ctx.byType.get("ROLLBACK_OBSERVED") ?? [];
  const promotions = [
    ...(ctx.byType.get("PATTERN_QUALIFIED") ?? []),
    ...(ctx.byType.get("PATTERN_DEMOTED") ?? []),
  ];
  const promoted = new Set();
  for (const p of promotions) {
    promoted.add(`${p.pattern_identity.pattern_id}|${p.pattern_identity.generation}`);
  }
  if (promoted.size === 0) return notMeasurable("production_promotion_unauthorized");
  const seen = new Set();
  let numer = 0;
  const eventIds = [];
  for (const r of rollbacks) {
    const key = `${r.pattern_identity.pattern_id}|${r.payload.from_generation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    numer += 1;
    eventIds.push(r.event_id);
  }
  return measured(numer, promoted.size, { event_ids: eventIds });
}

function reduceM15(ctx) {
  const events = ctx.events;
  if (events.length === 0) return notMeasurable("denominator_zero");
  let numer = 0;
  const eventIds = [];
  const excluded = [];
  for (const e of events) {
    eventIds.push(e.event_id);
    const scanned = e.redaction_status?.scanned === true && e.redaction_status?.secret_hit === false;
    const complete = e.evidence_complete === true;
    const bound = e.project_identity && e.task_identity && e.attempt_identity;
    const outcomeOk = !["OUTCOME_OBSERVED"].includes(e.event_type) || e.outcome_ref != null;
    if (scanned && complete && bound && outcomeOk) numer += 1;
    else excluded.push(e.event_id);
  }
  return measured(numer, events.length, { event_ids: eventIds, excluded_event_ids: excluded });
}

function buildTrace(metrics) {
  const trace = {};
  for (const [id, m] of Object.entries(metrics)) {
    trace[id] = (m.event_ids ?? []).map((event_id) => ({ event_id }));
  }
  return trace;
}

export function reduceTransferMetrics({
  events,
  window,
  formula_version = FORMULA_VERSION,
  applicable_universe = null,
  costByRetrieval = new Map(),
  costByExecution = new Map(),
  durationByExecution = new Map(),
  revokedWriterIds = new Set(),
  eventGenerations = null,
} = {}) {
  if (!window || !window.start || !window.end) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, "window {start,end} required");
  }
  if (formula_version !== FORMULA_VERSION) {
    fail(TRANSFER_CODES.FORMULA_MIXED, `formula_version ${formula_version} != ${FORMULA_VERSION}`);
  }
  if ((events ?? []).length > MAX_REDUCER_EVENTS) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `event count ${(events ?? []).length} exceeds ${MAX_REDUCER_EVENTS}`);
  }
  const producerKind = window.producer_kind ?? "measurement-writer";
  const filtered = [];
  for (const event of events ?? []) {
    // Per-FILE generation validation [A-1]: every event is validated against
    // ITS FILE's header generation (v1 file ⇒ v1 rules, v2 file ⇒ v2 rules);
    // versions outside {v1, v2} ⇒ FORMULA_MIXED fail-closed. When no file
    // map is supplied, each event's own schema_version supplies its
    // generation.
    const generation = eventGenerations instanceof Map
      ? (eventGenerations.get(event.journal_sequence) ?? null)
      : (event.schema_version === SCHEMA_VERSION ? 1
        : event.schema_version === SCHEMA_VERSION_V2 ? 2
        : null);
    if (generation !== 1 && generation !== 2) {
      fail(TRANSFER_CODES.FORMULA_MIXED, `event schema_version ${String(event.schema_version)} not in {v1, v2}`);
    }
    if (event.event_type === AUTHORITY_EVENT_TYPE) {
      if (generation !== 2) fail(TRANSFER_CODES.FORMULA_MIXED, "authority event outside a GEN-2 file");
      validateAuthorityRecord(event);
      // EXCLUDED before every population, event_ids, and input_digest —
      // authority events can never become a metric.
      continue;
    }
    if (event.schema_version !== (generation === 1 ? SCHEMA_VERSION : SCHEMA_VERSION_V2)) {
      fail(TRANSFER_CODES.FORMULA_MIXED, "event schema_version does not match its file generation");
    }
    if (!inWindow(event, window)) continue;
    if (!producerAllowed(event, producerKind)) continue;
    filtered.push(event);
  }
  const event_ids = unique(filtered.map((e) => e.event_id)).sort();
  const ctx = {
    events: filtered,
    byType: indexByType(filtered),
    adjudications: adjudicationsBySubject(filtered),
    outcomes: outcomeByExecution(filtered),
    applicableUniverse: applicable_universe,
    costByRetrieval,
    costByExecution,
    durationByExecution,
    revokedWriterIds,
  };
  const m3 = reduceImpact(ctx, "PATTERN_USED_IN_PLANNING", false);
  const m3v = reduceImpact(ctx, "PATTERN_USED_IN_PLANNING", true);
  const m4 = reduceImpact(ctx, "PATTERN_USED_IN_VERIFICATION", false);
  const m4v = reduceImpact(ctx, "PATTERN_USED_IN_VERIFICATION", true);
  const metrics = {
    M1: reduceM1(ctx),
    M1C: reduceM1C(ctx),
    M2: reduceM2(ctx),
    M2C: reduceM2C(ctx),
    M3: m3,
    M3v: m3v,
    M4: m4,
    M4v: m4v,
    M5: reduceM5(ctx),
    M6: reduceM6(ctx),
    M7: reduceM7(ctx),
    M8: reduceM8(ctx),
    M9: reduceM9(ctx),
    M10: reduceM10(ctx),
    M11: m11AlwaysNotMeasurable(),
    M12: reduceM12(ctx),
    M12C: reduceM12C(ctx),
    M13: reduceM13(ctx),
    M14: m14AlwaysNotMeasurable(),
    M15: reduceM15(ctx),
  };
  const input = {
    formula_version,
    window: { start: window.start, end: window.end, bound_field: "occurred_at" },
    event_ids,
  };
  const doc = {
    formula_version,
    window: { start: window.start, end: window.end, bound_field: "occurred_at" },
    event_ids,
    input_digest: digestOf(input),
    metrics,
    trace: buildTrace(metrics),
    canonical_metrics: CANONICAL_METRICS,
    companion_metrics: COMPANION_METRICS,
    authority: "NONE",
    authoritative: false,
    production_effect: "NO_PRODUCTION_EFFECT",
  };
  const serialized = canonical(doc);
  if (Buffer.byteLength(serialized, "utf8") > MAX_DERIVED_BYTES) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `derived document exceeds ${MAX_DERIVED_BYTES}`);
  }
  return doc;
}

export function writeDerivedDocument(root, doc) {
  const serialized = canonical(doc);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_DERIVED_BYTES) {
    fail(TRANSFER_CODES.PAYLOAD_MALFORMED, `derived document exceeds ${MAX_DERIVED_BYTES}`);
  }
  const dir = join(root, "derived");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `transfer-metrics-${doc.formula_version.replace(/\//g, "_")}-${doc.input_digest}.json`;
  const path = join(dir, name);
  writeFileSync(path, serialized + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return path;
}

export function serializeDerived(doc) {
  return canonical(doc);
}
