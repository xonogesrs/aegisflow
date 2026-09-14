// test/v2/test-pi-transport-adapter.mjs
// Formal Pi transport adapter — scripted fetch 測試（零真實 API；Step 7/8）。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPiTransportAdapter, createPayloadGuard, createGuardedFetch, strictParse, TRANSPORT_FREEZE,
} from "../../src/v2/pi-transport-adapter.mjs";
import {
  DONE, deltaContent, deltaReasoning, finishChunk, okResponse, errorResponse,
  redirectResponse, sse, usageChunk, createScriptedFetch,
} from "./helpers/scripted-fetch.mjs";
import { validateIRShape } from "../../src/v2/ir-schema.mjs";

function adapterWith(fetchImpl, hooks) {
  return createPiTransportAdapter({ fetchImpl, allowMissingKey: true, onEvent: hooks?.onEvent });
}

const GOOD_IR = {
  verdict: "DECOMPOSED",
  parent_goal: "g",
  execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
  phases: [{
    phase_id: "p1", title: "p1", summary: "p1", responsibility: "p1", purpose: "implementation",
    effects: { artifact_mutation: "required", runtime_side_effect: "forbidden", external_system_mutation: "forbidden",
      evidence_output: "none", boundaries: { artifact: ["src/"], runtime: [], external_system: [], evidence: [] } },
    covers: [{ requirement_id: "R1", completeness: "complete", claim: "x" }],
    depends_on: [],
  }],
  dispositions: [],
  decomposition_evidence: ["e"],
};

test("payload guard: success injects response_format, verifies frozen fields", () => {
  const guard = createPayloadGuard();
  const payload = {
    model: "deepseek-v4-flash",
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    max_completion_tokens: 4096,
  };
  const result = guard(payload, { provider: "deepseek" });
  assert.deepEqual(result.response_format, { type: "json_object" });
});

test("payload guard: wrong provider throws", () => {
  const guard = createPayloadGuard();
  assert.throws(() => guard({ model: "deepseek-v4-flash" }, { provider: "openai" }), /transport:provider/);
});

test("payload guard: tools present throws", () => {
  const guard = createPayloadGuard();
  const payload = { model: "deepseek-v4-flash", tools: [], thinking: { type: "enabled" }, reasoning_effort: "high", max_completion_tokens: 4096 };
  assert.throws(() => guard(payload, { provider: "deepseek" }), /transport:tools/);
});

test("payload guard: wrong reasoning effort throws", () => {
  const guard = createPayloadGuard();
  const payload = { model: "deepseek-v4-flash", thinking: { type: "enabled" }, reasoning_effort: "low", max_completion_tokens: 4096 };
  assert.throws(() => guard(payload, { provider: "deepseek" }), /transport:reasoning_effort/);
});

test("transport: strict JSON success → completed with parsed", async () => {
  let captured = null;
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaReasoning("thinking...")), sse(deltaContent(JSON.stringify(GOOD_IR))),
      sse(usageChunk()), sse(finishChunk("stop")), DONE]),
    { onCapture: (b) => (captured = b) });
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "completed");
  assert.ok(r.parsed.verdict === "DECOMPOSED");
  assert.equal(r.stopReason, "stop");
  assert.ok(r.usage.totalTokens > 0);
  assert.equal(adapter.getRequestCount(), 1);
  // payload guard 已注入
  assert.deepEqual(captured.response_format, { type: "json_object" });
  assert.equal(captured.thinking.type, "enabled");
  assert.equal(captured.reasoning_effort, "high");
  assert.equal(captured.max_completion_tokens, 4096);
  assert.equal(captured.tools, undefined);
  assert.equal(captured.tool_choice, undefined);
  assert.equal(captured.model, "deepseek-v4-flash");
});

test("transport: no reasoning effort → guard throws → zero HTTP request", async () => {
  let realCalls = 0;
  const fetchImpl = createScriptedFetch(() => okResponse([sse(finishChunk("stop")), DONE]),
    { onRequest: () => realCalls++ });
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i", reasoningEffort: "low" });
  assert.equal(r.status, "error");
  assert.match(r.errorMessage || "", /reasoning_effort/);
  assert.equal(realCalls, 0, "zero HTTP request when guard fails");
});

test("transport: empty content → HOLD", async () => {
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaReasoning("no content here")), sse(finishChunk("stop")), DONE]));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "hold");
  assert.equal(r.reason, "empty_content");
});

test("transport: stopReason length → HOLD", async () => {
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaContent('{"verdict":')), sse(finishChunk("length")), DONE]));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "hold");
  assert.equal(r.reason, "stopReason_length");
});

test("transport: markdown fence → non_strict_json HOLD", async () => {
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaContent("```json\n" + JSON.stringify(GOOD_IR) + "\n```")), sse(finishChunk("stop")), DONE]));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "hold");
  assert.match(r.reason, /non_strict_json/);
});

test("transport: 429 → zero retry, status error", async () => {
  const fetchImpl = createScriptedFetch(() => errorResponse(429, "rate limited"));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "error");
  assert.equal(adapter.getRequestCount(), 1, "exactly 1 request, no retry");
});

test("transport: 500 → zero retry, status error", async () => {
  const fetchImpl = createScriptedFetch(() => errorResponse(500, "boom"));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "error");
  assert.equal(adapter.getRequestCount(), 1);
});

test("netguard: wrong host → error, realFetch never called", async () => {
  let realCalls = 0;
  const { fetch: gf } = createGuardedFetch(TRANSPORT_FREEZE, async () => { realCalls++; return okResponse([]); });
  await assert.rejects(() => gf("https://evil.example.com/x"), /host/);
  assert.equal(realCalls, 0, "zero real HTTP requests on wrong host");
});

test("netguard: cross-host redirect → failure", async () => {
  let realCalls = 0;
  const { fetch: gf } = createGuardedFetch(TRANSPORT_FREEZE,
    async () => { realCalls++; return redirectResponse(302, "https://evil.example.com/steal"); });
  await assert.rejects(() => gf("https://api.deepseek.com/v1/chat/completions", { method: "POST" }), /cross-host redirect/);
  assert.equal(realCalls, 1, "initial call made, redirect blocked");
});

test("netguard: same-host redirect counts toward budget → second request fails", async () => {
  let realCalls = 0;
  const { fetch: gf, count } = createGuardedFetch(TRANSPORT_FREEZE,
    async () => { realCalls++; return redirectResponse(301, "https://api.deepseek.com/v1/chat/completions"); });
  // 第一次：初始 + 同 host redirect = 2 次 → 超 budget → error
  await assert.rejects(() => gf("https://api.deepseek.com/v1/chat/completions", { method: "POST" }), /request #2 exceeds/);
  assert.equal(realCalls, 1);
});

test("transport: schema invalid JSON → completed by transport, HOLD at validator layer", async () => {
  const badIR = { verdict: "DECOMPOSED" }; // missing phases/parent_goal
  const fetchImpl = createScriptedFetch(() =>
    okResponse([sse(deltaContent(JSON.stringify(badIR))), sse(finishChunk("stop")), DONE]));
  const adapter = adapterWith(fetchImpl);
  const r = await adapter.generate({ systemPrompt: "s", input: "i" });
  assert.equal(r.status, "completed");
  assert.equal(validateIRShape(r.parsed).valid, false, "validator rejects schema-invalid output (HOLD at validator)");
});

test("strictParse rejects fences/trailing prose/arrays", () => {
  assert.equal(strictParse("```json\n{}\n```").ok, false);
  assert.equal(strictParse('{"a":1} trailing').ok, false);
  assert.equal(strictParse("[1,2]").ok, false);
  assert.equal(strictParse('{"a":1}').ok, true);
  assert.equal(strictParse("").ok, false);
});
