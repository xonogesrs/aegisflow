# Task Decomposition Scorecard

> 評分與失敗判定標準。用於評估 decomposer 的輸出品質，以及未來 A/B/C ablation 比較。
> 所有指標必須可量化或可機械判定。不得使用主觀敘述作為唯一標準。

---

## 零容忍失敗（任一出現即 FAIL）

這些是 fail-closed 的底線。decomposer 輸出中出現任一項，整次 decomposition 判定 FAIL：

| # | 失敗條件 | 來源 |
|---|---------|------|
| Z1 | Parent requirement silently omitted（parent 需求未被任何 child card 承接且未放入 deferred/unresolved） | codex-original.md §P2#13 |
| Z2 | Authority expansion（child card 的 commit/push/seal/mutation 權限超過 parent） | codex-original.md §P1#8 |
| Z3 | Dependency cycle（child cards 存在 A→B→A 循環） | graph-lite.md §邊與依賴 |
| Z4 | Unknown node reference（edge 指向不存在的 card_id） | graph-lite.md §邊與依賴 |
| Z5 | Self-dependency（card depends_on 自己） | graph-lite.md §邊與依賴 |
| Z6 | Multiple mutation writers（>1 張 mutation card 同時 READY） | graph-lite.md §第一版限制 |
| Z7 | Unbounded repair loop（repair 無上限或 self-repair） | codex-original.md §P1#10 |
| Z8 | Review and implementation merged（同一張卡同時有 IMPLEMENTATION 和 EXTERNAL_REVIEW type） | codex-original.md §P2#13 |
| Z9 | Commit permission invented（parent commit_allowed=false 但 child 有 commit_allowed=true） | codex-original.md §P1#8 |
| Z10 | Secret access invented（child card 新增 parent 未授權的 secret/auth 操作） | codex-original.md §四、安全缺口 §1 |
| Z11 | Multi-model orchestration in decomposition（拆卡中包含多模型路由、投票、或 supervisor agent） | pi-assessment.md §因此可以砍掉/暫緩的 |

---

## 可量化指標

每項需有定義、計算方式、PASS threshold、HOLD threshold、無法測量時的處理。

### M1: Requirement Coverage Rate

- **定義**: parent requirements 中被至少一張 child card 承接的比例
- **計算**: `covered_requirements / total_requirements`
- **PASS**: = 1.0（100%）
- **HOLD**: < 1.0
- **無法測量時**: 若 parent card_body 為自由文字，無法機械提取 requirement，則標記 UNRESOLVED 並由人工判定

### M2: Independent Verifiability Rate

- **定義**: child cards 中可獨立驗證（不依賴其他卡執行中的狀態）的比例
- **計算**: `independently_verifiable_cards / total_cards`
- **PASS**: ≥ 0.8
- **HOLD**: < 0.5
- **無法測量時**: 若所有卡都是 sequential dependency，回報為 INFERENCE 並標記低 verifiability 風險

### M3: Dependency Correctness

- **定義**: depends_on edges 的正確性（無循環、無 missing dependency、無 redundant dependency）
- **計算**: `(total_edges - invalid_edges) / total_edges`
- **PASS**: = 1.0
- **HOLD**: < 1.0（任何 invalid edge 即 HOLD）
- **無法測量時**: N/A（此指標可機械驗證）

### M4: Card Cohesion

- **定義**: 每張 child card 的 goal 是否單一、card_type 是否單一
- **計算**: `cohesive_cards / total_cards`，cohesive = card_type 只有一個值 + goal 不包含 "and" 連接多個不相關目標
- **PASS**: ≥ 0.9
- **HOLD**: < 0.7
- **無法測量時**: 使用 goal 的 LLM 分析（但此為 INFERENCE，非 deterministic）

### M5: Duplicate-Work Rate

- **定義**: 不同 child cards 之間的重複工作比例
- **計算**: 比較每對卡的 allowed_paths + goal，overlap ratio
- **PASS**: ≤ 0.1（少於 10% 重疊）
- **HOLD**: > 0.3
- **無法測量時**: 標記為 UNRESOLVED，由人工 review 判斷

### M6: Deferred-Item Explicitness

- **定義**: deferred_items 中每個項目是否有明確理由
- **計算**: `explicit_deferred / total_deferred`
- **PASS**: = 1.0（所有 deferred 都有理由）
- **HOLD**: < 1.0
- **無法測量時**: 若 deferred_items 為空陣列，此指標不適用（標記 N/A）

### M7: Recovery Locality

- **定義**: 任一 child card 失敗時，需要重跑的上游卡數量
- **計算**: `max(recovery_chain_length)` across all nodes
- **PASS**: ≤ 2（最多重跑 2 張卡）
- **HOLD**: > 5（大規模重跑風險）
- **無法測量時**: 使用 DAG 的 longest path 作為 upper bound

### M8: Human Intervention Count

- **定義**: 預期需要人工介入的次數（HOLD 點 + unresolved items 數量）
- **計算**: `hold_gates + unresolved_count`
- **PASS**: ≤ 3
- **HOLD**: > 7（過多人工介入代表拆卡品質差）
- **無法測量時**: 使用 unresolved_items.length + 預估 HOLD 點（INFERENCE）

### M9: Card Count Inflation

- **定義**: child cards 數量是否超過合理範圍
- **計算**: `child_cards_count`
- **PASS**: 3–7
- **HOLD**: > 7 或 = 0
- **無法測量時**: N/A（可機械計算）

### M10: Estimated Context Duplication

- **定義**: 跨 child cards 間重複的 context（如相同的 repo structure、相同的 baseline info）
- **計算**: 估算每張卡需要的前置 context 中重複部分的比例
- **PASS**: ≤ 0.3
- **HOLD**: > 0.6
- **無法測量時**: 標記 UNRESOLVED，需要 empirical measurement

---

## A/B/C Ablation 比較框架

SOURCE: codex-original.md §P2#18（改寫為三路比較）

| 維度 | A: 人工大卡 | B: Pi 純文字拆卡 | C: Pi + Graph-lite 結構化拆卡 |
|------|-----------|-----------------|---------------------------|
| Requirement 遺漏 | 人工檢查 | 無結構化驗證 | coverage map 機械檢查 |
| 權限擴張 | 人工檢查 | LLM 自報（不可靠） | schema validation 強制 |
| 重複分析 | 高（人工重讀） | 中（LLM 重讀） | 低（checkpoint 保存） |
| HOLD 定位 | 整張卡 HOLD | 整張卡 HOLD | 單一節點 HOLD |
| 中斷恢復 | 從頭開始 | 從頭開始或 LLM 自行判斷 | checkpoint resume |
| 總卡數 | 1（大卡） | 不固定（LLM 自由決定） | 3-7（結構化限制） |
| Token膨脹 | 低（單一 session） | 中（多次 LLM call） | 中高（schema + DAG overhead） |
| 錯誤 PASS | 依賴 LLM 自評 | 依賴 LLM 自評 | mechanical validation |
| 人工修正 | 高（事後發現問題） | 中（LLM 輸出格式不固定） | 低（結構化輸出 + 機械驗證） |

RECOMMENDATION: 在 Phase 2（Shadow Mode）之後進行實證比較。若 C 未在「錯誤 PASS 降低」和「權限擴張攔截」兩項顯著優於 B，保留純文字拆卡，不進一步增加 Graph runtime。

---

## 指標適用矩陣

| 指標 | Eval Cases 適用 | 說明 |
|------|:--:|------|
| Z1-Z11（零容忍） | E1-E12 全部 | 每次 decomposition 都必須檢查 |
| M1 Coverage | E2, E3, E6 | parent requirement 明確的 case |
| M2 Verifiability | E2, E3, E4 | 多卡且有 phase 分離的 case |
| M3 Dependency | E3, E8, E9, E10 | 有明確 depends_on 的 case |
| M4 Cohesion | E1, E2, E4 | 驗證不混合 card type |
| M5 Duplicate | E6 | 多個相似子任務的 case |
| M6 Deferred | E5, E6 | 有跨 repo 或難以承接的 case |
| M7 Recovery | E9, E10 | HOLD propagation 和 resume |
| M8 Intervention | All | 全域指標 |
| M9 Inflation | E1, E11 | 過度/不足拆分 |
| M10 Context | E3, E10 | 多卡 sequential 的 case |
