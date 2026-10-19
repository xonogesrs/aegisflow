# CBM upstream parity matrix

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT
**Baseline:** `f731015`

---

## 0. How to read this matrix

The card's classification vocabulary presumes an upstream ("UPSTREAM_*"). The
provenance audit established that **AegisFlow has no integrated CBM upstream**
(`CBM_PROVENANCE_AND_HISTORY.md`). Applying `UPSTREAM_PRESENT_LOCAL_MISSING` to a
project that was never integrated would be a category error — it would imply an
obligation that does not exist.

So each row is classified **twice**:

1. **`LOCAL_STATE`** — the AegisFlow-vs-nothing classification, using the card's
   vocabulary where it is meaningful for a first-party subsystem.
2. **`VS_REFERENCE`** — what the two documented reference implementations
   (`DeusData/codebase-memory-mcp`, `@colbymchenry/codegraph`) would add. This is
   informational for the repair decision, **not** a parity debt.

Legend for `VS_REFERENCE`: `ADD` = reference has it, local does not;
`LOCAL_ONLY` = local has it, references do not; `BOTH` = both have it;
`NEITHER` = neither.

Every row carries an evidence location. `NOT_APPLICABLE` is used only where the
capability has no meaning for a governed ledger.

---

## 1. The matrix

| # | Capability | Local state | Evidence | Vs DeusData | Vs CodeGraph |
|---|---|---|---|---|---|
| 1 | Repository indexing | `LOCAL_EXTENSION` (a *record* index, not a source index) | `src/memory/sqlite-schema.mjs` DDL; **no** tree-sitter/ctags/LSP anywhere (`grep` over `src/`, `scripts/` → 0) | `ADD` | `ADD` |
| 2 | Incremental update | `VERSION_DIFFERENCE` — freshness is check-at-use, not a watcher | `scripts/autoloop-memory-query.mjs` `computeFreshness`; `cbm-query.js` `freshness` block | `ADD` | `ADD` |
| 3 | File navigation | `NOT_APPLICABLE` (no file/symbol model) | absent; `scope.path` is a declared string on a record | `ADD` | `ADD` |
| 4 | Symbol search | `NOT_APPLICABLE` | no symbol extractor; `scope.symbol` is declared, not derived | `ADD` | `ADD` |
| 5 | Dependency graph | `NOT_APPLICABLE` | `grep -rn "call graph\|dependency graph" src` → 0 | `ADD` | `ADD` |
| 6 | Impact analysis | `NOT_APPLICABLE` | same | `ADD` | `ADD` |
| 7 | Persistent knowledge | `UPSTREAM_PRESENT_LOCAL_PRESENT` → reframed: **`LOCAL_EXTENSION`**, governed | `src/memory/local-store.mjs`, `jsonl-journal.mjs`; live store 8 records, 8 journal events | `NEITHER` (their persistence is a derived graph) | `NEITHER` |
| 8 | Project memory (decisions/runs) | `LOCAL_EXTENSION` (`DECISION`, `EXECUTION`, `PATTERN`) | `contract.mjs:11` `RECORD_TYPES`; 3 EXECUTION records in store | `ADD` (ADR only, ungoverned) | `ADD`? — neither has run history either; closest is `manage_adr` | 
| 9 | MCP interface | `LOCAL_EXTENSION` — an OMP **extension tool**, not MCP | `integrations/omp/extensions/cbm-query.js` `pi.registerTool`; no CBM entry in any `mcp.json` | `ADD` (17 MCP tools) | `ADD` (10 MCP tools) |
| 10 | Multi-repository | `VERSION_DIFFERENCE` — isolation by identity, not a cross-repo graph | `resolveRepositoryIdentity` + eligibility filter; `repository-aliases.mjs` for declared lineage | `ADD` (`CROSS_*` edges) | `NEITHER` |
| 11 | Update / migration | `LOCAL_EXTENSION` — forward-only migrations, checksum-pinned | `sqlite-schema.mjs:183-260`; 2 rows in `memory_migrations` | `BOTH` | `BOTH` |
| 12 | Deterministic retrieval | `LOCAL_EXTENSION` | `retrieval.mjs` frozen ranking tuple + `retrievalDigest`; tests N3–N6 | `ADD` (not claimed upstream) | `ADD` (not claimed) |
| 13 | Trust ladder / promotion | `LOCAL_EXTENSION` | `contract.mjs` `TRUST_STATES`; `writeback/trust.mjs` | `N/A` (no such concept) | `N/A` |
| 14 | Validity / stale / tombstone / conflict | `LOCAL_EXTENSION` | `contract.mjs` `VALIDITY_STATUSES`; `retrieval.mjs` conflict policy | `N/A` | `N/A` |
| 15 | Conflict surfacing (never silent merge) | `LOCAL_EXTENSION` | `retrieval.mjs` conflict group; store `memory_conflicts` table (0 rows) | `N/A` | `N/A` |
| 16 | Journal + crash recovery / rebuild | `LOCAL_EXTENSION` | `jsonl-journal.mjs`; `rebuildFromJournal`; `test-rebuild-determinism.mjs` | `N/A` | `N/A` |
| 17 | Governed write-back with evidence binding | `LOCAL_EXTENSION` (mechanism complete, **0 production writes**) | `writeback/gate.mjs`, `writeback/graph.mjs`; store `memory_evidence` = 0 rows | `N/A` | `N/A` |
| 18 | Secret-scan / ingestion allowlist | `LOCAL_EXTENSION` | `validation.mjs` secret scan; `run-evidence-store.mjs` `scanForSecrets` | `UNKNOWN` upstream | `UNKNOWN` upstream |
| 19 | Semantic / vector search | `UPSTREAM_PRESENT_LOCAL_MISSING` (vs DeusData only) | no embedding dep; `node_modules` search → none | `ADD` | `UNKNOWN` |
| 20 | HTTP/gRPC route discovery, IaC indexing, dead-code detection, Cypher | `NOT_APPLICABLE` to a ledger | absent by design | `ADD` | `ADD` (subset) |
| 21 | Web UI / visualization | `NOT_APPLICABLE` | absent | `ADD` (CBM Lens beta) | `ADD`? — no UI documented in the installed package README |

### 1.1 Rows that need a note

**Row 1 — "repository indexing" is the pivot.** AegisFlow's CBM *indexes records
that were written into it*; it never reads the repository tree. Any claim that
"CBM indexes the codebase" is false at this baseline. `scope.path` / `scope.symbol`
exist to let an operator **attribute** a record to a file or symbol, not to
discover it.

**Row 7 — persistent knowledge is `LOCAL_ONLY`, not parity drift.** Neither
reference project stores governed, evidence-bound facts with a trust ladder; both
derive a graph from source. Treating DeusData as "our upstream, missing features"
would invert the relationship.

**Row 9 — "MCP interface".** The card's `UPSTREAM_PRESENT_NOT_EXPOSED` category
does not apply: the local surface **is** exposed (to OMP). What is absent is
*MCP registration*, which was never created and has no defect to repair (see
`CBM_OMP_INTEGRATION_AND_USAGE.md` §2).

**Row 17 — the write path is complete but unexercised.** `runGraphWriteback` is
wired at `src/runtime/colima-graph-runner.mjs:892`, gated on
`writeback.store` **and** `admission.memory_policy.writeback_allowed`. Every
profile in `src/admission/policy-projection.mjs:79-127` sets
`memory_writeback_allowed: false`. So the mechanism is present, the authority is
denied by every profile, and the observed write count since 2026-08-16 is 0.

**Row 19 — semantic search.** This is the only row where an upstream capability is
genuinely absent locally *and* would matter if the goal were code navigation. It is
marked against DeusData only; CodeGraph's README does not claim vector search.

---

## 2. The two "missing" capabilities that are really one

Rows 1–6 and 19 are all symptoms of one architectural fact: **AegisFlow never built
a parser.** Everything in that block (index, symbol table, call graph, impact,
semantic search) depends on parsing source into a graph, which `src/memory/`
deliberately does not do.

That yields the honest summary:

| Statement | Grade |
|---|---|
| AegisFlow uses 100% of *its own* CBM design | `CONFIRMED` — contract, store, retrieval, write-back, tool all exist |
| AegisFlow uses **0%** of any *third-party* code-index capability | `CONFIRMED` — none was integrated |
| The "original CBM capabilities" the card asks about do not exist as a set to be "missing" | `CONFIRMED` |
| What the local system *lacks relative to a code-intelligence product* is a source parser and the graph built from it | `CONFIRMED` |
| What it *has that no candidate has* is a governed, deterministic, evidence-bound record store | `CONFIRMED` |

---

## 3. Requirement mapping (card §5's ten rows)

The card's table asked for these ten; here they are in one place.

| Card row | Local state | Reference has it | Meaning |
|---|---|---|---|
| Repository indexing | record index, not source index | yes (both) | genuine capability gap vs products |
| File navigation | absent | yes (both) | gap |
| Symbol search | absent | yes (both) | gap |
| Dependency graph | absent | yes (both) | gap |
| Impact analysis | absent | yes (both) | gap |
| Persistent knowledge | **present, governed** | derived-graph only | **local strength** |
| Project memory | **present** (`DECISION`/`EXECUTION`/`PATTERN`) | partial (ADR) | **local strength** |
| MCP interface | present as OMP extension tool | yes (both, MCP) | interface differs; both work |
| Multi-repository | present as isolation | DeusData yes / CodeGraph no | design difference, not a defect |
| Update / migration | present, forward-only | yes (both) | equivalent |

---

## 4. Non-claims

- This matrix does not say CBM is "behind" DeusData. They measure different things.
- It does not say DeusData should be adopted. That is a separate, unauthorised decision.
- `NOT_APPLICABLE` rows are not defects and must not be turned into repair tickets.
- No row was downgraded because the feature is unused; usage is reported separately
  in `CBM_OMP_INTEGRATION_AND_USAGE.md`.
