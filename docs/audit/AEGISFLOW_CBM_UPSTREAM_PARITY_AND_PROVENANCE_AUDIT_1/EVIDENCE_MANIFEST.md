# Evidence manifest

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Baseline:** `f731015` = `HEAD` = `origin/audit/omp-native-capability-dispatch-1`
**Mode:** READ-ONLY. No production store, config, agent state or external artefact
was modified. Every store read was either a direct read-only query or a byte copy
under `/tmp`.

---

## 1. Committed deliverables

| File | Purpose |
|---|---|
| `CBM_PROVENANCE_AND_HISTORY.md` | where CBM came from; why there is no upstream; negative evidence; history-reconstruction gap |
| `CBM_UPSTREAM_CAPABILITY_INVENTORY.md` | installed CBM-2/3/4 capability inventory + both named reference projects at named versions |
| `CBM_UPSTREAM_PARITY_MATRIX.md` | 21-row matrix, dual classification (`LOCAL_STATE` + `VS_REFERENCE`), evidence per row |
| `AEGISFLOW_MEMORY_VS_CBM_ARCHITECTURE.md` | the one-system finding, read paths, write gates, identity/lineage, OMP boundary |
| `CBM_OMP_INTEGRATION_AND_USAGE.md` | surface inventory, data flow, the complete usage corpus, what the single call does and does not prove |
| `THIRD_PARTY_LICENSE_INVENTORY.md` | first-party position, dependency counts, candidate obligations, three-way disposition |
| `CBM_MINIMAL_REPAIR_CANDIDATES.md` | R0–R6, ranked, with prerequisites and risks; nothing implemented |
| `AUDIT_VERDICT.md` | verdict, gate results, direct answers to §1's eight questions |
| `EVIDENCE_MANIFEST.md` | this file |

File hashes at write time (sha256 over the content written by this card):

```
a620b3ca0cfd9afd655fc44b305fc4da2388096118fc655c604653c20e6c51fa  AEGISFLOW_MEMORY_VS_CBM_ARCHITECTURE.md
de23e50b3d25a73391bd6cbdd9d8617e1b23e81fa21d8bc07e9df196dfedb51a  AUDIT_VERDICT.md
e3838cdfdee58ec4decc33c0500dabc221ec70dc95e74a4eb72bc50b76fb28f8  CBM_MINIMAL_REPAIR_CANDIDATES.md
10528e0f7079b182f9d4342cc3ff0438165f8f7037d32a50de0e2336a7d95db9  CBM_OMP_INTEGRATION_AND_USAGE.md
3f1719affa8a8e5ec667e1aa8356429f6ef0bac581c4627f8ac899b3b43ebc1f  CBM_PROVENANCE_AND_HISTORY.md
1e83d69a62c6d0fb7cdc0f376e82e61e74ebb4d4e88fc00360e82e159e99eb5b  CBM_UPSTREAM_CAPABILITY_INVENTORY.md
9bb39136bac4fb4eaf4d692c241dd6b0ca009c5efc5e4f336eec77392c90cc62  CBM_UPSTREAM_PARITY_MATRIX.md
55bec86318786b1fdb98a7479d88cc35294d92b5fad7a9aaa101bb300874d51f  THIRD_PARTY_LICENSE_INVENTORY.md
```

This manifest's own hash is omitted (not fixed-point stable).

---

## 2. Durable landing gate (executed, card §0)

Working directory: `/Volumes/NVM2T/Development/repos/autoloop`

| Command | Output |
|---|---|
| `git status --short` | *(empty)* |
| `git log -1 --format='%H %s'` | `f731015f1654499f383042a8f5249d3bd546bf18 docs(audit): record self-evolution effectiveness audit` |
| `git branch --show-current` | `audit/omp-native-capability-dispatch-1` |
| `git remote -v` | `origin git@github.com:xonogesrs/aegisflow.git (fetch)` / `(push)` |
| `git ls-remote origin refs/heads/audit/omp-native-capability-dispatch-1 refs/heads/main` | `f731015f…\trefs/heads/audit/omp-native-capability-dispatch-1`<br>`1cf1e9fa…\trefs/heads/main` |
| `git merge-base --is-ancestor f731015 HEAD` | true |
| `git worktree list --porcelain` | `repos/autoloop` @ `f731015` (this branch); `/private/tmp/aegis-work` @ `1cf1e9f` on `feat/omp-cbm-recovery` |
| `git status --porcelain` (second worktree) | *(empty)* |
| `git stash list` | *(empty)* |
| `git tag` | *(none)* |

`origin/main` was **not** assumed to contain the audit branch; it is `1cf1e9f`,
three commits behind the audit tip.

---

## 3. Provenance evidence

### 3.1 Positive

| Claim | Command / source |
|---|---|
| CBM = Codebase Memory, defined by `AUTOLOOP-PI-GRAPH-CBM2-1` | `docs/pi-graph-output/cbm2/card-closeout-bundle-20260806-f484fae1.txt` §5 Objective (archived at `evidence/autoloop/publication-archive-2026-09-24/pi-graph-output/cbm2/`) |
| First appearance of `src/memory/` in Git | `git log --reverse --format='%h %ad %s' --date=short -- src/memory` → `b207e20 2026-08-14` |
| Root commit has no memory module | `git ls-tree -r --name-only 5f263cf \| grep -c src/memory` → `0` |
| CBM-1 research exists and predates the code | `~/Desktop/AutoLoop-Review/governance/codebase-memory/cbm-1-existing-landscape-and-contract-boundaries.md` (31,395 B, 2026-08-06) |
| CBM-1 probe result | `…/cbm1-probe-result.json` — 7/7 PASS, `all_pass: true` |
| Write-back architecture chosen over a code index | CBM-1 §10 (candidate comparison, "Not adopted: C … external embedding") |
| `251d9ae` is not on this lineage | `git merge-base --is-ancestor 251d9ae HEAD` → false |

### 3.2 Negative (the important half)

| Probe | Result |
|---|---|
| `git log --all -S"DeusData"` | 0 commits |
| `git log --all -S"colbymchenry"` | 0 commits |
| `git log --all -S"codegraph"` | 0 commits |
| `git log --all -S"codebase-memory"` | 2 commits, both false positives: `16638d6` uses the phrase "codebase-memory" descriptively ("the AegisFlow codebase-memory (CBM) read tool"); `1301bb1` quotes a `cbm_query` tool result ("1 codebase-memory record(s)"). Neither names `DeusData/codebase-memory-mcp` |
| `grep -rn "DeusData\|colbymchenry\|codebase-memory-mcp\|@colbymchenry" .` (excl. `node_modules`, `.git`) | no matches |
| `git submodule status` / `.gitmodules` | none / absent |
| `git ls-files \| grep -iE "codegraph\|codebase-memory\|\.mcpb\|tree-sitter"` | no matches |
| tracked vendor dirs | `pi-extensions/search-scope-governor/vendor/` only — two first-party copies |
| `package.json` deps | `@earendil-works/pi-ai@0.83.0` only; peer `pi-coding-agent` optional |
| `~/.codegraph` | absent (`ls` → No such file or directory) |
| `command -v codebase-memory-mcp` | rc=1 |
| `~/.cache/codebase-memory-mcp` | absent |
| `pip3 show codebase-memory-mcp` | not found |

---

## 4. Local capability evidence

| Claim | Command | Result |
|---|---|---|
| no source parser | `grep -rln "tree-sitter\|ast-grep\|ctags\|language server\|LSP" src scripts` | no matches |
| no call/dependency graph | `grep -rn "call graph\|dependency graph\|impact analysis" src` | no matches |
| CBM size | `wc -l src/memory/*.mjs src/memory/writeback/*.mjs …` | 6,073 lines total |
| store schema | `sqlite3 -readonly <copy> ".schema memory_records"` | 26 columns, 4 record types, `UNIQUE(logical_key, content_hash)` |
| store counts | `sqlite3 -readonly <copy>` | records 8, fts 8, lifecycle 8, evidence 0, conflicts 0, relationships 0 |
| migrations | same | `cbm2-v1` 2026-08-07, `cbm2-v1-pattern-type` 2026-10-18 |
| journal | `wc -l < ~/.autoloop/memory/journal.jsonl` | 8 |
| retrieval (default) | `node scripts/autoloop-memory-query.mjs --repo "$PWD" --json` | `AVAILABLE, selected 1`, excluded `{trust:2, validity:5}`, `stale: true` |
| retrieval (historical) | same, `--trust-floor RAW --validity ALL` | `selected 8`, excluded all 0 |
| contract suite | `node --test test/memory/test-{canonical,jsonl,record-schema,security,sqlite,trust-validity}.mjs` | **93/93 pass** |
| retrieval suite | `node --test test/memory/test-{query-schema,local-store,retrieval,snapshot,rebuild-determinism,retrieval-security,graph-context}.mjs` | **92/92 pass** |
| `cbm_query` contract | `node --test test/omp-integration/test-omp-cbm-query.mjs` | **10/10 pass** |
| OMP integration suite | `node --test test/omp-integration/` | **35/35 pass** |
| deployed drift | `node scripts/install-omp-integration.mjs check` | `MATCH=6 EQUIVALENT=1 DRIFT=0 MISSING=0` |
| no graph provider caller | `grep -rn createGraphMemoryProvider src scripts examples test` | definition + tests only |
| write-back authority | `grep -n memory_writeback_allowed src/admission/policy-projection.mjs` | `false` on all 7 profiles |
| write-back gate site | `sed -n '872-905p' src/runtime/colima-graph-runner.mjs` | post-final, requires store **and** authority |

---

## 5. Usage evidence (agent corpus)

| Claim | Command | Result |
|---|---|---|
| corpus size | `find ~/.omp/agent/sessions -name "*.jsonl" \| wc -l` | 1,741 transcript files (16 session dirs; recursive — 1,222 at depth ≤2, 519 nested deeper) |
| `cbm_query` tool calls | JSON parse of every `*.jsonl`, matching `type == "toolCall"` ∧ `name == "cbm_query"` | **exactly 1** |
| location | same | `--private-tmp-aegis-work--/2026-10-18T13-56-36-732Z_01a14f4c-…jsonl`, 2026-10-18T13:56:40.172Z |
| arguments | same | `{"terms": "nightly gc boundary retention"}` |
| result | same | `1 codebase-memory record(s)`; record `3730d773…`, CODE, VERIFIED, path `docs/operations.md` |
| the record's text is a fixture | `grep -rn cbmRetentionQuota` over repo → no match in `docs/operations.md`; present in `/tmp/aegis-recovery/seed2.mjs` | `CONFIRMED` |
| the store read was the harness store | `grep -rl 3730d773… /tmp` | `/tmp/aegis-recovery/auto-store/{memory.db,journal.jsonl}` |

Cross-check with the prior card's own evidence:
`evidence/autoloop/AEGISFLOW_CANONICAL_PUBLICATION_AND_CBM_IDENTITY_REPAIR_1/R06-live-agent.txt`
§D3 documents this exact isolated-session run and its `8/8 records` / pre-repair `0`
control.

---

## 6. Reference-implementation evidence (not installed)

| Fact | Source |
|---|---|
| DeusData repo, MIT, v0.12.1 (2026-10-16), `main` `d4980ad` (2026-10-19) | GitHub API `/releases/latest`, `/commits/main` |
| 17 MCP tools, 162 languages, SQLite graph, CBM Lens beta, 45 client surfaces | upstream README fetched at audit time |
| CodeGraph 0.9.6, MIT, 10 MCP tools, `.codegraph/` per project | `~/.npm-global/lib/node_modules/@colbymchenry/codegraph/{package.json,README.md}` |
| CodeGraph installed 2026-05-28 (before CBM cards) | package directory mtime |
| CodeGraph not initialised for this repo | `codegraph status` → `Not initialized`; `.codegraph/` absent |

---

## 7. Agent-config evidence (no CBM MCP registration, and none missing)

| Config | Servers |
|---|---|
| `~/.omp/agent/mcp.json` | `kicad` |
| `~/.omp/plugins/package.json` | `omp-computer-use`, `omp-grok-build`, `pi-jev`, `zmarketplace` |
| `~/.claude.json` (top level) | `kicad`, `omp-external-llm` |
| `~/.codex/config.toml` `[mcp_servers]` | `node_repl`, `computer-use`, `glm_review`, `kicad` |
| `~/.config/opencode/opencode.jsonc` | none matching |

---

## 8. Licence evidence

| Claim | Command | Result |
|---|---|---|
| dependency licence distribution | parse `package-lock.json` | 93 packages: Apache-2.0 47, MIT 33, BSD-3-Clause 11, 0BSD 1, ISC 1; unknown 0 |
| no copyleft / non-OSI | same parse, filter GPL/AGPL/SSPL/BSL/BUSL/CC-BY-NC | `[]` |
| first-party Apache-2.0 | `LICENSE`, `package.json`, `NOTICE` | all consistent |
| no third-party header in CBM | `grep -rn "copyright\|license\|SPDX\|adapted from\|based on\|ported from" src/memory integrations/omp/extensions/cbm-query.js scripts/autoloop-memory-query.mjs` | 0 matches |
| CBM has no CBM entry in notices | `grep -i "cbm\|codebase-memory\|codegraph" THIRD_PARTY_NOTICES.md` | no match (correct — nothing to notice) |

---

## 9. Mutation audit

| Resource | Touched? |
|---|---|
| OMP binary / `~/.omp/agent/{config.yml,mcp.json,models.yml}` | no |
| `~/.omp/agent/extensions/**` | no (drift check read-only) |
| `~/.omp/agent/sessions/**` | no (read-only parse) |
| `~/.autoloop/memory/memory.db` | no (read-only sqlite + byte copy to `/tmp/audit-store-copy.db`) |
| `~/.autoloop/memory/journal.jsonl` | no |
| `~/.autoloop/memory/repository-aliases.json` | no |
| `~/.autoloop/{learning,evolution}` | no |
| Jev / Pilot / terminal fence | no |
| Branches / history / worktrees / stashes | no (no checkout, merge, reset, clean, stash) |
| Repository source | no — **only** the nine files in `docs/audit/AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1/` were added |
| Temporary artefacts | `/tmp/audit-store-copy.db` (byte copy, disposable); no file outside the repo was written by the audit |

---

## 10. Reproduction recipe

```sh
cd /Volumes/NVM2T/Development/repos/autoloop

# gate
git status --short && git log -1 --format='%H %s'
git ls-remote origin refs/heads/audit/omp-native-capability-dispatch-1 refs/heads/main

# provenance
git log --all -S"DeusData" --oneline | wc -l          # 0
git log --all -S"colbymchenry" --oneline | wc -l      # 0
git log --reverse --format='%h %ad %s' --date=short -- src/memory

# capability boundary
grep -rln "tree-sitter\|ast-grep\|ctags\|language server\|LSP" src scripts   # empty
grep -rn "call graph\|dependency graph\|impact analysis" src                 # empty

# engine works
node scripts/autoloop-memory-query.mjs --repo "$PWD" --json | head -5
node --test test/memory/test-retrieval.mjs test/memory/test-local-store.mjs

# usage corpus
find ~/.omp/agent/sessions -name "*.jsonl" | wc -l                            # 1741
# (count toolCall records named cbm_query → 1)

# deployment
node scripts/install-omp-integration.mjs check
```

---

## 11. Limits of this evidence

- The pre-rewrite authoring commits (CBM-1…CBM-4, 2026-08-02 → 2026-08-16) are not
  in this repository's object database. Capability claims are therefore grounded in
  the **published code and its tests**, plus the archived card evidence — not in a
  commit range. Stated in `CBM_PROVENANCE_AND_HISTORY.md` §7.
- The single agent call's *benefit* cannot be graded beyond `UNPROVEN`; its
  mechanism and its fixture nature are both `CONFIRMED`.
- Upstream capability tables describe what the candidates' own documentation
  claims; no candidate was installed or executed, so no upstream behaviour was
  independently exercised.
- "No `.codegraph` index for an AegisFlow checkout" is an absence-of-evidence
  finding backed by a status command and a filesystem search; it is not a proof
  about every past session.
