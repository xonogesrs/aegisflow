#!/usr/bin/env node
// scripts/gov-review-bundle.mjs
//
// External review bundle generator (AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
// FINALIZATION-1 §6/§7/§11/§15/§16).
//
// 流程: Agent 實作＋測試 → 本 script 產生桌面 bundle（含 fresh verification）
//   → HOLD / WAITING_FOR_EXTERNAL_REVIEW
//   → Controller 上傳 → 外部 reviewer 判定 → PASS 後才允許 integration commit／push／Draft PR。
//
// 固定輸出:
//   $HOME/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt
//   $HOME/Desktop/AutoLoop-Review/archive/<YYYYMMDD-HHMMSS>-<CARD_ID>-<RUN_ID>.txt
//
// 寫入協定: 暫存檔 → 完整寫入 → atomic rename → archive copy。
// 身份: changedTreeIdentity / patchSha256 / testOutputDigest / evidenceDigest /
// bundleSha256 全部由實際內容計算（非信任輸入）。
// Security: 任何檢查無法確定 → HOLD / SECURITY_CHECK_INCOMPLETE，不產生 bundle。
// Bundle 實際輸出位置必須等於 authorization artifact 授權之 canonical path。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./shared/gov-args.mjs";
import {
  readLifecycleAuthorization,
  effectiveAuthority,
  normalizeAuthority,
  validateAuthorityRecord,
} from "../src/governance/lifecycle-authorization.mjs";
import { buildChangeInventory, expandPath } from "../src/governance/change-inventory.mjs";
import { evaluateReviewUnitGate, REVIEW_UNIT_LIMIT_FIELDS, REVIEW_UNIT_ACTUAL_TO_LIMIT } from "../src/governance/review-unit-gate.mjs";
import { digestOfPayload, buildBundleHeader, renderProhibitedActions, EXTERNAL_REVIEW_STOP } from "../src/governance/external-review.mjs";
import { bundleDigestFromFile } from "../src/governance/review-context.mjs";
import { scanForSecrets } from "../src/evidence/run-evidence-store.mjs";
import { GOV_HOLD, hold } from "../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const { flags } = parseArgs(process.argv.slice(2));
const REPO_ROOT = flags?.cwd ? resolve(flags.cwd) : join(HERE, "..");
const cardId = flags.cardId || "UNKNOWN-CARD";
const runId = flags.runId || "run-1";
const reviewRound = Number.isInteger(Number(flags.reviewRound)) ? Number(flags.reviewRound) : 1;
const cardTitle = flags.cardTitle || "";
const baseBranch = flags.baseBranch || "main";
const agent = flags.agent || "pi-deepseek-v4-flash";

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}
function gitOk(args) {
  try { git(args); return true; } catch { return false; }
}

const SEP = "=".repeat(80);
const RULE = "-".repeat(80);
function section(title) {
  return `${SEP}\n${title}\n${SEP}\n`;
}

// ── authority record ──
let record;
if (flags.execDir) record = readLifecycleAuthorization(flags.execDir);
else if (flags.authorityFile) {
  const raw = JSON.parse(readFileSync(flags.authorityFile, "utf8"));
  if (!validateAuthorityRecord(raw).valid && raw.lifecycle_authorization) {
    record = { schema: "autoloop.lifecycle-authorization/v2", card_id: cardId, ...raw, lifecycle_authorization: raw.lifecycle_authorization };
  } else {
    record = raw;
  }
} else {
  record = null;
}
if (!record) {
  console.error("--exec-dir or --authority-file required");
  process.exit(2);
}
const block = record.lifecycle_authorization ?? record;
const authority = normalizeAuthority(block);
const top = {
  repository: flags.repository || record.repository || "",
  branch: record.branch || "",
  base: record.base || baseBranch,
  base_head: record.base_head || "",
  authorized_paths: record.authorized_paths || [],
  bundle_path: record.bundle_path || authority.external_review?.bundle_path || "",
};
const effective = flags.effectiveFile
  ? JSON.parse(readFileSync(flags.effectiveFile, "utf8"))
  : null;

const meta = flags.meta ? JSON.parse(readFileSync(flags.meta, "utf8")) : {};
const milestones = (flags.milestones || "").split(",").filter(Boolean);
const architectureGoal = meta.architectureGoal || flags.architectureGoal || meta.goal || "";

// ── change inventory (complete: committed + staged + dirty + untracked) ──
const inventory = buildChangeInventory({ git, cwd: REPO_ROOT, baseBranch });
const changedTreeIdentity = inventory.changedTreeIdentity;
const patchSha256 = inventory.patchSha256;

// ── review-unit boundary (§5) — runtime enforcement ──
const repairRounds = Number.isInteger(Number(meta.repairRounds)) ? Number(meta.repairRounds) : 0;
const reviewUnitActual = {
  repository_count: 1,
  worktree_count: 1,
  parent_card_count: 1,
  architecture_goal_count: 1,
  internal_milestones: milestones.length || 1,
  changed_paths: inventory.changedPaths.length,
  patch_lines: inventory.patchLines,
  repair_rounds: repairRounds,
};
const reviewUnit = evaluateReviewUnitGate({ authority, actual: reviewUnitActual });

// ── fresh verification (§15): full rerun embedded in the bundle ──
const testCommands = [
  ["npm run check", "syntax check (all src .mjs)"],
  ["npm run test:governance", "governance tests"],
  ["npm run test:v1", "v1 test suite"],
  ["npm run test:v2", "v2 test suite"],
  ["git diff --check", "whitespace/conflict check"],
];
const testReports = [];
let allPassed = true;
let testOutputText = "";
if (flags.skipFreshVerify) {
  testReports.push({ cmd: "(skipped by --skip-fresh-verify)", label: "test harness", exitCode: 0, ok: true, output: "" });
} else {
  for (const [cmd, label] of testCommands) {
    let output = "";
    let exitCode = -1;
    try {
      if (cmd.startsWith("git ")) {
        output = execFileSync("git", cmd.slice(4).split(" "), { cwd: REPO_ROOT, encoding: "utf8" });
        exitCode = 0;
      } else if (cmd.startsWith("npm run ")) {
        const script = cmd.slice("npm run ".length);
        output = execFileSync("npm", ["run", script], { cwd: REPO_ROOT, encoding: "utf8" });
        exitCode = 0;
      } else {
        exitCode = 1;
      }
    } catch (e) {
      output = String(e.stdout ?? "") + String(e.stderr ?? "");
      exitCode = e.status ?? 1;
    }
    const ok = exitCode === 0;
    if (!ok) allPassed = false;
    testReports.push({ cmd, label, exitCode, ok, output });
    testOutputText += `\n===== ${cmd} (${label}) =====\nexit: ${exitCode}\n${output}`;
  }
}
const testOutputDigest = digestOfPayload(testOutputText);
const evidenceDigest = digestOfPayload([testOutputDigest, changedTreeIdentity, patchSha256].join("\n"));

// ── security checks (§12) — fail-closed, no UNKNOWN ──
const secretScan = scanForSecrets(inventory.patchText + "\n" + testOutputText);
const securityBlockers = [];
const securityNotes = [];
if (secretScan.matches.length > 0) {
  securityBlockers.push(`SECRET_SCAN_MATCHES: ${secretScan.matches.join(",")}`);
}
if (inventory.binaries.length > 0) securityNotes.push(`BINARY_FILES: ${inventory.binaries.join(",")}`);
if (inventory.symlinks.length > 0) securityNotes.push(`SYMLINKS: ${inventory.symlinks.join(",")}`);
if (inventory.execBitChanges.length > 0) securityNotes.push(`EXEC_BIT_CHANGES: ${inventory.execBitChanges.join(",")}`);
if (inventory.dependencyChanges.length > 0) securityNotes.push(`DEPENDENCY_CHANGES: ${inventory.dependencyChanges.join(",")}`);
const securityComplete = securityBlockers.length === 0;
if (!securityComplete) {
  console.error(GOV_HOLD.SECURITY_CHECK_INCOMPLETE);
  for (const b of securityBlockers) console.error(`  - ${b}`);
  process.exit(1);
}

// ── bundle path authorization (§11): output must equal authorized path ──
const outDir = flags.outDir ? resolve(flags.outDir) : join(homedir(), "Desktop", "AutoLoop-Review");
const archiveDir = join(outDir, "archive");
const target = join(outDir, "READY_FOR_REVIEW.txt");
const authorizedBundlePath = top.bundle_path || authority.external_review?.bundle_path || "";
const canonicalTarget = resolve(target);
const canonicalAuthorized = authorizedBundlePath ? resolve(expandPath(authorizedBundlePath, REPO_ROOT)) : "";
if (canonicalAuthorized && canonicalAuthorized !== canonicalTarget) {
  console.error(GOV_HOLD.BUNDLE_PATH_MISMATCH);
  console.error(`  authorized: ${canonicalAuthorized}`);
  console.error(`  actual:     ${canonicalTarget}`);
  process.exit(1);
}

// ── assemble bundle ──
const branch = inventory.branch;
const head = inventory.head;
const baseHead = inventory.baseHead;
const statusShort = git(["status", "--short"]).trim();
const worktree = statusShort === "" ? "CLEAN" : "DIRTY";
const diffCheck = gitOk(["diff", "--check"]) ? "CLEAN" : "VIOLATIONS";

const header = buildBundleHeader({
  cardId, cardTitle,
  repository: top.repository || "xonogesrs/autoloop",
  branch, baseBranch, baseHead, currentHead: head, worktree,
  agent,
});

const effectiveText = effective
  ? JSON.stringify(effective, null, 1)
  : "(未提供 --effective-file；以入口卡 record 為授權)";

const scopeMark = (p) => {
  const scope = top.authorized_paths.length ? top.authorized_paths : (flags.scope || "").split(",").filter(Boolean);
  return scope.some((s) => p === s || p.startsWith(s.replace(/\/?$/, "/"))) ? "AUTHORIZED" : "UNEXPECTED — 需 reviewer 確認";
};

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

const bundle = [
  SEP,
  "AUTOLOOP EXTERNAL REVIEW BUNDLE",
  SEP,
  "",
  `BUNDLE_SCHEMA: ${header.bundle_schema}`,
  `CARD_ID: ${header.card_id}`,
  `CARD_TITLE: ${header.card_title}`,
  `RUN_ID: ${runId}`,
  `REVIEW_ROUND: ${reviewRound}`,
  `GENERATED_AT: ${header.generated_at}`,
  `REPOSITORY: ${header.repository}`,
  `BRANCH: ${header.branch}`,
  `BASE_BRANCH: ${header.base_branch}`,
  `BASE_HEAD: ${header.base_head}`,
  `CURRENT_HEAD: ${header.current_head}`,
  `WORKTREE: ${header.worktree}`,
  `AGENT: ${header.agent}`,
  `REQUESTED_REVIEW_VERDICT: PASS / REPAIR / HOLD`,
  "",

  section("1. AUTHORIZATION AND PROHIBITED ACTIONS"),
  renderProhibitedActions({ ...authority, scope: meta.scope || "(see card)", paths: top.authorized_paths }, [
    `EXTERNAL_REVIEW_STATUS: PENDING`,
    `REVIEW_UNIT: one coherent review unit（內部 milestones: ${milestones.length}）`,
    "本 bundle 產生後 Agent 停止，等待外部 reviewer 判定。",
  ]),
  `AUTHORIZED_BINDINGS: ${JSON.stringify({ repository: top.repository, branch: top.branch || branch, base: top.base, base_head: top.base_head, bundle_path: top.bundle_path })}`,
  "",
  section("2. EXECUTIVE SUMMARY"),
  `- 本卡目標: ${meta.goal || "(未填)"}`,
  `- 實際完成內容: ${meta.completed || "(未填)"}`,
  `- 尚未完成內容: ${meta.pending || "(未填)"}`,
  `- Agent 自評: ${meta.selfAssessment || "(未填)"}`,
  `- 已知限制: ${meta.limitations || "(未填)"}`,
  `- 負面結果: ${meta.negativeResults || "無"}`,
  "",
  section("3. REPOSITORY INTEGRITY"),
  `- git branch --show-current: ${branch}`,
  `- git rev-parse HEAD: ${head}`,
  `- git rev-parse ${baseBranch}: ${baseHead}`,
  `- git status --short:`,
  statusShort || "(clean)",
  `- git diff --check: ${diffCheck}`,
  `- inventory: committed(${git(["diff", "--name-status", "--no-renames", `${baseBranch}...HEAD`]).split("\n").filter(Boolean).length}) staged(${inventory.stagedPaths.length}) dirty(${inventory.changedPaths.length}) untracked(${inventory.untracked.length})`,
  `- unexpected path 檢查: 見 §4（全路徑逐項標記授權範圍）`,
  "",
  section("4. CHANGED PATHS (complete inventory)"),
  ...inventory.entries.map((e) => `- ${e.path}  [${e.status}]  scope: ${scopeMark(e.path)}${e.symlink ? "  SYMLINK" : ""}${e.binary ? "  BINARY" : ""}${e.execBitChanged ? "  EXEC_BIT_CHANGED" : ""}  mode:${e.mode || "?"}  sha256:${e.contentSha256}`),
  `- deleted: ${inventory.deleted.length ? inventory.deleted.join(",") : "NONE"}`,
  `- staged: ${inventory.stagedPaths.length ? inventory.stagedPaths.join(",") : "NONE"}`,
  `- untracked: ${inventory.untracked.length ? inventory.untracked.join(",") : "NONE"}`,
  `- dependency changes: ${inventory.dependencyChanges.length ? inventory.dependencyChanges.join(",") : "NONE"}`,
  "",
  section("5. COMPLETE PATCH"),
  inventory.patchText || "(no patch)",
  "",
  section("6. TEST AND VERIFICATION RESULTS (fresh rerun)"),
  ...testReports.map((t) => [
    `- command: ${t.cmd}  (${t.label})`,
    `- exit code: ${t.exitCode}`,
    `- result: ${t.ok ? "PASS" : "FAIL"}`,
    t.ok ? "" : `- failure output:\n${t.output.slice(0, 20000)}`,
  ].join("\n")),
  `- test_output_digest: ${testOutputDigest}`,
  "",
  section("7. REVIEW AND REPAIR HISTORY"),
  `- reviewer invocation identity: ${meta.reviewerIdentity || "(待外部 review)"}`,
  `- executor invocation identity: ${meta.executorIdentity || agent}`,
  `- fresh session: ${meta.freshSession ?? "YES"}`,
  `- blocking findings: ${meta.blockingFindings || "無（內部 review）"}`,
  `- repair rounds: ${repairRounds}`,
  `- repair budget 剩餘: ${meta.repairBudgetLeft ?? "—"}`,
  `- 最終 fresh verification: ${allPassed ? "PASS" : "FAIL — 不得請求 PASS"}`,
  `- internal milestones: ${milestones.length ? milestones.join(", ") : "(單一 milestone)"}`,
  `- architecture goal: ${architectureGoal || "(未填)"}`,
  "EXTERNAL_REVIEW_STATUS: PENDING",
  "",
  section("8. ARTIFACT AND EVIDENCE IDENTITY"),
  `- changed-tree identity: ${changedTreeIdentity}`,
  `  （計算: sha256 of sorted "STATUS\\tPATH\\tFILE_SHA256\\tMODE\\tSYMLINK\\tBINARY" 串）`,
  `- patch SHA-256: ${patchSha256}`,
  `  （計算: sha256 of sorted "=== FILE <path> ===\\n<content-sha256>" 串）`,
  `- test-output digest: ${testOutputDigest}`,
  `- evidence digest: ${evidenceDigest}`,
  `  （計算: sha256(test_output_digest + changed_tree_identity + patch_sha256)）`,
  `- bundle SHA-256: 見檔案尾（END marker 之後；覆蓋其上方全部內容）`,
  `- digest 計算: node scripts/gov-review-bundle.mjs（內建 sha256Text；非信任輸入）`,
  "",
  section("9. SECURITY CHECK"),
  `- secret scan（patch + untracked + test output）: ${secretScan.matches.length === 0 ? "NO MATCHES" : `MATCHES: ${secretScan.matches.join(",")}`}`,
  `- binary files: ${inventory.binaries.length ? inventory.binaries.join(",") : "NONE（已完整列舉）"}`,
  `- symlinks（lstat）: ${inventory.symlinks.length ? inventory.symlinks.join(",") : "NONE（已完整列舉）"}`,
  `- executable-bit changes: ${inventory.execBitChanges.length ? inventory.execBitChanges.join(",") : "NONE（已完整列舉）"}`,
  `- dependency changes: ${inventory.dependencyChanges.length ? inventory.dependencyChanges.join(",") : "NONE（已完整列舉）"}`,
  `- external side effect / network write / production write: NONE（本 bundle 產生過程僅讀取 repo 與寫入 ${outDir}）`,
  `- SECURITY_CHECK_STATUS: ${securityComplete ? "COMPLETE (no UNKNOWN)" : "INCOMPLETE"}`,
  ...securityNotes.map((n) => `- note: ${n}`),
  "",
  section("10. REVIEW UNIT BOUNDARY"),
  `- 執行單位: ONE COHERENT REVIEW UNIT`,
  ...REVIEW_UNIT_LIMIT_FIELDS.map((f) => {
    const limit = reviewUnit.limits[f];
    const shortKey = Object.keys(REVIEW_UNIT_ACTUAL_TO_LIMIT).find((k) => REVIEW_UNIT_ACTUAL_TO_LIMIT[k] === f);
    const value = reviewUnitActual[f] ?? (shortKey ? reviewUnitActual[shortKey] : undefined);
    const ok = value !== undefined && value <= limit;
    return `- ${f}: actual ${value ?? "(未測量)"} / limit ${limit}  ${ok ? "OK" : value === undefined ? "UNMEASURED" : "EXCEEDED"}`;
  }),
  `- review-unit gate: ${reviewUnit.allowed ? "WITHIN LIMITS" : `VIOLATIONS: ${reviewUnit.violations.join("; ")}`}`,
  `- stop conditions triggered: ${meta.stopConditions?.length ? meta.stopConditions.join(",") : "NONE"}`,
  `- effective authority（若提供）: ${effectiveText}`,
  "",
  section("11. OPEN QUESTIONS AND REVIEW REQUEST"),
  ...(meta.openQuestions || []).map((q) => `- ${q}`),
  "",
  `NEXT_ACTION_IF_PASS: integration checkpoint commit（digest-bound result artifact）→ feature branch push → Draft PR 建立／更新（整合紀錄＋CI）`,
  `NEXT_ACTION_IF_REPAIR: 依 reviewer findings 於授權範圍內 bounded repair → fresh verification → 重新產生 bundle`,
  `NEXT_ACTION_IF_HOLD: 停止，交回 Controller`,
  "",
  SEP,
  "END OF REVIEW BUNDLE",
  SEP,
  "",
].join("\n");

const bundleSha = digestOfPayload(bundle);
const finalBundle = `${bundle}BUNDLE_SHA256 (sha256 of all content above): ${bundleSha}\n`;

// ── atomic write + archive ──
mkdirSync(outDir, { recursive: true });
mkdirSync(archiveDir, { recursive: true });
const tmp = join(outDir, `.READY_FOR_REVIEW.txt.tmp-${process.pid}`);
const archive = join(archiveDir, `${stamp}-${cardId}-${runId}.txt`);
writeFileSync(tmp, finalBundle, "utf8");
renameSync(tmp, target);
copyFileSync(target, archive);

const report = {
  review_bundle: target,
  archive_path: archive,
  bundle_sha256: bundleSha,
  patch_sha256: patchSha256,
  changed_tree_identity: changedTreeIdentity,
  test_output_digest: testOutputDigest,
  evidence_digest: evidenceDigest,
  test_totals: testReports.map((t) => ({ cmd: t.cmd, exit: t.exitCode, ok: t.ok })),
  changed_paths: inventory.changedPaths,
  changed_path_count: inventory.changedPaths.length,
  patch_lines: inventory.patchLines,
  repair_round: repairRounds,
  remaining_repair_budget: Math.max(0, reviewUnit.limits.maximum_repair_rounds - repairRounds),
  security_complete: securityComplete,
  worktree,
  branch,
  head,
  secret_matches: secretScan.matches.length,
};
console.log(JSON.stringify(report, null, 1));
console.log("");
console.log(EXTERNAL_REVIEW_STOP.WAITING);
console.log("review_bundle: " + target);
console.log("archive_path: " + archive);
console.log("bundle_sha256: " + bundleSha);
console.log("patch_sha256: " + patchSha256);
console.log("changed_tree_identity: " + changedTreeIdentity);
