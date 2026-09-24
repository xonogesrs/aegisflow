// test/governance/test-truth-revocation.mjs
//
// AUTOLOOP POST-P4 — TRUTH REVOCATION CASCADE: adversarial matrix + property
// table + durable ledger + PASS-oracle/gate integration.
//
// Coverage map（task-card TR-numbers）:
//   Pure core ........... TR1, TR3-TR10, TR13-TR16
//   Oracle integration .. TR2, TR15, TR17, TR18（race semantics）
//   Durable ledger ...... TR10-TR12, TR16（restart / reconcile / resurrection）
//   Gate integration .... GR1-GR3（runCloseoutGate revocation path）
//   Property table ...... P-TR（class × fencing × restart）
//
// Run: node --test test/governance/test-truth-revocation.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  REVOCATION_ISSUER_ROLES,
  REVOCABLE_TRUTH_CLASSES,
  computeCascade,
  fenceRevocationAgainstTruth,
  revocationFactsForOracle,
  validateRevocationEvent,
} from "../../src/governance/truth-revocation.mjs";
import {
  appendRevocation,
  readRevocationLedger,
  revocationLedgerPath,
} from "../../src/governance/truth-revocation-store.mjs";
import {
  ORACLE_REJECTIONS,
  evaluatePassOracle,
  normalizeSuccessContract,
  validateOracleEvidence,
} from "../../src/governance/pass-oracle.mjs";

const NOW = "2026-08-22T00:00:00.000Z";
const HEAD = "c".repeat(40);
const TREE = "d".repeat(64);
const ART = "e".repeat(64);

const issuer = (over = {}) => ({ identity: "governance-operator", role: "operator", ...over });
const rev = (over = {}) => validateRevocationEvent({
  schema: "autoloop.truth-revocation/v1",
  revocationId: "rv-001",
  truthClass: "evidence",
  truthId: "ev-1",
  trigger: "verifier-retraction",
  reason: "verifier retracted the prior result",
  at: NOW,
  issuedBy: issuer(),
  ...over,
}).event;

// ── oracle evidence factory（mirrors P4 fixture discipline）──────────────

let seq = 0;
const ev = (over = {}) => ({
  schema: "autoloop.oracle-evidence/v1",
  evidenceId: `ev-${++seq}`,
  cardId: "TR-CARD",
  generation: 0,
  checkId: "suite-alpha",
  kind: "deterministic",
  producer: { identity: "ci-runner", role: "executor" },
  result: "PASS",
  at: NOW,
  command: "npm test",
  binding: { head: HEAD, treeSha: TREE, artifactSha256: null },
  ...over,
});
const contractFor = (requiredChecks = [], over = {}) =>
  normalizeSuccessContract({ requiredChecks, head: HEAD, treeSha: TREE, ...over });

// ── TR16/TR9: malformed + unauthorized revocations rejected ──────────────

test("TR16. malformed revocation events are rejected, never partially applied", () => {
  for (const bad of [
    null,
    {},
    { schema: "wrong" },
    rev({ schema: "autoloop.truth-revocation/v1", revocationId: "" }),
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "opinion", truthId: "y", trigger: "verifier-retraction", reason: "r", at: NOW, issuedBy: issuer() },
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "artifact", truthId: "not-a-sha", trigger: "verifier-retraction", reason: "r", at: NOW, issuedBy: issuer() },
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "evidence", truthId: "y", trigger: "hypothetical-trigger", reason: "r", at: NOW, issuedBy: issuer() },
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "evidence", truthId: "y", trigger: "verifier-retraction", reason: "", at: NOW, issuedBy: issuer() },
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "evidence", truthId: "y", trigger: "verifier-retraction", reason: "r", at: "not-a-ts", issuedBy: issuer() },
    { schema: "autoloop.truth-revocation/v1", revocationId: "x", truthClass: "evidence", truthId: "y", trigger: "verifier-retraction", reason: "r", at: NOW, issuedBy: null },
  ]) {
    const v = validateRevocationEvent(bad);
    assert.equal(v.ok, false, JSON.stringify(bad));
  }
});

test("TR9. unauthorized issuers (incl. executor) are rejected by validation", () => {
  assert.ok(!REVOCATION_ISSUER_ROLES.includes("executor"));
  const v = validateRevocationEvent({
    schema: "autoloop.truth-revocation/v1",
    revocationId: "rv-exec", truthClass: "evidence", truthId: "gate:independent-review",
    trigger: "verifier-retraction", reason: "executor tries to revoke independent proof",
    at: NOW, issuedBy: { identity: "implementing-agent", role: "executor" },
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith("issuer_role_unauthorized")));
});

test("TR7. wrong-generation revocation is fenced out against a known truth record", () => {
  const f = fenceRevocationAgainstTruth(rev({ generation: 1 }), { cardId: "TR-CARD", generation: 0 });
  assert.equal(f.ok, false);
  assert.equal(f.code, "WRONG_GENERATION_REVOCATION");
});

test("TR8. wrong-lineage revocation is fenced out against a known truth record", () => {
  // Strict fencing: a truth record that declares cardId WITHOUT generation
  // still fences on lineage; one declaring generation fences generation first
  //（a mismatched event can never hide behind an unset field）.
  const f = fenceRevocationAgainstTruth(rev({ cardId: "OTHER-CARD" }), { cardId: "TR-CARD" });
  assert.equal(f.ok, false);
  assert.equal(f.code, "WRONG_LINEAGE_REVOCATION");
});

test("TR8c. omitting cardId/generation does NOT dodge fencing (red-team regression)", () => {
  const genDodge = fenceRevocationAgainstTruth(rev({ generation: null }), { cardId: "TR-CARD", generation: 7 });
  assert.equal(genDodge.ok, false);
  const cardDodge = fenceRevocationAgainstTruth(rev({ cardId: null }), { cardId: "TR-CARD" });
  assert.equal(cardDodge.ok, false);
});

test("TR7b/TR8b. matching generation and lineage pass fencing; unknown truth defers to cascade-time checks", () => {
  assert.deepEqual(fenceRevocationAgainstTruth(rev({ cardId: "TR-CARD", generation: 0 }), { cardId: "TR-CARD", generation: 0 }), { ok: true });
  assert.deepEqual(fenceRevocationAgainstTruth(rev(), null), { ok: true });
});

// ── cascade determinism ──────────────────────────────────────────────────

test("TR1+TR5. valid unrelated truth remains valid when an unrelated root is revoked", () => {
  const e1 = ev({ evidenceId: "keep-me", binding: { head: HEAD, treeSha: TREE } });
  const c = computeCascade({
    events: [rev({ revocationId: "rv-unrelated", truthId: "some-other-evidence" })],
    evidence: [e1],
  });
  assert.deepEqual(c.revokedEvidenceIds, ["some-other-evidence"]);
  assert.ok(!c.revokedEvidenceIds.includes("keep-me"));
});

test("TR4. artifact-root revocation invalidates exactly the dependent evidence", () => {
  const bound = ev({ evidenceId: "bound-to-artifact", binding: { head: HEAD, treeSha: TREE, artifactSha256: ART } });
  const unbound = ev({ evidenceId: "no-artifact", binding: { head: HEAD, treeSha: TREE } });
  const c = computeCascade({
    events: [rev({ revocationId: "rv-art", truthClass: "artifact", truthId: ART, trigger: "artifact-hash-changed" })],
    evidence: [bound, unbound],
  });
  assert.ok(c.revokedEvidenceIds.includes("bound-to-artifact"));
  assert.ok(!c.revokedEvidenceIds.includes("no-artifact"));
});

test("TR14. cascade touches only ACTUAL dependents along explicit edges (transitive)", () => {
  const c = computeCascade({
    events: [rev({ revocationId: "rv-root", truthId: "A" })],
    dependencies: [
      { dependentId: "B", dependsOnId: "A" },
      { dependentId: "C", dependsOnId: "B" },
      { dependentId: "D", dependsOnId: "unrelated" },
    ],
  });
  assert.ok(c.revokedEvidenceIds.includes("A"));
  assert.ok(c.revokedEvidenceIds.includes("B"));
  assert.ok(c.revokedEvidenceIds.includes("C"));
  assert.ok(!c.revokedEvidenceIds.includes("D"));
  // deterministic derivation order recorded
  assert.deepEqual(c.cascade.map((x) => x.revokedId).filter((id) => ["B", "C"].includes(id)), ["B", "C"]);
});

test("TR6. authority-class revocation propagates as a current-authority fact", () => {
  const c = computeCascade({ events: [rev({ revocationId: "rv-auth", truthClass: "authority", truthId: "external-reviewer-1", trigger: "authority-revoked" })] });
  assert.deepEqual(c.revokedAuthorityIds, ["external-reviewer-1"]);
});

test("TR10. duplicate revocation is idempotent at cascade level", () => {
  const e = rev();
  const c = computeCascade({ events: [e, { ...e }, e] });
  assert.deepEqual(c.revokedEvidenceIds, ["ev-1"]);
  assert.equal(c.duplicates.length, 2);
});
const passingWorld = () => {
  const contract = contractFor([{ id: "suite-alpha", requiresIndependent: false }]);
  // The oracle ALWAYS requires the implicit checks review-bundle-valid +
  // independent-review — a complete world satisfies all three.
  const evidence = [
    ev({ evidenceId: "ev-good", producer: { identity: "ci-runner", role: "independent" } }),
    ev({ evidenceId: "ev-bundle", checkId: "review-bundle-valid", kind: "deterministic", producer: { identity: "validator", role: "independent" } }),
    ev({ evidenceId: "ev-review", checkId: "independent-review", kind: "semantic", producer: { identity: "reviewer", role: "independent" } }),
  ];
  return { contract, evidence };
};

test("TR1. without revocations the world still passes (baseline unchanged)", () => {
  const { contract, evidence } = passingWorld();
  const o = evaluatePassOracle({ contract, evidence, now: NOW });
  assert.equal(o.decision, "PASS");
  const o2 = evaluatePassOracle({ contract, evidence, revocations: null, now: NOW });
  assert.equal(o2.decision, "PASS");
});

test("TR2+TR17. revoked required evidence cannot satisfy PASS", () => {
  const { contract, evidence } = passingWorld();
  const facts = revocationFactsForOracle(computeCascade({ events: [rev({ truthId: "ev-good" })] }));
  const o = evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW });
  assert.equal(o.decision, "NOT_PASS");
  assert.ok(o.rejectedEvidence.some((r) => r.evidenceId === "ev-good" && r.code === ORACLE_REJECTIONS.EVIDENCE_REVOKED));
  assert.ok(o.failures.some((f) => f.code === ORACLE_REJECTIONS.MISSING_REQUIRED && f.checkId === "suite-alpha"));
});

test("TR17b. artifact-revoked required evidence cannot satisfy PASS either", () => {
  const contract = contractFor([{ id: "suite-alpha", freshness: "content", expectedArtifactSha256: ART }]);
  const evidence = [
    ev({ evidenceId: "ev-content", binding: { head: HEAD, treeSha: TREE, artifactSha256: ART }, producer: { identity: "ci", role: "independent" } }),
    ev({ evidenceId: "ev-bundle", checkId: "review-bundle-valid", kind: "deterministic", producer: { identity: "validator", role: "independent" } }),
    ev({ evidenceId: "ev-review", checkId: "independent-review", kind: "semantic", producer: { identity: "reviewer", role: "independent" } }),
  ];
  const base = evaluatePassOracle({ contract, evidence, now: NOW });
  assert.equal(base.decision, "PASS");
  const facts = revocationFactsForOracle(computeCascade({
    events: [rev({ revocationId: "rv-art", truthClass: "artifact", truthId: ART, trigger: "artifact-hash-changed" })],
    evidence,
  }));
  const o = evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW });
  assert.equal(o.decision, "NOT_PASS");
  assert.ok(o.failures.some((f) => f.code === ORACLE_REJECTIONS.MISSING_REQUIRED));
});


test("TR15. contradictory required evidence fails closed regardless of revocation state", () => {
  const { contract } = passingWorld();
  const evidence = [
    ev({ evidenceId: "ev-pass", producer: { identity: "a", role: "independent" } }),
    ev({ evidenceId: "ev-fail", result: "FAIL", producer: { identity: "b", role: "independent" } }),
  ];
  const o = evaluatePassOracle({ contract, evidence, revocations: { evidenceIds: [], artifactShas: [] }, now: NOW });
  assert.equal(o.decision, "NOT_PASS");
  assert.ok(o.failures.some((f) => f.code === ORACLE_REJECTIONS.CONTRADICTORY));
});
test("TR3+TR5. revoked OPTIONAL/unrelated evidence does not falsely invalidate required proof", () => {
  // Implicit required checks（review-bundle-valid + independent-review）are
  // ALWAYS present; the fixture satisfies them and revokes only an optional
  // extra. Redeclaring an implicit check is contract-invalid, so the optional
  // check is DECLARED AS OPTIONAL — never a shadowed implicit one.
  const contract = normalizeSuccessContract({
    requiredChecks: [],
    optionalChecks: [{ id: "optional-extra" }],
    head: null, treeSha: null,
  });
  assert.equal(contract.ok, true, contract.errors?.join(","));
  const evidence = [
    ev({ evidenceId: "req-bundle", checkId: "review-bundle-valid", kind: "deterministic", binding: {}, producer: { identity: "validator", role: "independent" } }),
    ev({ evidenceId: "req-review", checkId: "independent-review", kind: "semantic", binding: {}, producer: { identity: "rev", role: "independent" } }),
    ev({ evidenceId: "opt-proof", checkId: "optional-extra", binding: {} }),
  ];
  const facts = revocationFactsForOracle(computeCascade({ events: [rev({ truthId: "opt-proof" })] }));
  const o = evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW });
  assert.equal(o.decision, "PASS");
  assert.ok(!o.acceptedEvidence.includes("opt-proof"));
  assert.deepEqual(o.acceptedEvidence.filter((id) => id.startsWith("req-")), ["req-bundle", "req-review"]);
});

// ── property table（P-TR）──────────────────────────────────────────────────

test("P-TR. property table: class x fencing x restart -> expected disposition", () => {
  const CASES = [
    // [name, eventOver, truthOver|null, expectOk]
    ["valid evidence revoke", {}, null, true],
    ["artifact revoke", { truthClass: "artifact", truthId: ART, trigger: "artifact-hash-changed" }, null, true],
    ["authority revoke", { truthClass: "authority", truthId: "auth-1", trigger: "authority-revoked" }, null, true],
    ["wrong generation fenced", { generation: 3 }, { cardId: "TR-CARD", generation: 0 }, false],
    ["wrong lineage fenced", { cardId: "OTHER" }, { cardId: "TR-CARD", generation: 0 }, false],
  ];
  for (const [name, over, truth, expectOk] of CASES) {
    const store = appendRevocation({ ledgerDir: `${tmpdir()}/tr-prop-${process.pid}`, event: rev({ revocationId: `rv-${name.replace(/\W+/g, "-")}`, ...over }), truth });
    assert.equal(store.ok, expectOk, name);
  }
});

// ── durable ledger: TR10-TR12, TR16 ──────────────────────────────────────

const LEDGER = `${tmpdir()}/tr-ledger-${process.pid}`;

test("TR11. revocation survives restart: ledger re-derived from disk after 'crash'", () => {
  rmSync(LEDGER, { recursive: true, force: true });
  mkdirSync(LEDGER, { recursive: true });
  const r1 = appendRevocation({ ledgerDir: LEDGER, event: rev({ revocationId: "rv-crash" , truthId: "ev-good" }) });
  assert.equal(r1.ok, true);
  // "crash": fresh process-equivalent read straight from disk
  const led = readRevocationLedger(LEDGER);
  assert.equal(led.ok, true);
  assert.equal(led.events.length, 1);
  const facts = revocationFactsForOracle(computeCascade({ events: led.events }));
  const { contract, evidence } = passingWorld();
  const o = evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW });
  assert.equal(o.decision, "NOT_PASS", "revoked truth must not regain authority across restart");
});

test("TR12. stale pre-revocation checkpoint cannot resurrect truth on reconcile", () => {
  // A checkpoint captured BEFORE the revocation holds no revocation facts.
  // Reconcile MUST re-read the durable ledger, not trust the stale view.
  const staleCheckpointFacts = { evidenceIds: [], artifactShas: [] }; // captured pre-revocation
  const led = readRevocationLedger(LEDGER); // reconcile-by-recompute（Stage E doctrine）
  const facts = revocationFactsForOracle(computeCascade({ events: led.events }));
  assert.ok(facts.evidenceIds.includes("ev-good"));
  assert.notDeepEqual(facts, staleCheckpointFacts);
  const { contract, evidence } = passingWorld();
  assert.equal(evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW }).decision, "NOT_PASS");
});

test("TR10b. ledger duplicate is idempotent; same-id different-content fails closed", () => {
  const e = rev({ revocationId: "rv-dup", truthId: "ev-dup-target" });
  const a = appendRevocation({ ledgerDir: LEDGER, event: e });
  assert.equal(a.ok, true);
  const b = appendRevocation({ ledgerDir: LEDGER, event: e });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  const conflict = appendRevocation({ ledgerDir: LEDGER, event: rev({ revocationId: "rv-dup", truthId: "DIFFERENT", reason: "other reason entirely for conflict" }) });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.holdCode, "TRUTH_REVOCATION_ID_CONFLICT");
});

test("TR16b. corrupt ledger entries FAIL CLOSED — revoked truth cannot resurrect (red-team regression)", () => {
  const dir = `${LEDGER}-malformed`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bad.json"), "{not json");
  writeFileSync(join(dir, "bad2.json"), JSON.stringify({ schema: "nope", revocationId: "z" }));
  assert.equal(appendRevocation({ ledgerDir: dir, event: rev({ revocationId: "rv-good", truthId: "t" }) }).ok, true);
  const led = readRevocationLedger(dir);
  // A torn/invalid file might BE a revocation: deriving CURRENT-AUTHORITY
  // from a partial ledger is forbidden — callers must HOLD.
  assert.equal(led.ok, false);
  assert.equal(led.holdCode, "TRUTH_REVOCATION_LEDGER_INVALID");
  assert.equal(led.malformed.length, 2);
  // The valid entry is still parsed（for operator diagnostics）but the
  // ledger as a whole is unusable.
  assert.equal(led.events.length, 1);
});

test("TR13. historical record behavior: appending a revocation rewrites nothing", () => {
  // The ledger only ever ADDS files; existing bundle/journal/state bytes are
  // untouched by construction（appendRevocation writes one new file）.
  const dir = `${LEDGER}-history`;
  rmSync(dir, { recursive: true, force: true });
  const hist = join(dir, "closeout-state.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(hist, '{"schema":"autoloop.closeout-state/v1"}\n');
  const before = existsSync(hist);
  appendRevocation({ ledgerDir: revocationLedgerPath(dir), event: rev({ revocationId: "rv-hist", truthId: "t" }) });
  assert.equal(existsSync(hist), before);
  const led = readRevocationLedger(revocationLedgerPath(dir));
  assert.equal(led.events.length, 1);
});

// ── gate integration（runCloseoutGate revocation path）─────────────────────

import { runCloseoutGate } from "../../src/governance/review-bundle.mjs";
import { fileURLToPath } from "node:url";

const GROOT = `${tmpdir()}/truth-rev-gate-${process.pid}`;
const REPO_A = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\/]$/, "");

const gateSource = (cardId, over = {}) => ({
  schema: "autoloop.review-bundle.source/v1",
  task: { cardId, cardTitle: `${cardId} title`, cardType: "implementation", generation: 0 },
  executiveStatus: "PASS",
  repo: {},
  objective: `${cardId}: truth-revocation gate fixture`,
  authorizedScope: ["src/governance/review-bundle.mjs"],
  designDecisions: ["fixture"],
  diffSummary: "fixture",
  review: { pass: true, result: "PASS", reviewResultIdentity: "cc".repeat(32), blockingFindings: [], summary: "independent review PASS" },
  verifier: { pass: true, result: "PASS", summary: "verifier ok" },
  regression: [{ suite: "suite-alpha", tests: 2, pass: 2, fail: 0 }],
  negativeCases: [],
  risks: [],
  limitations: [],
  openQuestions: [],
  recommendedNextStep: "external review",
  inventory: null,
  evidence: [],
  ...over,
});

const driveGate = async (cardId, extra = {}) =>
  runCloseoutGate({
    source: gateSource(cardId),
    repoPath: REPO_A,
    outDir: join(GROOT, cardId),
    timeoutMs: 15000,
    deliver: null, // non-formal unit-test path
    successContract: { requiredChecks: [{ id: "suite-alpha" }, { id: "verifier-gate", kind: "verifier" }] },
    ...extra,
  });

test("GR1. baseline: identical gate input WITHOUT revocations still reaches final PASS", { timeout: 60000 }, async () => {
  rmSync(GROOT, { recursive: true, force: true });
  mkdirSync(GROOT, { recursive: true });
  const r = await driveGate("TG-baseline");
  assert.equal(r.final, "PASS", `(${r.holdCode}:${r.reason})`);
});

test("GR2. gate: revoking a required check's evidence -> HOLD PASS_ORACLE_REJECTED", { timeout: 60000 }, async () => {
  mkdirSync(GROOT, { recursive: true });
  const cardId = "TG-revoked";
  const r = await driveGate(cardId, {
    truthRevocations: [rev({
      revocationId: "rv-gate-suite",
      truthId: "gate:suite-alpha",
      trigger: "verifier-retraction",
      reason: "suite run retracted: runner environment was contaminated",
    })],
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "PASS_ORACLE_REJECTED");
  // The rejection detail lives on the oracle record（rejectedEvidence）; the
  // gate reason surfaces the resulting MISSING_REQUIRED failure.
  assert.ok(r.oracle.rejectedEvidence.some((x) => x.evidenceId === "gate:suite-alpha" && x.code === ORACLE_REJECTIONS.EVIDENCE_REVOKED), JSON.stringify(r.oracle?.rejectedEvidence));
  assert.ok(r.reason.includes("ORACLE_REQUIRED_EVIDENCE_MISSING@suite-alpha"), r.reason);
});

test("GR3. gate: revoking an UNRELATED evidence id leaves the PASS intact (TR5 at gate level)", { timeout: 60000 }, async () => {
  const cardId = "TG-unrelated";
  const r = await driveGate(cardId, {
    truthRevocations: [rev({ revocationId: "rv-other-card", truthId: "gate:some-other-check" })],
  });
  assert.equal(r.final, "PASS", `(${r.holdCode}:${r.reason})`);
});

// ── red-team regressions（independent review findings）─────────────────────

test("RT1. oracle rejects evidence produced by a REVOKED AUTHORITY identity", () => {
  const { contract } = passingWorld();
  const evidence = [
    ev({ evidenceId: "ev-by-revoked-reviewer", producer: { identity: "fallen-reviewer", role: "independent" } }),
    ev({ evidenceId: "ev-bundle", checkId: "review-bundle-valid", kind: "deterministic", binding: {}, producer: { identity: "validator", role: "independent" } }),
    ev({ evidenceId: "ev-review", checkId: "independent-review", kind: "semantic", binding: {}, producer: { identity: "other-reviewer", role: "independent" } }),
  ];
  const facts = revocationFactsForOracle(computeCascade({
    events: [rev({ revocationId: "rv-auth", truthClass: "authority", truthId: "fallen-reviewer", trigger: "authority-revoked" })],
  }));
  const o = evaluatePassOracle({ contract, evidence, revocations: facts, now: NOW });
  assert.equal(o.decision, "NOT_PASS");
  assert.ok(o.rejectedEvidence.some((x) => x.evidenceId === "ev-by-revoked-reviewer" && x.code === ORACLE_REJECTIONS.EVIDENCE_REVOKED && x.detail.startsWith("authority_revoked:")));
});

test("RT2. gate SELF-LOADS the durable ledger — no caller wiring needed (enforcement not dead code)", { timeout: 60000 }, async () => {
  mkdirSync(GROOT, { recursive: true });
  const cardId = "TG-selfload";
  const outDir = join(GROOT, cardId);
  const a = appendRevocation({
    ledgerDir: revocationLedgerPath(outDir),
    event: rev({ revocationId: "rv-selfload", truthId: "gate:suite-alpha", cardId, generation: 0, reason: "suite retracted by operator" }),
  });
  assert.equal(a.ok, true, a.reason);
  // NO truthRevocations parameter: the gate must discover the ledger itself.
  const r = await driveGate(cardId);
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "PASS_ORACLE_REJECTED");
  assert.ok(r.oracle.rejectedEvidence.some((x) => x.evidenceId === "gate:suite-alpha" && x.code === ORACLE_REJECTIONS.EVIDENCE_REVOKED));
});

test("RT3. gate override with an executor-role event -> HOLD TRUTH_REVOCATION_INVALID (laundering blocked)", { timeout: 60000 }, async () => {
  const r = await driveGate("TG-executor", {
    truthRevocations: [{
      schema: "autoloop.truth-revocation/v1",
      revocationId: "rv-laundry", truthClass: "evidence", truthId: "gate:independent-review",
      trigger: "verifier-retraction", reason: "executor tries to revoke independent proof",
      at: NOW, issuedBy: { identity: "implementing-agent", role: "executor" },
    }],
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "TRUTH_REVOCATION_INVALID");
});

test("RT4. corrupt ledger -> gate HOLDs instead of PASSing over a partial view", { timeout: 60000 }, async () => {
  const cardId = "TG-corrupt";
  const outDir = join(GROOT, cardId);
  mkdirSync(revocationLedgerPath(outDir), { recursive: true });
  writeFileSync(join(revocationLedgerPath(outDir), "torn.json"), "{torn");
  const r = await driveGate(cardId);
  assert.equal(r.final, "HOLD");
  assert.equal(r.holdCode, "TRUTH_REVOCATION_LEDGER_INVALID");
});
