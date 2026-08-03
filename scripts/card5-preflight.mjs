// scripts/card5-preflight.mjs
// V2 Card 5 Stage 4 — Pre-live acceptance gate。
// 依序：Card 5 focused suite → V2 suite → V1 suite → static oracle-leak scan →
// retired-mechanism scan → dependency/lock verification → freeze manifest generation →
// final pre-live integrity audit。任一失敗 → HOLD / NO LIVE REQUEST。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scanOracleLeak, scanRetiredMechanisms, verifyDependencyLock } from "./card5-static-scans.mjs";
import { buildFreezeManifest, EVIDENCE_ROOT } from "./card5-freeze-manifest.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runSuite(name, args) {
  try {
    const out = execFileSync("node", ["--test", ...args], { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: true, tests: m?.[1], pass: m?.[2], fail: m?.[3], raw: out };
  } catch (e) {
    const out = String(e.stdout || "");
    const m = out.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
    return { name, ok: false, tests: m?.[1], pass: m?.[2], fail: m?.[3], error: String(e.stderr || e.message).slice(0, 800) };
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function integrityAudit() {
  const problems = [];
  const staged = git(ROOT, ["diff", "--cached", "--name-only"]);
  if (staged) problems.push(`staged paths not empty: ${staged}`);
  // V1 production routing 不得 import V2
  for (const f of ["src/lifecycle-runner.mjs", "src/operator-tick.mjs", "src/decompose-task.mjs"]) {
    const p = `${ROOT}/${f}`;
    if (!existsSync(p)) continue;
    const t = readFileSync(p, "utf8");
    if (/v2|decompose-ir/.test(t) && /from\s+["'].*v2|import.*v2|require\(.*v2/.test(t)) {
      problems.push(`${f}: V1 routing imports V2`);
    }
  }
  // no live call yet：本 script 不觸發任何 provider request
  //（live probe 只由 scripts/card5-live-probe.mjs 觸發，且其證據目錄尚未建立）
  const liveProbeDirs = existsSync(EVIDENCE_ROOT)
    ? readdirSync(EVIDENCE_ROOT).filter((d) => d.startsWith("card-5-live-probe-"))
    : [];
  if (liveProbeDirs.length > 0) problems.push(`live probe evidence already exists: ${liveProbeDirs.join(",")}`);
  // key 不得寫入 evidence（掃描已有 card-5 evidence）
  if (existsSync(EVIDENCE_ROOT)) {
    for (const d of readdirSync(EVIDENCE_ROOT)) {
      if (!d.startsWith("card-5-")) continue;
      const full = `${EVIDENCE_ROOT}/${d}`;
      for (const f of readdirSync(full)) {
        const t = readFileSync(`${full}/${f}`, "utf8");
        if (/sk-[A-Za-z0-9]{16,}|authorization\s*[:=]\s*["']?Bearer|DEEPSEEK_API_KEY\s*=\s*\S/.test(t)) {
          problems.push(`secret pattern in evidence ${d}/${f}`);
        }
      }
    }
  }
  return { pass: problems.length === 0, problems };
}

const results = [];

async function main() {
  results.push(runSuite("card5-focused", ["test/v2/test-runner.mjs", "test/v2/test-prompt-builder.mjs", "test/v2/test-pipeline.mjs"]));
  results.push(runSuite("v2-full", ["test/v2/*.mjs"]));
  results.push(runSuite("v1-full", ["test/test-*.mjs"]));

  const leak = scanOracleLeak();
  results.push({ name: "static-oracle-leak-scan", ok: leak.pass, detail: `${leak.problems.length} problems`, problems: leak.problems });
  const retired = scanRetiredMechanisms();
  results.push({ name: "static-retired-mechanism-scan", ok: retired.pass, detail: `${retired.problems.length} problems`, problems: retired.problems });
  const dep = verifyDependencyLock();
  results.push({ name: "dependency-lock-verification", ok: dep.pass, detail: dep.problems.join("; ") || "pi-ai 0.83.0 pin/lock/install OK" });

  const manifest = buildFreezeManifest();
  const dir = `${EVIDENCE_ROOT}/card-5-freeze-manifest-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(dir, { recursive: true });
  const manifestPath = `${dir}/freeze-manifest.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  results.push({ name: "freeze-manifest-generation", ok: true, detail: manifestPath, manifest });

  const audit = integrityAudit();
  results.push({ name: "pre-live-integrity-audit", ok: audit.pass, detail: audit.problems.join("; ") || "staged=0, V1 routing unchanged, no live call, key not in evidence" });

  const allOk = results.every((r) => r.ok);
  process.stdout.write(JSON.stringify({
    verdict: allOk ? "PASS / PRE_LIVE_ACCEPTANCE" : "HOLD / NO LIVE REQUEST",
    steps: results.map(({ name, ok, tests, pass, fail, detail }) => ({ name, ok, tests, pass, fail, detail })),
    integrity: audit,
    freeze_manifest: manifestPath,
  }, null, 2) + "\n");
  if (!allOk) process.exitCode = 1;
}

main();
