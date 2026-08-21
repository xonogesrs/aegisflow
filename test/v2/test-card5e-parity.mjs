// test/v2/test-card5e-parity.mjs
// V2 Card 5E Stage 6 — Prompt-Schema Parity deterministic tests（30 items）。
//
// 區塊：
//   A. Disposition transmission (1–10)
//   B. Full parity (11–20)
//   C. Oracle isolation (21–25)
//   D. Regression replays (26–30)
//
// 全程離線：無模型、無 live API、無改動任何 frozen evidence。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildSystemPrompt, buildPromptBundle, buildPromptSchemaProjection, verifyPromptSchemaParity,
} from "../../src/v2/prompt-builder.mjs";
import {
  PROJECTION_BEGIN, PROJECTION_END, FORMAT_EXAMPLE, EXAMPLE_PARENT, EXAMPLE_MANIFEST,
} from "../../src/v2/schema-projection.mjs";
import {
  validateIRShape, PHASE_REQUIRED, PLAN_REQUIRED, DISPOSITION_REQUIRED,
  REQUIRED_EFFECTS, REQUIRED_BOUNDARIES, DISPOSITION_VALUES,
} from "../../src/v2/ir-schema.mjs";
import { validateStructural } from "../../src/v2/structural-validator.mjs";
import { validateSemantic } from "../../src/v2/semantic-consistency.mjs";
import { evaluateCase } from "../../src/v2/case-evaluator.mjs";
import { evaluateScorecardV2 } from "../../src/v2/scorecard-v2.mjs";
import { CONTRACTS_BY_ID } from "../../src/v2/case-contracts.mjs";
import { probeParent, probeSource } from "../../scripts/shared/probe-sources.mjs";

const EVIDENCE = JSON.parse(
  readFileSync(new URL("/Volumes/NVM2T/Development/evidence/autoloop/card-5c-live-probe-2026-08-02T16-10-02-635Z/evidence.json", "file://"), "utf8"),
);

const SYSTEM = buildSystemPrompt();
const clone = (o) => JSON.parse(JSON.stringify(o));

function extractProjection(prompt = SYSTEM) {
  const b = prompt.indexOf(PROJECTION_BEGIN);
  const e = prompt.indexOf(PROJECTION_END);
  assert.ok(b >= 0 && e > b, "projection markers present");
  return JSON.parse(prompt.slice(b + PROJECTION_BEGIN.length, e).trim());
}

const PROJ = extractProjection();

// ── 全 gate 鏈（與 pipeline 一致：schema → structural → semantic → case → scorecard）──
function runGates(ir, { parent, manifest, contract }) {
  const shape = validateIRShape(ir);
  if (!shape.valid) return { stage: "schema", verdict: "HOLD", failures: shape.errors };
  const struct = validateStructural(ir, parent);
  const sf = struct.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`);
  if (sf.length) return { stage: "structural", verdict: "HOLD", failures: sf };
  const sem = validateSemantic(ir, manifest);
  const mf = [...sem.gates.filter((g) => !g.pass).map((g) => `${g.gate_id}: ${g.evidence}`), ...sem.frontierFailures];
  if (mf.length) return { stage: "semantic", verdict: "HOLD", failures: mf };
  const caseEval = evaluateCase(ir, contract);
  if (caseEval.failures.length) return { stage: "case", verdict: "HOLD", failures: caseEval.failures };
  const score = evaluateScorecardV2(ir, { parent, manifest, contract });
  if (score.verdict !== "PASS") return { stage: "scorecard", verdict: score.verdict, failures: score.failures || [] };
  return { stage: "scorecard", verdict: "PASS", failures: [] };
}

// ── oracle 掃描用（與 test-prompt-builder 同邏輯）──
import { CASE_CONTRACTS } from "../../src/v2/case-contracts.mjs";
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
    for (const ex of c.accepted_examples || []) for (const p of ex.phases || []) out.add(p.phase_id);
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

// ═══════════════ A. Disposition transmission (1–10) ═══════════════

test("1. prompt 含 literal \"disposition\"", () => {
  assert.ok(SYSTEM.includes('"disposition"'), 'system prompt must contain the literal key "disposition"');
});

test("2. projection 包含 disposition entry 完整 required keys", () => {
  const req = PROJ.objects["dispositions[]"].required;
  for (const k of DISPOSITION_REQUIRED) assert.ok(req.includes(k), `missing required key ${k}`);
});

test("3. projection 禁止 type", () => {
  assert.ok(!PROJ.objects["dispositions[]"].allowed.includes("type"));
});

test("4. projection 禁止 kind", () => {
  assert.ok(!PROJ.objects["dispositions[]"].allowed.includes("kind"));
});

test("5. projection 禁止未知欄位（additionalProperties=false）", () => {
  assert.equal(PROJ.objects["dispositions[]"].additionalProperties, false);
});

test("6. 非空 disposition example 通過正式 schema", () => {
  assert.equal(FORMAT_EXAMPLE.ir.dispositions.length > 0, true);
  const shape = validateIRShape(FORMAT_EXAMPLE.ir);
  assert.deepEqual(shape.errors, []);
});

test("7. example disposition→type 後 schema 失敗", () => {
  const ir = clone(FORMAT_EXAMPLE.ir);
  for (const d of ir.dispositions) { d.type = d.disposition; delete d.disposition; }
  const shape = validateIRShape(ir);
  assert.equal(shape.valid, false);
  assert.ok(shape.errors.some((e) => e.includes("unknown field: type")), shape.errors.join("; "));
});

test("8. 同時出現 type 與 disposition 時 schema 失敗", () => {
  const ir = clone(FORMAT_EXAMPLE.ir);
  for (const d of ir.dispositions) { d.type = d.disposition; }
  const shape = validateIRShape(ir);
  assert.equal(shape.valid, false);
  assert.ok(shape.errors.some((e) => e.includes("unknown field: type")), shape.errors.join("; "));
});

test("9. 缺少 disposition 時 schema 失敗", () => {
  const ir = clone(FORMAT_EXAMPLE.ir);
  for (const d of ir.dispositions) delete d.disposition;
  const shape = validateIRShape(ir);
  assert.equal(shape.valid, false);
  assert.ok(shape.errors.some((e) => e.includes("missing required: disposition")), shape.errors.join("; "));
});

test("10. 合法 key 但錯誤 enum 時 schema 失敗", () => {
  const ir = clone(FORMAT_EXAMPLE.ir);
  ir.dispositions[0].disposition = "bogus_value";
  const shape = validateIRShape(ir);
  assert.equal(shape.valid, false);
  assert.ok(shape.errors.some((e) => e.includes("invalid value")), shape.errors.join("; "));
});

// ═══════════════ B. Full parity (11–20) ═══════════════

test("11. 所有 root required keys 均傳輸", () => {
  const root = PROJ.objects.root;
  for (const k of ["verdict", "decomposition_evidence"]) assert.ok(root.required.includes(k));
  for (const k of ["parent_goal", "execution_policy", "phases", "dispositions"]) {
    assert.ok(root.conditional.DECOMPOSED.includes(k), `DECOMPOSED conditional missing ${k}`);
  }
});

test("12. 所有 phase required keys 均傳輸", () => {
  const req = PROJ.objects["phases[]"].required;
  for (const k of PHASE_REQUIRED) assert.ok(req.includes(k), `missing ${k}`);
});

test("13. effects required／conditional keys 均傳輸", () => {
  const req = PROJ.objects["phases[].effects"].required;
  for (const k of REQUIRED_EFFECTS) assert.ok(req.includes(k));
  assert.ok(req.includes("boundaries"));
});

test("14. boundaries contract 完整傳輸", () => {
  const req = PROJ.objects["phases[].effects.boundaries"].required;
  for (const k of REQUIRED_BOUNDARIES) assert.ok(req.includes(k), `missing ${k}`);
});

test("15. coverage entry contract 完整傳輸", () => {
  const req = PROJ.objects["phases[].covers[]"].required;
  for (const k of ["requirement_id", "completeness", "claim"]) assert.ok(req.includes(k));
});

test("16. verification plan contract 完整傳輸", () => {
  const req = PROJ.objects["phases[].verification_plan"].required;
  for (const k of PLAN_REQUIRED) assert.ok(req.includes(k), `missing ${k}`);
});

test("17. execution policy lock 完整傳輸", () => {
  const lk = PROJ.objects.execution_policy.locked;
  assert.deepEqual(lk, { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false });
});

test("18. 正式 schema 新增 required key 時 parity test 必須 RED", () => {
  const modified = clone(buildPromptSchemaProjection());
  modified.objects.root.required.push("fake_new_required_key");
  const r = verifyPromptSchemaParity(modified);
  assert.equal(r.pass, false);
});

test("19. projection 漏掉 required key 時 parity test 必須 RED", () => {
  const modified = clone(PROJ);
  modified.objects["dispositions[]"].required = modified.objects["dispositions[]"].required.filter((k) => k !== "disposition");
  const r = verifyPromptSchemaParity(modified);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.includes("required mismatch")), r.problems.join("; "));
});

test("20. projection 多出 alias 時 parity test 必須 RED", () => {
  const modified = clone(PROJ);
  modified.objects["dispositions[]"].allowed.push("type");
  const r = verifyPromptSchemaParity(modified);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.includes("alias")), r.problems.join("; "));
});

// ═══════════════ C. Oracle isolation (21–25) ═══════════════

test("21. prompt 不含 accepted examples（reference slugs）", () => {
  const hits = SLUGS.filter((s) => SYSTEM.includes(s));
  assert.deepEqual(hits, [], `system prompt leaks reference slugs: ${hits.join(", ")}`);
});

test("22. prompt 不含 known-invalid examples 標記", () => {
  assert.ok(!KNOWN_INVALID_RE.test(SYSTEM));
});

test("23. prompt 不含 E1–E12 case-specific 答案", () => {
  for (const marker of ["production database", "產生 migration 檔案", "提交結果", "提取共用邏輯", "email verification", "migration_file"]) {
    assert.ok(!SYSTEM.includes(marker), `system prompt leaks case-specific marker: ${marker}`);
  }
  // example 的 disposition 不得使用 live cases 的專屬 reason code
  assert.ok(FORMAT_EXAMPLE.ir.dispositions.every((d) => d.reason_code !== "COMMIT_NOT_AUTHORIZED" && d.reason_code !== "PRODUCTION_RUNTIME_OUT_OF_SCOPE"));
});

test("24. prompt 不含 reference phase IDs", () => {
  const hits = SLUGS.filter((s) => SYSTEM.includes(s));
  assert.deepEqual(hits, []);
});

test("25. prompt 不含 expected phase count 或 edge set", () => {
  for (const h of COUNT_HINTS) assert.ok(!SYSTEM.includes(h), `phase-count hint: ${h}`);
});

// ═══════════════ D. Regression replays (26–30) ═══════════════

for (const caseId of ["E2", "E6", "E9"]) {
  test(`26–28. ${caseId} 舊 raw IR deterministic replay 仍 PASS`, () => {
    const rec = EVIDENCE.cases.find((c) => c.case_id === caseId);
    const ir = rec.parsed_ir;
    const r = runGates(ir, {
      parent: probeParent(caseId),
      manifest: CONTRACTS_BY_ID[caseId].requirements,
      contract: CONTRACTS_BY_ID[caseId],
    });
    assert.equal(r.verdict, "PASS", `${caseId} replay ${r.stage}: ${r.failures.join("; ")}`);
  });
}

test("29. E4 原始 type raw IR 仍 SCHEMA_FAILURE", () => {
  const rec = EVIDENCE.cases.find((c) => c.case_id === "E4");
  const shape = validateIRShape(rec.parsed_ir);
  assert.equal(shape.valid, false);
  assert.ok(shape.errors.some((e) => e.includes("unknown field: type")), shape.errors.join("; "));
  assert.ok(shape.errors.some((e) => e.includes("missing required: disposition")), shape.errors.join("; "));
});

test("30. E4 key-only 診斷副本全 gates PASS（不得算 live PASS）", () => {
  const rec = EVIDENCE.cases.find((c) => c.case_id === "E4");
  const ir = clone(rec.parsed_ir);
  for (const d of ir.dispositions) { d.disposition = d.type; delete d.type; }
  const r = runGates(ir, {
    parent: probeParent("E4"),
    manifest: CONTRACTS_BY_ID.E4.requirements,
    contract: CONTRACTS_BY_ID.E4,
  });
  assert.equal(r.verdict, "PASS", `E4 key-only ${r.stage}: ${r.failures.join("; ")}`);
  // 診斷副本不等於 live PASS：原始 evidence 的 failure_code 必須維持 SCHEMA_FAILURE
  assert.equal(rec.failure_code, "SCHEMA_FAILURE");
  assert.equal(rec.final_verdict, "HOLD");
});
