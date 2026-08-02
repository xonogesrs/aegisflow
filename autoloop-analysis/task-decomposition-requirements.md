# Task Decomposition Requirements

> v2.2 — manifest 接入、BASELINE_COMMIT 移除、REPAIR 狀態修正、risk enum 對齊。

---

## 1. 架構

SOURCE: pi-assessment.md、graph-lite.md

```
Parent Task → AutoLoop → Pi + DeepSeek V4 → REPAIR → GPT Review
```

---

## 2. 輸入 Contract

Parent card + optional manifest:

```json
{
  "parent_requirement_manifest": [
    { "requirement_id": "R1", "text": "分析現有結構" }
  ]
}
```

有 manifest → Z1/M1 可 deterministic。無 manifest → 不得宣稱 100% coverage。

---

## 3. 輸出 — Three-Way Union

### DECOMPOSITION_NOT_BENEFICIAL

小任務，無 child_cards。

### DECOMPOSED (1–7 cards)

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
      "card_id": "<string — unique>",
      "role_id": "<string — unique>",
      "goal": "<string>",
      "card_type": "READ_ONLY_AUDIT | IMPLEMENTATION | REPAIR | RUNTIME_VALIDATION | EXTERNAL_REVIEW",
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
      "risk_level": "LOW | MEDIUM | HIGH"
    }
  ],
  "edges": [{ "from": "<role_id>", "to": "<role_id>", "type": "depends_on" }],
  "deferred_items": [{ "requirement_id": "R1", "reason_code": "COMMIT_NOT_AUTHORIZED", "reason": "..." }],
  "unresolved_items": [{ "requirement_id": "R1", "reason_code": "CYCLIC_DEPENDENCY", "question": "..." }],
  "coverage_map": [{ "requirement_id": "R1", "role_id": "audit", "verification": "..." }],
  "decomposition_evidence": ["<string>"]
}
```

規則：
- `card_id`/`role_id` 唯一。`edges` 只引用 `role_id`。
- `requirement_id` 不得同時出現在 coverage 與 deferred/unresolved。
- Reason codes: `COMMIT_NOT_AUTHORIZED | CROSS_REPO_AUTHORITY_REQUIRED | PRODUCTION_RUNTIME_OUT_OF_SCOPE | CYCLIC_DEPENDENCY | AMBIGUOUS_SCOPE | MISSING_AUTHORITY | MULTI_MODEL_ORCHESTRATION_FORBIDDEN | OTHER`
- `execution_policy` 固定值，`additionalProperties: false`。
- `risk_level` 對齊 card-input.schema.json：LOW/MEDIUM/HIGH（無 CRITICAL）。

### DECOMPOSITION_BLOCKED

無法形成安全 DAG。僅 unresolved_items，無 child_cards/edges。

---

## 4. Child Card 類型

| 類型 | mutation | node class |
|------|:--:|------|
| `READ_ONLY_AUDIT` | ❌ | READ_ONLY |
| `IMPLEMENTATION` | ✅ | Mutation（需唯一 permit） |
| `REPAIR` | ✅（限前卡範圍） | Mutation（需 permit） |
| `RUNTIME_VALIDATION` | ❌ | READ_ONLY |
| `EXTERNAL_REVIEW` | ❌ | READ_ONLY（不得要求 mutation authority） |

**已移除**：`BASELINE_COMMIT`（commit 繼續由獨立授權卡處理）。

**禁止**：Audit+mutation、Impl+review、Repair+commit、跨 repo、多不相關目標、EXTERNAL_REVIEW 要求 mutation authority。

---

## 5. 限制

| 參數 | 值 |
|------|-----|
| Child cards（DECOMPOSED） | 1–7 |
| Graph | static DAG |
| Max concurrent mutation permits | 1 |
| Parallel mutation | disabled |
| Repair | max 1 per card |
| READ_ONLY | 不取 mutation permit |
| Mutation node | 需唯一 mutation permit |

---

## 6. 狀態機

```
PENDING → READY → RUNNING → PASS
         READY → SKIPPED

RUNNING → REPAIR → READY → RUNNING
RUNNING → HOLD      (timeout, authority violation, malformed evidence)
REPAIR  → HOLD      (budget exhausted, same finding recurred)

HOLD → terminal
```

---

## 7. Edge 規則

- `edges` 唯一 canonical。PASS 解鎖下游，HOLD 阻擋所有 descendants，REPAIR 不影響上游。

---

## 8. Coverage

有 manifest: coverage/deferred/unresolved 覆蓋所有 requirement_id。

無 manifest: 可拆分但 Z1=HOLD。

---

## 9. 權限

Child ≤ parent。第一版僅 repo paths。Production DB/network/credential/cross-repo → unresolved。

---

## 10. Checkpoint

既有 `checkpoint-store.mjs` additive extension。全 node state（含 PENDING/READY/RUNNING）。Resume: fingerprint match，不要求 clean tree。

---

## 11. Reason Codes

```text
COMMIT_NOT_AUTHORIZED / CROSS_REPO_AUTHORITY_REQUIRED
PRODUCTION_RUNTIME_OUT_OF_SCOPE / CYCLIC_DEPENDENCY
AMBIGUOUS_SCOPE / MISSING_AUTHORITY
MULTI_MODEL_ORCHESTRATION_FORBIDDEN / OTHER
```
