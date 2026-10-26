# FINAL_VERDICT

**Card:** `AEGISFLOW_EVOLUTION_PRODUCTION_ADMISSION_1`
**Type:** PRODUCTION ADMISSION / READ-ONLY FIRST
**Agent:** OMP
**Date:** 2026-10-19
**Baseline:** `da3a251` (`feat/omp-cbm-recovery`, prior audit measured at `1301bb1`)

```
VERDICT                              = HOLD — TARGETED_REPAIR_REQUIRED
MODE                                 = READ_ONLY
SOURCE_MUTATION                      = NONE
OMP_MUTATION                         = NONE (binary + config sha256 unchanged)
EKM_MUTATION                         = NONE
CBM_MUTATION                         = NONE
EVOLUTION_ENABLED                    = NO
PRODUCTION_EVOLUTION_CYCLES          = 0
REPAIRS_IMPLEMENTED                  = 0
```

Proposal-Only Evolution is **not admissible today**. Three specific,
code-level gaps block it, each with a measured proof. The rest of the machinery
required by the mode is present, reachable and verified. The repair is bounded
(§`MINIMUM_REPAIR_PLAN.md`) and is not authorized by this card.

---

## 1. Durable landing gate (card §0)

| Check | Result |
|---|---|
| Predecessor card verdict | PASS — `docs/audit/AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1/FINAL_VERDICT.md` |
| `git status --short` | empty (both worktrees) |
| `git branch --show-current` | `feat/omp-cbm-recovery` |
| `git log -1 --oneline` | `da3a251 docs(cbm): integrate DeusData codebase-memory-mcp as an independent MCP server` |
| `git remote -v` | `origin git@github.com:xonogesrs/aegisflow.git` (fetch + push) |
| `git rev-parse HEAD` | `da3a2518df17b68cf1bf531dc77619c9937c4079` |
| `git rev-parse @{upstream}` | same |
| `git ls-remote origin refs/heads/feat/omp-cbm-recovery` | `da3a2518df17b68cf1bf531dc77619c9937c4079` |
| `git worktree list` | `autoloop` @ `8bb72a5` (`audit/omp-native-capability-dispatch-1`); `aegis-work` @ `da3a251` |
| `git stash list` | empty |

No reset, clean, or overwrite was performed. No unprotected work existed.

---

## 2. Which verdict, and why

### Rejected verdicts

- **PASS — PROPOSAL_ONLY_ADMISSIBLE** — rejected. Three required capabilities
  do not hold (§3). Nothing was relaxed to avoid this.
- **FAIL — AUTHORITY_OR_DATA_INTEGRITY_VIOLATION** — rejected. No privilege
  escalation, no governance-surface mutation, no EKM/CBM/OMP write, no loss or
  corruption of existing evolution data was found
  (`AUTHORITY_AND_DATA_INTEGRITY.md` §1–§2).
- **HOLD — INSUFFICIENT_PRODUCTION_EVIDENCE** — rejected as the *primary*
  reason. Evidence is thin (zero production cycles), but the blocking findings
  are code-level and directly demonstrable, not an absence of evidence.

### Selected verdict

**HOLD — TARGETED_REPAIR_REQUIRED.** Three gaps, each proven by execution, each
with a minimal fix that adds no new subsystem.

---

## 3. The three blocking gaps

| ID | Gap | Proof |
|---|---|---|
| **G1** | Synthetic evidence reaches derivation | Three synthetic `PHASE_REPAIR_REQUESTED` events with `{synthetic:true, test_only:true}` produced `CYCLE_STARTED` → **`PROMOTED`** in a fixture repository (fixture store/policy). The feed excludes synthetic records (`attribution-feed.mjs:240,333`); the trigger path does not (`production-observer.mjs:137-182`). |
| **G2** | A strategy proposal is never persisted | `deriveStrategyCandidate` returns `CREATED` with a digest-bound candidate and writes nothing (`candidate-strategy.mjs:95-214`). Measured: store directory unchanged after the call; `evolution-candidates/` absent. `listCandidates` (`candidate.mjs:306`) and `reconcileEvolutionState` (`recovery.mjs:64`) therefore cannot see it. |
| **G3** | No proposal-only stop exists | No flag, stage ceiling or verdict. `EVOLUTION_LOOP_VERDICTS` (`loop.mjs:54`) has no proposal verdict, and after a PLAN the loop proceeds to authorization (`:346`), mutation, fitness, review, promotion and canary. |

---

## 4. What is already adequate

| Area | Status |
|---|---|
| Real-evidence journaling + integrity check | works (`production-observer.mjs:81`) |
| Every-run attribution | works (`attribution-feed.mjs:293`) |
| Minimum-evidence floors / single incident cannot fire | works (floors ≥3; strategy samples ≥3) |
| Deterministic, auditable plan production | works (`plan-producer.mjs:77,225`) |
| Evidence references on every trigger | works (`trigger.mjs:517`) |
| Isolated mutation, production checkout untouched | works (`mutation.mjs:108`, C3B worktree) |
| Fitness with honest INCONCLUSIVE | works (`fitness.mjs:131`, `fitness-strategy.mjs:78`) |
| Eight promotion gates, all fail-closed | works (`promotion.mjs:232`) |
| Canary + automatic rollback | works (`canary.mjs:99,153,212`) |
| Crash reconciliation | works (`recovery.mjs:64`) |
| Kill switch isolates evolution from normal operation | works — verified: `SUSPENDED` with the run still `PASS` |
| Fail-open to normal operation | works (`admission-gate.mjs:438-441`; suite `R7`) |

Known limitations recorded for any future mutation admission, out of scope here:
review independence is a deployment-supplied identity string with a `PASS`
default (`promotion.mjs:158-186`, `production-consumer.mjs:223`), and the
policy budget counters are never supplied by the production caller
(`policy.mjs:527-534`, `loop.mjs:305`, `production-consumer.mjs:496-518`).

---

## 5. Admission gates

### A. Evidence Gate — **FAIL**

The proposal source is traceable to real durable evidence *when* the run is
real, but a fixture run can reach the full cycle (G1). Requirement: "不得以
fixture、合成事件或過期資料宣稱 Production 改善" — not met by construction.

### B. Authority Gate — **PASS**

Evolution holds no authority above the agent. It cannot mint its own policy,
cannot touch governance/admission surfaces (`policy.mjs:113,431-465`), cannot
promote MEDIUM or HIGH autonomously, cannot write main/master, and cannot
bypass the terminal fence or admission. The kill switch is operator-controlled
and outside the repository.

### C. Isolation Gate — **FAIL for the mode as specified, PASS for state safety**

Improvement derivation writes only under `storeRoot`; no EKM/CBM/OMP write path
exists; the strategy store has no runtime consumer outside `src/evolution`.
However, the process cannot stop at "proposal saved" (G3), so a proposal cannot
be produced in isolation from mutation and promotion.

### D. Review Gate — **PASS for proposal-only; WEAK for any mutation**

For a proposal, the human reviewer is the boundary and no automatic approval is
required. For autonomous mutation the review artifact is written by the same
process from a deployment-supplied identity with a defaulted `PASS` verdict —
recorded as W1, not a blocker for proposal-only.

### E. Rollback Gate — **PASS**

Proposal-only needs a disable path, not a rollback system. The kill switch
(`kill-switch.mjs:41-64`) stops new cycles without touching normal operation,
and it was verified end to end.

---

## 6. Minimal verification performed (card §6)

| Required check | Result |
|---|---|
| Existing evolution tests | `node --test test/evolution/*.mjs` → **69/69 PASS** (9.9 s) |
| Production path reachability | real `runAdmittedGraph` → `DISABLED` (undeclared), `NO_QUALIFIED_TRIGGER` (declared), `SUSPENDED` (kill switch) — all with final `PASS` |
| Proposal source evidence | synthetic fixture drove a full cycle (G1) — the finding itself |
| Normal task unaffected with evolution disabled | suite `R7`, `R8`, `P12` + direct run: `PASS` in every case |
| EKM/CBM not written by evolution | `grep -rn 'cbm|ekm' src/evolution` → none; sha256 of EKM db/journal/lineage and CBM cache unchanged |
| OMP and tool config unchanged | binary `fa41b27d…d24bac5`; `config.yml` `108ca03c…`; `mcp.json` `032839c1…`; extension `03c08f43…` — all unchanged, extension still byte-identical to the repository |

Fixtures were used only to *demonstrate* mechanisms (and to prove G1). Their
successes are **not** counted as production evolution results.

---

## 7. Deliverables

| File | Content |
|---|---|
| `EVOLUTION_PRODUCTION_PATH_AUDIT.md` | stage-by-stage classification with call sites; the two measured defects |
| `PROPOSAL_ONLY_ADMISSION_MATRIX.md` | 20 required capabilities, MET/GAP counts, three blocking gaps |
| `AUTHORITY_AND_DATA_INTEGRITY.md` | authority boundaries, three weaknesses, before/after integrity hashes |
| `MINIMUM_REPAIR_PLAN.md` | R1–R4 proposal, unapproved, with acceptance criteria |
| `FINAL_VERDICT.md` | this document |

No source, test, config, store, policy, declaration, skill, prompt, extension or
OMP file was modified. No Evolution was enabled.

---

## 8. Required next step

Controller decision on `MINIMUM_REPAIR_PLAN.md`. If authorized, it should be a
separate implementation card limited to R1–R4. **This card authorizes no
repair, no enablement, and no autonomous operation.**

```
NEXT = Controller review of MINIMUM_REPAIR_PLAN.md
PROPOSAL_ONLY_ENABLED = NO
AUTONOMOUS_MUTATION  = NO
```
