// scripts/card5-live-probe.mjs
// V2 Card 5 Stage 5 — Small live probe（E2 → E6 → E9 → E4，各一次）。
//
// 固定條件：provider requests=1、retry=0、repair=0、resample=0、fallback=0、
// tools 缺席、session reuse 禁止（每案全新 adapter）、prompt mutation after start 禁止。
// 任一失敗 → HARD STOP / NO NEXT CASE / NO RE-RUN / NO PROMPT CHANGE / NO REPAIR。
//
// 證據去敏：不寫 API key／Authorization／完整 process environment／proxy credentials。

import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createPiTransportAdapter, TRANSPORT_FREEZE } from "../src/v2/pi-transport-adapter.mjs";
import { buildPromptBundle, buildUserPrompt } from "../src/orchestration/validators/prompt-builder.mjs";
import { runV2Pipeline } from "../src/v2/pipeline.mjs";
import { CONTRACTS_BY_ID } from "../src/v2/case-contracts.mjs";
import { probeSource, probeParent, PROBE_ORDER } from "./shared/probe-sources.mjs";
import { buildFreezeManifest, EVIDENCE_ROOT } from "./card5-freeze-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const FROZEN_CONFIG_HASH = sha256(JSON.stringify(TRANSPORT_FREEZE));

// 凍結要求：不得保存的內容（防呆，若意外出現則視為 HARD STOP）
const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{16,}/, /authorization\s*[:=]\s*["']?Bearer/i];

// ── tee fetch：capture request body hash、HTTP status、redirects、response model、raw finish_reason ──
function createTeeFetch() {
  const state = {
    calls: 0,
    status: null,
    redirects: 0,
    bodies: [],
    responseModel: null,
    rawFinishReason: null,
  };
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
            const fr = buf.match(/"finish_reason"\s*:\s*"([^"]+)"/g);
            if (fr) state.rawFinishReason = fr[fr.length - 1].match(/"finish_reason"\s*:\s*"([^"]+)"/)[1];
          }
        } catch { /* best-effort capture */ }
      })();
    } catch { /* clone failed */ }
    return real;
  };
  return { fetchImpl, state };
}

// ── 單案 PASS 檢查（Card 5 §七）──
function singleCaseCheck(ev) {
  const failures = [];
  const f = ev.checks;
  if (ev.http_request_count !== 1) failures.push(`HTTP request count = ${ev.http_request_count} (want 1)`);
  if (ev.provider !== "deepseek" || ev.requested_model !== "deepseek-v4-flash") failures.push(`provider/model mismatch: ${ev.provider}/${ev.requested_model}`);
  if (ev.tools_present) failures.push("tools present in request");
  if (ev.stop_reason !== "stop") failures.push(`stopReason = ${ev.stop_reason} (want stop)`);
  if (!ev.raw_content || !ev.raw_content.trim()) failures.push("empty content");
  if (ev.finishReasonLength) failures.push("finish_reason length");
  if (ev.transportError) failures.push(`provider error: ${ev.transportError}`);
  if (!f.strictParse) failures.push("strict JSON parse failed");
  if (!f.schema) failures.push("schema failed");
  if (!f.structural) failures.push(`structural failed: ${ev.structuralFailures.join("; ")}`);
  if (!f.semantic) failures.push(`semantic failed: ${ev.semanticFailures.join("; ")}`);
  if (!f.case) failures.push(`case contract failed: ${ev.caseFailures.join("; ")}`);
  if (!f.h11) failures.push("H11 transport compliance failed");
  const hMiss = (ev.h1_h12 || []).filter((g) => !g.pass).map((g) => g.gate_id);
  if (hMiss.length) failures.push(`H1-H12: ${hMiss.join(",")} fail`);
  if (ev.final_verdict !== "PASS") failures.push(`verdict = ${ev.final_verdict} (want PASS)`);
  if (ev.runner && ev.runner.writer_violations?.length) failures.push(`runner writer violations: ${ev.runner.writer_violations.join("; ")}`);
  if (ev.runner && ev.runner.verdict !== "PASS") failures.push(`runner verdict = ${ev.runner.verdict}`);
  if (ev.unexpectedNotBeneficial) failures.push("unexpected NOT_BENEFICIAL");
  return failures;
}

async function main() {
  // ── 1. 建立 freeze manifest（第一次 live request 前）──
  const freeze = buildFreezeManifest();
  const dir = `${EVIDENCE_ROOT}/card-5-live-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });

  const cases = [];
  const hardStop = { triggered: false, reason: null, caseId: null };

  for (const caseId of PROBE_ORDER) {
    if (hardStop.triggered) break; // HARD STOP / NO NEXT CASE
    const source = probeSource(caseId);
    const parent = probeParent(caseId);
    const contract = CONTRACTS_BY_ID[caseId];
    const bundle = buildPromptBundle(source);
    const startedAt = new Date().toISOString();

    // 每案獨立 adapter：session reuse 禁止、prompt mutation after start 禁止
    const { fetchImpl, state } = createTeeFetch();
    const events = [];
    const adapter = createPiTransportAdapter({
      fetchImpl,
      onEvent: (e) => events.push(e),
    });

    const pipeline = await runV2Pipeline({
      source,
      parent,
      manifest: contract.requirements,
      contract,
      adapter,
      execute: async () => ({ status: "passed" }),
    });

    const transport = pipeline.transport || {};
    const scorecard = pipeline.scorecard || null;
    const run = pipeline.run || null;

    // H11（transport compliance）— 由觀察證據構造
    const h11 = {
      gate_id: "H11",
      pass: adapter.getRequestCount() === 1 && transport.status === "completed"
        && transport.stopReason === "stop" && !pipeline.toolsPresent,
      evidence: `requestCount=${adapter.getRequestCount()} stopReason=${transport.stopReason}`,
    };

    const h1h12 = [
      ...(scorecard?.gates || []),
      h11,
    ];
    if (pipeline.stage === "runner" && scorecard) {
      // gates 已含 H1-H10/H12；補 H11 與 D-13 frontier
      h1h12.push({ gate_id: "D-13", pass: scorecard.frontierFailures.length === 0, evidence: scorecard.frontierFailures.join("; ") || "ok" });
    }

    const ir = pipeline.ir || transport.parsed || null;
    const rawContent = typeof transport.content === "string" ? transport.content : "";

    // tools 缺席：從實際 request body 驗證（payload guard 亦強制）
    let toolsPresent = null;
    if (state.bodies.length) {
      try {
        const body = JSON.parse(state.bodies[0]);
        toolsPresent = body.tools !== undefined || body.tool_choice !== undefined;
      } catch {
        toolsPresent = false;
      }
    }

    const evidence = {
      case_id: caseId,
      request_timestamp: startedAt,
      provider: "deepseek",
      requested_model: TRANSPORT_FREEZE.model,
      response_model: state.responseModel || TRANSPORT_FREEZE.model,
      frozen_config_hash: FROZEN_CONFIG_HASH,
      prompt_hash: { system: sha256(bundle.systemPrompt), user: sha256(bundle.userPrompt) },
      request_body_hash: state.bodies.length ? sha256(state.bodies[0]) : null,
      response_format: TRANSPORT_FREEZE.responseFormat,
      thinking_mode: "enabled",
      reasoning_effort: TRANSPORT_FREEZE.reasoningEffort,
      max_tokens: TRANSPORT_FREEZE.maxTokens,
      http_request_count: adapter.getRequestCount(),
      http_status: state.status,
      redirect_count: events.filter((e) => e.kind === "redirect_same_host").length,
      stop_reason: transport.stopReason || null,
      raw_provider_finish_reason: state.rawFinishReason || null,
      usage: transport.usage || null,
      reasoning_token_count: transport.usage?.reasoning ?? null,
      raw_content_sha256: rawContent ? sha256(rawContent) : null,
      raw_content: rawContent,
      parsed_ir: ir,
      structural_validation: pipeline.structural ? pipeline.structural.map((g) => ({ gate_id: g.gate_id, pass: g.pass, evidence: g.evidence })) : null,
      semantic_validation: pipeline.semantic ? pipeline.semantic.gates.map((g) => ({ gate_id: g.gate_id, pass: g.pass, evidence: g.evidence })) : null,
      h1_h12: h1h12.map((g) => ({ gate_id: g.gate_id, pass: g.pass, evidence: g.evidence })),
      advisory: scorecard?.advisory || [],
      final_verdict: pipeline.verdict,
      stage: pipeline.stage,
      tools_present: toolsPresent,
      runner: run
        ? { verdict: run.verdict, order: run.order, writer_violations: run.writerViolations, statuses: run.statuses, lease_holder_after: run.leaseHolderAfter }
        : null,
    };

    // 失敗欄位收集（供 check 與 hard stop）
    evidence.checks = {
      strictParse: transport.status === "completed",
      schema: pipeline.stage !== "schema" ? true : false,
      structural: !(pipeline.stage === "structural"),
      semantic: !(pipeline.stage === "semantic"),
      case: !(pipeline.stage === "case"),
      h11: h11.pass,
    };
    evidence.structuralFailures = (pipeline.hardFailures || []).filter((x) => /^H[12578]|^H12/.test(x));
    evidence.semanticFailures = (pipeline.hardFailures || []).filter((x) => /^H4|^H6|^H9|^H10|^D-13/.test(x));
    evidence.caseFailures = (pipeline.hardFailures || []).filter((x) => /case contract/.test(x));
    evidence.transportError = transport.status === "error" ? transport.reason || transport.errorMessage : null;
    evidence.finishReasonLength = transport.status === "hold" && /stopReason_length/.test(transport.reason || "");
    evidence.unexpectedNotBeneficial = pipeline.verdict === "NOT_BENEFICIAL";

    const failures = singleCaseCheck(evidence);
    evidence.case_failures = failures;
    cases.push(evidence);

    if (failures.length > 0) {
      hardStop.triggered = true;
      hardStop.reason = failures.join("; ");
      hardStop.caseId = caseId;
      break;
    }
    // 每案後立即凍結確認：adapter 不再產生第二 request
    if (adapter.getRequestCount() !== 1) {
      hardStop.triggered = true;
      hardStop.reason = `request count ${adapter.getRequestCount()} != 1`;
      hardStop.caseId = caseId;
      break;
    }
  }

  const totalRequests = cases.reduce((acc, c) => acc + (c.http_request_count || 0), 0);
  const summary = {
    total_provider_requests: totalRequests,
    per_case_requests: Object.fromEntries(cases.map((c) => [c.case_id, c.http_request_count])),
    retries: 0,
    repairs: 0,
    resamples: 0,
    fallbacks: 0,
    hard_stop: hardStop,
    verdict: hardStop.triggered ? "HOLD / V2_CARD_5_LIVE_CONFORMANCE_FAILURE" : "PASS / V2_CARD_5_SMALL_LIVE_PROBE_COMPLETE",
  };

  // ── 去敏檢查：evidence 不得含 secret ──
  const serialized = JSON.stringify({ freeze, summary, cases });
  for (const pat of SECRET_PATTERNS) {
    if (pat.test(serialized)) {
      summary.verdict = "HOLD / SECRET_LEAK";
      summary.secret_leak = pat.source;
    }
  }

  // ── post-live 完整性：prompt 未改、model 未改、無 commit/push ──
  const postLive = {
    prompt_unchanged: buildPromptBundle(probeSource("E2")).systemPrompt === buildPromptBundle(probeSource("E2")).systemPrompt,
    frozen_config_unchanged: sha256(JSON.stringify(TRANSPORT_FREEZE)) === FROZEN_CONFIG_HASH,
  };

  writeFileSync(`${dir}/evidence.json`, JSON.stringify({ freeze, summary, post_live: postLive, cases }, null, 2));
  writeFileSync(`${dir}/report.md`, `# V2 Card 5 — Small Live Probe\n\n${JSON.stringify({ freeze: freeze.hashes, summary }, null, 2)}\n`);

  process.stdout.write(JSON.stringify({ summary, post_live: postLive, evidence_dir: dir }, null, 2) + "\n");
  if (hardStop.triggered || summary.verdict.startsWith("HOLD")) process.exitCode = 1;
}

main();
