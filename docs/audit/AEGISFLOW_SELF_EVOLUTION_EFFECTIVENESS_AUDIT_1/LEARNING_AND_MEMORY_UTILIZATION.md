# Learning and memory utilisation

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Mode:** READ-ONLY. **Baseline:** `1301bb1`. All counts are direct measurements
taken during this audit; observation windows are stated per row.

---

## 1. Availability vs activation vs use

| Mechanism | Reachable | Enabled by default | Observed use | Persistent result |
|---|---|---|---|---|
| Evolution loop (`runEvolutionCycle`) | yes, via `runAdmittedGraph` | **no** — three config inputs required, none exported | 0 production cycles | none |
| Attribution feed | yes, same gate | no | 0 records in the production store | none |
| Strategy memory | yes | no | 0 observations in production store; 70 in benchmark artifact | benchmark file only |
| Trigger evaluation | yes (observer always runs when configured) | no | 0 triggers; breaker `CLEAR` | none |
| Candidate derivation | yes | no | 0 candidates; `derivations = 0` | none |
| Source mutation / promotion | yes | no | 0 `evolution/<id>` refs | none |
| Canary / rollback | yes | no | 0 canary records | none |
| Kill switch | yes (CLI + env) | ENABLED (not suspended) | not engaged; no marker file | none |
| Circuit breaker | yes | CLEAR | 0 trips | none |
| CBM retrieval (harness CLI) | yes | opt-in | used in this audit: 1 query, `selected 1 / 8` | 1 record returned |
| CBM retrieval (`cbm_query` in OMP) | yes | registered `essential` | **1** call, 2026-10-18T13:56Z | result DATA only |
| CBM writeback | code path exists | **no** — needs `memory_policy.writeback_allowed` **and** a caller-supplied store | 0 writes since 2026-08-16 | store frozen at 8 records |
| Learning transfer metrics | code exists | **hard-disabled** (`TRANSFER_METRICS_ENABLED = false`) | 0 production events | none |
| Incident projection / adapter | code exists | no production caller | 0 | none |
| Learning lifecycle state machine | code exists | reachable only through a provenance no producer sets | 0 | none |
| OMP native memory (`recall`/`retain`/`reflect`/`edit`) | backend-gated, default off | no | **0** calls / 1,740 sessions | none |
| OMP `learn` / `manage_skill` | registered conditionally | no observed use | **0** calls | none |
| OMP skills (native) | yes | yes | **815** loads, 19 distinct names | procedural knowledge, not memory |

---

## 2. Evolution store: the decisive measurement

Largest available observation window: `1301bb1` (2026-10-19), store created
2026-09-24. Command:

```
node scripts/evolution-operator.mjs --store /Volumes/NVM2T/Development/evidence/autoloop-evolution --json
```

Result (abridged, verbatim values):

| Field | Value |
|---|---|
| `policy.state` | `ACTIVE` |
| `policy.generation` | `1` |
| `policy.expiresAt` | `2026-10-24T10:56:29.996Z` |
| `circuitBreaker.state` | `CLEAR` |
| `generation.derivations` | `0` |
| `triggers.count` | `0` |
| `candidates` | `[]` |
| `reviews` | `{}` |
| `canary` | `{}` |
| `rollbacks` | `[]` |
| `strategy.generation` | `0` |
| `strategy.active` | `{}` |
| `strategyMemory.total` | `0` |
| `attributionFeed.total` | `0` |
| `deployment.provided` | `false` |

Filesystem corroboration — the store contains exactly three files:

```
evolution-policy.gen0.json        1744 B   2026-09-24T07:37
evolution-policy.json             1853 B   2026-09-24T18:56
production-declaration.json        705 B   2026-09-24T19:47
```

No `evolution-trigger-state.json`, `evolution-candidates/`, `reviews/`,
`canary/`, `strategy-policy.json`, `strategy-memory.json`,
`attribution-feed.json`, `evolution-policy-history/` or
`evolution-suspended.json`. **Zero evolution cycles have ever run against the
production store.**

Observation window width: 25 days (2026-09-24 → 2026-10-19). Within it the loop
was reachable-by-configuration but never configured.

---

## 3. Why the loop is inert (measured, not inferred)

`resolveEvolutionProductionConfig` requires `storeRoot`, `checkpointRoot`,
`repoRoot`. Measured outcomes:

| Inputs | Result |
|---|---|
| `env = {}` | `enabled:false`, `missing:["storeRoot","checkpointRoot","repoRoot"]` |
| shell environment at audit time | no `AEGISFLOW_EVOLUTION_*` / `AUTOLOOP_EVOLUTION_*` |
| `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG` exported manually | `enabled:true`, storeRoot resolved, dims `["MODEL_ROUTING","RETRY_REPAIR"]` |
| launcher (`scripts/pi-aegisflow.sh`) | no evolution variable |
| LaunchAgents (`~/Library/LaunchAgents`) | no evolution entry |
| control-plane dispatcher | forwards `task.runnerOpts`; no evolution object |

Conclusion: the deployment declaration is a **dormant** artifact. Anyone who
exports it activates the every-run feed and trigger observation on the next
admitted run; nobody currently does.

---

## 4. Learning system: disabled by construction

| Check | Result |
|---|---|
| `TRANSFER_METRICS_ENABLED` | `false` (`src/learning/transfer-metrics/seam.mjs:7`) |
| `recordTransferEvent(payload)` | `{status:"DISABLED", production_effect:"NO_PRODUCTION_EFFECT"}` |
| `getTransferMetricsWriter()` | `null` |
| Production callers of `TransferMetricsWriter` | none (only `fixtures.mjs` and tests) |
| Production callers of `observeLifecycleHeldIncident` | none (tests only; returns `UNAVAILABLE` without writer) |
| Non-test importers of consolidation/qualification | none |
| Non-test importer of `applicability.mjs` | `src/memory/retrieval.mjs:50` (boundary evaluation only) |

### 4.1 Scratch corpus — measured, and not learning

`~/.autoloop/learning/scratch`: **1,676 directories, 11,210 files, 47 MB**,
timestamps 2026-09-24 → 2026-10-19. 1,520 `transfer-events.jsonl` files,
3,769 lines, 2,234 event records:

| Field | Counts |
|---|---|
| `event_type` | `INCIDENT_OBSERVED` 1,526 · `LEARNING_AUTHORITY_STATE_CHANGED` 708 |
| `authority.role` | `fixture` 1,526 · `operator` 708 |
| `producer_kind` | `fixture` 1,526 · `measurement-writer` 708 |
| `applicability_decision` | `UNKNOWN` 2,234 |
| Events outside `learning/scratch` | **0** |

Every event is test-fixture material (`src/learning/transfer-metrics/fixtures.mjs`
labels its principals `role: "fixture"`, and `createTestRoot` uses the scratch
namespace). **No production incident, pattern or learning record was ever
written.**

Residue note: 31 empty directories and ~1,600 completed fixture roots remain
after their processes exited, notwithstanding the exit-sweep
(`fixtures.mjs:106-118`). This is a hygiene cost, not a learning result.

---

## 5. CBM / memory utilisation

### 5.1 Store contents (read-only query)

| Metric | Value |
|---|---|
| `memory_records` | 8 (`CODE` 5, `EXECUTION` 3) |
| trust | `REVIEWED` 6, `UNVERIFIED` 2 |
| validity | `CURRENT` 8 |
| `memory_lifecycle_events` | 8 (`CREATED` only) |
| `memory_evidence` / `memory_relationships` / `memory_conflicts` | 0 / 0 / 0 |
| FTS rows | 8 |
| creation window | 2026-08-07 → 2026-08-16 |

Retrieval through the declared lineage:

```
node scripts/autoloop-memory-query.mjs --repo <checkout> --max-records 20 --json
→ state AVAILABLE, selected 1, totalCandidates 8
  excluded: trust 2, validity 5
  freshness.stale = true (indexed tree 8bc33e49…, current 29cc8e58…)
```

Without the declared lineage the historical records are unreachable (that was
the defect repaired by `fb8ce6a`). The lineage registry contains 2 aliases, both
evidence-bound.

### 5.2 Read paths

| Path | Production reachable | Observed use |
|---|---|---|
| Harness CLI (`scripts/autoloop-memory-query.mjs`) | yes | used by this audit and by operators |
| Graph retrieval (`phase.runtime.memoryContext`) | only when a caller passes `memory.provider` **and** the admission authorises retrieval | no production caller constructs the provider at HEAD |
| OMP `cbm_query` | yes, `essential` | **1** call |

`251d9ae` ("production provider wiring") is **not an ancestor of `1301bb1`**;
the current `runAdmittedGraph` builds no provider. The claim in that commit
message therefore does not describe the audit baseline.

### 5.3 Write paths

| Path | Gate | Observed writes |
|---|---|---|
| `runGraphWriteback` in the Colima runner | `writeback.store` supplied **and** `admission.memory_policy.writeback_allowed === true` | 0 since 2026-08-16; no production caller supplies the store |
| `memory:lineage declare` | operator CLI | 2 aliases (2026-10-18) |
| OMP `cbm_query` | read-only by construction | never writes |

No component writes OMP skills, prompts, `config.yml`, `mcp.json` or settings
(verified by syscall-name grep over both extensions and by the installer's
closed `KNOWN_FILES` set).

---

## 6. OMP native memory/learning

| Measurement | Value |
|---|---|
| Session files | 1,740 (2026-08-16 → 2026-10-19) |
| `memory_recall` tool calls | 0 |
| `memory_retain` tool calls | 0 |
| `memory_reflect` tool calls | 0 |
| `memory_edit` tool calls | 0 |
| `learn` tool calls | 0 |
| `manage_skill` tool calls | 0 |
| `skill://` loads | 815 (19 distinct names; top: code-review 200, diagnosing-bugs 166, codebase-design 96) |
| `cbm_query` calls | 1 |

`~/.omp/agent/config.yml` has no `memory:` or `autolearn:` block; both are
default-off. Native memory is **available, gated, and unused** — matching the
prior audit, with the session count drifted from 1,735 to 1,740 and skill loads
from 814 to 815.

---

## 7. Cost, latency, maintenance burden

| Mechanism | Direct runtime cost | Maintenance / residue |
|---|---|---|
| Evolution post-result block | 3 config reads + one journal read **only when enabled**; at HEAD `enabled:false`, so `readObservationJournal` is skipped (`admission-gate.mjs:398-406`) | 22 modules, 6,684 lines, 6 test files (4,383 lines) for zero production cycles |
| Attribution feed | one write per eligible run when enabled | bounded file (64 recent records) |
| Learning transfer metrics | none — functions return `DISABLED` before any I/O | 21 modules, 11,873 lines, 34 test files, 47 MB of scratch residue |
| CBM read | one SQLite open per query | tiny store; correctness repaired twice in Oct 2026 |
| CBM write | zero — no caller | writeback modules idle |
| OMP native memory | zero — backend off | none |

There is no measurable production latency attributable to learning or memory:
the disabled seams return before I/O, and the evolution block short-circuits on
`!enabled`.

---

## 8. Utilisation verdict per mechanism

| Verdict | Mechanisms |
|---|---|
| **Actively used, effective** | OMP native skills (815 loads); CBM read (CLI + 1 tool call); declared repository lineage |
| **Used, effect unmeasured** | CBM `cbm_query` (1 call — too few for benefit claims) |
| **Available, never used** | evolution loop, feed, trigger, candidate, mutation, promotion, canary, kill switch, breaker, strategy store, transfer metrics, incident projection, lifecycle writer, OMP native memory/learn |
| **Used only in tests/benchmarks** | strategy fitness, cross-agent transfer, canary/rollback, breaker trip, policy succession |
| **Absent** | skill authoring, prompt self-editing, automatic error-analysis → repair from natural evidence |
