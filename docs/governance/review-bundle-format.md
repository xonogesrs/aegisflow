# External Review Bundle 格式（Review-Unit 版）

> 固定規則：每次完成需要外部 review 的 review unit 後，Agent 產生完整、可獨立審查的純文字
> bundle，Controller 直接上傳給外部 reviewer。**Draft PR 不再是首次外部 review 的必要前置條件。**

## 流程

```text
Agent 實作多個內部 milestones（本地 checkpoint commits）
→ fresh full verification
→ 產生桌面 review bundle（scripts/gov-review-bundle.mjs）
→ HOLD / WAITING_FOR_EXTERNAL_REVIEW
→ Controller 上傳 bundle 給外部 reviewer
→ 外部 reviewer 判定
→ PASS 後才允許 integration commit／push／Draft PR（Draft PR 僅作整合紀錄＋CI 載體）
```

## 固定輸出位置

```text
$HOME/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt
$HOME/Desktop/AutoLoop-Review/archive/<YYYYMMDD-HHMMSS>-<CARD_ID>-<RUN_ID>.txt
```

寫入協定：建立目錄 → 寫入暫存檔 → 完整 secret scan → 驗證未截斷 → atomic rename 更新
`READY_FOR_REVIEW.txt` → timestamped archive 副本。實際輸出位置必須等於 authorization
artifact 授權之 canonical `bundle_path`（不一致 → `HOLD / BUNDLE_PATH_MISMATCH`）。

## 停止條件

產生 bundle 後 Agent 停止並回報：

```text
HOLD / WAITING_FOR_EXTERNAL_REVIEW
review_bundle: $HOME/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt
```

外部 reviewer 明確 PASS 前，不得 integration commit／push／建立或更新 Draft PR／標記 ready／
merge／release／seal／開始下一張實作卡。

## Round／Repair 帳目

- `REVIEW_ROUND`：外部 review 輪次（REPAIR 後遞增，round ≥ 2 的 result artifact 必須綁定
  上一輪 `prior_bundle_sha256`＋`prior_findings_digest`）。
- `repair round`：累計修復輪數，**不得重設**；`remaining repair budget = maximum_repair_rounds
  − repair round`。
- Bundle §7 必須包含**上一輪 external findings 全文與其 findings digest**。
- fresh verification 為強制：production CLI 完全移除 `--skip-fresh-verify` 與任何
  `--verify-config` 旗標（round 4 finding 1：`--verify-config` 一併明確拒絕，無法以任意
  命令集取代驗證）；任一測試 FAIL 或 NOT RUN → `HOLD / FRESH_VERIFY_FAILED`，**不產生
  bundle**。Production 固定執行治理定義的完整命令集（`npm run check` / `npm run
  test:governance` / `npm run test:v1` / `npm run test:v2` / `git diff --check`）。
  測試注入只能透過程式內部 dependency injection（`generateReviewBundle({ verifyCommands })`
  的函式參數），不得暴露成 production CLI flag，也不得經由環境變數開後門。
- bundle §6 內嵌每項命令的 parsed totals（`ℹ tests / pass / fail` 行）供 reviewer 獨立核對；
  §1 內嵌完整 authorization record 與 effective authority。

## Bundle 章節

1. **AUTHORIZATION AND PROHIBITED ACTIONS** — 授權範圍、禁止清單、AUTHORIZED_BINDINGS
   （repository/branch/base/base_head/bundle_path）、Agent 聲明（未 commit/push/PR/merge/release/seal）
2. **EXECUTIVE SUMMARY** — 目標、完成、未完成、自評、限制、負面結果
3. **REPOSITORY INTEGRITY** — branch/HEAD/base/status/diff-check + inventory 統計
4. **CHANGED PATHS (complete inventory)** — 逐項路徑、狀態、scope 標記、SYMLINK/BINARY/
   EXEC_BIT_CHANGED、mode、content sha256；deleted/staged/untracked/dependency 清單
5. **COMPLETE PATCH** — committed＋staged＋dirty＋untracked 完整內容；**不得截斷**
6. **TEST AND VERIFICATION RESULTS** — fresh rerun；每項含完整命令、exit code、通過數、
   失敗輸出、test_output_digest
7. **REVIEW AND REPAIR HISTORY** — reviewer/executor identity、fresh session、findings、
   repair rounds、budget 剩餘、internal milestones、architecture goal
8. **ARTIFACT AND EVIDENCE IDENTITY** — changed-tree identity、patch SHA-256、
   test-output digest、evidence digest、bundle SHA-256、計算命令；**digest 由工具計算，非信任輸入**
9. **SECURITY CHECK** — secret scan、binary、symlink（lstat）、executable bit、
   dependency、side effect；全部必須完整列舉（無 UNKNOWN）；無法確定 → `HOLD / SECURITY_CHECK_INCOMPLETE`
10. **REVIEW UNIT BOUNDARY** — limits 與 actual 逐項對照、early-stop conditions、
    effective authority
11. **OPEN QUESTIONS AND REVIEW REQUEST** — reviewer 確認點＋NEXT_ACTION_IF_PASS/REPAIR/HOLD

## 治理接線

- schema v2 頂層綁定：`repository / worktree / branch / base / authorized_paths / bundle_path`
- `lifecycle_authorization.external_review`：`required`、`require_bundle`、`bundle_path`
- 三個 post-PASS gate 皆強制（當 `external_review.required=true`）：
  - integration-commit-gate：digest-bound result artifact（bundle/patch/changed-tree/card/run/round）
  - feature-branch-push-gate：verified result artifact + HEAD 未偏離
  - draft-pr-lifecycle：verified result artifact + repo/card/head 綁定 + PR draft state
- 外部 review 狀態：`PENDING / PASS / REPAIR / HOLD`（`src/governance/external-review.mjs`）
- external review result artifact：`<execDir>/governance/external-review-result.json`
  （`autoloop.external-review-result/v1`，harness-owned、digest-bound）
