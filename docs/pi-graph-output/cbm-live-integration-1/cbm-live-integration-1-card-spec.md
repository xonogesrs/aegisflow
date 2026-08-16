# AUTOLOOP-CBM-LIVE-INTEGRATION-1 — CBM Live Integration: Harness Query Surface + Production Provider Wiring

Card: xonogesrs/autoloop (repo-local). Type: formal review-required implementation.
Baseline: `d36d016` (REVART-LC1 dogfood closeout evidence), branch `governance/decomp-opt1-design-freeze`.
Review lifecycle: THIS card is the first formal card that must auto-publish to the canonical surface
(`~/Desktop/AutoLoop-Review/Current/`) with NO `reviewSurfaceDir` override, NO manual bundle, NO manual verdict.

## Goal

Make the existing AutoLoop Codebase Memory (CBM-2/CBM-3 foundation, `src/memory/*`) genuinely available to
the live executor and read-only sub-agents. Integration of the existing foundation — NOT a second memory system.

## Known chain gaps (reconciled by this card)

1. no harness-facing query surface → **Phase 1: `scripts/autoloop-memory-query.mjs` (CLI)**
2. production dispatch does not inject a memory provider → **Phase 2: one construction site in `runAdmittedGraph`**
3. admission defaults `memory_retrieval_allowed=false` → **Phase 3: preserved as an explicit capability
   (FAST_PATH stays false; this card's admission uses the HIGH profile → retrieval_allowed=true)**
4. sub-agents receive only passive pre-built memoryContext → **Phase 6: on-demand CLI query by a real read-only scout**
5. repository identity is path-bound → **Phase 4: hard isolation preserved; governed population via the CBM-4
   writeback gate for the exact execution identity**
6. freshness/writeback exists but is not production-wired → **Phase 5: check-at-use freshness in the CLI**

## Design decisions (frozen)

### D1 — Query surface is a small machine-readable CLI (Phase 1)
`scripts/autoloop-memory-query.mjs`: resolves identity via the SAME `resolveRepositoryIdentity` the Graph
provider uses, validates an `autoloop.memory-query/v1` query, calls the existing `LocalMemoryStore.query`
(retrieval.mjs). NO duplicated ranking/identity/store logic. Output:
`{ schema: autoloop.memory-query/v1, state: AVAILABLE|EMPTY_MEMORY|INVALID, repository, query, retrieval,
freshness }`. Exit 0 = success (EMPTY_MEMORY is a valid explicit answer, same semantics as the Graph
provider); exit 2 = INVALID fail-closed; exit 3 = usage. No MCP — no justified MCP foundation exists in the repo.

### D2 — ONE provider construction/ownership path (Phase 2)
`runAdmittedGraph` (the production entrypoint) constructs the read-only provider automatically when
`isRetrievalAuthorized(admission)` (memory_policy.retrieval_allowed === true): one site, no caller-specific
dogfood injection. Unauthorized admission → NO provider → the runner gate
(`isRetrievalAuthorized(admission) && memory && provider.retrieveGraphMemory`) fails closed. A caller-supplied
provider is respected unchanged. Provider availability is never authority: missing store → EMPTY_MEMORY;
corrupt → MEMORY_STORE_INVALID HOLD (existing governed semantics).

### D3 — Retrieval stays an explicit capability (Phase 3)
No global default change. FAST_PATH (the only `memory_retrieval_allowed:false` profile) untouched. The card's
own admission is classified HIGH (external review + retrieval) through the authoritative profile path
(`classify` → `buildAdmissionRecord` → `freezeAdmission`), bound to the v3 authority digest + review_closeout binding.

### D4 — Identity: hard isolation preserved; governed population (Phase 4)
`resolveRepositoryIdentity` semantics unchanged (repositoryIdentity = sha256({remote, canonicalPath}); no
silent aliasing `/Volumes/...` ↔ `/tmp/...`). The card's execution identity is resolved from authoritative
execution facts (the worktree this card runs in). If that exact identity has no populated store, the governed
bootstrap is the CBM-4 writeback gate (`runGraphWriteback`) — evidence-bound, verifier/reviewer-backed,
journal-first — writing EXECUTION + CODE records for the card's own changed paths under the exact identity.
No implicit write at query time (preserves the CBM-3/CBM-4 zero-automatic-writeback boundary); population is
an explicit post-run governed step.

### D5 — Freshness: deterministic check-at-use (Phase 5)
The CLI computes `freshness` from the current authoritative repository facts (HEAD^{tree}) vs the set of
indexed `scope.tree` values for that repository identity. `stale` only when an index exists but does not
cover the current tree; tree-bound records bound to an older tree are additionally EXCLUDED at retrieval
time by the existing tree-baseline validity check (never labeled current). Refresh = re-run the governed
writeback/import at the new tree (A9). No filesystem watcher.

### D6 — Sub-agent on-demand access (Phase 6)
A real read-only scout (OMP task agent) issues a bounded CBM query through the CLI during the card's
verification, reports its answer, and the Controller verifies one critical claim from source. The repo's
container sub-agents are fixed busybox scripts (cannot run node) — documented; the CLI is the surface a
future executor integration calls (the colima `runtime.command` path can run it).

### D7 — Benchmark (Phase 7)
Reuse the Review Lifecycle architecture recon as known truth. Ask CBM structural questions, compare against
established truth, and record what CBM made unnecessary (inventory/discovery/grep) vs what still requires
source verification. CBM is not expected to replace proof-of-negative source verification.

## Authorized mutation set

- `scripts/autoloop-memory-query.mjs` (new — CLI query surface)
- `src/admission/admission-gate.mjs` (modify — D2 provider construction site)
- `test/memory/test-cbm-live-query-cli.mjs` (new — A2/A6/A7/A8/A9/A15)
- `test/admission/test-admission-memory-provider.mjs` (new — A3/A4/A5)
- `package.json` (add `test:memory-live`)

Governance outputs (this card's own lifecycle): `docs/pi-graph-output/cbm-live-integration-1/` (authority,
admission, spec, closeout-state, bundle, review job, dogfood evidence).

## Acceptance mapping (A1–A16)

| # | Requirement | Evidence |
|---|---|---|
| A1 | Existing LocalMemoryStore tests green | `test:memory-contract` + `test:memory-retrieval` in the formal runner |
| A2 | CLI returns valid autoloop.memory-query/v1 data | test-cbm-live-query-cli (A2) |
| A3 | Production admitted execution receives provider automatically | test-admission-memory-provider (A3) + formal runner receives `opts.memory` |
| A4 | retrieval_allowed=false → denied/fail-closed | test-admission-memory-provider (A4, FAST_PATH) |
| A5 | retrieval_allowed=true → retrieval succeeds | test-admission-memory-provider (A5, real retrieval) |
| A6 | wrong repository identity → EMPTY/zero, no leakage | test-cbm-live-query-cli (A6, excludedSummary.repository) |
| A7 | missing exact identity → governed population/bootstrap | test-cbm-live-query-cli (A7) + formal writeback population |
| A8 | stale index detected | test-cbm-live-query-cli (A8) |
| A9 | refreshed state queryable with provenance | test-cbm-live-query-cli (A9, indexedTrees [T1,T2]) |
| A10 | real OMP/main executor can query CBM | formal runner invokes injected provider; CLI smoke on /tmp/autoloop |
| A11 | real read-only sub-agent queries CBM on demand | Phase 6 scout proof |
| A12 | parallel scouts querying CBM do not mutate state | CLI is read-only (LocalMemoryStore.query); scout proof uses no writes |
| A13 | restart/new session reopens persisted memory | store open/parity in the formal run (persisted ~/.autoloop/memory) |
| A14 | journal/SQLite parity/rebuild invariants green | test-local-store + test-rebuild-determinism in formal runner |
| A15 | corrupted/mismatched memory fail-closed | test-cbm-live-query-cli (A15, INVALID exit 2) |
| A16 | benchmark answers match direct-source truth | Phase 7 (Controller verifies claims from source) |

## Forbidden scope

No CBM redesign, no second memory DB, no MCP platform build, no Parent→Child changes, no search-governor
work, no unrelated cleanup, no Review Lifecycle changes unless a real blocking defect is found (then REPLAN).

## Pre-closeout

Targeted suites green → `git diff --check` clean → one scoped candidate commit (NO PUSH) → formal lifecycle
run (authority v3 + frozen admission + verification runner, NO reviewSurfaceDir override) → expect
REVIEW_PENDING + review job + automatic delivery to `~/Desktop/AutoLoop-Review/Current/` → verify trio
identity agreement → STOP (no self-mint, no rotate). Verdict:
`READY_FOR_EXTERNAL_REVIEW / CBM_LIVE_INTEGRATION_IMPLEMENTED`.
