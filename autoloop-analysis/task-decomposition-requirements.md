# Task Decomposition Requirements

> AutoLoop「大卡切小卡」第一版最小 contract。
> 狀態：REQUIREMENTS（非實作）
> 產生者：Pi + DeepSeek V4
> 來源性質標記：SOURCE（來自既有分析與 repo 程式碼）、INFERENCE（跨文件推導）、RECOMMENDATION（Pi 提出的設計建議）

---

## 1. 架構前提

SOURCE: pi-assessment.md §架構定案、graph-lite.md §核心定位

```
Parent Task
→ AutoLoop 流程控制
→ Pi + DeepSeek V4 單一執行路徑
→ 有限 REPAIR
→ 完整結果與證據
→ GPT 外部 Review
```

Task Decomposition 發生在「Parent Task 進入 → 第一張 child card 執行前」之間的階段。Decomposer 是 Pi 的角色，驗證是 AutoLoop deterministic rules 的角色。

---

## 2. 輸入 Contract

SOURCE: card-input.schema.json（repo src/schema/card-input.schema.json）

Decomposer 接收的 parent card 必須是合法 card-input schema 的 instance。最低輸入欄位：

```json
{
  "card_id": "<string>",
  "mode": "<CHANGE | FIX | IMPLEMENT | READ_ONLY_DESIGN>",
  "worktree_path": "<string>",
  "base_branch": "<string>",
  "executor": { "model": "<deepseek-v4 model>" },
  "reviewer": { "default": "<GPT model>" },
  "scope": {
    "allowed_paths": ["<path>"],
    "forbidden_paths": ["<path>"]
  },
  "limits": {
    "commit_allowed": false,
    "push_allowed": false,
    "seal_allowed": false,
    "mutation_allowed": false,
    "max_repair_rounds": 2
  },
  "card_body": "<free-text task description>"
}
```

RECOMMENDATION: 拆卡時需額外提供：

- `repository_context`: Git root、branch、HEAD、remote count、dirty flag
- `authority_boundary`: 從 parent card 的 scope/limits 推導，子卡不得擴張
- `max_child_cards`: 第一版上限 7
- `max_repair_attempts_per_card`: 第一版 1

---

## 3. 輸出 Contract

SOURCE: graph-lite.md §建議導入順序、codex-original.md §P2#13 大卡拆小卡

Decomposer 輸出必須是結構化 JSON（非自然語言），欄位：

```json
{
  "parent_goal": "<string — 從 parent card_body 精煉的單句目標>",
  "child_cards": [
    {
      "card_id": "<string — 由 decomposer 產生>",
      "goal": "<string — 這張小卡的單句目標>",
      "card_type": "READ_ONLY_AUDIT | IMPLEMENTATION | REPAIR | RUNTIME_VALIDATION | EXTERNAL_REVIEW | BASELINE_COMMIT",
      "prerequisites": ["<card_id> — 執行前必須滿足的非依賴條件>"],
      "depends_on": ["<card_id> — 必須先 PASS 的前置卡>"],
      "allowed_paths": ["<path>"],
      "forbidden_actions": ["<action>"],
      "authority_required": {
        "commit_allowed": false,
        "push_allowed": false,
        "mutation_allowed": false
      },
      "verification": {
        "required_commands": ["<command>"],
        "forbidden_commands": ["<command>"]
      },
      "hard_stop": ["<condition>"],
      "report_format": "<schema reference>",
      "risk_level": "LOW | MEDIUM | HIGH | CRITICAL"
    }
  ],
  "edges": [
    {
      "from": "<card_id>",
      "to": "<card_id>",
      "type": "depends_on | blocks_on_fail | blocks_on_hold"
    }
  ],
  "deferred_items": ["<parent requirement 無法由任何 child card 承接，附理由>"],
  "unresolved_items": ["<parent requirement 尚待澄清，附具體問題>"],
  "coverage_map": [
    {
      "parent_requirement": "<string>",
      "child_card_id": "<string>",
      "verification": "<string>"
    }
  ],
  "decomposition_evidence": ["<decomposer 如何推導出這個拆分的說明>"]
}
```

RECOMMENDATION: 如果 parent task 範圍太小（單一檔案、單一操作、無依賴），decomposer 可回傳：

```json
{
  "verdict": "DECOMPOSITION_NOT_BENEFICIAL",
  "reason": "<string>"
}
```

---

## 4. Child Card 類型定義

SOURCE: codex-original.md §P2#13，INFERENCE: 從現有 card-input mode enum 推導

| 類型 | 說明 | 允許 mutation | 範例 |
|------|------|:--:|------|
| `READ_ONLY_AUDIT` | 唯讀分析、盤點 | ❌ | 分析 repo 結構、檢查依賴 |
| `IMPLEMENTATION` | 程式碼變更 | ✅ | 新增功能、重構、修正 |
| `REPAIR` | 修正前卡失敗 | ✅（僅限前卡範圍） | 修復測試失敗 |
| `RUNTIME_VALIDATION` | 執行測試驗證 | ❌ | 跑 test suite、檢查 regression |
| `EXTERNAL_REVIEW` | 外部模型審查 | ❌ | GPT review |
| `BASELINE_COMMIT` | 授權 commit | ❌（只變 Git state） | 合併結果、建立 commit |

INFERENCE: 這些類型映射到現有 card-input.mode enum（READ_ONLY、CHANGE、OPS、IMPLEMENT、FIX、COMMIT_ONLY）但語意更精確。需在實作階段建立 mapping。

**禁止混在同一卡的組合：**

SOURCE: codex-original.md §P2#13

- Audit + mutation
- Implementation + external review
- Repair + baseline commit
- 高風險 runtime + source modification
- 不同 repo 的 mutation
- 多個不相關主要目標

---

## 5. 第一版限制

SOURCE: graph-lite.md §不建議現在做完整 Graph 平台

| 參數 | 第一版值 |
|------|---------|
| Child cards 數量 | 3–7 |
| Graph 類型 | static DAG |
| Writer 數量 | 1 |
| Concurrent mutation nodes | 0 |
| Repair loop | finite（max 1 per card） |
| Auto execution | disabled |
| Mode | shadow mode（只產生 DAG 不執行） |

---

## 6. Graph-lite 節點狀態

SOURCE: graph-lite.md §中斷與恢復

```
PENDING   → 尚未滿足前置條件
READY     → 所有 depends_on 已 PASS，可執行
RUNNING   → 正在執行中
PASS      → 執行成功，verified
REPAIR    → 執行失敗，進入修復
HOLD      → 無法修復或超出 repair budget
SKIPPED   → 有正式理由不執行（附 reason）
```

狀態轉移規則（INFERENCE，從 graph-lite.md 推導）：

```
PENDING → READY    (所有 depends_on = PASS)
READY   → RUNNING  (AutoLoop 核發執行)
RUNNING → PASS     (驗證通過)
RUNNING → REPAIR   (測試失敗、review finding)
REPAIR  → PASS     (修復成功)
REPAIR  → HOLD     (超出 repair budget 或同一 finding 再現)
READY   → SKIPPED  (有正式理由，附 reason)
HOLD    → (terminal，需人工介入)
```

---

## 7. Edge 與依賴規則

SOURCE: graph-lite.md §邊與依賴，INFERENCE: 補足細節

必須定義：

- `depends_on`: Card B 必須等 Card A PASS 才進入 READY
- PASS 解鎖下游：Card A PASS → 所有 depends_on Card A 的卡檢查是否所有前置都 PASS
- HOLD 阻擋 descendants：Card A HOLD → 所有直接/間接 depends_on Card A 的卡設為 PENDING（不得執行）
- REPAIR 回到原節點：Card A REPAIR → 不影響已 PASS 的上游卡
- SKIPPED 必須有正式理由，記錄在 card 的 `deferred_items`
- 不允許循環依賴
- 不允許 self-dependency
- 不允許指向不存在的 node

---

## 8. Parent Requirement Coverage

SOURCE: codex-original.md §P2#13，graph-lite.md §Parent requirement coverage

每一項 parent requirement 必須：

1. 被一張或多張 child card 承接（記錄在 coverage_map）；或
2. 明確放入 deferred_items 並附理由；或
3. 被判定不再適用並附理由

不得靜默遺漏。

Coverage map 格式：

```json
{
  "parent_requirement": "<從 parent card_body 提取的需求描述>",
  "child_card_id": "<string>",
  "verification": "<如何驗證這張 child card 滿足了該需求>"
}
```

---

## 9. 權限保留原則

SOURCE: pi-assessment.md §三個角色，INFERENCE

Child card 的 authority 不得超過 parent card：

- 若 parent `commit_allowed: false`，所有 child 也必須 `commit_allowed: false`
- 若 parent `push_allowed: false`，所有 child 也必須 `push_allowed: false`
- Child card 的 `allowed_paths` 必須是 parent `allowed_paths` 的子集
- Child card 的 `forbidden_paths` 必須包含 parent `forbidden_paths` 的所有項目
- 不得在 child card 中發明新的 commit/push/secret 權限

AutoLoop 在驗證 DAG 時必須機械式檢查這些約束。違反 → HOLD。

---

## 10. 與 spec-driven-dev 的邊界

SOURCE: pi-assessment.md §現有 pi 技能 vs AutoLoop 的關係，RECOMMENDATION

| | spec-driven-dev | Task Decomposer |
|---|---|---|
| 輸出格式 | Markdown（人類閱讀） | JSON（機器驗證） |
| 誰讀 | 開發者、LLM | AutoLoop deterministic validator |
| 依賴表示 | `[P]` 標記、Phase 順序 | depends_on edges、coverage map |
| 使用時機 | 人類主導的功能開發 | AutoLoop 內的自動化工作鏈 |
| 可驗證性 | 人工檢查 | 機械式 schema + DAG 驗證 |

責任分界：

- **spec-driven-dev**：人類主導的 spec → plan → tasks 流程，產出人工可讀的 tasks.md
- **Task Decomposer**：把 tasks.md 或 parent card 轉成結構化 JSON，供 AutoLoop 驗證和執行
- **AutoLoop**：驗證結構、DAG、權限，管理狀態，控制執行

不得讓兩邊維護互相矛盾的拆卡規則。實作時應考慮 spec-driven-dev 的 tasks.md 可作為 decomposer 的輸入來源之一。

---

## 11. Checkpoint 需求（定義，不實作）

SOURCE: graph-lite.md §中斷與恢復，codex-original.md §P1#12

未來 checkpoint 必須保存：

```json
{
  "graph_identity": "<parent card_id + execution_id>",
  "parent_baseline": {
    "branch": "<string>",
    "head": "<string>",
    "fingerprint": "<string>"
  },
  "node_states": {
    "<card_id>": {
      "state": "PASS | REPAIR | HOLD | SKIPPED",
      "attempt_count": 0,
      "verified_artifacts": ["<path>"],
      "mutation_snapshot": {
        "before": "<fingerprint>",
        "after": "<fingerprint>",
        "diff": "<git diff stat>"
      }
    }
  },
  "blocked_descendants": ["<card_id>"],
  "last_completed_transition": "<card_id>: PENDING → READY",
  "resume_preconditions": [
    "git branch = parent_baseline.branch",
    "working tree clean",
    "all PASS nodes unchanged since snapshot"
  ]
}
```

本卡只定義需求，不設計 persistent journal implementation。

---

## 12. Reason Codes（定義）

SOURCE: codex-original.md §五、可用性缺口 §2，RECOMMENDATION: 補足具體 codes

Decomposer 和 Graph validator 使用的 reason codes：

```text
# Decomposition 階段
DECOMPOSITION_NOT_BENEFICIAL     — parent task 太小，不值得拆分
DECOMPOSITION_CYCLE_DETECTED     — child cards 存在循環依賴
DECOMPOSITION_COVERAGE_GAP       — parent requirement 未被任何 child 承接
DECOMPOSITION_AUTHORITY_EXPANSION — child card 權限超過 parent

# Graph 驗證階段
GRAPH_CYCLE                      — DAG 驗證發現循環
GRAPH_ORPHAN_REQUIREMENT         — parent requirement 無對應節點
GRAPH_UNKNOWN_NODE_REF           — edge 指向不存在的 node
GRAPH_SELF_DEPENDENCY            — node depends_on 自己
GRAPH_MULTIPLE_WRITERS           — 多個 mutation node 同時 READY
GRAPH_UNBOUNDED_REPAIR           — repair loop 無上限
GRAPH_REVIEW_IMPLEMENTATION_MERGED — review 和 implementation 混在同一卡

# 執行階段
EXECUTION_MUTATION_SCOPE_VIOLATION — 實際變更超出 allowed_paths
EXECUTION_EVIDENCE_INCOMPLETE      — 必要證據缺失
EXECUTION_PROVIDER_TIMEOUT         — provider 超時
EXECUTION_STATE_DIVERGENCE         — state JSON 與實際 filesystem 不一致

# 修復階段
REPAIR_BUDGET_EXHAUSTED          — repair 次數用完
REPAIR_SAME_FINDING_RECURRED     — 同一 finding 再次出現
REPAIR_SCOPE_EXPANSION           — repair 嘗試擴張 mutation scope
```

---

## 13. 來源忠實性標記

本文件所有陳述均標記來源性質：

- **SOURCE**: 直接來自 codex-original.md、pi-assessment.md、graph-lite.md 或 repo 程式碼
- **INFERENCE**: 從多份文件或 repo 程式碼推導
- **RECOMMENDATION**: Pi 提出的設計建議，尚未在既有文件中明確
- **UNRESOLVED**: 需要進一步討論或研究
