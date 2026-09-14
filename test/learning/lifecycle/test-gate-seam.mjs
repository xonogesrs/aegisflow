// test/learning/lifecycle/test-gate-seam.mjs
//
// RUNG-6 Step 4 suite — the ONE additive gate delegation: lifecycle kinds
// arriving as writeback intents at the PATTERN-branch seam consult N1 AFTER
// ladder/ceiling + evidence checks, BEFORE the journal append; non-ok
// verdicts short-circuit with the exact code; existing kinds byte-identical
// (neighbor suites stay green); no second decision table in the gate.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWritebackGate } from "../../../src/memory/writeback/gate.mjs";
import { createWritebackCandidate } from "../../../src/memory/writeback/candidate.mjs";
import { LocalMemoryStore } from "../../../src/memory/index.mjs";
import { hex64 } from "./helpers.mjs";
import { patternContent } from "../../memory/test-r2-helpers.mjs";

const ROOTS = [];
function freshRoot() { const r = mkdtempSync(join(tmpdir(), "lc-gate-")); ROOTS.push(r); return r; }
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

const silent = { info() {}, warn() {}, error() {} };
const REPO = "1".repeat(64);
const VERIFIER_ID = "b".repeat(64);
const RUN = "graph-lc-seam-1";
const CARD = "LC-SEAM-1";
const RESULT_ID = `node:${RUN}:${CARD}:result`;
// canonical evidence inventory the verifier identity is bound to
const CANONICAL_EVIDENCE = () => ({
  graphRunId: RUN,
  taskCardIds: [CARD],
  resultIdentities: [RESULT_ID, VERIFIER_ID],
});

function openStore() {
  const s = new LocalMemoryStore({ stateRoot: freshRoot(), log: silent });
  s.open();
  return s;
}

/** A PATTERN candidate carrying a lifecycle event kind at the seam. */
function lifecycleCandidate(o = {}) {
  const c = createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: CARD,
    originatingNode: "LC-NODE",
    sourceResultIdentity: RESULT_ID,
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: o.patternId ?? "pat-lifecycle-1", repositoryIdentity: REPO },
    proposedSubjectStatement: "PATTERN: lifecycle seam probe",
    proposedContent: patternContent(),
    proposedScope: { repository: REPO },
    evidenceReferences: [`manifest:${hex64(9)}`, `verifier:${VERIFIER_ID}`],
    proposedTrust: "VERIFIED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "independent_reviewer",
  });
  // The seam's frozen trigger: provenance.lifecycle != null on a PATTERN
  // CREATE. The candidate field allowlist is untouched (unknown top-level
  // fields fail closed); intent metadata rides the existing provenance object.
  c.provenance.lifecycle = {
    kind: o.kind ?? "PROMOTE",
    to: o.to ?? null,
    generation: o.generation ?? null,
    elements: o.elements ?? {},
  };
  return c;
}

const FULL_ELEMENTS = () => ({
  E1: { incidents: [hex64(11)] },
  E2: { identity: hex64(12), independent: true },
  E3: { boundary: "PATH_PREFIX:/src" },
  E4: { analysis: "fp measured" },
  E5: { benefit: "transfer measured" },
  E6: { path: "rollback" },
  E7: true,
});

test("GS-1. lifecycle kind with full elements consults N1: empty journal = CANDIDATE with no durable generation ⇒ WRONG_GENERATION", async () => {
  const s = openStore();
  const c = lifecycleCandidate({ kind: "PROMOTE", to: "ADVISORY", generation: 1, elements: FULL_ELEMENTS() });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  // Empty lifecycle journal → state CANDIDATE, generation null → F5 generation
  // binding fails closed unless the intent generation binds the durable one.
  assert.equal(r.status, "WRITEBACK_REJECTED", JSON.stringify(r));
  assert.match(r.reason, /^WRONG_GENERATION:GENERATION_MISMATCH/);
});

test("GS-1b. seam maps the N1 verdict status onto the gate outcome shape", async () => {
  const s = openStore();
  const c = lifecycleCandidate({ kind: "PROMOTE", to: "ADVISORY", generation: 1, elements: FULL_ELEMENTS() });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  assert.equal(r.status, "WRITEBACK_REJECTED");
  // The consulted code survives verbatim (no reclassification at the seam).
  const [code] = r.reason.split(":");
  assert.equal(code, "WRONG_GENERATION");
});

test("GS-2. unregistered lifecycle kind short-circuits REJECT (never defaulted)", async () => {
  const s = openStore();
  const c = lifecycleCandidate({ kind: "REACTIVATE", to: "ADVISORY", generation: 1, elements: FULL_ELEMENTS() });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  assert.equal(r.status, "WRITEBACK_REJECTED");
  assert.match(r.reason, /^LIFECYCLE_TRANSITION_ILLEGAL:UNREGISTERED_EVENT_KIND/);
});

test("GS-3. illegal transition through the seam short-circuits with the exact I-row code (I2 skip-level)", async () => {
  const s = openStore();
  const c = lifecycleCandidate({ kind: "PROMOTE", to: "MANDATORY_GATE", generation: 1, elements: FULL_ELEMENTS() });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  // CANDIDATE (empty journal) PROMOTE-to-MG: F5 fires first (generation null)
  // — the exact fail-closed fence for the seam path.
  assert.equal(r.status, "WRITEBACK_REJECTED");
  assert.match(r.reason, /^WRONG_GENERATION:GENERATION_MISMATCH/);
});

test("GS-4. missing element at the seam: exact element-class code short-circuits (I9)", async () => {
  const s = openStore();
  const el = FULL_ELEMENTS(); delete el.E4;
  const c = lifecycleCandidate({ kind: "PROMOTE", to: "ADVISORY", generation: 1, elements: el });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  assert.equal(r.status, "WRITEBACK_REJECTED");
  // F5 precedes F7: the generation fence fires first for an empty journal
  assert.match(r.reason, /^WRONG_GENERATION:GENERATION_MISMATCH/);
});

test("GS-5. existing kinds byte-identical: plain PATTERN CREATE (no lifecycle kind) writes through unchanged", async () => {
  const s = openStore();
  const c = createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: CARD,
    originatingNode: "LC-NODE",
    sourceResultIdentity: RESULT_ID,
    proposedRecordType: "PATTERN",
    proposedIdentity: { patternId: "pat-plain-1", repositoryIdentity: REPO },
    proposedSubjectStatement: "PATTERN: plain R2 create",
    proposedContent: patternContent(),
    proposedScope: { repository: REPO },
    evidenceReferences: [`manifest:${hex64(9)}`, `verifier:${VERIFIER_ID}`],
    proposedTrust: "VERIFIED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "independent_reviewer",
  });
  const r = await runWritebackGate({ candidate: c, store: s, verifierIdentity: VERIFIER_ID, canonicalEvidence: CANONICAL_EVIDENCE() });
  assert.equal(r.status, "WRITEBACK_ACCEPTED", JSON.stringify(r));
  assert.match(r.recordId, /^[0-9a-f]{64}$/);
  const got = s.get(r.recordId);
  assert.equal(got.recordType, "PATTERN");
});

test("GS-6. EXECUTION candidate with a lifecycle kind field does NOT trigger the seam (PATTERN-branch only)", async () => {
  const s = openStore();
  const c = createWritebackCandidate({
    graphRunId: RUN,
    taskCardId: CARD,
    originatingNode: "LC-NODE",
    sourceResultIdentity: RESULT_ID,
    proposedRecordType: "EXECUTION",
    proposedIdentity: { repositoryIdentity: REPO, resultStatus: "PASS" },
    proposedSubjectStatement: "plain execution record",
    proposedScope: { repository: REPO },
    evidenceReferences: [`manifest:${hex64(9)}`],
    proposedTrust: "UNVERIFIED",
    proposedRelationships: [],
    lifecycleIntent: "CREATE",
    origin: "graph_closeout",
  });
  c.provenance.lifecycle = { kind: "PROMOTE", to: null, generation: null, elements: {} }; // non-PATTERN: seam must not consult N1
  const r = await runWritebackGate({ candidate: c, store: s, canonicalEvidence: CANONICAL_EVIDENCE() });
  assert.equal(r.status, "WRITEBACK_ACCEPTED", JSON.stringify(r));
});

test("GS-7. the seam adds no second decision table: legality lives only in state-machine.mjs", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync("src/memory/writeback/gate.mjs", "utf8");
  // No transition table in the gate: no T-row/I-row structures, no state enum.
  assert.equal(/LEGAL_TRANSITIONS\s*=/.test(src), false);
  assert.equal(/ILLEGAL_TRANSITIONS\s*=/.test(src), false);
  assert.equal(/CANDIDATE.*ADVISORY.*REQUIRED_QUESTION.*MANDATORY_GATE/.test(src.split("consultLifecycleSeam")[0]), false);
  // The seam delegates by import of N1 only.
  assert.match(src, /authorizeLifecycleEvent/);
  assert.match(src, /state-machine\.mjs/);
});
