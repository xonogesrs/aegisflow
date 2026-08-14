# DE-1R External Review Verdict — PASS

## Review Identity

- CARD_ID: `AUTOLOOP-PI-GRAPH-DE1R`
- CARD_TITLE: External Candidate Live Prototype Bake-off (DE-1R)
- CARD_TYPE: research
- GRAPH_RUN_ID: `de1r-self-closeout-20260808`
- REVIEW_BUNDLE_IDENTITY: `2ff86a262ad9e75f1c2b8efbaffbc0ea53e9fc4dc4237c601b8d480830a6f182`
- REVIEW_BUNDLE_SHA256: `a1353d0ae761066aac688587d477c1e944c9eca8c4209fd14cbb471b3d43f00d`
- BUNDLE_PATH: `docs/pi-graph-output/de1r/card-closeout-bundle-20260808-2ff86a26.txt`
- REVIEWER_IDENTITY: Controller / External Reviewer
- REVIEWED_AT: `2026-08-08T05:40:00Z`
- VERDICT: **PASS**
- VERDICT_CODE: **AUTOLOOP_PI_GRAPH_DE1R_EXTERNAL_REVIEW_CONFIRMED**

## Verdict

`PASS / AUTOLOOP_PI_GRAPH_DE1R_EXTERNAL_REVIEW_CONFIRMED`

DE-1R 補齊了上一輪 DE-1 external review（HOLD / DE1_RESEARCH_EXTENSION_REQUIRED）
要求的核心缺口：**Temporal 以本機 isolated runtime 實際執行**，不再只是 paper
comparison。正式 PASS。

---

## 1. 核心缺口已補齊（接受）

Temporal 以真實 runtime 執行：

- Temporal CLI 1.8.2（server 1.31.2, UI 2.50.1）+ `temporalio@1.9.3` SDK
- SQLite 持久化，localhost-only（127.0.0.1:7233 / 8233 / 61177）
- 真實 worker `SIGKILL` 注入
- 與 DE-1 對齊的 4-phase DAG（ro1→ro2→writer→verifier）與 crash classes
  （crash during node / result-persisted-successor-unscheduled / writer
  side-effect boundary / duplicate recovery / corrupt-state equivalent）

## 2. 實測結果支撐選型（接受）

- Temporal 提供 automatic re-dispatch + deterministic replay，**沒有 lost
  completed results**（server history 逐 scenario 驗證）。
- 但 writer activity 在 mid-activity crash 時仍是 **at-least-once**：RAW
  side effect 實際產生 **1 次 duplicate**（S3 `FAIL_DUPLICATE`），必須由
  **app-level idempotency / commit-token**（S4）才恢復 exactly-once。
- completed workflow 的 **workflowId reuse 沒有自動 exactly-once invocation
  guard**（S5）：default 允許新 execution；`REJECT_DUPLICATE` 只擋 running。
- corrupt state：SQLite `integrity_check` 可偵測損毀，但 server 為 **lazy
  validation**（S6），非 proactive。
- Footprint 實測：1 server process（~196MB RSS）+ SQLite（1.6MB）+ 3
  listeners + 1 worker + 154 SDK packages；STACK_A = 0 added services。

**核心結論（實測支撐）**：Temporal 的 automatic replay/re-dispatch 較漂亮，
但**沒有消除 AutoLoop 最敏感的 writer dedup 問題** — 這個 correctness
burden 最終仍由 AutoLoop application layer 負責。因此「直接 harden 現有
STACK_A」是合理且有實測支撐的選擇，不再只是偏好自研。

## 3. Restate 處置（接受）

接受「由 Stage 13 hard gate 淘汰、不另跑性能 bake-off」：bundle 明確把
`@scarf/scarf` phone-home（BLOCKER）與 BSL license（HIGH）判定為既定
rejection gate，而不是因為沒跑就假裝比較過。gate 本身足以淘汰。

## 4. Regression 判讀（接受）

`7 tests / 6 PASS / 1 FAIL` **不是 closeout failure**：

- 該 FAIL 正是 S3 RAW writer-side-effect 測試**預期要捕捉的**
  `FAIL_DUPLICATE`。
- 它是這次選型**最有價值的觀察之一**（at-least-once 對 writer boundary 的
  實測證據），不是 harness 缺陷。
- Independent review 已 PASS，無 blocking findings。
- DE-1R 未使用 repair budget（`REPAIR_BUDGET_USED: 0`）。

## 5. 治理修正（流程順序 — 不需 REPAIR DE-1R）

Bundle Section 24 原文：

> "...After DE-2, close DE-1 formally and proceed to Autonomous Research
> Escalation."

**此順序不採用。** 正確治理順序：

```
DE-1R external PASS（本 verdict）
→ 使用 DE-1R evidence 立即解除 DE-1 HOLD
→ DE-1 最終正式判定 PASS / EXISTING_DURABLE_EXECUTION_SELECTED
→ 然後才進 DE-2 — Native Durable Execution Hardening
```

理由：DE-1 當初 HOLD 的唯一理由就是 external candidate live bake-off 不完整；
該缺口已被 DE-1R 完整補掉。沒有理由讓 DE-1 在進 DE-2 後仍維持 HOLD。
這是 downstream lifecycle bookkeeping — 不修改 DE-1R implementation/evidence，
不重新生成 repair bundle。已由 `de1-external-review-resolution.json` 記錄。

## 6. 正式結論

- **DE-1R：PASS**
- DE-1 provisional（`EXISTING AUTOLOOP LEADS`）正式提升為：

  **`PASS / EXISTING_DURABLE_EXECUTION_SELECTED`**

- 下一張正式進：**DE-2 — Native Durable Execution Hardening**
  （STACK_A 接到 production Graph、F1 resume whitelist、F2/F3
  resumed-orchestrator edge、D7 telemetry replay-awareness、writer worktree
  restoration；可參考 DE-1R S4 commit-token pattern 做 writer dedup）

---

### END OF VERDICT
