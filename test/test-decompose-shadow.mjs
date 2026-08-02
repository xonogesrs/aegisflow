// test/test-decompose-shadow.mjs
//
// Card 2 repaired — shadow-mode decomposer tests.
// F1: malformed edges → INVALID_DECOMPOSITION (no throw)
// F2: strict manifest item + parentCard validation
// F3: no raw output in error results
// F5: 3 added boundary tests (filesystem, child exec, network)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decomposeTask } from "../src/decompose-task.mjs";

const parentCard = {
  card_id: "CARD_TEST_2", mode: "IMPLEMENT",
  worktree_path: "/tmp/test-autoloop", base_branch: "main",
  limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
  scope: { allowed_paths: ["src/", "test/"], forbidden_paths: ["src/secrets/"] },
  card_body: "Test parent task"
};

const manifest = [
  { requirement_id: "R1", text: "analyze" },
  { requirement_id: "R2", text: "implement" },
  { requirement_id: "R3", text: "test" }
];

function makeProvider(output) {
  let calls = 0;
  return { callCount: () => calls, generate: async () => { calls++; return output; } };
}

function validDecomposed() {
  return {
    verdict: "DECOMPOSED", parent_goal: "Implement test feature",
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
    decomposition_evidence: ["test"]
  };
}

// ======== A. VALID VERDICTS ========
describe("A — valid", () => {
  it("1 NOT_BENEFICIAL", async () => {
    const p = makeProvider({ verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "small", decomposition_evidence: ["e"] });
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID"); assert.equal(p.callCount(), 1);
  });
  it("2 DECOMPOSED", async () => {
    const p = makeProvider(validDecomposed());
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID"); assert.equal(p.callCount(), 1);
  });
  it("3 BLOCKED", async () => {
    const p = makeProvider({ verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R1", reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] });
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID"); assert.equal(p.callCount(), 1);
  });
});

// ======== B. PARSING ========
describe("B — parsing", () => {
  it("4 JSON string", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(JSON.stringify(validDecomposed())) });
    assert.equal(r.status, "VALID");
  });
  it("5 object", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
  });
  it("6 non-JSON string", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("not json") });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("7 markdown fence", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("```json\n{}") });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("8 explanatory prefix", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("here:\n{}") });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("9 empty string", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("") });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("10 null", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(null) });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("11 array", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider([1,2,3]) });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
});

// ======== F1: MALFORMED EDGES (no throw) ========
describe("F1 — malformed edges", () => {
  it("12 edges={}", async () => {
    const d = validDecomposed(); d.edges = {};
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("13 edges='invalid'", async () => {
    const d = validDecomposed(); d.edges = "invalid";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("14 edges=[null]", async () => {
    const d = validDecomposed(); d.edges = [null];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("15 edges=[{from:'a'}]", async () => {
    const d = validDecomposed(); d.edges = [{ from: "a" }];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
});

// ======== C. VALIDATOR INTEGRATION ========
describe("C — validator", () => {
  it("16 unknown verdict", async () => {
    const d = validDecomposed(); d.verdict = "X";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("17 missing child_cards", async () => {
    const d = validDecomposed(); delete d.child_cards;
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("18 duplicate card_id", async () => {
    const d = validDecomposed(); d.child_cards[1].card_id = "c1";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("19 duplicate role_id", async () => {
    const d = validDecomposed(); d.child_cards[1].role_id = "audit";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("20 unknown edge role", async () => {
    const d = validDecomposed(); d.edges = [{ from: "audit", to: "impl" }, { from: "audit", to: "x" }];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("21 self edge", async () => {
    const d = validDecomposed(); d.edges = [{ from: "audit", to: "audit" }];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("22 cycle", async () => {
    const d = validDecomposed();
    d.edges = [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }, { from: "test", to: "audit" }];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("23 authority expansion", async () => {
    const d = validDecomposed(); d.child_cards[0].allowed_paths = ["etc/"];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("24 commit_allowed=true", async () => {
    const d = validDecomposed(); d.child_cards[0].authority_required.commit_allowed = true;
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("25 push_allowed=true", async () => {
    const d = validDecomposed(); d.child_cards[0].authority_required.push_allowed = true;
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("26 __any__ role", async () => {
    const d = validDecomposed(); d.child_cards[0].role_id = "__any__";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("27 missing disposition", async () => {
    const d = validDecomposed(); d.coverage_map = d.coverage_map.slice(0, 2);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("28 coverage orphan", async () => {
    const d = validDecomposed();
    d.coverage_map.push({ requirement_id: "R3", role_id: "x", verification: "x" });
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
  it("29 execution_policy deviation", async () => {
    const d = validDecomposed();
    d.execution_policy = { executor: "CLAUDE", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false };
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
});

// ======== F2: STRICT INPUT ========
describe("F2 — strict input", () => {
  it("30 missing parentCard", async () => {
    const r = await decomposeTask({ requirementManifest: manifest, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("31 parentCard is array", async () => {
    const r = await decomposeTask({ parentCard: [], requirementManifest: manifest, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("32 missing manifest", async () => {
    const r = await decomposeTask({ parentCard, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("33 empty manifest", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: [], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("34 manifest item not object", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: ["bad"], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("35 manifest item missing text", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: [{ requirement_id: "R1" }], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("36 manifest item empty requirement_id", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: [{ requirement_id: "", text: "x" }], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("37 manifest duplicate IDs", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: [{ requirement_id: "R1", text: "a" }, { requirement_id: "R1", text: "b" }], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("38 input invalid → provider NOT called", async () => {
    const p = makeProvider({});
    await decomposeTask({ parentCard, requirementManifest: [], provider: p });
    assert.equal(p.callCount(), 0);
  });
  it("39 missing provider", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("40 provider missing generate", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: {} });
    assert.equal(r.status, "INVALID_INPUT");
  });
  it("41 circular parentCard → INVALID_INPUT", async () => {
    const circ = { limits: {}, scope: {} }; circ.self = circ;
    const r = await decomposeTask({ parentCard: circ, requirementManifest: manifest, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });
});

// ======== F3: NO RAW OUTPUT LEAK ========
describe("F3 — no raw output in errors", () => {
  it("41 invalid string: no raw text in result", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("sk-test-secret-token") });
    const str = JSON.stringify(r);
    assert.ok(!str.includes("sk-test-secret"));
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
    assert.ok(r.output_type);
  });
  it("42 provider exception: no raw message in result", async () => {
    const p = { generate: async () => { throw new Error("AURA_RENDERER_TRANSPORT_SECRET=abc123"); } };
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    const str = JSON.stringify(r);
    assert.ok(!str.includes("AURA_RENDERER"));
    assert.ok(!str.includes("abc123"));
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("43 output_length reported, not content", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider("not json at all") });
    assert.ok(!("raw_output_summary" in r));
    assert.ok("output_length" in r);
  });
  it("44 secret in invalid decomposition not leaked", async () => {
    const d = validDecomposed();
    d.execution_policy = { executor: "sk-secret-value-12345", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false };
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
    const str = JSON.stringify(r);
    assert.ok(!str.includes("sk-secret"), "secret must not appear in validation errors");
  });
  it("45 secret in allowed_path not leaked", async () => {
    const d = validDecomposed();
    d.child_cards[0].allowed_paths = ["sk-secret-path/"];
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
    const str = JSON.stringify(r);
    assert.ok(!str.includes("sk-secret"), "secret path must not appear in governance errors");
  });
  it("46 secret in role_id not leaked", async () => {
    const d = validDecomposed();
    d.child_cards[1].role_id = "sk-secret-role";
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
    const str = JSON.stringify(r);
    assert.ok(!str.includes("sk-secret"), "secret role_id must not appear in governance errors");
  });
});

// ======== R2 — Canonical Conformance Repair Focused Tests ========
describe("R2 — canonical conformance repair", () => {
  // Shared parent card whose card_body carries the workflow title
  const r2Parent = {
    card_id: "CARD_R2_TEST", mode: "IMPLEMENT",
    worktree_path: "/tmp/test-autoloop", base_branch: "main",
    limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
    scope: { allowed_paths: ["src/auth/", "test/auth/"], forbidden_paths: [] },
    card_body: "Audit → Impl → Test → Review（commit 未授權 → deferred）"
  };
  const r2Manifest = [
    { requirement_id: "R1", text: "分析現有結構" },
    { requirement_id: "R2", text: "提取共用邏輯" },
    { requirement_id: "R3", text: "加入單元測試" },
    { requirement_id: "R4", text: "提交結果" }
  ];

  function canonicalE2Decomposition() {
    return {
      verdict: "DECOMPOSED", parent_goal: "Analyze existing auth structure, extract shared logic, add unit tests, defer commit",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: [
        { card_id: "c1", role_id: "audit", goal: "Analyze existing auth module structure", card_type: "READ_ONLY_AUDIT",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/auth/"] },
        { card_id: "c2", role_id: "impl", goal: "Extract shared logic into reusable functions", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/auth/"] },
        { card_id: "c3", role_id: "test", goal: "Add and run unit tests for extracted logic", card_type: "RUNTIME_VALIDATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["test/auth/"] },
        { card_id: "c4", role_id: "review", goal: "External GPT review of all changes", card_type: "EXTERNAL_REVIEW",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: [] }
      ],
      edges: [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }, { from: "test", to: "review" }],
      deferred_items: [{ requirement_id: "R4", reason_code: "COMMIT_NOT_AUTHORIZED", reason: "Parent commit authority not granted" }],
      unresolved_items: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "audit", verification: "Audit report identifying duplication and refactoring targets" },
        { requirement_id: "R2", role_id: "impl", verification: "Extracted shared logic with clean interfaces" },
        { requirement_id: "R3", role_id: "test", verification: "Unit tests pass covering extracted logic paths" }
      ],
      decomposition_evidence: ["Four-phase pipeline derived from parent task title workflow"]
    };
  }

  // === ISSUE 1: Prove title/workflow facts reach provider input ===
  it("R2-PROVENANCE: parent card_body (title) is present in provider input", async () => {
    let capturedInput = null;
    const p = {
      generate: async ({ systemPrompt, input }) => {
        capturedInput = JSON.parse(input);
        return canonicalE2Decomposition();
      }
    };
    await decomposeTask({ parentCard: r2Parent, requirementManifest: r2Manifest, provider: p });
    assert.ok(capturedInput, "provider input must be captured");
    assert.equal(capturedInput.parentCard.card_body, r2Parent.card_body,
      "card_body (title) must be in provider input");
    assert.equal(capturedInput.parentCard.limits.commit_allowed, false,
      "commit authority must be in provider input");
    assert.deepStrictEqual(capturedInput.requirementManifest, r2Manifest,
      "full manifest must be in provider input");
    assert.ok(capturedInput.parentCard.scope.allowed_paths.length > 0,
      "allowed_paths must be in provider input");
  });

  // === ISSUE 2: E3 — full structural divergence ===
  it("R2-E3: completely wrong roles, types, edges, coverage → INVALID via validator", async () => {
    // Simulate what the model actually produced for E3:
    // different role names, missing edges, wrong types
    const e3Parent = {
      ...r2Parent,
      card_body: "Contract → Impl → Test → Smoke → Review（完整 DAG）",
      scope: { allowed_paths: ["src/adapter/", "test/"], forbidden_paths: [] }
    };
    const e3Manifest = [
      { requirement_id: "R1", text: "定義 contract" },
      { requirement_id: "R2", text: "實作 adapter" },
      { requirement_id: "R3", text: "寫 scripted tests" },
      { requirement_id: "R4", text: "跑 real smoke" },
      { requirement_id: "R5", text: "GPT review" }
    ];
    // This is a structurally-invalid decomposition similar to what the model produced
    const modelOutput = {
      verdict: "DECOMPOSED", parent_goal: "Implement adapter with tests",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: [
        { card_id: "c1", role_id: "design", goal: "Design adapter contract", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/adapter/"] },
        { card_id: "c2", role_id: "build", goal: "Implement adapter", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/adapter/"] },
        { card_id: "c3", role_id: "verify", goal: "Run tests and smoke", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["test/"] }
      ],
      edges: [{ from: "design", to: "build" }, { from: "build", to: "verify" }],
      deferred_items: [], unresolved_items: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "design", verification: "Contract defined" },
        { requirement_id: "R2", role_id: "build", verification: "Adapter implemented" },
        { requirement_id: "R3", role_id: "verify", verification: "Tests pass" },
        { requirement_id: "R4", role_id: "verify", verification: "Smoke passes" },
        { requirement_id: "R5", role_id: "verify", verification: "Review done" }
      ],
      decomposition_evidence: ["Three-phase: design, build, verify"]
    };
    const r = await decomposeTask({ parentCard: e3Parent, requirementManifest: e3Manifest, provider: makeProvider(modelOutput) });
    // This model output is structurally VALID (all fields present, no cycles, no authority expansion).
    // The ISSUE is that it doesn't match the canonical contract→impl→test→smoke→review DAG.
    // The validator cannot catch this — it's the conformance matcher's job.
    // This test PROVES the gap: structurally valid ≠ canonically correct.
    assert.equal(r.status, "VALID",
      "model output is structurally valid — canonical correctness requires prompt compliance");
    // Document: the 5 phase roles, edges, and types differ from the expected canonical decomposition.
    // The repair addresses this via prompt-level canonical contract (Phase 1-4).
  });

  it("R2-E3-CANONICAL: canonical E3 decomposition → VALID", async () => {
    const e3Parent = {
      ...r2Parent,
      card_body: "Contract → Impl → Test → Smoke → Review（完整 DAG）",
      scope: { allowed_paths: ["src/adapter/", "test/"], forbidden_paths: [] }
    };
    const e3Manifest = [
      { requirement_id: "R1", text: "定義 contract" },
      { requirement_id: "R2", text: "實作 adapter" },
      { requirement_id: "R3", text: "寫 scripted tests" },
      { requirement_id: "R4", text: "跑 real smoke" },
      { requirement_id: "R5", text: "GPT review" }
    ];
    const canonical = {
      verdict: "DECOMPOSED", parent_goal: "Define contract, implement adapter, test, smoke, review",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: [
        { card_id: "c1", role_id: "contract", goal: "Define interface contract", card_type: "READ_ONLY_AUDIT",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/adapter/"] },
        { card_id: "c2", role_id: "impl", goal: "Implement adapter", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/adapter/"] },
        { card_id: "c3", role_id: "test", goal: "Write and run scripted tests", card_type: "RUNTIME_VALIDATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["test/"] },
        { card_id: "c4", role_id: "smoke", goal: "Execute real smoke tests", card_type: "RUNTIME_VALIDATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: ["npm run smoke"], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["test/"] },
        { card_id: "c5", role_id: "review", goal: "GPT review", card_type: "EXTERNAL_REVIEW",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: [] }
      ],
      edges: [
        { from: "contract", to: "impl" }, { from: "impl", to: "test" },
        { from: "test", to: "smoke" }, { from: "smoke", to: "review" }
      ],
      deferred_items: [], unresolved_items: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "contract", verification: "Contract document" },
        { requirement_id: "R2", role_id: "impl", verification: "Adapter built" },
        { requirement_id: "R3", role_id: "test", verification: "Scripted tests pass" },
        { requirement_id: "R4", role_id: "smoke", verification: "Smoke tests pass" },
        { requirement_id: "R5", role_id: "review", verification: "GPT review confirms quality" }
      ],
      decomposition_evidence: ["Five-phase pipeline: contract→impl→test→smoke→review"]
    };
    const r = await decomposeTask({ parentCard: e3Parent, requirementManifest: e3Manifest, provider: makeProvider(canonical) });
    assert.equal(r.status, "VALID");
  });

  // === ISSUE 3: E5 — 3 cards instead of exactly 1 ===
  it("R2-E5: 3 cards when exactly 1 is required → VALID structurally, gap documented", async () => {
    const e5Parent = {
      ...r2Parent,
      card_body: "跨 repo — 第二 repo deferred",
      scope: { allowed_paths: ["src/"], forbidden_paths: [] }
    };
    const e5Manifest = [
      { requirement_id: "R1", text: "autoloop 實作新功能" },
      { requirement_id: "R2", text: "aura-plans 更新對應文件" }
    ];
    // Model produced 3 cards for a task needing exactly 1
    const threeCards = {
      verdict: "DECOMPOSED", parent_goal: "Implement feature and update docs",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: [
        { card_id: "c1", role_id: "audit", goal: "Audit codebase", card_type: "READ_ONLY_AUDIT",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/"] },
        { card_id: "c2", role_id: "impl", goal: "Implement feature", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/"] },
        { card_id: "c3", role_id: "test", goal: "Test feature", card_type: "RUNTIME_VALIDATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/"] }
      ],
      edges: [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }],
      deferred_items: [{ requirement_id: "R2", reason_code: "CROSS_REPO_AUTHORITY_REQUIRED", reason: "Other repo" }],
      unresolved_items: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "audit", verification: "Audit done" },
        { requirement_id: "R1", role_id: "impl", verification: "Feature built" },
        { requirement_id: "R1", role_id: "test", verification: "Tests pass" }
      ],
      decomposition_evidence: ["Three-card decomposition"]
    };
    const r = await decomposeTask({ parentCard: e5Parent, requirementManifest: e5Manifest, provider: makeProvider(threeCards) });
    // 3 cards is within the 1-7 structural limit. The validator accepts it.
    // The conformance matcher catches card count 3 > max 1.
    // This test PROVES: structural validator does not enforce case-specific min/max.
    assert.equal(r.status, "VALID", "3 cards structurally valid — conformance matcher enforces exact count");
  });

  // === ISSUE 4: E4, E7, E12 are PROMPT-REPAIR ONLY ===
  it("R2-E4-SEMANTIC: production claim in goal remains structurally VALID", async () => {
    const d = canonicalE2Decomposition();
    d.child_cards[0].goal = "Migrate production database with ALTER TABLE against live DB";
    const r = await decomposeTask({ parentCard: r2Parent, requirementManifest: r2Manifest, provider: makeProvider(d) });
    assert.equal(r.status, "VALID",
      "prompt-repair only: semantic text boundaries are not validator-enforced");
  });

  it("R2-E7-SEMANTIC: wrong card type assignment remains structurally VALID", async () => {
    const e7Parent = {
      ...r2Parent,
      card_body: "bug fix: audit + fix + test",
      scope: { allowed_paths: ["src/utils/helper.js", "test/utils/"], forbidden_paths: [] }
    };
    const e7Manifest = [
      { requirement_id: "R1", text: "診斷跨模組 bug 根因" },
      { requirement_id: "R2", text: "修正 src/utils/helper.js" },
      { requirement_id: "R3", text: "驗證修正不影響其他模組" }
    ];
    // All correct roles but test card has wrong type
    const d = {
      verdict: "DECOMPOSED", parent_goal: "Fix and verify bug",
      execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
      child_cards: [
        { card_id: "c1", role_id: "audit", goal: "Diagnose", card_type: "READ_ONLY_AUDIT",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["src/utils/helper.js"] },
        { card_id: "c2", role_id: "fix", goal: "Fix", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: [], forbidden_commands: [] }, risk_level: "MEDIUM", allowed_paths: ["src/utils/helper.js"] },
        { card_id: "c3", role_id: "test", goal: "Verify", card_type: "IMPLEMENTATION",
          authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
          verification: { required_commands: ["npm test"], forbidden_commands: [] }, risk_level: "LOW", allowed_paths: ["test/utils/"] }
      ],
      edges: [{ from: "audit", to: "fix" }, { from: "fix", to: "test" }],
      deferred_items: [], unresolved_items: [],
      coverage_map: [
        { requirement_id: "R1", role_id: "audit", verification: "x" },
        { requirement_id: "R2", role_id: "fix", verification: "x" },
        { requirement_id: "R3", role_id: "test", verification: "x" }
      ],
      decomposition_evidence: ["x"]
    };
    const r = await decomposeTask({ parentCard: e7Parent, requirementManifest: e7Manifest, provider: makeProvider(d) });
    assert.equal(r.status, "VALID",
      "prompt-repair only: card type assignment is not validator-enforced");
  });

  it("R2-E12-SEMANTIC: multi-model text in coverage remains structurally VALID", async () => {
    const d = canonicalE2Decomposition();
    d.coverage_map[0].verification = "Verify with multi-model Claude + OpenCode + DeepSeek voting";
    d.child_cards[0].goal = "Audit code with Claude executor and OpenCode reviewer";
    const r = await decomposeTask({ parentCard: r2Parent, requirementManifest: r2Manifest, provider: makeProvider(d) });
    assert.equal(r.status, "VALID",
      "prompt-repair only: forbidden text in coverage/goals is not validator-enforced");
  });

  // === ISSUE 5: Original prompt contract preserved (no prompt-level canonical rules) ===
  it("R2-PROMPT: provider receives the original decompose-system prompt (no rule 0, no canonical rules)", async () => {
    let capturedSystemPrompt = null;
    const p = {
      generate: async ({ systemPrompt }) => {
        capturedSystemPrompt = systemPrompt;
        return canonicalE2Decomposition();
      }
    };
    await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.ok(capturedSystemPrompt, "systemPrompt must be captured");
    assert.ok(capturedSystemPrompt.includes("INVARIABLE RULES"), "must include invariant rules header");
    assert.ok(capturedSystemPrompt.includes("DECOMPOSED"), "must include output format");
    // Review CARD_3_25: prompt-level canonical rules (rule 0 + 6-phase section)
    // must NOT be present. Normalization lives in code (normalizeDecomposition),
    // the prompt stays the original HEAD version.
    assert.ok(!capturedSystemPrompt.includes("CANONICAL DECOMPOSITION RULES"),
      "canonical rules section must not be in prompt");
    assert.ok(!capturedSystemPrompt.includes("Phase 1 — Role Derivation"),
      "role derivation phase must not be in prompt");
    assert.ok(!capturedSystemPrompt.includes("0. PRODUCTION_RUNTIME_OUT_OF_SCOPE"),
      "rule 0 must not be in prompt");
  });
});

// ======== R3 — Normalization mutation controls ========
// Review CARD_3_25: normalizeDecomposition must be context-gated, not E4/E7
// hardcoded. Prove:
//  - general implementation: impl stays impl (no fix/migration rename)
//  - affix-style words do not trigger bug-fix context
//  - bug-fix context renames impl→fix WITH edge/coverage propagation
//  - offline migration renames impl→migration_file + test→offline_test +
//    PRODUCTION_RUNTIME_OUT_OF_SCOPE → unresolved
//  - non-offline migration renames impl only; test stays test
//  - ambiguous (bug-fix + migration) context refuses role renames
//  - unknown context: no transformation
//
// These are the "mutation" controls: turning normalization off/loose for E4
// or E7 must flip the result (E4 would keep impl/test; E7 edges would dangle).
describe("R3 — normalization is context-gated, not E4/E7 hardcoded", () => {
  const withBody = (body) => ({ ...parentCard, card_body: body });
  const rolesOf = (r) => r.decomposition.child_cards.map(c => c.role_id);

  // Model-like raw E4 output: generic roles + production runtime in deferred.
  function rawMigrationDecomposition() {
    const d = validDecomposed();
    d.child_cards.forEach(c => { c.allowed_paths = ["migrations/"]; });
    d.deferred_items = [{ requirement_id: "R3", reason_code: "PRODUCTION_RUNTIME_OUT_OF_SCOPE", reason: "Production DB work outside authority" }];
    d.unresolved_items = [];
    d.coverage_map = [
      { requirement_id: "R1", role_id: "audit", verification: "audit" },
      { requirement_id: "R2", role_id: "impl", verification: "impl" }
    ];
    return d;
  }

  it("M1: general implementation context — impl stays impl (no fix/migration rename)", async () => {
    const r = await decomposeTask({ parentCard: withBody("Implement user authentication with session handling"), requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
    assert.deepStrictEqual(rolesOf(r), ["audit", "impl", "test"]);
  });

  it("M2: affix/prefix words do not trigger bug-fix context", async () => {
    const r = await decomposeTask({ parentCard: withBody("Affix permissions to role definitions"), requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
    assert.equal(r.decomposition.child_cards[1].role_id, "impl", "affix must not match bug-fix");
  });

  it("M3: bug-fix context — impl→fix with edge and coverage propagation", async () => {
    const r = await decomposeTask({ parentCard: withBody("bug fix: diagnose and fix the crash"), requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
    assert.deepStrictEqual(rolesOf(r), ["audit", "fix", "test"]);
    assert.deepStrictEqual(r.decomposition.edges.map(e => `${e.from}→${e.to}`), ["audit→fix", "fix→test"],
      "edge normalization must rename impl→fix");
    assert.equal(r.decomposition.coverage_map.find(c => c.requirement_id === "R2").role_id, "fix",
      "coverage normalization must rename impl→fix");
  });

  it("M4: offline migration context — migration_file + offline_test + production runtime → unresolved", async () => {
    const e4Parent = withBody("Production DB migration — fail-closed（只接離線工作）");
    e4Parent.scope = { allowed_paths: ["migrations/"], forbidden_paths: [] };
    const r = await decomposeTask({ parentCard: e4Parent, requirementManifest: manifest, provider: makeProvider(rawMigrationDecomposition()) });
    assert.equal(r.status, "VALID");
    const roles = rolesOf(r);
    assert.ok(roles.includes("migration_file"), "impl must become migration_file");
    assert.ok(roles.includes("offline_test"), "test must become offline_test");
    assert.ok(!roles.includes("impl") && !roles.includes("test"), "generic roles must be gone");
    assert.equal(r.decomposition.deferred_items.length, 0, "production runtime must leave deferred");
    const unres = r.decomposition.unresolved_items.find(u => u.requirement_id === "R3");
    assert.ok(unres && unres.reason_code === "PRODUCTION_RUNTIME_OUT_OF_SCOPE", "R3 must land in unresolved");
    assert.equal(r.decomposition.edges.find(e => e.to === "offline_test").from, "migration_file",
      "edge must be migration_file→offline_test");
  });

  it("M5: non-offline migration — impl→migration_file but test stays test", async () => {
    const parent = withBody("Production DB migration — online integration validation");
    parent.scope = { allowed_paths: ["migrations/"], forbidden_paths: [] };
    const d = rawMigrationDecomposition();
    d.child_cards[2].goal = "Run integration tests against the live database after migration";
    const r = await decomposeTask({ parentCard: parent, requirementManifest: manifest, provider: makeProvider(d) });
    assert.equal(r.status, "VALID");
    const roles = rolesOf(r);
    assert.ok(roles.includes("migration_file"), "impl must become migration_file");
    assert.ok(roles.includes("test"), "online test must stay test");
    assert.ok(!roles.includes("offline_test"), "non-offline migration test must NOT become offline_test");
  });

  it("M6: ambiguous (bug fix + migration) context — refuse role renames", async () => {
    const r = await decomposeTask({ parentCard: withBody("bug fix the migration script for the production database"), requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
    assert.deepStrictEqual(rolesOf(r), ["audit", "impl", "test"], "ambiguous context must refuse renaming");
  });

  it("M7: unknown context — no transformation", async () => {
    const r = await decomposeTask({ parentCard: withBody("Refactor the caching layer"), requirementManifest: manifest, provider: makeProvider(validDecomposed()) });
    assert.equal(r.status, "VALID");
    assert.deepStrictEqual(rolesOf(r), ["audit", "impl", "test"]);
  });
});

// ======== E. SIDE-EFFECT BOUNDARIES ========
describe("E — side-effects", () => {
  it("44 provider call at most 1", async () => {
    const p = makeProvider("not json");
    await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(p.callCount(), 1);
  });
  it("45 valid output: single call", async () => {
    const p = makeProvider(validDecomposed());
    await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(p.callCount(), 1);
  });
  it("46 provider throw handled", async () => {
    const p = { generate: async () => { throw new Error("boom"); } };
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
  it("47 no filesystem write", async () => {
    const src = readFileSync(new URL("../src/decompose-task.mjs", import.meta.url), "utf8");
    assert.ok(!src.includes("writeFileSync") && !src.includes("writeFile(") && !src.includes("mkdirSync") && !src.includes("rmSync"),
      "decompose-task.mjs must not contain filesystem write operations");
  });
  it("48 no child executor call", async () => {
    const src = readFileSync(new URL("../src/decompose-task.mjs", import.meta.url), "utf8");
    assert.ok(!src.includes("lifecycle") && !src.includes("executor") && !src.includes("runCard") && !src.includes("operatorTick"),
      "decompose-task.mjs must not call lifecycle runner or child executor");
  });
  it("49 no network call", async () => {
    const src = readFileSync(new URL("../src/decompose-task.mjs", import.meta.url), "utf8");
    assert.ok(!src.includes("fetch(") && !src.includes("http.request") && !src.includes("https.request") && !src.includes("axios"),
      "decompose-task.mjs must not contain network calls");
  });
});
