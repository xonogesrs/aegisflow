// test/v2/test-production-pipeline.mjs
//
// C2 — Production decomposition pipeline tests.
// Offline only: scripted/fake decomposition adapter, no provider, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// P7 subtraction re-point: the production pipeline now lives in the OPTIONAL
// orchestration layer (src/orchestration/decomposition/production-pipeline.mjs);
// its contract is unchanged and is still proven by this suite.
import { runProductionPipeline } from "../../src/orchestration/decomposition/production-pipeline.mjs";

// ── Handcrafted valid DECOMPOSED IR（no case oracle involved）──

export const VALID_IR = {
  verdict: "DECOMPOSED",
  parent_goal: "implement the change",
  execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
  phases: [
    {
      phase_id: "p_analysis",
      title: "Analysis",
      summary: "Read-only analysis",
      responsibility: "Produce analysis findings for R1",
      purpose: "analysis",
      effects: {
        artifact_mutation: "forbidden",
        runtime_side_effect: "forbidden",
        external_system_mutation: "forbidden",
        evidence_output: "ephemeral",
        boundaries: { artifact: [], runtime: [], external_system: [], evidence: [] },
      },
      covers: [{ requirement_id: "R1", completeness: "complete", claim: "analysis covers R1" }],
      depends_on: [],
    },
    {
      phase_id: "p_impl",
      title: "Implementation",
      summary: "Implement the change",
      responsibility: "Implement R2",
      purpose: "implementation",
      effects: {
        artifact_mutation: "required",
        runtime_side_effect: "forbidden",
        external_system_mutation: "forbidden",
        evidence_output: "persistent",
        boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: ["evidence/"] },
      },
      covers: [{ requirement_id: "R2", completeness: "complete", claim: "implements R2" }],
      depends_on: ["p_analysis"],
    },
  ],
  dispositions: [],
  decomposition_evidence: ["test evidence"],
};

export const VALID_MANIFEST = [
  { requirement_id: "R1", text: "analyze the current state" },
  { requirement_id: "R2", text: "implement the change" },
];

export const VALID_PARENT = { scope: { allowed_paths: ["src/"], forbidden_paths: [] } };

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function adapterFor(ir) {
  return {
    generate: async () => ({
      status: "completed",
      parsed: ir,
      content: JSON.stringify(ir),
      thinking: "",
      usage: null,
      stopReason: "stop",
      elapsedMs: 1,
      requestCount: 1,
    }),
  };
}

function failAdapter(status, reason) {
  return {
    generate: async () => ({ status, reason, elapsedMs: 1, requestCount: 1 }),
  };
}

test("T1: valid DECOMPOSED → final PASS, stage scorecard, one request", async () => {
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(VALID_IR),
  });
  assert.equal(r.final, "PASS");
  assert.equal(r.stage, "scorecard");
  assert.equal(r.reason, null);
  assert.equal(r.transport.requestCount, 1);
  assert.equal(r.ir.verdict, "DECOMPOSED");
});

test("T2: NOT_BENEFICIAL → final NOT_BENEFICIAL, zero lifecycle calls (no phases)", async () => {
  const ir = {
    verdict: "DECOMPOSITION_NOT_BENEFICIAL",
    reason: "already satisfied",
    dispositions: [
      { requirement_id: "R1", disposition: "not_beneficial", reason_code: "ALREADY_SATISFIED", evidence: "nothing to change" },
    ],
    decomposition_evidence: ["test"],
  };
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(ir),
  });
  assert.equal(r.final, "NOT_BENEFICIAL");
  assert.equal(r.stage, "decomposition_verdict");
  assert.equal(r.ir.verdict, "DECOMPOSITION_NOT_BENEFICIAL");
});

test("T3: DECOMPOSITION_BLOCKED → final HOLD, reason DECOMPOSITION_BLOCKED", async () => {
  const ir = {
    verdict: "DECOMPOSITION_BLOCKED",
    dispositions: [
      { requirement_id: "R1", disposition: "unresolved", reason_code: "AMBIGUOUS_SCOPE", question: "which module?" },
    ],
    decomposition_evidence: ["test"],
  };
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(ir),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.reason, "DECOMPOSITION_BLOCKED");
  assert.equal(r.stage, "decomposition_verdict");
});

test("T4: schema failure → HOLD at schema stage", async () => {
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor({ verdict: "DECOMPOSED" }), // missing phases/dispositions/evidence
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.stage, "schema");
  assert.ok(r.hardFailures.length > 0);
});

test("T5: semantic failure → HOLD at semantic stage", async () => {
  const ir = clone(VALID_IR);
  ir.phases[1].covers = []; // R2 now uncovered → H4 failure at semantic stage
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(ir),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.stage, "semantic");
  assert.ok(r.hardFailures.some((f) => f.startsWith("H4:")));
});

test("T6: structural failure → HOLD at structural stage", async () => {
  const ir = clone(VALID_IR);
  ir.phases[1].effects.boundaries.artifact = []; // required mutation without boundary → H7
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(ir),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.stage, "structural");
});

test("T7: transport failure → HOLD at transport stage, no request leakage", async () => {
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: failAdapter("hold", "non_strict_json:markdown_fence"),
  });
  assert.equal(r.final, "HOLD");
  assert.equal(r.stage, "transport");
  assert.ok(r.reason.includes("non_strict_json"));
});

test("T8: production pipeline never invokes the case evaluator", async () => {
  // Source-level: no case oracle imports in the production path.
  const src = readFileSync(new URL("../../src/orchestration/decomposition/production-pipeline.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("case-evaluator"), "production pipeline must not import case-evaluator");
  assert.ok(!src.includes("case-contracts"), "production pipeline must not import case-contracts");
  assert.ok(!src.includes("CONTRACTS_BY_ID"), "production pipeline must not reference eval contracts");
  // Behavior-level: scorecard runs without a contract → zero case failures.
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapterFor(VALID_IR),
  });
  assert.deepEqual(r.scorecard.caseFailures, []);
  assert.deepEqual(r.scorecard.caseCodes, []);
});

test("T9: no second request / no repair on pipeline failures", async () => {
  let calls = 0;
  const adapter = {
    generate: async () => {
      calls += 1;
      return { status: "hold", reason: "empty_content", elapsedMs: 1, requestCount: calls };
    },
  };
  const r = await runProductionPipeline({
    source: { goal: "g", requirements: VALID_MANIFEST, authority: {} },
    parent: VALID_PARENT,
    manifest: VALID_MANIFEST,
    decompositionAdapter: adapter,
  });
  assert.equal(r.final, "HOLD");
  assert.equal(calls, 1, "exactly one provider request, never retried");
});
