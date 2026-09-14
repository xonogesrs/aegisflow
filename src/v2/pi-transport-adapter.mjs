// src/v2/pi-transport-adapter.mjs
//
// Formal Pi × DeepSeek structured transport adapter（V2 Card 4 Step 7）。
// 與 V1 並存；不切換 production runtime。
//
// 契約（V2 P0 freeze + C6）：
//   pinned @earendil-works/pi-ai@0.83.0（package.json 精確鎖定）
//   provider=deepseek, model=deepseek-v4-flash, reasoningEffort=high
//   maxTokens=4096, timeoutMs=120000, retries=0, requests=1
//   無 tools/tool_choice；response_format=json_object
//   fail-closed onPayload（provider/model/tools/thinking/effort/maxToken）
//   guarded fetch（1 request、host 檢查、redirect:"manual"、跨 host 拒絕、同 host 仍計 budget）
//   empty content / stopReason=length / provider error → HOLD
//   無 repair/retry/resample/fallback
//
// 不從 autoloop-analysis/probes/ import runtime code；本檔自含。

import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export const TRANSPORT_FREEZE = Object.freeze({
  package: "@earendil-works/pi-ai",
  version: "0.83.0",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseUrl: "https://api.deepseek.com",
  allowedHost: "api.deepseek.com",
  reasoningEffort: "high",
  maxTokens: 4096,
  timeoutMs: 120_000,
  maxRetries: 0,
  maxRequests: 1,
  responseFormat: Object.freeze({ type: "json_object" }),
  maxTokenField: "max_completion_tokens",
});

export class TransportError extends Error {
  constructor(code, message) {
    super(`[transport:${code}] ${message}`);
    this.code = code;
    this.name = "TransportError";
  }
}

/** 去敏 URL（不記錄 query/secret） */
export function redactUrl(url) {
  try {
    const u = new URL(String(url));
    return { host: u.host, pathname: u.pathname, hasQuery: u.search.length > 0 };
  } catch {
    return { raw: String(url).slice(0, 120) };
  }
}

/**
 * Fail-closed payload guard（onPayload）— 在 HTTP 送出前驗證/注入。
 * pi-ai openai-completions adapter 於 client.chat.completions.create() 之前執行 onPayload；
 * 拋錯則請求未送出。
 */
export function createPayloadGuard(freeze = TRANSPORT_FREEZE) {
  return (payload, model) => {
    if (model?.provider !== freeze.provider) {
      throw new TransportError("provider", `provider=${model?.provider} want=${freeze.provider}`);
    }
    if (payload?.model !== freeze.model) {
      throw new TransportError("model", `model=${payload?.model} want=${freeze.model}`);
    }
    if (payload.tools !== undefined || payload.tool_choice !== undefined) {
      throw new TransportError("tools", "tools/tool_choice present");
    }
    payload.response_format = { ...freeze.responseFormat };
    if (payload.thinking?.type !== "enabled") {
      throw new TransportError("thinking", `thinking=${payload.thinking?.type} want=enabled`);
    }
    if (payload.reasoning_effort !== freeze.reasoningEffort) {
      throw new TransportError("reasoning_effort", `reasoning_effort=${payload.reasoning_effort} want=${freeze.reasoningEffort}`);
    }
    if (payload[freeze.maxTokenField] !== freeze.maxTokens) {
      throw new TransportError("max_tokens", `${freeze.maxTokenField}=${payload[freeze.maxTokenField]} want=${freeze.maxTokens}`);
    }
    return payload;
  };
}

/**
 * Guarded fetch — 1 request、host 檢查、redirect:"manual" 攔截跨 host、同 host 遞迴仍計 budget。
 */
export function createGuardedFetch(freeze = TRANSPORT_FREEZE, realFetch = globalThis.fetch, onEvent = () => {}) {
  let count = 0;
  const guardFetch = async (input, init) => {
    count += 1;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? String(input);
    onEvent({ kind: "request", n: count, url: redactUrl(url), method: init?.method ?? "GET" });
    if (count > freeze.maxRequests) {
      throw new TransportError("request_count", `request #${count} exceeds max ${freeze.maxRequests}`);
    }
    const parsed = new URL(url);
    if (parsed.host !== freeze.allowedHost) {
      throw new TransportError("host", `host=${parsed.host} want=${freeze.allowedHost}`);
    }
    const res = await realFetch(input, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const loc = res.headers.get("location");
      let target;
      try {
        target = new URL(loc, url);
      } catch {
        throw new TransportError("redirect", `unparseable redirect location: ${loc}`);
      }
      if (target.host !== freeze.allowedHost) {
        throw new TransportError("redirect", `cross-host redirect ${parsed.host} -> ${target.host}`);
      }
      onEvent({ kind: "redirect_same_host", status: res.status, to: target.host });
      return guardFetch(target.href, init); // 同 host 遞迴仍計入 budget
    }
    onEvent({ kind: "response", n: count, status: res.status });
    return res;
  };
  return { fetch: guardFetch, count: () => count };
}

/** Strict JSON parse：只接受完整、無 fence、無尾註的 JSON object */
export function strictParse(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return { ok: false, reason: "empty" };
  const t = raw.trim();
  if (t.startsWith("```")) return { ok: false, reason: "markdown_fence" };
  let value;
  try {
    value = JSON.parse(t);
  } catch {
    return { ok: false, reason: "not_strict_json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not_object" };
  }
  return { ok: true, value };
}

/**
 * 建立正式 transport adapter。
 * @param {object} [opts] { fetchImpl, allowMissingKey (test-only), onEvent }
 */
export function createPiTransportAdapter(opts = {}) {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel(TRANSPORT_FREEZE.provider, TRANSPORT_FREEZE.model);
  if (!model) {
    return {
      error: "model_not_found",
      generate: async () => ({ status: "error", reason: "model_not_found" }),
    };
  }

  const onEvent = opts.onEvent || (() => {});
  const { fetch: guardedFetch, count } = createGuardedFetch(TRANSPORT_FREEZE, opts.fetchImpl || globalThis.fetch, onEvent);
  // allowMissingKey：test-only。僅供 scripted-fetch 測試繞過 ambient credential 解析；
  // production 呼叫端不得傳入，真實請求仍需有效 API key（fail-closed 不變）。
  const authOverride = opts.allowMissingKey === true ? { apiKey: "test-only-no-key" } : {};

  async function generate({ systemPrompt, input, maxTokens = TRANSPORT_FREEZE.maxTokens, reasoningEffort = TRANSPORT_FREEZE.reasoningEffort }) {
    const t0 = Date.now();
    let stream;
    try {
      stream = models.stream(model, {
        systemPrompt,
        messages: [{ role: "user", content: input, timestamp: Date.now() }],
      }, {
        fetch: guardedFetch,
        onPayload: createPayloadGuard(TRANSPORT_FREEZE),
        reasoningEffort,
        maxTokens,
        timeoutMs: TRANSPORT_FREEZE.timeoutMs,
        maxRetries: 0,
        ...authOverride,
      });
    } catch (e) {
      return { status: "error", reason: "stream_setup_failed", errorMessage: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }

    let msg;
    try {
      for await (const _ of stream) { /* drain */ }
      msg = await stream.result();
    } catch (e) {
      return { status: "error", reason: "stream_consume_failed", errorMessage: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }

    const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const thinking = (msg.content || []).filter(b => b.type === "thinking").map(b => b.thinking).join("");

    // fail-closed 判定（C6/P0）：不 repair、不 retry、不 resample、不 fallback
    if (msg.stopReason === "error" || msg.stopReason === "aborted") {
      return { status: "error", reason: "provider_error", stopReason: msg.stopReason, errorMessage: msg.errorMessage || null, elapsedMs: Date.now() - t0, requestCount: count() };
    }
    if (msg.stopReason === "length") {
      return { status: "hold", reason: "stopReason_length", elapsedMs: Date.now() - t0, requestCount: count() };
    }
    if (!text.trim()) {
      return { status: "hold", reason: "empty_content", thinkingChars: thinking.length, elapsedMs: Date.now() - t0, requestCount: count() };
    }
    const parsed = strictParse(text);
    if (!parsed.ok) {
      return { status: "hold", reason: `non_strict_json:${parsed.reason}`, elapsedMs: Date.now() - t0, requestCount: count() };
    }

    return {
      status: "completed",
      content: text,
      parsed: parsed.value,
      thinking,
      usage: msg.usage || null,
      stopReason: msg.stopReason,
      elapsedMs: Date.now() - t0,
      requestCount: count(),
    };
  }

  return { generate, getRequestCount: count, model, freeze: TRANSPORT_FREEZE };
}
