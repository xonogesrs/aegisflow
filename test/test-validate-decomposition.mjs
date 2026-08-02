// test/test-validate-decomposition.mjs
//
// Card 1 repaired: all 14 negative-path gates covered.

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
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/"] },
      { card_id: "c2", role_id: "impl", goal: "Impl", card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/"] },
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
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/"] }
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
  it("path prefix matches correctly (src/file.js in src/)", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src/utils/file.js"];
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, true);
  });
});

// ======== F1: missing parentCard / manifest ========
describe("F1 — parentCard/manifest required", () => {
  it("rejects missing parentCard", () => {
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d() });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "MISSING_PARENT_CARD"));
  });
  it("rejects missing manifest", () => {
    const r = validateDecomposition({ parentCard, decomposition: d() });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "MISSING_MANIFEST"));
  });
  it("rejects empty manifest", () => {
    const r = validateDecomposition({ parentCard, requirementManifest: [], decomposition: d() });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "MISSING_MANIFEST"));
  });
});

// ======== F2: full authority ========
describe("F2 — authority", () => {
  it("rejects mutation_allowed invented", () => {
    const p = { limits: { commit_allowed: false, push_allowed: false, mutation_allowed: false } };
    const v = d();
    v.child_cards[1].authority_required.mutation_allowed = true;
    const r = validateDecomposition({ parentCard: p, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION" && e.message.includes("mutation_allowed")));
  });
  it("rejects allowed_path intersecting parent forbidden_path", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src/secrets/"]; // parent forbidden
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });
  it("rejects path with ..", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["../etc"];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "INVALID_PATH"));
  });
  it("rejects path with backslash", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src\\utils"];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "INVALID_PATH"));
  });
  it("rejects path not in parent scope (different dir)", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["etc/"];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });
  it("accepts child path as subdirectory under parent path", () => {
    const v = d();
    v.child_cards[0].allowed_paths = ["src/auth/"]; // subdir of src/
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, true);
  });
});

// ======== F4: coverage ========
describe("F4 — coverage", () => {
  it("rejects coverage with orphan role", () => {
    const v = d();
    v.coverage_map.push({ requirement_id: "R3", role_id: "nonexistent", verification: "x" });
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "COVERAGE_ORPHAN_ROLE"));
  });
  it("rejects __any__ role_id in production", () => {
    const v = d();
    v.child_cards[0].role_id = "__any__";
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "RESERVED_ROLE_ID"));
  });
  it("rejects manifest duplicate IDs", () => {
    const badManifest = [
      { requirement_id: "R1", text: "a" },
      { requirement_id: "R1", text: "b" }
    ];
    const r = validateDecomposition({ parentCard, requirementManifest: badManifest, decomposition: d() });
    assert.ok(r.errors.some(e => e.rule === "DUPLICATE_MANIFEST_ID"));
  });
  it("rejects cross-category duplicate (coverage + deferred)", () => {
    const v = d();
    v.deferred_items = [{ requirement_id: "R1", reason_code: "OTHER" }];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "CROSS_CATEGORY_DUPLICATE"));
  });
  it("rejects missing requirement", () => {
    const v = d();
    v.coverage_map = v.coverage_map.slice(0, 2);
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "MISSING_DISPOSITION"));
  });
});

// ======== F5: card type mutation ========
describe("F5 — card type vs mutation", () => {
  it("rejects READ_ONLY_AUDIT with mutation", () => {
    const v = d();
    v.child_cards[0].authority_required.mutation_allowed = true;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "TYPE_MUTATION_MISMATCH"));
  });
  it("rejects RUNTIME_VALIDATION with mutation", () => {
    const v = d();
    v.child_cards[2].authority_required.mutation_allowed = true;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "TYPE_MUTATION_MISMATCH"));
  });
  it("rejects IMPLEMENTATION without mutation", () => {
    const v = d();
    v.child_cards[1].authority_required.mutation_allowed = false;
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "TYPE_MUTATION_MISMATCH"));
  });
  it("rejects EXTERNAL_REVIEW with mutation", () => {
    const v = d();
    v.child_cards.push({ card_id: "c4", role_id: "review", goal: "Rev", card_type: "EXTERNAL_REVIEW",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
      verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/"] });
    v.coverage_map.push({ requirement_id: "R1", role_id: "review", verification: "x" });
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "TYPE_MUTATION_MISMATCH"));
  });
});

// ======== F6: edge type default ========
describe("F6 — edge type default", () => {
  it("applies depends_on default when type missing (schema default)", () => {
    const v = d();
    v.edges = [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }]; // no type
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.equal(r.valid, true);
    // After validation, type should be filled
    assert.equal(v.edges[0].type, "depends_on");
    assert.equal(v.edges[1].type, "depends_on");
  });
});

// ======== Misc ========
describe("misc", () => {
  it("rejects NOT_BENEFICIAL with child_cards", () => {
    const v = { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "x", decomposition_evidence: ["e"], child_cards: [{ card_id: "x" }] };
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v }).valid, false);
  });
  it("rejects cycle", () => {
    const v = d();
    v.edges = [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }, { from: "test", to: "audit" }];
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "CYCLE_DETECTED"));
  });
  it("rejects wrong executor", () => {
    const v = d({ execution_policy: { executor: "CLAUDE", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false } });
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: v });
    assert.ok(r.errors.some(e => e.rule === "EXECUTION_POLICY_LOCKED" || e.rule === "SCHEMA"));
  });
  it("rejects 8 cards", () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({
      card_id: `c${i}`, role_id: `r${i}`, goal: `g${i}`, card_type: i < 2 ? "IMPLEMENTATION" : "READ_ONLY_AUDIT",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: i < 2 },
      verification: { required_commands: [], forbidden_commands: [] },
      risk_level: "LOW", allowed_paths: ["src/"]
    }));
    const r = validateDecomposition({ parentCard, requirementManifest: manifest,
      decomposition: { verdict: "DECOMPOSED", parent_goal: "x",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        child_cards: cards, edges: [], deferred_items: [], unresolved_items: [],
        coverage_map: [], decomposition_evidence: ["e"] } });
    assert.ok(r.errors.some(e => e.rule === "CARD_COUNT" || e.rule === "SCHEMA"));
  });
  it("rejects null", () => {
    assert.equal(validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: null }).valid, false);
  });
});
