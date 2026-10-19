# CBM upstream capability inventory

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT

---

## 0. Scope statement (read this before the tables)

The card asks for the upstream capabilities of "the GitHub CBM we integrated".
**There is no integrated upstream** — see `CBM_PROVENANCE_AND_HISTORY.md`.

Consequently this document does two things, kept strictly separate:

1. **§1 — the substrate actually installed here** (AegisFlow's own CBM-2/3/4
   modules). This is the thing that produces `cbm_query` answers.
2. **§2–§4 — the two GitHub projects named in the card, inventoried as *reference
   implementations only***, with their upstream facts and what adopting one would
   and would not give. They are `NOT_INTEGRATED`, not "our upstream with version
   drift".

Nothing in §2–§4 is installed, registered, or executed by AegisFlow at this
baseline.

---

## 1. Installed substrate — AegisFlow CBM-2/3/4

### 1.1 Code inventory (measured, `wc -l`)

| File | Lines | Role |
|---|---:|---|
| `src/memory/canonical.mjs` | 123 | recursive canonical JSON + content hash |
| `src/memory/contract.mjs` | 255 | frozen enums (record types, trust, validity, scopes, relationships) |
| `src/memory/identity.mjs` | 71 | recordId / logicalKey / contentHash derivation |
| `src/memory/schema.mjs` | 66 | per-type field requirements |
| `src/memory/validation.mjs` | 726 | fail-closed validators + secret scan |
| `src/memory/sqlite-schema.mjs` | 590 | DDL, migrations, pinned FTS5 tokenizer |
| `src/memory/jsonl-journal.mjs` | 249 | append-only hash-chained journal |
| `src/memory/query-schema.mjs` | 409 | query contract `autoloop.memory-query/v1` |
| `src/memory/snapshot.mjs` | 121 | store snapshot digest |
| `src/memory/retrieval.mjs` | 686 | deterministic ranking + eligibility pipeline |
| `src/memory/local-store.mjs` | 578 | store open/close/migrate/query/import/lifecycle |
| `src/memory/repository-aliases.mjs` | 158 | declared lineage registry |
| `src/memory/graph-context.mjs` | 156 | read-only graph provider |
| `src/memory/writeback/*` (9 files) | 1,324 | CBM-4 governed write-back |
| **subtotal** | **5,512** | |
| `integrations/omp/extensions/cbm-query.js` | 357 | OMP tool adapter |
| `scripts/autoloop-memory-query.mjs` | 204 | harness CLI |
| **total** | **6,073** | |

Tests: 30 files under `test/memory/` plus `test/omp-integration/test-omp-cbm-query.mjs`.

### 1.2 Capability evidence (executed at `f731015`)

| Capability | Present? | Evidence |
|---|---|---|
| Durable store (SQLite primary + JSONL journal) | **yes** | `src/memory/sqlite-schema.mjs` (DDL + FTS5), `jsonl-journal.mjs` (hash chain) |
| Deterministic retrieval | **yes** | `retrieval.mjs` frozen ranking tuple; digest tests N3–N6 pass |
| Lexical search | **yes** | FTS5 with pinned tokenizer `unicode61 remove_diacritics 0` (`sqlite-schema.mjs:124-127`) |
| Identity binding (repo/worktree/commit/tree/path/symbol) | **yes** | `identity.mjs`, `resolveRepositoryIdentity` |
| Trust ladder + promotion rules | **yes** | `contract.mjs` RAW→CONFIRMED; `writeback/trust.mjs` |
| Validity / stale / invalidated / tombstone / conflict | **yes** | `contract.mjs` `VALIDITY_STATUSES`; `retrieval.mjs` eligibility |
| Conflict surfacing (never silent merge) | **yes** | `retrieval.mjs` conflict policy; tests V8 |
| Crash recovery / journal rebuild | **yes** | `rebuildFromJournal`, `verifyJournalParity`; `test-rebuild-determinism.mjs` |
| Governed write-back (evidence-bound) | **yes** (mechanism) | `writeback/gate.mjs` `runWritebackGate`, `writeback/graph.mjs` `runGraphWriteback` |
| Cross-session persistence | **yes** | one store at `~/.autoloop/memory`, shared by CLI + extension |
| Repository isolation | **yes** | identity filter; `cbm_query` test "another repository's records are never returned" |
| Declared lineage (repo rename/move) | **yes** | `repository-aliases.mjs`; two aliases declared on the live store |
| Zero external dependencies | **yes** | `node:sqlite` only; `package.json` has one runtime dep (`pi-ai`) unrelated to memory |

### 1.3 Capabilities that do **not** exist in the installed substrate

These are the gaps that make "CBM" smaller than the phrase "codebase intelligence"
suggests. Each is `CONFIRMED` by the searches shown.

| Missing capability | Evidence |
|---|---|
| **Source-code indexing** (parse the repository tree into symbols) | `grep -rln "tree-sitter\|ast-grep\|ctags\|language server\|LSP" src scripts` → **no matches** |
| **Symbol table / definition search** | no symbol extractor anywhere; record `scope.symbol` is an operator-declared string |
| **Call graph / dependency graph** | `grep -rn "call graph\|dependency graph\|impact analysis" src` → **no matches** |
| **Impact analysis** | same search; absent |
| **Incremental re-index on file change** | no watcher; freshness is check-at-use against `HEAD^{tree}` |
| **Semantic / vector search** | no embedding dependency; `retrieval.mjs` is lexical + scope + trust only |
| **Automatic ingestion** | `explicitImport` is the only write path (CBM-4 keeps auto write-back out of scope) |
| **Multi-repository graph** | isolation is per-identity by design; no cross-repo edge model |
| **File outline / code snippet retrieval** | absent |

The installed CBM is therefore a **governed knowledge ledger with deterministic
retrieval** — not a code index. This is the single most important finding of the
parity work, and it is what the rest of this document is measured against.

### 1.4 Scale and current contents

| Metric | Value |
|---|---|
| Records in `~/.autoloop/memory/memory.db` | 8 (5 CODE, 3 EXECUTION) |
| FTS rows | 8 |
| Lifecycle events | 8 |
| Evidence rows | 0 |
| Conflicts | 0 |
| Relationships | 0 |
| Journal events | 8 |
| Migrations applied | 2 (`cbm2-v1`, `cbm2-v1-pattern-type`) |
| Store size | 208,896 B (`memory.db`) + 17,647 B (`journal.jsonl`) |
| Creation window | 2026-08-07 → 2026-08-16 |
| Recorded trees | one (`8bc33e49…`) |

Record scope: 5 CODE records name the five paths the CBM-live-integration card
touched; 3 EXECUTION records are graph closeouts (`cbm4-self-closeout-20260807`,
`de1-self-closeout-20260808`, `cbm-live-integration-1`). All 8 carry
`evidenceIdentity` of `null` except the EXECUTION `source` field — i.e. they are
**self-closeout records about CBM itself**, not knowledge about the codebase.

---

## 2. Reference implementation A — `DeusData/codebase-memory-mcp`

**Status: `NOT_INTEGRATED`.** Inventoried from upstream documentation only.

| Fact | Value | Source |
|---|---|---|
| Repository | `github.com/DeusData/codebase-memory-mcp` | GitHub API |
| License | MIT | repo README badge + `LICENSE` |
| Latest release | **v0.12.1**, published 2026-10-16 | `/releases/latest` |
| `main` at audit time | `d4980ad7570b42e8186a77fbdf1b963639bbbe8e` (2026-10-19) | `/commits/main` |
| Implementation | pure C, single static binary, zero dependencies | README |
| Storage | SQLite graph DB under `~/.cache/codebase-memory-mcp/` (or `CBM_CACHE_DIR`) | README "Persistence" |
| Interface | MCP server, **17 tools**; also CLI mode and an embedded web UI ("CBM Lens", beta) | README |
| Parsing | 162 vendored tree-sitter grammars + hybrid LSP type resolution for 13 languages | README |
| Scale claim | Linux kernel (28M LOC / 75K files) indexed in ~3 min; Cypher queries < 1 ms on M3 Pro | README benchmark |
| Local-only | yes — no hosted service, no API key; optional browser model download only if the Lens chat is enabled | README |
| Client integration | installer writes config for 45 agent surfaces | README "Multi-Agent Support" |

### 2.1 Capability matrix (upstream, as documented)

| Capability | Upstream support | Notes |
|---|---|---|
| Repository indexing | **yes** | `index_repository`; modes `full` / `moderate` / `fast` |
| Incremental update | **yes** | background watcher + `(size,mtime)`/content-hash reconciliation |
| File navigation | **yes** | `get_file_outline`, `search_code`, Lens Explore |
| Symbol search | **yes** | `search_graph` (structural + BM25 + semantic) |
| Dependency / call graph | **yes** | `CALLS`, `IMPORTS`, `IMPLEMENTS`, `INHERITS`, cross-service edges |
| Impact analysis | **yes** | `detect_changes` maps a git diff to affected symbols + blast radius |
| Persistent knowledge graph | **yes** | SQLite graph persisted per project |
| Project memory (decisions) | **partial** | `manage_adr` stores Architecture Decision Records, not run history |
| MCP interface | **yes** | 17 tools |
| Multi-repository | **yes** | `CROSS_*` edges across indexes in one store |
| Update / migration | **yes** | install script is the updater; schema migrations on index open |
| Determinism guarantees | **not claimed** | ranked results are heuristic (BM25 + 11-signal scoring) |
| Governed write path / trust ladder | **no** | the graph is derived from source; ADR writes are ungoverned |
| Secret-scan / ingestion allowlist | **not documented** | — |

---

## 3. Reference implementation B — `@colbymchenry/codegraph`

**Status: `NOT_INTEGRATED` (but installed on this machine for unrelated use).**

| Fact | Value | Evidence |
|---|---|---|
| Package | `@colbymchenry/codegraph@0.9.6` | `~/.npm-global/lib/node_modules/@colbymchenry/codegraph/package.json` |
| Installed | 2026-05-28 (before the CBM cards) | package directory mtime |
| License | MIT (`"license": "MIT"`) | package.json |
| Interface | MCP server, **10 tools** | README "MCP Tools" |
| Storage | `.codegraph/` directory inside each initialized project | README |
| Status for this repo | `codegraph status` → **`Not initialized`**; `.codegraph/` absent | executed |
| Registration in any agent config | **none** (not in OMP `mcp.json`, not in `~/.claude.json`, not in Codex) | config inspection |

### 3.1 Capability matrix (upstream, as documented)

| Capability | Upstream support | Tool |
|---|---|---|
| Repository indexing | **yes** | `codegraph init` |
| Incremental update | **yes** | debounce + connect-time reconciliation |
| File navigation | **yes** | `codegraph_files` |
| Symbol search | **yes** | `codegraph_search` |
| Dependency graph | **yes** | `codegraph_callers`, `codegraph_callees` |
| Impact analysis | **yes** | `codegraph_impact` |
| Persistent knowledge graph | **yes** | `.codegraph/` on disk |
| Project memory (decisions) | **no** | not a feature |
| MCP interface | **yes** | 10 tools |
| Multi-repository | **not documented** | per-project index |
| Update / migration | package version | npm |
| Determinism guarantees | **not claimed** | heuristic context building |
| Governed write path / trust ladder | **no** | index-derived |
| Secret-scan / ingestion allowlist | not documented | — |

---

## 4. What each candidate would and would not replace

The distinction that matters for the repair decision (see
`CBM_MINIMAL_REPAIR_CANDIDATES.md`):

| Need | AegisFlow CBM-2/3/4 today | DeusData CBM | CodeGraph |
|---|---|---|---|
| "What did we already decide/measure here, with evidence?" | **yes, governed** | no | no |
| "Where is symbol X defined / who calls it?" | **no** | **yes** | **yes** |
| "What breaks if I change this file?" | **no** | **yes** | **yes** |
| Deterministic, digest-verifiable answer | **yes** | no | no |
| Trust levels / promotion / conflict surfacing | **yes** | no | no |
| Zero new dependency | **yes** | a 50 MB binary | a bundled runtime |
| Operates without an agent host | **yes** (CLI) | yes (CLI) | no (MCP only) |

They are **complementary, not substitutes**. That is the finding that shapes the
minimal-repair options: the honest choices are (a) keep CBM as the governed
knowledge ledger and leave code navigation to grep/read/OMP-native tools, or
(b) add a *separate* code-index MCP alongside CBM, not instead of it.

---

## 5. Grades

| Claim | Grade |
|---|---|
| No upstream GitHub CBM was integrated | `CONFIRMED` |
| Installed CBM has no source-code indexer | `CONFIRMED` (negative grep over `src/` + `scripts/`) |
| Installed CBM has a governed, deterministic retrieval engine | `CONFIRMED` (tests + executed CLI query) |
| DeusData capabilities as listed | `CONFIRMED` from upstream README at v0.12.1 / `main` `d4980ad` |
| CodeGraph capabilities as listed | `CONFIRMED` from the installed package's own README/package.json |
| "Adopting DeusData would restore CBM's value" | **not established** — it would add a *different* capability (code navigation), not restore the ledger |
