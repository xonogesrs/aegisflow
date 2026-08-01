# Task Decomposition Scorecard

> v2.1 — gating metrics 可完全 deterministic；advisory metrics 記錄用。
> **修復**：Z1/M1 依賴 manifest、Z10 執行政策、permit 語意、M9 1–7、reason_code matching。

---

## GATING METRICS

### Z1–Z10：零容忍（任一即 FAIL）

| # | 條件 | 前提 |
|---|------|------|
| Z1 | Parent requirement 未被 coverage/deferred/unresolved 覆蓋 | 需 parent_requirement_manifest 存在；NOT_BENEFICIAL/BLOCKED → N/A |
| Z2 | Authority expansion | — |
| Z3 | Dependency cycle | DECOMPOSED only |
| Z4 | Unknown role_id reference | DECOMPOSED only |
| Z5 | Self-dependency | DECOMPOSED only |
| Z6 | 同時持有 mutation permit > 1 | runtime；decomposition 階段檢查 card_type 宣告 |
| Z7 | Unbounded repair loop | — |
| Z8 | 同卡 card_type = IMPLEMENTATION + EXTERNAL_REVIEW | — |
| Z9 | Commit permission invented | — |
| Z10 | execution_policy 偏離固定值（非 INHERIT_PARENT/EXTERNAL_GPT/false） | — |

### M1: Requirement Coverage Rate

- **定義**: `(covered + deferred + unresolved) / total_manifest_requirements`
- **PASS**: = 1.0（manifest 存在時）；無 manifest → HOLD（無法驗證）
- **NOT_BENEFICIAL/BLOCKED**: N/A

### M3: Dependency Correctness

- **定義**: `invalid_edges_count`
- **PASS**: = 0；total_edges=0 不影響 PASS
- **NOT_BENEFICIAL/BLOCKED**: N/A

### M7: Recovery Locality

- **定義**: REPAIR 時需重跑的上游 PASS 卡數量
- **PASS**: = 0
- **可測量時機**: Card 3.5+（execution runtime）

### M9: Card Count

- **定義**: `child_cards.length`
- **PASS**: 1–7（DECOMPOSED）；N/A（NOT_BENEFICIAL/BLOCKED）
- **HOLD**: > 7

---

## ADVISORY METRICS

僅供 A/B/C ablation 參考，不直接用於 gating。

| # | 指標 | 建議 PASS | 注意 |
|---|------|:--:|------|
| A1 | Independent verifiability | ≥ 0.8 | ≤ 0.5 為 advisory warning |
| A2 | Card cohesion（LLM 輔助） | ≥ 0.9 | goal 是否單一 |
| A3 | Duplicate path overlap | ≤ 0.1 | 僅計算 allowed_paths 交集 |
| A4 | Deferred explicitness | = 1.0 | 用 reason_code 機械判定 |
| A5 | Human intervention（unresolved count） | ≤ 3 | 高風險任務偏高屬正常 |
| A6 | Context duplication（估算） | ≤ 0.3 | 無可重現算法，需 empirical |

---

## A/B/C Ablation

| 維度 | A: 人工 | B: Pi 純文字 | C: Graph-lite |
|------|--------|-------------|--------------|
| Requirement 遺漏 | 人工 | 無驗證 | coverage map |
| 權限擴張 | 人工 | LLM 自報 | schema 強制 |
| 錯誤 PASS | LLM 自評 | LLM 自評 | mechanical |

---

## 指標適用矩陣

| 指標 | Eval Cases | 說明 |
|------|:--:|------|
| Z1–Z10 | E1–E12 | 零容忍 |
| M1 Coverage | E2, E3, E6 | manifest-based |
| M3 Dependency | E2, E3, E4, E9, E10 | edges 驗證 |
| M7 Recovery | E9, E10 | execution（Card 3.5/5） |
| M9 Card Count | E1, E5, E8, E11 | 1–7 / N/A |
| A1–A6 | as applicable | advisory only |
