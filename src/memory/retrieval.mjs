// src/memory/retrieval.mjs
//
// CBM-3 — Deterministic Retrieval Engine.
//
// The SAME store snapshot + SAME query MUST always produce:
//   - the same ordered result
//   - the same exclusion decisions
//   - the same conflict groups
//   - the same retrievalDigest
//
// Determinism rules（card §12-§14）:
//   - FTS5 is used ONLY for lexical candidate GENERATION（binary in/out）.
//     FTS score / rowid / implicit SQLite ordering NEVER enter the ranking,
//     the selection, or the retrievalDigest.
//   - every SQL has an explicit deterministic ORDER BY.
//   - the final ranking uses the DOCUMENTED tuple below; the last element
//     is always the stable recordId tie-break（ascending）.
//
// Ranking tuple（documented, frozen by tests）— descending on elements
// 1..5, ascending on element 6:
//   1. identityMatch:  2 = recordId explicitly selected; 1 = exact
//                      logicalKey selector; 0 = otherwise
//   2. scopeSpecificity: 3 = path-pinned to the query path; 2 = symbol-
//                      pinned to the query symbol; 1 = tree-pinned to the
//                      query tree baseline; 0 = otherwise
//   3. trustRank:      TRUST_RANK[trust]（higher trust wins）
//   4. relationshipApplicability: 1 when the record participates in a
//                      first-class relationship with an identity-selected
//                      record（either direction）; 0 otherwise
//   5. lexicalMatchClass: count of distinct query terms found in the
//                      record's searchable text（deterministic term count —
//                      never bm25）
//   6. recordId        ascending（stable tie-break — REQUIRED）
//
// Conflict policy（card §15）: two+ CURRENT records sharing a logicalKey
// with different contentHash → conflictGroup surfaced（records excluded from
// selection, NEVER silently merged / never "choose first / newest / highest
// score"）. Records with CONFLICTED validity / present in the conflict table
// are surfaced as conflict groups too（card §28: CONFLICTED surfaced, never
// selected, never silently dropped）.

import { MEMORY_RETRIEVAL_RESULT_SCHEMA, MEMORY_RETRIEVAL_DIGEST_SCHEMA, queryIdentity, normalizeQueryTerms } from "./query-schema.mjs";
import { TRUST_RANK, TRUST_STATES, VALIDITY_STATUSES, RELATIONSHIP_TYPES, MEMORY_RECORD_SCHEMA, RECORD_TYPES } from "./contract.mjs";
import { recursiveCanonicalJson } from "./canonical.mjs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { storeSnapshotDigest, snapshotStats } from "./snapshot.mjs";
import { ftsMatch } from "./sqlite-schema.mjs";
import { scanFreeTextFields } from "./validation.mjs";
import { deriveMemoryRecordId, deriveLogicalKey, deriveContentHash } from "./identity.mjs";
import { evaluateBoundary } from "../learning/patterns/applicability.mjs";

export const RETRIEVAL_ERRORS = Object.freeze({
  RETRIEVAL_INVALID_QUERY: "RETRIEVAL_INVALID_QUERY",
});

const VALIDITY_ELIGIBLE = Object.freeze({
  CURRENT: ["CURRENT"],
  INCLUDE_STALE: ["CURRENT", "STALE"],
  ALL: ["CURRENT", "STALE", "INVALIDATED", "TOMBSTONED"],
});

// R2 O7 — PATTERN applicability selectors present in the structured query
// (QUERY_FIELDS member `pattern`). Presence of any selector field TRIGGERS
// boundary consultation for PATTERN hits (PLAN-OBLIGATION-FREEZE §1:
// WHEN REQUIRED / WHEN NOT REQUIRED / TRIGGER INPUT — total over the input
// space; no conditionals left to implementation judgment).
function patternSelectorsPresent(query) {
  const p = query.pattern;
  if (!p || typeof p !== "object") return false;
  return Array.isArray(p.appliesWhen) && p.appliesWhen.length > 0
    || Array.isArray(p.doesNotApplyWhen) && p.doesNotApplyWhen.length > 0
    || (p.mechanismSignature !== null && p.mechanismSignature !== undefined && typeof p.mechanismSignature === "object");
}

/** Searchable text for lexical matching（statement + content + path + symbol）. */
export function recordSearchableText(rec) {
  return [
    typeof rec?.subject?.statement === "string" ? rec.subject.statement : "",
    typeof rec?.content?.text === "string" ? rec.content.text : "",
    typeof rec?.scope?.path === "string" ? rec.scope.path : "",
    typeof rec?.scope?.symbol === "string" ? rec.scope.symbol : "",
  ].filter(Boolean).join(" ");
}

/**
 * Light record validation at retrieval time（eligibility "record schema
 * validation"）. Recomputed identity + fixed enums + secret scan — evidence
 * FILE hashing is skipped（records were file-validated at import; this guard
 * exists to catch tampered DB state, not to re-verify the filesystem）.
 */
export function validateMemoryRecordLight(rec) {
  const errors = [];
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return { ok: false, errors: ["record_not_object"] };
  if (rec.schema !== MEMORY_RECORD_SCHEMA) errors.push(`schema_invalid:${String(rec.schema)}`);
  if (typeof rec.recordId !== "string") errors.push("recordId_missing");
  if (typeof rec.recordType !== "string" || !RECORD_TYPES.includes(rec.recordType)) errors.push("recordType_invalid");
  if (typeof rec.trust !== "string" || !TRUST_STATES.includes(rec.trust)) errors.push("trust_invalid");
  if (typeof rec.validity?.status !== "string" || !VALIDITY_STATUSES.includes(rec.validity.status)) errors.push("validity_invalid");
  if (typeof rec.scope !== "object" || rec.scope === null || Array.isArray(rec.scope)) errors.push("scope_missing");
  try {
    if (rec.recordId !== deriveMemoryRecordId(rec)) errors.push("recordId_mismatch");
    if (rec.subject?.contentHash !== deriveContentHash(rec.content)) errors.push("contentHash_mismatch");
  } catch (e) {
    errors.push(`canonicalization_failed:${String(e?.message ?? e)}`);
  }
  const scan = scanFreeTextFields({ content: rec.content, subject: rec.subject, metadata: rec.metadata });
  if (!scan.safe) errors.push(`secret_detected:${scan.matches.join(",")}`);
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Eligibility pipeline（card §9）
// ---------------------------------------------------------------------------

/**
 * Full eligibility decision for one record against one query. Returns
 * { eligible, reasons, validityStatus }. CONFLICTED-validity records are
 * NEVER eligible for selection（they are surfaced as conflicts instead）;
 * the caller detects that via `conflicted=true`.
 */
function eligibilityDecision(record, query, { explicitlySelected = false, explicitLogicalKey = false } = {}) {
  const reasons = [];
  const scope = record.scope ?? {};
  const validityStatus = record.validity?.status ?? "CURRENT";

  // 1. repository match（hard first boundary）
  const repo = scope.repository;
  if (typeof repo !== "string" || repo.length === 0) {
    if (scope.global === true) {
      if (query.scope.global === false) return { eligible: false, conflicted: false, reasons: ["scope:global_excluded"], validityStatus };
    } else {
      return { eligible: false, conflicted: false, reasons: ["repository:no_repository_binding_and_not_global"], validityStatus };
    }
  } else {
    if (repo !== query.context.repository) return { eligible: false, conflicted: false, reasons: ["repository:mismatch"], validityStatus };
  }

  // 2. worktree isolation（hard per-record boundary）
  if (typeof scope.worktree === "string" && scope.worktree.length > 0) {
    if (typeof query.context.worktree !== "string" || query.context.worktree.length === 0) {
      return { eligible: false, conflicted: false, reasons: ["worktree:bound_without_query_worktree"], validityStatus };
    }
    if (scope.worktree !== query.context.worktree) {
      return { eligible: false, conflicted: false, reasons: ["worktree:mismatch"], validityStatus };
    }
  }

  // 3. scope compatibility（path / symbol / graphRun / task）
  if (query.scope.path) {
    if (typeof scope.path === "string" && scope.path.length > 0) {
      const recPath = scope.path.replace(/\/+$/, "");
      const okPath = recPath === query.scope.path || query.scope.path.startsWith(recPath + "/");
      if (!okPath) return { eligible: false, conflicted: false, reasons: ["scope:path_mismatch"], validityStatus };
    }
  }
  if (query.scope.symbol) {
    if (typeof scope.symbol === "string" && scope.symbol.length > 0 && scope.symbol !== query.scope.symbol) {
      return { eligible: false, conflicted: false, reasons: ["scope:symbol_mismatch"], validityStatus };
    }
  }
  if (query.context.graphRunId) {
    if (typeof scope.graphRun === "string" && scope.graphRun.length > 0 && scope.graphRun !== query.context.graphRunId) {
      return { eligible: false, conflicted: false, reasons: ["scope:graphRun_mismatch"], validityStatus };
    }
  }
  if (query.context.task) {
    if (typeof scope.task === "string" && scope.task.length > 0 && scope.task !== query.context.task) {
      return { eligible: false, conflicted: false, reasons: ["scope:task_mismatch"], validityStatus };
    }
  }

  // 4. trust check — an explicit recordId / logicalKey selector is a
  //    deliberate point lookup: it MAY retrieve a record below the trust
  //    floor（the caller explicitly asked for THIS record）. It can NEVER
  //    bypass isolation / validity / security.
  if (!explicitlySelected && !explicitLogicalKey) {
    const rank = TRUST_RANK[record.trust] ?? -1;
    const floor = TRUST_RANK[query.trustFloor] ?? TRUST_RANK.VERIFIED;
    if (rank < floor) return { eligible: false, conflicted: false, reasons: ["trust:below_floor"], validityStatus };
  }

  // 5. validity check — CONFLICTED is never eligible for selection
  if (validityStatus === "CONFLICTED") {
    return { eligible: false, conflicted: true, reasons: ["validity:conflicted_surfaced"], validityStatus };
  }
  // 5b. tree-baseline validity（CBM-2 validity contract）: a tree-bound record
  // whose scope.tree differs from the query tree is STALE for THIS context —
  // excluded under the default policy; explicitly included (flagged by its
  // stored validity) only under INCLUDE_STALE / ALL.
  if (query.context.tree && typeof scope.tree === "string" && scope.tree !== query.context.tree) {
    if (!["INCLUDE_STALE", "ALL"].includes(query.validityPolicy)) {
      return { eligible: false, conflicted: false, reasons: ["validity:tree_changed_stale"], validityStatus };
    }
  }
  if (!VALIDITY_ELIGIBLE[query.validityPolicy]?.includes(validityStatus)) {
    return { eligible: false, conflicted: false, reasons: [`validity:${validityStatus}_excluded_by_${query.validityPolicy}`], validityStatus };
  }

  // 6. security / schema
  const v = validateMemoryRecordLight(record);
  if (!v.ok) return { eligible: false, conflicted: false, reasons: [`security:${v.errors.join(";")}`], validityStatus };

  return { eligible: true, conflicted: false, reasons: [], validityStatus };
}

// ---------------------------------------------------------------------------
// Ranking（documented tuple）
// ---------------------------------------------------------------------------

function scopeSpecificity(record, query) {
  const scope = record.scope ?? {};
  if (query.scope.path && typeof scope.path === "string") {
    const recPath = scope.path.replace(/\/+$/, "");
    if (recPath === query.scope.path || query.scope.path.startsWith(recPath + "/")) return 3;
  }
  if (query.scope.symbol && typeof scope.symbol === "string" && scope.symbol === query.scope.symbol) return 2;
  if (query.context.tree && typeof scope.tree === "string" && scope.tree === query.context.tree) return 1;
  return 0;
}

function lexicalMatchClass(record, terms) {
  if (terms.length === 0) return 0;
  const text = recordSearchableText(record).toLowerCase();
  let count = 0;
  for (const t of terms) {
    if (text.includes(t)) count += 1;
  }
  return count;
}

function compareRanked(a, b) {
  for (let i = 0; i < a.rank.length - 1; i++) {
    if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i]; // descending
  }
  const ra = a.rank[a.rank.length - 1];
  const rb = b.rank[b.rank.length - 1];
  if (ra !== rb) return ra < rb ? -1 : 1; // ascending（recordId tie-break）
  return 0;
}

// ---------------------------------------------------------------------------
// Conflict surfacing（card §15 / §28）
// ---------------------------------------------------------------------------

/**
 * Detect conflict groups among the query's candidates:
 *   (a) two+ CURRENT-eligible records sharing a logicalKey with ≥2 distinct
 *       contentHash → surfaced（never merged / never one chosen）;
 *   (b) CONFLICTED-validity candidates → surfaced;
 *   (c) conflict-table rows whose records pass repository/worktree/scope
 *       eligibility → surfaced.
 * Every surfaced record is excluded from selection.
 */
export function detectRetrievalConflicts({ eligibleRecords, conflictedRecords, db }) {
  const groups = [];
  const seenKeys = new Set();
  const keyOf = (rec) => rec.logicalKey ?? deriveLogicalKey(rec);

  // (a) CURRENT logical-key version conflicts
  const byKey = new Map();
  for (const r of eligibleRecords) {
    if (r.validity?.status !== "CURRENT") continue;
    const lk = keyOf(r);
    if (!byKey.has(lk)) byKey.set(lk, []);
    byKey.get(lk).push(r);
  }
  for (const [lk, members] of byKey) {
    const hashes = new Set(members.map((m) => m.subject?.contentHash));
    if (hashes.size > 1) {
      groups.push({
        logicalKey: lk,
        reason: "CURRENT records with conflicting content versions under one logicalKey",
        records: members.map((m) => m.recordId).sort(),
      });
      seenKeys.add(lk);
    }
  }

  // (b) CONFLICTED-validity candidates
  const byId = new Map(eligibleRecords.map((r) => [r.recordId, r]));
  for (const r of conflictedRecords) byId.set(r.recordId, r);
  for (const rec of conflictedRecords) {
    const lk = keyOf(rec);
    if (seenKeys.has(lk)) continue;
    const members = [rec.recordId];
    for (const other of conflictedRecords) {
      if (other.recordId !== rec.recordId && keyOf(other) === lk && !members.includes(other.recordId)) members.push(other.recordId);
    }
    groups.push({ logicalKey: lk, reason: "validity_status = CONFLICTED", records: members.sort() });
    seenKeys.add(lk);
  }

  // (c) conflict-table rows（repo/worktree/scope-eligible records only）
  const conflictRows = db.prepare(`
    SELECT record_id, logical_key FROM memory_conflicts ORDER BY conflict_group_id ASC, record_id ASC
  `).all();
  for (const row of conflictRows) {
    const rec = byId.get(row.record_id);
    if (!rec) continue; // not a candidate for THIS query → not surfaced here
    if (seenKeys.has(row.logical_key)) continue;
    groups.push({ logicalKey: row.logical_key, reason: "present in the conflict table", records: [row.record_id] });
    seenKeys.add(row.logical_key);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Main retrieval
// ---------------------------------------------------------------------------

/**
 * Deterministic retrieval over a store snapshot.
 *
 * @param {object} opts
 * @param {DatabaseSync} opts.db — open memory sqlite
 * @param {object} opts.query — validated/normalized query（validateMemoryQueryV1）
 * @returns {object} MEMORY_RETRIEVAL_RESULT_SCHEMA
 */
export function retrieveMemory({ db, query }) {
  const excluded = { repository: 0, worktree: 0, scope: 0, trust: 0, validity: 0, security: 0, conflict: 0, boundary: 0 };
  // R2 O7 trigger input (frozen §1): structured PATTERN applicability
  // selectors — presence (not content) decides WHETHER consultation runs.
  const patternSelectors = patternSelectorsPresent(query);
  const pattern = patternSelectors ? query.pattern : null;

  // ── SQL candidate prefilter（card §30: no full DB serialization per
  // query）—— deterministic hard filters are pushed into parameterized SQL;
  // only candidates are loaded and re-validated in JS（path/symbol matching,
  // security/schema）. Explicit deterministic ORDER BY everywhere.
  const where = [];
  const args = [];
  if (query.recordTypes !== null) {
    where.push(`record_type IN (${query.recordTypes.map(() => "?").join(",")})`);
    args.push(...query.recordTypes);
  }
  // repository（hard first boundary）
  if (query.scope.global === false) {
    where.push("scope_repository = ?");
    args.push(query.context.repository);
  } else {
    where.push("(scope_repository = ? OR scope_global = 1)");
    args.push(query.context.repository);
  }
  // worktree isolation
  if (query.context.worktree) {
    where.push("(scope_worktree = ? OR scope_worktree IS NULL)");
    args.push(query.context.worktree);
  } else {
    where.push("scope_worktree IS NULL");
  }
  // trust floor（explicit selectors bypass — deliberate point lookups）
  const floor = TRUST_RANK[query.trustFloor] ?? TRUST_RANK.VERIFIED;
  const selectors = query.identitySelectors.recordIds;
  if (selectors.length > 0 || query.logicalKey) {
    const selConds = [];
    if (selectors.length > 0) {
      selConds.push(`record_id IN (${selectors.map(() => "?").join(",")})`);
    }
    if (query.logicalKey) {
      selConds.push("logical_key = ?");
    }
    // placeholder order: trust_rank first, then selectors（match the SQL）
    where.push(`(trust_rank >= ? OR ${selConds.join(" OR ")})`);
    args.push(floor, ...selectors);
    if (query.logicalKey) args.push(query.logicalKey);
  } else {
    where.push("trust_rank >= ?");
    args.push(floor);
  }
  // validity（CONFLICTED never selectable — surfaced separately）
  const valid = VALIDITY_ELIGIBLE[query.validityPolicy] ?? VALIDITY_ELIGIBLE.CURRENT;
  where.push(`validity_status IN (${valid.map(() => "?").join(",")})`);
  args.push(...valid);
  // tree-baseline staleness（CURRENT policy only — stale trees excluded）
  if (query.context.tree && query.validityPolicy === "CURRENT") {
    where.push("(scope_tree = ? OR scope_tree IS NULL)");
    args.push(query.context.tree);
  }
  // graphRun / task binding
  if (query.context.graphRunId) {
    where.push("(scope_graph_run = ? OR scope_graph_run IS NULL)");
    args.push(query.context.graphRunId);
  }
  if (query.context.task) {
    where.push("(scope_task = ? OR scope_task IS NULL)");
    args.push(query.context.task);
  }

  const records = db.prepare(`
    SELECT record_id, record_type, trust, validity_status, json FROM memory_records
    WHERE ${where.join(" AND \n    ")}
    ORDER BY record_id ASC
  `).all(...args).map((r) => JSON.parse(r.json));

  const totalCandidates = db.prepare("SELECT COUNT(*) n FROM memory_records").get().n;

  // ── staged exclusion accounting（deterministic; first-failing-filter
  // semantics）: each stage counts how many records pass the cumulative
  // filters, so exclusions are attributed to the FIRST filter that rejects
  // them — coherent with the eligibility pipeline and digest-stable.
  const fragRepo = { sql: query.scope.global === false ? "scope_repository = ?" : "(scope_repository = ? OR scope_global = 1)", args: [query.context.repository] };
  const fragWt = query.context.worktree
    ? { sql: "(scope_worktree = ? OR scope_worktree IS NULL)", args: [query.context.worktree] }
    : { sql: "scope_worktree IS NULL", args: [] };
  const fragTrust = (() => {
    if (selectors.length > 0 || query.logicalKey) {
      const sel = [];
      const sa = [];
      if (selectors.length > 0) {
        sel.push(`record_id IN (${selectors.map(() => "?").join(",")})`);
        sa.push(...selectors);
      }
      if (query.logicalKey) {
        sel.push("logical_key = ?");
        sa.push(query.logicalKey);
      }
      return { sql: `(trust_rank >= ? OR ${sel.join(" OR ")})`, args: [floor, ...sa] };
    }
    return { sql: "trust_rank >= ?", args: [floor] };
  })();
  const fragValid = { sql: `validity_status IN (${valid.map(() => "?").join(",")})`, args: [...valid] };
  const fragTree = query.context.tree && query.validityPolicy === "CURRENT"
    ? { sql: "(scope_tree = ? OR scope_tree IS NULL)", args: [query.context.tree] }
    : null;
  const countFragments = (...frags) => {
    const flat = frags.filter(Boolean);
    const args = flat.flatMap((f) => f.args);
    return db.prepare(`SELECT COUNT(*) n FROM memory_records WHERE ${flat.map((f) => f.sql).join(" AND ")}`).get(...args).n;
  };
  const afterRepoOnly = countFragments(fragRepo);
  const afterRepoWT = countFragments(fragRepo, fragWt);
  const afterTrust = countFragments(fragRepo, fragWt, fragTrust);
  const afterValidity = countFragments(fragRepo, fragWt, fragTrust, fragValid, fragTree);
  const conflictedCount = countFragments(fragRepo, fragWt, fragTrust, { sql: "validity_status = 'CONFLICTED'", args: [] });
  excluded.repository = totalCandidates - afterRepoOnly;
  excluded.worktree = afterRepoOnly - afterRepoWT;
  excluded.trust = afterRepoWT - afterTrust;
  excluded.validity = afterTrust - afterValidity - conflictedCount;
  excluded.conflict = conflictedCount;

  // CONFLICTED-status records passing repository/worktree/trust isolation
  // are surfaced（never silently dropped, never selected）.
  const conflictedRecords = db.prepare(`
    SELECT record_id, record_type, trust, validity_status, json FROM memory_records
    WHERE ${[fragRepo, fragWt, fragTrust, { sql: "validity_status = 'CONFLICTED'", args: [] }].map((f) => f.sql).join(" AND \n    ")}
    ORDER BY record_id ASC
  `).all(...[fragRepo, fragWt, fragTrust].flatMap((f) => f.args)).map((r) => JSON.parse(r.json));

  // FTS lexical candidate generation（candidate ONLY — never ordering）.
  const ftsCandidates = new Set();
  if (query.terms && typeof query.terms === "string" && query.terms.trim().length > 0) {
    try {
      for (const rid of ftsMatch(db, query.terms)) ftsCandidates.add(rid);
    } catch {
      // malformed FTS query → empty candidate set; determinism preserved
      //（recomputed the same way every time）.
    }
  }
  const terms = normalizeQueryTerms(query.terms);

  const eligible = [];
  for (const rec of records) {
    const explicitlySelected = query.identitySelectors.recordIds.includes(rec.recordId);
    const explicitLogicalKey = query.logicalKey !== null && (rec.logicalKey ?? deriveLogicalKey(rec)) === query.logicalKey;
    // identity / logicalKey selectors are RANKING signals（tuple element 1）—
    // an exact match ranks first, but never silently excludes the rest of the
    // eligible pool and never bypasses isolation / validity / security.
    const decision = eligibilityDecision(rec, query, { explicitlySelected, explicitLogicalKey });
    if (!decision.eligible) {
      if (decision.conflicted) {
        conflictedRecords.push(rec);
        continue;
      }
      const r = decision.reasons[0]?.split(":")[0] ?? "other";
      if (r === "repository") excluded.repository += 1;
      else if (r === "worktree") excluded.worktree += 1;
      else if (r === "scope") excluded.scope += 1;
      else if (r === "trust") excluded.trust += 1;
      else if (r === "validity") excluded.validity += 1;
      else if (r === "security") excluded.security += 1;
      else if (r === "boundary") excluded.boundary += 1;
      continue;
    }
    // R2 O7 — boundary consultation (frozen §1 semantics; AFTER all trust/
    // validity/scope/security fences, BEFORE FTS candidate narrowing):
    //   WHEN REQUIRED: PATTERN hit + query carries PATTERN applicability
    //     selector fields → the record's STORED boundary is evaluated against
    //     the query selectors (mechanism/applicability primary matching per
    //     [CT §4]; the boundary is on the record, self-describing).
    //   WHEN NOT REQUIRED: non-PATTERN hits keep today's semantics
    //     byte-identical; PATTERN hits on selector-less queries flow through
    //     identity/scope/trust-floor/lexical paths only.
    //   FAILURE RESULT: a boundary that cannot re-derive from stored fields
    //     fails closed (SCHEMA_INVALID class, boundary_vacuous — thrown by
    //     the evaluator and NEVER swallowed); a required-but-false match
    //     makes the record NON-ELIGIBLE — a deterministic filter with the
    //     reason recorded (NOT an error).
    //   DURABLE EFFECT: NONE (read-only consultation; output is ALWAYS DATA).
    //   PROHIBITION: consultation NEVER infers applicability from lexical
    //     similarity alone — only the structured selector fields above.
    if (rec.recordType === "PATTERN" && patternSelectors) {
      const verdict = evaluateBoundary(rec.content?.data?.applicability ?? null, {
        appliesWhen: pattern.appliesWhen ?? undefined,
        doesNotApplyWhen: pattern.doesNotApplyWhen ?? undefined,
        mechanismSignature: pattern.mechanismSignature ?? undefined,
      });
      if (!verdict.eligible) {
        excluded.boundary += 1;
        continue;
      }
    }
    // FTS: when lexical terms are present, a record must be a candidate
    // UNLESS it is explicitly selected by identity/logicalKey.
    if (query.terms && query.terms.trim().length > 0) {
      if (!explicitlySelected && !explicitLogicalKey && !ftsCandidates.has(rec.recordId)) continue;
    }
    eligible.push({ rec, explicitlySelected, explicitLogicalKey });
  }

  // ── conflict surfacing（before ranking — conflicted members never rank）──
  const conflictGroups = detectRetrievalConflicts({
    eligibleRecords: eligible.map((e) => e.rec),
    conflictedRecords,
    db,
  });
  const conflictRecordIds = new Set();
  for (const g of conflictGroups) for (const rid of g.records) conflictRecordIds.add(rid);
  const selectedPool = eligible.filter((e) => !conflictRecordIds.has(e.rec.recordId));
  // CURRENT conflict members（removed from selection）count as conflict
  // exclusions — never as validity exclusions, never silently dropped.
  excluded.conflict += eligible.length - selectedPool.length;

  // ── relationship applicability（identity-selected records only）────────
  const relationships = db.prepare(`
    SELECT record_id, target_record_id, relationship_type FROM memory_relationships ORDER BY relationship_id ASC
  `).all();
  const relGraph = new Map(); // recordId -> set of related recordIds
  for (const rel of relationships) {
    if (!RELATIONSHIP_TYPES.includes(rel.relationship_type)) continue;
    if (!relGraph.has(rel.record_id)) relGraph.set(rel.record_id, new Set());
    relGraph.get(rel.record_id).add(rel.target_record_id);
    if (!relGraph.has(rel.target_record_id)) relGraph.set(rel.target_record_id, new Set());
    relGraph.get(rel.target_record_id).add(rel.record_id);
  }
  const identitySelectedIds = new Set(
    selectedPool.filter((e) => e.explicitlySelected || e.explicitLogicalKey).map((e) => e.rec.recordId),
  );
  const relationshipRelevant = new Set();
  for (const id of identitySelectedIds) {
    const related = relGraph.get(id);
    if (related) for (const x of related) relationshipRelevant.add(x);
  }

  // ── deterministic ranking（documented tuple）───────────────────────────
  const ranked = selectedPool.map(({ rec, explicitlySelected, explicitLogicalKey }) => {
    const rankTuple = [
      explicitlySelected ? 2 : explicitLogicalKey ? 1 : 0,
      scopeSpecificity(rec, query),
      TRUST_RANK[rec.trust] ?? 0,
      relationshipRelevant.has(rec.recordId) ? 1 : 0,
      lexicalMatchClass(rec, terms),
      rec.recordId, // stable tie-break（ascending）
    ];
    return { rec, rank: rankTuple };
  });
  ranked.sort(compareRanked);

  // ── deterministic limits / truncation（stable order only）──────────────
  const selectedRecords = [];
  let byteCount = 0;
  let truncated = false;
  for (const { rec } of ranked) {
    const recBytes = Buffer.byteLength(recursiveCanonicalJson(rec), "utf8");
    if (selectedRecords.length >= query.limits.maxRecords || byteCount + recBytes > query.limits.maxBytes) {
      truncated = true;
      continue;
    }
    selectedRecords.push(rec);
    byteCount += recBytes;
  }

  // applicable relationships per selected record（provenance preserved）.
  const applicableRelationships = (recId) => {
    const out = [];
    for (const rel of relationships) {
      if (!RELATIONSHIP_TYPES.includes(rel.relationship_type)) continue;
      if (rel.record_id === recId || rel.target_record_id === recId) {
        out.push({ relationshipType: rel.relationship_type, recordId: rel.record_id, targetRecordId: rel.target_record_id });
      }
    }
    return out.sort((a, b) => (a.relationshipType < b.relationshipType ? -1 : a.relationshipType > b.relationshipType ? 1 : (a.recordId < b.recordId ? -1 : 1)));
  };

  const snapshotDigest = storeSnapshotDigest(db);
  const stats = snapshotStats(db);
  const digestInput = {
    schema: MEMORY_RETRIEVAL_DIGEST_SCHEMA,
    queryIdentity: queryIdentity(query),
    context: { ...query.context },
    storeSnapshotDigest: snapshotDigest,
    selectedRecordIds: selectedRecords.map((r) => r.recordId),
    conflictGroups: conflictGroups.map((g) => ({ logicalKey: g.logicalKey, recordIds: [...g.records] })),
    excludedSummary: { ...excluded, totalCandidates },
    truncated,
    limits: { ...query.limits },
  };
  const digest = sha256Text(recursiveCanonicalJson(digestInput));

  return {
    schema: MEMORY_RETRIEVAL_RESULT_SCHEMA,
    queryIdentity: queryIdentity(query),
    storeSnapshotDigest: snapshotDigest,
    retrievalDigest: digest,
    selectedRecords: selectedRecords.map((rec) => ({
      recordId: rec.recordId,
      recordType: rec.recordType,
      trust: rec.trust,
      validity: { status: rec.validity?.status ?? "CURRENT", validityTree: rec.validity?.validityTree ?? null },
      scope: { ...(rec.scope ?? {}) },
      content: { kind: rec.content?.kind ?? null, text: typeof rec.content?.text === "string" ? rec.content.text : null, data: rec.content?.data ?? null },
      sourceIdentity: rec.source?.identity ?? null,
      evidenceIdentity: {
        manifestDigest: rec.evidence?.manifestDigest ?? null,
        verifierResultIdentity: rec.evidence?.verifierResultIdentity ?? null,
        reviewResultIdentity: rec.evidence?.reviewResultIdentity ?? null,
        controllerRulingIdentity: rec.evidence?.controllerRulingIdentity ?? null,
      },
      applicableRelationships: applicableRelationships(rec.recordId),
    })),
    conflictGroups,
    excludedSummary: { ...excluded, totalCandidates },
    counts: {
      selected: selectedRecords.length,
      conflictRecords: conflictRecordIds.size,
      eligibleBeforeConflict: selectedPool.length,
      totalCandidates,
      storeRecords: stats.recordCount,
    },
    byteCount,
    truncated,
    limits: { ...query.limits },
  };
}

export { queryIdentity, deriveLogicalKey };
