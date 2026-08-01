# Task Decomposition Roadmap

> 後續最小實作卡順序。每張卡獨立可驗證，不跨卡混合不相關工作。
> 本 roadmap 只定義卡片順序與邊界，不在此卡實作。
>
> **已更新（2026-08-02）**：在 Card 3 後插入 EXECUTION_BACKEND_BAKEOFF（Card 3.5），
> 用 Eval cases 客觀比較 minimal runner vs LangGraph.js vs Dagu，再決定執行後端。
> Card 4 改為 SELECTED_SEQUENTIAL_EXECUTION_BACKEND。

---

## Card 0: REVIEW_AND_COMMIT_CURRENT_BASELINE

**目標**: GPT review 現有四份未 commit 文件，修正 finding，commit baseline。

**產出**:
- `task-decomposition-requirements.md`（已修正 finding）
- `task-decomposition-eval-cases.json`（已修正 finding）
- `task-decomposition-scorecard.md`（已修正 finding）
- `task-decomposition-roadmap.md`（已更新含 bake-off 新順序）

**修正項目**:
- [ ] Card-input schema 的 reviewer description 殘留 OpenCode → 更新為 GPT
- [ ] 其他 GPT review finding

**HARD STOP**: 不得在此卡修改任何 `src/` 或 `test/` 檔案

**是否阻擋下一張**: 是（後續所有卡以此 baseline 為基礎）

---

## Card 1: TASK_DECOMPOSITION_SCHEMA_AND_VALIDATOR

**目標**: 實作 child card schema validator。能接收 decomposer 輸出的 JSON，機械式驗證結構正確性。

**前置條件**:
- Card 0 完成（baseline committed）

**允許修改範圍**:
- 新增 `src/schema/task-decomposition.schema.json`
- 新增 `src/validate-decomposition.mjs`
- 新增 `test/test-validate-decomposition.mjs`
- 不得修改 `src/lifecycle-runner.mjs`、`src/c2d/*`

**核心測試**:
- 12 個 eval cases 的 JSON 可通過 schema validation
- 故意插入 Z1-Z11 的錯誤 → validator 必須 reject
- 循環依賴必須被偵測（獨立 cycle detection 測試）
- Validator 本身不依賴任何 provider

**HARD STOP**:
- 修改 lifecycle runner
- 新增 npm dependency
- 引入 Graph library

**是否阻擋下一張**: 是（Card 2 必須使用此 validator）

---

## Card 2: TASK_DECOMPOSITION_SHADOW_MODE

**目標**: Pi 在 shadow mode 下產生 decomposition JSON（不執行 child cards）。建立 decomposer prompt template，讓 Pi 能從 parent card 產出結構化拆卡結果。

**前置條件**:
- Card 1 完成（schema + validator 存在）

**允許修改範圍**:
- 新增 `src/decompose-task.mjs`（讀取 parent card，呼叫 Pi，收集 JSON 輸出）
- 新增 `src/prompts/decompose-system.txt`（decomposer 的 system prompt）
- 新增 `test/test-decompose-shadow.mjs`（使用 scripted adapter 模擬 Pi 回傳 decomposition JSON）
- 不得修改 `src/lifecycle-runner.mjs`

**核心測試**:
- 使用 scripted adapter 模擬 Pi 回傳合法 decomposition JSON → validator PASS
- 模擬 Pi 回傳 DECOMPOSITION_NOT_BENEFICIAL → 正確處理
- 模擬 Pi 回傳格式錯誤的 JSON → validator REJECT
- 模擬 Pi 回傳含循環依賴的 JSON → validator REJECT
- 模擬 Pi 回傳含權限擴張的 JSON → validator REJECT

**HARD STOP**:
- 自動執行 child cards
- 修改 lifecycle runner
- 呼叫真實 Pi（只用 scripted adapter）

**是否阻擋下一張**: 是（Card 3 需要 shadow mode 的輸出）

---

## Card 3: TASK_DECOMPOSITION_EVAL_RUN

**目標**: 對 12 個 eval cases 進行完整 baseline 評估。用 scripted adapter 模擬 Pi，跑完整 eval suite，產出 baseline scorecard。

**前置條件**:
- Card 2 完成（shadow mode decomposer 存在）
- 12 個 eval cases JSON 存在

**允許修改範圍**:
- 新增 `test/test-decomposition-eval-runner.mjs`（eval runner）
- 可修改 `test/fixtures/` 增加 test fixtures
- 不得修改 production code

**核心測試**:
- 所有 12 個 eval cases 預期結果與實際結果比較
- 每個 case 的 pass/fail 判定
- 零容忍失敗 Z1-Z11 的觸發測試
- 可量化指標 M1-M10 的 baseline 值
- 產出 eval report（pass/fail/skip per case）

**HARD STOP**:
- 修改 decomposer production code（只能新增 tests）
- 呼叫真實 Pi

**是否阻擋下一張**: 否（Card 3.5 可並行開始準備，但完整測試需要 Card 3 的 baseline）

---

## Card 3.5: EXECUTION_BACKEND_BAKEOFF

**目標**: 用 12 個 Eval cases + Z1-Z11 零容忍條件，客觀比較三條執行後端路徑。只做 spike，不做正式整合。

**前置條件**:
- Card 3 完成（Eval runner 存在，baseline scorecard 已建立）

**比較路徑**:

| 路徑 | 說明 | 授權 | 注意 |
|------|------|:--:|------|
| A. Minimal runner | 自建 thin contract interpreter（控制組） | — | 不算平台，只是 DAG + state machine |
| B. LangGraph.js | 嵌入式 stateful orchestration | MIT | 需確認 checkpoint 相容性、不破壞單一 writer |
| C. Dagu | 外部 CLI backend | GPLv3 (community) | 保持外部呼叫，不嵌入 AutoLoop |

**測試項目**（三條路徑跑相同 12 項測試）:
1. 線性三節點全部 PASS
2. 中間節點 HOLD → 所有直接/間接後代被阻擋
3. 中間節點 REPAIR → 只重跑該節點
4. Cycle 在執行前被拒絕
5. Checkpoint 後殺掉程序 → resume
6. 已完成 writer 節點不因 resume 重複 mutation
7. Artifact hash 不一致 → HOLD
8. 同時 READY 的唯讀節點仍 sequential
9. Writer count 永遠 ≤ 1
10. 無額外 provider call
11. 完全離線可執行
12. E1–E12 全部通過、Z1–Z11 零容忍全部攔截

**量測指標**: adapter 程式量、新增依賴與常駐服務、啟動複雜度、checkpoint 正確性、crash recovery、語意轉譯例外數、Mac/WSL 可攜性、授權與未來商業化限制

**選擇規則**（硬規則）:
- LangGraph.js 能以薄 adapter 完整通過 → Card 4 改用 LangGraph.js backend
- Dagu 通過且只作外部程序使用合理 → 保留為 optional external backend，不成為 AutoLoop 核心
- 兩者都需要扭曲 PASS/REPAIR/HOLD 或加入過多基礎設施 → 採 minimal runner
- Card 6 平行唯讀繼續延後，等真實任務證明 sequential 造成明顯瓶頸才啟用

**HARD STOP**: 不做正式整合、不修改 production lifecycle runner、不引入常駐服務

**是否阻擋下一張**: 是（決定 Card 4 的執行後端）

---

## Card 4: SELECTED_SEQUENTIAL_EXECUTION_BACKEND

**目標**: 根據 bake-off 結果，實作選擇的執行後端。整合進 graph runner。

**前置條件**:
- Card 3.5 完成（bake-off 有明確結論）
- Card 1 完成（schema validator）
- Card 2 完成（shadow mode decomposer）

**允許修改範圍**:
- 根據 bake-off 結果新增對應的 backend adapter
- 擴充 `src/graph-runner.mjs`
- 新增對應 tests
- 不得修改 `src/c2d/*`

**核心測試**: 與原始 Card 4 相同（sequential execution、HOLD propagation、REPAIR locality）

**HARD STOP**: 與原始 Card 4 相同（平行 mutation、npm dependency、修改 commit authorization）

**是否阻擋下一張**: 是（Card 5 需要穩定的 graph runner）

---

## Card 5: GRAPH_CHECKPOINT_AND_RESUME

**目標**: 實作 graph checkpoint 持久化與 resume。中斷後能從 checkpoint 恢復，不重跑已 PASS 的卡。

**前置條件**:
- Card 4 完成（graph runner 存在）

**允許修改範圍**:
- 擴充 `src/c2d/checkpoint-store.mjs` 增加 graph checkpoint 支援
- 擴充 `src/graph-runner.mjs` 增加 resume entry point
- 新增 `test/test-graph-checkpoint.mjs`
- 不得修改 `src/c2d/lock.mjs`、`src/c2d/lease.mjs`

**核心測試**: 與原始 Card 5 相同（正常 flow、中斷 resume、artifact 一致性、損壞 checkpoint、雙重 resume lock）

**HARD STOP**: 與原始 Card 5 相同

**是否阻擋下一張**: 是（Card 6 需要 checkpoint 穩定）

---

## Card 6: OPTIONAL_READ_ONLY_PARALLELISM

**目標**: 允許少量獨立唯讀節點平行執行（最多 3-5 個），全部完成後合併結果再進入 mutation 節點。

**前置條件**:
- Card 5 完成（checkpoint/resume 穩定）
- 真實任務證明 sequential 造成明顯瓶頸

**允許修改範圍**: 與原始 Card 6 相同

**HARD STOP**: 與原始 Card 6 相同

**是否阻擋下一張**: 否（此為最後一張，optional）

---

## Card Dependency Graph（已更新）

```
Card 0 (Review + Commit Baseline)
    ↓
Card 1 (Schema + Validator)
    ↓
Card 2 (Shadow Mode)
    ↓
Card 3 (Eval Run)
    ↓
Card 3.5 (Execution Backend Bake-off)
    ↓
Card 4 (Selected Sequential Backend)
    ↓
Card 5 (Checkpoint/Resume)
    ↓
Card 6 (Optional: Read-Only Parallelism)
```

---

## 不在本 Roadmap 的項目（明確排除）

以下項目有其價值但不屬於 Task Decomposition 的第一版 roadmap：

- 大卡完成度聚合（final acceptance card）→ 屬於 review layer，非 decomposition
- 多 repo mutation 協調 → 需要 cross-repo lock，屬 P3
- Real Pi smoke（目前只使用 scripted adapter）→ 在 Card 3 Eval Run 之後
- GPT integration（將 review package 送 GPT）→ 屬於 review layer
- AutoLoop 自我改進 loop（收集 traces → A/B 比較）→ 需全流程穩定後才做
- 完整 Graph 平台（LangGraph/Dagu/Inngest/Hatchet 等全功能部署）→ bake-off 後才決定
- 多模型 orchestration、model router、supervisor agent → 已從架構中永久移除
