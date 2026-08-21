// scripts/card5b-regression.mjs
// V2 Card 5B Stage 6 — regression suites。
// 依序：Card 5B focused → V2 全量 → V1 全量 → provenance scan → retired-oracle scan →
// original-source integrity → Card 5/5A evidence integrity。任一失敗 → HOLD。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanProvenance, scanRetiredOracle, scanFailureTaxonomy } from "./card5b-provenance-scan.mjs";
import { EVIDENCE_ROOT } from "./shared/evidence-root.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const sha = (s) => createHash("sha256").update(s).digest("hex");
const fsha = (p) => sha(readFileSync(p, "utf8"));

function runSuite(name, args) {
  try {
    const out = execFileSync("node", ["--test", ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: true, tests: m?.[1], pass: m?.[2], fail: m?.[3] };
  } catch (e) {
    const out = String(e.stdout || "");
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: false, tests: m?.[1], pass: m?.[2], fail: m?.[3], error: String(e.stderr || e.message).slice(0, 500) };
  }
}

function sourceIntegrity() {
  const problems = [];
  // 四份原始 Task Decomposition 文件必須仍為 git-clean（未修改）
  const gitStatus = execFileSync("git", ["status", "--short", "--", "autoloop-analysis/"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (gitStatus) problems.push(`original sources dirty: ${gitStatus}`);
  return { pass: problems.length === 0, problems };
}

function evidenceIntegrity() {
  const problems = [];
  const expected = {
    "/card-5-freeze-manifest-2026-08-02T15-41-38-388Z/freeze-manifest.json": "e0669bb4129482e602dc74b9c91425fa9a165624e3cdec5441a5a52cfddd41bd",
    "/card-5-live-probe-2026-08-02T15-43-49-242Z/evidence.json": "b062b57c7771b4d42560b7d3ce19e569c6153e589c2289a26e585260fa5ffce7",
    "/card-5-live-probe-2026-08-02T15-43-49-242Z/card5a-audit-report.md": "4bcb56e0cd1d4140db2c0fc29ce2ced110965f0b8132599210babb79cbc83b23",
    "/card-5-live-probe-2026-08-02T15-43-49-242Z/report.md": "335824f32aac6f3ce48eb66357757f088090d8e145809af5e74f43fd3cc03691",
  };
  for (const [rel, want] of Object.entries(expected)) {
    const p = `${EVIDENCE_ROOT}${rel}`;
    if (!existsSync(p)) { problems.push(`missing evidence ${rel}`); continue; }
    if (fsha(p) !== want) problems.push(`evidence hash mismatch: ${rel}`);
  }
  return { pass: problems.length === 0, problems };
}

const results = [];
results.push(runSuite("card5b-focused", ["test/v2/test-card5b-contract-repair.mjs"]));
results.push(runSuite("v2-all", ["test/v2/*.mjs"]));
results.push(runSuite("v1-all", ["test/test-*.mjs"]));
results.push({ name: "source-provenance-scan", ok: scanProvenance().pass, detail: `${scanProvenance().problems.length} problems` });
results.push({ name: "retired-oracle-scan", ok: scanRetiredOracle().pass, detail: `${scanRetiredOracle().problems.length} problems` });
results.push({ name: "failure-taxonomy-scan", ok: scanFailureTaxonomy().pass, detail: "taxonomy separated" });
const src = sourceIntegrity();
results.push({ name: "original-source-integrity", ok: src.pass, detail: src.problems.join("; ") || "original Task Decomposition files clean" });
const evi = evidenceIntegrity();
results.push({ name: "evidence-integrity", ok: evi.pass, detail: evi.problems.join("; ") || "Card 5/5A evidence hashes unchanged" });

const allOk = results.every((r) => r.ok);
const dir = `${EVIDENCE_ROOT}/card-5b-regression-${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(dir, { recursive: true });
const report = {
  verdict: allOk ? "PASS / V2_CARD_5B_CASE_CONTRACT_REPAIRED" : "HOLD / V2_CARD_5B_DETERMINISTIC_FAILURE",
  steps: results.map(({ name, ok, tests, pass, fail, detail }) => ({ name, ok, tests, pass, fail, detail })),
  run_at: new Date().toISOString(),
};
writeFileSync(`${dir}/regression.json`, JSON.stringify(report, null, 2));
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (!allOk) process.exitCode = 1;
