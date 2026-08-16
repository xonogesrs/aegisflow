CARD: AUTOLOOP-PI-GRAPH-DE1R
CARD_TITLE: External Candidate Live Prototype Bake-off (DE-1R)
CARD_TYPE: research
RISK: MEDIUM
MODE: CONTROLLED_RESEARCH_EXTENSION

SOURCE REVIEW

`DE-1` external review verdict — HOLD / DE1_RESEARCH_EXTENSION_REQUIRED
(reviewer: Controller / External Reviewer, reviewedAt 2026-08-08T04:28:47Z,
bound to bundle aedcafcc8453bc9346e2abaceafb6b7b7615636eafc8c3c9e167773cde3e867b;
findings digest a1e2594ca28431230e9ac05260f0e4298f8a6b515ad69aa56b096185c15bf4dd)

SOURCE VERDICT

`HOLD / DE1_RESEARCH_EXTENSION_REQUIRED`

OBJECTIVE

補齊 DE-1 bake-off 的唯一缺口：external candidate 從未以 live runtime 參與
failure-injection。DE-1 只對 Candidate A（Existing AutoLoop）跑了真實 SIGKILL
bake-off；Temporal / Restate 只有 design/security/complexity 研究。本卡建立
minimal live prototype bake-off，讓 Temporal（必要時 Restate）以與 Candidate A
**相同的 failure classes** 被實測，然後用**相同的 selection rubric** 重新判定，
證明或否證 "EXISTING AUTOLOOP LEADS" 的 provisional selection。

本卡不得改 production、不得引入 external runtime 作為 production dependency、
不得動 scheduler / writer / memory / authority。這是 isolated research
bake-off，不是 production Colima 整合。

BASELINE

預期：

* `HEAD=origin/master=2e897e995202c0c8c079c5fdc96b9f5d42d50d25`
  （與 DE-1 bundle 一致；若移動，以移動後為準並記錄）
* ahead/behind 依執行時實際狀態記錄
* worktree 預期 dirty（既有 research outputs 皆 untracked）
* 新增檔案僅限 authorized scope
* no commit / push / merge / seal

執行前記錄：

```bash
git fetch origin
git rev-parse HEAD
git rev-parse origin/master
git rev-list --left-right --count HEAD...origin/master
git status --short
```

若 HEAD 相對 DE-1 bundle 記錄的 2e897e99 有變，停止並回報 baseline 移動。

CURRENT ASSESSMENT

DE-1 已確立的結果（本卡保留、不重做）：

* STACK_A（durable）/ STACK_B（production Graph path 不 durable）區分
* DurableExecutionProvider 12-method seam
* D1–D8 invariants
* Candidate A 真實 SIGKILL 結果：22 runs、9 recovery PASS、13 recoverability
  fail、safety hard gates 全 0（lostCompletedResult=0、duplicateWriterMutation=0、
  falsePass=0、authorityEscalation=0）
* F1（resume post-head whitelist）/ F2/F3（resumed-orchestrator edge）→ DE-2 repair targets
* Restate Stage 13 security finding（@scarf/scarf phone-home + BSL）
* Selection 目前為 **PROVISIONAL: EXISTING AUTOLOOP LEADS**（非 final winner）

IN SCOPE

* Temporal minimal local isolated deployment（`temporalio@1.9.3` SDK + dev
  server + SQLite，或 docker compose；localhost only）
* 以與 DE-1 Candidate A 相同（或等價）的 failure harness 跑 Temporal
* Restate：若 Stage 13 gate 被正式判定為 hard FAIL，可不進完整性能 bake-off，
  但必須書面證明該 gate 足以淘汰它（不能宣稱 same bake-off 卻沒跑）
* 量測與對照表（見 REQUIRED MEASUREMENTS）
* 以同一 selection rubric 重判
* 產出：`docs/pi-graph-output/de1r/` 下研究證據 + closeout bundle

OUT OF SCOPE

* production durable runtime replacement
* external runtime 成為 production dependency
* 修改 production Colima / Graph runner / scheduler / writer / memory / telemetry
* 修改 DE-1 既有 evidence 檔
* 正式進入 DE-2 hardening（DE-2 等本卡關閉後才開始）
* commit / push / merge / seal

REQUIRED FAILURE CLASSES（與 Candidate A 對照）

Temporal 至少要以同等 failure injection 跑以下 classes（對應 DE-1 T1–T12 的
key classes；kill 方式為真實 process SIGKILL 或等價的 runtime kill）：

1. crash during node（node 執行中 crash）
2. result persisted / successor not scheduled（結果已寫入、後繼未排程）
3. writer side-effect boundary（writer side-effect 邊界 crash）
4. duplicate recovery（重複 recovery invocation）
5. corrupt state / checkpoint 等價物（state/checkpoint 損毀）

每個 class 都要記錄：

* correctness（completed results 是否遺失、side-effect 是否重複）
* recovery latency（resume/replay 花費）
* duplicate behavior（exactly-once / at-least-once 實測結果）
* resource / service footprint（process、記憶體、DB、port）
* operational complexity（啟動、升級、清除成本）

REQUIRED MEASUREMENTS

對 Candidate A（引用 DE-1 既有數據）與 Candidate B（Temporal 實測）建立對照表：

| metric | A — Existing | B — Temporal (live) |
| --- | --- | --- |
| correctness（lost/dup/false PASS） | DE-1 既有 | 實測 |
| recovery latency | DE-1 既有（resumeMs） | 實測 |
| duplicate behavior | DE-1 既有 | 實測 |
| resource/service footprint | 0 added services | server + DB 實測 |
| operational complexity | zero | 實測 |
| deployment surface | local disk | server + DB + SDK |
| constraints on workflow code | none added | determinism / activities |

若 Restate 未因 Stage 13 淘汰，同樣建立 Candidate C 對照。

SELECTION RUBRIC（沿用 DE-1）

同一 rubric：recovery improvement 是否值得新增 server + DB + deterministic
workflow constraints？判定選項：

* Temporal/Restate 的 recovery 優勢不足以抵消新增 surface →
  `PASS / EXISTING_DURABLE_EXECUTION_SELECTED`（正式關閉 DE-1 selection）
* Temporal/Restate 在關鍵 class 明顯勝出且值得 → 記錄並升級為正式候選評估
* 無法公平量測 → `HOLD / REQUIRED_EVIDENCE_UNAVAILABLE`

PROVISIONAL DOWNGRADE（必須反映在 closeout）

DE-1 的 selection verdict 在 DE-1R 關閉前維持：

`PROVISIONAL: EXISTING AUTOLOOP LEADS`

DE-1R closeout 必須明確把 provisional 升級為 final，或推翻。

RESTATE DISPOSITION（Stage 13）

* 若判定 Restate server（@scarf/scarf phone-home + BSL）為 hard FAIL：
  * 書面證明該 gate 已足以淘汰（不因「比較麻煩」而不跑，而是「gate 本身淘汰」）
  * 允許不跑完整性能 bake-off，但不得宣稱三者 same bake-off
* 若不足以淘汰：跑相同 failure classes

REQUIRED VALIDATION

```bash
node --check scripts/de1r-*.mjs
node scripts/de1r-bakeoff.mjs --mode temporal   # 或等價 harness
node scripts/de1r-closeout.mjs                  # 產出 closeout bundle
```

若新增 tests：執行對應 suites 並確認無退化。

ACCEPTANCE CRITERIA

只有全部成立才能 PASS：

* Temporal 以 live deployment 跑完指定 failure classes
* 每個 class 有 correctness / recovery latency / duplicate / footprint /
  ops complexity 實測
* 與 Candidate A 建立同一 harness 的對照（apples-to-apples）
* Restate 處置明確：hard-FAIL 有書面證明，或已跑相同 classes
* selection rubric 重跑並給出明確 verdict
* provisional downgrade 有正式反映（final 或推翻）
* DE-1 既有成果無被改動（STACK_A/B、provider seam、D1–D8、F1/F2/F3、
  Restate finding 保留）
* 不 commit / push / seal

STOP CONDITIONS

立即停止並回報 HOLD：

* Temporal dev server 無法在 local isolated 環境建立
* 無法以同等 failure injection 對照（harness 不等價）
* Restate 處置與「未跑」宣稱矛盾且無法用 Stage 13 證明淘汰
* DE-1 既有 evidence 被意外修改
* baseline 移動
* 必須修改 production 才能完成量測

EXPECTED VERDICTS

External candidate live 量測完成、selection 有明確 final：

`PASS / DE1_SELECTION_FINALIZED`

量測證明外部 runtime 明顯勝出：

`PASS / EXTERNAL_RUNTIME_SELECTED`

證據邊界無法建立：

`HOLD / REQUIRED_EVIDENCE_UNAVAILABLE`

REQUIRED CLOSEOUT

* CARD / TYPE / RISK / VERDICT
* baseline/final HEAD、origin/master、ahead/behind、worktree state
* changed files（限 authorized scope）
* Temporal deployment 記錄（版本、模式、storage、ports）
* failure classes 結果對照表（A vs B，必要時 C）
* correctness / recovery latency / duplicate / footprint / ops 實測值
* Restate Stage 13 處置書面結論
* selection rubric 重跑結果
* provisional 降級是否正式化
* test commands / results
* newly discovered defects / evidence gaps
* commit allowed: NO / push: NO / seal: NO

DE-1R 通過後，下一張：`DE-2 — Native Durable Execution Hardening`（wire
STACK_A behind runColimaGraph + F1 whitelist + F2/F3 edge + D7 telemetry +
worktree restoration），除非 selection 被外部 runtime 推翻。
