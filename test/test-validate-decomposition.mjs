// test/test-validate-decomposition.mjs
//
// Card 1 repaired v2: F1–F6 negative-path gates + malformed input tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition } from "../src/validate-decomposition.mjs";

const parentCard = {
  limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
  scope: { allowed_paths: ["src/", "test/"], forbidden_paths: ["src/secrets/", ".env"] }
};

const manifest = [
  { requirement_id: "R1", text: "analyze" },
  { requirement_id: "R2", text: "implement" },
  { requirement_id: "R3", text: "test" }
];

function d(overrides = {}) {
  return {
    verdict: "DECOMPOSED", parent_goal: "Implement X",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    child_cards: [
      { card_id: "c1", role_id: "audit", goal: "Audit", card_type: "READ_ONLY_AUDIT",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/core/"] },
      { card_id: "c2", role_id: "impl", goal: "Impl", card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/core/"] },
      { card_id: "c3", role_id: "test", goal: "Test", card_type: "RUNTIME_VALIDATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["test/"] }
    ],
    edges: [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }],
    deferred_items: [], unresolved_items: [],
    coverage_map: [
      { requirement_id: "R1", role_id: "audit", verification: "audit" },
      { requirement_id: "R2", role_id: "impl", verification: "impl" },
      { requirement_id: "R3", role_id: "test", verification: "test" }
    ],
    decomposition_evidence: ["e"],
    ...overrides
  };
}

// ======== VALID ========
describe("valid", () => {
  it("NOT_BENEFICIAL", () => {
    const v = { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "small", decomposition_evidence: ["e"] };
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
  it("BLOCKED", () => {
    const v = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R1", reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] };
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
  it("DECOMPOSED valid", () => {
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: d() }).valid, true);
  });
  it("single card, no edges", () => {
    const v = d({ child_cards: [
      { card_id: "c1", role_id: "fix", goal: "Fix", card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/core/"] }
    ], edges: [],
    coverage_map: [
      { requirement_id: "R1", role_id: "fix", verification: "x" },
      { requirement_id: "R2", role_id: "fix", verification: "x" },
      { requirement_id: "R3", role_id: "fix", verification: "x" }
    ]});
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
  it("multiple coverage roles for same requirement", () => {
    const v = d({ coverage_map: [
      { requirement_id: "R1", role_id: "audit", verification: "x" },
      { requirement_id: "R1", role_id: "impl", verification: "y" },
      { requirement_id: "R2", role_id: "impl", verification: "x" },
      { requirement_id: "R3", role_id: "test", verification: "x" }
    ]});
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
  it("deferred covers a requirement", () => {
    const v = d({ coverage_map: [
      { requirement_id: "R1", role_id: "audit", verification: "x" },
      { requirement_id: "R2", role_id: "impl", verification: "x" }
    ], deferred_items: [{ requirement_id: "R3", reason_code: "COMMIT_NOT_AUTHORIZED", reason: "x" }] });
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
  it("path prefix matches (src/utils/file.js in src/)", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src/utils/file.js"];
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
});

// ======== F1: REPAIR mutation bound to parent ========
describe("F1 — REPAIR no mutation bypass", () => {
  it("rejects REPAIR with mutation when parent mutation_allowed=false", () => {
    const p = { limits: { commit_allowed: false, push_allowed: false, mutation_allowed: false } };
    const v = d();
    v.child_cards.push({ card_id: "c4", role_id: "repair", goal: "Repair", card_type: "REPAIR",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
      verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/core/"] });
    v.coverage_map.push({ requirement_id: "R1", role_id: "repair", verification: "x" });
    const r = validateDecomposition({ parentCard: p, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION" && e.message.includes("mutation_allowed")));
  });
});

// ======== F2: empty allowed_paths ========
describe("F2 — empty parent allowed_paths", () => {
  it("rejects child paths when parent has no allowed_paths", () => {
    const p = { limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
      scope: { allowed_paths: [], forbidden_paths: [] } };
    const r = validateDecomposition({ parentCard: p, requirementManifest: manifest, decomposition: d() });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });
});

// ======== F3: malformed DECOMPOSED ========
describe("F3 — malformed input", () => {
  it("rejects missing child_cards", () => {
    const v = { verdict: "DECOMPOSED" };
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "SCHEMA"));
  });
  it("rejects child_cards=null", () => {
    const v = { verdict: "DECOMPOSED", parent_goal: "x",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: null, edges: [], deferred_items: [], unresolved_items: [],
      coverage_map: [], decomposition_evidence: ["e"] };
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, false);
  });
  it("rejects missing edges", () => {
    const v = d();
    delete v.edges;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, false);
  });
  it("rejects edges=null", () => {
    const v = d({ edges: null });
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, false);
  });
});

// ======== F4: forbidden-path ancestor ========
describe("F4 — forbidden-path ancestor", () => {
  it("rejects child allowed_path=src/ when parent forbidden=src/secrets/", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src/"]; // ancestor of src/secrets/
    const p = { limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
      scope: { allowed_paths: ["src/", "test/"], forbidden_paths: ["src/secrets/"] } };
    const r = validateDecomposition({ parentCard: p, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION" && e.message.includes("ancestor")));
  });
});

// ======== F5: deferred/unresolved require requirement_id ========
describe("F5 — deferred/unresolved requirement_id required", () => {
  it("rejects DECOMPOSED deferred without requirement_id", () => {
    const v = d();
    v.deferred_items = [{ reason_code: "OTHER", reason: "x" }];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "SCHEMA"));
  });
  it("rejects DECOMPOSED unresolved without requirement_id", () => {
    const v = d();
    v.unresolved_items = [{ reason_code: "OTHER", question: "?" }];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "SCHEMA"));
  });
  it("rejects BLOCKED unresolved without requirement_id", () => {
    const v = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] };
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "SCHEMA"));
  });
  it("rejects BLOCKED unresolved with unknown requirement_id", () => {
    const v = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R99", reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] };
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "UNKNOWN_REQUIREMENT_ID"));
  });
  it("accepts BLOCKED with valid manifest-aligned unresolved", () => {
    const v = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R1", reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] };
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, true);
  });
});

// ======== F6: commit/push banned in child cards ========
describe("F6 — commit/push forbidden", () => {
  it("rejects child with commit_allowed=true", () => {
    const v = d();
    v.child_cards[0].authority_required.commit_allowed = true;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "COMMIT_FORBIDDEN"));
  });
  it("rejects child with push_allowed=true", () => {
    const v = d();
    v.child_cards[0].authority_required.push_allowed = true;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "PUSH_FORBIDDEN"));
  });
});

// ======== Others ========
describe("others", () => {
  it("rejects missing parentCard", () => {
    assert.equal(validateDecomposition({ requirementManifest: manifest, decomposition: d() }).valid, false);
  });
  it("rejects missing manifest", () => {
    assert.equal(validateDecomposition({ parentCard, decomposition: d() }).valid, false);
  });
  it("rejects wrong executor", () => {
    const r = validateDecomposition({ parentCard, requirementManifest: manifest,
      decomposition: d({ execution_policy: { executor: "CLAUDE", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false } }) });
    assert.ok(r.errors.some(e => e.rule === "EXECUTION_POLICY_LOCKED" || e.rule === "SCHEMA"));
  });
  it("rejects cycle", () => {
    const v = d();
    v.edges = [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }, { from: "test", to: "audit" }];
    assert.ok(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).errors.some(e => e.rule === "CYCLE_DETECTED"));
  });
  it("rejects 8 cards", () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({
      card_id: `c${i}`, role_id: `r${i}`, goal: `g${i}`, card_type: i < 2 ? "IMPLEMENTATION" : "READ_ONLY_AUDIT",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: i < 2 },
      verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/core/"]
    }));
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest,
      decomposition: { verdict: "DECOMPOSED", parent_goal: "x",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        child_cards: cards, edges: [], deferred_items: [], unresolved_items: [],
        coverage_map: [], decomposition_evidence: ["e"] } }).valid, false);
  });
});
