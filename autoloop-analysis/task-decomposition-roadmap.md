# Task Decomposition Roadmap

> v2.2 — 全部卡片完整展開，無外部引用。

---

## Card 0: FINAL_REVIEW_AND_COMMIT

GPT re-review 修復後文件，確認所有 finding 關閉後 commit。

**HARD STOP**: 不修改 `src/` 或 `test/`

---

## Card 0A: REVIEWER_SCHEMA_FIX

修正 `src/schema/card-input.schema.json` 的 `reviewer.default.description`（OpenCode → GPT）。僅改字串。

**可並行，不阻塞後續**

---

## Card 1: SCHEMA_AND_VALIDATOR

**目標**: decomposition output schema + validator。

**新增**:
- `src/schema/task-decomposition.schema.json`（three-way union：NOT_BENEFICIAL / DECOMPOSED / BLOCKED）
- `src/schema/task-decomposition-eval-cases.schema.json`
- `src/validate-decomposition.mjs`
- `test/test-validate-decomposition.mjs`

**測試**: synthetic valid/invalid fixtures（完整 E1–E12 fixtures 留 Card 3）、additionalProperties 強制、role_id/card_id 唯一、cycle detection、execution_policy 鎖定。

**HARD STOP**: 修改 lifecycle runner、npm dependency、Graph library。

**阻擋 Card 2**

---

## Card 2: SHADOW_MODE_DECOMPOSER

**目標**: Pi shadow mode decomposition。

**新增**:
- `src/decompose-task.mjs`
- `src/prompts/decompose-system.txt`
- `test/test-decompose-shadow.mjs`

**測試**: scripted adapter → DECOMPOSED / NOT_BENEFICIAL / BLOCKED、格式錯誤 reject、循環 reject、權限擴張 reject、role_id matching。

**HARD STOP**: 自動執行 child cards、修改 lifecycle runner、真實 Pi。

**阻擋 Card 3**

---

## Card 3: STATIC_CONFORMANCE

**目標**: E1–E12 fixtures 靜態驗證。

**新增**:
- `test/test-decomposition-conformance.mjs`
- `test/fixtures/decomposition-outputs/`（每個 eval case 對應一個 fixture）

**測試**: schema、edges、coverage（manifest-based）、authority、cycle、expected roles、execution_policy。不測 E9/E10 runtime、M7 recovery。

**HARD STOP**: 修改 production code、真實 Pi。

**阻擋 Card 3.25 與 Card 3.5；兩者彼此不阻擋**

---

## Card 3.25: REAL_PI_EVAL

**目標**: 真實 Pi 跑 E1–E8、E11–E12。

**前置**: Card 3、Pi RPC 可用。

**測試**: Pi output 通過 schema、NOT_BENEFICIAL/BLOCKED 正確、coverage/authority/cycle/multi-model。

**不執行 child cards。**

**與 Card 3.5 彼此不阻擋**

---

## Card 3.5: BACKEND_BAKEOFF

**目標**: 比較 minimal runner / LangGraph.js / Dagu。

**前置**: Card 3。

**測試**（獨立 execution fixtures，12 項）:
1. 線性三節點 PASS
2. 中間 HOLD → descendants 阻擋
3. 中間 REPAIR → 只重跑該節點（RUNNING→REPAIR→READY→RUNNING）
4. Cycle 拒絕
5. Kill process → resume（basic smoke，完整 resume 在 Card 5）
6. 已 PASS writer 不重複 mutation
7. Artifact hash 不一致 → HOLD
8. 多 READ_ONLY 仍 sequential
9. Writer count ≤ 1
10. 無額外 provider call
11. 完全離線
12. Z1–Z10 攔截

**量測**: adapter 量、依賴、啟動複雜度、checkpoint 正確性、crash recovery、例外數、可攜性、授權。

**HARD STOP**: 不正式整合、不改 production runner。

**阻擋 Card 4**

---

## Card 4: SELECTED_BACKEND

**目標**: 實作選定後端。

**新增**: backend adapter、`src/graph-runner.mjs`、`test/test-graph-runner.mjs`。LangGraph 勝出時允許 `package.json` + `package-lock.json`。

**測試**: sequential DAG、HOLD propagation、REPAIR locality（RUNNING→REPAIR→READY→RUNNING）、repair budget exhaustion → HOLD、E9 fixture。不測 E10 resume。

**HARD STOP**: minimal runner 禁止 npm dep；LangGraph 僅限 bake-off 版本；Dagu 僅外部 CLI。平行 mutation=0，不改 commit authorization。

**阻擋 Card 5**

---

## Card 5: CHECKPOINT_AND_RESUME

**目標**: checkpoint + resume，與既有 store 相容。

**擴充**: `src/c2d/checkpoint-store.mjs`（graph extension section）、`src/graph-runner.mjs`（resume entry point）。

**測試**: E10（kill→resume，不重跑 PASS 卡）、fingerprint resume（不要求 clean tree）、損壞 checkpoint HOLD、雙重 resume lock、artifact hash 不一致 HOLD。

**HARD STOP**: 修改 lock/lease、外部 dep。

**阻擋 Card 6**

---

## Card 6: OPTIONAL_READ_ONLY_PARALLELISM

**目標**: 3–5 個 READ_ONLY_AUDIT 平行。

**前置**: Card 5 + 真實 sequential bottleneck 證據。

**測試**: 平行 AUDIT、HOLD 不影響其他、>5 拒絕、mutation 不平行。

---

## Dependency Graph

```
Card 0 ─→ Card 0A (並行)
Card 0 ─→ Card 1 → Card 2 → Card 3 ─┬─→ Card 3.25
                                     └─→ Card 3.5 → Card 4 → Card 5 → Card 6
```

---

## 排除

Final acceptance、cross-repo mutation、production DB runtime、Graph 平台、多模型 orchestration。
