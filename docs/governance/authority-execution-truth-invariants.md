# AutoLoop v1 — Authority & Execution Truth Invariants

> **Card:** `GOV-AET1` — Authority & Execution Truth Invariants Adoption
> **Policy authority:** AutoLoop governance
> **Scope:** this document only (`docs/governance/authority-execution-truth-invariants.md`)
> **Status:** adopted — authoritative AutoLoop governance policy

---

本文件定義三項跨專案、跨 Agent、跨 execution runtime 的治理原則。

這些原則本身由 AutoLoop governance 作為 **policy authority**；但每個專案、repo、worktree、runtime domain 的實際 operational truth，仍由各自的 authoritative source-of-record 管理。

因此：

```text
AutoLoop governance
    └── 定義通用規則

Project / Repo A
    └── 管理自己的 authoritative operational state

Project / Repo B
    └── 管理自己的 authoritative operational state
```

不得因共用同一套治理原則，而把不同 repo、worktree 或 lifecycle 的實際 authority 合併。

---

# AET-1 — Authority Convergence / Single Authoritative Baseline

## Principle

**At every decision boundary, there must be exactly one authoritative source-of-record for the state being acted upon.**

同一個 issue、phase、repair 或驗證流程可以暫時存在：

* branches
* worktrees
* candidate source
* candidate builds
* review bundles
* evidence sets
* launch scripts
* artifact manifests
* historical copies

這些平行物件可以因隔離、比較、review、rollback 或實驗而存在，但不得長期形成 competing source-of-truth。

---

## Authority is domain-local

「唯一 authoritative baseline」是針對一個明確 authority domain，而不是要求整個開發環境只有一個 worktree。

例如：

```text
AutoLoop repo
    └── 有自己的 authoritative source baseline

Aura / PR17 repo
    └── 有自己的 authoritative source baseline

Receiver runtime
    └── 有自己的 promoted runtime artifact

Review lifecycle
    └── 有自己的 authoritative review bundle/verdict chain
```

這些 authority 可以同時存在，因為它們管理的是不同 domain。

禁止的是：

```text
同一個 authority domain
├── candidate A 被當成 current truth
├── candidate B 也被當成 current truth
└── historical worktree 仍可能被拿來執行
```

而不是禁止不同專案各自擁有自己的 authoritative baseline。

---

## Required convergence

當 validation、review 或 promotion 已足以做出 authority decision 時，必須：

1. 指定唯一 authoritative object。
2. 記錄：

   * identity
   * revision / SHA
   * absolute path or durable locator
   * provenance
   * authority role
3. 將其餘相關物件分類為：

   * candidate
   * experimental
   * pending-validation
   * superseded
   * historical
   * legacy
   * non-authoritative
4. 後續 decision、execution、review、handoff、recovery 必須從 authoritative object 建立。

核心規則：

**Discoverable history is not executable authority.**

---

## Branch / worktree lifecycle

Branch 或 worktree 必須因明確隔離目的存在。

合理：

```text
authoritative baseline
      │
      ├── isolated repair worktree
      └── independent review worktree
```

驗證完成後：

```text
isolate
→ mutate
→ verify
→ select authority
→ promote / commit / merge / closeout as applicable
→ mark alternatives superseded
```

不得長期保持多個 competing candidates，而讓下一張卡重新猜哪一個才是真的。

---

## Cross-project rule

通用 governance 文件可以引用其他專案作為案例，但不得保存另一個專案會變動的 operational truth。

例如 AutoLoop governance 可以說：

> Receiver promotion 必須收斂到唯一 authoritative runtime artifact。

但不應在這裡永久記錄：

```text
Receiver authoritative SHA = ...
Receiver current executable = ...
PR17 current branch = ...
```

這些資料應由 PR17 / Receiver 自己的 manifest、card 或 closeout 管理。

---

# AET-2 — Handoff Re-Proof / Current Prerequisite Truth

## Principle

**A previous PASS proves a previous state. It does not prove that a downstream prerequisite exists and remains authoritative now.**

禁止：

```text
Card A PASS
therefore
Card B prerequisite must exist
```

正確模型：

```text
Card A PASS
      ↓
handoff boundary
      ↓
re-prove prerequisite
      ↓
current truth established
      ↓
Card B admitted
```

---

## Required handoff checks

所有會影響 downstream correctness 的 prerequisite，在 handoff 時必須重新驗證。

至少包括適用的：

* existence
* identity
* provenance
* authoritative status
* revision/version
* expected location
* integrity/hash
* freshness
* compatibility
* lifecycle state

### Executable artifact

應重新證明：

* binary/artifact 真實存在
* bytes/hash 正確
* launcher 指向正確 artifact
* runtime location 正確
* deployment state 符合預期

### Authority artifact

應重新證明：

* issuer / authority identity
* binding
* validity/freshness
* supersede state
* current authority status

### Review/evidence artifact

應重新證明：

* reviewed bytes identity
* review event identity
* verdict binding
* current vs historical status
* evidence chain 沒有漂移

---

## Historical PASS ≠ Current Truth

不得僅靠先前 PASS 推論：

* build 仍存在
* SHA 沒變
* launcher 沒漂移
* credential 還有效
* review bundle 還是 authoritative
* worktree 還是 current
* external service/runtime 還存在
* hardware prerequisite 已準備完成

---

## Failure timing objective

AutoLoop 應盡量在：

```text
producer
   ↓
handoff verification
   ↓
consumer
```

這個 seam 發現問題。

而不是：

```text
producer PASS
   ↓
card PASS
   ↓
card PASS
   ↓
hardware/runtime execution
   ↓
才發現 prerequisite 從未存在或早已漂移
```

流程改善的核心問題不是只有：

> 為什麼出錯？

而是：

> 為什麼 prerequisite failure 直到這麼晚才被發現？

---

## Failure classification

當 prerequisite truth 無法建立時，應優先分類為 handoff failure，而不是假裝成 downstream implementation defect。

可使用：

```text
HANDOFF_PREREQUISITE_MISSING
HANDOFF_PROVENANCE_UNRESOLVED
HANDOFF_AUTHORITY_STALE
HANDOFF_IDENTITY_MISMATCH
HANDOFF_INTEGRITY_MISMATCH
```

之後再依既有 risk envelope 自動：

```text
REPAIR
REPLAN
或 HOLD
```

---

# AET-3 — Policy Ownership & Execution Boundary Coverage

## Principle

**AutoLoop owns policy. Host runtimes enforce AutoLoop decisions but must not become competing policy authorities.**

Pi、Codex、Claude Code 或其他 Agent/runtime 應被視為：

```text
execution adapter
+
enforcement point
```

而不是：

```text
AutoLoop governance policy owner
```

---

## Required architecture

```text
Agent proposal
      ↓
Runtime adapter
      ↓
AutoLoop admission / policy authority
      ↓
ALLOW / BLOCK / REPLAN / HOLD
      ↓
Runtime enforcement
      ↓
Actual execution
```

AutoLoop policy 包括適用的：

* authority/admission
* search scope
* resource budget
* retry/no-progress
* risk envelope
* lifecycle/recovery
* execution constraints

Runtime adapter 不得自行建立平行版本。

---

## Runtime adapter responsibility

Runtime-specific integration 原則上只負責：

1. 捕捉 execution proposal。
2. 收集必要 context：

   * command/tool call
   * cwd
   * path scope
   * execution identity
   * relevant runtime metadata
3. 交給 AutoLoop policy/admission。
4. 取得裁決。
5. 在真正執行前機械執行該裁決。
6. 回傳 execution evidence。

---

## Enforcement placement

**Policy existence is not enforcement coverage.**

以下不足以證明安全：

```text
governor unit test PASS
```

必須證明：

```text
real runtime proposal
→ real admission
→ real pre-execution enforcement
→ actual spawn/tool execution
```

不存在：

```text
proposal
→ bypass
→ execution
```

---

## Execution Boundary Coverage invariant

每個被 AutoLoop 視為可無人值守執行的 runtime，必須有 execution-boundary coverage proof。

至少驗證適用的：

* model-issued tool calls
* runtime/user-issued execution paths
* bash/shell execution
* subprocess spawn
* tool adapter paths
* fallback/recovery execution
* reload/restart persistence

新增新的 Agent backend 時，不得因「同樣使用 AutoLoop」就假設 governor 自動生效。

每一個 runtime 都必須證明：

```text
proposal
→ AutoLoop admission
→ runtime enforcement
→ actual execution
```

完整閉合。

---

## Runtime modification boundary

優先順序：

1. runtime 官方 extension
2. hook
3. plugin
4. middleware
5. bounded pre-execution adapter

原則上禁止直接修改：

* runtime `dist/`
* internal package implementation
* third-party runtime internals
* 私有 fork

除非：

* 沒有可用的正式 enforcement seam
* 無法以 bounded adapter 達成要求
* 並取得另外的明確 authority

即使如此，AutoLoop policy 仍不得移轉成 runtime-owned policy。

---

## Derived deployment artifacts

某些 runtime integration 可能需要把 AutoLoop policy code bundle/vendor 到 deployment location。

允許，但必須符合：

```text
canonical logical source
        ↓
deterministic derived copy
        ↓
runtime deployment
```

必須：

* 明確標示 derived deployment artifact
* 維持 canonical source provenance
* hash/integrity pin
* 有 regression 防止 drift
* canonical 與 derived copy 不得被當成兩個 competing policy authorities

---

## Coverage-gap handling

發現 execution bypass 時：

1. 先定位真正 execution seam。
2. 不先假設 policy 缺規則。
3. 驗證現有 policy 對事件本身是否已能正確裁決。
4. 如果 policy 正確但 runtime 沒接上：

   * 修 integration seam
   * 不複製第二套 policy
5. 使用真正 runtime path 做 acceptance。
6. 將該 execution path 加入 regression coverage。

---

# Combined Authority Model

三項 invariant 組成完整鏈：

```text
AET-1
What is authoritative?
      ↓
AET-2
Is that authority/prerequisite still true now?
      ↓
AET-3
Does actual execution mechanically obey it?
      ↓
Authoritative Execution Truth
```

因此 AutoLoop 在進入 unattended execution 前，不得只問：

```text
Did the previous card PASS?
```

必須回答：

```text
1. What is authoritative in this domain now?

2. Have competing candidates been converged or explicitly classified?

3. Can identity, provenance and prerequisite truth be proven at this handoff?

4. Does the actual execution path pass through the authoritative policy boundary?

5. Can execution evidence prove that the decision was really enforced?
```

五項成立，才能視為 authoritative execution chain。

---

# Fixed Governance Shorthand

## AET-1 — AUTHORITY CONVERGENCE

**One authority domain, one current authoritative baseline.**

不同 project/repo/runtime 可以各有自己的 authority；同一 domain 不得存在 competing current truth。

## AET-2 — HANDOFF RE-PROOF

**Previous PASS does not prove current prerequisite truth.**

所有 downstream-critical prerequisite 必須在 handoff 重新證明。

## AET-3 — EXECUTION COVERAGE

**AutoLoop owns policy; runtimes enforce it. Every governed execution path must pass through admission.**

任何 runtime bypass 都是 execution coverage gap。

---

# Scope Boundary

這三項原則是 AutoLoop governance policy。

它們不把：

* AutoLoop repo
* Aura/PR17 repo
* Receiver deployment
* Pi runtime
* 其他 worktree

合併成一個 operational source-of-record。

相反地，它們要求每個 authority domain：

```text
各自建立 authoritative truth
+
在 handoff 驗證該 truth
+
在執行時服從共同治理規則
```

這是 AutoLoop 對跨 repo、跨 worktree、跨 Agent runtime 的正式 authority model。

---

# Adoption Notes (GOV-AET1)

- **Policy authority** is AutoLoop governance; **operational authority** stays domain-local (PR17 / Receiver / Pi / other repos each keep their own authoritative source-of-record).
- PR17 / Receiver / Pi appear **only as illustrative cases**; their dynamic SHA / path / branch / executable are **never** recorded here as AutoLoop operational truth.
- Cross-repo / cross-worktree coexistence is **not** competing authority; the single-current-baseline requirement applies **only within one authority domain**.
- AET-1 / AET-2 / AET-3 are **fixed invariants** that downstream card design, review, and admission may cite by shorthand (`AET-1`, `AET-2`, `AET-3`).
