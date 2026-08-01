# AutoLoop 現況分析（2026-08-02，已更新簡化架構）

---

## 架構定案（簡化版）

```
大任務
→ AutoLoop 拆成小卡（deterministic rules）
→ Pi + DeepSeek V4 單一模型依序執行小卡
→ AutoLoop 驗證範圍、證據與流程（deterministic rules）
→ 產出完整 review package
→ GPT 做最終外部 review
```

### 三個角色，各司其職

| 角色 | 誰做 | 做什麼 | 可以修改安全規則？ |
|------|------|--------|:--:|
| 執行者 | Pi + DeepSeek V4 | 拆卡、執行、自我修復、整理證據 | ❌ |
| 流程裁決 | AutoLoop deterministic rules | 驗證範圍、證據、mutation scope、permit | ❌（只有人能改） |
| 最終審查 | GPT | review 完整結果、通過/拒絕 | ❌ |

### 因此可以砍掉/暫緩的

- ❌ 多模型角色分工（執行者跟 reviewer 用不同 provider）
- ❌ 模型投票或交叉辯論
- ❌ 多 Agent 協調
- ❌ 複雜的模型選擇器
- ❌ 不同模型間的上下文轉換
- ❌ P3#20 多 Provider 路由（整項移除）

### 因此簡化的

- P1#11 Reviewer 獨立性：executor = DeepSeek V4，reviewer = GPT，天然獨立，不用費心設計內部隔離

---

## AutoLoop 的發佈形式：Skill + Scripts（跨 agent）

```
autoloop/
├── SKILL.md                    # Agent 讀這個，知道怎麼呼叫
├── scripts/
│   ├── validate-card.js        # 輸入：task card，輸出：pass/reject + reason
│   ├── prepare-run.js          # baseline snapshot + lock + permit
│   ├── execute.js              # 呼叫 provider，收集 raw result
│   ├── validate-result.js      # diff 比對、mutation scope 檢查
│   ├── review-package.js       # 組裝完整 review package
│   └── commit.js               # 授權 commit
├── core/                       # 從 Aura 抽出的 43 個模組
│   ├── checkpoint.js
│   ├── fingerprint.js
│   ├── journal.js
│   ├── lock.js
│   ├── permit.js
│   ├── mutation-scope.js
│   └── reconcile.js
└── tests/
    └── fixtures/
```

強制力在 scripts 裡（deterministic JS），不在 agent 的 extension 裡。任何能跑 `node` 的 agent 都能調用。

---

## 現有 pi 技能 vs AutoLoop 的關係

| pi 技能 | AutoLoop 內的角色 |
|---------|-----------------|
| `spec-driven-dev` | 大任務的 spec → 小 task cards |
| `tdd` | 小卡執行時的測試紀律 |
| `code-review` | AutoLoop 內部檢查的輔助（最終 review 由 GPT 做） |
| `triage` | AutoLoop HOLD 之後的問題分類 |

---

## 近期實作順序（已更新）

```text
1. Claude 完成 Pi RPC 接線
2. Pi + DeepSeek V4 跑通單一任務（end-to-end）
3. 建立大卡切小卡能力 ← 最關鍵
4. 建立逐卡執行與恢復
5. 建立最終 review package
6. GPT review 完整結果
```

---

## 拆分階段 Pi 的工作（不變）

1. 建立 standalone 目錄結構
2. 複製 43 個來源檔案
3. 去除 Aura 特定命名
4. 拆出 Git diff helper
5. 建立最小 package.json
6. 建立 provider-neutral import smoke test
7. 搬入 tests/fixtures
8. 確認不依賴 Aura、OpenCode、外部 npm
9. 產出 capability-gap backlog

不需要新工具，現有的 read/write/edit/bash 就夠用。
