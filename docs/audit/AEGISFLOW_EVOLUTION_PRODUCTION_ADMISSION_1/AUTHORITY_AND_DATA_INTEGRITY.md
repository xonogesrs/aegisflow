# Authority and data integrity

**Card:** `AEGISFLOW_EVOLUTION_PRODUCTION_ADMISSION_1`
**Baseline:** `da3a251`
**Mode:** READ-ONLY audit. No OMP, EKM, CBM, evolution store, policy or source
was modified.

This document records what the audit observed about authority boundaries and
about the integrity of the state the audit touched. It separates **structural
guarantees** (enforced by construction, verifiable by reading the code) from
**observed state** (measured on this host before and after the audit).

---

## 1. Authority boundaries

### 1.1 Evolution cannot grant itself authority

| Boundary | Mechanism | Verdict |
|---|---|---|
| Cannot mint or amend its own policy | `EVOLUTION_POLICY_SELF` is a HIGH-risk class; HIGH classes must appear in `forbidden_risk_classes` or the policy fails validation (`policy.mjs:144`) | STRUCTURAL |
| Cannot edit governance/admission surfaces | `src/governance/**`, `src/admission/**`, `src/evolution/**`, `.git/**`, `docs/governance/**` must be in `forbidden_patterns` (`policy.mjs:113`); the classifier refuses them independently (`policy.mjs:431-465`) | STRUCTURAL |
| Cannot promote MEDIUM autonomously | `promotionRequiresOperator` returned by `authorizeUnderPolicy` (`policy.mjs:537`); loop stops at `AWAITING_OPERATOR_PROMOTION` (`loop.mjs:447-456`) | STRUCTURAL |
| Cannot promote HIGH | refused upstream at `authorizeUnderPolicy` (`policy.mjs:483-485`); `evaluateAutonomousPromotion` refuses any non-LOW (`promotion.mjs:242-249`) | STRUCTURAL |
| Cannot touch main/master | `commitCandidateToEvolutionBranch` refuses protected refs and writes only `refs/heads/evolution/<candidate>` (`promotion.mjs:99-112`) | STRUCTURAL |
| Cannot modify the production checkout during evaluation | mutation runs in a C3B worktree; the loop only reads the repo for a fingerprint | STRUCTURAL |
| Runs after the production result, off the run's stack | `scheduleCycle` yields, cycle scheduled not awaited (`production-consumer.mjs:409-430`); verified `R7` — a failing cycle leaves the run `PASS` | STRUCTURAL |
| Kill switch stops new cycles only | `readEvolutionSuspension` + env precedence (`kill-switch.mjs:41-64`); verified: `SUSPENDED` while a normal run still returned `PASS` | STRUCTURAL + VERIFIED |

### 1.2 Where the authority boundary is weaker than it reads

Three findings. None is a privilege escalation; each is a place where a
documented guarantee is weaker than the wording suggests.

**W1 — the review artifact is an in-process assertion.**
`bindEvolutionReview` (`promotion.mjs:158-186`) refuses the identities
`agent:*` and `autoloop-evolution` (`:159-161`) — a string check. The identity
and the verdict both come from deployment configuration
(`production-consumer.mjs:223` defaults `reviewVerdict` to `"PASS"`; the
declaration at
`/Volumes/NVM2T/Development/evidence/autoloop-evolution/production-declaration.json`
supplies `reviewerIdentity: "reviewer:evolution-fitness-gate"`). The same
process that runs the mutation writes the PASS artifact it later reads, and
`evaluateAutonomousPromotion` (`promotion.mjs:232`) checks the artifact's
presence and digest, not that a different principal produced it. So
"independent review" is structurally unself-approvable only in the narrow
sense that the *identity string* may not be the agent's own. It is not an
independent execution boundary. For a proposal-only mode this does not matter:
no promotion happens. For autonomous mutation it does, and it is recorded here
as a known limitation rather than repaired in this card.

**W2 — budget counters never bind in production.**
`authorizeUnderPolicy` enforces `max_mutation_runs` and
`max_evolutions_per_window` against a `usage` object (`policy.mjs:527-534`).
`runEvolutionCycle` defaults it to `{}` (`loop.mjs:305`) and the production
caller does not pass it (`production-consumer.mjs:496-518`). Effective
production limits are therefore the trigger gates (cooldown 6 h, 3 per 24 h,
`trigger.mjs:87-89`), not the policy budget. The policy's `window_ms` is
validated (`policy.mjs:127`) and never applied.

**W3 — the trigger path does not consult the synthetic declaration.**
`resolveEvolutionProductionConfig` computes `synthetic`
(`production-consumer.mjs:197-198`) and only the feed uses it
(`attribution-feed.mjs:333`). The observer receives no such flag
(`production-observer.mjs:137`) and the consumer does not re-check it. Measured:
three synthetic repair events, declared test-only in the durable payload,
produced `CYCLE_STARTED` → `PROMOTED` in a fixture repository. This is an
Evidence-Gate failure for admission purposes, not a privilege escalation — the
mutation stayed inside the fixture worktree and fixture store — but a proposal
derived from fixture data would be indistinguishable from a production one.

---

## 2. Data integrity

### 2.1 State the audit must not change — measured before and after

| Artefact | sha256 before | sha256 after | mtime |
|---|---|---|---|
| OMP binary `~/.local/bin/omp` | `fa41b27d…d24bac5` | identical | 2026-10-18 12:52:09 (+0800), 195,462,176 B |
| `~/.omp/agent/config.yml` | `108ca03c…9528d66` | identical | 2026-10-19 08:03:20 (before audit start) |
| `~/.omp/agent/mcp.json` | `032839c1…ab5a67d4` | identical | 2026-10-19 19:08 |
| `~/.omp/agent/extensions/cbm-query.js` | `03c08f43…f52b75e` | identical, and identical to the repository copy | — |
| EKM `~/.autoloop/memory/memory.db` | `0fa9dbb3…151e487c` | identical | 2026-10-18 21:53 |
| EKM journal `~/.autoloop/memory/journal.jsonl` | `c5093265…dc7c22733` | identical | 2026-08-16 21:47 |
| EKM lineage `~/.autoloop/memory/repository-aliases.json` | `bffe10d4…7c527302` | identical | 2026-10-18 23:47 |
| CBM cache `Volumes-NVM2T-…-autoloop.db` | `4fa928e4…af2a7` | read-only reference | — |
| CBM cache `private-tmp-aegis-work.db` | `99a51c25…768f0` | read-only reference | — |
| Production evolution store | 3 files, hashes `f12bea42…` / `1a8d6d57…` / `63dfa6ff…` | identical, still 3 files | 2026-09-24 |

CBM's `activity.db` is written by the MCP server on its own schedule
(19:18 mtime); this audit issued no CBM queries through the server, so that
write is not attributable to the audit. It is noted for honesty, not asserted
to be unrelated.

### 2.2 Evolution store isolation

- Every write the evolution subsystem performs is under `storeRoot`:
  `evolution-policy.json`, `evolution-trigger-state.json`,
  `evolution-candidates/`, `reviews/`, `canary/`, `strategy-policy.json`,
  `strategy-memory.json`, `attribution-feed.json`, `evolution-cycles/*.lock`.
- There is no EKM and no CBM identifier anywhere in `src/evolution`
  (`grep -rn 'cbm|ekm' src/evolution` → no matches).
- The strategy store is not imported by any runtime module outside
  `src/evolution` (`resolveProductionRoute` `strategy-store.mjs:299` has no
  production caller), so a strategy activation cannot silently change routing.
- Fixture verification: a cycle run against a fresh `mkdtemp` store and a
  `mkdtemp` git repository created only its own store files; the production
  store's three files kept their hashes.

### 2.3 Repository integrity

| Check | Result |
|---|---|
| `git status --short` (both worktrees) | empty before and after verification |
| `git branch --show-current` | `feat/omp-cbm-recovery` |
| `git log -1` | `da3a251` |
| `git rev-parse HEAD` = `@{upstream}` | `da3a2518df17b68cf1bf531dc77619c9937c4079` = `origin/feat/omp-cbm-recovery` |
| `git worktree list` | `/Volumes/NVM2T/Development/repos/autoloop` @ `8bb72a5` (audit branch), `/private/tmp/aegis-work` @ `da3a251` |
| `git stash list` | empty |
| Test residue | suite writes only to `mkdtemp` roots; repo clean afterwards |

### 2.4 What the audit itself executed

Only read paths plus fixture-isolated writes:

1. `node --test test/evolution/*.mjs` — 69/69 PASS; temp roots only.
2. Three targeted test-name patterns (`R1`, `R6`/`R7`/`R8`/`P12`) — PASS.
3. `scripts/evolution-operator.mjs --store <production store> --json` — read
   only, zero writes by design (`operator-view.mjs:1-35`).
4. `scripts/evolution-kill-switch.mjs … --status` — read only.
5. Two throwaway scripts in `/tmp` (not in the repository) that call
   `resolveEvolutionProductionConfig` and `runAdmittedGraph` against
   `mkdtemp` stores and evidence roots.
6. One throwaway script that runs `runEvolutionCycle` against a `mkdtemp`
   policy store with a fixture plan, and one that runs `deriveStrategyCandidate`
   and lists the store — both proving the persistence gap without writing to
   production state.

No production evolution cycle, no mutation against a real repository, no
policy issuance, no declaration, no kill-switch toggle, no EKM/CBM/OMP write.

---

## 3. Findings that constrain admission

| ID | Finding | Constraint |
|---|---|---|
| W1 | Review independence is a deployment-supplied string + a defaulted PASS verdict | Do not admit autonomous mutation on the strength of this review gate; proposal-only is unaffected |
| W2 | Policy budget counters unbound in production | Any admitted mode must state its real limiter (trigger gates), not the policy budget |
| W3 | Synthetic evidence excluded only by the feed | Evidence Gate fails; a proposal-only mode must refuse synthetic runs before derivation |
| D1 | Strategy proposals are never persisted | A proposal-only mode has nothing to review unless this is closed |
| D2 | No proposal-only stop exists | The loop proceeds to mutation after a PLAN |

No `FAIL — AUTHORITY_OR_DATA_INTEGRITY_VIOLATION` condition was found: no
privilege escalation, no governance-surface mutation, no EKM/CBM/OMP write, no
loss or corruption of existing evolution data.
