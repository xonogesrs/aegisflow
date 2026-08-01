# Task Decomposition Roadmap

> v2.1 — 修復順序衝突、Card 4 E10 移除、Card 3.25/3.5 分支、LangGraph package files。

---

## Card 0: REVIEW_AND_COMMIT_SECOND_REPAIR

**目標**: GPT re-review，確認所有 finding 關閉。

**HARD STOP**: 不修改 `src/` 或 `test/`

---

## Card 0A: REVIEWER_SCHEMA_DESCRIPTION_ALIGNMENT

**目標**: 修正 `card-input.schema.json` 中 reviewer description（OpenCode → GPT）。

**允許修改**: 僅 `reviewer.default.description` 字串。不修改 runtime。

**可不阻塞後續**

---

## Card 1: TASK_DECOMPOSITION_SCHEMA_AND_VALIDATOR

**目標**: Schema + validator。

**允許修改**:
- `src/schema/task-decomposition.schema.json`（three-way union）
- `src/schema/task-decomposition-eval-cases.schema.json`
- `src/validate-decomposition.mjs`
- `test/test-validate-decomposition.mjs`

**核心測試**:
- 少量 synthetic valid/invalid fixtures 通過 schema（完整 E1-E12 fixtures 留給 Card 3）
- `additionalProperties: false` 強制
- Role_id/card_id uniqueness
- Cycle detection

**HARD STOP**: 修改 lifecycle runner、npm dependency、Graph library

**阻擋**: Card 2

---

## Card 2: TASK_DECOMPOSITION_SHADOW_MODE

**與上版相同**（不變）

**阻擋**: Card 3

---

## Card 3: STATIC_DECOMPOSITION_CONFORMANCE

**目標**: 對 E1–E12 fixtures 進行靜態驗證。

**允許修改**:
- `test/test-decomposition-conformance.mjs`
- `test/fixtures/decomposition-outputs/`（每個 eval case 對應一個 expected fixture）

**測試**: schema、edges、coverage、authority、cycle、expected roles

**不測試**: E9/E10 runtime、M7 recovery

**HARD STOP**: 修改 production code、真實 Pi

**阻擋**: 不阻擋 Card 3.25 或 Card 3.5

---

## Card 3.25: REAL_PI_DECOMPOSITION_EVAL

**目標**: 真實 Pi 跑 E1–E8、E11–E12。不執行 child cards。

**前置**: Card 3、Pi RPC 可用

**測試**: Pi 輸出通過 schema、NOT_BENEFICIAL/BLOCKED 正確、coverage/authority/cycle/multi-model

**不阻擋 Card 3.5**（兩者可並行）

---

## Card 3.5: EXECUTION_BACKEND_BAKEOFF

**目標**: 三條後端比較（minimal / LangGraph.js / Dagu）。

**前置**: Card 3（static validator）

**測試**: 使用獨立 execution fixtures，12 項（含 E9 HOLD propagation，不含 E10 resume）

**HARD STOP**: 不正式整合

**阻擋**: Card 4

---

## Card 4: SELECTED_SEQUENTIAL_EXECUTION_BACKEND

**目標**: 實作選定的後端。

**允許修改**:
- Backend adapter（`src/adapter/`）
- `src/graph-runner.mjs`
- `test/test-graph-runner.mjs`
- **若選 LangGraph.js**: `package.json` + `package-lock.json`（僅限 bake-off 鎖定版本）
- 不得修改 `src/c2d/*`

**測試**: Sequential DAG、HOLD propagation、REPAIR locality、repair budget exhaustion、E9 fixture

**不測試**: E10 resume（Card 5）

**HARD STOP**:
- Minimal runner: 禁止 npm dependency
- LangGraph.js: 只允許 bake-off 鎖定版本
- Dagu: 只允許外部 CLI adapter
- 所有: 平行 mutation=0、不修改 commit authorization

**阻擋**: Card 5

---

## Card 5: GRAPH_CHECKPOINT_AND_RESUME

**目標**: Checkpoint + resume。與既有 `checkpoint-store.mjs` 相容。

**測試**: 含 E10（kill process + resume）、fingerprint resume（不要求 clean tree）、損壞 checkpoint HOLD、雙重 resume lock

**阻擋**: Card 6

---

## Card 6: OPTIONAL_READ_ONLY_PARALLELISM

**目標**: 最多 3-5 個 READ_ONLY_AUDIT 平行。

**前置**: Card 5 + 真實 sequential bottleneck 證據

**測試**: 平行 AUDIT、HOLD 不影響其他、>5 拒絕、mutation 不平行

---

## Dependency Graph

```
Card 0 → Card 0A (可並行)
Card 0 → Card 1 → Card 2 → Card 3
                              ├─ Card 3.25 (可並行)
                              └─ Card 3.5 → Card 4 → Card 5 → Card 6
```

---

## 明確排除

Final acceptance、cross-repo mutation、production DB runtime、Graph 平台、多模型 orchestration。
