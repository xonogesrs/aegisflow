// test/v2/test-prompt-builder.mjs
// V2 Card 5 — generic prompt builder 無 oracle leakage 驗證。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CASE_CONTRACTS, CONTRACTS_BY_ID } from "../../src/v2/case-contracts.mjs";
import { buildSystemPrompt, buildUserPrompt, buildPromptBundle, PROMPT_BUILDER_VERSION } from "../../src/orchestration/validators/prompt-builder.mjs";

const BUILDER_SRC = readFileSync(fileURLToPath(new URL("../../src/orchestration/validators/prompt-builder.mjs", import.meta.url)), "utf8");
// 掃描用：去除註解後檢查實際程式碼與 prompt 內容（註解屬文件，不算 prompt 內容）
const BUILDER_CODE = BUILDER_SRC.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ── oracle 內容抽取（全部來自 E1–E12 case contracts，僅測試用）──

const CONTRACT_VOCAB = new Set([
  "verification", "implementation", "analysis", "review", "operation",
  "forbidden", "allowed", "required", "persistent", "ephemeral", "none",
  "complete", "partial", "deferred", "unresolved", "blocked", "out_of_scope", "not_beneficial",
  "DECOMPOSED", "DECOMPOSITION_NOT_BENEFICIAL", "DECOMPOSITION_BLOCKED",
  "CYCLIC_DEPENDENCY", "AMBIGUOUS_SCOPE", "MISSING_AUTHORITY", "OTHER",
  "EXTERNAL_DEPENDENCY_PENDING", "PRODUCTION_RUNTIME_OUT_OF_SCOPE",
  "COMMIT_NOT_AUTHORIZED", "CROSS_REPO_AUTHORITY_REQUIRED",
  "MULTI_MODEL_ORCHESTRATION_FORBIDDEN", "ALREADY_SATISFIED", "NO_EFFECTIVE_IMPROVEMENT",
]);

function referenceSlugs() {
  const out = new Set();
  for (const c of CASE_CONTRACTS) {
    for (const ex of c.accepted_examples || []) {
      for (const p of ex.phases || []) out.add(p.phase_id);
    }
    for (const inv of c.known_invalid_examples || []) {
      const m = inv.mutation || {};
      if (m.phase_id) out.add(m.phase_id);
      if (m.from) out.add(m.from);
      if (m.to) out.add(m.to);
      if (m.phase?.phase_id) out.add(m.phase.phase_id);
    }
  }
  return [...out].filter((s) => s.length >= 6 && !CONTRACT_VOCAB.has(s));
}

const SLUGS = referenceSlugs();
const KNOWN_INVALID_RE = /E\d+-invalid-\d+/;
const COUNT_HINTS = ["4 張卡", "five-phase", "5-phase", "4-phase", "3-phase", "2-phase", "min_cards", "max_cards", "expected phase count"];
const ROLE_DICT_HINTS = ["role dictionary", "canonical role vocabulary", "foundation", "offline_validation", "generate_migration", "extract_common_logic"];

// ── probe sources（與 live probe 相同構造；requirements 來自 case contract，authority 來自原始 eval fixture）──

import { readFileSync as _rfs } from "node:fs";
const EVAL_CASES_RAW = JSON.parse(_rfs(new URL("../../autoloop-analysis/task-decomposition-eval-cases.json", import.meta.url), "utf8"));
const EVAL_CASES = Array.isArray(EVAL_CASES_RAW) ? EVAL_CASES_RAW : EVAL_CASES_RAW.cases || EVAL_CASES_RAW.eval_cases || [];
const evalBy = (id) => EVAL_CASES.find((e) => e.case_id === id);

export function probeSource(caseId) {
  const c = CONTRACTS_BY_ID[caseId];
  const ev = evalBy(caseId);
  return {
    caseId,
    requirements: c.requirements,
    authority: {
      allowed_paths: ev?.authority_boundary?.allowed_paths || [],
      mutation_allowed: ev?.authority_boundary?.mutation_allowed ?? true,
      commit_allowed: ev?.authority_boundary?.commit_allowed ?? false,
    },
  };
}

const SYSTEM = buildSystemPrompt();

test("builder source does not import case contracts / eval fixtures", () => {
  assert.ok(!BUILDER_CODE.includes("case-contracts"), "prompt builder must not import case contracts");
  assert.ok(!BUILDER_CODE.includes("task-decomposition-eval-cases"), "prompt builder must not read eval fixtures");
  assert.ok(!BUILDER_CODE.includes("accepted_examples"), "prompt builder must not reference accepted examples");
  assert.ok(!BUILDER_CODE.includes("known_invalid"), "prompt builder must not reference known-invalid examples");
});

test("system prompt 不包含 accepted examples 的 reference phase slugs", () => {
  const hits = SLUGS.filter((s) => SYSTEM.includes(s));
  assert.deepEqual(hits, [], `system prompt leaks reference slugs: ${hits.join(", ")}`);
});

test("builder source 不包含 accepted examples 的 reference phase slugs", () => {
  const hits = SLUGS.filter((s) => BUILDER_CODE.includes(s));
  assert.deepEqual(hits, [], `builder code leaks reference slugs: ${hits.join(", ")}`);
});

test("prompt 不包含 known-invalid example 標記", () => {
  assert.ok(!KNOWN_INVALID_RE.test(SYSTEM), "system prompt must not contain known-invalid ids");
  assert.ok(!KNOWN_INVALID_RE.test(BUILDER_CODE), "builder code must not contain known-invalid ids");
});

test("prompt 不包含 canonical role dictionary", () => {
  for (const h of ROLE_DICT_HINTS) {
    assert.ok(!SYSTEM.includes(h), `system prompt contains role-dictionary hint: ${h}`);
    assert.ok(!BUILDER_CODE.includes(h), `builder code contains role-dictionary hint: ${h}`);
  }
});

test("prompt 不包含 case-specific phase count", () => {
  for (const h of COUNT_HINTS) {
    assert.ok(!SYSTEM.includes(h), `system prompt contains phase-count hint: ${h}`);
    assert.ok(!BUILDER_CODE.includes(h), `builder code contains phase-count hint: ${h}`);
  }
});

test("prompt 不包含 evaluator gate 結果", () => {
  for (const token of ["H1:", "H2:", "H12", "gate result", "expected_verdict", "invariants"]) {
    assert.ok(!SYSTEM.includes(token), `system prompt contains evaluator-gate token: ${token}`);
  }
});

// ── per-case user prompts（E2/E6/E9/E4）──

for (const caseId of ["E2", "E6", "E9", "E4"]) {
  test(`user prompt (${caseId}) 不含 reference slugs（除 source 需求文字外）`, () => {
    const src = probeSource(caseId);
    const up = buildUserPrompt(src);
    const allowed = JSON.stringify(src).replace(/[^a-z0-9_\u4e00-\u9fff]/gi, " ");
    const hits = SLUGS.filter((s) => up.includes(s) && !allowed.includes(s));
    assert.deepEqual(hits, [], `${caseId} user prompt leaks reference slugs: ${hits.join(", ")}`);
    assert.ok(!KNOWN_INVALID_RE.test(up), `${caseId} user prompt leaks known-invalid ids`);
  });
}

test("user prompt 含原始 requirements 與 authority boundary（source 注入）", () => {
  const src = probeSource("E2");
  const up = buildUserPrompt(src);
  for (const r of src.requirements) {
    assert.ok(up.includes(`${r.requirement_id}`), `missing ${r.requirement_id}`);
    assert.ok(up.includes(r.text), `missing requirement text: ${r.text}`);
  }
  assert.ok(up.includes('"src/auth/"'));
  assert.ok(up.includes("commit_allowed: false"));
});

test("同一 source 產生 deterministic prompts（build 可重現）", () => {
  const src = probeSource("E6");
  const a = buildPromptBundle(src);
  const b = buildPromptBundle(src);
  assert.equal(a.systemPrompt, b.systemPrompt);
  assert.equal(a.userPrompt, b.userPrompt);
  assert.equal(a.version, PROMPT_BUILDER_VERSION);
});

test("buildUserPrompt 對空 requirements 仍可輸出（NOT_BENEFICIAL 類）", () => {
  const up = buildUserPrompt({ requirements: [], authority: { allowed_paths: ["README.md"], mutation_allowed: true, commit_allowed: false } });
  assert.ok(up.includes("(none)"));
});
