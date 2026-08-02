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
