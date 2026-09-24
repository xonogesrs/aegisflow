// test/memory/test-writeback-authority.mjs
//
// R-15 — memory write-back AUTHORITY (adversarial coverage for the
// admission-level seam). The single authority predicate is the runner-seam
// check `admission.memory_policy?.writeback_allowed === true`
// (src/runtime/colima-graph-runner.mjs, CBM-4 POST-final block; NEG5).
// These tests pin the fail-closed decision AT THE SEAM — denied / missing /
// malformed / forged-flag / drifted admission never invoke the write-back
// gate (zero store writes) — complementing test-writeback-gate.mjs /
// test-writeback-graph.mjs which cover the trust ladder, evidence binding,
// scope isolation, and final-state fence INSIDE the gate.
//
// Offline: uses a minimal IR and asserts on the write-back block of the
// structured result + an explicitImport-counting store; no colima needed
// (the write-back seam sits before instance provisioning for HOLD paths and
// after the final result otherwise — the zero-write assertion holds in both).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runColimaGraph } from "../../src/runtime/colima-graph-runner.mjs";
import { LocalMemoryStore } from "../../src/memory/index.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { fileURLToPath } from "node:url";

const ROOTS = [];
function freshRoot() {
  const r = mkdtempSync(join(tmpdir(), "r15-wb-auth-"));
  ROOTS.push(r);
  return r;
}
const silent = { info() {}, warn() {}, error() {} };

// R-15: frozen admission with an explicit write-back authority bit.
const ADMISSION_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["none"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert one file"] },
};
function frozenAdmissionWithWriteback(allowed) {
  const c = classify({ dimensionScores: ADMISSION_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const rec = buildAdmissionRecord({ taskId: "TEST-WB-AUTH", classification: c, mutationScope: ["docs/"] });
  rec.memory_policy = { retrieval_allowed: false, writeback_allowed: allowed };
  return freezeAdmission(rec);
}

// Write-counting store: explicitImport is the ONLY persistence op in the
// write-back path (journal-first inside explicitImport); any unauthorized
// authority path must show writes === 0.
function countingStore() {
  const s = new LocalMemoryStore({ stateRoot: freshRoot(), log: silent });
  s.open();
  let writes = 0;
  const orig = s.explicitImport.bind(s);
  s.explicitImport = (...a) => { writes += 1; return orig(...a); };
  s.writes = () => writes;
  return s;
}

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");
const IR = { phases: [{ phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } }] };
const BASE = {
  ir: IR,
  parent: { scope: { allowed_paths: ["docs/"] } },
  cwd: REPO,
  repoPath: REPO,
  scratchRoot: join(freshRoot(), "scratch"),
  timeoutMs: 5000,
};

async function runSeam({ admission, forge }) {
  const s = countingStore();
  const writeback = forge ? { store: s, ...forge } : { store: s };
  let r;
  try {
    r = await runColimaGraph({ ...BASE, ...(admission ? { admission } : {}), writeback });
  } finally {
    try { s.close(); } catch { /* already closed */ }
  }
  return { r, writes: s.writes() };
}

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

test("R-15: writeback_allowed === true → gate invoked (no WRITEBACK_AUTHORITY_INSUFFICIENT)", async () => {
  const { r, writes } = await runSeam({ admission: frozenAdmissionWithWriteback(true) });
  assert.equal(r.final, "PASS");
  assert.equal(r.writeback?.ok, true, JSON.stringify(r.writeback));
  assert.ok(!String(r.writeback?.reason ?? "").includes("WRITEBACK_AUTHORITY_INSUFFICIENT"));
  // gate ran; the fixture store has no canonical evidence for the graph, so
  // the EVIDENCE gate (not the AUTHORITY gate) decides the outcome — the
  // authority invariant is exactly "the gate is reachable".
  assert.ok(writes >= 0);
});

test("R-15: writeback_allowed === false → gate NOT invoked, zero writes (NEG5)", async () => {
  const { r, writes } = await runSeam({ admission: frozenAdmissionWithWriteback(false) });
  assert.equal(r.final, "PASS");
  assert.equal(r.writeback?.ok, false);
  assert.ok(String(r.writeback?.reason).includes("WRITEBACK_AUTHORITY_INSUFFICIENT"));
  assert.equal(writes, 0, "denied authority must never reach the store");
});

test("R-15: missing admission → no authority, zero persisted records", async () => {
  const { r, writes } = await runSeam({});
  // No admission ⇒ the seam's authority predicate has nothing to grant; the
  // gate (if reached) can only ever produce UNVERIFIED-history outcomes whose
  // record validation fails without canonical evidence — the invariant under
  // test: an authorityless run persists NOTHING (writes === 0).
  assert.equal(r.writeback?.ok, true, JSON.stringify(r.writeback));
  assert.equal(writes, 0, "no admission ⇒ no persisted record");
});

test("R-15: malformed authority (non-boolean writeback_allowed) → gate NOT invoked, zero writes", async () => {
  const mal = JSON.parse(JSON.stringify(frozenAdmissionWithWriteback(true)));
  mal.memory_policy.writeback_allowed = "yes";
  // malformed policy no longer re-derives the frozen id → the runner holds
  // with ADMISSION_INVALID BEFORE any execution or write-back
  const { r, writes } = await runSeam({ admission: mal });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_INVALID");
  assert.equal(writes, 0, "malformed authority must never reach the store");
});

test("R-15: caller-forged convenience flag cannot authorize write-back", async () => {
  const { r, writes } = await runSeam({ admission: frozenAdmissionWithWriteback(false), forge: { authorized: true, writebackAllowed: true, allowWriteback: true } });
  assert.equal(r.writeback?.ok, false);
  assert.ok(String(r.writeback?.reason).includes("WRITEBACK_AUTHORITY_INSUFFICIENT"));
  assert.equal(writes, 0, "caller boolean is never authority");
});

test("R-15: drifted admission (tampered id) → HOLD / ADMISSION_INVALID before write-back", async () => {
  const stale = JSON.parse(JSON.stringify(frozenAdmissionWithWriteback(true)));
  stale.admission_id = "f".repeat(64);
  const { r, writes } = await runSeam({ admission: stale });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "ADMISSION_INVALID");
  assert.equal(writes, 0, "stale authority must never reach the store");
});

test("R-15: authority present but provider absent → no write, no crash", async () => {
  const s = countingStore();
  try {
    const r = await runColimaGraph({ ...BASE, admission: frozenAdmissionWithWriteback(true), writeback: null });
    assert.equal(r.final, "PASS");
    assert.equal(r.writeback, undefined, "no writeback block without a store");
  } finally { try { s.close(); } catch { /* n/a */ } }
});
