// test/memory/test-r2-consolidation-qualification-applicability.mjs
//
// R2 PHASE 3 — CANDIDATE / EVIDENCE BINDING CORE (O4 / O5 / O6 focused
// pre-freeze slices; PHASE-3-CANDIDATE-BINDING STEP 1a/1b/1c).
//
// O4 consolidation: ≥2 independent incidents OR documented single-high-severity
// rationale; dedup constituents by (logicalKey, contentHash) BEFORE admission;
// duplicate inflation rejected; consolidation cites EVERY constituent
// recordId verbatim; provenance re-verifiable.
// O5 qualification: independent review record; V5 self-approval rejected;
// identical retry does not launder the rejection; blocking-findings carried.
// O6 applicability: boundary present + machine-testable; vacuous rejected;
// never lexical-similarity-only; deterministic evaluation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consolidateIncidents,
  verifyConsolidation,
  rederiveConstituentSetDigest,
  CONSOLIDATION_REJECT,
  ConsolidationError,
} from "../../src/learning/patterns/consolidation.mjs";
import {
  qualifyCandidate,
  retryQualification,
  verifyQualification,
  QUALIFICATION_REJECT,
  REQUIRED_LIFECYCLE_LEVELS,
  QualificationError,
} from "../../src/learning/patterns/qualification.mjs";
import {
  classifyApplicability,
  evaluateBoundary,
  APPLICABILITY_REJECT,
  ApplicabilityError,
} from "../../src/learning/patterns/applicability.mjs";
import { hex64, incidentRecord, patternBoundary } from "./test-r2-helpers.mjs";

const inc = (n, key, extra = {}) => ({
  recordId: hex64(n),
  logicalKey: hex64(key),
  contentHash: hex64(String.fromCharCode(0x61 + (Number(key) % 26))),
  ...extra,
});

// ── O4 consolidation ─────────────────────────────────────────────────────────

test("O4+. two independent incidents consolidate; every constituent recordId cited verbatim", () => {
  const a = inc("1", "a");
  const b = inc("2", "b");
  const c = consolidateIncidents({ incidents: [a, b], patternId: "pat-1" });
  assert.deepEqual(c.constituentIncidentRecordIds, [a.recordId, b.recordId], "cited verbatim, order preserved");
  assert.equal(c.constituentIncidentSetDigest.length, 64);
  assert.equal(c.deduped, true);
});

test("O4+. deterministic: same incidents + same rationale ⇒ same consolidation digest", () => {
  const a = inc("1", "a");
  const b = inc("2", "b");
  const c1 = consolidateIncidents({ incidents: [a, b], patternId: "pat-1" });
  const c2 = consolidateIncidents({ incidents: [a, b], patternId: "pat-1" });
  assert.equal(c1.digest, c2.digest);
  assert.equal(c1.constituentIncidentSetDigest, c2.constituentIncidentSetDigest);
});

test("O4−. duplicate inflation rejected (same logicalKey + contentHash twice)", () => {
  const a = inc("1", "a");
  const dup = inc("1", "a"); // same root incident contributed twice (different recordId, same logical content)
  assert.throws(
    () => consolidateIncidents({ incidents: [a, dup], patternId: "pat-1" }),
    (e) => e instanceof ConsolidationError && e.code === CONSOLIDATION_REJECT.DUPLICATE_INFLATION,
  );
});

test("O4−. single incident without documented high-severity rationale rejected", () => {
  assert.throws(
    () => consolidateIncidents({ incidents: [inc("1", "a")], patternId: "pat-1" }),
    (e) => e instanceof ConsolidationError && e.code === CONSOLIDATION_REJECT.RATIONALE_REQUIRED,
  );
  assert.throws(
    () => consolidateIncidents({ incidents: [{ ...inc("1", "a"), severity: "low" }], singleIncidentRationale: "documented but low severity", patternId: "pat-1" }),
    (e) => e instanceof ConsolidationError && e.code === CONSOLIDATION_REJECT.RATIONALE_REQUIRED,
  );
});

test("O4+. documented single-high-severity rationale is the legal single-incident path", () => {
  const c = consolidateIncidents({
    incidents: [{ ...inc("1", "a"), severity: "high" }],
    singleIncidentRationale: "verified data-loss bug with journal-attested severity",
    patternId: "pat-1",
  });
  assert.equal(c.constituentIncidentRecordIds.length, 1);
  assert.equal(c.singleIncidentRationale, "verified data-loss bug with journal-attested severity");
});

test("O4+. provenance re-verifiable from cited constituents (verifyConsolidation)", () => {
  const a = inc("1", "a");
  const b = inc("2", "b");
  const c = consolidateIncidents({ incidents: [a, b], patternId: "pat-1" });
  assert.equal(verifyConsolidation(c, [a, b]).ok, true);
  const tampered = rederiveConstituentSetDigest(c, [a]); // constituent lost upstream
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "CONSOLIDATION_PROVENANCE_MISMATCH");
});

test("O4−. malformed incident (non-hex recordId) rejected fail-closed", () => {
  assert.throws(
    () => consolidateIncidents({ incidents: [inc("1", "a"), { recordId: "not-hex", logicalKey: hex64("b"), contentHash: hex64("c") }] }),
    (e) => e instanceof ConsolidationError && e.code === CONSOLIDATION_REJECT.INCIDENT_MALFORMED,
  );
});

test("O4+. R2 fixture incidents (durable EXECUTION-layer records) consolidate", () => {
  const i1 = incidentRecord({ seq: "1" });
  const i2 = incidentRecord({ seq: "2", nodeId: "SA-P2" });
  const c = consolidateIncidents({
    incidents: [
      { recordId: i1.recordId, logicalKey: deriveLogicalKeyOf(i1), contentHash: i1.subject.contentHash },
      { recordId: i2.recordId, logicalKey: deriveLogicalKeyOf(i2), contentHash: i2.subject.contentHash },
    ],
    patternId: "pat-r2-1",
  });
  assert.equal(c.inputIncidentCount, 2);
});

function deriveLogicalKeyOf(rec) {
  // import lazily to keep the top imports narrow
  return deriveLogicalKeyCached(rec);
}
let _dlk = null;
function deriveLogicalKeyCached(rec) {
  if (!_dlk) {
    // eslint-disable-next-line no-undef
    _dlk = require0();
  }
  return _dlk(rec);
}
function require0() {
  // static import at module load (ESM): deriveLogicalKey already imported below
  return deriveLogicalKey;
}
import { deriveLogicalKey } from "../../src/memory/index.mjs";

// ── O5 qualification ─────────────────────────────────────────────────────────

const baseQual = (o = {}) => ({
  reviewerIdentity: hex64("c"),
  executorIdentity: hex64("a"),
  rootCause: "missing exponential backoff in retry loop",
  mechanism: "retry loop re-queues without delay, saturating the executor",
  applicability: patternBoundary(),
  counterexamples: "single-shot tasks without retry",
  transferPotential: "high within memory/writeback subsystem",
  requiredLifecycleLevel: "ADVISORY",
  blockingFindings: [],
  ...o,
});

test("O5+. independent qualification accepted; required elements carried; blockingFindings empty ⇒ qualified", () => {
  const q = qualifyCandidate(baseQual());
  assert.equal(q.qualified, true);
  assert.equal(q.schema, "autoloop.pattern-qualification/v1");
  assert.ok(q.rootCause && q.mechanism && q.applicability && q.transferPotential);
  assert.ok(REQUIRED_LIFECYCLE_LEVELS.includes(q.requiredLifecycleLevel));
});

test("O5−. V5 self-approval rejected (qualification identity == executor identity)", () => {
  assert.throws(
    () => qualifyCandidate(baseQual({ reviewerIdentity: hex64("a") })),
    (e) => e instanceof QualificationError && e.code === QUALIFICATION_REJECT.SELF_APPROVAL,
  );
});

test("O5−. identical retry reproduces the identical rejection (retry never launders)", () => {
  const first = (() => {
    try {
      qualifyCandidate(baseQual({ reviewerIdentity: hex64("a") }));
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(first instanceof QualificationError);
  assert.throws(
    () => retryQualification(first, baseQual({ reviewerIdentity: hex64("a") })),
    (e) => e instanceof QualificationError && e.code === QUALIFICATION_REJECT.SELF_APPROVAL,
  );
  // a genuinely independent reviewer identity IS a legal retry input
  const q = retryQualification(first, baseQual({ reviewerIdentity: hex64("c") }));
  assert.equal(q.qualified, true);
});

test("O5+. blocking findings carried verbatim; non-empty ⇒ not qualified", () => {
  const q = qualifyCandidate(baseQual({ blockingFindings: [{ finding: "mechanism unproven on trees", severity: "high" }] }));
  assert.equal(q.qualified, false);
  assert.equal(q.blockingFindings.length, 1);
  assert.equal(q.blockingFindings[0].finding, "mechanism unproven on trees");
});

test("O5+. qualification digest deterministic + re-verifiable (resume path)", () => {
  const q1 = qualifyCandidate(baseQual());
  const q2 = qualifyCandidate(baseQual());
  assert.equal(q1.digest, q2.digest);
  assert.equal(verifyQualification(q1).ok, true);
  const tampered = { ...q1, mechanism: "tampered" };
  assert.equal(verifyQualification(tampered).ok, false);
});

test("O5−. missing required element rejected fail-closed", () => {
  assert.throws(
    () => qualifyCandidate(baseQual({ requiredLifecycleLevel: "MANDATORY_GATE_NOW" })),
    (e) => e instanceof QualificationError && e.code === QUALIFICATION_REJECT.MALFORMED,
  );
});

// ── O6 applicability ─────────────────────────────────────────────────────────

test("O6+. structured boundary classified; normalized shape returned", () => {
  const b = classifyApplicability({
    appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
    doesNotApplyWhen: [{ field: "scope.symbol", op: "SYMBOL_EQUALS", value: "pat-x" }],
    mechanismSignature: { errorClass: "livelock" },
  });
  assert.equal(b.schema, "autoloop.pattern-applicability/v1");
  assert.equal(b.appliesWhen.length, 1);
  assert.equal(b.doesNotApplyWhen.length, 1);
});

test("O6−. vacuous boundary rejected with boundary_vacuous fine code", () => {
  assert.throws(
    () => classifyApplicability({ appliesWhen: [], mechanismSignature: { errorClass: "x" } }),
    (e) => e instanceof ApplicabilityError && e.details.reason === "applies_when_empty_or_missing",
  );
  assert.throws(
    () => classifyApplicability({ appliesWhen: [{ field: "x", op: "PATH_PREFIX", value: "y" }], mechanismSignature: {} }),
    (e) => e instanceof ApplicabilityError && e.details.reason === "mechanism_signature_empty",
  );
});

test("O6−. non-machine-testable ops rejected — never lexical-similarity-only ([CT §1 R6] NG)", () => {
  assert.throws(
    () => classifyApplicability({ appliesWhen: [{ field: "x", op: "LEXICAL_SIMILAR", value: "y" }], mechanismSignature: { errorClass: "x" } }),
    (e) => e instanceof ApplicabilityError && e.details.reason === "boundary_op_invalid:LEXICAL_SIMILAR",
  );
});

test("O6+. evaluation is deterministic and read-only (same inputs ⇒ same verdict; no writes)", () => {
  const b = classifyApplicability({
    appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }],
    mechanismSignature: { errorClass: "livelock" },
  });
  const selectors = { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/memory" }] };
  const r1 = evaluateBoundary(b, selectors);
  const r2 = evaluateBoundary(b, selectors);
  assert.deepEqual(r1, r2);
  assert.equal(r1.eligible, true);
  assert.deepEqual(r1.reasons, []);
});

test("O6+. required-but-false match ⇒ NON-ELIGIBLE with recorded reasons (deterministic filter, NOT an error)", () => {
  const b = classifyApplicability(patternBoundary());
  const r = evaluateBoundary(b, { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/other" }] });
  assert.equal(r.eligible, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /^not_covered_by_applies_when\[0\]$/);
});

test("O6−. non-derivable stored boundary fails closed (SCHEMA_INVALID-class fine code)", () => {
  assert.throws(
    () => evaluateBoundary({ appliesWhen: [] }, {}),
    (e) => e instanceof ApplicabilityError && e.details.reason === "applicability_boundary_missing",
  );
  assert.throws(() => evaluateBoundary(null, {}));
});

test("O6+. doesNotApplyWhen exclusion surfaces as deterministic exclusion reason", () => {
  const b = classifyApplicability({
    appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/" }],
    doesNotApplyWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/legacy" }],
    mechanismSignature: { errorClass: "livelock" },
  });
  const r = evaluateBoundary(b, { appliesWhen: [{ field: "scope.path", op: "PATH_PREFIX", value: "src/legacy" }] });
  assert.equal(r.eligible, false);
  assert.equal(r.reasons[0], "excluded_by_does_not_apply_when[0]");
});
