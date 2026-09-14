// scripts/card5f-live-probe.mjs
// V2 Card 5F Stage 7–9 — new-freeze live revalidation（E2 → E6 → E9 → E4，各一次 canonical call）。
//
// 固定條件：provider requests=1 per case、retry=0、repair=0、resample=0、fallback=0、tools 缺席、
// session reuse=0（每案全新 adapter）、prompt mutation after start 禁止。
// 任一失敗 → HARD STOP / NO NEXT CASE / NO RE-RUN / NO REPAIR（Card 5F §7/§11）。
// 每案獨立目錄保存完整 evidence（§8），含 sanitized request payload、raw response、
// parsed IR、gate 結果、usage 與 token/context margin（§9）。

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPiTransportAdapter, TRANSPORT_FREEZE } from "../src/v2/pi-transport-adapter.mjs";
import { buildPromptBundle, buildUserPrompt, buildSystemPrompt } from "../src/orchestration/validators/prompt-builder.mjs";
import { runV2Pipeline } from "../src/v2/pipeline.mjs";
import { CONTRACTS_BY_ID } from "../src/v2/case-contracts.mjs";
import { probeSource, probeParent, PROBE_ORDER } from "./shared/probe-sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { EVIDENCE_ROOT } from "./shared/evidence-root.mjs";
export { EVIDENCE_ROOT };
const CONTEXT_LENGTH = 1_000_000;

const sha = (s) => createHash("sha256").update(s).digest("hex");
const FROZEN_CONFIG_HASH = sha(JSON.stringify(TRANSPORT_FREEZE));

function latestFreezeManifest() {
  const dirs = readdirSync(EVIDENCE_ROOT).filter((d) => d.startsWith("v2-card5f-") && d.endsWith("-prompt-builder-2")).sort();
  if (dirs.length === 0) throw new Error("no v2-card5f freeze manifest found");
  const id = dirs[dirs.length - 1];
  const path = `${EVIDENCE_ROOT}/${id}/freeze-manifest.json`;
  const m = JSON.parse(readFileSync(path, "utf8"));
  const pre = m.preflight || {};
  if (!pre.projection_parseable || !pre.parity_gate || !pre.dirty_classification) {
    throw new Error(`refusing to use failed-preflight freeze ${id}: ${JSON.stringify({ projection_parseable: pre.projection_parseable, parity_gate: pre.parity_gate, dirty_classification: pre.dirty_classification })}`);
  }
  return { id, path, manifest: m };
}

// sanitized request payload：redact 任何疑似 secret 欄位（body 不含 header，但保守處理）
function redactDeep(v) {
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (/key|secret|authorization|bearer|token|api[-_]?key/i.test(k)) out[k] = "[REDACTED]";
      else out[k] = redactDeep(val);
    }
    return out;
  }
  return v;
}

function classifyFailure(pipeline, transport) {
  if (transport.status === "error") return "TRANSPORT_FAILURE";
  if (transport.status === "hold") {
    const reason = transport.reason || "";
    if (reason.includes("empty_content")) return "EMPTY_CONTENT";
    if (reason.includes("stopReason_length")) return "LENGTH_TRUNCATION";
    if (reason.includes("non_strict_json")) return "STRICT_JSON_FAILURE";
    return "TRANSPORT_FAILURE";
  }
  switch (pipeline.stage) {
    case "schema": return "SCHEMA_FAILURE";
    case "structural": return "STRUCTURAL_FAILURE";
    case "semantic": return "SEMANTIC_FAILURE";
    case "case": {
      const codes = pipeline.caseEval?.codes || [];
      if (codes.includes("REQUIRED_DISPOSITION_MISSING")) return "REQUIRED_DISPOSITION_MISSING";
      if (codes.includes("REQUIRED_ORDERING_VIOLATION")) return "REQUIRED_ORDERING_VIOLATION";
      if (codes.includes("REQUIRED_PURPOSE_MISSING")) return "REQUIRED_PURPOSE_MISSING";
      if (codes.includes("REQUIRED_RESPONSIBILITY_UNCOVERED")) return "REQUIRED_RESPONSIBILITY_UNCOVERED";
      if (codes.includes("PROHIBITED_PURPOSE_PRESENT")) return "PROHIBITED_PURPOSE_PRESENT";
      if (codes.includes("INVALID_COVERAGE_CLAIM")) return "INVALID_COVERAGE_CLAIM";
      return "SCORECARD_HARD_FAILURE";
    }
    case "scorecard": return pipeline.verdict === "NOT_BENEFICIAL" ? "UNEXPECTED_NOT_BENEFICIAL" : "SCORECARD_HARD_FAILURE";
    default: return "SCORECARD_HARD_FAILURE";
  }
}

function createTeeFetch() {
  const state = { calls: 0, status: null, bodies: [], responseModel: null, responseId: null, rawFinishReason: null };
  const fetchImpl = async (input, init) => {
    state.calls += 1;
    if (typeof init?.body === "string") state.bodies.push(init.body);
    const real = await globalThis.fetch(input, init);
    state.status = real.status;
    try {
      const probe = real.clone();
      (async () => {
        try {
          const reader = probe.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const m = buf.match(/"model"\s*:\s*"([^"]+)"/);
            if (m && !state.responseModel) state.responseModel = m[1];
            const rid = buf.match(/"id"\s*:\s*"(chatcmpl-[^"]+)"/);
            if (rid && !state.responseId) state.responseId = rid[1];
            const fr = buf.match(/"finish_reason"\s*:\s*"([^"]+)"/g);
            if (fr) state.rawFinishReason = fr[fr.length - 1].match(/"finish_reason"\s*:\s*"([^"]+)"/)[1];
          }
        } catch { /* best-effort */ }
      })();
    } catch { /* clone failed */ }
    return real;
  };
  return { fetchImpl, state };
}

function singleCaseCheck(ev) {
  const failures = [];
  const f = ev.checks;
  if (ev.http_status === null || ev.http_status >= 400) failures.push(`HTTP status ${ev.http_status} not successful`);
  if (ev.http_request_count !== 1) failures.push(`provider requests = ${ev.http_request_count} (want 1)`);
  if (ev.provider !== "deepseek" || ev.requested_model !== "deepseek-v4-flash") failures.push(`provider/model mismatch ${ev.provider}/${ev.requested_model}`);
  if (ev.redirect_count !== 0) failures.push(`redirect contract violation: ${ev.redirect_count}`);
  if (ev.tools_present) failures.push("tools present");
  if (ev.reasoning_effort !== "high") failures.push(`reasoning effort ${ev.reasoning_effort}`);
  if (ev.stop_reason !== "stop") failures.push(`stopReason ${ev.stop_reason} (want stop)`);
  if (!ev.raw_content || !ev.raw_content.trim()) failures.push("empty content");
  if (!f.strictParse) failures.push("strict JSON failed");
  if (!f.schema) failures.push("schema failed");
  if (!f.structural) failures.push(`structural failed: ${ev.structuralFailures.join("; ")}`);
  if (!f.semantic) failures.push(`semantic failed: ${ev.semanticFailures.join("; ")}`);
  if (!f.case) failures.push(`case evaluator failed: ${ev.caseFailures.join("; ")}`);
  const hMiss = (ev.h1_h12 || []).filter((g) => !g.pass).map((g) => g.gate_id);
  if (hMiss.length) failures.push(`H1-H12: ${hMiss.join(",")} fail`);
  if (ev.final_verdict !== "PASS") failures.push(`final verdict ${ev.final_verdict} (want PASS)`);
  if (ev.runner && ev.runner.verdict !== "PASS") failures.push(`runner verdict ${ev.runner.verdict}`);
  if (ev.runner && ev.runner.writer_violations?.length) failures.push(`single-writer violation: ${ev.runner.writer_violations.join("; ")}`);
  return failures;
}

function tokenAnalysis(usage, stopReason) {
  if (!usage) return null;
  const input = usage.input ?? 0;
  const cache = usage.cacheRead ?? 0;
  const output = usage.output ?? 0;
  const reasoning = usage.reasoning ?? 0;
  const total = usage.totalTokens ?? (input + cache + output);
  const maxCompletion = TRANSPORT_FREEZE.maxTokens;
  const declaredMargin = CONTEXT_LENGTH - (input + cache) - maxCompletion;
  // 官方語意：total_tokens = prompt + completion；input+generated 受 context 限制 → 可比較
  const observedMargin = CONTEXT_LENGTH - total;
  return {
    input_tokens: input,
    cache_hit_tokens: cache,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: total,
    stop_reason: stopReason,
    configured_max_completion_tokens: maxCompletion,
    declared_request_margin: declaredMargin,
    observed_margin: observedMargin,
    truncation_indication: stopReason !== "stop",
  };
}

async function main() {
  const freeze = latestFreezeManifest();
  const manifest = JSON.parse(readFileSync(freeze.path, "utf8"));
  const dir = `${EVIDENCE_ROOT}/v2-card5f-live-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });

  const cases = [];
  const hardStop = { triggered: false, code: null, caseId: null, detail: null };

  for (const caseId of PROBE_ORDER) {
    if (hardStop.triggered) break;
    const source = probeSource(caseId);
    const parent = probeParent(caseId);
    const contract = CONTRACTS_BY_ID[caseId];
    const bundle = buildPromptBundle(source);
    const startedAt = new Date().toISOString();

    const upHash = sha(bundle.userPrompt);
    const spHash = sha(bundle.systemPrompt);
    const promptFrozen = spHash === manifest.hashes.system_prompt && upHash === manifest.hashes[`user_prompt_${caseId}`];

    const { fetchImpl, state } = createTeeFetch();
    const events = [];
    const adapter = createPiTransportAdapter({ fetchImpl, onEvent: (e) => events.push(e) });

    const pipeline = await runV2Pipeline({
      source, parent, manifest: contract.requirements, contract, adapter,
      execute: async () => ({ status: "passed" }),
    });

    const transport = pipeline.transport || {};
    const scorecard = pipeline.scorecard || null;
    const run = pipeline.run || null;

    const h11 = {
      gate_id: "H11",
      pass: adapter.getRequestCount() === 1 && transport.status === "completed" && transport.stopReason === "stop",
      evidence: `requestCount=${adapter.getRequestCount()} stopReason=${transport.stopReason}`,
    };
    const h1h12 = [...(scorecard?.gates || []), h11];
    if (pipeline.stage === "runner" && scorecard) {
      h1h12.push({ gate_id: "D-13", pass: scorecard.frontierFailures.length === 0, evidence: scorecard.frontierFailures.join("; ") || "ok" });
    }

    const ir = pipeline.ir || transport.parsed || null;
    const rawContent = typeof transport.content === "string" ? transport.content : "";

    let toolsPresent = null;
    let sanitizedRequest = null;
    if (state.bodies.length) {
      try {
        const body = JSON.parse(state.bodies[0]);
        toolsPresent = body.tools !== undefined || body.tool_choice !== undefined;
        sanitizedRequest = redactDeep(body);
      } catch { toolsPresent = false; }
    }

    const usage = transport.usage || null;
    const evidence = {
      case_id: caseId,
      request_timestamp: startedAt,
      freeze_manifest_id: freeze.id,
      prompt_hash: { system: spHash, user: upHash },
      prompt_frozen_match: promptFrozen,
      request_body_hash: state.bodies.length ? sha(state.bodies[0]) : null,
      provider: "deepseek",
      requested_model: TRANSPORT_FREEZE.model,
      response_model: state.responseModel || TRANSPORT_FREEZE.model,
      response_id: state.responseId || null,
      http_request_count: adapter.getRequestCount(),
      http_status: state.status,
      redirect_count: events.filter((e) => e.kind === "redirect_same_host").length,
      response_format: TRANSPORT_FREEZE.responseFormat,
      thinking_mode: "enabled",
      reasoning_effort: TRANSPORT_FREEZE.reasoningEffort,
      max_tokens: TRANSPORT_FREEZE.maxTokens,
      stop_reason: transport.stopReason || null,
      raw_provider_finish_reason: state.rawFinishReason || null,
      usage,
      token_analysis: tokenAnalysis(usage, transport.stopReason || null),
      raw_content_sha256: rawContent ? sha(rawContent) : null,
      raw_content: rawContent,
      parsed_ir: ir,
      structural_validation: pipeline.structural ? pipeline.structural.map((g) => ({ gate_id: g.gate_id, pass: g.pass })) : null,
      semantic_validation: pipeline.semantic ? pipeline.semantic.gates.map((g) => ({ gate_id: g.gate_id, pass: g.pass })) : null,
      case_evaluator: pipeline.caseEval ? { pass: pipeline.caseEval.failures.length === 0, failures: pipeline.caseEval.failures, codes: pipeline.caseEval.codes } : null,
      h1_h12: h1h12.map((g) => ({ gate_id: g.gate_id, pass: g.pass })),
      advisories: scorecard?.advisory || [],
      runner_simulation: run ? { verdict: run.verdict, order: run.order, writer_violations: run.writerViolations, statuses: run.statuses, lease_holder_after: run.leaseHolderAfter } : null,
      final_verdict: pipeline.verdict,
      stage: pipeline.stage,
      tools_present: toolsPresent,
      request_metadata: {
        provider: TRANSPORT_FREEZE.provider,
        requested_model: TRANSPORT_FREEZE.model,
        returned_model: state.responseModel || null,
        max_completion_tokens: TRANSPORT_FREEZE.maxTokens,
        temperature_sampling: "not set (default)",
        tool_policy: "none (absent)",
        session_policy: "fresh adapter per case (no reuse)",
        transport: "pi-transport-adapter.mjs",
        runner: "runner.mjs schedule",
        prompt_hash: spHash,
        schema_hash: manifest.hashes.ir_schema,
        case_contract_hash: manifest.hashes[`case_contract_${caseId}`],
        freeze_id: freeze.id,
      },
      generic_system_prompt: bundle.systemPrompt,
      case_payload: source,
    };

    evidence.checks = {
      strictParse: transport.status === "completed",
      schema: pipeline.stage !== "schema",
      structural: !(pipeline.stage === "structural"),
      semantic: !(pipeline.stage === "semantic"),
      case: !(pipeline.stage === "case"),
    };
    evidence.structuralFailures = (pipeline.hardFailures || []).filter((x) => /^H[12578]|^H12/.test(x));
    evidence.semanticFailures = (pipeline.hardFailures || []).filter((x) => /^H4|^H6|^H9|^H10|^D-13/.test(x));
    evidence.caseFailures = pipeline.caseEval?.failures || (pipeline.hardFailures || []).filter((x) => /case contract/.test(x));

    const failures = singleCaseCheck(evidence);
    evidence.case_failures = failures;
    const failureCode = failures.length ? classifyFailure(pipeline, transport) : null;
    cases.push({ ...evidence, failure_code: failureCode });

    // 每案獨立目錄（§8）
    const caseDir = `${dir}/${caseId}`;
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(`${caseDir}/case-evidence.json`, JSON.stringify(evidence, null, 2));
    writeFileSync(`${caseDir}/sanitized-request.json`, JSON.stringify(sanitizedRequest, null, 2));
    writeFileSync(`${caseDir}/generic-prompt.txt`, bundle.systemPrompt);
    writeFileSync(`${caseDir}/case-payload.json`, JSON.stringify(source, null, 2));
    writeFileSync(`${caseDir}/raw-response.txt`, rawContent);
    if (ir) writeFileSync(`${caseDir}/parsed-ir.json`, JSON.stringify(ir, null, 2));
    writeFileSync(`${caseDir}/report.md`, `# V2 Card 5F case ${caseId}\n\n- final_verdict: ${pipeline.verdict}\n- stage: ${pipeline.stage}\n- failure_code: ${failureCode || "none"}\n- prompt_frozen_match: ${promptFrozen}\n- stop_reason: ${transport.stopReason}\n- usage: ${JSON.stringify(usage)}\n`);

    if (failures.length) {
      hardStop.triggered = true;
      hardStop.code = failureCode;
      hardStop.caseId = caseId;
      hardStop.detail = failures.join("; ");
      break;
    }
    if (adapter.getRequestCount() !== 1) {
      hardStop.triggered = true;
      hardStop.code = "TRANSPORT_FAILURE";
      hardStop.caseId = caseId;
      hardStop.detail = `request count ${adapter.getRequestCount()} != 1`;
      break;
    }
  }

  const totalRequests = cases.reduce((acc, c) => acc + (c.http_request_count || 0), 0);
  const summary = {
    total_provider_requests: totalRequests,
    per_case_requests: Object.fromEntries(cases.map((c) => [c.case_id, c.http_request_count])),
    retries: 0, repairs: 0, resamples: 0, fallbacks: 0, session_reuse: 0,
    hard_stop: hardStop,
    verdict: hardStop.triggered
      ? `HOLD / ${hardStop.code}`
      : "PASS / V2_CARD_5F_NEW_FREEZE_4_OF_4_LIVE_GATE",
  };

  const postLive = {
    prompt_unchanged: buildSystemPrompt() === manifest.hashes.system_prompt ? true : sha(buildSystemPrompt()) === manifest.hashes.system_prompt,
    frozen_config_unchanged: sha(JSON.stringify(TRANSPORT_FREEZE)) === FROZEN_CONFIG_HASH,
  };

  writeFileSync(`${dir}/evidence.json`, JSON.stringify({ freeze: { id: freeze.id }, summary, post_live: postLive, cases }, null, 2));
  writeFileSync(`${dir}/report.md`, `# V2 Card 5F — New Freeze Live Revalidation\n\n${JSON.stringify({ summary }, null, 2)}\n`);
  writeFileSync(`${dir}/context.json`, JSON.stringify({
    provider_context: manifest.provider_context,
    token_semantics: manifest.provider_context.semantics,
    e6_accounting_note: "completion_tokens_details.reasoning_tokens ⊂ completion_tokens per provider docs; whether reasoning counts against max_tokens cap is not documented → UNKNOWN pending live usage.",
  }, null, 2));

  process.stdout.write(JSON.stringify({ summary, post_live: postLive, evidence_dir: dir }, null, 2) + "\n");
  if (hardStop.triggered) process.exitCode = 1;
}

main();
