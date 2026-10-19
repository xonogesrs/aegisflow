# Evidence manifest

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Baseline:** `1301bb1` = `origin/audit/omp-native-capability-dispatch-1`
**Mode:** READ-ONLY. No production state was copied into the repository; every
external artefact below stayed in place and was read in place.

---

## 1. Committed deliverables

| File | Purpose |
|---|---|
| `SELF_EVOLUTION_ARCHITECTURE.md` | implemented architecture, entry points, gates, stores, OMP boundary |
| `EVOLUTION_LEDGER.md` | 22-row ledger with fixed evidence grades |
| `LEARNING_AND_MEMORY_UTILIZATION.md` | reachability, activation, measured utilisation, cost |
| `EVOLUTION_EFFECTIVENESS_ASSESSMENT.md` | answers to the card's effectiveness questions |
| `OVERLAP_WITH_OMP_NATIVE_CAPABILITIES.md` | AegisFlow vs OMP vs third-party, boundary and duplication |
| `AUDIT_VERDICT.md` | verdict, gate results, six answers, non-claims |
| `EVIDENCE_MANIFEST.md` | this file |

File hashes at commit time (sha256, over the committed content):

```
efe4faffae3f779fc9fe0b62737a81d804806f1eed610d1b2951d60ed8ed5747  AUDIT_VERDICT.md
64ffdc4ebdaf13026cc63315379f86c4b8105652af3cdc28d364e57431237f80  EVOLUTION_EFFECTIVENESS_ASSESSMENT.md
226394223dad886bd482e543317c14c925b24e83138d29958184fbab163d78e1  EVOLUTION_LEDGER.md
e3992746d4ef77bd148b6006014a7cbbe580eafda235a4d889bc666b15b6d014  LEARNING_AND_MEMORY_UTILIZATION.md
37c6a9392ec9e6e153024b581932cc8cbd0b2e81e319c83d9e606d0b14b6ca61  OVERLAP_WITH_OMP_NATIVE_CAPABILITIES.md
be2f3c3609c18c8a45a0005e990b8e4e293188ab2bc8d2c759a0ff69d06bc6da  SELF_EVOLUTION_ARCHITECTURE.md
```

This manifest's own hash is deliberately omitted (it is not fixed-point stable).

---

## 2. External artefacts (not committed)

### 2.1 Runtime stores — unchanged during the audit

| Artefact | Path | Identity |
|---|---|---|
| Evolution policy gen 0 | `/Volumes/NVM2T/Development/evidence/autoloop-evolution/evolution-policy.gen0.json` | sha256 `f12bea42…ced322`, 1,744 B |
| Evolution policy gen 1 | `…/autoloop-evolution/evolution-policy.json` | sha256 `1a8d6d57…cc31f8`, 1,853 B, generation 1, expires `2026-10-24T10:56:29.996Z` |
| Deployment declaration | `…/autoloop-evolution/production-declaration.json` | sha256 `63dfa6ff…2128ac`, 705 B |
| CBM store | `~/.autoloop/memory/memory.db` | sha256 `0fa9dbb3…1e487c`, 208,896 B, 8 records |
| CBM journal | `~/.autoloop/memory/journal.jsonl` | sha256 `c5093265…7c22733`, 17,647 B, 8 events |
| Lineage registry | `~/.autoloop/memory/repository-aliases.json` | sha256 `bffe10d4…7c527302`, 2,209 B, 2 aliases |
| Learning scratch | `~/.autoloop/learning/scratch/` | 1,676 dirs / 11,210 files / 47 MB; all events `authority.role: fixture` |

The evolution store directory contained exactly three files before and after
the audit; no `strategy-policy.json`, `strategy-memory.json`,
`attribution-feed.json`, `evolution-trigger-state.json`, `candidates/`,
`reviews/`, `canary/` or `evolution-policy-history/` exists.

### 2.2 Repository artefacts

| Artefact | Path | Identity |
|---|---|---|
| Evolution suite | `test/evolution/*.mjs` | 6 files, 69 tests, 4,383 lines |
| Evolution modules | `src/evolution/*.mjs` | 22 files, 6,684 lines |
| Learning modules | `src/learning/**` | 21 files, 11,873 lines |
| Memory modules | `src/memory/**` | 21 files, 5,364 lines |
| Disabled seam | `src/learning/transfer-metrics/seam.mjs` | sha256 `66171952…baba29`, `TRANSFER_METRICS_ENABLED = false` |
| Graph memory provider | `src/memory/graph-context.mjs` | sha256 `efb9b29d…ba05b1` |
| OMP CBM tool | `integrations/omp/extensions/cbm-query.js` | sha256 `9d56cffa…f7f7f117` |
| Benchmark analysis | `benchmarks/results/analysis.json` | sha256 `171ce7f0…a505625`, 105 runs |
| Benchmark learned store | `benchmarks/results/learned-strategy-store/strategy-policy.json` | sha256 `c5719878…a0af144`, generation 42 |
| Benchmark doc | `docs/benchmark.md` | sha256 `254c8297…162514` |

### 2.3 OMP runtime baseline (unchanged)

| Artefact | Path | Identity |
|---|---|---|
| OMP binary | `~/.local/bin/omp` | sha256 `fa41b27d434380e99b713e4f9ced0f73eb1fc0c409fdf23a57c119971d24bac5`, 195,462,176 B, mtime 2026-10-18 12:52 +08:00, `omp/18.12.1` |
| Agent config | `~/.omp/agent/config.yml` | 878 B, mtime 2026-10-19 08:03 (before this audit) |
| Deployed extension | `~/.omp/agent/extensions/cbm-query.js` | sha256 `9d56cffa…f7f7f117` — identical to repository |
| Session corpus | `~/.omp/agent/sessions/**/*.jsonl` | 1,740 files, 2026-08-16 → 2026-10-19 |
| `cbm_query` session | `~/.omp/agent/sessions/--private-tmp-aegis-work--/2026-10-18T13-56-36-732Z_01a14f4c-d0fc-70f5-94c7-c45a471a18f3.jsonl` | sha256 `23718e83…85a2b9`, 9,443 B |

### 2.4 Archived governance records (read in place)

Path prefix:
`/Volumes/NVM2T/Development/evidence/autoloop/publication-archive-2026-09-24/governance/`

| File | Used for |
|---|---|
| `autoloop-autonomous-evolution-loop-completion-1.md` | EV-01 acceptance rows A–N |
| `autoloop-autonomous-evolution-production-activation-1.md` | EV-03, the `NOT_ACTUALLY_CLOSED` correction, `FIRST_LIVE_EVOLUTION = NOT_YET_TRIGGERED` |
| `autoloop-agent-strategy-evolution-completion-1.md` | EV-04 |
| `autoloop-agent-strategy-evidence-feed-repair-1.md` | EV-05 |
| `autoloop-agent-strategy-evolution-production-activation-rerun-1.md` | EV-06/07/08, `NOT_YET_TRIGGERED` for natural cross-agent evolution |

Stage-F re-admission (read in place):
`/Volumes/NVM2T/Development/evidence/autoloop/AUTOLOOP-V1-STAGE-F-SELF-EVOLUTION-RE-ADMISSION-1-20260911T172110Z/RE-ADMISSION-RECORD.md`
§21 verdict + boundary note ("authorizes NO pipeline implementation").

Prior audio card evidence:
`docs/audit/AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1/`
(component inventory, skill/tool census, overlap, root causes, verdict).

---

## 3. Reproduction queries

```bash
# gate
cd /Volumes/NVM2T/Development/repos/autoloop
git rev-parse HEAD && git rev-parse origin/main
git status --porcelain=v1 | wc -l
git ls-remote origin refs/heads/audit/omp-native-capability-dispatch-1

# evolution state (read-only)
node scripts/evolution-operator.mjs --store /Volumes/NVM2T/Development/evidence/autoloop-evolution --json

# configuration gate
node -e 'import("./src/evolution/production-consumer.mjs").then(m=>console.log(m.resolveEvolutionProductionConfig({env:{}})))'
AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG=/Volumes/NVM2T/Development/evidence/autoloop-evolution/production-declaration.json \
  node -e 'import("./src/evolution/production-consumer.mjs").then(m=>console.log(m.resolveEvolutionProductionConfig({env:process.env})))'

# learning seam
node -e 'import("./src/learning/transfer-metrics/seam.mjs").then(m=>console.log(m.TRANSFER_METRICS_ENABLED, m.recordTransferEvent({},null)))'

# memory
node scripts/autoloop-memory-lineage.mjs list
node scripts/autoloop-memory-query.mjs --repo "$PWD" --max-records 20 --json

# CBM records
sqlite3 ~/.autoloop/memory/memory.db "select record_type,trust,validity_status,created_at from memory_records;"

# session census (memory / learn / cbm / skills)
cd ~/.omp/agent/sessions
grep -rho '"name":"cbm_query"' . | wc -l          # 1
grep -rho '"name":"memory_recall"' . | wc -l      # 0
grep -rho '"name":"memory_retain"' . | wc -l      # 0
grep -rho '"name":"learn"' . | wc -l              # 0
grep -rho '"name":"manage_skill"' . | wc -l       # 0

# evolution suite (writes only to mkdtemp)
node --test test/evolution/*.mjs

# store identity
shasum -a 256 ~/.local/bin/omp
shasum -a 256 integrations/omp/extensions/cbm-query.js ~/.omp/agent/extensions/cbm-query.js
```

---

## 4. Non-reproduction disclosures

1. **Session corpus drifts.** Counts were taken at one instant; the prior card
   measured 1,735 sessions / 814 skill loads, this card 1,740 / 815. The
   `cbm_query` count (1) and the native memory/learn counts (0) are stable
   across both.
2. **The evolution test suite is not a production run.** It uses temp git
   fixtures and injected runners; no model or provider was called. Passing it
   proves the gates compose, not that a real cycle fired.
3. **`~/.autoloop/learning/scratch` is test residue.** All 3,769 event lines
   carry `authority.role: fixture` or the fixture measurement-writer and
   `applicability_decision: UNKNOWN`; zero production learning events exist.
4. **Benchmark figures are operator-run.** 105 runs on one provider/route; the
   learned arm was never executed, and the project's own docs reject
   success-rate claims from this pilot as variance.
5. **Time-of-check caveat.** The evolution policy expires 2026-10-24; after that
   date `readEvolutionPolicy` HOLDs and the consumer reports
   `POLICY_UNAVAILABLE`. A later audit will observe a different state for the
   same fixed code.

---

## 5. Commands that were *not* run, and why

| Not run | Reason |
|---|---|
| `npm test` (full) | out of card scope; prior card's package-resolution failures remain recorded |
| Any production evolution cycle | card §6 forbids dynamic tests that mutate production state |
| `evolution-kill-switch --suspend/--resume` | mutates durable store state |
| Store rebuild / reindex / GC | forbidden (would destroy evidence) |
| OMP session start | would create new session state |
| Jev / Pilot / fence changes | excluded by card §6 |
