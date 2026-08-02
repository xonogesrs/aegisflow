// test/test-validate-decomposition.mjs
//
// Card 1: synthetic tests for validate-decomposition.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateDecomposition } from "../src/validate-decomposition.mjs";

const parentCard = {
  limits: { commit_allowed: false, push_allowed: false },
  scope: { allowed_paths: ["src/", "test/"], forbidden_paths: [] }
};

const manifest = [
  { requirement_id: "R1", text: "analyze existing code" },
  { requirement_id: "R2", text: "implement feature" },
  { requirement_id: "R3", text: "run tests" }
];

function makeDecomposed(overrides = {}) {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "Implement feature X",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    child_cards: [
      { card_id: "c1", role_id: "audit", goal: "Audit code", card_type: "READ_ONLY_AUDIT",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: [], forbidden_commands: [] },
        risk_level: "LOW", allowed_paths: ["src/"] },
      { card_id: "c2", role_id: "impl", goal: "Implement feature", card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
        verification: { required_commands: [], forbidden_commands: [] },
        risk_level: "MEDIUM", allowed_paths: ["src/"] },
      { card_id: "c3", role_id: "test", goal: "Run tests", card_type: "RUNTIME_VALIDATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: ["npm test"], forbidden_commands: [] },
        risk_level: "LOW", allowed_paths: ["test/"] }
    ],
    edges: [
      { from: "audit", to: "impl", type: "depends_on" },
      { from: "impl", to: "test", type: "depends_on" }
    ],
    deferred_items: [],
    unresolved_items: [],
    coverage_map: [
      { requirement_id: "R1", role_id: "audit", verification: "audit report" },
      { requirement_id: "R2", role_id: "impl", verification: "implementation" },
      { requirement_id: "R3", role_id: "test", verification: "test pass" }
    ],
    decomposition_evidence: ["test evidence"],
    ...overrides
  };
}

// ======== POSITIVE ========

describe("validateDecomposition — valid", () => {
  it("accepts NOT_BENEFICIAL", () => {
    const d = { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "too small", decomposition_evidence: ["e"] };
    const r = validateDecomposition({ decomposition: d });
    assert.equal(r.valid, true, r.errors.map(e => e.message).join("; "));
  });

  it("accepts DECOMPOSITION_BLOCKED", () => {
    const d = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R1", reason_code: "CYCLIC_DEPENDENCY", question: "how to break cycle?" }],
      decomposition_evidence: ["e"] };
    const r = validateDecomposition({ decomposition: d });
    assert.equal(r.valid, true, r.errors.map(e => e.message).join("; "));
  });

  it("accepts valid DECOMPOSED with manifest", () => {
    const d = makeDecomposed();
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: d });
    assert.equal(r.valid, true, r.errors.map(e => e.message).join("; "));
  });

  it("accepts DECOMPOSED without manifest (coverage check skipped)", () => {
    const d = makeDecomposed();
    const r = validateDecomposition({ parentCard, requirementManifest: undefined, decomposition: d });
    assert.equal(r.valid, true, r.errors.map(e => e.message).join("; "));
  });

  it("accepts DECOMPOSED without parentCard (authority check skipped)", () => {
    const d = makeDecomposed();
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.equal(r.valid, true);
  });

  it("accepts DECOMPOSED with single card + no edges", () => {
    const d = makeDecomposed({
      child_cards: [
        { card_id: "c1", role_id: "fix", goal: "Fix bug", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] },
          risk_level: "LOW", allowed_paths: ["src/"] }
      ],
      edges: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "fix", verification: "fix applied" },
        { requirement_id: "R2", role_id: "fix", verification: "fix applied" },
        { requirement_id: "R3", role_id: "fix", verification: "fix applied" }
      ]
    });
    const r = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: d });
    assert.equal(r.valid, true);
  });
});

// ======== NEGATIVE ========

describe("validateDecomposition — schema errors", () => {
  it("rejects null", () => {
    const r = validateDecomposition({ decomposition: null });
    assert.equal(r.valid, false);
  });

  it("rejects unknown verdict", () => {
    const r = validateDecomposition({ decomposition: { verdict: "SOMETHING_ELSE" } });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "SCHEMA" || e.rule === "UNKNOWN_VERDICT"));
  });

  it("rejects NOT_BENEFICIAL with child_cards", () => {
    const d = { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "x", decomposition_evidence: ["e"], child_cards: [{ card_id: "x" }] };
    const r = validateDecomposition({ decomposition: d });
    assert.equal(r.valid, false);
  });

  it("rejects BLOCKED with edges", () => {
    const d = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"], edges: [{ from: "a", to: "b" }] };
    const r = validateDecomposition({ decomposition: d });
    assert.equal(r.valid, false);
  });

  it("rejects DECOMPOSED with 0 child cards", () => {
    const d = makeDecomposed({ child_cards: [], edges: [], coverage_map: [] });
    const r = validateDecomposition({ decomposition: d });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.rule === "CARD_COUNT" || e.rule === "SCHEMA"));
  });
});

// ======== EXECUTION POLICY ========

describe("validateDecomposition — execution policy", () => {
  it("rejects wrong executor", () => {
    const d = makeDecomposed({ execution_policy: { executor: "CLAUDE", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false } });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "EXECUTION_POLICY_LOCKED" || e.rule === "SCHEMA"));
  });

  it("rejects multi_model_orchestration: true", () => {
    const d = makeDecomposed({ execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: true } });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "EXECUTION_POLICY_LOCKED" || e.rule === "SCHEMA"));
  });
});

// ======== UNIQUENESS ========

describe("validateDecomposition — uniqueness", () => {
  it("rejects duplicate card_id", () => {
    const d = makeDecomposed();
    d.child_cards[1].card_id = "c1"; // duplicate
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "DUPLICATE_CARD_ID"));
  });

  it("rejects duplicate role_id", () => {
    const d = makeDecomposed();
    d.child_cards[1].role_id = "audit"; // duplicate
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "DUPLICATE_ROLE_ID"));
  });
});

// ======== EDGES ========

describe("validateDecomposition — edges", () => {
  it("rejects unknown role in edge", () => {
    const d = makeDecomposed();
    d.edges.push({ from: "audit", to: "nonexistent", type: "depends_on" });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "UNKNOWN_ROLE_REF"));
  });

  it("rejects self-dependency", () => {
    const d = makeDecomposed();
    d.edges.push({ from: "audit", to: "audit", type: "depends_on" });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "SELF_DEPENDENCY"));
  });

  it("rejects cycle A→B→C→A", () => {
    const d = makeDecomposed();
    d.edges = [
      { from: "audit", to: "impl" },
      { from: "impl", to: "test" },
      { from: "test", to: "audit" }
    ];
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "CYCLE_DETECTED"));
  });
});

// ======== AUTHORITY ========

describe("validateDecomposition — authority", () => {
  it("rejects commit_allowed invented", () => {
    const d = makeDecomposed();
    d.child_cards[0].authority_required.commit_allowed = true;
    const r = validateDecomposition({ parentCard, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });

  it("rejects push_allowed invented", () => {
    const d = makeDecomposed();
    d.child_cards[0].authority_required.push_allowed = true;
    const r = validateDecomposition({ parentCard, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });

  it("rejects path outside parent scope", () => {
    const d = makeDecomposed();
    d.child_cards[0].allowed_paths = ["etc/"];
    const r = validateDecomposition({ parentCard, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "AUTHORITY_EXPANSION"));
  });
});

// ======== EXTERNAL_REVIEW ========

describe("validateDecomposition — EXTERNAL_REVIEW", () => {
  it("rejects review card with mutation", () => {
    const d = makeDecomposed();
    d.child_cards.push({
      card_id: "c4", role_id: "review", goal: "Review", card_type: "EXTERNAL_REVIEW",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
      verification: { required_commands: [], forbidden_commands: [] },
      risk_level: "LOW", allowed_paths: ["src/"]
    });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "REVIEW_MUTATION"));
  });

  it("rejects review card with commit", () => {
    const d = makeDecomposed();
    d.child_cards.push({
      card_id: "c4", role_id: "review", goal: "Review", card_type: "EXTERNAL_REVIEW",
      authority_required: { commit_allowed: true, push_allowed: false, mutation_allowed: false },
      verification: { required_commands: [], forbidden_commands: [] },
      risk_level: "LOW", allowed_paths: ["src/"]
    });
    const r = validateDecomposition({ decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "REVIEW_MUTATION"));
  });
});

// ======== REQUIREMENT DISPOSITION ========

describe("validateDecomposition — requirement disposition", () => {
  it("rejects missing requirement (not in coverage/deferred/unresolved)", () => {
    const d = makeDecomposed();
    d.coverage_map = d.coverage_map.slice(0, 2); // drop R3
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "MISSING_DISPOSITION"));
  });

  it("rejects duplicate disposition (same ID in coverage and deferred)", () => {
    const d = makeDecomposed();
    d.deferred_items = [{ requirement_id: "R1", reason_code: "OTHER" }];
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "DUPLICATE_DISPOSITION"));
  });

  it("rejects unknown requirement_id in coverage", () => {
    const d = makeDecomposed();
    d.coverage_map.push({ requirement_id: "R99", role_id: "audit", verification: "x" });
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.ok(r.errors.some(e => e.rule === "UNKNOWN_REQUIREMENT_ID"));
  });

  it("accepts deferred items for certain requirements", () => {
    const d = makeDecomposed();
    d.coverage_map = [
      { requirement_id: "R1", role_id: "audit", verification: "x" },
      { requirement_id: "R2", role_id: "impl", verification: "x" }
    ];
    d.deferred_items = [{ requirement_id: "R3", reason_code: "COMMIT_NOT_AUTHORIZED", reason: "no commit" }];
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.equal(r.valid, true);
  });

  it("accepts unresolved items for certain requirements", () => {
    const d = makeDecomposed();
    d.coverage_map = [
      { requirement_id: "R1", role_id: "audit", verification: "x" },
      { requirement_id: "R2", role_id: "impl", verification: "x" }
    ];
    d.unresolved_items = [{ requirement_id: "R3", reason_code: "AMBIGUOUS_SCOPE", question: "scope unclear?" }];
    const r = validateDecomposition({ requirementManifest: manifest, decomposition: d });
    assert.equal(r.valid, true);
  });
});

// ======== CARD COUNT ========

describe("validateDecomposition — card count", () => {
  it("rejects 8 cards", () => {
    const cards = Array.from({ length: 8 }, (_, i) => ({
      card_id: `c${i}`, role_id: `r${i}`, goal: `g${i}`, card_type: "READ_ONLY_AUDIT",
      authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
      verification: { required_commands: [], forbidden_commands: [] },
      risk_level: "LOW", allowed_paths: ["src/"]
    }));
    const r = validateDecomposition({
      decomposition: {
        verdict: "DECOMPOSED", parent_goal: "x",
        execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
        child_cards: cards, edges: [],
        deferred_items: [], unresolved_items: [],
        coverage_map: [], decomposition_evidence: ["e"]
      }
    });
    assert.ok(r.errors.some(e => e.rule === "CARD_COUNT" || e.rule === "SCHEMA"));
  });
});
