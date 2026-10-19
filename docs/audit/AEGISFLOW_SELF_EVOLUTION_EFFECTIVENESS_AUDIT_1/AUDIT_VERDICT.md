# Audit verdict

**Card:** `AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1`
**Type:** READ-ONLY AUDIT · **Priority:** P1
**Baseline:** `1301bb1` (`audit/omp-native-capability-dispatch-1`), `origin/main` = `1cf1e9f`

```
VERDICT                              = PASS (audit complete; no repair authorised, none performed)
MODE                                 = READ_ONLY
SOURCE_MUTATION                      = NONE
OMP_CORE_MUTATION                    = NONE
OMP_CONFIG_MUTATION                  = NONE
SKILLS_PROMPTS_SETTINGS_MUTATION     = NONE
EVOLUTION_STORE_MUTATION             = NONE
CBM_MEMORY_DB_MUTATION               = NONE
JEV_PILOT_FENCE_MUTATION             = NONE
SESSION_STARTED_BY_AUDIT             = NONE
NEW_INFRASTRUCTURE                   = NONE
AUTONOMOUS_EVOLUTION_ENABLED         = NONE
```

---

## 1. Durable landing gate (card §0)

| Check | Result |
|---|---|
| Predecessor card PASS | `docs/audit/AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1/AUDIT_VERDICT.md` → `Ver­dict: PASS` |
| Audit branch published | local and remote `audit/omp-native-capability-dispatch-1` both `1301bb1b1b271be58373446c572106f40713931a` |
| `origin/main` unchanged | `1cf1e9fa284d2407c4edbe42f525fffe12a169c2` (no movement) |
| Worktrees | `/Volumes/NVM2T/Development/repos/autoloop` @ `1301bb1` clean; `/private/tmp/aegis-work` @ `1cf1e9f` clean |
| Stash | 0 |
| Unpublished commits on audit branch | 0 |
| OMP baseline | binary sha256 `fa41b27d434380e99b713e4f9ced0f73eb1fc0c409fdf23a57c119971d24bac5`, 195,462,176 B, mtime 2026-10-18 12:52; `config.yml` untouched during this card (mtime 2026-10-19 08:03, before audit start) |
| Existing sessions | not started, not modified |

No landing work was required. Nothing was forced, reset, cleaned or overwritten.

---

## 2. Direct answers to the required questions

### 2.1 How many demonstrable autonomous evolutions exist?

**Zero.** No production trigger, candidate, mutation, promotion, canary or
rollback exists in the production store or in any git ref. The operator surface
reports `triggers.count = 0`, `derivations = 0`, `candidates = []`,
`strategy.generation = 0`, `attributionFeed.total = 0`.

### 2.2 Which capabilities were improved?

Five, all by operator-assigned cards, none by the evolution loop:

1. read-only CBM tool visible to the interactive agent (`16638d6`);
2. memory reachability after checkout/remote drift (`fb8ce6a`);
3. forward-only store migration restoring openability (`16638d6`);
4. terminal-fence parity between repo and deployment (`fb8ce6a`);
5. the evolution machinery itself — implemented, 69/69 tests pass at `1301bb1`.

### 2.3 Which results remain in effect?

Policy gen 1 (until `2026-10-24T10:56:29Z`), the deployment declaration (present,
unconsumed), the CBM store with its lineage registry, the deployed `cbm_query`
extension (byte-identical), and the hard-disabled transfer-metrics seam.

### 2.4 What is only human-assigned automation?

Every commit in the evolution/memory/learning history. No commit carries agent
authorship; all committers are `zhengfengqing <xonogears@gmail.com>`.

### 2.5 Which mechanisms never worked?

The production evolution loop (never configured), the attribution feed and
strategy memory in production (0 records), strategy candidate persistence
(not implemented), strategy consumption (no production caller), natural
repair-plan derivation (requires an evidence shape journals do not carry),
three of seven trigger classes (`null` baselines), the policy-supplied trigger
window (never applied), circuit-breaker recovery (no call site), transfer
metrics (hard-disabled), incident projection/adapter (no emitter), OMP native
memory/learn (0 calls), skill auto-creation (absent), prompt evolution (nominal
token only).

### 2.6 Which capabilities should be kept, and which need investigation?

- **Keep:** the evolution policy/deployment gate design; the bounded trigger
  floors; the fail-open post-result wiring; CBM retrieval + lineage; the
  `cbm_query` read-only tool.
- **Investigate (no repair in this card):** whether exporting the declaration is
  intended; the three `null` trigger baselines; the unused `windowMs`; the
  missing strategy-candidate persistence; the absent strategy consumer; the
  breaker-reset gap; the 47 MB scratch residue; the missing production memory
  provider (unmerged `251d9ae` lineage).

---

## 3. Evidence grading roll-up

| Grade | Count | Items |
|---|---:|---|
| `CONFIRMED_EVOLUTION` | 0 | — |
| `CONFIRMED_ASSISTED_CHANGE` | 10 | EV-01…EV-08, EV-10…EV-12 |
| `PROPOSAL_ONLY` | 2 | EV-09 (benchmark store), EV-13 (Stage-F re-admission text) |
| `MEMORY_ONLY` | 1 | EV-21 (CBM records) |
| `UNUSED_BUT_AVAILABLE` | 8 | EV-15…EV-20, EV-22 (and the lesson from EV‑14) |
| `UNKNOWN` | 1 | EV-14 (skill self-authoring — absent) |

No classification was relaxed to make the system look effective.

---

## 4. Verification performed in this card

| Check | Method | Result |
|---|---|---|
| Evolution suite | `node --test test/evolution/*.mjs` | **69/69 PASS**, 6.9 s |
| Evolution config gate | `resolveEvolutionProductionConfig` with empty env, then with the declaration | `enabled:false` → `enabled:true` |
| Transfer seam | direct module import | `TRANSFER_METRICS_ENABLED=false`, `DISABLED`, writer `null` |
| Operator surface | `scripts/evolution-operator.mjs --store … --json` | all sections empty; `policy ACTIVE gen 1` |
| Memory query | `scripts/autoloop-memory-query.mjs --repo … --json` | `AVAILABLE`, selected 1 / 8, stale |
| Lineage registry | `scripts/autoloop-memory-lineage.mjs list` | 2 evidence-bound aliases |
| Deployed extension identity | `shasum -a 256` | repo == `~/.omp/agent/extensions/cbm-query.js` |
| Session census | parse all 1,740 JSONL files | `cbm_query` 1; native memory/learn 0; skills 815 |
| Post-test state | git status, store listing, scratch count | clean; store unchanged (3 files); scratch unchanged (2,084 entries) |

The evolution suite writes only to `mkdtemp` roots (`test/evolution/*.mjs:65,70,80,89,104`) and left the repository and the production store untouched.

The prior card's `npm test` package-resolution failures were not re-run; this
card's scope does not include them and they remain recorded as before.

---

## 5. What this audit does not claim

- It does not claim the evolution machinery is broken. It is implemented and
  test-proven; it is simply unconfigured and therefore unused.
- It does not claim the deployment declaration is wrong. It is valid and
  resolves; nothing exports it.
- It does not claim the missing production memory provider is a defect. The
  commit that added it (`251d9ae`) is on an unmerged branch; whether the
  provider should be restored is a separate design decision.
- It does not claim the benchmark shows no effect of learning — it shows the
  learned arm was never run, so no effect is measurable either way.
- It does not claim OMP native memory is unusable. It is available, backend-off,
  and unused.

---

## 6. Landing state

- This card adds seven documents under
  `docs/audit/AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1/` only.
- No source, test, config, store, skill, prompt or extension file changed.
- No repair, no enablement, no cleanup, no new infrastructure.

```
CARD                                 = AEGISFLOW_SELF_EVOLUTION_EFFECTIVENESS_AUDIT_1
VERDICT                              = PASS
CONFIRMED_EVOLUTION                  = 0
CONFIRMED_ASSISTED_CHANGE            = 10
PROPOSAL_ONLY                        = 2
MEMORY_ONLY                          = 1
UNUSED_BUT_AVAILABLE                 = 8
PRODUCTION_EVOLUTION_CYCLES          = 0
PRODUCTION_TRIGGERS                  = 0
PRODUCTION_CANDIDATES                = 0
PRODUCTION_PROMOTIONS                = 0
PRODUCTION_MEMORY_WRITES_SINCE_0816  = 0
OMP_NATIVE_MEMORY_CALLS              = 0
CBM_TOOL_CALLS_OBSERVED              = 1
EVOLUTION_TESTS                      = 69/69 PASS
REPAIRS_PERFORMED                    = 0
NEXT                                 = Controller review
```
