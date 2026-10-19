# Audit verdict

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1`
**Type:** READ-ONLY AUDIT · **Priority:** P0
**Verdict:** **PASS** (audit complete; no repair authorised, none performed)

```
VERDICT                        = PASS
MODE                           = READ_ONLY
OMP_CORE_MUTATION              = NONE
OMP_CONFIG_MUTATION            = NONE
SKILLS_MUTATION                = NONE
EXTENSIONS_MUTATION            = NONE
CBM_JEV_PILOT_MCP_MUTATION     = NONE
CACHE_DB_WORKTREE_CLEANUP      = NONE
INSTALL_UPGRADE_REMOVE         = NONE
NEW_ROUTER_ADAPTER_INFRA       = NONE
SESSION_STARTED_BY_AUDIT       = NONE
```

---

## 1. Direct answers to the six required questions

### 1.1 Is OMP's native autonomous skill invocation mechanism working?

**Yes — `CONFIRMED`.**

- Discovery → description → prompt listing → model choice → `skill://` load → execution is intact end to end, on native mechanisms, with no AegisFlow involvement.
- 814 skill loads across 19 distinct skills in 1,735 sessions, with the expected domain concentration and correct abstention behaviour visible in sessions that never load a skill.
- Descriptions are model-compressed through the `smol` role; the cache holds 11 rows and no compression failure has been logged since 2026-10-19T08:03.
- The only non-native participant is `pi-jev`, and its channel is display-only (§1.3).

### 1.2 Does AegisFlow interfere with native capability?

**No — `CONFIRMED`.**

- Both extensions and both commands register through documented APIs. No source patch, no fork, no prompt rewrite, no duplicate tool names, no provider collision.
- The waiter policy narrows `bash` admission; the fence tool is additive and read-only; the CBM tool is additive and read-only.
- The one capability reduction is the **one-shot governed launcher**, which passes `--no-extensions --no-skills --no-rules`; the interactive governed path restricts built-ins with `--tools` but keeps extension tools and skills. The reduction is an intentional containment implemented with native CLI flags, not interference with native behaviour.

### 1.3 Which integration components are not achieving their purpose?

| Component | Status | Label |
|---|---|---|
| `pi-jev` **recommendation channel** | malfunctioning — every suggestion is uncallable (`/skill:skill:<name>`) | `INTEGRATION_DEFECT` |
| `pi-jev` **tools** | reachable, discoverable, never used | `UNUSED_BUT_VALID` |
| One-shot governed runs (extension/MCP surface) | extension modules absent (`--no-extensions`); interactive governed runs keep them | `CONFIGURATION_DEFECT` **only if** the intent was for them to be present |
| `omp-grok-build`, `zmarketplace` | installed, load, no observed use | `UNUSED_UNPROVEN` |
| `search-scope-governor` | not installed into OMP | out of scope |

### 1.4 Which components merely lack usage evidence?

`jev_find_tools`, `jev_find_skill`, `jev_evaluate`; native `memory_*`/`learn`/`manage_skill`; `omp-grok-build`; `zmarketplace`; `cbm_query` (1 call); `kicad-design` and `software-ios-native` skills (0 loads). For all of these, *reachability was verified* and *use was not observed*. None is proven broken.

### 1.5 Which problems actually need repair?

Only one is a true defect with an established mechanism: the `pi-jev` doubled-prefix recommendation (§A of `ROOT_CAUSE_CANDIDATES.md`). It belongs to a third-party plugin, not to AegisFlow and not to OMP, and this card does not authorise repairing it.

Everything else on the candidate list is either an operator decision (whether governed runs should see extension/MCP capability; whether Jev should continue to exist), an upstream limitation (no dead-model-role startup warning), a hygiene question (two Merge credentials), or non-use.

### 1.6 Does any problem require modifying OMP itself?

**No — `CONFIRMED` for every finding in this audit.**

- The skill description failure that the previous card fixed was a configuration value, not an OMP defect.
- The `pi-jev` defect is fixable in the plugin.
- The governed-surface gap is fixable by launcher flags/config.
- The only genuine OMP weakness found is the absence of a startup validation for a role whose model is unreachable (§G). That is an *upstream improvement proposal*, not a blocker: the OMP-side mitigation would be a non-fatal startup diagnostic. No evidence in this audit shows it causes wrong task outcomes — it degrades descriptions, and descriptions are advisory.

---

## 2. Findings by class

| Class | Count | Items |
|---|---:|---|
| `INTEGRATION_DEFECT` | 1 | Jev `/skill:skill:` recommendation |
| `CONFIGURATION_DEFECT` | 2 | governed-run capability exclusion (conditional); two Merge credentials |
| `UPSTREAM_OMP_LIMITATION` | 1 | no start-up warning for an unusable model role |
| `UNUSED_BUT_VALID` | 4 | Jev tools; native memory family; CBM (value unproven); `omp-grok-build`/`zmarketplace` (as a group) |
| `REDUNDANT_CAPABILITY` | 1 | Jev tool/skill routing duplicates native selection + native Judge |
| `NO_DEFECT` | 3 | retired `node_repl_js` MCP; stale deny names in the pilot overlay; binary/source version skew |
| `INSUFFICIENT_EVIDENCE` | 1 | why `kicad-design` was never selected on real KiCad tasks |

Reference: `ROOT_CAUSE_CANDIDATES.md` §11 for ranking and per-item evidence.

---

## 3. What this audit does **not** claim

- It does not claim Jev is useless. It claims Jev's only observable output on this host is wrong, and its tools have no observed use.
- It does not claim the governed launcher is misconfigured. It states what the launcher makes unreachable, so that future "component X was not used" conclusions are not misread as component failures.
- It does not claim OMP's skill selection is optimal. One skill (`kicad-design`) has never been selected on real tasks despite the domain appearing; the cause is unknown.
- It does not re-run the previous card's Rust / Code Review / KiCad / abstention acceptance. Those results stand as that card's evidence; this audit only confirms the corpus is consistent with them.

---

## 4. Evidence inventory and reproducibility

| Artefact | Location | Reproducible by |
|---|---|---|
| Binary identity | `~/.local/bin/omp`, sha256 `fa41b27d…4bac5` | `shasum -a 256`, `omp --version` |
| Readable source | `~/node_modules/@oh-my-pi/pi-coding-agent` (18.8.9) | file reads at the cited lines |
| Session corpus | `~/.omp/agent/sessions/**/*.jsonl` (1,735 files) | counting `toolCall` / `toolResult` blocks |
| Log corpus | `~/.omp/logs/*.log` | `json.loads` per line, filter `message` |
| Skill cache | `~/.omp/agent/skill-descriptions.db` | `SELECT * FROM skill_descriptions` (11 rows) |
| CBM store | `~/.autoloop/memory/memory.db` | table counts (8 records) |
| Deployed integration | `~/.omp/agent/extensions/` | `npm run omp:check` → 6 MATCH, 1 EQUIVALENT, 0 DRIFT |
| Plugin registry | `~/.omp/plugins/omp-plugins.lock.json` | read |
| Extension loadability | two offline `import()` probes with a stub `pi` | `bun -e` / `node -e`; no session created |
| Pilot evidence | `/Volumes/NVM2T/Development/autoloop-omp-pilot/runtime/**` (462 directories; 38 session files) | read |

Two probes were executed that touch runtime code: an offline `import()` of `pi-jev/extensions/index.ts` and of `cbm-query.js`, each with a hand-built `pi` stub, to establish whether the module registers its tools. Neither created a session, wrote a file, contacted a model, or started an MCP server. `CONFIRMED`.

---

## 5. Landing state

- Repository: `/Volumes/NVM2T/Development/repos/autoloop`, remote `git@github.com:xonogesrs/aegisflow.git`.
- Pre-audit HEAD: `1cf1e9f` = `origin/main`; worktree clean; worktree `/private/tmp/aegis-work` at `1cf1e9f`, clean; 0 stashes.
- This card adds documentation only. No source, test, config or extension file changed.
- Previous card's constraint honoured: no empty or ceremonial commit was made for its config-only change. Its one-line `smol` fix remains live, and the backup `config.yml.bak-pre-skilldesc-20261019` still exists.

---

## 6. Directive compliance

| Directive | Observed |
|---|---|
| Preserve OMP upstream baseline | binary hash and mtime unchanged; no config write; no cache write |
| Audit before repair | zero repairs performed, including for the one confirmed defect |
| Prefer native Agent capabilities | the report attributes working behaviour to native mechanisms wherever they explain it |
| No unnecessary orchestration | no router, adapter, shim or new file outside this audit directory |
| No unverified claims | every consequence cites a transcript, log, DB row or source line; version-dependent mechanisms are labelled as such |
| No destructive cleanup | no cache, DB, worktree, log or history was removed |
