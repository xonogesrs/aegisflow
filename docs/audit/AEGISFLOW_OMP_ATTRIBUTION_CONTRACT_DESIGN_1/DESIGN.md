# AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1

狀態：設計草案（唯讀研究）。未實作、未提交、未寫入任何 store／policy／設定。
日期：2026-10-26

## 0. 前置確認

- 上一張（isolated feed 測試）無 repo 變更。durable 落地基準：`fix/system-remediation-p1-p2` = `origin/main` = `73ac094f`，worktree 乾淨（fetch 後確認）。
- 本文件位於 scratchpad，**尚未落地**，不得視為正式成果。
- `autoloop-omp-pilot` 目錄**不是 git repo**（無版本控制），pilot 程式碼目前沒有 durable 保存。

## 1. 現況資料流盤點

### 1.1 OMP 原生
- 每個互動 session 寫入 `~/.omp/agent/sessions/<cwd-slug>/<ISO時間>_<uuid>.jsonl`（子 agent 另存同名目錄下）。
- 實測一個 session 的 entry 類型：`session`、`model_change`、`message`（user／assistant／toolResult）、`custom`、`custom_message`、`credential_pin`、`title(_change)`。
- 結構欄位足以做 attribution：
  - `session`: `id`、`cwd`、`timestamp`
  - `model_change`: `model`、`resolvedModelIsFallback`
  - assistant `message`: `provider`、`model`、`stopReason`、`duration`、`usage`（input／output／cacheRead／totalTokens／reasoningTokens）、content 內 `toolCall` 區塊（`name`）
  - `toolResult`: `toolName`、`isError`
- 同一檔也含 prompt、輸出、`providerPayload`、`details`、`contextSnapshot`：**含敏感內容風險**。

### 1.2 al-omp pilot
- `omp()` shell 函式：`al-omp is-on` → 走 `al-omp omp --`（`runInteractiveOmp`），否則原生。
- 每次互動 run 建 `runtime/alomp-<ts>-<pid>-<rand>/`，內有 `execution-metadata.json`、`execution-result.json`（status、wallClock、pty 資訊）、`pilot-overlay.yml`。其 `sessions/` 目錄為空（原生 session 不搬進來）。`toolCallAudit` 記為 `SKIPPED_INTERACTIVE_NATIVE_SESSIONS`。
- **發現 A：pilot ON 不等於原生。** 互動路徑加 `--tools read,grep,glob,edit,write,lsp,bash` 與 overlay（拒絕 task／hub／web_search／browser／computer／github 等、`task.maxRecursionDepth: 0`、`retry.maxRetries: 1`、`mcp.enableProjectConfig: false`）。這會改變日常 omp 能力，違反「OMP 保持原生執行」原則。
- **發現 B：pilot 最新 run 目錄為 10/17。** 今天 pilot ON 之後沒有新的 `alomp-*` 目錄；今天的 OMP session 是原生檔案。即 pilot ON 並未讓今天的任務產生 Aegis 側證據。
- pilot 的 `adapter.js` 已用唯讀 import 方式引用 repo 的 `src/rollover/spawn-registry.mjs`（`omp-pilot` × `merge-gateway`），代表「OMP 作為 graph run 的 executor」這條路已存在（需 graph run，非日常路徑）。

### 1.3 Aegis 進化管線
- feed 只在 `runAdmittedGraph` 完成後被呼叫（`admission-gate.mjs`），輸入是 `RunEvidenceStore` 的 durable journal。
- 資格條件（`attribution-feed.mjs`／`attribution.mjs`）：
  1. journal rows 須有 `event_id`（`evt_<n>_<16hex>`）與 `sequence`；
  2. 須有 agent 執行身分（`phase_id`、`PHASE_*`、`DAG_ACCEPTED`、`TOOL_USAGE_OBSERVED`）；
  3. provider 權威來自 frozen admission 的 `provider_binding`；
  4. `terminal_outcome` 只由 `RUN_PASSED`／`RUN_HELD` 產生，否則為 `UNKNOWN`；
  5. 以 execution／graph run id 去重；同 run 證據被擴充 ⇒ identity conflict，拒絕、不重複計數；
  6. 宣告 synthetic／test_only 者排除。
- 策略維度：MODEL_ROUTING、DECOMPOSITION、CONTEXT_ALLOCATION、RETRY_REPAIR、FANOUT_PARALLELISM、TOOL_SELECTION。

### 1.4 缺口歸納
| # | 缺口 | 說明 |
|---|---|---|
| G1 | 無 PASS／HOLD 判決 | OMP 沒有 harness-owned 驗證結果，outcome 不可驗證 |
| G2 | 無 phase／decomposition／admission | DECOMPOSITION、FANOUT 無資料；provider 無 frozen admission 作權威 |
| G3 | 證據形式不符 | feed 吃 RunEvidenceStore journal，不吃 OMP session |
| G4 | 語意落差 | 被進化的是 Aegis graph 策略；OMP 資料即使累積，promotion 改的是 Aegis 策略，不會改變 OMP 行為 |
| G5 | 隱私 | session 檔含 prompt／輸出 |

## 2. 設計選項

| 選項 | 內容 | 評估 |
|---|---|---|
| **A（建議）** 事後旁路 extractor | 唯讀讀取「已靜止」的原生 session JSONL，白名單抽取欄位，寫入 Aegis 專屬觀察區 | 不碰 OMP 執行路徑；失敗不影響工作；最小改動 |
| B OMP extension／hook 在 session 結束時送出事件 | 即時 | 需改 OMP 側或安裝擴充，侵入性高；延後 |
| C 經 pilot adapter 走 graph run | 有 admission 與判決 | 改變執行方式，違反原則 1；僅限刻意的 Aegis 任務 |
| D 讀 `~/.omp/agent/history.db`／`agent.db` | — | **未評估**（未讀其 schema）；不納入本設計 |

## 3. 建議設計（選項 A）

### 3.1 Contract：`aegisflow.omp-attribution/v1`
單一 session 一筆觀察，欄位全為有界識別碼、摘要、列舉、數字：

- `observation_id`：`ompobs_` + sha256(`omp_session_id`) 前 32 hex（確定性，供去重）。
- `source`：`{ kind: "omp-native-session", session_id, file_sha256, last_entry_id, entry_count, extractor_version }`。
- `cwd_ref`：cwd 的 sha256 ＋ 是否在允許清單內（不存原始路徑）。
- `task_class`：預設常數 `OMP_GENERAL`。**不讀 prompt 分類**（避免內容外洩與不穩定）。
- `model`：`{ providers[], models[], fallback_used }`（來自 `model_change` 與 assistant 訊息）。
- `tools`：toolCall 名稱 → 計數，白名單外歸入 `other`。
- `usage`：token 加總（input／output／cache／reasoning）、assistant 總 duration、`stopReason` 計數。
- `errors`：`isError` toolResult 的數量（僅計數，**不當作** `PHASE_REPAIR_REQUESTED`）。
- `outcome`：v1 **固定為** `UNVERIFIED`（schema 不允許其他值）。`VERIFIED_*` 待 D6 設計卡後以新版 schema 引入（見 §3.5）。
- `evidence_class`：`OBSERVED_NATIVE_SESSION`（不是 harness-owned）。
- `strategy_projection`：MODEL_ROUTING、TOOL_SELECTION、CONTEXT_ALLOCATION 可投影；DECOMPOSITION、FANOUT_PARALLELISM、RETRY_REPAIR 為 `null`（不偽造）。

### 3.2 去重、靜止判定與處理狀態（審查補強 1）
實測：原生 session JSONL **沒有任何「結束」標記**（entry 類型僅 session／model_change／message／custom／custom_message／credential_pin／title）。因此「已結束」只能由觀察推定，且必須假設 session 可能被恢復續寫。不得只靠 session id 雜湊去重。

來源檔案的穩定識別（每次觀察都記錄）：
`{ dev, inode, size, mtime_ns, first_entry_id, last_entry_id, entry_count, prefix_sha256, tail_sha256 }`。

處理狀態機（持久化於 `<store>/omp-observations/state/`，每個 session 一筆）：
```
SEEN → QUIESCENT_CANDIDATE → RECORDED
          ↘ EXCLUDED(reason)      RECORDED → EXTENDED_AFTER_RECORD(只記錄、不改寫)
```
- `SEEN → QUIESCENT_CANDIDATE`：連續兩次觀察（間隔 ≥ T，預設 30 分鐘）`size`、`mtime_ns`、`tail_sha256` 完全相同，且 `lsof`（或等價機制）顯示沒有行程持有該檔。任一條件不成立 ⇒ 維持 `SEEN`。
- `QUIESCENT_CANDIDATE → RECORDED`：抽取成功、通過 schema 與敏感內容檢查後，才一次性寫入觀察，同時寫入 `recorded_through_entry_id` 與 `prefix_sha256`。
- 去重鍵 = `observation_id`（session id 雜湊）**加上** `prefix_sha256` 比對。
- 已 `RECORDED` 後檔案增長：
  - 前綴 digest 相同（純附加）⇒ 狀態 `EXTENDED_AFTER_RECORD`，記錄新長度；**不重複計數、不改寫、不另產生第二筆**。
  - 前綴 digest 不同（被改寫）⇒ `PREFIX_MISMATCH`，標記該觀察為可疑並排除於任何統計；不覆寫。
- 讀取中途若檔案大小或 mtime 改變 ⇒ 本輪放棄、不記錄（避免讀到未完成資料）。
- 當前正在使用的 session（有行程持有）永不處理。

### 3.3 品質與信任
- 不可驗證即不可信：`outcome=UNVERIFIED` 的觀察**不進** fitness 的成功率／HOLD 率，只可用於 token、延遲、工具使用分布等描述性統計。
- 缺 session id、檔案不可解析、`parseErrors` 過多 ⇒ 排除並附明確 disposition（對齊 feed 的 explicit disposition 風格）。
- 模擬／測試 fixture 一律標 `synthetic: true`。
- agent 自己跑的測試結果屬 `AGENT_REPORTED`，不等同獨立驗證，不得升級為 `VERIFIED_*`。

### 3.4 安全與隱私（審查補強 2）
白名單只決定「讀哪些欄位」，不足以保證「欄位值安全」。工具名稱、模型識別、session metadata 都可能夾帶敏感內容。因此加上下列固定規則：

**輸入邊界（讀取範圍）**
- 必須提供明確的 cwd allowlist（見 D5）。allowlist 為空 ⇒ extractor 拒絕執行（fail-closed）。
- 候選檔案路徑先 `lstat`：**不跟隨符號連結**；僅接受 regular file；`realpath` 後必須仍位於 `~/.omp/agent/sessions/` 之下，且其 session 目錄 slug 對應到 allowlist 內的 cwd。目錄或檔案是 symlink、hardlink 數 > 1、或 realpath 跳出允許根 ⇒ `EXCLUDED(path_escape)`。
- 開檔使用 `O_RDONLY|O_NOFOLLOW`；單檔大小上限、單行長度上限、entry 數上限，超過 ⇒ `EXCLUDED(too_large)`，不截斷後硬讀。
- 排除 `/tmp`、scratchpad、`--private-tmp--*` 與未授權子代理目錄（`<session>/<AgentName>.jsonl`）。

**輸出 schema（固定、封閉）**
- schema 以 `additionalProperties: false` 驗證；所有字串欄位必須符合限定 regex（例：model／provider／tool 名 `^[A-Za-z0-9._:/-]{1,96}$`）、長度上限與數量上限（distinct model ≤ 8、distinct tool ≤ 64）。
- 不符合 regex 或超量者**不原樣保留**：歸入 `other` 計數，必要時只存其 sha256 前 12 hex（不可逆）。
- session id 必須是 UUID 格式；cwd 只存 sha256；不輸出標題、路徑、prompt、輸出、`providerPayload`、`details`、`contextSnapshot`、credential 欄位。
- 縱深防禦：對所有輸出字串再掃一次敏感樣式（token／key／bearer 型態）；命中 ⇒ **整筆丟棄**並記 `EXCLUDED(sensitive_pattern)`，不寫入、不寫該字串。
- 讀取唯讀、離線、無網路；失敗只回報，**不影響任何 OMP 工作**；遵守 kill switch（`AUTO_EVOLUTION=SUSPENDED` ⇒ 不寫入）。
- 測試必含：植入假 secret 於 prompt／輸出／providerPayload／工具名稱／模型名稱／cwd 名稱；symlink 跳出；hardlink；超大檔；非 UUID session id；偽造 tool 名稱帶 secret——全部驗證不出現在輸出。

### 3.5 統計與進化證據的嚴格分離（審查補強 3）
- `<store>/omp-observations/` 是**獨立資料域**：獨立 schema 名稱、獨立目錄、獨立寫入模組。**不 import** strategy-memory 寫入函式，並以測試（靜態檢查 import 圖）強制；不寫 strategy memory，不觸發 trigger／candidate／cycle／promotion。
- v1 schema 中 `outcome` **只允許** `UNVERIFIED`；`VERIFIED_PASS`／`VERIFIED_FAIL` 在 v1 **不可表示**（schema 拒絕），待 D6 設計卡通過後以新版 schema 引入。
- 未來的 `VERIFIED_*` 必須帶可追溯的 `verification_ref`（來源種類、來源 digest、驗證者身分、時間），且來源須獨立於該 OMP agent 自身的輸出。**session 正常結束、無錯誤、stopReason 為 end 等，一律不得解讀為任務成功。**
- 描述性統計（token、延遲、工具分布）與進化證據之間沒有自動升級路徑；任何升級都需要獨立卡與獨立 reviewer 介面（本卡不設 reviewer）。

## 4. 修改範圍（若獲准實作）

新增（Aegis repo）：
- `src/evolution/omp-attribution/contract.mjs`（schema 與驗證）
- `src/evolution/omp-attribution/extract.mjs`（白名單抽取、靜止判定、去重鍵）
- `scripts/omp-session-attribution.mjs`（唯讀 CLI，`--dry-run` 預設；`--write` 才落地）
- 測試：fixtures（含植入 secret）、去重／衝突、靜止判定、parse 失敗、kill switch、synthetic
- 文件：docs 一節說明 contract 與限制

**不修改**：`admission-gate.mjs`、`attribution-feed.mjs`、strategy memory、policy、kill switch、reviewer、al-omp pilot、OMP 設定、`~/.zshrc`。

規模估計：約 300–500 行新程式碼＋測試；無新服務、無新框架、無 Colima／網路需求。

## 5. 風險與誠實限制

1. **R1（立即）pilot ON 會限制日常 omp 能力**（工具白名單與 deny 清單）。旁路方案完全不依賴 pilot。建議 Controller 重新確認是否維持 ON（可 `al-omp off`）。
2. **R2 outcome 不可驗證**：第一階段只能產出描述性遙測，**幾乎不會讓 trigger 觸發**（觸發靠重複失敗／repair／HOLD，OMP 沒有這些訊號）。這是方案的誠實上限。
3. **R3 語意落差**：累積的 OMP 資料與 Aegis graph 策略的對應是間接的；promotion 不會改變 OMP 行為。需先決定「OMP 觀察」要影響哪些決策。
4. **R4 隱私**：session 含 prompt；必須白名單抽取＋測試覆蓋；cwd 只存 hash。
5. **R5 session 成長／續接**：靜止門檻與衝突語意需定案。
6. **R6 範圍選擇**：`~/.omp/agent/sessions/-tmp` 內有大量審查／子 agent session，需定義納入的 cwd 允許清單，否則資料噪音高。
7. **R7 pilot 無版本控制**：若未來要依賴 pilot，需先納入 git。

## 6. Controller 裁決（2026-10-26，CONDITIONAL PASS；依設計摘要之架構層級審查）

| 決策 | 裁決 |
|---|---|
| D1 task class | 第一階段常數 `OMP_GENERAL`，不由 cwd 猜測 |
| D2 UNVERIFIED | 接受；僅供描述性統計，不納入 fitness |
| D3 執行方式 | 手動 CLI；先不加 hook 或常駐程序 |
| D4 Pilot | 建議 OFF；**尚未授權直接修改環境**。`al-omp off` 僅呼叫 `clearPilotState` 與 `hideIndicator`（讀程式碼確認），不改 OMP 設定、不影響執行中 session；仍待 Controller 明確授權後才執行 |
| D5 CWD 範圍 | 明確 allowlist；排除 `/tmp`、scratchpad、未授權子代理 |
| D6 VERIFIED 來源 | 暫緩另開卡；先釐清現有驗證證據可否重用 |

結論：架構（選項 A）接受，**實作暫緩**。選項 D（SQLite）不評估、不擴大設計。
實作前須先：(1) 本文件三點補強（§3.2、§3.4、§3.5）已納入；(2) 本文件正式納入版本控制並核對 clean worktree；(3) 再由 Controller 授權最小 Extractor 實作。
**目前不授權修改 OMP、Pilot 或 Evolution 正式環境。**

另記：Controller 審查依據為設計摘要，尚未直接讀取本文件與原始碼；若需逐條審查須提供本文件。

## 7. 本卡未做

未實作、未寫 store、未改 policy／reviewer／環境／pilot。僅讀取 repo、pilot、OMP session 結構（欄位名與型別，未複製內容）。

## 8. 定位聲明

第一階段 Extractor 只提供「資料收集基礎」與描述性統計，**不宣稱**已完成自我進化整合。目標仍是讓日常工作能累積可驗證的進化證據；在 D6 的驗證來源釐清之前，OMP 觀察不會成為進化證據。
