# Task Decomposition Scorecard

> v2.2 — Z6/Z8 修正、M9 補 HOLD 條件、risk 對齊。

---

## GATING METRICS

### Z1–Z9：零容忍

| # | 條件 | 可用階段 |
|---|------|:--:|
| Z1 | Requirement 未被 coverage/deferred/unresolved 覆蓋 | Card 3+（需 manifest） |
| Z2 | Authority expansion | Card 1+ |
| Z3 | Dependency cycle | Card 1+ |
| Z4 | Unknown role_id ref | Card 1+ |
| Z5 | Self-dependency | Card 1+ |
| Z6 | 同時持有 mutation permit > 1 | Card 4+（runtime） |
| Z7 | Unbounded repair | Card 1+ |
| Z8 | EXTERNAL_REVIEW card 要求 mutation authority 或 mutation actions | Card 1+ |
| Z9 | Commit permission invented | Card 1+ |
| Z10 | execution_policy 偏離固定值 | Card 1+ |

### M1: Coverage Rate

- `(covered + deferred + unresolved) / total_manifest`
- PASS: = 1.0（有 manifest）；無 manifest → HOLD
- NOT_BENEFICIAL/BLOCKED → N/A

### M3: Dependency

- `invalid_edges_count = 0`
- total_edges=0 不影響 PASS；NOT_BENEFICIAL/BLOCKED → N/A

### M7: Recovery Locality

- REPAIR 重跑上游數 = 0
- Card 3.5+（runtime only）

### M9: Card Count

- DECOMPOSED: 1–7 PASS；<1 或 >7 → HOLD
- NOT_BENEFICIAL/BLOCKED → N/A

---

## ADVISORY（A1–A6，記錄用）

| # | 指標 | 建議 | 注意 |
|---|------|:--:|------|
| A1 | Verifiability | ≥ 0.8 | |
| A2 | Cohesion | ≥ 0.9 | LLM 輔助 |
| A3 | Duplicate paths | ≤ 0.1 | |
| A4 | Deferred explicitness | reason_code 存在 = 1.0 | |
| A5 | Unresolved count | ≤ 3 | 高風險偏高正常 |
| A6 | Context duplication | ≤ 0.3 | 估算值 |

---

## Ablation

| | A: 人工 | B: Pi 文字 | C: Graph-lite |
|---|---|---|---|
| 遺漏 | 人工 | 無 | coverage map |
| 權限 | 人工 | LLM 自報 | schema 強制 |
| 錯誤 PASS | LLM | LLM | mechanical |
