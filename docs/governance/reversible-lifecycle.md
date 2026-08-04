# Reversible Lifecycle Governance

> 狀態：實作完成，待 GitHub 外部 review
> 卡片：`AUTOLOOP-GOVERNANCE-REVERSIBLE-LIFECYCLE-1`
> 分支：`governance/reversible-lifecycle-draft-pr`
> 基底：main（未修改）

## 1. 目的

讓一張高階入口卡可以一次授權完整、受控且可逆的工作生命週期：

```text
拆卡 → 執行 → 獨立 review → 有限 repair → fresh verification
→ checkpoint commit → feature branch push → Draft PR 建立／更新
```

不再要求使用者逐張人工發出 review 卡、repair 卡、checkpoint commit 卡、push 卡或 Draft PR 更新卡。

## 2. Commit 的新定位

```text
checkpoint commit ≠ final approval ≠ merge ≠ seal ≠ release
```

Checkpoint commit 只是「已通過本地 gate、可獨立審查、可回滾、可追溯、可供 Draft PR 外部 review」的工作狀態。

## 3. 可逆／不可逆分離

入口卡明確授權後可自主執行：`DECOMPOSE / EXECUTE / INDEPENDENT_REVIEW / BOUNDED_REPAIR / FRESH_VERIFY / CHECKPOINT_COMMIT / FEATURE_BRANCH_PUSH / DRAFT_PR_CREATE / DRAFT_PR_UPDATE`

以下仍必須明確停下交回 Controller：`MERGE_MAIN / FORCE_PUSH / DELETE_REMOTE_BRANCH / DELETE_TAG / FINAL_SEAL / CREATE_RELEASE / PUBLISH_PACKAGE / PRODUCTION_MIGRATION / SECRET_CREATE_OR_ROTATE / EXTERNAL_SERVICE_WRITE / PHYSICAL_DEVICE_OPERATION / PAYMENT / EMAIL_OR_PUBLICATION`

## 4. 向後相容（fail-closed 預設）

入口卡若無 `lifecycle_authorization` 區塊：

```text
commit = DENIED  push = DENIED  draft_pr = DENIED  merge = DENIED  seal = DENIED
```

既有 `commit=NO`、`push=NO`、`seal=NO` 絕不被新治理隱式覆寫。

## 5. 授權契約

Schema：`src/schema/lifecycle-authorization.schema.json`（`autoloop.lifecycle-authorization/v1`）。

範例（即本卡授權）：

```yaml
lifecycle_authorization:
  decomposition:        { allowed: true, max_depth: 1, max_total_nodes: 16 }
  independent_review:   { allowed: true, require_fresh_session: true, require_same_artifact_digest: true }
  bounded_repair:       { allowed: true, max_rounds: 2, scope_expansion: false }
  checkpoint_commit:    { allowed: true, require_local_gates_pass: true, require_clean_index_before_stage: true, require_expected_paths_only: true }
  feature_branch_push:  { allowed: true, branch_pattern: "governance/*", force_push: false, require_remote_ancestor_check: true }
  draft_pr:             { allowed: true, base_branch: main, draft_only: true, create_if_missing: true, update_if_present: true }
  merge_main:           { allowed: false }
  release:              { allowed: false }
  seal:                 { allowed: false }
```

## 6. 授權繼承（§5）

```text
child effective authority = parent authority ∩ child declared authority ∩ runtime policy
```

子卡不得擴大 writable scope、不得增加 commit repository、不得改變 branch pattern、不得提高 repair rounds、不得開啟父卡禁止的 push／merge／seal、不得把 Draft PR 授權提升為 merge 授權。

任何 escalation → `HOLD / AUTHORITY_ESCALATION_REJECTED`（`src/governance/lifecycle-authorization.mjs` 之 `effectiveAuthority`）。

## 7. Lifecycle 狀態分層（§6）

```text
NODE_PASS → CARD_PASS → MILESTONE_PASS → CHECKPOINT_COMMITTED → DRAFT_PR_UPDATED → PR_READY → FINAL_SEAL
```

- `NODE_PASS` 不代表父卡完成；`CARD_PASS` 不代表 milestone 可提交；`CHECKPOINT_COMMITTED` 不代表外部 review 通過；`DRAFT_PR_UPDATED` 不代表 PR ready；`PR_READY` 不代表可以 merge；`FINAL_SEAL` 維持獨立、最高層級治理（本授權永不自動）。

狀態機：`src/governance/lifecycle-state.mjs`（未宣告之轉移一律 `HOLD / LIFECYCLE_TRANSITION_INVALID`）。

## 8. Checkpoint Commit Gate（§7）

`src/governance/checkpoint-commit-gate.mjs` — 12 條件全過才可 commit：

```text
1 branch 符合授權 pattern   2 不在 main/master/受保護 branch
3 changed paths 全在 scope   4 無未知 staged path
5 git diff --check 通過      6 必要測試與驗證通過
7 artifact identity 已固定    8 evidence digest 已建立
9 無 blocking review finding  10 repair 已收斂或誠實負面結果
11 無 secret-like 真實值      12 commit message 含 card/milestone identity
```

Commit footer：

```text
AutoLoop-Card: <card_id>
AutoLoop-Run: <run_id>
AutoLoop-Milestone: <milestone_id>
Evidence-Digest: <digest>
```

CLI：`scripts/gov-commit-checkpoint.mjs`（預設 dry-run；`--apply` 才實際 commit）。

## 9. Push Gate（§8）

`src/governance/feature-branch-push-gate.mjs` — 僅允許 push 到授權 feature branch；remote 分支未知更新 → `HOLD / REMOTE_BRANCH_DIVERGED`；不得自動 rebase／覆蓋／force-push。

CLI：`scripts/gov-push-gate.mjs`（預設 dry-run；`--apply` 才實際 push）。

## 10. Draft PR Lifecycle（§9）

`src/governance/draft-pr-lifecycle.mjs` — 每張父卡一個 Draft PR，同 head branch 持續更新；不得為每張子卡建立新 PR；不得自動標記 ready；不得自動 merge。Body 含 §9 全部章節。

CLI：`scripts/gov-draft-pr.mjs`（預設 dry-run；`--apply` 才呼叫 gh）。

## 11. 自動 Review 與 Repair（§10）

入口卡授權後自行完成：`executor result → fresh independent reviewer → blocking finding classification → bounded repair → fresh rerun`。

Reviewer 使用不同 session／invocation identity、讀取固定 artifact digest、不接受 executor 自述代替證據、檢查 scope/tests/evidence/changed paths、不自行擴張 repair scope。超過預算 → `HOLD / REPAIR_BUDGET_EXHAUSTED`。

## 12. 交回 Controller 的條件（§11）

`AUTHORITY_ESCALATION_REQUIRED / MAJOR_ARCHITECTURE_DECISION / SCOPE_EXPANSION_REQUIRED / SECRET_ACCESS_REQUIRED / PHYSICAL_DEVICE_REQUIRED / PRODUCTION_SIDE_EFFECT_REQUIRED / MERGE_OR_RELEASE_REQUIRED / REMOTE_BRANCH_DIVERGED / REPAIR_BUDGET_EXHAUSTED / EVIDENCE_IDENTITY_MISMATCH / UNRESOLVED_BLOCKING_REVIEW` → 一律 `HOLD / <specific_reason>`。

## 13. 模組地圖

```text
src/schema/lifecycle-authorization.schema.json  授權契約 schema
src/governance/holds.mjs                        HOLD taxonomy（共用 C2dHoldError）
src/governance/lifecycle-state.mjs              狀態分層與轉移
src/governance/lifecycle-authorization.mjs      schema 驗證 + effective authority + escalation
src/governance/checkpoint-commit-gate.mjs       §7 十二條件 gate
src/governance/feature-branch-push-gate.mjs     §8 push gate
src/governance/draft-pr-lifecycle.mjs           §9 Draft PR lifecycle
scripts/gov-commit-checkpoint.mjs               checkpoint commit CLI（dry-run 預設）
scripts/gov-push-gate.mjs                       push CLI（dry-run 預設）
scripts/gov-draft-pr.mjs                        Draft PR CLI（dry-run 預設）
scripts/gov-effective-authority.mjs             effective authority 計算 CLI
test/governance/*.mjs                           §13 測試（六類）
```

## 14. 驗證

```text
npm run test:governance  → 六類測試全過
npm run check            → 全 src 語法檢查
git diff --check         → clean
main 未修改；未 force-push；未 merge；未 seal
```
