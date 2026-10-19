# Audit verdict

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Type:** READ-ONLY AUDIT · **Priority** P1
**Verdict:** **PASS** — audit complete; no repair authorised, none performed
**Baseline:** `f731015` on `audit/omp-native-capability-dispatch-1`
(**= `origin/main` is `1cf1e9f`, unchanged**)

```
VERDICT                        = PASS
MODE                           = READ_ONLY
OMP_CORE_MUTATION              = NONE
OMP_CONFIG_MUTATION            = NONE
MCP_REGISTRATION_MUTATION      = NONE
CBM_INSTALL_UPGRADE_REMOVE     = NONE
CBM_REINDEX                    = NONE
MEMORY_DB_MUTATION             = NONE
JOURNAL_MUTATION               = NONE
EVOLUTION_LEARNING_ENABLED     = NONE
JEV_PILOT_FENCE_MUTATION       = NONE
HISTORICAL_BRANCH_MERGE        = NONE
SESSION_MUTATION               = NONE
DESTRUCTIVE_GIT_OPERATION      = NONE
SOURCE_MUTATION                = NONE
```

---

## 1. Durable landing gate (card §0)

Executed in `/Volumes/NVM2T/Development/repos/autoloop`:

| Check | Result |
|---|---|
| `git status --short` | **empty** (clean) |
| `git log -1 --format='%H %s'` | `f731015f1654499f383042a8f5249d3bd546bf18 docs(audit): record self-evolution effectiveness audit` |
| `git branch --show-current` | `audit/omp-native-capability-dispatch-1` |
| `git remote -v` | `origin git@github.com:xonogesrs/aegisflow.git` (fetch/push) |
| `git ls-remote origin refs/heads/audit/omp-native-capability-dispatch-1` | `f731015f…` — **matches local HEAD** |
| `git ls-remote origin refs/heads/main` | `1cf1e9fa…` — unchanged |
| prior commit is ancestor of HEAD | `git merge-base --is-ancestor f731015 HEAD` → **true** |
| `git worktree list --porcelain` | 2 worktrees: this one at `f731015`; `/private/tmp/aegis-work` at `1cf1e9f` on `feat/omp-cbm-recovery` |
| second worktree status | clean |
| `git stash list` | **empty** (0 entries) |
| OMP binary/config modified | **no** |
| Evolution store / Memory DB modified | **no** |

Prior card PASS is durably landed. No landing work was required before this audit.

---

## 2. Direct answers to the card's required questions

### 2.1 Which project is "the original CBM"?

**There is no original CBM. CBM is AegisFlow's own subsystem.** `PROVENANCE_UNRESOLVED`
for any third-party ancestry, with positive evidence of absence.

- "CBM" expands to **Codebase Memory**, defined first by card
  `AUTOLOOP-PI-GRAPH-CBM2-1`: "Define the formal AutoLoop Codebase Memory Contract
  v1…"
- The lineage is four first-party cards: CBM-1 (research) → CBM-2 (contract) →
  CBM-3 (store + retrieval) → CBM-4 (write-back), then live-integration, identity
  repair, and the agent tool.
- `git log --all -S"DeusData"` → 0 commits. `-S"colbymchenry"` → 0.
  `-S"codegraph"` → 0. No vendor tree, no submodule, no fork notice, no
  third-party copyright header in 6,073 lines of CBM code.
- CBM-1's own capability map records the only third-party index ever seen
  (`~/.codegraph`, 5.9 GB) as "home-level … stale … **NOT part of Repo A / not
  trusted by AutoLoop**". That directory no longer exists.

The card's two named candidates are both **not integrated**:
`DeusData/codebase-memory-mcp` is not installed anywhere on this machine;
`@colbymchenry/codegraph@0.9.6` is installed (2026-05-28, before the CBM cards) but
has no index for this repo (`codegraph status` → `Not initialized`) and appears in
no AegisFlow file or agent config.

### 2.2 How much of the original functionality do we actually use?

**100% of AegisFlow's own design is implemented; 0% of any third-party
code-intelligence capability is present.**

Implemented and working: contract, SQLite store, JSONL journal with hash chain,
deterministic retrieval with digest, trust ladder, validity/stale/tombstone/conflict
semantics, lineage registry, governed write-back gate, harness CLI, OMP tool.
Executed this audit: `state: AVAILABLE, selected: 1 / 8` at the default floor,
`selected: 8` at `RAW`/`ALL`; contract and retrieval suites green (93/93 and 92/92);
`cbm_query` contract 10/10; OMP integration 35/35; installer drift `MATCH=6
EQUIVALENT=1 DRIFT=0`.

### 2.3 Which original capabilities have failed or are unwired?

None have *failed*. Two are **unwired by design or by history**:

| Item | State | Why |
|---|---|---|
| Graph retrieval provider | present, **no production caller** at `f731015` | `createGraphMemoryProvider` is constructed only in tests; `251d9ae`'s construction site is not an ancestor of HEAD |
| Write-back | mechanism complete, **authority denied everywhere** | `memory_writeback_allowed: false` on every profile; 0 writes since 2026-08-16 |

And two are **absent by design**, not regressions:

| Item | Why absent |
|---|---|
| Source indexing / symbols / call graph / impact / semantic search | CBM-1 explicitly chose a record store over a parser; no tree-sitter/ctags/LSP anywhere in `src/` |
| Automatic ingestion | CBM-4 keeps automatic write-back out of scope; `explicitImport` is the only write path |

### 2.4 Which first-party features duplicate the original?

The question inverts: **the first-party features ARE the original.** What duplication
exists is conceptual, with OMP's native memory tools
(`memory_retain`/`recall`/`reflect`/`edit`, `learn`), which share the word "memory"
and nothing else:

| | AegisFlow CBM | OMP native memory |
|---|---|---|
| store | `~/.autoloop/memory` | agent-owned |
| scope | repository identity + tree | session/workspace |
| trust | five-level, evidence-bound | none documented |
| determinism | frozen ranking + digest | not claimed |
| observed use | 1 tool call ever | 0 calls across 1,741 transcripts |

Different stores, different authority models, no conflict. The prior audit reached
the same conclusion; this audit found no reason to revise it.

### 2.5 Does CBM's persistent knowledge capability actually exist and work?

**Exists: yes. Works: yes. Does anything useful with it: no.**

- Persistence: SQLite + journal, journal-first durability, `rebuildFromJournal`,
  `verifyJournalParity`, forward-only migrations, 2 migration rows, 0 FK violations.
- Cross-session: the production store holds records written 2026-08-07 … 08-16 and
  they are readable on 2026-10-19 (`selected 1` default / `selected 8` at
  `RAW`/`ALL`). `CONFIRMED`. (The single agent call is **not** evidence of age: the
  fixture store behind it was seeded on 2026-10-18 with a constant
  `created_at`.)
- Corpus quality: **8 records, all about CBM's own cards**, all bound to tree
  `8bc33e49…`, none bound to the current tree. At the default query policy exactly
  one is eligible; at `RAW`/`ALL` all 8.
- Benefit: `UNPROVEN`. The single agent call answered a question whose answer had
  been seeded as a fixture (`cbmRetentionQuota` does not exist in
  `docs/operations.md`; the sentence is in `/tmp/aegis-recovery/seed2.mjs`).

### 2.6 Which problems need only a setting or an adapter?

| Problem | Fix class | Authorised here? |
|---|---|---|
| CBM described as a code index | **documentation** | no (proposed as R0) |
| Graph retrieval unreachable | **one construction site** (adapter-layer) | no (R3) |
| Write-back never runs | **one admission flag + one store argument** | no (R2) |
| Store has nothing worth retrieving | **data decision**, not code | no (R2) |
| `cbm_query` ergonomics when 0 selected | **adapter presentation** | no (R4) |
| Any "restore upstream parity" | **not applicable** — no upstream | n/a |

### 2.7 Is there any reason to modify OMP itself?

**No.**

- The tool uses `pi.registerTool` with `loadMode: "essential"` and
  `approval: "read"` — documented API.
- MCP registration is not needed and none is missing: `~/.omp/agent/mcp.json` has
  exactly one server (`kicad`), and no AegisFlow code writes MCP config.
- The installer's `KNOWN_FILES` allowlist is 7 local paths, no network, no config
  mutation.
- The only capability asymmetry (one-shot `--no-extensions` hides extension tools)
  is an OMP launcher property already assigned to the Pilot by a prior card; it is
  not a reason to patch OMP.

Adding a code index later would also be an **MCP server alongside OMP**, not a
modification of it.

---

## 3. The central finding, stated once

> AegisFlow built a governed, deterministic, evidence-bound **knowledge ledger** and
> named it "Codebase Memory". It never built a code index, and it never integrated
> one. The ledger works; it has almost nothing in it; and it has been consulted
> exactly once in 1,741 transcripts.

Every apparent "gap" follows from that sentence. None of them is a bug.

---

## 4. What this verdict is not

- **Not** authorisation to enable write-back, retrieval wiring, or any profile change.
- **Not** a recommendation to adopt, install, or remove DeusData CBM or CodeGraph.
- **Not** a claim that CBM is useless — it is a claim that its *value is unmeasured*
  because its corpus is empty.
- **Not** a licence opinion; the inventory records facts and open questions only.
- **Not** a statement that OMP is deficient; no OMP change is indicated.

---

## 5. Gate results

| Card gate | Result |
|---|---|
| §0 durable landing verified | **PASS** |
| §1 provenance traced, no guessing | **PASS** (`PROVENANCE_UNRESOLVED` for third-party, with positive absence evidence) |
| §2/§3 upstream capability inventory at a named version | **PASS** (DeusData v0.12.1 / `main` `d4980ad`; CodeGraph 0.9.6 as installed) |
| §4 three-layer local inventory (original / AegisFlow memory / OMP) | **PASS** (collapsed to one layer by evidence, documented) |
| §5 parity matrix with evidence per row | **PASS** |
| §6 usage and benefit, no duplicate testing | **PASS** (reused prior results; added store/agent/dataflow evidence) |
| §7 licence inventory, three-way disposition | **PASS** |
| §8 minimal repair candidates, no implementation | **PASS** |
| §9 read-only constraints | **PASS** (no mutation performed) |
| §10 nine deliverables | **PASS** |
| §11 landing of audit docs only | **PASS** (see `EVIDENCE_MANIFEST.md`) |

---

## 6. Recommended next action (not this card's authority)

Ordered, per `CBM_MINIMAL_REPAIR_CANDIDATES.md`:

1. **Document the boundary** (R0) — one paragraph in
   `docs/agent-integration.md` and `integrations/omp/README.md`.
2. **Decide what CBM should remember** — a data/authority decision that precedes any
   wiring.
3. Only then consider R2 (populate) and R3 (re-land the provider construction) as a
   single card with a benefit measurement.
4. Keep any code-index adoption in a separate card, as an addition beside CBM.

The unified root-cause and repair-priority decision the operator plans after the
third audit should treat "CBM has no parser" as a **design fact**, not a defect to
be scheduled.
