# CBM provenance and history

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT
**Baseline:** `f731015` on `audit/omp-native-capability-dispatch-1`

---

## 1. Answer in one line

**`PROVENANCE_UNRESOLVED` for any third-party upstream — and positive evidence that
there is none to resolve.** "CBM" in AegisFlow is not an integrated GitHub project.
It is a first-party in-repo subsystem (CBM-1 research → CBM-2 contract → CBM-3
store/retrieval → CBM-4 write-back), authored in this repository between
2026-08-02 and 2026-08-16. The two GitHub projects named as candidates in the card
(`DeusData/codebase-memory-mcp`, `colbymchenry/codegraph`) were never integrated.

This is a stronger result than "unresolved": the audit can show the absence on
both the positive (history, files, tests, authorship) and the negative (no
declaration, no MCP registration, no installation) sides.

---

## 2. What "CBM" means here

Local expansion, from the first artifact that defines it:

> "Define the formal AutoLoop Codebase Memory Contract v1: MemoryRecordV1 envelope,
> CODE/EXECUTION/DECISION record contracts, strict recursive canonical identity, trust
> promotion ladder, validity/stale/invalidated/tombstone/conflict semantics, …"

— `docs/pi-graph-output/cbm2/card-closeout-bundle-20260806-f484fae1.txt`, CARD_ID
`AUTOLOOP-PI-GRAPH-CBM2-1` (archived copy:
`evidence/autoloop/publication-archive-2026-09-24/pi-graph-output/cbm2/`)

So **CBM = Codebase Memory**, an AegisFlow-internal concept with a four-card lineage:

| Stage | Meaning | Artifact |
|---|---|---|
| **CBM-1** | research: existing landscape + contract boundary | `~/Desktop/AutoLoop-Review/governance/codebase-memory/cbm-1-existing-landscape-and-contract-boundaries.md` (31,395 bytes, 2026-08-06; never committed to the repo) |
| **CBM-2** | Memory Contract v1 + SQLite DDL + JSONL journal | `src/memory/{contract,schema,validation,canonical,identity,sqlite-schema,jsonl-journal}.mjs` |
| **CBM-3** | store + deterministic retrieval + graph context | `src/memory/{local-store,retrieval,query-schema,snapshot,graph-context}.mjs` |
| **CBM-4** | governed write-back | `src/memory/writeback/*` |
| CBM-live-integration | harness CLI + provider wiring | `scripts/autoloop-memory-query.mjs`, commit `251d9ae` |
| CBM-identity repair | lineage registry | `src/memory/repository-aliases.mjs`, commit `fb8ce6a` |
| CBM-agent surface | `cbm_query` extension | `integrations/omp/extensions/cbm-query.js`, commit `16638d6` |

---

## 3. History trace (executed, `git log` over the real repository)

### 3.1 First appearance in Git

```
$ git log --reverse --format='%h %ad %s' --date=short -- src/memory
b207e20 2026-08-14 chore: pin reconstructed canonical AutoLoop source baseline
14a0deb 2026-09-15 feat(learning): land governed learning lifecycle, pattern consolidation, and R2 memory/writeback lineage
16638d6 2026-10-18 fix(memory,omp): forward-only schema migration + agent-visible CBM tool
fb8ce6a 2026-10-18 fix(memory,omp): canonical fence reconciliation + declared repository lineage
```

`b207e20` is the **reconstructed canonical baseline** commit: it contains 386 files,
95,850 insertions, and establishes the entire `src/memory/` tree in one commit
(`chore: pin reconstructed canonical AutoLoop source baseline`). Its parent is
`2e897e9`, the pre-existing checkpoint history (`checkpoint: round-5 repair-cap model fix`).

```
$ git rev-list --count 5f263cf     # root commit, "establish standalone autoloop baseline"
$ git ls-tree -r --name-only 5f263cf | grep -c src/memory
0
```

`src/memory/` does not exist in the first 35 commits of the repository. It appears
only at `b207e20`, whose message says its purpose is to **pin reconstructed
canonical source** — i.e. the tree was rebuilt after the CBM work had already been
developed on the pre-rewrite history.

### 3.2 Where the CBM work was actually done

The pre-`b207e20` artifacts were authored inside the *old* checkout
`/Volumes/NVM2T/Development/autoloop` (which no longer exists) and are preserved in
three places, all consistent:

1. `~/Desktop/AutoLoop-Review/governance/codebase-memory/` — CBM-1 research doc,
   probe source (`probe/cbm1-memory-probe.mjs`), probe result
   (`cbm1-probe-result.json`, 7/7 PASS, 2026-08-06).
2. `evidence/autoloop/publication-archive-2026-09-24/pi-graph-output/{cbm2,cbm2r,cbm3,cbm4}/`
   — the review bundles and closeout evidence for each card, archived byte-identically
   when the tree was prepared for publication (`dafe7f7`).
3. `docs/pi-graph-output/cbm-live-integration-1/` at `251d9ae` — the live-integration
   card's own evidence, including `cbm-r1-subagent-query.json`, now archived out of
   the publication tree but recoverable from history.

Card identifiers observed: `AUTOLOOP-PI-GRAPH-CBM1-1` (research),
`AUTOLOOP-PI-GRAPH-CBM2-1` (contract), CBM-2R (repair), CBM-3, CBM-4,
`AUTOLOOP-CBM-LIVE-INTEGRATION-1`.

### 3.3 The CBM-1 landscape document states the upstream position explicitly

The capability map in `cbm-1-existing-landscape-and-contract-boundaries.md` (§2)
records, for every code-intelligence capability the card was testing for:

| Capability | Status in Repo A | Note |
|---|---|---|
| file index | `ABSENT` | home-level `~/.codegraph/codegraph.db` (5.9 GB) is "a **third-party** code-graph index — present at home level, but stale and **NOT part of Repo A / not trusted by AutoLoop**" |
| symbol index | `ABSENT` | "Same `~/.codegraph` caveat" |
| semantic search | `ABSENT` | "No embedding/vector/semantic layer anywhere in Repo A" |
| dependency graph | `PARTIAL` | `package.json` + lockfile only, "no persisted dependency-graph analysis/query layer" |

And §10 compares three *architectures it would build*, not three products it would
integrate:

> A. Pure JSON/JSONL + content hash · B. SQLite relational + FTS5 (`node:sqlite`) ·
> C. Local vector / hybrid — "**Not adopted**: C … requires an external embedding
> model/dependency".

The chosen architecture (B) is described as **"ZERO new external dependency"**. No
third-party component was selected, vendored, or forked at any point in the CBM
lineage.

### 3.4 `~/.codegraph` (the only third-party index ever seen) is gone and was never trusted

```
$ ls -d ~/.codegraph
ls: cannot access '/Users/zhengfengqing/.codegraph': No such file or directory
```

The 5.9 GB `codegraph.db` that CBM-1 observed on 2026-08-06 no longer exists. The CBM-1
document classified it as home-level, stale, and untrusted; it was never a dependency
of AegisFlow, and no AegisFlow code references it.

---

## 4. Negative evidence (searched for, not found)

All of the following were executed at the audit baseline.

| Probe | Result |
|---|---|
| `git log --all -S"DeusData"` | **0 commits** |
| `git log --all -S"colbymchenry"` | **0 commits** |
| `git log --all -S"codegraph"` | **0 commits** |
| `grep -rn "codebase-memory-mcp\|@colbymchenry\|DeusData\|colbymchenry"` over the working tree (excluding `node_modules`/`.git`) | **no matches** |
| `git submodule status` | no submodules |
| `.gitmodules` | absent |
| `git ls-files \| grep -iE "codegraph\|codebase-memory\|\.mcpb\|tree-sitter"` | no matches |
| vendor directories (`vendor/`, `third_party/`, `external/`) tracked | none |
| `package.json` `dependencies` | 1 entry: `@earendil-works/pi-ai@0.83.0` |
| `package.json` `peerDependencies` | 1 entry: `@earendil-works/pi-coding-agent` (optional) |
| `package-lock.json` name matches for CBM candidates | none |
| tracked MCP config in the repo (`.mcp.json` etc.) | none |
| `scripts/install-omp-integration.mjs` fetches anything | no — `KNOWN_FILES` is a 7-entry local allowlist, no network |
| commit authorship | 157 × `zhengfengqing <xonogears@gmail.com>`, 2 × `xonogesrs`, 1 × local — one author, no imported commits |

### 4.1 The two card-named candidates, checked against this machine

| Candidate | Local state | Verdict for AegisFlow |
|---|---|---|
| `DeusData/codebase-memory-mcp` | NOT installed: `command -v codebase-memory-mcp` → rc=1; `~/.cache/codebase-memory-mcp` absent; `pip3 show` → not found; not in global npm | **never integrated** |
| `colbymchenry/codegraph` | installed as `@colbymchenry/codegraph@0.9.6` in `~/.npm-global` (dated 2026-05-28, i.e. **before** the CBM cards); `codegraph status` on this repo → `Not initialized`; no `.codegraph/` directory | **present on the machine, never used by/for AegisFlow** |

`codegraph` is a real, separate, MIT-licensed tool the operator installed months
earlier for other projects. It is not referenced by any AegisFlow file, not
registered in any MCP configuration AegisFlow reads or writes, and has no index for
this repository.

### 4.2 Where a CBM MCP server would have to be registered — and is not

| Config | Servers present | CBM server? |
|---|---|---|
| `~/.omp/agent/mcp.json` (OMP) | `kicad` only | no |
| `~/.omp/plugins/package.json` (OMP plugins) | 4 GitHub/npm plugins (`omp-computer-use`, `omp-grok-build`, `pi-jev`, `zmarketplace`) | no |
| `~/.claude.json` top level | `kicad`, `omp-external-llm` | no |
| `~/.codex/config.toml` `[mcp_servers]` | `node_repl`, `computer-use`, `glm_review`, `kicad` | no |
| `~/.config/opencode/opencode.jsonc` | none matching | no |

There is therefore **no MCP registration to repair** and no "existing MCP
registration" defect: the `cbm_query` surface is an OMP *extension tool*, not an MCP
server.

---

## 5. What `cbm_query` actually is

`integrations/omp/extensions/cbm-query.js` (357 lines) declares one tool and imports
the repository's own memory module:

```js
const mod = await import(join(resolved.root, "src", "memory", "index.mjs"));
// uses mod.LocalMemoryStore, mod.resolveRepositoryIdentity, mod.resolveMemoryQueryV1, …
pi.registerTool({ name: "cbm_query", … });
```

Its header states the design intent in its own words: "ONE read-only tool,
`cbm_query`, that delegates to the SAME retrieval engine the harness CLI uses
(`LocalMemoryStore.query → retrieval.mjs`). There is no second store, no second
ranking path and no write capability."

So the tool is an **adapter onto the in-repo CBM-3 engine**. It is not a client of
an external indexer, and it answers from `~/.autoloop/memory/memory.db` — a SQLite
database populated by AegisFlow's own write-back gate.

---

## 6. Ownership and lineage statement

| Question | Answer | Grade |
|---|---|---|
| Is AegisFlow's CBM a fork of a GitHub project? | No | `CONFIRMED` (no matching history, no vendored code, no license obligation that could apply) |
| Was any fork / vendor copy / re-implementation of a public CBM tool made? | No copy exists. The *concept* of "codebase memory" is generic and appears in the CBM-1 research as prior art (the CBM-1 doc names `~/.codegraph` as a third-party example), but no code, schema, or text was taken from it | `CONFIRMED` for code; `INFERENCE` for conceptual independence |
| Is `cbm_query` equal to GitHub's original CBM? | It is not derived from one. It is AegisFlow's own retrieval engine behind an OMP tool | `CONFIRMED` |
| Is there an unresolved upstream to keep looking for? | No. The provenance question closes as **"first-party subsystem, no third-party upstream"** | `CONFIRMED` |

**`PROVENANCE_UNRESOLVED` applies only in this narrow sense:** the pre-rewrite
`/Volumes/NVM2T/Development/autoloop` checkout and the CBM-1 research document were
never committed to the canonical tree, so the *authoring commits* themselves
(2026-08-02 → 2026-08-06) are not in this repository's object database. The
reconstruction at `b207e20` is what carries the code. That is a **history
reconstruction gap**, not an unknown upstream.

---

## 7. History reconstruction gap (the one open provenance item)

| Item | State |
|---|---|
| Code as published | complete and byte-stable at `f731015` |
| Authoring commits for CBM-1/CBM-2/CBM-3/CBM-4 | not in this repository; lived in the retired `/Volumes/NVM2T/Development/autoloop` checkout |
| Card evidence for those commits | preserved (publication archive + `Desktop/AutoLoop-Review/governance/codebase-memory/`) |
| Consequence for this audit | capability claims can be checked against the *published* code and tests, which is what §3–§5 of the parity matrix does |
| Consequence for a future "was this ever reviewed?" question | must cite the archived bundles, not a commit range — the range does not exist here |

This is recorded so the next card does not re-open "find the upstream repo": there
is no upstream repo, only a retired local checkout.
