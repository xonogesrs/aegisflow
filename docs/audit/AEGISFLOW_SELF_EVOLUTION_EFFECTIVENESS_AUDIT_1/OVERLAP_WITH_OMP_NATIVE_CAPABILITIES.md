# Overlap with OMP native capabilities

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Mode:** READ-ONLY. **Baseline:** `1301bb1`; OMP `18.12.1`
(sha256 `fa41b27d…24bac5`); readable source `@oh-my-pi/pi-coding-agent@18.8.9`.

---

## 1. Feature map

| Purpose | AegisFlow implementation | OMP native | Overlap |
|---|---|---|---|
| Durable memory store | CBM SQLite + digest-chained journal (`src/memory/**`) | `memory.backend` = `off` \| `local` \| `hindsight` \| `mnemopi` \| `sharpshooter`, **default `off`** | conceptual duplicate, separate stores |
| Read / recall | `cbm_query` tool; harness CLI | `recall` (backend-gated) | conceptual duplicate; native inert here |
| Write / retain | CBM-4 writeback gate, requires `writeback_allowed` + caller store | `retain` (backend-gated) | duplicate purpose; AegisFlow strictest |
| Learning from runs | attribution feed + strategy memory + transfer metrics | `learn` (lessons file) + `AutoLearnController` | duplicate purpose; AegisFlow measures, native narrates |
| Skill authoring | **none** | `learn` / `manage_skill` → `~/.omp/agent/managed-skills` | **no overlap** |
| Skill consumption | none | native discovery + `skill://` | native only |
| Prompt evolution | `PROMPT_EVOLUTION` declared token, MEDIUM | none | nominal only |
| Search policing | `pi-extensions/search-scope-governor` (Pi runtime, not OMP) | native search tools | no OMP overlap |

---

## 2. What AegisFlow actually registers into OMP

| Surface | API | Memory/learning? |
|---|---|---|
| `request_terminal_fence` | `registerTool`, `essential`, approval `read` | no |
| `/fence-generation`, `/release-final` | `registerCommand` | no |
| `cbm_query` | `registerTool`, `essential`, approval `read` | **yes** |
| hooks (`session_start`, `tool_call`, `tool_result`, `agent_end`, `session_stop`) | extension hooks | no (gate only) |

Exactly one memory-related surface crosses the boundary, and it is read-only.

---

## 3. Write surface: none toward OMP

| Claim | Verification |
|---|---|
| No write syscalls in `no-poll-waits.js` / `cbm-query.js` | grep for `writeFileSync\|appendFileSync\|mkdirSync\|renameSync\|unlinkSync\|openSync` → no hits |
| Installer writes a closed set | `KNOWN_FILES` = 7 extension files (`scripts/omp-integration/lib.mjs:41-49`); no `config.yml`, `mcp.json`, `settings.json`, skills or prompts |
| Launcher isolation | run-local `pilot-overlay.yml`; `models.yml` only in an isolated HOME; overlay states it "NEVER touches `~/.omp/agent/config.yml`" |
| No skill writer in the repository | no `SKILL.md` in repo; no code path writes skills |

AegisFlow therefore cannot modify OMP skills, prompts, settings or agent config.

---

## 4. Duplication assessment by authority

| Axis | OMP native | AegisFlow | Assessment |
|---|---|---|---|
| Storage | settings-gated, off | first-party SQLite at `~/.autoloop/memory` | independent; no shared identity |
| Trust model | none | trust ladder + validity + evidence manifest | AegisFlow stricter |
| Retrieval | backend-defined | deterministic, digest-bound, repository-scoped | AegisFlow stricter |
| Learning | prose capture | measurement + gated policy | different epistemics |
| Activation | config key | policy artifact + deployment declaration | AegisFlow gated |

There is no conflict, no shared file, no duplicate tool name, and no competing
authority. The duplication is **purpose-level**, not mechanism-level.

---

## 5. Observed use in the same corpus

| Surface | Calls | Window |
|---|---:|---|
| `cbm_query` | 1 | 2026-08-16 → 2026-10-19 (1,740 sessions) |
| OMP `memory_recall` | 0 | same |
| OMP `memory_retain` | 0 | same |
| OMP `memory_reflect` / `memory_edit` | 0 | same |
| OMP `learn` | 0 | same |
| OMP `manage_skill` | 0 | same |
| OMP native skills (`skill://`) | 815 | same |

Neither memory system is exercised in normal work. Skills are exercised heavily.

---

## 6. Third-party components in the same space

| Component | Owner | Observed use | Note |
|---|---|---|---|
| `pi-jev` | third party | 0 tool calls; 4 uncallable suggestions since install | duplicated routing/skill channel, defective (prior audit) |
| CBM | AegisFlow | 1 call | read-only tool |
| `@oh-my-pi/pi-mnemopi` | OMP package | unused | backend never selected |

---

## 7. Conclusion

- AegisFlow's evolution/learning layer does **not** overlap OMP's memory or
  learning machinery at the mechanism level and cannot alter it.
- CBM duplicates OMP's memory *purpose*. Only one read-only tool crosses into
  OMP, and OMP's own backend is off, so there is no double-write and no
  authority conflict.
- The only redundancy that could confuse an operator is **two dormant memory
  systems** (OMP backend off, CBM read-only with 8 stale records). Consolidation
  is an operator decision, not a defect this audit can resolve.
- No capability overlap justifies modifying OMP.
