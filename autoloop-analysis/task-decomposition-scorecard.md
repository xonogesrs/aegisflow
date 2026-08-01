# Task Decomposition Scorecard

> 評分與失敗判定標準。分為 GATING（影響 PASS/REPAIR/HOLD）和 ADVISORY（記錄用，不直接授權 PASS）。
> **已修復（2026-08-02）**：split gating/advisory、fix M3/M7/M9 定義、移除不可計算指標。

---

## GATING METRICS（可完全 deterministic）

### Z1–Z9：零容忍失敗（任一即 FAIL）

| # | 失敗條件 | 來源 |
|---|---------|------|
| Z1 | Parent requirement 未被 coverage_map 承接且不在 deferred/unresolved | codex-original.md §P2#13 |
| Z2 | Authority expansion（child commit/push/mutation 權限超過 parent） | codex-original.md §P1#8 |
| Z3 | Dependency cycle（DAG 有 A→B→A） | graph-lite.md |
| Z4 | Unknown role_id reference（edge 指向不存在的 role_id） | graph-lite.md |
| Z5 | Self-dependency | graph-lite.md |
| Z6 | 同時持有 mutation permit 的節點 > 1（非同時 READY） | requirements.md §5 |
| Z7 | Unbounded repair loop | codex-original.md §P1#10 |
| Z8 | 同一 child card 的 card_type 同時為 IMPLEMENTATION 和 EXTERNAL_REVIEW | codex-original.md §P2#13 |
| Z9 | Commit permission invented | codex-original.md §P1#8 |

### M1: Requirement Coverage Rate

- **定義**: parent requirements 被 coverage_map/deferred/unresolved 覆蓋的比例
- **計算**: `(covered + deferred + unresolved) / total_requirements`
- **PASS**: = 1.0
- **HOLD**: < 1.0
- **無法測量時**: parent card_body 為自由文字時標記 UNRESOLVED

### M3: Dependency Correctness

- **定義**: edges 的正確性（無循環、無未知 role_id、無 self-dependency）
- **計算**: `invalid_edges_count`
- **PASS**: = 0
- **HOLD**: > 0
- **特殊情況**: total_edges = 0 時不影響 PASS（單卡任務合法）
- **無法測量時**: N/A（機械驗證）

### M7: Recovery Locality

- **定義**: 任一節點 REPAIR 時，需重跑的上游 PASS 卡數量
- **計算**: `max(recovery_rerun_count)` across nodes
- **PASS**: = 0（精確 repair locality：已 PASS 的上游不重跑）
- **HOLD**: > 0
- **無法測量時**: 僅在 graph runtime 時可測量；decomposition 階段標記 N/A

### M9: Card Count

- **定義**: child cards 數量
- **計算**: `child_cards.length`
- **PASS**: 1–7（combines NOT_BENEFICIAL 和 DECOMPOSED）
- **HOLD**: > 7
- **NOT_BENEFICIAL 時**: M9 = N/A

---

## ADVISORY METRICS（記錄用，不直接授權 PASS/FAIL）

以下指標需要 LLM 或人工判斷，不直接用於 gating。分值僅供 future A/B/C ablation 參考。

### A1: Independent Verifiability Rate（原 M2）

- **定義**: child cards 中可獨立驗證的比例
- **計算**: `independently_verifiable / total_cards`
- **建議 PASS**: ≥ 0.8
- **注意**: ≤ 0.5 為 advisory warning，不自動 HOLD

### A2: Card Cohesion（原 M4）

- **定義**: 每張 child card 的 goal 是否單一、card_type 是否單一
- **計算**: `cohesive_cards / total_cards`
- **建議 PASS**: ≥ 0.9
- **注意**: 使用 LLM 判斷 goal 是否包含不相關目標

### A3: Duplicate-Work Rate（原 M5）

- **定義**: 不同 child cards 之間的重複工作比例
- **計算**: 比較每對卡的 allowed_paths 交集比例
- **建議 PASS**: ≤ 0.1
- **注意**: 僅計算 path overlap，不含 goal semantic overlap（LLM 輔助）

### A4: Deferred-Item Explicitness（原 M6）

- **定義**: deferred_items 中每個項目是否有明確理由
- **計算**: `explicit_deferred / total_deferred`
- **建議 PASS**: = 1.0
- **注意**: 空 deferred_items → A4 = N/A

### A5: Human Intervention Estimate（原 M8）

- **定義**: 預期人工介入點數量（unresolved_items 數量）
- **計算**: `unresolved_items.length`
- **建議 PASS**: ≤ 3
- **注意**: 高風險任務需要較多人工 gate 是合理的，不是拆卡品質問題

### A6: Estimated Context Duplication（原 M10）

- **定義**: 跨 child cards 間重複 context 的估算比例
- **計算**: 估算值，無可重現算法
- **建議 PASS**: ≤ 0.3
- **注意**: advisory-only，需要 empirical measurement 才能提升為 gating

---

## A/B/C Ablation 比較框架

SOURCE: codex-original.md §P2#18

| 維度 | A: 人工大卡 | B: Pi 純文字拆卡 | C: Pi + Graph-lite |
|------|-----------|-----------------|-------------------|
| Requirement 遺漏 | 人工檢查 | 無結構化驗證 | coverage map 機械檢查 |
| 權限擴張 | 人工檢查 | LLM 自報 | schema validation 強制 |
| 重複分析 | 高 | 中 | 低（checkpoint 保存） |
| HOLD 定位 | 整張卡 | 整張卡 | 單一節點 |
| 中斷恢復 | 從頭開始 | 從頭開始 | checkpoint resume |
| Token膨脹 | 低 | 中 | 中高（schema overhead） |
| 錯誤 PASS | LLM 自評 | LLM 自評 | mechanical validation |

RECOMMENDATION: Card 3.25（Real Pi eval）之後實證比較。若 C 未在「錯誤 PASS 降低」和「權限擴張攔截」顯著優於 B，保留純文字拆卡。

---

## 指標適用矩陣

| 指標 | Eval Cases | 說明 |
|------|:--:|------|
| Z1–Z9 | E1–E12 全部 | 每次 decomposition 檢查 |
| M1 Coverage | E2, E3, E6 | parent requirement 明確的 case |
| M3 Dependency | E3, E8, E9, E10 | 有 edges 的 case |
| M7 Recovery | E9, E10 | execution conformance（Card 3.5） |
| M9 Card Count | E1, E11 | 過度/不足拆分 |
| A1 Verifiability | E2, E3 | advisory |
| A2 Cohesion | E2, E4 | advisory |
| A3 Duplicate | E6 | advisory |
| A4 Deferred | E2, E5 | advisory |
| A5 Intervention | All | advisory |
| A6 Context | E3, E10 | advisory |
