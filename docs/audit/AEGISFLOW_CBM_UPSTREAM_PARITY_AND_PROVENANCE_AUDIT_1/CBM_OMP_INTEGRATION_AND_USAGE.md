# CBM — OMP integration and observed usage

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT
**Baseline:** `f731015`

---

## 1. Surface inventory

| Surface | Kind | File | Registered where |
|---|---|---|---|
| `cbm_query` | OMP extension tool | `integrations/omp/extensions/cbm-query.js` (357 lines) | `pi.registerTool`, `loadMode: "essential"`, `approval: "read"` |
| `autoloop-memory-query` | Node CLI | `scripts/autoloop-memory-query.mjs` (204 lines) | `npm run` / direct |
| `memory:lineage` | operator CLI | `scripts/autoloop-memory-lineage.mjs` | `package.json` script |
| graph provider | internal module | `src/memory/graph-context.mjs:87` | no production caller at `f731015` |
| MCP server | — | **does not exist** | no CBM entry in any `mcp.json` |

### 1.1 There is no MCP registration, and none is missing

The card asks whether CBM "has been correctly registered, exposed, and can be
autonomously called by an OMP Agent". The answer differs per surface:

- **Exposed to OMP:** yes — the extension registers `cbm_query` as a first-class
  tool. Verified by the prior audit's offline import probe and by this audit's
  install drift check.
- **Registered as MCP:** no, and there is nothing to repair. `~/.omp/agent/mcp.json`
  contains exactly one server (`kicad`). No AegisFlow file writes or reads MCP
  registration for CBM; `scripts/omp-integration/lib.mjs` `KNOWN_FILES` is a
  7-entry local copy allowlist with no network and no config mutation.

So the "MCP interface" row in the parity matrix is `LOCAL_EXTENSION`, not a
defective MCP integration.

### 1.2 Deployment state (executed)

```
$ node scripts/install-omp-integration.mjs check
OMP_INTEGRATION_DRIFT_CHECK
source = …/integrations/omp/extensions
target = ~/.omp/agent/extensions
  no-poll-waits.js                             EQUIVALENT  (1 redacted identifier)
  cbm-query.js                                 MATCH
  lib/poll-wait-policy.js                      MATCH
  test/poll-wait-policy.test.mjs               MATCH
  test/waiter-fence.acceptance.ts              MATCH
  test/terminal-fence-authority.acceptance.ts  MATCH
  test/terminal-fence-ordering.acceptance.ts   MATCH
MATCH=6 EQUIVALENT=1 DRIFT=0 MISSING=0
DRIFT_CHECK=MATCH
```

The tool is deployed, byte-identical to the published source, and loadable.

---

## 2. Data flow of one `cbm_query` call

```
agent turn
  └─ tool_call { name: "cbm_query", arguments: { terms | path | symbol | recordTypes | trustFloor | validityPolicy | maxRecords } }
       └─ queryCodebaseMemory({ cwd, … })
            ├─ resolveRepoRoot(cwd)          env AEGISFLOW_REPO_ROOT → extension path → walk-up from cwd
            ├─ import(src/memory/index.mjs)  the repo's own engine
            ├─ resolveRepositoryIdentity(cwd)  sha256({remote, canonicalPath})
            ├─ resolveRepositoryLineage(id)    declared aliases from the store root
            ├─ LocalMemoryStore.open()
            ├─ computeFreshness(...)          indexed trees vs HEAD^{tree}
            └─ store.query(validated query)
       └─ { state, kind: "MEMORY_CONTEXT_DATA", authorityBoundary, repository, retrieval, freshness }
```

Failure modes are explicit and never silent:

| State | Meaning |
|---|---|
| `AVAILABLE` | store opened, query valid, `retrieval.selectedRecords` may be empty |
| `EMPTY_MEMORY` | no store on this machine — a valid answer, not an error |
| `INVALID` | corrupt / irreconcilable store — fail closed |
| `UNAVAILABLE` | no checkout, or the memory module failed to import — reason included |

`EMPTY_MEMORY` vs `AVAILABLE with 0 selected` is a meaningful distinction: the
first means "nothing has ever been written here", the second means "records exist
but none are eligible for this query". Both are reported with
`excludedSummary` so the caller can see *why* nothing was selected.

---

## 3. Observed usage — the entire corpus

### 3.1 Count (executed, precise parse over every `*.jsonl` transcript)

```
toolCall count: 1
  --private-tmp-aegis-work--/2026-10-18T13-56-36-732Z_01a14f4c-d0fc-70f5-94c7-c45a471a18f3.jsonl
  timestamp 2026-10-18T13:56:40.172Z
```

Corpus: 1,741 `*.jsonl` transcript files under `~/.omp/agent/sessions` (16
session directories, several with nested sub-agent transcripts).

This confirms and sharpens the prior audits' "1 call": it is exactly one
`toolCall` record, not one file mentioning the name.

### 3.2 That call, in full

**The model's own reasoning** (verbatim from the transcript):

> The user asks about "nightly gc boundary recorded for CBM retention". This is
> repo-specific knowledge. Should use cbm_query.

**Arguments:** `{ "terms": "nightly gc boundary retention" }`

**Result header:** `1 codebase-memory record(s).`

**Selected record:**

```
recordId  3730d7737ae3dc1a036df79dad5958ba1c5cf2108390e437963f9841c794481b
type      CODE
trust     VERIFIED
scope     path docs/operations.md, symbol cbmRetentionQuota
text      cbmRetentionQuota=4096 records/repository; gcBoundary=03:17 local;
          eviction order: lowest trust rank first.
```

**Repository context reported by the tool:**

```
repositoryIdentity  677b045d965930d3f24b067bc0236b35ea92110e6acbf74a81dd2eb2b632cdcd
canonicalPath       /tmp/aegis-work
branch              feat/omp-cbm-recovery
commit              97d627d3…
indexedTrees        ["8f2aa4dd…"]      stale: false
```

### 3.3 What that call proves — and does not prove

| Claim | Grade |
|---|---|
| An OMP agent autonomously chose `cbm_query` from its description, without being told the tool name | `CONFIRMED` — the thinking block states the decision and the argument |
| Cross-session persistence works | `CONFIRMED` **from the production store, not this call** — `~/.autoloop/memory` holds records written 2026-08-07…08-16 and still readable today (the CLI returned `selected 1` / `selected 8`). The 2026-10-18 call read a **separate, freshly seeded** store whose record's `created_at` is a fixed constant, so that call is not evidence of cross-session age |
| Repository isolation is effective | `CONFIRMED` — identity `677b045d…` differs from this checkout's `e3cc9b97…`; the tool still answered because the store it read declared that identity |
| The record reflects the real source tree | **NO.** `cbmRetentionQuota` does not exist in `docs/operations.md` (grep → no match), and the same sentence appears in `/tmp/aegis-recovery/seed2.mjs`, a fixture-seeding script. The record was **seeded for the acceptance test**, not derived from the code | 
| CBM helped solve a real task | `UNPROVEN` — the question itself came from the fixture |
| The store the tool reads is the production store | **NO.** The record exists only in `/tmp/aegis-recovery/auto-store` (`grep -rl 3730d773…` → that store's `memory.db` + `journal.jsonl`), so the session read that store (or a byte copy of it) via `AEGISFLOW_MEMORY_STATE_ROOT`, not `~/.autoloop/memory` |

This is not a defect in the tool: the call was made during the acceptance run
recorded in `AEGISFLOW_CANONICAL_PUBLICATION_AND_CBM_IDENTITY_REPAIR_1/R06-live-agent.txt`,
whose whole purpose was to prove reachability with a controlled record. The audit
records it so that later claims do not treat the single call as evidence of
production benefit.

### 3.4 The production store, queried by this audit (read-only)

```
$ node scripts/autoloop-memory-query.mjs --repo "$PWD" --max-records 20 --json
state      AVAILABLE
selected   1
excluded   { repository: 0, worktree: 0, scope: 0, trust: 2, validity: 5,
             security: 0, conflict: 0, boundary: 0, totalCandidates: 8 }
freshness  indexedTrees ["8bc33e49…"], currentTree "0456b6a6…", stale: true

$ … --trust-floor RAW --validity ALL
selected   8     excluded all 0
```

So the production store answers, and its 8 records are reachable when the caller
asks for historical material. At the default (`trustFloor: VERIFIED`,
`validityPolicy: CURRENT`) exactly **one** record survives: the
`cbm-live-integration-1` EXECUTION closeout. The other 7 are excluded by trust
(2) and tree validity (5).

### 3.5 What the 8 records contain

| Type | Count | Content |
|---|---:|---|
| CODE | 5 | "path `<file>` modified and verified in graph cbm-live-integration-1", for the five files that card touched |
| EXECUTION | 3 | graph closeouts: `cbm4-self-closeout-20260807` (PASS), `de1-self-closeout-20260808` (PASS), `cbm-live-integration-1` (REVIEW_PENDING at write time) |

All 8 are **records about AegisFlow's own cards**. None records a fact about how
the code works, and none is bound to a current tree. This is the measured
substance behind "the store is frozen at 8 records".

### 3.6 Harness CLI usage

The CLI is an **entry point**, not a library: nothing imports it, and no
`package.json` script names it. Searching the tree for its name returns only:

- its own header and usage strings (`scripts/autoloop-memory-query.mjs:2`, `:33`, `:70`);
- one comment in `test/omp-integration/test-omp-cbm-query.mjs:7` that names it
  as the harness CLI the extension replaced.

There is **no** `src/`, `scripts/` or `test/` module that invokes it, and no npm
script for it; operators and audits call it by path.


---

## 4. Can the agent *discover* CBM?

| Discovery channel | State |
|---|---|
| Tool listing | yes — `loadMode: "essential"` puts `cbm_query` in the default tool set |
| Description quality | explicit about when to call and when not to ("Do not call it for tasks that do not need prior knowledge") |
| One-shot governed path | **no** — `--no-extensions` removes all extension modules, so `cbm_query` is absent there (prior audit, `ROOT_CAUSE_CANDIDATES.md` §E) |
| Interactive governed path | yes — `--tools` restricts built-ins only; extension tools are force-included |
| `--tools cbm_query` | **rejected** by OMP's validator (`Unknown tool in --tools`), so the tool cannot be explicitly allowlisted — it is either auto-included or absent |

That asymmetry is an OMP launcher property, not a CBM property, and the prior
audit already assigned it to the Pilot. It is restated here only because it
bounds what "CBM is available to the agent" can mean.

---

## 5. Is CBM helping code location?

**No.** Not because it failed, but because it has no locator:

- A `cbm_query` for a symbol returns records whose `scope.symbol` *happens to
  match* a declared symbol string. It does not resolve a symbol to a definition.
- There is no file index, no AST, no reference graph (§1.3 of the inventory doc).
- The single observed call asked a knowledge question ("what was the retention
  boundary?"), which is exactly the shape this store serves.

For "find where X is defined / who calls it", the working tools remain `grep`,
`find`, `read`, and — if separately adopted — a code-index MCP. That is a
capability statement, not a criticism of CBM's design.

---

## 6. Does the persisted knowledge cross sessions?

Yes, mechanically — and this is `CONFIRMED` from the **production** store, not from
the single agent call:

- The store on disk is the only source of truth; nothing is held in the process.
- `~/.autoloop/memory` contains records written 2026-08-07 … 2026-08-16 and they
  are readable today: the CLI returned `selected 1` (default policy) and
  `selected 8` (`RAW`/`ALL`) in this audit session on 2026-10-19.
- The CLI and the extension open the same root (`AEGISFLOW_MEMORY_STATE_ROOT`,
  default `~/.autoloop/memory`).
- The graph provider would open the same root if a caller constructed it.

**Correction to a tempting reading of §3.2.** The 2026-10-18 agent call read a
record whose `created_at` is `2026-08-07T00:00:00.000Z`, which looks like a
70-day-old fact. It is not: `/tmp/aegis-recovery/seed2.mjs` and that store were
both written at 2026-10-18 21:55 local (13:55:13Z), about **87 seconds before** the
call at 13:56:40Z, and the timestamp is a constant supplied by the test helper. So the call demonstrates
reachability, not age. Cross-session persistence is proven by the production store
instead.

So "persistent across sessions" is `CONFIRMED`; "used across sessions by an agent"
is `1 call` — `CONFIRMED` as a fact, `UNPROVEN` as a benefit.

---

## 7. Summary table

| Required question (card §6) | Answer | Grade |
|---|---|---|
| Does the original CBM have real index data? | The *original* (there is none) — no. AegisFlow's store has 8 records | `CONFIRMED` |
| Is the original CBM registered in the current OMP environment? | No upstream exists; `cbm_query` (local) is registered as an extension | `CONFIRMED` |
| Can the agent discover the original CBM's tools? | No upstream; the local tool is essential-mode visible | `CONFIRMED` |
| Are CBM and `cbm_query` different data flows? | No — same store, same engine, one adapter | `CONFIRMED` |
| Can CBM actually help locate code? | No — no parser, no symbol resolution | `CONFIRMED` |
| Can CBM's persisted data be used across sessions? | Yes, mechanically; observed once | `CONFIRMED` |
