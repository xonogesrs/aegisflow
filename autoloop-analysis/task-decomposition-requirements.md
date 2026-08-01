# Task Decomposition Requirements

> AutoLoop「大卡切小卡」第一版最小 contract。
> 狀態：REQUIREMENTS（非實作）
> 產生者：Pi + DeepSeek V4
> 來源性質標記：SOURCE、INFERENCE、RECOMMENDATION
> **已修復（2026-08-02）**：output union、canonical edges、role_id、checkpoint 相容、
> execution_policy、card count discriminated union、split gating/advisory metrics。

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

Task Decomposition 發生在「Parent Task 進入 → 第一張 child card 執行前」之間的階段。

---

## 2. 輸入 Contract

SOURCE: card-input.schema.json（repo src/schema/card-input.schema.json）

Decomposer 接收的 parent card 必須是合法 card-input schema 的 instance。

RECOMMENDATION: 拆卡時需額外提供：

- `repository_context`: Git root、branch、HEAD、remote count
- `authority_boundary`: 從 parent card 的 scope/limits 推導，子卡不得擴張
- `max_child_cards`: 第一版上限 7

---

## 3. 輸出 Contract — Discriminated Union

Decomposer 輸出是兩種互斥格式之一。

### Type A: DECOMPOSITION_NOT_BENEFICIAL

當 parent task 範圍太小，不適合拆分：

```json
{
  "verdict": "DECOMPOSITION_NOT_BENEFICIAL",
  "reason": "<string>",
  "decomposition_evidence": ["<decomposer 的判斷理由>"]
}
```

此時 `child_cards` 不存在，`edges` 不存在，M9 card count = N/A。

### Type B: DECOMPOSED

當 parent task 需要拆分：

```json
{
  "verdict": "DECOMPOSED",
  "parent_goal": "<string — 從 parent card_body 精煉的單句目標>",
  "execution_policy": {
    "executor": "INHERIT_PARENT",
    "reviewer": "EXTERNAL_GPT",
    "multi_model_orchestration": false
  },
  "child_cards": [
    {
      "card_id": "<string — 由 decomposer 產生，任意格式>",
      "role_id": "<string — 語意角色，供 eval matching 使用，如 'audit' / 'impl' / 'test' / 'review'>",
      "goal": "<string — 這張小卡的單句目標>",
      "card_type": "READ_ONLY_AUDIT | IMPLEMENTATION | REPAIR | RUNTIME_VALIDATION | EXTERNAL_REVIEW | BASELINE_COMMIT",
      "prerequisites": ["<string — 執行前必須滿足的非依賴條件>"],
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
      "from": "<role_id of upstream card>",
      "to": "<role_id of downstream card>",
      "type": "depends_on"
    }
  ],
  "deferred_items": [
    {
      "parent_requirement": "<string>",
      "reason": "<string — 為什麼無法由任何 child card 承接>"
    }
  ],
  "unresolved_items": [
    {
      "parent_requirement": "<string>",
      "question": "<string — 需要澄清的具體問題>"
    }
  ],
  "coverage_map": [
    {
      "parent_requirement": "<string>",
      "child_role_id": "<string>",
      "verification": "<string — 如何驗證該 child card 滿足此需求>"
    }
  ],
  "decomposition_evidence": ["<decomposer 如何推導出這個拆分的說明>"]
}
```

**Edge 是唯一的 canonical 依賴來源。** Child card 本身不保存 `depends_on`。READY / HOLD propagation 全部由頂層 `edges` 計算。`additionalProperties: false` 在 schema 層級強制，child card 不得覆寫 execution_policy 或 model。

**Child card 數量建議 2–7**（下限 2 以允許 E5 兩卡情境）。

---

## 4. Child Card 類型定義

SOURCE: codex-original.md §P2#13

| 類型 | 說明 | 允許 mutation |
|------|------|:--:|
| `READ_ONLY_AUDIT` | 唯讀分析、盤點 | ❌ |
| `IMPLEMENTATION` | 程式碼變更 | ✅ |
| `REPAIR` | 修正前卡失敗 | ✅（僅限前卡範圍） |
| `RUNTIME_VALIDATION` | 執行測試驗證 | ❌ |
| `EXTERNAL_REVIEW` | 外部模型審查 | ❌ |
| `BASELINE_COMMIT` | 授權 commit | ❌（只變 Git state） |

INFERENCE: 實作階段需建立這些類型到 card-input.mode enum 的 mapping。

**禁止混在同一卡的組合**（SOURCE: codex-original.md §P2#13）:

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
| Child cards 數量（DECOMPOSED） | 2–7 |
| Graph 類型 | static DAG |
| Writer 數量 | 1 |
| Concurrent mutation nodes（同時持有 mutation permit） | 0 |
| Repair loop | finite（max 1 per card） |
| Auto execution | disabled |
| Mode | shadow mode（只產生 DAG 不執行） |

---

## 6. Graph-lite 節點狀態

SOURCE: graph-lite.md §中斷與恢復

```
PENDING   → 尚未滿足前置條件
READY     → 所有 depends_on 已 PASS，可執行（但尚未持有 permit）
RUNNING   → 正在執行中（持有 permit）
PASS      → 執行成功，verified
REPAIR    → 執行失敗，進入修復
HOLD      → 無法修復或超出 repair budget
SKIPPED   → 有正式理由不執行
```

狀態轉移規則（INFERENCE）:

```
PENDING → READY    (所有 depends_on = PASS)
READY   → RUNNING  (AutoLoop 核發 mutation permit)
RUNNING → PASS     (驗證通過)
RUNNING → REPAIR   (測試失敗、review finding)
REPAIR  → PASS     (修復成功)
REPAIR  → HOLD     (超出 repair budget 或同一 finding 再現)
READY   → SKIPPED  (有正式理由)
HOLD    → (terminal，需人工介入)
```

---

## 7. Edge 與依賴規則

SOURCE: graph-lite.md §邊與依賴

僅有頂層 `edges` 是 canonical 來源。規則：

- `depends_on`: Card B 必須等 Card A PASS 才進入 READY
- PASS 解鎖下游：Card A PASS → 所有 depends_on Card A 的卡檢查是否所有前置都 PASS
- HOLD 阻擋 descendants：Card A HOLD → 所有直接/間接 depends_on Card A 的卡設為 PENDING
- REPAIR 回到原節點：上游 PASS 卡不重跑
- 不允許循環依賴、self-dependency、指向不存在的 role_id

---

## 8. Parent Requirement Coverage

每項 parent requirement 必須：

1. 被一張或多張 child card 承接（記錄在 coverage_map）；或
2. 明確放入 deferred_items 並附理由；或
3. 明確放入 unresolved_items 並附具體問題

不得靜默遺漏，不得重新解釋需求以製造 100% coverage。

---

## 9. 權限保留原則

SOURCE: pi-assessment.md §三個角色

Child card 的 authority 不得超過 parent card。AutoLoop validator 機械式檢查。

第一版 parent authority 僅涵蓋 repository paths。以下權限不在第一版範圍，出現即 unresolved：
- Production database mutation
- Network/remote access
- Credential scope
- Cross-repo mutation（單一 parent card 只有一個 worktree_path）

---

## 10. Checkpoint 需求

SOURCE: graph-lite.md §中斷與恢復，INFERENCE: 與現有 checkpoint-store 相容

Graph checkpoint 是既有 checkpoint store 的 additive extension，不另建平行系統。沿用既有 `execution_id`、`checkpoint_id`、`chain_id`、repository identity、expected HEAD/ref、revision CAS、checksum。

Graph extension 保存：

```json
{
  "graph_identity": "<parent card_id + execution_id>",
  "parent_baseline": {
    "branch": "<string>",
    "head": "<string>",
    "fingerprint": "<string>"
  },
  "node_states": {
    "<role_id>": {
      "state": "PENDING | READY | RUNNING | PASS | REPAIR | HOLD | SKIPPED",
      "attempt_count": 0,
      "verified_artifacts": ["<path>"],
      "mutation_snapshot": {
        "before": "<fingerprint>",
        "after": "<fingerprint>"
      }
    }
  },
  "blocked_descendants": ["<role_id>"],
  "last_completed_transition": "<role_id>: <from_state> → <to_state>",
  "resume_preconditions": [
    "current branch/HEAD/worktree fingerprint == checkpoint expected state"
  ]
}
```

Resume 前提是 fingerprint 相等，**不**要求 working tree clean（PASS 後的合法變更可能尚未 commit）。

---

## 11. Reason Codes

SOURCE: codex-original.md §五 §2，RECOMMENDATION

```text
# Decomposition 階段
DECOMPOSITION_NOT_BENEFICIAL     — parent task 太小
DECOMPOSITION_CYCLE_DETECTED     — 循環依賴
DECOMPOSITION_COVERAGE_GAP       — parent requirement 未被承接
DECOMPOSITION_AUTHORITY_EXPANSION — child 權限超過 parent

# Graph 驗證階段
GRAPH_CYCLE                      — DAG 循環
GRAPH_ORPHAN_REQUIREMENT         — requirement 無節點
GRAPH_UNKNOWN_ROLE_REF           — edge 指向不存在的 role_id
GRAPH_SELF_DEPENDENCY            — 自依賴
GRAPH_MULTIPLE_MUTATION_PERMITS  — >1 節點同時持有 mutation permit
GRAPH_UNBOUNDED_REPAIR           — repair 無上限

# 執行階段
EXECUTION_MUTATION_SCOPE_VIOLATION — 變更超出 allowed_paths
EXECUTION_EVIDENCE_INCOMPLETE      — 必要證據缺失
EXECUTION_PROVIDER_TIMEOUT         — provider 超時
EXECUTION_STATE_DIVERGENCE         — state 與 filesystem 不一致

# 修復階段
REPAIR_BUDGET_EXHAUSTED          — repair 次數用完
REPAIR_SAME_FINDING_RECURRED     — 同一 finding 再現
REPAIR_SCOPE_EXPANSION           — repair 擴張 scope
```

---

## 12. 來源忠實性標記

- **SOURCE**: 直接來自既有文件或 repo 程式碼
- **INFERENCE**: 跨文件推導
- **RECOMMENDATION**: Pi 提出的設計建議
- **UNRESOLVED**: 需進一步討論
