// test/test-decompose-shadow.mjs
//
// Card 2 — Shadow-mode decomposer scripted tests.
// 36 test cases covering valid, invalid, parsing, validation, input, side-effects.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { decomposeTask } from "../src/decompose-task.mjs";
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parentCard = {
  card_id: "CARD_TEST_2",
  mode: "IMPLEMENT",
  worktree_path: "/tmp/test-autoloop",
  base_branch: "main",
  limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
  scope: { allowed_paths: ["src/", "test/"], forbidden_paths: ["src/secrets/"] },
  card_body: "Test parent task"
};

const manifest = [
  { requirement_id: "R1", text: "analyze" },
  { requirement_id: "R2", text: "implement" },
  { requirement_id: "R3", text: "test" }
];

// --- Scripted provider ---
function makeProvider(output, opts = {}) {
  let callCount = 0;
  return {
    callCount: () => callCount,
    generate: async () => { callCount++; return output; }
  };
}

// --- Valid decompositions for scripted use ---
function validDecomposed() {
  return {
    verdict: "DECOMPOSED",
    parent_goal: "Implement test feature",
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

// ======== A. THREE VALID VERDICTS ========

describe("A — valid verdicts", () => {
  it("1 — DECOMPOSITION_NOT_BENEFICIAL", async () => {
    const output = { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "too small", decomposition_evidence: ["e"] };
    const p = makeProvider(output);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID");
    assert.equal(p.callCount(), 1);
  });

  it("2 — DECOMPOSED", async () => {
    const p = makeProvider(validDecomposed());
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID");
    assert.equal(p.callCount(), 1);
    assert.equal(r.decomposition.verdict, "DECOMPOSED");
  });

  it("3 — DECOMPOSITION_BLOCKED", async () => {
    const output = { verdict: "DECOMPOSITION_BLOCKED",
      unresolved_items: [{ requirement_id: "R1", reason_code: "CYCLIC_DEPENDENCY", question: "?" }],
      decomposition_evidence: ["e"] };
    const p = makeProvider(output);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID");
    assert.equal(p.callCount(), 1);
  });
});

// ======== B. PROVIDER OUTPUT PARSING ========

describe("B — provider output parsing", () => {
  it("4 — accepts JSON string", async () => {
    const p = makeProvider(JSON.stringify(validDecomposed()));
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID");
  });

  it("5 — accepts object", async () => {
    const p = makeProvider(validDecomposed());
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "VALID");
  });

  it("6 — rejects non-JSON string", async () => {
    const p = makeProvider("not json at all");
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });

  it("7 — rejects markdown-fenced JSON", async () => {
    const p = makeProvider("```json\n" + JSON.stringify(validDecomposed()) + "\n```");
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });

  it("8 — rejects JSON with explanatory text", async () => {
    const p = makeProvider("Here is the result:\n" + JSON.stringify(validDecomposed()));
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });

  it("9 — rejects empty string", async () => {
    const p = makeProvider("");
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });

  it("10 — rejects null", async () => {
    const p = makeProvider(null);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });

  it("11 — rejects array", async () => {
    const p = makeProvider([1, 2, 3]);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
  });
});

// ======== C. VALIDATOR INTEGRATION ========

describe("C — validator integration", () => {
  it("12 — unknown verdict → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.verdict = "UNKNOWN";
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("13 — missing child_cards → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); delete d.child_cards;
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("14 — duplicate card_id → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[1].card_id = "c1";
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("15 — duplicate role_id → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[1].role_id = "audit";
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("16 — unknown edge role → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.edges.push({ from: "audit", to: "nonexistent" });
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("17 — self edge → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.edges.push({ from: "audit", to: "audit" });
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("18 — cycle → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed();
    d.edges = [{ from: "audit", to: "impl" }, { from: "impl", to: "test" }, { from: "test", to: "audit" }];
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("19 — authority expansion → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[0].allowed_paths = ["etc/"];
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("20 — commit_allowed=true → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[0].authority_required.commit_allowed = true;
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("21 — push_allowed=true → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[0].authority_required.push_allowed = true;
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("22 — __any__ role_id → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.child_cards[0].role_id = "__any__";
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("23 — missing requirement disposition → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed(); d.coverage_map = d.coverage_map.slice(0, 2);
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("24 — coverage orphan role → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed();
    d.coverage_map.push({ requirement_id: "R3", role_id: "nonexistent", verification: "x" });
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });

  it("25 — execution_policy deviation → INVALID_DECOMPOSITION", async () => {
    const d = validDecomposed();
    d.execution_policy = { executor: "CLAUDE", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false };
    const p = makeProvider(d);
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_DECOMPOSITION");
  });
});

// ======== D. INPUT FAIL-CLOSED ========

describe("D — input fail-closed", () => {
  it("26 — missing parentCard", async () => {
    const r = await decomposeTask({ requirementManifest: manifest, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });

  it("27 — missing manifest", async () => {
    const r = await decomposeTask({ parentCard, provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });

  it("28 — empty manifest", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: [], provider: makeProvider({}) });
    assert.equal(r.status, "INVALID_INPUT");
  });

  it("29 — missing provider", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest });
    assert.equal(r.status, "INVALID_INPUT");
  });

  it("30 — provider missing generate", async () => {
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: {} });
    assert.equal(r.status, "INVALID_INPUT");
  });
});

// ======== E. SIDE-EFFECT BOUNDARIES ========

describe("E — side-effect boundaries", () => {
  it("31 — invalid output: single provider call", async () => {
    const p = makeProvider("not json");
    await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(p.callCount(), 1);
  });

  it("32 — provider call succeeds with 1 call", async () => {
    const p = makeProvider(validDecomposed());
    await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(p.callCount(), 1);
  });

  it("33 — provider throw → INVALID_PROVIDER_OUTPUT", async () => {
    const p = { generate: async () => { throw new Error("boom"); }, callCount: () => 1 };
    const r = await decomposeTask({ parentCard, requirementManifest: manifest, provider: p });
    assert.equal(r.status, "INVALID_PROVIDER_OUTPUT");
    assert.equal(r.reason_code, "DECOMPOSITION_PROVIDER_CALL_FAILED");
  });
});
