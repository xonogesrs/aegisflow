// test/v2/test-pipeline.mjs
// V2 Card 5 — pipeline boundary 測試：固定順序、HOLD 不進 runner、
// NOT_BENEFICIAL 無 actionable phases、request count = 1、fail-closed。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPiTransportAdapter, TRANSPORT_FREEZE } from "../../src/v2/pi-transport-adapter.mjs";
import { runV2Pipeline, PIPELINE_STAGES } from "../../src/v2/pipeline.mjs";
import { CONTRACTS_BY_ID, applyMutation } from "../../src/v2/case-contracts.mjs";
import { probeSource } from "./test-prompt-builder.mjs";
import {
  DONE, deltaContent, deltaReasoning, finishChunk, okResponse, errorResponse,
  sse, usageChunk, createScriptedFetch,
} from "./helpers/scripted-fetch.mjs";

const E2 = "E2";
const PARENT_E2 = { scope: { allowed_paths: ["src/auth/", "test/auth/"], forbidden_paths: [] } };

function adapterReturningJson(json, hooks) {
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaReasoning("thinking...")), sse(deltaContent(JSON.stringify(json))),
      sse(usageChunk()), sse(finishChunk("stop")), DONE]),
    { onRequest: (u) => hooks?.onRequest?.(u) });
  return createPiTransportAdapter({ fetchImpl, allowMissingKey: true });
}

const PASSING_IR = CONTRACTS_BY_ID.E2.accepted_examples[1]; // 5-phase E2（deterministic 測試輸入）

test("固定 pipeline stage 順序", () => {
  assert.deepEqual(PIPELINE_STAGES, ["transport", "schema", "structural", "semantic", "case", "scorecard", "runner"]);
});

test("PASS IR → stage=runner, verdict=PASS, 有排程且無 single-writer violation", async () => {
  const adapter = adapterReturningJson(PASSING_IR);
  const r = await runV2Pipeline({
    source: probeSource(E2),
    parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements,
    contract: CONTRACTS_BY_ID.E2,
    adapter,
    execute: async () => ({ status: "passed" }),
  });
  assert.equal(r.stage, "runner", r.hardFailures?.join("; "));
  assert.equal(r.verdict, "PASS");
  assert.ok(r.run, "runner must have executed");
  assert.equal(r.run.writerViolations.length, 0);
  assert.equal(r.run.leaseHolderAfter, null);
  assert.equal(adapter.getRequestCount(), 1, "exactly one provider request");
});

test("schema invalid → 停在 schema stage（先於 semantic/scorecard）", async () => {
  const adapter = adapterReturningJson({ verdict: "DECOMPOSED" }); // 缺 phases/parent_goal
  const r = await runV2Pipeline({
    source: probeSource(E2), parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
  });
  assert.equal(r.stage, "schema");
  assert.equal(r.verdict, "HOLD");
  assert.ok(!r.run, "runner must not run");
});

test("semantic failure → 停在 semantic stage（順序在 schema 之後）", async () => {
  // drop R2 coverage → H4/Z1 failure（structural 仍 pass）
  const bad = applyMutation(PASSING_IR, { op: "drop_coverage", requirement_id: "R2" });
  const adapter = adapterReturningJson(bad);
  const r = await runV2Pipeline({
    source: probeSource(E2), parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
  });
  assert.equal(r.stage, "semantic");
  assert.equal(r.verdict, "HOLD");
  assert.ok(!r.run, "runner must not run");
});

test("case-contract failure → 停在 case stage", async () => {
  // R4 disposition 錯 code → case invariant disposition 失敗
  const bad = applyMutation(PASSING_IR, { op: "change_disposition", requirement_id: "R4", to: "unresolved", reason_code: "CYCLIC_DEPENDENCY" });
  const adapter = adapterReturningJson(bad);
  const r = await runV2Pipeline({
    source: probeSource(E2), parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
  });
  assert.equal(r.stage, "case");
  assert.equal(r.verdict, "HOLD");
});

test("HOLD（任一 stage）不得進 runner", async () => {
  // 多種 HOLD 路徑：transport（provider error）、schema、semantic、case
  const cases = [
    {
      name: "transport",
      fetch: () => errorResponse(500, "boom"),
      json: null,
    },
    {
      name: "schema",
      json: { verdict: "DECOMPOSED" }, // 缺 phases/parent_goal
    },
    {
      name: "semantic",
      json: applyMutation(PASSING_IR, { op: "drop_coverage", requirement_id: "R2" }),
    },
    {
      name: "case",
      json: applyMutation(PASSING_IR, { op: "change_disposition", requirement_id: "R4", to: "unresolved", reason_code: "CYCLIC_DEPENDENCY" }),
    },
  ];
  for (const c of cases) {
    const fetchImpl = c.fetch
      ? c.fetch()
      : createScriptedFetch(() =>
          okResponse([sse(deltaReasoning("r")), sse(deltaContent(JSON.stringify(c.json))), sse(usageChunk()), sse(finishChunk("stop")), DONE]));
    const adapter = createPiTransportAdapter({ fetchImpl });
    const r = await runV2Pipeline({
      source: probeSource(E2), parent: PARENT_E2,
      manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
    });
    assert.equal(r.verdict, "HOLD", `${c.name}: verdict ${r.verdict}`);
    assert.ok(!r.run, `${c.name}: HOLD must not enter runner`);
  }
});

test("NOT_BENEFICIAL → 不產生 actionable phases（不進 runner）", async () => {
  const adapter = adapterReturningJson(CONTRACTS_BY_ID.E1.accepted_examples[0]);
  const r = await runV2Pipeline({
    source: probeSource("E1"),
    parent: { scope: { allowed_paths: ["README.md"], forbidden_paths: [] } },
    manifest: [],
    contract: CONTRACTS_BY_ID.E1,
    adapter,
  });
  assert.equal(r.stage, "scorecard");
  assert.equal(r.verdict, "NOT_BENEFICIAL");
  assert.ok(!r.run, "NOT_BENEFICIAL must not produce actionable phases");
});

test("strict JSON fail-closed：非 JSON → transport stage HOLD", async () => {
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaReasoning("r")), sse(deltaContent("Some prose answer, not JSON.")), sse(finishChunk("stop")), DONE]));
  const adapter = createPiTransportAdapter({ fetchImpl });
  const r = await runV2Pipeline({
    source: probeSource(E2), parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
  });
  assert.equal(r.stage, "transport");
  assert.equal(r.verdict, "HOLD");
  assert.match(r.hardFailures[0], /transport/);
});

test("provider error 不觸發第二 request（request count 保持 1）", async () => {
  let calls = 0;
  const fetchImpl = createScriptedFetch(() => {
    calls += 1;
    return errorResponse(500, "boom");
  });
  const adapter = createPiTransportAdapter({ fetchImpl, allowMissingKey: true });
  const r = await runV2Pipeline({
    source: probeSource(E2), parent: PARENT_E2,
    manifest: CONTRACTS_BY_ID.E2.requirements, contract: CONTRACTS_BY_ID.E2, adapter,
  });
  assert.equal(r.stage, "transport");
  assert.equal(r.verdict, "HOLD");
  assert.equal(calls, 1, "exactly one HTTP request, no retry on provider error");
  assert.equal(adapter.getRequestCount(), 1);
});

test("H11 transport freeze 由 adapter 強制（tools 禁止、response_format、effort、maxTokens）", async () => {
  assert.equal(TRANSPORT_FREEZE.maxRetries, 0);
  assert.equal(TRANSPORT_FREEZE.maxRequests, 1);
  assert.deepEqual(TRANSPORT_FREEZE.responseFormat, { type: "json_object" });
  assert.equal(TRANSPORT_FREEZE.model, "deepseek-v4-flash");
  assert.equal(TRANSPORT_FREEZE.reasoningEffort, "high");
  assert.equal(TRANSPORT_FREEZE.maxTokens, 4096);
  assert.equal(TRANSPORT_FREEZE.timeoutMs, 120000);
  assert.equal(TRANSPORT_FREEZE.provider, "deepseek");
});
