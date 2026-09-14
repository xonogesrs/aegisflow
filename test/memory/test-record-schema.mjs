// test/memory/test-record-schema.mjs
//
// CBM-2 §15 Record schema: 10 required cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMemoryRecordV1, MEMORY_ERRORS, NOT_APPLICABLE } from "../../src/memory/index.mjs";
import { baseCodeRecord, baseExecutionRecord, baseDecisionRecord, hex64, hex40 } from "./helpers.mjs";

const opts = { authorizedDirs: [] };

test("1. valid CODE record", () => {
  const r = baseCodeRecord();
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.ok(v.derivedIdentity.recordId === r.recordId);
  assert.ok(v.derivedIdentity.contentHash === r.subject.contentHash);
});

test("2. valid EXECUTION record", () => {
  const v = validateMemoryRecordV1(baseExecutionRecord(), opts);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("3. valid DECISION record", () => {
  const v = validateMemoryRecordV1(baseDecisionRecord(), opts);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("4. unknown record type rejected", () => {
  const r = baseCodeRecord({ recordType: "WHISPER" });
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("recordType_invalid")));
});

test("5. unknown schema rejected", () => {
  const r = baseCodeRecord({ schema: "autoloop.memory-record/v999" });
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("unknown_schema")));
});

test("6. missing required field rejected", () => {
  for (const drop of ["identity.path", "subject.statement", "content.kind"]) {
    const r = baseCodeRecord();
    const parts = drop.split(".");
    let cur = r;
    for (const p of parts.slice(0, -1)) cur = cur[p];
    delete cur[parts[parts.length - 1]];
    const v = validateMemoryRecordV1(r, opts);
    assert.equal(v.valid, false, `${drop} should be required`);
    assert.ok(v.errors.some((e) => e.includes("missing_required") && e.includes(drop)), drop);
  }
  // top-level enum fields use fixed-enum checks
  const noSource = baseCodeRecord();
  delete noSource.source.source;
  assert.ok(validateMemoryRecordV1(noSource, opts).errors.some((e) => e.includes("source_invalid")));
  const noTrust = baseCodeRecord();
  delete noTrust.trust;
  assert.ok(validateMemoryRecordV1(noTrust, opts).errors.some((e) => e.includes("trust_invalid")));
});

test("7. arbitrary extra control field rejected", () => {
  const r = baseCodeRecord({ _control: "exec-me" });
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("unknown_envelope_field")));
});

test("8. writer-provided fake recordId rejected (identity mismatch)", () => {
  const r = baseCodeRecord();
  r.recordId = "0".repeat(64); // inject AFTER derivation（helpers always derive）
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("IDENTITY_MISMATCH:recordId")));
});

test("9. identity recomputation mismatch rejected (tampered identity field)", () => {
  const r = baseCodeRecord();
  r.identity.path = "src/OTHER.mjs"; // change identity without recomputing recordId
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("IDENTITY_MISMATCH:recordId")));
});

test("10. NOT_APPLICABLE only allowed in legal fields", () => {
  // legal: identity.symbol for CODE
  const okRec = baseCodeRecord({ identity: { ...baseCodeRecord().identity, symbol: NOT_APPLICABLE } });
  assert.equal(validateMemoryRecordV1(okRec, opts).valid, true);
  // illegal: trust = NOT_APPLICABLE
  const badRec = baseCodeRecord({ trust: NOT_APPLICABLE });
  const v = validateMemoryRecordV1(badRec, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("not_applicable_not_legal:trust")));
});

test("extra: EXECUTION always graphRun-bound; DECISION status/authority enums", () => {
  // graphRunId must not be NOT_APPLICABLE（execution memory is ALWAYS run-bound）
  const r = baseExecutionRecord({ identity: { ...baseExecutionRecord().identity, graphRunId: NOT_APPLICABLE } });
  const v = validateMemoryRecordV1(r, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("execution_requires_graphRunId")));
  const d = baseDecisionRecord({ subject: { ...baseDecisionRecord().subject, status: "maybe" } });
  const dv = validateMemoryRecordV1(d, opts);
  assert.equal(dv.valid, false);
  assert.ok(dv.errors.some((e) => e.includes("decision_status_invalid")));
});

test("extra: evidence path safety (missing file / symlink / escape)", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cbm2-ev-"));
  const evFile = join(dir, "ev.json");
  writeFileSync(evFile, "{}");
  const sha = (await import("node:crypto")).createHash("sha256").update("{}").digest("hex");
  try {
    const good = baseCodeRecord({ trust: "VERIFIED", evidence: { manifestDigest: hex64("d"), verifierResultIdentity: hex64("e"), items: [{ path: evFile, sha256: sha }] }, source: { source: "VERIFIER", identity: hex64("f") } });
    assert.equal(validateMemoryRecordV1(good, { authorizedDirs: [dir] }).valid, true, "evidence file in authorized dir valid");
    // escape
    const esc = baseCodeRecord({ evidence: { manifestDigest: hex64("d"), verifierResultIdentity: hex64("e"), items: [{ path: join(dir, "..", "escape.txt"), sha256: sha }] }, source: { source: "VERIFIER", identity: hex64("f") } });
    const ev = validateMemoryRecordV1(esc, { authorizedDirs: [dir] });
    assert.equal(ev.valid, false);
    assert.ok(ev.errors.some((e) => e.includes("PATH_NOT_ALLOWED")));
    // symlink
    const link = join(dir, "link.txt");
    symlinkSync(evFile, link);
    const sl = baseCodeRecord({ evidence: { manifestDigest: hex64("d"), verifierResultIdentity: hex64("e"), items: [{ path: link, sha256: sha }] }, source: { source: "VERIFIER", identity: hex64("f") } });
    const sv = validateMemoryRecordV1(sl, { authorizedDirs: [dir] });
    assert.equal(sv.valid, false);
    assert.ok(sv.errors.some((e) => e.includes("PATH_NOT_ALLOWED") && e.includes("symlink")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extra: metadata / lifecycle changes do NOT change recordId", () => {
  const a = baseCodeRecord();
  const b = baseCodeRecord({ metadata: { note: "changed" } });
  assert.equal(a.recordId, b.recordId, "non-identity fields never affect recordId");
  const c = baseCodeRecord({ timestamps: { createdAt: "2026-08-08T00:00:00.000Z", updatedAt: "2026-08-08T00:00:00.000Z" } });
  assert.equal(a.recordId, c.recordId);
  const d = baseCodeRecord({ scope: { repository: hex64("a"), tree: hex40("X") } });
  assert.notEqual(a.recordId, d.recordId, "identity-relevant scope change changes recordId");
});

// ── R2 PATTERN record-type extension (AUTOLOOP-V1-STAGE-F-R2-IMPLEMENTATION-1;
//    additive cases only — existing expectations above byte-untouched) ─────

import { MEMORY_RECORD_SCHEMA, deriveContentHash, deriveMemoryRecordId, RECORD_TYPES, PATTERN_BOUNDARY_OPERATORS, PATTERN_MECHANISM_SIGNATURE_FIELDS, PATTERN_APPLICABILITY_DECISIONS, NOT_APPLICABLE as NA2 } from "../../src/memory/index.mjs";

const PATTERN_CONTENT = () => ({
  kind: "STRUCTURED",
  data: {
    mechanismDigest: hex64("1"),
    applicabilityDigest: hex64("2"),
    constituentIncidentSetDigest: hex64("3"),
    constituentIncidentRecordIds: [hex64("4")],
    qualificationRecordId: hex64("5"),
    publicationGeneration: 1,
    counterexamples: NA2,
    applicability: {
      appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
      doesNotApplyWhen: [{ field: "identity.patternId", op: "SYMBOL_EQUALS", value: "pat-excluded" }],
      mechanismSignature: { errorClass: "livelock", tool: "retry-loop" },
    },
  },
});

function basePatternRecord(overrides = {}) {
  const rec = {
    schema: MEMORY_RECORD_SCHEMA,
    recordType: "PATTERN",
    identity: { patternId: "pat-1", repositoryIdentity: hex64("6") },
    subject: { statement: "PATTERN: retry loop without backoff livelocks", contentHash: null, language: NA2 },
    content: PATTERN_CONTENT(),
    source: { source: "EXECUTION", identity: hex64("7") },
    scope: { repository: hex64("6") },
    trust: "UNVERIFIED",
    validity: { status: "CURRENT", validityTree: NA2 },
    lifecycle: { events: [] },
    timestamps: { createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z" },
    evidence: { manifestDigest: hex64("8"), items: [] },
    security: { scanResult: "clean", ingestionSource: "test-fixture" },
    metadata: {},
  };
  const merged = { ...rec, ...overrides };
  merged.subject.contentHash = deriveContentHash(merged.content);
  merged.recordId = deriveMemoryRecordId(merged);
  return merged;
}

test("R2-1. valid PATTERN record accepted (full required-field set)", () => {
  const v = validateMemoryRecordV1(basePatternRecord(), opts);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(v.derivedIdentity.recordId, basePatternRecord().recordId);
});

test("R2-2. RECORD_TYPES contains PATTERN after CODE/EXECUTION/DECISION (additive order)", () => {
  assert.deepEqual([...RECORD_TYPES], ["CODE", "EXECUTION", "DECISION", "PATTERN"]);
  assert.ok(PATTERN_BOUNDARY_OPERATORS.includes("PATH_PREFIX"));
  assert.ok(PATTERN_MECHANISM_SIGNATURE_FIELDS.includes("errorClass"));
  assert.ok(PATTERN_APPLICABILITY_DECISIONS.includes("APPLIES"));
});

test("R2-3. DECISION/EXECUTION stuffing rejected — incident re-typed as PATTERN keeps SCHEMA_INVALID class", () => {
  // an EXECUTION-shaped record claiming recordType PATTERN lacks patternId
  const stuffed = baseExecutionRecord({ recordType: "PATTERN" });
  const v = validateMemoryRecordV1(stuffed, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("recordType_invalid") || e.includes("missing_required") || e.includes("pattern_")));
});

test("R2-4. missing required PATTERN fields rejected (mechanism / qualification / generation / lineage)", () => {
  for (const drop of ["mechanismDigest", "qualificationRecordId", "publicationGeneration", "constituentIncidentRecordIds"]) {
    const rec = basePatternRecord();
    delete rec.content.data[drop];
    rec.subject.contentHash = deriveContentHash(rec.content);
    rec.recordId = deriveMemoryRecordId(rec);
    const v = validateMemoryRecordV1(rec, opts);
    assert.equal(v.valid, false, `${drop} must be required`);
    assert.ok(v.errors.some((e) => e.includes("SCHEMA_INVALID")), drop);
  }
});

test("R2-5. vacuous boundary rejected with boundary_vacuous fine code", () => {
  const emptyApplies = basePatternRecord();
  emptyApplies.content.data.applicability.appliesWhen = [];
  emptyApplies.subject.contentHash = deriveContentHash(emptyApplies.content);
  emptyApplies.recordId = deriveMemoryRecordId(emptyApplies);
  const v1 = validateMemoryRecordV1(emptyApplies, opts);
  assert.equal(v1.valid, false);
  assert.ok(v1.errors.some((e) => e.includes("boundary_vacuous")));
  const missingBoundary = basePatternRecord();
  delete missingBoundary.content.data.applicability;
  missingBoundary.subject.contentHash = deriveContentHash(missingBoundary.content);
  missingBoundary.recordId = deriveMemoryRecordId(missingBoundary);
  const v2 = validateMemoryRecordV1(missingBoundary, opts);
  assert.equal(v2.valid, false);
  assert.ok(v2.errors.some((e) => e.includes("boundary_vacuous")));
});

test("R2-6. boundary must be machine-testable (structured ops only — never lexical-similarity)", () => {
  const rec = basePatternRecord();
  rec.content.data.applicability.appliesWhen = [{ field: "x", op: "LEXICAL_SIMILAR", value: "y" }];
  rec.subject.contentHash = deriveContentHash(rec.content);
  rec.recordId = deriveMemoryRecordId(rec);
  const v = validateMemoryRecordV1(rec, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("boundary_op_invalid")));
});

test("R2-7. incident-layer raw fields forbidden on PATTERN (two-layer separation)", () => {
  for (const rawField of ["stdout", "stderr", "rawIncidentPayload", "filesChanged"]) {
    const rec = basePatternRecord();
    rec.content.data[rawField] = "raw incident data";
    rec.subject.contentHash = deriveContentHash(rec.content);
    rec.recordId = deriveMemoryRecordId(rec);
    const v = validateMemoryRecordV1(rec, opts);
    assert.equal(v.valid, false, `${rawField} must be forbidden`);
    assert.ok(v.errors.some((e) => e.includes("pattern_forbidden_incident_layer_field")), rawField);
  }
});

test("R2-8. unknown envelope / unknown boundary fields still rejected (fail-closed unchanged)", () => {
  const rec = basePatternRecord({ _control: "no" });
  assert.equal(validateMemoryRecordV1(rec, opts).valid, false);
  const bad = basePatternRecord();
  bad.content.data.applicability = { ...bad.content.data.applicability, unknownKey: 1 };
  bad.subject.contentHash = deriveContentHash(bad.content);
  bad.recordId = deriveMemoryRecordId(bad);
  const vb = validateMemoryRecordV1(bad, opts);
  assert.equal(vb.valid, false);
  assert.ok(vb.errors.some((e) => e.includes("pattern_boundary_unknown_field")));
});

test("R2-9. PATTERN identity determinism (same content ⇒ same recordId; tampered identity ⇒ mismatch)", () => {
  const a = basePatternRecord();
  const b = basePatternRecord();
  assert.equal(a.recordId, b.recordId);
  const t = basePatternRecord();
  t.recordId = "0".repeat(64);
  const v = validateMemoryRecordV1(t, opts);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("IDENTITY_MISMATCH:recordId")));
});

test("R2-10. legacy types unchanged (CODE/EXECUTION/DECISION still validate)", () => {
  assert.equal(validateMemoryRecordV1(baseCodeRecord(), opts).valid, true);
  assert.equal(validateMemoryRecordV1(baseExecutionRecord(), opts).valid, true);
  assert.equal(validateMemoryRecordV1(baseDecisionRecord(), opts).valid, true);
});
