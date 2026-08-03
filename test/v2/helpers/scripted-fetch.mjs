// test/v2/helpers/scripted-fetch.mjs
// 自含 scripted fetch（不 import probes/）— 供 transport adapter 測試模擬 DeepSeek SSE。

export function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
export const DONE = "data: [DONE]\n\n";

export function deltaContent(text) {
  return { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}
export function deltaReasoning(text) {
  return { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] };
}
export function usageChunk(input = 100, output = 50, reasoning = 20) {
  return { id: "c", object: "chat.completion.chunk", choices: [],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: input, completion_tokens_details: { reasoning_tokens: reasoning } } };
}
export function finishChunk(reason = "stop") {
  return { id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

function toBody(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    start(controller) {
      const push = () => {
        while (i < chunks.length) {
          const c = chunks[i++];
          controller.enqueue(enc.encode(c));
          if (c === DONE) { controller.close(); return; }
        }
        controller.close();
      };
      push();
    },
  });
}

export function okResponse(chunks) {
  return new Response(toBody(chunks), { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function errorResponse(status, message = "scripted error") {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { "content-type": "application/json" } });
}

export function redirectResponse(status, location) {
  return new Response(null, { status, headers: { location } });
}

/**
 * Scripted fetch：capture request body、回 scripted response、計數。
 * @param {(capturedBody: object|null, n: number) => Response} responder
 */
export function createScriptedFetch(responder, hooks = {}) {
  let n = 0;
  const captured = [];
  return (input, init) => {
    n += 1;
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    hooks.onRequest?.(url, init);
    let body = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { /* non-JSON */ }
    if (body) { captured.push(body); hooks.onCapture?.(body); }
    return Promise.resolve(responder(body, n));
  };
}
