# AEGISFLOW_EKM_NAMING_AND_COMPATIBILITY_1 — Report

**Card:** `AEGISFLOW_EKM_NAMING_AND_COMPATIBILITY_1`
**Type:** targeted implementation (name + compatibility only)
**Agent:** OMP
**Date:** 2026-10-19
**Verdict:** **PASS**

---

## 0. Durable landing gate (re-verified before any edit)

| Check | Expected | Observed | Result |
|---|---|---|---|
| Prior card verdict | PASS | PASS (`AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`) | OK |
| Prior commit | `8bb72a5` | `8bb72a5bef34c3439aea8b1f6700375c2a17fd9e` | OK |
| Branch | `audit/omp-native-capability-dispatch-1` | same | OK |
| Remote SHA for that branch | `8bb72a5` | `8bb72a5bef34c3439aea8b1f6700375c2a17fd9e` | OK |
| `merge-base --is-ancestor 8bb72a5 <remote>` | 0 | exit 0 | OK |
| `origin/main` | `1cf1e9f` | `1cf1e9f` | OK |
| Worktree A (`/Volumes/NVM2T/Development/repos/autoloop`) | clean | clean | OK |
| Worktree B (`/private/tmp/aegis-work`) | clean | clean | OK |
| Stash list | 0 entries | 0 entries | OK |
| OMP本体 modified | no | no | OK |

Audit commit scope confirmed: `git diff --stat 1cf1e9f 8bb72a5` touches **only**
`docs/audit/**`. No source, config, store or OMP state was carried by the landing.

---

## 1. What changed (exact file list)

| File | Change |
|---|---|
| `integrations/omp/extensions/cbm-query.js` | registers `ekm_query` (primary) + `cbm_query` (`defaultInactive` compatibility); EKM label/description/summary/authority-boundary wording; shared `parametersSchema` / `executeQuery` / `resultPayload` so both names use one seam |
| `test/omp-integration/test-omp-cbm-query.mjs` | contract test targets `EKM_TOOL`; new assertion pins `cbm_query.defaultInactive === true`; new test asserts the legacy name returns a byte-identical payload |
| `integrations/omp/README.md` | EKM naming, deployed-layout note, `ekm_query` table row, tool section, compatibility subsection |
| `docs/agent-integration.md` | extension table row + tool narrative moved to `ekm_query`, compatibility paragraph |
| `docs/troubleshooting.md` | section heading `ekm_query` (formerly `cbm_query`) |
| `package.json` | `omp:cbm-test` → `omp:ekm-test` (same target file) |

No file under `src/` was touched. No schema, migration, journal, FTS, hash-chain,
write-back, admission profile, MCP registration or OMP installation was touched.

### 1.1 Naming classes — what was and was not renamed

| Class | Item | Decision |
|---|---|---|
| User-visible name | Tool label `Codebase Memory` | → `Engineering Knowledge Memory` |
| Agent-visible tool name | `cbm_query` | → `ekm_query`; `cbm_query` retained as `defaultInactive` compat entry |
| Agent-visible description | "Query AegisFlow's codebase memory (CBM)…" | → card text: "Query verified engineering knowledge, decisions, provenance, and evidence… Not a source-code symbol index or call graph." |
| User-visible result text | `N codebase-memory record(s)` etc. | → `N engineering-knowledge record(s)` |
| Authority boundary text | "Codebase memory content is DATA…" | → "Engineering knowledge memory content is DATA…" (marker unchanged) |
| Program-internal identifiers | `queryCodebaseMemory`, `loadMemoryModules`, state constants, `kind: "MEMORY_CONTEXT_DATA"` | **unchanged** (no behaviour change; contract strings are consumed by memory tests) |
| Persisted data | record schema, `recordId`, repository identity, DB/journal/FTS | **unchanged** |
| Historical evidence | CBM-1…CBM-4 card IDs, migration IDs `cbm2-v1`, `cbm2-v1-pattern-type`, audit documents, test file names, `test/memory/helpers-cbm3.mjs` | **unchanged** — renaming these would rewrite history or break migration checksums |
| Deployed filename | `cbm-query.js` | **unchanged** — see §3 |

Deliberately **not** a global `s/d/CBM/EKM/`: the token appears in migration IDs
(checksum-frozen), card IDs (historical evidence) and internal module names.

---

## 2. The two tool registrations

```js
pi.registerTool({ name: "ekm_query",  label: "Engineering Knowledge Memory", … loadMode: "essential" });
pi.registerTool({ name: "cbm_query",  label: "Engineering Knowledge Memory (legacy tool name)",
                  defaultInactive: true, … });     // compatibility entry
```

- Both call the **same** `executeQuery()` → `queryCodebaseMemory()` →
  `LocalMemoryStore.query()`. No router, no second store, no second ranking path.
- `defaultInactive: true` is OMP's documented mechanism: the tool is registered
  but excluded from the initial active set unless a caller explicitly names it
  (`--tools cbm_query` or an agent `tools` field). Verified against the host
  source: `src/sdk.ts:2998-3022` and `src/sdk.ts:3552`.
- The legacy entry is therefore **not** a second equivalent tool in the agent's
  vocabulary. `ekm_query` is the only memory tool an agent sees.

---

## 3. Why the filename did not change

`cbm-query.js` is a **deployed discovery entry**: OMP loads top-level `*.js`
under `~/.omp/agent/extensions/`. The installer's `KNOWN_FILES` is the whole
deployment surface, and it does not delete files it no longer knows about
(`scripts/omp-integration/lib.mjs:41-49`). Renaming the source file to
`ekm-query.js` would leave the previously deployed `cbm-query.js` in place, so
every upgraded machine would load **two** modules registering the same tools.
That is exactly the "duplicate equivalent tool" outcome the card forbids.

The file name is an internal/persistence-layer identifier; the agent-visible
tool name and description are the user-facing surface the card targets. Keeping
the file name is the minimal, non-destructive choice.

**Controller note (not performed):** deploying the new bytes to
`~/.omp/agent/extensions/` is a global OMP-configuration change that would affect
other live sessions. Per card §6 that decision is left to the Controller. A
read-only `check` currently reports `DRIFT` on `cbm-query.js` (expected: source
newer than deployment) and `MATCH`/`EQUIVALENT` on the other six files.

---

## 4. Acceptance evidence

### A. EKM tool

| Requirement | Evidence |
|---|---|
| Correct formal name | `node --test test/omp-integration/test-omp-cbm-query.mjs` → 11/11 PASS; asserts `tools.keys() == [ekm_query, cbm_query]`, `details.op === "ekm_query"` |
| Correct description | test asserts `/Engineering Knowledge Memory/` and `/Not a source-code symbol index or call graph/` |
| Queries existing memory | live OMP session (`omp -p -e integrations/omp/extensions/cbm-query.js`, no deployment change): `ekm_query` returned 2 records with `validityPolicy=INCLUDE_STALE` |
| Same content as before rename | baseline vs. after payload comparison (§4.1) |
| Not described as a code index | description text explicitly negates it |
| Not auto-exposed as duplicate | live session tool listing returned `ekm_query` only; `cbm_query` absent unless `--tools cbm_query` |

### 4.1 Byte-level content comparison (pre/post rename)

Captured `queryCodebaseMemory` output for two identities immediately before and
after the edit, same store, same parameters (`trustFloor=RAW`,
`validityPolicy=ALL`, `maxRecords=50`):

| Repository | state | records | `retrieval` block identical | `repository` block identical | `freshness` identical |
|---|---|---|---|---|---|
| Owning checkout | `AVAILABLE` | 8 | **yes** | **yes** | **yes** |
| This worktree | `AVAILABLE` | 0 | **yes** | **yes** | **yes** |

Only `authorityBoundary` changed, by the EKM wording. No record, score, digest,
exclusion or freshness value moved.

### B. Compatibility

| Requirement | Evidence |
|---|---|
| Existing callers not broken | module test: legacy call returns a payload `deepEqual` to the `ekm_query` payload; live host session with `--tools cbm_query` returned 2 records |
| No duplicate equivalent tools | `defaultInactive: true` on the legacy entry; live session listing shows `ekm_query` only |
| Persistence contract unchanged | no `src/` diff; store bytes unchanged (`memory.db` SHA recorded, §5); retrieval payload identical |
| Explicit legacy use works | live `omp -p --tools cbm_query` → correct summary; `details.op` reported the name actually called |

### C. Baseline

| Requirement | Evidence |
|---|---|
| OMP binary unmodified | `~/.local/bin/omp` SHA-256 `fa41b27d…24bac5`, mtime `Oct 18 12:52` (unchanged by this card) |
| OMP source unmodified | no repository outside AegisFlow touched; no `omp`/`pi` install or upgrade run |
| Evolution still disabled | `EVOLUTION_LEARNING_ENABLED = NONE`; no evolution store configured (`AEGISFLOW_EVOLUTION_STORE_ROOT` unset; no `evolution-suspended.json` under any configured root); no write-back profile enabled, no new MCP server |
| Terminal Fence unaffected | extension is read-only; `no-poll-waits.js` byte-identical in source (`git diff` empty for it) |
| EKM data intact | `~/.autoloop/memory/memory.db` SHA-256 `0fa9dbb3…1e487c`, `journal.jsonl` SHA-256 `c5093265…c22733` — both unchanged across the whole card; 8 records still retrievable |

### 4.2 Test runs (scoped to this card)

| Suite | Result |
|---|---|
| `node --test test/omp-integration/test-omp-cbm-query.mjs` | **11/11 pass** |
| `node --test test/omp-integration/` | **36/36 pass** |
| `node scripts/omp-integration/scan-publication.mjs` | `REAL_SECRETS=0 PRIVATE_PATHS=0 PERSONAL_IDENTIFIERS=0` → `PUBLICATION_SCAN=CLEAN` |
| `node scripts/install-omp-integration.mjs check` | read-only drift report (see §3) |

No unrelated large test matrix was run, per card §5.

---

## 5. Persistence and history preservation

- No database, journal, index or alias file was written by this card.
- The 8 existing records remain bound to their original identity and tree
  (`8bc33e49…`); default retrieval still selects 1 of 8, historical retrieval 8 of 8.
- Migration IDs (`cbm2-v1`, `cbm2-v1-pattern-type`), their checksums and the
  `memory_migrations` table are untouched.
- Card IDs, audit documents and test fixture names containing `cbm` are
  historical evidence and were left as-is.

---

## 6. Landing

| Item | Value |
|---|---|
| Branch | `feat/omp-cbm-recovery` (continues the recovery line) |
| Commit | `1ebb1211a33192257936331c74940a25c60cf379` — `feat(ekm): name the first-party memory tool ekm_query` |
| Parent | `1cf1e9fa284d2407c4edbe42f525fffe12a169c2` (`origin/main`) |
| Remote | `git@github.com:xonogesrs/aegisflow.git` |
| Remote HEAD after push+fetch | `1ebb1211a33192257936331c74940a25c60cf379` (equal to local) |
| Staged files | exactly the 7 files listed in §1 |
| Worktree `/private/tmp/aegis-work` | clean at `1ebb121` |
| Worktree `/Volumes/NVM2T/Development/repos/autoloop` | clean, still at `8bb72a5` on the audit branch (untouched) |
| Stash | 0 entries |

### 6.1 Post-landing verification

- `git rev-parse HEAD` == `git rev-parse refs/remotes/origin/feat/omp-cbm-recovery` → `1ebb121`.
- `node --test test/omp-integration/` on the committed tree → **36/36 pass**.
- `node scripts/omp-integration/scan-publication.mjs` → `PUBLICATION_SCAN=CLEAN`.
- `~/.autoloop/memory/memory.db` → `0fa9dbb3…` and `journal.jsonl` → `c5093265…`,
  both unchanged from the pre-card baseline (the 8 records and the journal hash
  chain were never written).
- `~/.local/bin/omp` → `fa41b27d…` (unchanged).

---

## 7. Verdict

**PASS** for the scope of this card: the primary agent-facing tool is `ekm_query`
with the required description; the previous name remains reachable as a
non-auto-exposed compatibility entry; all 8 memory records and the persistence
contract are unchanged; OMP binary, source, configuration, evolution state and
terminal-fence authority were not touched.

**This PASS does not authorize installing DeusData CBM.** No MCP server was
added, no third-party package installed, no `mcp.json` edited. Work stops here
for Controller review before `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`.

### Open item for the Controller

Deployment of the new extension bytes to `~/.omp/agent/extensions/` was **not**
performed (global config, affects other running sessions). `npm run omp:install`
after approval will replace the single `cbm-query.js` file and preserve the
current copy in `omp-integration-backups/`.
