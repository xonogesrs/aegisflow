# AutoLoop 現況、能力缺口與優化優先順序（Codex 原始分析）

> 2026-08-02，由 Codex 產出

## 一、目標形態

完整 AutoLoop 應形成這條生命週期：

接收任務 → 驗證任務卡 → 重建 repository baseline → 判定權限與 mutation scope → 必要時拆解工作 → 核發執行 permit → 呼叫 Agent → 監控實際變更 → 執行指定驗證 → 獨立 review → PASS / REPAIR / HOLD → 有限 repair → 最終證據封裝 → 經批准後才 commit / push

核心原則：
- Agent 負責提出或執行工作
- AutoLoop 負責限制、驗證和裁決
- 不因 Agent 自稱 PASS 就接受 PASS
- 任一狀態不明、證據不足或越界都必須 fail closed

---

## 二、目前已經具備的基礎

目前 Aura 內的 AutoLoop 已存在約 145 個 tracked files，其中預計先抽出的 standalone core 來源為 43 個。

### 1. 任務卡與 schema 基礎
已存在：任務卡 schema、role/artifact schema、task normalization、provider output normalization、artifact validation、generation manifest。

### 2. C2D／mutation 治理模組
目前 c2d/ 有 19 個模組，包括：checkpoint store、execution ID、fingerprint、atomic filesystem operations、journal、lease、lock、repository mutation lock、mutation authority、mutation scope、mutation run、permit、materialization authorization、commit authorization、reviewed commit candidate、reconciliation、snapshot validation、read-only discovery run。

這些模組已涵蓋：單一 writer 所需的鎖與 lease、mutation 授權、checkpoint/journal、snapshot/fingerprint、中斷後 reconciliation 的部分基礎、commit 前的授權與 reviewed candidate。

但需確認它們是否已經被同一條 end-to-end lifecycle 真正串起來。

### 3. 現有執行 harness
Aura 內已有 run-card.mjs、operator-tick.mjs、normalization、validation、OpenCode 呼叫、preflight、review/repair 相關流程、PASS/REPAIR/HOLD 語意。

目前不是缺少 runner，而是 runner：
- 綁在 Aura repository
- 綁定 OpenCode
- 混合核心、專案 policy 與 provider 邏輯
- 尚未形成可移植的正式介面

---

## 三、目前真正欠缺的能力

### P0：Standalone 成立前的必要缺口

1. **尚未成為真正獨立的產品** — 仍依賴 Aura 的 repository layout、路徑、命名、設定、run-card.mjs、.opencode/
2. **缺少穩定的核心 API** — 需收斂成 normalizeCard/validateCard/prepareRun/authorizeRun/recordExecutionEvent/validateResult/reconcileRun
3. **Provider-neutral runner 邊界尚未成立** — run-card.mjs 綁定 OpenCode，需要最小 adapter contract
4. **缺少無 provider 的完整測試 runner** — 需要 fake adapter/scripted adapter 模擬各種情境
5. **設定仍未完全外部化** — 核心不應硬編 Aura 名稱、路徑、.opencode/ 等

### P1：Pi 可以安全幹活前必須補足

6. **Pi adapter 尚不存在**
7. **回報格式仍需由核心強制** — 需要 normalized result schema，機械式拒絕非法輸出
8. **權限目前偏向「卡片描述」，還需真正執行** — 需要執行前/中/後三層控制
9. **Mutation scope 需要 end-to-end 強制** — 不只 git diff --name-only
10. **Repair loop 需要明確治理** — 最大次數、允許範圍、baseline 規則
11. **Reviewer 獨立性尚需證明** — executor/reviewer 必須是不同 phase
12. **中斷與 resume 需要實際故障測試** — journal + filesystem + Git state 交叉判斷

### P2：小卡穩定後需要補的能力

13. **大卡拆小卡** — decomposition layer
14. **大卡完成度聚合** — final acceptance card
15. **任務風險分級** — LOW/MEDIUM/HIGH/CRITICAL
16. **Baseline policy 太單一** — 需要多種 baseline policy
17. **Evidence provenance 仍需強化** — 區分 Agent 自報 vs AutoLoop 觀察
18. **Negative-path/mutation testing** — 反事實測試

### P3：使用經驗成熟後再考慮

19. Graph-lite／並行節點
20. 多 Provider 路由
21. Operator UI

---

## 四、安全與可靠性缺口

1. Secrets handling
2. Path safety
3. Command injection
4. State durability
5. Lock/lease 正確性

---

## 五、可用性缺口

1. Dry-run/Explain mode
2. 明確 reason codes
3. 可重現執行摘要

---

## 六、Pi 在本次拆分時可以做什麼

COPY_AND_BOOTSTRAP 只應實作 extraction blocker：
1. 建立 standalone 目錄
2. 複製確認的 43 個來源檔案
3. 去除 Aura lock 名稱
4. 拆出 Git diff helper
5. 建立最小 package.json
6. 建立 provider-neutral import smoke
7. 搬入必要的 provider-neutral tests/fixtures
8. 確認核心不依賴 Aura、OpenCode 或外部 npm package
9. 產生一份 capability-gap backlog

本次不要實作：Pi adapter、大卡拆小卡、Graph、Claude/Codex、provider registry、新 lifecycle 重寫、Web UI、多模型 routing、自動 commit/push、Aura policy migration

---

## 七、Standalone 完成後的建議實作順序

Phase 1: 核心獨立 → Phase 2: Fake Adapter → Phase 3: Pi Adapter → Phase 4: 低風險實戰 → Phase 5: Repair/Reviewer → Phase 6: 大卡拆小卡 → Phase 7: Issue #5

---

## 八、判斷是否已經「可用」的最低標準

15 項必須通過的情境，從「合法唯讀卡正常 PASS」到「全流程不依賴 Aura 專用路徑或 .opencode/」。

---

## 九、最重要的實作原則

先可獨立 → 再可測試 → 再接 Pi → 再跑小卡 → 再補 repair → 再拆大卡 → 最後才做 Graph 與多 Provider
