# Task Decomposition Requirements

> AutoLoop「大卡切小卡」第一版最小 contract。狀態：REQUIREMENTS。
> **v2.1（2026-08-02）**：三種 verdict union、reason codes、permit 語意修正、
> trusted requirement manifest、unique identity rules。

---

## 1. 架構前提

SOURCE: pi-assessment.md、graph-lite.md

```
Parent Task → AutoLoop → Pi + DeepSeek V4 → REPAIR → GPT Review
```

---

## 2. 輸入 Contract

SOURCE: card-input.schema.json

Decomposer 接收 parent card。可選輸入：

```json
{
  "parent_requirement_manifest": [
    { "requirement_id": "R1", "text": "分析現有結構" }
  ]
}
```

- **有 manifest**: M1/Z1 可 deterministic gating
- **無 manifest**: shadow mode 可產生拆分，但不得宣稱機械式 100% coverage；必須交 reviewer 或 HOLD

---

## 3. 輸出 Contract — Three-Way Union

### Type A: DECOMPOSITION_NOT_BENEFICIAL

小型原子任務，不值得拆分：

```json
{
  "verdict": "DECOMPOSITION_NOT_BENEFICIAL",
  "reason": "<string>",
  "decomposition_evidence": ["<string>"]
}
```

無 child_cards、無 edges。Z1/M1 = N/A。

### Type B: DECOMPOSED

正常拆分，1–7 張 child cards，可包含 deferred/unresolved：

```json
{
  "verdict": "DECOMPOSED",
  "parent_goal": "<string>",
  "execution_policy": {
    "executor": "INHERIT_PARENT",
    "reviewer": "EXTERNAL_GPT",
    "multi_model_orchestration": false
  },
  "child_cards": [
    {
      "card_id": "<string — unique within graph>",
      "role_id": "<string — unique within graph, for eval matching>",
      "goal": "<string>",
      "card_type": "READ_ONLY_AUDIT | IMPLEMENTATION | REPAIR | RUNTIME_VALIDATION | EXTERNAL_REVIEW | BASELINE_COMMIT",
      "prerequisites": ["<string>"],
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
      "risk_level": "LOW | MEDIUM | HIGH | CRITICAL"
    }
  ],
  "edges": [
    {
      "from": "<role_id>",
      "to": "<role_id>",
      "type": "depends_on"
    }
  ],
  "deferred_items": [
    {
      "parent_requirement": "<string>",
      "reason_code": "CROSS_REPO_AUTHORITY_REQUIRED | COMMIT_NOT_AUTHORIZED | PRODUCTION_RUNTIME_OUT_OF_SCOPE | OTHER",
      "reason": "<string>"
    }
  ],
  "unresolved_items": [
    {
      "parent_requirement": "<string>",
      "reason_code": "CYCLIC_DEPENDENCY | AMBIGUOUS_SCOPE | MISSING_AUTHORITY | OTHER",
      "question": "<string>"
    }
  ],
  "coverage_map": [
    {
      "parent_requirement_id": "<R1 from manifest, or extracted text>",
      "child_role_id": "<string>",
      "verification": "<string>"
    }
  ],
  "decomposition_evidence": ["<string>"]
}
```

**規則**:
- `card_id` 在 graph 中唯一
- `role_id` 在 graph 中唯一
- `edges.from/to` 只能引用存在的 `role_id`
- `__any__` 為 eval matching 特殊值，表示任一 role_id 承接即可
- eval 比較使用 `reason_code`（機械），自然語言僅供閱讀
- `execution_policy` 固定：executor=INHERIT_PARENT, reviewer=EXTERNAL_GPT, multi_model_orchestration=false
- `additionalProperties: false`，child card 不得覆寫 execution_policy 或 model
- 1–7 張 child cards（下限 1 以允許 E5 單卡情境）

### Type C: DECOMPOSITION_BLOCKED

無法形成安全 DAG，至少一項 unresolved：

```json
{
  "verdict": "DECOMPOSITION_BLOCKED",
  "unresolved_items": [
    {
      "parent_requirement": "<string>",
      "reason_code": "CYCLIC_DEPENDENCY | AMBIGUOUS_SCOPE | MISSING_AUTHORITY | OTHER",
      "question": "<string>"
    }
  ],
  "decomposition_evidence": ["<string>"]
}
```

無 child_cards、無 edges。適用於 E8 循環需求。Z1/M1 = N/A（blocked 本身即為 unresolved）。

---

## 4. Child Card 類型

| 類型 | mutation | 節點類型 |
|------|:--:|:--:|
| `READ_ONLY_AUDIT` | ❌ | READ_ONLY（取得 read lock，不取得 mutation permit） |
| `IMPLEMENTATION` | ✅ | Mutation（必須取得唯一 mutation permit） |
| `REPAIR` | ✅（限前卡範圍） | Mutation（取得 mutation permit） |
| `RUNTIME_VALIDATION` | ❌ | READ_ONLY |
| `EXTERNAL_REVIEW` | ❌ | READ_ONLY |
| `BASELINE_COMMIT` | ❌ | READ_ONLY（只變 Git state） |

**禁止組合**：Audit+mutation、Implementation+review、Repair+commit、跨 repo mutation、多不相關目標。

---

## 5. 第一版限制

| 參數 | 值 |
|------|-----|
| Child cards（DECOMPOSED） | 1–7 |
| Graph 類型 | static DAG |
| Maximum concurrent mutation permits | 1 |
| Parallel mutation execution | disabled |
| Repair loop | max 1 per card |
| Auto execution | disabled |

READ_ONLY node: READY→RUNNING，取得 read lock，**不**取得 mutation permit。
Mutation node: READY→RUNNING，必須取得唯一 mutation permit。

---

## 6. Graph-lite 節點狀態

```
PENDING → READY → RUNNING → PASS
                           → REPAIR → PASS
                                    → HOLD
READY → SKIPPED（附 reason）
HOLD → terminal
```

---

## 7. Edge 規則

- `edges` 是唯一 canonical 來源。child card 本身無 `depends_on`。
- PASS 解鎖下游，HOLD 阻擋所有 descendants（直接+間接），REPAIR 不影響上游。
- 禁止循環、self-dependency、未知 role_id。

---

## 8. Parent Requirement Coverage

有 `parent_requirement_manifest`：每項 requirement_id 必須在 coverage_map / deferred / unresolved 中出現。

無 manifest：可產生拆分，但不得宣稱 100% coverage。Z1 自動 = HOLD（無法驗證）或交 reviewer。

---

## 9. 權限保留

Child authority ≤ parent。第一版 parent 只有 repo paths。以下出現即 unresolved：production DB、network/remote、credential、cross-repo。

---

## 10. Checkpoint

Graph checkpoint 是既有 `checkpoint-store.mjs` 的 additive extension。沿用既有 identity 欄位。

Graph extension 記錄所有 node states（含 PENDING/READY/RUNNING/PASS/REPAIR/HOLD/SKIPPED）。

Resume 前提：branch/HEAD/fingerprint 等於 checkpoint 記錄。**不**要求 working tree clean。

---

## 11. Reason Codes

```text
# Decomposition
DECOMPOSITION_NOT_BENEFICIAL — 小任務
DECOMPOSITION_BLOCKED — 無法形成安全 DAG
DECOMPOSITION_CYCLE_DETECTED
DECOMPOSITION_COVERAGE_GAP
DECOMPOSITION_AUTHORITY_EXPANSION

# Graph
GRAPH_CYCLE / GRAPH_ORPHAN_REQUIREMENT / GRAPH_UNKNOWN_ROLE_REF
GRAPH_SELF_DEPENDENCY / GRAPH_MULTIPLE_MUTATION_PERMITS / GRAPH_UNBOUNDED_REPAIR

# Execution
EXECUTION_MUTATION_SCOPE_VIOLATION / EXECUTION_EVIDENCE_INCOMPLETE
EXECUTION_PROVIDER_TIMEOUT / EXECUTION_STATE_DIVERGENCE

# Repair
REPAIR_BUDGET_EXHAUSTED / REPAIR_SAME_FINDING_RECURRED / REPAIR_SCOPE_EXPANSION
```

---

## 12. 來源標記

SOURCE / INFERENCE / RECOMMENDATION / UNRESOLVED
