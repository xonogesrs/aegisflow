# CBM — minimal repair candidates

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT — **proposals only. Nothing here is authorised or implemented.**

---

## 0. The framing correction that precedes every option

The card assumed CBM was a third-party integration with missing wiring. It is not:
it is first-party, and the engine is complete. What is missing is **use**, not
**connection**.

That changes what "repair" can mean. There is no broken registration to fix, no
version drift to reconcile, no fork to re-sync. The honest options are about
*whether and how to put the existing engine to work*, and they must be ranked by
cost and reversibility, not by "how much CBM is missing".

Two capabilities are genuinely absent and cannot be repaired by wiring:

- a source parser (→ index, symbols, call graph, impact analysis, semantic search)
- any automatic ingestion of facts

Neither is a defect; both were excluded by the CBM-1 design decision.

---

## 1. Option ranking (card §8's prescribed order)

| # | Option | Mutates | Cost | Reversible | Addresses |
|---|---|---|---|---|---|
| R0 | Do nothing; record the capability boundary | docs only | none | n/a | correct expectations |
| R1 | Fix a **documentation** claim (there is no broken registration) | docs only | trivial | yes | "CBM indexes code" misreading |
| R2 | Restore normal use of the existing engine: produce one real record through the existing gate | data | low | yes (append-only) | the 8-record empty-corpus problem |
| R3 | Repair the AegisFlow integration layer: make the graph provider reachable | source | medium | yes | retrieval never invoked in a graph run |
| R4 | Use OMP's documented extension API for a richer tool | source | medium | yes | tool ergonomics only |
| R5 | Adopt a separate code-index MCP (DeusData or CodeGraph) **alongside** CBM | config + external binary | high | yes | source navigation, which CBM never had |
| R6 | Replace CBM with a code index | source deletion | very high | no | nothing CBM does |

R5/R6 are explicitly **out of scope** for this card and are listed only so the
ordering is complete.

---

## 2. R0 — Record the boundary (recommended as the immediate action)

**Proposal.** Add one short section to `docs/agent-integration.md` (near the
`cbm_query` paragraph) and to `integrations/omp/README.md` stating, in one
sentence each:

- AegisFlow CBM is a governed **record** store. It does not parse source, index
  files, or resolve symbols.
- `cbm_query` answers "what did we already record about this?", not "where is X
  defined?".
- For code navigation, the working tools are `grep` / `find` / `read` (or a
  separately adopted code-index MCP).

**Why first.** Every other option depends on someone deciding what CBM is for. This
one costs a paragraph, prevents the next audit from re-deriving the same finding,
and is the only change that cannot make anything worse.

**Not applied** — read-only card.

---

## 3. R1 — Correct the one misleading phrase, if any

The audit found the published docs are already careful: `integrations/omp/README.md`
and `docs/agent-integration.md` describe `cbm_query` as "one read-only tool over
AegisFlow's CBM store (`src/memory/`, CBM-2/CBM-3)" and never claim source
indexing.

The only wording worth reviewing is the **name** "Codebase Memory" itself, which
invites the code-index reading. Options, in ascending cost:

1. Keep the name, add the clarifying sentence from R0 (recommended).
2. Rename the user-facing label to "AegisFlow memory" or "governed memory", keeping
   CBM-2/3/4 as internal stage identifiers (touches the tool `label`, docs, and
   record schema names — a real migration for little gain).
3. Do both later.

**Verdict:** option 1. Option 2 is not worth its blast radius on `autoloop.memory-*`
schema strings and stored `schema_version` values.

---

## 4. R2 — Give the store something real to remember

**Problem measured.** The live store holds 8 records, all written by the CBM cards'
own closeouts, all bound to tree `8bc33e49…`, none bound to the current tree. At
the default query settings exactly 1 of 8 is eligible. This is why every claim of
CBM value is `UNPROVEN`: there is no corpus of facts to retrieve.

**Proposal (not authorised).** Populate the store through the path that already
exists, under an explicit authority decision:

```
admission.memory_policy.writeback_allowed = true     ← currently false on every profile
writeback.store = <LocalMemoryStore>                 ← currently never supplied
```

Then let one real governed run produce `EXECUTION` + `CODE` records through
`runWritebackGate` (evidence-bound, journal-first, `CONFIRMED` still
Controller-only).

**Why this is the highest-value option.** It does not change the engine, the
schema, the ranking, or the tool. It exercises three mechanisms that are proven
individually but never together in production, and it creates the first corpus that
could support a benefit measurement.

**Risks, stated plainly.**

| Risk | Mitigation available today |
|---|---|
| An admission profile change is an authority widening | Use a single explicit profile, not a default; keep `FAST_PATH` at false |
| Records could be re-derived from a tree that then changes | Tree-bound validity already marks them stale, not current |
| Write-back could fail mid-run | It runs **post-final** and cannot change the graph outcome (`colima-graph-runner.mjs:874-886` comment + code) |
| Journal growth | 8 events / 17 KB today; negligible |

**Precondition.** A decision on *what* is worth remembering. Writing more
closeout records would reproduce the same empty corpus with a larger count.

---

## 5. R3 — Make the graph retrieval path callable

**Problem measured.** `runColimaGraph` retrieves memory only when
`isRetrievalAuthorized(admission)` **and** a caller supplied `memory.provider`.
`createGraphMemoryProvider` has **no** `src/`, `scripts/` or `examples/` caller at
`f731015` (tests only). `251d9ae` added the construction site, but that commit is
not an ancestor of the audited baseline.

**Proposal (not authorised).** Re-land the one-site construction in
`runAdmittedGraph`, exactly as `251d9ae`'s card described:

```js
if (!forward.memory && isRetrievalAuthorized(admission)) {
  const { createGraphMemoryProvider } = await import("../memory/graph-context.mjs");
  forward = { ...forward, memory: { provider: createGraphMemoryProvider({}) } };
}
```

**Why it is ranked below R2.** Wiring a provider to a store with 8 self-referential
records produces `EMPTY_MEMORY` or one stale closeout record on every run. It makes
the mechanism reachable without making it useful. Do R2 first, or do R2 and R3 in
one card with a benefit measurement attached.

**Note on the prior branch.** `feat/omp-cbm-recovery` (`1cf1e9f` = `origin/main`)
already carries the `repository-aliases` repair and the `cbm_query` tool. Whether
`251d9ae`'s provider block should also return is a **lineage decision** for the
Controller, not something this audit can settle: the block was lost in the
`b207e20` reconstruction, and the reconstruction is the current canonical history.

---

## 6. R4 — Tool ergonomics (low value, low risk)

Candidate improvements to `cbm_query`, all within the documented extension API:

| Candidate | Value | Risk |
|---|---|---|
| Return `excludedSummary` prominently when `selected === 0` | the agent can tell "no records" from "records filtered out" | none (already in the payload, only presentation) |
| Suggest `validityPolicy: INCLUDE_STALE` automatically when `freshness.stale === true` | measured: the one real agent session did exactly this unaided | low — changes a default only in the stale case |
| Accept `maxBytes` | parity with the CLI | none |
| Add a `lineage` echo to the header line | operator can see why a record was reachable | none |

None of these addresses a capability gap. They are listed because the card asks
for "official extension API" options; all of them **are** that, and none requires
touching OMP.

**Explicitly rejected:** adding a write tool, adding a second store, adding a
router that picks between CBM and OMP memory, or injecting memory into the prompt
automatically. Each contradicts a documented boundary and was already declined by
prior cards.

---

## 7. R5 — Add a code index alongside CBM (out of scope, recorded for ordering)

If source navigation is wanted, the honest shape is a **separate MCP server** — not
a modification of CBM:

| Candidate | Would give | Would cost |
|---|---|---|
| `DeusData/codebase-memory-mcp` v0.12.1 | index, call graph, impact, Cypher, cross-repo, UI | ~50 MB binary, a daemon, its own cache under `~/.cache`, 17 new tools, MIT (no patent grant) |
| `@colbymchenry/codegraph` 0.9.6 | index, callers/callees, impact, trace | already installed, `.codegraph/` per project, 10 new tools, MIT |

Both would run **beside** CBM, not instead of it: neither can store evidence-bound,
trust-ranked, conflict-surfaced facts, and CBM cannot parse code.

**Prerequisites before adopting either (none of which this card can authorise):**

1. An OMP-side MCP registration decision (the only `mcp.json` today has one server).
2. A decision on whether indexed source may leave the working tree in graph form
   (DeusData can write `.codebase-memory/graph.db.zst` into the repo).
3. A cache-location decision consistent with `src/shared/autoloop-paths.mjs`
   (AegisFlow's roots are env-configurable; these tools default to `~/.cache`).
4. A license-notice row, in the style already used for Temporal and Restate.

**Do not do this to "restore CBM's value".** It restores a capability CBM was never
designed to have. It is a separate product decision.

---

## 8. Summary of the recommendation

| Priority | Option | Justification |
|---|---|---|
| **1** | **R0 + R1(option 1)** — document the boundary | zero risk, prevents the recurring misreading, satisfies the card's "no unnecessary reinvention" directive |
| **2** | **R2** — populate through the existing gate, under an explicit authority decision | the only option that can turn `UNPROVEN` into measurable |
| **3** | **R3** — re-land the one-site provider construction, **only together with R2** | wiring a useful store is worthwhile; wiring an empty one is not |
| 4 | R4 — small tool improvements | optional, after R2 gives the tool something to return |
| — | R5 / R6 | separate card, separate authority |

**Nothing in this document authorises source changes, profile changes, MCP
registration, data writes, or an upgrade.** Every item is a candidate for a future
card, and each names its own prerequisite.
