# Graph-Lite 分析（2026-08-02，Codex 產出）

## 核心定位

Graph-lite ≠ 多模型平台。它是把 AutoLoop 的工作關係表示成節點、邊、狀態與條件轉移的控制層。

```
Graph 控制器：AutoLoop（deterministic）
執行模型：Pi + DeepSeek V4
唯一 writer：Pi
最終 reviewer：GPT
```

節點可以是 deterministic code、單次 LLM call、或完整 agent loop。邊決定下一步、分支與重試。

## 對 AutoLoop 最直接的幫助

### 1. 大卡切小卡（最關鍵）
Pi 拆卡後輸出可驗證的依賴圖。AutoLoop 檢查：循環依賴、遺漏需求、權限擴張、可立即執行的卡、需等待的卡、HOLD 時需凍結的下游。

### 2. 中斷與恢復
每個節點有狀態（PENDING/READY/RUNNING/PASS/REPAIR/HOLD/SKIPPED）。重啟時從 READY 或中斷節點繼續，不重跑已 PASS 的卡。

### 3. 精確 REPAIR
Card 3 失敗 → 只回到 Card 3，Card 1/2 保持 PASS，Card 4/5 等待。不重複執行。

### 4. Evidence 聚合
每個節點產出自己的證據（baseline/diff/tests/scope/verdict/risk）。join 節點組合成 GPT review package。GPT 不必讀完整聊天。

## 不需要恢復的

- 模型路由器、多模型投票、supervisor Agent
- 多個 writer、Agent 互相聊天
- LangGraph dependency

## 不建議現在做完整 Graph 平台

研究指出：Graph 在流程可預測時有效，過度複雜會增加協調成本、timeout 和一致性問題。效能常在中等複雜度達到高點。

初期應採：靜態 DAG、少量節點、單一模型、單一 writer、有限 repair edge、無自動平行 mutation。

## 建議導入順序

| 階段 | 內容 |
|------|------|
| 1 | Graph 只用來拆卡（Pi 輸出 DAG，AutoLoop 驗證，不自動執行） |
| 2 | 依 DAG 順序執行（READY 節點、PASS 解鎖下游、HOLD 阻擋後代） |
| 3 | Checkpoint/Resume（graph state 持久化） |
| 4 | 有限平行（只允許獨立唯讀節點，最多 3-5 個） |

## 近期優先順序

1. Claude 完成 Pi RPC 接線
2. 建立大卡拆小卡 Eval
3. 實作最小 Graph schema
4. Shadow mode 只產生 DAG
5. 加入 sequential graph runner
6. 加入 checkpoint/resume
7. 最後才考慮少量唯讀平行節點

每增加一項 Graph 能力，必須用 Eval 證明改善至少一項：降低錯誤 PASS、降低人工介入、降低重複分析、降低中斷恢復成本、縮短總完成時間、不造成 token 或治理膨脹。
