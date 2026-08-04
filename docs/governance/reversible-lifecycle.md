# Reversible Lifecycle Governance — Review-Unit Edition

> 狀態：實作完成，待 GitHub 外部 review
> 卡片：`AUTOLOOP-GOVERNANCE-REVIEW-UNIT-FINALIZATION-1`
> 分支：`governance/reversible-lifecycle-draft-pr`
> 基底：main（未修改）
> Schema：`autoloop.lifecycle-authorization/v2`

## 1. 目的

讓一張高階入口卡一次授權**一個連貫的 review unit**（可含最多 3 個內部 milestones），
Agent 在內部完成多個 milestone、建立本地 checkpoint commits 保留回滾點，最後只輸出
**一次完整文字 review bundle**：

```text
入口卡授權
→ Agent 拆分內部 milestones
→ 執行 milestone 1 → local gate → 本地 checkpoint commit
→ 執行 milestone 2 → local gate → 本地 checkpoint commit
→ （必要時 bounded repair）→ fresh full verification
→ 產生桌面文字 review bundle
→ WAITING_FOR_EXTERNAL_REVIEW
→ Controller 上傳 bundle → 外部 PASS / REPAIR / HOLD
```

外部 PASS 後（且僅在此時）：

```text
→ integration-approved commit（digest-bound external-review-result artifact）
→ feature branch push（若需要）
→ Draft PR（若需要 CI 或整合紀錄；僅作整合紀錄，不作為首次外部 review 前置）
```

**Draft PR 不再是首次外部 review 的必要條件。**

## 2. Review Unit 任務邊界

執行單位 = ONE COHERENT REVIEW UNIT。預設上限（同時具備 schema、normalization、
effective-authority intersection、runtime enforcement、negative tests、bundle rendering）：

```text
repository_count:          1
worktree_count:            1
parent_card_count:         1
architecture_goal_count:   1
maximum_internal_milestones: 3
maximum_changed_paths:     25
maximum_patch_lines:       3000
maximum_repair_rounds:     2
```

上述為**預設上限**；入口卡可在 `review_unit` 區段明確宣告更大的
`maximum_changed_paths`／`maximum_patch_lines`（schema 提供 sanity bounds：64／20000），
runtime 一律以**有效（宣告）上限**執行。本卡（AUTOLOOP-GOVERNANCE-REVIEW-UNIT-
FINALIZATION-1）因授權範圍內完整修復必然超過預設 path/line 上限，故於 authority record
明確宣告 `maximum_changed_paths: 64`、`maximum_patch_lines: 20000`，並於 bundle
§10 REVIEW UNIT BOUNDARY 逐項揭露 actual vs limit。

遇到以下任一情況，**不得繼續擴大 review unit**，必須輸出具體 HOLD reason：

```text
跨 repository / 第二個 worktree / 第二個獨立架構目標
超過 milestone／path／patch／repair 上限
重大架構選擇尚未決定 / 需要擴張 writable scope
需要 secret 或 production access / 實體裝置 / 外部服務寫入 / production migration
需要 merge／release／seal / remote divergence
測試無法重現 / evidence identity 無法固定 / bundle 無法完整輸出
patch 大到 reviewer 無法可靠一次審查
```

實作：`src/governance/review-unit-gate.mjs`（`HOLD / REVIEW_UNIT_LIMIT_EXCEEDED`）。

## 3. 授權契約（Schema v2）

Schema：`src/schema/lifecycle-authorization.schema.json`（`autoloop.lifecycle-authorization/v2`）。

新增：

- 頂層綁定欄位：`repository`、`worktree`、`branch`、`base`、`base_head`、
  `authorized_paths`（writable scope）、`bundle_path`（canonical bundle 輸出位置）、`run_id`。
- `lifecycle_authorization.review_unit` 區段（上限契約，見 §2）。
- 其餘區段（decomposition / independent_review / bounded_repair / checkpoint_commit /
  feature_branch_push / draft_pr / external_review / merge_main / release / seal）。

Runtime validator（`src/governance/lifecycle-authorization.mjs`）與 schema 為**同一契約**：
`additionalProperties:false`、required fields、const、integer bounds、string length 全部一致
（parity tests：`test/governance/test-schema-parity.mjs`，以獨立 evaluator 交叉驗證）。

## 4. 授權交集方向（effective authority = parent ∩ child ∩ runtime）

`src/governance/lifecycle-authorization.mjs` 之 `effectiveAuthority`。欄位分三類，方向不可混用：

### 4.1 Restrictive requirements（true = 更嚴格）— 聯集

```text
external_review.required / require_bundle
independent_review.require_fresh_session / require_same_artifact_digest
checkpoint_commit.require_local_gates_pass / require_clean_index_before_stage / require_expected_paths_only
feature_branch_push.require_remote_ancestor_check
draft_pr.draft_only
```

有效值 = `parent || child || runtime`：**runtime 設為 false 無法取消較嚴格要求**；
child 放寬 parent 的要求 → `HOLD / AUTHORITY_ESCALATION_REJECTED`。

### 4.2 Permission／capability（true = 增加能力）— 交集

```text
allowed（各區段）
bounded_repair.scope_expansion
feature_branch_push.force_push
draft_pr.create_if_missing / update_if_present
```

有效值 = `parent && child && runtime`；child 要求 parent 已否決的能力 → escalation；
runtime 永遠不能授予超過 parent ∩ child 的能力（例如 runtime `force_push:true` 無法放行）。

### 4.3 Pattern 與 identity — 真正交集

- branch pattern：containment 交集；交集無法證明安全時 **fail-closed HOLD**，不選擇較寬 pattern。
- base_branch / bundle_path / repository / worktree / branch / base：exact equality，衝突 → HOLD。
- authorized_paths：child 路徑必須被 parent scope 涵蓋（escaping → escalation）；
  runtime 只可收窄。

**禁止** `child || parent || runtime` 假裝代表 pattern intersection。

## 5. 兩種 Commit（分離，不共用 gate）

### 5.1 Internal checkpoint commit（§8.1）

用途：本地回滾點、milestone 邊界、repair 前後定位、大型 dirty worktree 風險控制。

```text
- 非 main/master、單一授權 repo/worktree、changed paths 在授權 scope
- 無未知 staged path、git diff --check PASS、milestone local verification PASS
- secret scan PASS、artifact identity 已固定、commit footer 完整
- review-unit 上限未超過
- 不要求外部 review PASS
- 不得 push
```

Gate：`src/governance/checkpoint-commit-gate.mjs`（無 external-review 條件）。
CLI：`scripts/gov-commit-checkpoint.mjs`（dry-run 預設；`--apply` 本地 commit）。

### 5.2 Integration-approved commit（§8.2）

用途：外部 review 已通過的完整 review unit，準備 push／Draft PR／CI。

```text
- 有效 external-review-result artifact（harness-owned，digest-bound）
- verdict = PASS
- bundle digest 完全匹配（重算自實際 bundle 檔）
- patch digest 完全匹配（重算自實際內容）
- changed-tree identity 完全匹配
- card / run / review round / head / base / repo / branch 一致
- 目前 worktree／HEAD 未偏離被審查 artifact
- fresh full verification PASS
```

Gate：`src/governance/integration-commit-gate.mjs`。CLI：`scripts/gov-commit-integration.mjs`。

**Gate 不得接受** `--external-review-status PASS` 或 `--reviewed-artifact-identity <caller>`
作為授權來源（`HOLD / RESULT_SELF_DECLARATION_REJECTED`）。

## 6. External Review Result Artifact（§9）

Harness-owned、digest-bound：`<execDir>/governance/external-review-result.json`。

```text
schema / card_id / run_id / verdict(PASS|REPAIR|HOLD)
bundle_sha256 / patch_sha256 / changed_tree_identity
reviewer_identity / reviewed_at / review_round / findings_digest
current_head / base_head / repository / branch / base_branch / bundle_path
```

Gate 讀取 artifact → 重新計算目前 identity → 比對；任何不一致 →
`HOLD / EVIDENCE_IDENTITY_MISMATCH`。Agent 不得自行建立 PASS result。

## 7. Lifecycle 狀態機

```text
AUTHORIZED
→ EXECUTING
→ INTERNAL_MILESTONE_PASS
→ INTERNAL_CHECKPOINT_COMMITTED
→ EXECUTING（下一個 milestone）
→ … → FULL_VERIFICATION_PASS
→ REVIEW_BUNDLE_READY
→ WAITING_FOR_EXTERNAL_REVIEW
```

外部判定：

```text
PASS   → EXTERNAL_REVIEW_PASS → INTEGRATION_READY
REPAIR → EXTERNAL_REVIEW_REPAIR → BOUNDED_REPAIR
         → FULL_VERIFICATION_PASS → REVIEW_BUNDLE_READY → WAITING_FOR_EXTERNAL_REVIEW
HOLD   → CONTROLLER_REQUIRED
```

`PR_READY / MERGED / RELEASED / FINAL_SEAL` **不得由本 reversible lifecycle 自動進入**；
`PR_READY → FINAL_SEAL` 已移除；任何 seal transition 都交回最高治理／Controller。

實作：`src/governance/lifecycle-state.mjs`（未宣告之轉移一律 `HOLD / LIFECYCLE_TRANSITION_INVALID`）。

## 8. 外部 Review Bundle（§6/§7/§11/§16）

固定輸出：

```text
$HOME/Desktop/AutoLoop-Review/READY_FOR_REVIEW.txt
$HOME/Desktop/AutoLoop-Review/archive/<YYYYMMDD-HHMMSS>-<CARD_ID>-<RUN_ID>.txt
```

Bundle 涵蓋整個 review unit（不只最後一個 milestone）：

```text
入口卡與完整授權範圍 / base HEAD / current HEAD / 全部 checkpoint commits
每個 milestone 的目的與結果 / base..HEAD 完整 diff（committed＋staged＋dirty＋untracked）
所有新增文字檔完整內容 / changed paths / 每次 repair 的前後差異
full test commands 與結果（fresh rerun）/ fresh verification / evidence digests
artifact identity / secret scan / symlink／mode／dependency 變更
known limitations / open questions
```

不得以「內容過長」、「省略」或摘要代替完整 patch。

Change inventory（`src/governance/change-inventory.mjs`）不以 `git diff base...HEAD
--name-status` 為唯一來源，統一涵蓋 committed / staged / tracked dirty / untracked /
renames / deletions / file modes / symlinks（lstat）/ binaries / dependency changes。

Identities 全部由實際內容計算（非信任輸入）：`changedTreeIdentity`、`patchSha256`、
`testOutputDigest`、`evidenceDigest`、`bundleSha256`。

Security checks（§12）fail-closed：任何檢查無法確定 → `HOLD / SECURITY_CHECK_INCOMPLETE`，
不產生 bundle；symlink 一律以 lstat 判定。

CLI：`scripts/gov-review-bundle.mjs`（寫入協定：暫存檔 → atomic rename → archive copy；
輸出位置必須等於 authorization 授權之 canonical bundle path）。

## 9. Push Gate（§8/§13）

`src/governance/feature-branch-push-gate.mjs` — push 僅在 verified external review PASS
（digest-bound result artifact）之後；remote 分支未知／diverged → `HOLD / REMOTE_BRANCH_DIVERGED`；
不得自動 rebase／覆蓋／force-push。CLI：`scripts/gov-push-gate.mjs`。

## 10. Draft PR Lifecycle（§13）

`src/governance/draft-pr-lifecycle.mjs` — Draft PR 僅在 `EXTERNAL_REVIEW_PASS` 或
`INTEGRATION_READY` 之後建立／更新。建立／更新前核對 repository identity、head branch、
base branch、parent card identity、PR draft state、既有 PR 與 parent card 的綁定、
review-result digest。同一 head 上存在非 draft PR 時**不得直接 UPDATE**。
PR 不得自動標記 ready、不得自動 merge、不得自動啟用 auto-merge。
CLI：`scripts/gov-draft-pr.mjs`。

## 11. 交回 Controller 的條件

`AUTHORITY_ESCALATION_REJECTED / GOVERNANCE_SCOPE_EXPANSION_REQUIRED /
REVIEW_UNIT_LIMIT_EXCEEDED / REPAIR_BUDGET_EXHAUSTED / REMOTE_BRANCH_DIVERGED /
EVIDENCE_IDENTITY_MISMATCH / SECURITY_CHECK_INCOMPLETE /
EXTERNAL_REVIEW_RESULT_MISSING|INVALID / BUNDLE_PATH_MISMATCH /
LIFECYCLE_TRANSITION_INVALID / UNRESOLVED_BLOCKING_REVIEW` → 一律 `HOLD / <specific_reason>`。

## 12. 模組地圖

```text
src/schema/lifecycle-authorization.schema.json    授權契約 schema v2（top-level bindings + review_unit）
src/governance/holds.mjs                          HOLD taxonomy
src/governance/lifecycle-state.mjs                狀態機（review-unit 版）
src/governance/lifecycle-authorization.mjs        schema 驗證 + effective authority + escalation
src/governance/review-unit-gate.mjs               review-unit 邊界與 early-stop 條件
src/governance/change-inventory.mjs               完整 change inventory + identities
src/governance/external-review.mjs                external review 狀態 + result artifact 契約
src/governance/review-context.mjs                 目前 review context 重算（bundle digest 等）
src/governance/checkpoint-commit-gate.mjs         §8.1 internal checkpoint gate
src/governance/integration-commit-gate.mjs        §8.2 integration-approved commit gate
src/governance/feature-branch-push-gate.mjs       §9 push gate（PASS 後）
src/governance/draft-pr-lifecycle.mjs             §10 Draft PR lifecycle（PASS 後）
scripts/gov-review-bundle.mjs                     external review bundle 生成
scripts/gov-commit-checkpoint.mjs                 internal checkpoint commit CLI
scripts/gov-commit-integration.mjs                integration-approved commit CLI
scripts/gov-push-gate.mjs                         push CLI（dry-run 預設）
scripts/gov-draft-pr.mjs                          Draft PR CLI（dry-run 預設）
scripts/gov-effective-authority.mjs               effective authority 計算 CLI
scripts/shared/gov-args.mjs / gov-context.mjs     argv 解析 / 共用 git+inventory+context
docs/governance/reversible-lifecycle.md           本文件
docs/governance/review-bundle-format.md           external review bundle 格式
test/governance/*.mjs                             測試（含 22 負向 + e2e temp repo）
```

## 13. 驗證

```text
npm run test:governance  → 全部通過（127+，含 22 負向與 e2e）
npm run check            → 全 src 語法檢查
npm run test:v1 / v2     → 既有套件全過
git diff --check         → clean
scripts/gov-review-bundle.mjs → 桌面 bundle 產生；停止於 WAITING_FOR_EXTERNAL_REVIEW
```

外部 reviewer 明確 PASS 前：不 push、不更新 PR、不 merge、不 release、不 seal、
不開始其他任務。
