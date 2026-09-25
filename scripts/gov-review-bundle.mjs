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
//   <review surface>/READY_FOR_REVIEW.txt
//   <review archive>/<YYYYMMDD-HHMMSS>-<CARD_ID>-<RUN_ID>.txt
//
// 寫入協定: 暫存檔 → 完整寫入 → atomic rename → archive copy。
// 身份: changedTreeIdentity / patchSha256 / testOutputDigest / evidenceDigest /
// bundleSha256 全部由實際內容計算（非信任輸入）。
// Security: 任何檢查無法確定 → HOLD / SECURITY_CHECK_INCOMPLETE，不產生 bundle。
// Bundle 實際輸出位置必須等於 authorization artifact 授權之 canonical path。
//
// Fresh verification（round 4 finding 1）: production 固定執行治理定義的完整命令集
// （DEFAULT_VERIFY_COMMANDS）；`--verify-config` 旗標已移除並明確拒絕。測試注入只能
// 透過程式內部 dependency injection — 呼叫本模組匯出的 `generateReviewBundle` 並傳入
// `verifyCommands` 參數 — 不能經由 production CLI flag 或環境變數開後門。

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, assertLiveBindings, assertScopeCoversInventory } from "./shared/gov-args.mjs";
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
import { readReviewHistory, deriveRoundContext } from "../src/governance/review-history.mjs";
import { scanForSecrets } from "../src/evidence/run-evidence-store.mjs";
import { scopeCovers } from "../src/governance/lifecycle-authorization.mjs";
import { GOV_HOLD } from "../src/governance/holds.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Governance-defined fresh-verification command set. Production runs EXACTLY
 * this set on every bundle generation: there is no --verify-config flag and
 * no environment-variable backdoor. Tests inject a minimal but REAL command
 * set through the library API (`generateReviewBundle({ verifyCommands })`) —
 * internal dependency injection only.
 */
export const DEFAULT_VERIFY_COMMANDS = Object.freeze([
  ["npm run check", "syntax check (all src .mjs)"],
  ["npm run test:governance", "governance tests"],
  ["npm run test:v1", "v1 test suite"],
  ["npm run test:v2", "v2 test suite"],
  ["git diff --check", "whitespace/conflict check"],
]);

const SEP = "=".repeat(80);
const RULE = "-".repeat(80);
function section(title) {
  return `${SEP}\n${title}\n${SEP}\n`;
}

const FORBIDDEN_GIT_OPS = ["fetch", "push", "pull", "remote add", "remote set-url", "remote remove", "remote rename"];

/** Fail-closed: throw a hold-coded error. The CLI main converts it to exit(1);
 * library callers (tests) catch it and read `e.code` / `e.message`. */
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

/**
 * Generate the external review bundle.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] — CLI-style argv (defaults to process.argv
 *   when run as the CLI). Tests pass their own argv for a temp repo.
 * @param {[string,string][]} [opts.verifyCommands] — internal dependency
 *   injection for the fresh-verification command set. Production ALWAYS uses
 *   DEFAULT_VERIFY_COMMANDS; this parameter exists only for tests to inject
 *   a minimal real command set. It is NOT exposed as a CLI flag.
 * @returns {object} the bundle report (also printed to stdout for the CLI).
 */
export function generateReviewBundle({ argv, verifyCommands = DEFAULT_VERIFY_COMMANDS } = {}) {
  const { flags } = parseArgs(argv ?? process.argv.slice(2));

  // Round 4 finding 1: the injection vector is explicitly rejected. The
  // production CLI must NOT accept a caller-supplied verification command set.
  if (flags.verifyConfig !== undefined) {
    fail(GOV_HOLD.FRESH_VERIFY_FAILED,
      "--verify-config is NOT a production flag: the verification command set is fixed by governance; test injection is internal dependency injection only");
  }

  // ── side-effect measurement (real, not asserted) ──
  // (a) the generator must not import network-capable modules;
  // (b) every git invocation must be local/read-only (no fetch/push/pull/remote
  //     mutation); (c) every file write must land inside outDir (verified after).
  const generatorSource = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const networkImport = /from ["']node:(net|http|https)["']/.exec(generatorSource);
  if (networkImport) {
    fail(GOV_HOLD.SECURITY_CHECK_INCOMPLETE, `generator imports network-capable module: ${networkImport[0]}`);
  }

  const REPO_ROOT = flags?.cwd ? resolve(flags.cwd) : join(HERE, "..");
  const cardTitle = flags.cardTitle || "";
  const baseBranch = flags.baseBranch || "main";
  const agent = flags.agent || "pi-deepseek-v4-flash";

  function git(args) {
    const joined = args.join(" ");
    if (FORBIDDEN_GIT_OPS.some((op) => joined.startsWith(op))) {
      fail(GOV_HOLD.SECURITY_CHECK_INCOMPLETE, `generator invoked remote/write git op: git ${joined}`);
    }
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
  }
  function gitOk(args) {
    try { git(args); return true; } catch { return false; }
  }

  // ── authority record ──
  let record;
  if (flags.execDir) record = readLifecycleAuthorization(flags.execDir);
  else if (flags.authorityFile) {
    const raw = JSON.parse(readFileSync(flags.authorityFile, "utf8"));
    const check = validateAuthorityRecord(raw);
    if (!check.valid) {
      // Fail-closed: no fallback for an invalid record (top-level bindings are
      // mandatory and must pass schema validation).
      fail("HOLD / AUTHORIZATION_INVALID", check.errors.join("; "));
    }
    record = raw;
  } else {
    throw new Error("--exec-dir or --authority-file required");
  }
  const block = record.lifecycle_authorization ?? record;
  const authority = normalizeAuthority(block);
  const top = {
    // repository / branch / base / scope / bundle_path come ONLY from the
    // authority record — CLI overrides are rejected (fail-closed).
    repository: record.repository || "",
    branch: record.branch || "",
    base: record.base || baseBranch,
    base_head: record.base_head || "",
    authorized_paths: record.authorized_paths || [],
    bundle_path: record.bundle_path || authority.external_review?.bundle_path || "",
  };
  const effective = flags.effectiveFile
    ? JSON.parse(readFileSync(flags.effectiveFile, "utf8"))
    : null;

  // ── bundle path authorization (§11): the actual output location must equal
  // the canonical path authorized in the authority artifact — checked early. ──
  const outDir = flags.outDir ? resolve(flags.outDir) : join(homedir(), "Desktop", "AutoLoop-Review");
  const archiveDir = join(outDir, "archive");
  const target = join(outDir, "READY_FOR_REVIEW.txt");
  const authorizedBundlePath = top.bundle_path || authority.external_review?.bundle_path || "";
  const canonicalTarget = resolve(target);
  const canonicalAuthorized = authorizedBundlePath ? resolve(expandPath(authorizedBundlePath, REPO_ROOT)) : "";
  if (canonicalAuthorized && canonicalAuthorized !== canonicalTarget) {
    fail(GOV_HOLD.BUNDLE_PATH_MISMATCH, `authorized: ${canonicalAuthorized}; actual: ${canonicalTarget}`);
  }

  const meta = flags.meta ? JSON.parse(readFileSync(flags.meta, "utf8")) : {};
  const milestones = (flags.milestones || "").split(",").filter(Boolean);
  const architectureGoal = meta.architectureGoal || flags.architectureGoal || meta.goal || "";

  // ── review-history artifact (round 3 finding 4): the round, accumulated
  // repair round, prior digests, prior findings and remaining budget are
  // DERIVED from the Controller-maintained history — never from Agent flags.
  // card/run identity come from the authority record only.
  const cardId = record?.card_id || flags.cardId || "UNKNOWN-CARD";
  const runId = record?.run_id || flags.runId || "run-1";
  if (flags.cardId && record?.card_id && flags.cardId !== record.card_id) {
    fail(GOV_HOLD.LIVE_BINDING_MISMATCH, `--card-id ${flags.cardId} != record ${record.card_id}`);
  }
  const history = readReviewHistory(outDir);
  const roundCtx = deriveRoundContext(history);
  const reviewRound = roundCtx.review_round;
  const repairRounds = roundCtx.repair_round;
  const priorFindings = roundCtx.prior_findings_text;
  const priorFindingsDigest = roundCtx.prior_findings_digest;
  const priorBundleSha256 = roundCtx.prior_bundle_sha256;
  const remainingBudget = roundCtx.remaining_budget;
  // Reject agent-supplied round/repair conflicts with the persisted history.
  if (flags.reviewRound && Number(flags.reviewRound) !== reviewRound) {
    fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
      `--review-round ${flags.reviewRound} != history round ${reviewRound} (round is derived, not caller-chosen)`);
  }
  if (meta.repairRounds !== undefined && Number(meta.repairRounds) !== repairRounds) {
    fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
      `meta.repairRounds ${meta.repairRounds} != history repair round ${repairRounds} (repair budget cannot be reset)`);
  }
  if (priorFindings && priorFindingsDigest !== digestOfPayload(priorFindings)) {
    fail(GOV_HOLD.REVIEW_HISTORY_INVALID, "history prior_findings_digest does not match prior_findings_text");
  }
  // Prior bundle binding: the recorded prior bundle digest must exist in the
  // archive (Controller-recorded, verifiable).
  // R-14: the match is DIGEST-VERIFIED — a candidate only counts when its
  // stated footer digest equals the recomputed content digest AND equals the
  // expected prior digest. A tampered artifact whose footer lies about its
  // own content can never satisfy the prior binding.
  if (reviewRound > 1 && priorBundleSha256) {
    let found = false;
    try {
      for (const f of readdirSync(archiveDir)) {
        if (!f.endsWith(".txt")) continue;
        const text = readFileSync(join(archiveDir, f), "utf8");
        const stated = text.split("\n").reverse().find((l) => l.startsWith("BUNDLE_SHA256"))?.split(":").slice(1).join(":").trim() ?? null;
        const recomputed = bundleDigestFromFile(text);
        if (stated && recomputed && stated === recomputed && recomputed === priorBundleSha256) { found = true; break; }
      }
    } catch { /* archive unreadable → fail below */ }
    if (!found) {
      fail(GOV_HOLD.REVIEW_HISTORY_INVALID, `prior bundle ${priorBundleSha256} not found in ${archiveDir} (prior binding cannot be verified)`);
    }
  }
  if (reviewRound > 1 && (!priorFindingsDigest || !priorBundleSha256)) {
    fail(GOV_HOLD.REVIEW_HISTORY_MISSING, "round > 1 requires a review-history artifact with prior bundle/findings digests");
  }

  // ── change inventory (complete: committed + staged + dirty + untracked) ──
  const inventory = buildChangeInventory({ git, cwd: REPO_ROOT, baseBranch });
  const changedTreeIdentity = inventory.changedTreeIdentity;
  const patchSha256 = inventory.patchSha256;

  // ── live bindings + writable scope (round 3 findings 2/3) — fail-closed ──
  assertLiveBindings({ record, cwd: REPO_ROOT, inventory, baseBranch, cardId, runId, flags });
  assertScopeCoversInventory(inventory, top.authorized_paths || []);

  // ── clean-worktree requirement (§8/§13): the reviewed HEAD must be the
  // pushable HEAD. Dirty or untracked content at bundle time would make the
  // reviewed artifact unpushable → fail-closed.
  if (inventory.dirtyCount > 0 || inventory.untrackedCount > 0) {
    fail(GOV_HOLD.WORKTREE_DIRTY_AT_BUNDLE, `dirty tracked: ${inventory.dirtyCount}, untracked: ${inventory.untrackedCount} — checkpoint all content before bundling`);
  }

  // ── review-unit boundary (§5) — runtime enforcement, fail-closed; every
  // declared stop condition is wired into the gate (round 3 finding 4). ──
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
  const stopConditions = meta.stopConditions || [];
  const reviewUnit = evaluateReviewUnitGate({ authority, actual: reviewUnitActual, stopConditions });
  if (!reviewUnit.allowed) {
    // round 5 finding: the gate enforces the canonical repair cap
    // (min of bounded_repair.max_rounds and
    // review_unit.maximum_repair_rounds) — repair_round > effective cap →
    // HOLD before any bundle is produced.
    fail(GOV_HOLD.REVIEW_UNIT_LIMIT_EXCEEDED, reviewUnit.violations.join("; "));
  }

  // Round 5 finding: the Controller-maintained history must agree with the
  // authority-derived effective repair cap — history can never expand
  // authorization. Both recorded fields (effective_repair_cap and
  // remaining_budget) must have been derived from the SAME cap this record
  // declares.
  if (history) {
    const effectiveCap = reviewUnit.limits.maximum_repair_rounds;
    if (Number.isFinite(effectiveCap) && roundCtx.effective_repair_cap !== effectiveCap) {
      fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
        `history effective_repair_cap ${roundCtx.effective_repair_cap} != authority effective cap ${effectiveCap}`);
    }
    const expectedRemaining = Math.max(0, effectiveCap - repairRounds);
    if (remainingBudget !== expectedRemaining) {
      fail(GOV_HOLD.REVIEW_HISTORY_INVALID,
        `history remaining_budget ${remainingBudget} != effective cap ${effectiveCap} − repair ${repairRounds} = ${expectedRemaining}`);
    }
  }

  // ── fresh verification (§15): full rerun embedded in the bundle. No skip
  // path exists and no caller-supplied command set exists: EVERY configured
  // command MUST run and PASS, otherwise the bundle is NOT produced (round 3
  // finding 1 / round 4 finding 1). Production always runs
  // DEFAULT_VERIFY_COMMANDS; tests inject a minimal REAL command set through
  // the `verifyCommands` dependency — never through a CLI flag.
  if (!Array.isArray(verifyCommands) || verifyCommands.some((c) => !Array.isArray(c) || c.length < 2 || typeof c[0] !== "string")) {
    fail(GOV_HOLD.FRESH_VERIFY_FAILED, "verify commands must be a list of [command, label] pairs (internal dependency only)");
  }
  const testCommands = verifyCommands;
  const testReports = [];
  let allPassed = true;
  let testOutputText = "";
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
      } else if (cmd.startsWith("node ")) {
        output = execFileSync("node", cmd.slice("node ".length).split(" "), { cwd: REPO_ROOT, encoding: "utf8" });
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
  if (!allPassed) {
    // Any FAIL / NOT-RUN → no bundle (fail-closed).
    const failed = testReports.filter((t) => !t.ok).map((t) => `FAILED: ${t.cmd} (exit ${t.exitCode})`);
    fail(GOV_HOLD.FRESH_VERIFY_FAILED, failed.join("; "));
  }
  const testOutputDigest = digestOfPayload(testOutputText);
  const evidenceDigest = digestOfPayload([testOutputDigest, changedTreeIdentity, patchSha256].join("\n"));

  // ── security checks (§12) — fail-closed, no UNKNOWN, real blocking ──
  const secretScan = scanForSecrets(inventory.patchText + "\n" + testOutputText);
  const securityBlockers = [];
  const securityNotes = [];
  if (secretScan.matches.length > 0) {
    securityBlockers.push(`SECRET_SCAN_MATCHES: ${secretScan.matches.join(",")}`);
  }
  // Structural anomalies are BLOCKING (unexpected binary / symlink / exec-bit).
  if (inventory.binaries.length > 0) securityBlockers.push(`UNEXPECTED_BINARY: ${inventory.binaries.join(",")}`);
  if (inventory.symlinks.length > 0) securityBlockers.push(`SYMLINK_CHANGES: ${inventory.symlinks.join(",")}`);
  if (inventory.execBitChanges.length > 0) securityBlockers.push(`EXEC_BIT_CHANGES: ${inventory.execBitChanges.join(",")}`);
  // Dependency changes outside the authorized scope are blocking; within the
  // authorized scope they are precisely reported as SECURITY_ITEM.
  const outOfScopeDeps = inventory.dependencyChanges.filter((d) => !scopeCovers(d, top.authorized_paths));
  if (outOfScopeDeps.length > 0) securityBlockers.push(`DEPENDENCY_CHANGES_OUTSIDE_SCOPE: ${outOfScopeDeps.join(",")}`);
  if (inventory.dependencyChanges.length > 0) securityNotes.push(`DEPENDENCY_CHANGES: ${inventory.dependencyChanges.join(",")}`);
  const securityComplete = securityBlockers.length === 0;
  if (!securityComplete) {
    fail(GOV_HOLD.SECURITY_CHECK_INCOMPLETE, securityBlockers.join("; "));
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
    repository: top.repository || "xonogesrs/aegisflow",
    branch, baseBranch, baseHead, currentHead: head, worktree,
    agent,
  });

  const effectiveText = effective
    ? JSON.stringify(effective, null, 1)
    : "(未提供 --effective-file；以入口卡 record 為授權)";

  // Effective authority computed from the entry record itself (parent == child
  // == entry; neutral runtime) — rendered for reviewer verification.
  let effectiveAuthorityComputed = null;
  try {
    effectiveAuthorityComputed = effectiveAuthority(record, record);
  } catch { effectiveAuthorityComputed = null; }

  // Per-command test totals parsed from the actual output (reviewer-verifiable).
  const testTotalsText = testOutputText
    .split("\n")
    .filter((l) => /^ℹ (tests|pass|fail)/.test(l))
    .join("; ");

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
    `AUTHORIZATION_RECORD: ${JSON.stringify(record, null, 1).split("\n").map((l) => `    ${l}`).join("\n")}`,
    `EFFECTIVE_AUTHORITY: ${effectiveAuthorityComputed ? JSON.stringify(effectiveAuthorityComputed, null, 1).split("\n").map((l) => `    ${l}`).join("\n") : "(不可計算)"}`,
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
    `- inventory: committed(${inventory.committedCount}) staged(${inventory.stagedCount}) dirty(${inventory.dirtyCount}) untracked(${inventory.untrackedCount})  changed_paths_total(${inventory.changedPaths.length})`,
    `- unexpected path 檢查: 見 §4（全路徑逐項標記授權範圍）`,
    "",
    section("4. CHANGED PATHS (complete inventory)"),
    ...inventory.entries.map((e) => `- ${e.path}  [${e.status}]  scope: ${scopeMark(e.path)}${e.symlink ? "  SYMLINK" : ""}${e.binary ? "  BINARY" : ""}${e.execBitChanged ? "  EXEC_BIT_CHANGED" : ""}  mode:${e.mode || "?"}  sha256:${e.contentSha256}`),
    `- renames (detected via git diff -M): ${inventory.renames.length ? inventory.renames.map((r) => `${r.similarity} ${r.from} -> ${r.to} (${r.source})`).join("; ") : "NONE"}`,
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
      t.ok ? "" : `- output:\n${(t.output || "").slice(0, 20000)}`,
    ].join("\n")),
    `- parsed totals from output: ${testTotalsText || "(無 ℹ tests/pass/fail 行 — 見上方完整輸出)"}`,
    `- test_output_digest: ${testOutputDigest}`,
    "",
    section("7. REVIEW AND REPAIR HISTORY"),
    `- external review round: ${reviewRound}`,
    `- repair round: ${repairRounds}`,
    `- effective repair cap (min of bounded_repair.max_rounds & review_unit.maximum_repair_rounds): ${reviewUnit.limits.maximum_repair_rounds}`,
    `- remaining repair budget: ${Math.max(0, reviewUnit.limits.maximum_repair_rounds - repairRounds)}（= effective cap − repair ${repairRounds}；history 紀錄 remaining ${remainingBudget}）`,
    `- previous external findings (round ${reviewRound - 1}):`,
    priorFindings ? priorFindings.split("\n").map((l) => `    ${l}`).join("\n") : `    (round ${reviewRound - 1} 無 findings 記錄 — round ${reviewRound - 1} 檔案不存在)`,
    `- previous findings digest: ${priorFindingsDigest || "(無)"}`,
    `- prior bundle digest: ${priorBundleSha256 || "(round 1 無 prior)"}`,
    `- reviewer invocation identity: ${meta.reviewerIdentity || "(待外部 review)"}`,
    `- executor invocation identity: ${meta.executorIdentity || agent}`,
    `- fresh session: ${meta.freshSession ?? "YES"}`,
    `- blocking findings（本輪內部 review）: ${meta.blockingFindings || "無"}`,
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
    `- executable-bit changes (vs base tree): ${inventory.execBitChanges.length ? inventory.execBitChanges.join(",") : "NONE（已完整列舉）"}`,
    `- dependency changes: ${inventory.dependencyChanges.length ? inventory.dependencyChanges.join(",") : "NONE（已完整列舉）"}`,
    `- renames: ${inventory.renames.length ? inventory.renames.length : "NONE（已完整列舉）"}`,
    `- external side effect / network write / production write: 本 bundle 產生過程僅執行本地 git／npm 指令（無 fetch/push/remote）與寫入 ${outDir}；generator 未 import 任何 node:net/http/https 模組（已靜態檢查）；寫入路徑全部落在 outDir 內（見下方 write footprint）`,
    `- SECURITY_CHECK_STATUS: ${securityComplete ? "COMPLETE (no UNKNOWN, no blocking item)" : "INCOMPLETE — 產生已中止"}`,
    `- blocking items: ${securityBlockers.length ? securityBlockers.join("; ") : "NONE"}`,
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
    `- stop conditions triggered: ${stopConditions.length ? stopConditions.join(",") : "NONE"}（已傳入 gate；任一觸發即不產生 bundle）`,
    `- effective authority（若提供）: ${effectiveText}`,
    "",
    section("11. OPEN QUESTIONS AND REVIEW REQUEST"),
    ...(meta.openQuestions || []).map((q) => `- ${q}`),
    "",
    `NEXT_ACTION_IF_PASS: 驗證 digest-bound result artifact → 推送已審查的 checkpoint HEAD → Draft PR 建立／更新（整合紀錄＋CI；不建立新 commit）`,
    `NEXT_ACTION_IF_REPAIR: 依 reviewer findings 於授權範圍內 bounded repair → fresh verification → 重新產生 bundle（repair round 遞增）`,
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

  // ── write-footprint verification (real measurement) ──
  const outDirResolved = resolve(outDir);
  for (const w of [tmp, target, archive]) {
    if (!w.startsWith(outDirResolved + "/")) {
      fail(GOV_HOLD.SECURITY_CHECK_INCOMPLETE, `write outside outDir: ${w}`);
    }
  }
  const writeFootprint = [tmp, target, archive].map((p) => p.replace(outDirResolved, "<outDir>"));

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
    review_round: reviewRound,
    repair_round: repairRounds,
    remaining_repair_budget: Math.max(0, reviewUnit.limits.maximum_repair_rounds - repairRounds),
    prior_findings_digest: priorFindingsDigest || null,
    security_complete: securityComplete,
    write_footprint: writeFootprint,
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
  return report;
}

// ── CLI main: production ALWAYS runs the governance-defined command set. ──
const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    generateReviewBundle({ verifyCommands: DEFAULT_VERIFY_COMMANDS });
  } catch (e) {
    if (e && e.code) {
      console.error(e.code);
      console.error(`  - ${e.message}`);
      process.exit(1);
    }
    console.error(e.message ?? e);
    process.exit(2);
  }
}
