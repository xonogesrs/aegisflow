# AegisFlow memory vs CBM — architecture

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT

---

## 1. There is no "AegisFlow Memory vs CBM"

The question presupposes two systems. At this baseline there is **one**:

```
                    ┌───────────────────────────────────────────┐
                    │  src/memory/  (CBM-2 / CBM-3 / CBM-4)     │
                    │  contract · SQLite store · FTS5 · journal │
                    │  deterministic retrieval · write-back gate│
                    └─────────────┬─────────────────────────────┘
                                  │  (three read surfaces, one engine)
        ┌─────────────────────────┼──────────────────────────────┐
        │                         │                              │
  scripts/autoloop-       graph provider                 integrations/omp/
  memory-query.mjs        (createGraphMemoryProvider)    extensions/cbm-query.js
  (harness CLI)           (runColimaGraph phase)          (OMP tool `cbm_query`)
```

"AegisFlow Memory" is the marketing-neutral name for the same modules. The
directory is `src/memory/`; the records are CBM records; the store is the CBM
store. There is no second store, no second ranking path and no second identity
scheme. This was verified by reading all three entry points:

- `scripts/autoloop-memory-query.mjs` imports `LocalMemoryStore`,
  `resolveRepositoryIdentity`, `validateMemoryQueryV1` from `src/memory/`.
- `src/memory/graph-context.mjs:87` `createGraphMemoryProvider()` constructs the
  same `LocalMemoryStore` internally.
- `integrations/omp/extensions/cbm-query.js:loadMemoryModules()` dynamically
  imports `src/memory/index.mjs` and calls `LocalMemoryStore.query()`.

So the answer to "is `src/memory` a separate system, a wrapper, a fork, or a
rewrite of the original CBM?" is: **it is the original CBM, and it is the only
one.**

---

## 2. What the store is (and is not)

### 2.1 It is a governed fact ledger

| Property | Implementation |
|---|---|
| Record envelope | `autoloop.memory-record/v1`, four types: `CODE`, `EXECUTION`, `DECISION`, `PATTERN` |
| Identity | `recordId = sha256(canonical(record))`; `contentHash = sha256("content:" + canonical(content))` |
| Scope | repository / worktree / commit / tree / path / symbol / content / graphRun / task / global |
| Trust | `RAW < UNVERIFIED < VERIFIED < REVIEWED < CONFIRMED` |
| Validity | `CURRENT`, `STALE`, `INVALIDATED`, `TOMBSTONED`, `CONFLICTED` |
| Durability | SQLite primary + append-only JSONL journal with a hash chain; `sqlite ⊆ journal` |
| Recovery | `rebuildFromJournal`, `verifyJournalParity` |
| Retrieval determinism | frozen six-element ranking tuple, last element `recordId` ascending; `retrievalDigest` over the result |
| Isolation | repository identity is the hard first boundary; worktree is the second |

### 2.2 It is not a code index

There is no parser. No file is ever read when a record is written or retrieved.
`scope.path` and `scope.symbol` are **declared attributes of a fact**, not
discovered locations:

```
CODE record example (from the live store):
  scope.path   = "src/admission/admission-gate.mjs"
  content.text = "path src/admission/admission-gate.mjs modified and verified in graph cbm-live-integration-1"
```

That record says *"this path was touched and verified in run X"*. It does not say
*"this file defines function Y, called by Z"*. A query for "who calls
`runAdmittedGraph`" cannot be answered by this store — and no one built it to.

### 2.3 Consequence for the name

"Codebase Memory" is accurate about **what is remembered** (facts about the
codebase) and misleading about **how it is populated** (by governed write-back,
not by indexing). The published docs are careful about this: `integrations/omp/README.md`
describes `cbm_query` as "one read-only tool over AegisFlow's CBM store
(`src/memory/`, CBM-2/CBM-3)" and never claims source indexing.

---

## 3. The three read paths, and their differences

| Path | Consumer | Authority gate | Freshness | Output |
|---|---|---|---|---|
| `scripts/autoloop-memory-query.mjs` | harness / operator | none (a CLI the operator runs) | check-at-use `freshness` block | JSON `autoloop.memory-query/v1` |
| `createGraphMemoryProvider` | `runColimaGraph` | `isRetrievalAuthorized(admission)` **and** a caller-supplied `memory.provider` | none | `memoryContext` injected into the run |
| `cbm_query` extension | OMP agent | none (read-only tool, `approval: "read"`) | check-at-use `freshness` block | two text blocks, the second pure JSON |

They share the engine; they differ in **who is allowed to ask**. That is the
correct shape: authority belongs to the caller's admission, not to the store.

### 3.1 The graph path is double-gated and currently unwired

`src/runtime/colima-graph-runner.mjs:249`:

```js
if (isRetrievalAuthorized(admission) && memory && typeof memory?.provider?.retrieveGraphMemory === "function") {
```

`isRetrievalAuthorized` reads `admission.memory_policy.retrieval_allowed === true`.
The second operand requires a caller to pass `memory.provider`. At `f731015`:

```
$ grep -rn "createGraphMemoryProvider" src scripts examples
src/memory/graph-context.mjs:87:export function createGraphMemoryProvider(...)
   (no src/, scripts/ or examples/ caller — tests only)
```

`251d9ae` ("production provider wiring") did add the construction site, but it is
**not an ancestor of `f731015`** (`git merge-base --is-ancestor 251d9ae HEAD` →
false). The block exists on the retired lineage only. So on the audited baseline
the graph retrieval path is structurally present and **practically unreachable**
without a caller that supplies a provider.

This was already recorded, correctly, by the prior audit
(`docs/audit/AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1/LEARNING_AND_MEMORY_UTILIZATION.md` §5.2).

---

## 4. Write side

```
                    candidate (from a graph run / review)
                                  │
                        runWritebackGate  ← evidence binding, trust rules
                                  │
                    explicitImport  ← ONLY write path (journal-first, fsync)
                                  │
                 ~/.autoloop/memory/journal.jsonl  +  memory.db
```

| Guard | Where | State |
|---|---|---|
| Admission authority | `colima-graph-runner.mjs:886` `admission.memory_policy.writeback_allowed !== true` → `WRITEBACK_AUTHORITY_INSUFFICIENT` | every profile sets it **false** (`policy-projection.mjs:79-127`) |
| Caller must supply a store | `writeback.store` | no production caller |
| Writer cannot self-promote | `writeback/trust.mjs` | enforced |
| `CONFIRMED` is Controller-only | `writeback/trust.mjs:141` | enforced |
| Automatic write-back | out of scope by contract (CBM-4) | `local-store.mjs:32` |

Observed writes since 2026-08-16: **0**. The 8 records in the live store were
written by the CBM cards' own closeout runs through the same gate.

---

## 5. Identity and the rename

```
repositoryIdentity = sha256(canonical({ remote, canonicalPath }))
```

A repository rename or move changes the identity, which — by design — makes old
records invisible. That is correct isolation and a terrible user experience, so
`src/memory/repository-aliases.mjs` adds a **declared** (never inferred) lineage
registry: an operator can state that a deprecated identity belongs to this
checkout, with evidence, and both the CLI and `cbm_query` then accept it.

Live store currently declares two aliases:

| Deprecated identity | Records | Declared |
|---|---:|---|
| `a8d93536…` (`autoloop.git`, `/Volumes/NVM2T/Development/autoloop`) | 2 | 2026-10-18T15:47:06Z |
| `29dcbefd…` (`autoloop.git`, `/tmp/autoloop`) | 6 | 2026-10-18T15:47:09Z |

Canonical today: `e3cc9b97…` (`aegisflow.git`, `/Volumes/NVM2T/Development/repos/autoloop`).

**Measured consequence.** With the aliases, the CLI on this checkout returns
`state: AVAILABLE, selected: 1` at the default floor, and `selected: 8` at
`trustFloor: RAW, validityPolicy: ALL`. Without them it would return
`excludedSummary.repository: 8`. That is the G4 repair from the previous card,
working.

---

## 6. Relationship to OMP's own memory

OMP ships `memory_retain` / `memory_recall` / `memory_reflect` / `memory_edit` /
`learn` / `manage_skill`. They are built-in, settings-gated, and — across 1,741
transcripts — have **0 calls each**.

| Dimension | AegisFlow CBM | OMP native memory |
|---|---|---|
| Store | `~/.autoloop/memory/memory.db` + journal | agent-owned SQLite/vector store |
| Scope | repository identity + tree | session / agent workspace |
| Trust model | five-level ladder, evidence-bound | none documented |
| Determinism | frozen ranking + digest | not claimed |
| Write path | governed gate, explicit only | model-invoked retain |
| Reachable in a governed run | interactive OMP yes; one-shot no (`--no-extensions`) | gated by settings; 0 observed |

They are **different stores with different authority models**. There is no conflict
and no duplication of *mechanism*; there is duplication of *concept* — a fact the
prior audit already recorded (`INTEGRATION_BOUNDARY_AND_OVERLAP.md` §). Nothing
here recommends merging them: OMP's memory cannot satisfy the evidence-binding
requirement, and CBM cannot satisfy session-scoped conversational recall.

---

## 7. What is actually running

| Element | Running? | Evidence |
|---|---|---|
| Store schema + migrations | yes | 2 migration rows; `migrate()` runs on `open()` |
| Retrieval engine | yes | executed this audit: `selected 1 / 8`, digest produced |
| Harness CLI | yes | executed this audit |
| `cbm_query` extension | **deployed and loadable** | `install-omp-integration.mjs check` → `cbm-query.js MATCH`; offline import registers the tool (prior audit) |
| `cbm_query` used by an agent | **once ever** | 1 `toolCall` across 1,741 transcripts (2026-10-18T13:56:40Z) |
| Graph retrieval provider | **no** | no production caller at `f731015` |
| Write-back | **no** | authority denied by every profile; 0 writes |
| Automatic ingestion | **no** | not implemented by design |

---

## 8. Summary in five sentences

1. AegisFlow has one memory system, and its name is CBM.
2. It stores governed facts, not parsed code: there is no indexer, symbol table,
   call graph, or semantic search anywhere in `src/`.
3. Its read surfaces (CLI, graph provider, OMP tool) all delegate to the same
   deterministic engine; only their callers' authority differs.
4. Its write surface is complete, evidence-bound, and closed by every admission
   profile, which is why the store has been frozen at 8 self-closeout records since
   2026-08-16.
5. None of this is a defect in the engine; it is a statement about what was built
   and what was never switched on.
