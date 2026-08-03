// scripts/card5e-parity-gate.mjs
// V2 Card 5E Stage 5 — PROMPT_SCHEMA_PARITY hard gate（freeze-time；Card 5E §五）。
//
// 驗證（12 項）：
//   1. prompt 內嵌 projection 可 parse
//   2. 每個 schema object path 均存在
//   3. 每個 required property 精確存在（結構比對）
//   4. allowed keys 與正式 schema 一致
//   5. enum 集合一致
//   6. unknown-field policy（additionalProperties）一致
//   7. conditional fields 規則一致
//   8. canonical example 通過正式 schema
//   9. canonical example 通過 structural validator
//  10. canonical example 通過 semantic validator
//  11. prompt 無 aliases（projection-level + alias 禁令陳述）
//  12. prompt 無 case-specific 答案（oracle isolation scan + retired scan + dependency lock）
//
// 任何 failure → exit 1 → HOLD / PROMPT_SCHEMA_PARITY_FAILURE，不得 freeze / live。

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildUserPrompt, verifyPromptSchemaParity } from "../src/v2/prompt-builder.mjs";
import {
  PROJECTION_BEGIN, PROJECTION_END, buildPromptSchemaProjection,
  FORMAT_EXAMPLE, EXAMPLE_PARENT, EXAMPLE_MANIFEST,
} from "../src/v2/schema-projection.mjs";
import { validateIRShape } from "../src/v2/ir-schema.mjs";
import { validateStructural } from "../src/v2/structural-validator.mjs";
import { validateSemantic } from "../src/v2/semantic-consistency.mjs";
import { scanOracleLeak, scanRetiredMechanisms, verifyDependencyLock } from "./card5-static-scans.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main() {
  const problems = [];
  const system = buildSystemPrompt();
  const userPrompts = {};

  // ── 1. projection 可 parse ──
  const b = system.indexOf(PROJECTION_BEGIN);
  const e = system.indexOf(PROJECTION_END);
  if (b < 0 || e < 0) problems.push("projection markers missing from system prompt");
  let parsed = null;
  if (b >= 0 && e > b) {
    try {
      parsed = JSON.parse(system.slice(b + PROJECTION_BEGIN.length, e).trim());
    } catch (err) {
      problems.push(`projection JSON parse failed: ${err.message}`);
    }
  }

  // ── 2–7. 結構 parity（對照 buildPromptSchemaProjection() 現時 descriptor）──
  if (parsed) {
    problems.push(...verifyPromptSchemaParity(parsed).problems);
  } else {
    problems.push("projection could not be parsed; structural parity skipped");
  }

  // ── 8. example 通過正式 schema ──
  const shape = validateIRShape(FORMAT_EXAMPLE.ir);
  if (!shape.valid) problems.push(`example schema: ${shape.errors.join("; ")}`);

  // ── 9. example 通過 structural validator ──
  for (const g of validateStructural(FORMAT_EXAMPLE.ir, EXAMPLE_PARENT).filter((x) => !x.pass)) {
    problems.push(`example structural ${g.gate_id}: ${g.evidence}`);
  }

  // ── 10. example 通過 semantic validator ──
  const sem = validateSemantic(FORMAT_EXAMPLE.ir, EXAMPLE_MANIFEST);
  for (const g of sem.gates.filter((x) => !x.pass)) problems.push(`example semantic ${g.gate_id}: ${g.evidence}`);
  for (const f of sem.frontierFailures) problems.push(`example semantic frontier: ${f}`);

  // ── 11. 無 aliases ──
  if (parsed) {
    const allowed = parsed.objects?.["dispositions[]"]?.allowed || [];
    for (const a of ["type", "kind", "status"]) {
      if (allowed.includes(a)) problems.push(`disposition alias present in projection: "${a}"`);
    }
  }
  if (!system.includes('"type", "kind", and "status" are NOT aliases')) {
    problems.push('disposition alias prohibition statement missing from prompt');
  }
  if (!system.includes('"disposition"')) {
    problems.push('literal "disposition" key missing from prompt');
  }

  // ── 12. 無 case-specific 答案 / retired / dependency ──
  const leak = scanOracleLeak();
  for (const p of leak.problems) problems.push(`oracle leak: ${p}`);
  const retired = scanRetiredMechanisms();
  for (const p of retired.problems) problems.push(`retired mechanism: ${p}`);
  const dep = verifyDependencyLock();
  for (const p of dep.problems) problems.push(`dependency lock: ${p}`);

  const pass = problems.length === 0;
  const out = {
    gate: "PROMPT_SCHEMA_PARITY",
    pass,
    system_bytes: Buffer.byteLength(system, "utf8"),
    projection_objects: parsed ? Object.keys(parsed.objects || {}) : [],
    problems,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (!pass) {
    process.stderr.write("HOLD / PROMPT_SCHEMA_PARITY_FAILURE — NO FREEZE, NO LIVE REQUEST\n");
    process.exitCode = 1;
  }
}

main();
