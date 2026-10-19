# CODEBASE_INDEX_ACCEPTANCE

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Scope:** first repository indexed = AegisFlow only. AuraCore and DAC were **not** indexed.

## 1. Index targets

| Project (CBM name) | Root | Git ref | Tracked files | Notes |
|---|---|---|---|---|
| `Volumes-NVM2T-Development-repos-autoloop` | `/Volumes/NVM2T/Development/repos/autoloop` | `audit/omp-native-capability-dispatch-1` @ `8bb72a5` | 642 | canonical worktree, primary acceptance target |
| `private-tmp-aegis-work` | `/private/tmp/aegis-work` | `feat/omp-cbm-recovery` @ `d926bbc3` | same tree | the landing worktree this card edits |

Both are the **same repository**, two worktrees. Indexing both was necessary because the card's
acceptance query (`retrieveMemory` and its callers) exists in both, and an OMP session launched in
`/private/tmp/aegis-work` (where this card's evidence is committed) must resolve its own project.
No third repository was indexed; `list_projects` returns exactly these two.

## 2. Scope enforcement

| Requirement | Result |
|---|---|
| `.git` excluded | yes — reported under `excluded.dirs` |
| `node_modules` excluded | yes — reported as `not_indexed_files` with `reason: "symlink"` (the tracked entry is a symlink to itself) |
| build artifacts / caches | no such directories present in the worktree; `.gitignore` (`dist/`, `build/`, `coverage/`, `*.tgz`) honored by CBM's gitignore layer |
| vendored third-party tree | `pi-extensions/search-scope-governor/vendor` excluded by CBM's built-in skip list |
| secrets / `.env` | `.env` **not indexed**: `get_file_outline(file_path=".env")` returns `total: 0`; `check_index_coverage` reports `.env` as `missing` (no recorded issue, not in the graph). `.gitignore` excludes it. |
| evidence store | `/evidence/` is gitignored and absent; nothing indexed from it |
| repository source modified | no — `git status --porcelain` empty in both worktrees after indexing |
| index location | CBM-owned cache root only (`/Volumes/NVM2T/cbm/cache`); no file written inside either worktree |

## 3. Measured result (canonical worktree)

```
project            Volumes-NVM2T-Development-repos-autoloop
excluded.dirs      [".git", "pi-extensions/search-scope-governor/vendor"]   count 2
not_indexed_files  [{"path":"node_modules","reason":"symlink"}]             count 1
skipped_count      0
parse_partial      0
parse_unusable     0
nodes              10481   (expected 10481)
edges              40868   (expected 40868)
status             indexed
```

The worktree copy produced `nodes 10173 / edges 40337` — the difference is the audit documents and
extension changes present only in the landing worktree.

### Graph shape (worktree copy, `get_graph_schema`)

```
node labels (14): Variable 4116, Function 3921, File 608, Module 608, Section 576,
                  Method 133, Folder 73, Class 60, EnvVar 52, Process 13,
                  Route 9, Channel 2, Branch 1, Project 1
edge types (22):  USAGE 12076, CALLS 10110, DEFINES 9414, IMPORTS 5652,
                  CONTAINS_FILE 608, MENTIONS 460, REFERENCES_FILE 429,
                  WRITES 362, SIMILAR_TO 318, RAISES 262, SPAWNS 200,
                  DEFINES_METHOD 133, CONFIGURES 104, CONTAINS_FOLDER 68,
                  FILE_CHANGES_WITH 50, THROWS 33, CALL_REFERENCE 20,
                  SEMANTICALLY_RELATED 19, HTTP_CALLS 9, TESTS 7, EMITS 2, HAS_BRANCH 1
```

Index mode `full`: all relationships plus semantic edges. Only these 22 edge types are queryable —
this card makes no claim about any relationship kind outside this list.

## 4. Time and disk

| Measure | Value |
|---|---|
| Cold index, canonical worktree (10.1 MB tracked / 642 files) | `real 3.02s` (`user 8.70s`, `sys 0.73s`) |
| Cold index, landing worktree | ~3 s (same call shape) |
| Warm re-index, canonical worktree | `real 0.93s` (`user 0.60s`, `sys 0.17s`) |
| DB, canonical worktree | 49,348,608 B (47.1 MiB) |
| DB, landing worktree | 42,401,792 B (40.4 MiB) |
| `_config.db` + `activity.db` + logs | 24,576 + 102,400 + 15,303 B |
| Total cache root | 89,776 KiB ≈ 87.7 MiB |
| Disk headroom on that volume | 169 GiB free (932 GiB total) |

Index size is ~8.7× the tracked source bytes; that ratio is the realistic planning number, not a
claim about other repositories.

Optional persistence of the graph *inside* a repository (`.codebase-memory/graph.db.zst`) was left at
its default `false`, so nothing large can land in AegisFlow's tree.

## 5. What indexing did not do

- It did not read the EKM store (`~/.autoloop/memory/`) — CBM has no knowledge of that path.
- It did not modify either worktree, its HEAD, its index, or its configuration.
- It did not create a `.cbmignore` in the repository. Exclusion relied on `.gitignore` plus CBM's
  built-in skip and suffix lists, both verified by the response's `excluded`/`not_indexed_files`
  fields.
- It did not enable the background watcher or auto-index, so the index will not silently refresh.
  Current behaviour: the index reflects the tree as of `2026-10-19T11:08Z`. Refresh on demand with
  `index_repository`, or re-enable the watcher deliberately (see `PLUGGABILITY_AND_ROLLBACK.md`).
