# Task Decomposition Roadmap

> 後續最小實作卡順序。**已修復（2026-08-02）**：Card 0A 拆分、Card 3/3.25/3.5 重排、
> Card 4–6 完整展開、移除「與原始相同」引用。

---

## Card 0: REVIEW_AND_COMMIT_REPAIRED_BASELINE

**目標**: GPT re-review 修復後的四份文件，確認所有 finding 已關閉。

**產出**: 四份修復後文件 + commit

**HARD STOP**: 不得修改 `src/` 或 `test/`

**是否阻擋下一張**: 是

---

## Card 0A: REVIEWER_SCHEMA_DESCRIPTION_ALIGNMENT

**目標**: 修正 `src/schema/card-input.schema.json` 中 reviewer 欄位的 description（移除 OpenCode 殘留，更新為 GPT）。

**允許修改範圍**:
- 僅修改 `card-input.schema.json` 中 `reviewer.default.description` 字串
- 不修改 schema validation logic、不修改 runtime

**核心測試**:
- `npm run check` 通過
- 既有 tests 全部通過
- Reviewer description 不再包含 "OpenCode Go"

**HARD STOP**: 修改任何 runtime code、schema structure

**是否阻擋下一張**: 否（可與 Card 1 並行）

---

## Card 1: TASK_DECOMPOSITION_SCHEMA_AND_VALIDATOR

**目標**: 實作 decomposition output schema 與 validator。

**前置條件**: Card 0 完成

**允許修改範圍**:
- 新增 `src/schema/task-decomposition.schema.json`（含 discriminated union NOT_BENEFICIAL / DECOMPOSED）
- 新增 `src/validate-decomposition.mjs`
- 新增 `test/test-validate-decomposition.mjs`
- 不得修改 `src/lifecycle-runner.mjs`、`src/c2d/*`

**核心測試**:
- 12 個 eval cases 的預期 output fixtures 可通過 schema validation
- 插入 Z1-Z9 錯誤 → validator 必須 reject
- Cycle detection 獨立測試
- `additionalProperties: false` 強制
- Validator 不依賴任何 provider

**HARD STOP**: 修改 lifecycle runner、新增 npm dependency、引入 Graph library

**是否阻擋下一張**: 是

---

## Card 2: TASK_DECOMPOSITION_SHADOW_MODE

**目標**: Pi 在 shadow mode 下產生 decomposition JSON。

**前置條件**: Card 1 完成

**允許修改範圍**:
- 新增 `src/decompose-task.mjs`
- 新增 `src/prompts/decompose-system.txt`
- 新增 `test/test-decompose-shadow.mjs`
- 不得修改 `src/lifecycle-runner.mjs`

**核心測試**:
- Scripted adapter 模擬 Pi 回傳合法 DECOMPOSED JSON → validator PASS
- 模擬 Pi 回傳 DECOMPOSITION_NOT_BENEFICIAL → 正確處理
- 模擬 Pi 回傳格式錯誤 / 循環 / 權限擴張 → validator REJECT
- Role_id matching 正確

**HARD STOP**: 自動執行 child cards、修改 lifecycle runner、呼叫真實 Pi

**是否阻擋下一張**: 是

---

## Card 3: STATIC_DECOMPOSITION_CONFORMANCE

**目標**: 對 12 個 eval cases 進行靜態驗證。只測 schema、coverage、authority、cycle、expected roles。

**前置條件**: Card 2 完成

**允許修改範圍**:
- 新增 `test/test-decomposition-conformance.mjs`
- 新增 `test/fixtures/decomposition-outputs/`（每個 eval case 對應一個 expected output fixture）
- 不得修改 production code

**核心測試**:
- 12 個 eval cases 的 expected output 對應正確 verdict
- Each case: 正確的 role_id、edge structure、coverage map
- Z1-Z9 的錯誤案例測試
- 產出 conformance report

**不測試**（runtime 能力尚未存在）:
- E9 HOLD propagation runtime
- E10 kill process + resume
- M7 recovery locality
- Graph runtime state transitions

**HARD STOP**: 修改 production code、呼叫真實 Pi

**是否阻擋下一張**: 否（Card 3.25 需要真實 Pi）

---

## Card 3.25: REAL_PI_DECOMPOSITION_EVAL

**目標**: 用真實 Pi 跑 E1–E8、E11–E12 decomposition。不執行 child cards。

**前置條件**: Card 3 完成、Pi RPC 可用

**允許修改範圍**:
- 擴充 eval runner 使用 `pi-rpc-adapter` 替代 scripted adapter
- 新增 `test/test-real-pi-decomposition.mjs`
- 不得修改 production lifecycle

**核心測試**:
- 真實 Pi 對 10 個 eval cases 的 decomposition 輸出通過 schema validation
- NOT_BENEFICIAL cases (E1, E11) 正確處理
- Coverage completeness (E2, E3, E6)
- Authority preservation (E7)
- Cycle detection (E8)
- Multi-model removal (E12)

**HARD STOP**: 執行 child cards、修改 lifecycle runner

**是否阻擋下一張**: 否

---

## Card 3.5: EXECUTION_BACKEND_BAKEOFF

**目標**: 用 execution-conformance fixtures（非 decomposition cases）比較三條後端。

**前置條件**: Card 3 完成（static validator 存在）

**比較路徑**:

| 路徑 | 說明 | 授權 |
|------|------|:--:|
| A. Minimal runner | Thin contract interpreter | — |
| B. LangGraph.js | Embedded stateful orchestration | MIT |
| C. Dagu | External CLI backend | GPLv3 |

**測試項目**（使用獨立 execution fixtures，12 項）:
1. 線性三節點 PASS
2. 中間節點 HOLD → descendants 阻擋
3. 中間節點 REPAIR → 只重跑該節點
4. Cycle 被拒絕
5. Kill process → resume
6. 已 PASS writer 不因 resume 重複 mutation
7. Artifact hash 不一致 → HOLD
8. 同時 READY 唯讀節點仍 sequential
9. Writer count ≤ 1
10. 無額外 provider call
11. 完全離線
12. Execution fixtures 驗證 Z1-Z9

**量測**: adapter 程式量、新增依賴、啟動複雜度、checkpoint 正確性、crash recovery、例外數、可攜性、授權

**HARD STOP**: 不做正式整合、不修改 production runner

**是否阻擋下一張**: 是（決定 Card 4 backend）

---

## Card 4: SELECTED_SEQUENTIAL_EXECUTION_BACKEND

**目標**: 根據 bake-off 結果，實作選擇的後端。

**前置條件**: Card 3.5 完成、Card 1+2 完成

**允許修改範圍**:
- 根據選擇結果新增 backend adapter（`src/adapter/`）
- 新增 `src/graph-runner.mjs`
- 新增 `test/test-graph-runner.mjs`
- 不得修改 `src/c2d/*`（lock/permit/mutation-scope 保持不變）

**核心測試**:
- Sequential DAG 執行：Card 1 RUN → PASS → Card 2 READY → RUN → PASS
- HOLD propagation：Card 2 HOLD → Card 3/4 PENDING
- REPAIR locality：Card 2 REPAIR → Card 1 保持 PASS
- Card 2 超出 repair budget → HOLD
- 所有卡 PASS 後 graph state = complete
- E9 + E10 execution fixtures 通過

**HARD STOP（backend-dependent）**:
- 若選 minimal runner: 禁止新增 npm dependency
- 若選 LangGraph.js: 只允許 bake-off 鎖定版本及必要 lockfile
- 若選 Dagu: 只允許外部 CLI adapter，不嵌入 GPL 程式碼
- 所有 backend: 平行 mutation nodes = 0、不修改 commit authorization

**是否阻擋下一張**: 是

---

## Card 5: GRAPH_CHECKPOINT_AND_RESUME

**目標**: Graph checkpoint 持久化與 resume，與既有 `checkpoint-store.mjs` 相容。

**前置條件**: Card 4 完成

**允許修改範圍**:
- 擴充 `src/c2d/checkpoint-store.mjs` 增加 graph extension section
- 擴充 `src/graph-runner.mjs` 增加 resume entry point
- 新增 `test/test-graph-checkpoint.mjs`
- 不得修改 `src/c2d/lock.mjs`、`src/c2d/lease.mjs`

**核心測試**:
- 正常 flow → checkpoint 記錄所有 node states（含 PENDING/READY/RUNNING/PASS）
- Card 2 RUNNING 時中斷 → resume 後 Card 1 不重跑，Card 2 從 RUNNING 恢復
- Resume 前提: branch/HEAD/fingerprint 等於 checkpoint expected state（不要求 clean working tree）
- Checkpoint 損壞 → HOLD
- 雙重 resume lock 拒絕
- Artifact hash 與 checkpoint 記錄不一致 → HOLD
- PASS card 的合法未 commit 變更不觸發 HOLD

**HARD STOP**: 修改 lock/lease、新增外部 dependency

**是否阻擋下一張**: 是

---

## Card 6: OPTIONAL_READ_ONLY_PARALLELISM

**目標**: 允許最多 3-5 個獨立 READ_ONLY_AUDIT 節點平行執行。

**前置條件**: Card 5 完成、真實任務證明 sequential 造成瓶頸

**允許修改範圍**:
- 擴充 `src/graph-runner.mjs` 增加 READ_ONLY 平行模式
- 新增 `test/test-graph-parallel-readonly.mjs`

**核心測試**:
- 3 個 AUDIT 同時執行 → 全 PASS → 解鎖 downstream IMPLEMENTATION
- 1 個 AUDIT HOLD → 其他繼續 → downstream 不執行
- 平行節點 > 5 → 拒絕並 HOLD
- 無 mutation 節點在平行期間執行
- 每個節點仍取得 read lock

**HARD STOP**: 平行 mutation、> 5 平行節點

**是否阻擋下一張**: 否（最後一張，optional）

---

## Card Dependency Graph

```
Card 0  (Review + Commit Repaired Baseline)
   ↓
Card 0A (Reviewer Schema Fix) ──→ 可並行
   ↓
Card 1  (Schema + Validator)
   ↓
Card 2  (Shadow Mode)
   ↓
Card 3  (Static Conformance)
   ↓
Card 3.25 (Real Pi Decomposition Eval)
   ↓
Card 3.5 (Execution Backend Bake-off)
   ↓
Card 4  (Selected Backend)
   ↓
Card 5  (Checkpoint/Resume)
   ↓
Card 6  (Optional: Read-Only Parallelism)
```

---

## 明確排除

- 大卡完成度聚合 → review layer
- 多 repo mutation → P3
- 完整 Graph 平台 → bake-off 後決定
- 多模型 orchestration → 永久移除
- Production database mutation → 第一版不在 scope
- Cross-repo child cards → 需要不同 parent card 授權
