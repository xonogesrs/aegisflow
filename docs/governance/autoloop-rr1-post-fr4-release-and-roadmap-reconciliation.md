# AUTOLOOP-RR1 — Post-FR4 Recursive Search Restriction Release & P0–P10 Roadmap Reconciliation

Status: **PASS / AUTOLOOP_POST_FR4_SEARCH_POLICY_RELEASED_AND_P0_P10_ROADMAP_RECONCILED**

Predecessor: `RB-SSG4-FR4` (PASS).

---

## Part 1 — Workstream A: Recursive Search Restriction Release

### A0. Pre-release runtime gate — PASSED

Verified against live source, not documentation:

| Check | Result |
|---|---|
| Authoritative governor source | `src/admission/search-scope-governor.mjs` (SHA `a994f33f…`) |
| Authoritative bridge source | `src/admission/pi-command-admission.mjs` (SHA `ad2766f2…`) |
| Installed runtime copy | `~/.pi/agent/extensions/search-scope-governor/vendor/*` |
| source == vendor == installed | **DEPLOYMENT_CONVERGED** (all SHA equal) |
| Coding mode exposes structured `grep` | live diag: `DIAG_HAS_GREP=true` |
| Coding mode exposes structured `find` | live diag: `DIAG_HAS_FIND=true` |
| Bounded recursive search works | live `rg governPiCommand src` → exit 0, real output |
| Forbidden root rejects | live `grep -R x /Users/zhengfengqing` → `UNBOUNDED_HOME_TRAVERSAL` |
| Unknown root fails closed | live `grep -R x ~root` → `INDETERMINATE_SEARCH_ROOT` |
| Runtime governor active | live `bash -c 'grep -r x src'` → `UNRESOLVED_EXECUTION_STRUCTURE` |

### A1/A2. Restriction inventory + classification

Searched authoritative bounded AutoLoop/Pi locations only (no HOME/collection
recursive scans). **Finding: no active blanket prohibition of recursive search
as a capability exists.** The former default-deny was already released by FR4's
coarse guard (bounded recursive search inside the authorized root is admitted by
construction). The remaining surfaces are forbidden-root boundaries and
explicit-scope policy, not recursion bans.

| Surface | Disposition |
|---|---|
| `AGENTS.md` "Verification scope (hard rule)" | **MODIFY** — added "Search policy (post-RB-SSG4-FR4)" clarifying recursion is a normal bounded capability |
| `src/governance/verification-scope-guard.mjs` | **KEEP** — forbidden-root bootstrap guard (`/`, `$HOME`), not a recursion ban |
| `src/subagent/*` `assertAuthorizedPathsBounded` | **KEEP** — invariant-B envelope boundary |
| `src/admission/search-scope-governor.mjs` `MISSING_SEARCH_DECLARATION` | **KEEP** — explicit-scope requirement (G2/G3), not a recursion ban |
| Pi extension `promptGuidelines` ("prefer structured") | **KEEP** — steering, not prohibition |
| `docs/governance/rb-ssg2-*.md`, `rb-ssg3-*.md` | **SUPERSEDE** — marked historical; authoritative model is RC1+FR4 |
| (none) | **RETIRE** — no blanket rule existed to remove |

### A3/A4/A5. Applied mutations + post-release behavior

- `AGENTS.md`: added the post-FR4 search-policy clause (bounded = ALLOWED;
  forbidden/oversized/unresolved = REJECT/RESTATE; scope+resources+retry = governed).
- Marked `rb-ssg2`/`rb-ssg3` docs SUPERSEDED (not deleted).
- Live post-release demo (fresh `pi --mode rpc`): bounded `rg`/`grep` **work**;
  HOME, filesystem root, and `~root` **remain blocked**; unknown root fails closed.

**Workstream A verdict:**
`PASS / LEGACY_RECURSIVE_SEARCH_RESTRICTION_RETIRED_AND_FR4_BOUNDED_GOVERNANCE_ACTIVE`

> Recursive search is no longer prohibited as a capability. Bounded recursive
> search is normal supported Agent behavior.

---

## Part 2 — Workstream B: Global Roadmap Reconciliation

### B1. Authoritative sources of truth (established live)

- Repository of record: `/Volumes/NVM2T/Development/autoloop`
- Branch `governance/reversible-lifecycle-draft-pr`, HEAD `fa93f3e`
- Most recent authoritative roadmap reconciliation: `docs/pi-graph-output/checkpoint-20260809/roadmap-revalidation.md` (+ `risk-and-debt-register.md`, `capability-health-inventory.md`, `p0-rs1-controller-synthesis.md`)
- Historical capability framework: `autoloop-analysis/codex-original.md` (2026-08-02)
- Review surface: `/Users/zhengfengqing/Desktop/AutoLoop-Review/Current/delivery.json`

### B2. Roadmap authority determination

**There is no repository artifact defining an 11-phase "P0–P10" roadmap.** The
label does not correspond to any authoritative document. Two real structures
exist and are reconciled here:

1. **Capability roadmap** (`codex-original.md`): P0 standalone → P1 Pi-safe →
   P2 small-card/decomposition → P3 graph/multi-provider.
2. **Current risk register** (`checkpoint-20260809`): findings classified
   P0/P1/P2 (R-00 … R-14), with a "recommended order" and resume point.

These are two layers of the same reality, not competing definitions. The
checkpoint is the latest read-only revalidation and is treated as authoritative
for current state; codex P0–P3 is the capability axis onto which current work
maps. No `ROADMAP_AUTHORITY_CONFLICT` HOLD is required.

### B3/B4/B5/B6. Phase-by-phase status (authoritative structure)

| Phase | Frozen objective (codex) | Current state | Evidence | Remaining gap | Blocking? | Next action |
|---|---|---|---|---|---|---|
| **P0 Standalone** | independent repo, stable core API, provider-neutral runner, scripted test runner, externalized config | **DONE** (minor P1 debt) | standalone repo + `package.json`/`src`/`test`; canonical baseline pinned (`b207e20`); scripted adapter tests; RB-SSG governor self-contained | R-03: bare `pi` wrong-cwd route, launcher opt-in (folds into P1 authority seam) | no (except R-03) | fold R-03 into P1 authority card |
| **P1 Pi-safe** | Pi adapter, normalized result, permission enforcement, mutation scope e2e, repair-loop governance, reviewer independence, interruption/resume | **PARTIAL** | admission gate + budget + review-bundle/closeout + durable resume exist; P0 scratchRoot repaired & reviewer PASS (`p0-rs1`) | **P1 cluster** (below): admission not universal, budget not pre-gated, verdict authority fragmented, closeout evidence weakly bound | **YES** | one foundation card |
| **P2 Decomposition/evidence** | decomposition, final acceptance, risk grading, baseline policies, evidence provenance, negative-path | **PARTIAL** | `src/decompose-task.mjs` + schema + conformance tests; `risk-normalization.mjs`; evidence manifests; RB2/RB2R1/RB2R2 closeout enforcement | evidence lineage/verdict-apply fail-closed (R-02/R-12/R-13, shared root with P1) | partially (same root) | subsumed into P1 authority card |
| **P3 Graph/multi-provider** | graph-lite/parallel, multi-provider routing, operator UI | **PARTIAL / DEFERRED** | durable graph + durable execution exist (two stacks, P2 debt); CP-1 control-plane frozen/implemented; multi-provider & UI DROP (no demonstrated need) | two durable stacks ownership (R: P2); Agent Plugins/Central CP DROP | no | P2 cleanup later |

#### P1 authority/admission/verdict/evidence cluster (the single blocking root cause)

R-01 budget dimensions observed-after-action, not pre-gated ·
R-09 `runAutoLoop`/raw paths bypass `runAdmittedGraph` ·
R-10 memory retrieval lacks `retrieval_allowed` check ·
R-11 legacy commit/PR gates read `external-review-result.json`, not `delivery.json` ·
R-12 state-driven closeout accepts weakly-bound evidence ·
R-13 verdict-apply copies identity/SHA instead of re-hashing; forced delivery possible

**Common root cause:** production authority (admission → budget → evidence →
closeout → verdict → commit) is not one canonical fail-closed seam. This is the
checkpoint's own "Recommended order" step 5 and the real blocker to a
"fully enforced and externally accepted" claim.

### B5. Codebase Memory reconciliation

- `src/memory/*` + memory tests (incl. P4–P10 security) exist and pass.
- Production state: **KEEP DORMANT** (opt-in; no default production caller in
  allowed roots).
- Open: R-10 (retrieval authority) — P1, owned by the P1 authority card.
- No "bottom-layer protocol" work is required for the next phase; CBM is not on
  the critical path.

### B6. Runtime governance (FR4 outcomes → roadmap)

FR4 outcomes satisfy, and are not double-counted across:
- structured bounded search + coarse Bash guard → P1 execution-safety / search-scope policy.
- default timeout + resource bounds → P1 "no-progress/livelock" (checkpoint: merge into durable state).
- failed-strategy → REPLAN → P1 no-progress governance.
- deployment integrity chain → Phase R / runtime-provenance convergence.

### B7. Independent review debt

- **FR5 (FR4 verification boundary)** — the LLM-issued failing `bash` →
  `tool_call` → `tool_result` → registry path has not been exercised end-to-end.
  Recorded accurately; **not silently complete.** It is REVIEW DEBT, not a
  mainline blocker (search governance is a live, tested, bounded subsystem; the
  unverified path is narrow). Fold into the next foundation card's independent
  review, or run as a small FR5 in parallel.
- **RB-SSG4-R3** is `AWAITING_EXTERNAL_REVIEW` in `Current/delivery.json`, but is
  **SUPERSEDED by RC1+FR4** (its machinery was retired). Mark superseded; do not
  spend a review on retired machinery.
- P0 scratchRoot repair: independently reviewed PASS (done).

### B8. Foundation / mainline / review / non-blocking / legacy separation

| Class | Items |
|---|---|
| **FOUNDATION (blocking)** | P1 authority/admission/verdict/evidence seam consolidation (R-01/R-09/R-10/R-11/R-12/R-13 + R-03) |
| **PHASE WORK** | remaining P2 decomposition/evidence hardening (after the authority seam) |
| **REVIEW DEBT** | FR5 (FR4 boundary); RB-SSG4-R3 review marked superseded |
| **NON-BLOCKING DEBT** | R-04 (17 self-closeout wrappers), R-05 (`wrapGraphHooks`), R-06 (telemetry opt-in), R-07 (Colima suite cost), R-08 (Pi adapters), R-14 (bundle byte determinism), two durable stacks |
| **LEGACY / SUPERSEDED** | old RB-SSG default-deny machinery (retired in FR4), `wrapGraphHooks`, dormant Pi adapters, 17 one-shot closeout scripts, the "P0–P10" label itself |

### B9. Dependency graph

```
DONE:  P0 scratchRoot (reviewed PASS) · search governance (RC1→FR4, live) ·
       review-bundle closeout (RB2) · CP-1 control-plane (frozen+implemented) ·
       Phase R + authority/execution-truth invariants

NEXT (blocking):  [P1 AUTHORITY SEAM]  ← prerequisite for "fully enforced
                                      and externally accepted"
   └─ subsumes R-01, R-09, R-10, R-11, R-12, R-13, R-03

PARALLEL:  FR5 (FR4 independent review, small) · P2 cleanups (non-blocking)

BLOCKED BY NEXT:  P2 evidence-hardening remainder · any new mainline phase

NO LONGER BLOCKS:  P0 · search scope · RB-SSG lineage
```

### B10. Next-action selection

Exactly one next mainline action:

**Open a FOUNDATION card: "Single Authoritative Admission/Verdict/Evidence
Seam"** — consolidate the P1 cluster (R-01/R-09/R-10/R-11/R-12/R-13, plus R-03)
under one root cause. It must make `runAdmittedGraph` the one universal
production entrypoint, make budget dimensions fail-closed pre-dispatch, bind
retrieval to `retrieval_allowed`, route all commit/PR gates through
`Current/delivery.json`, and require runner-owned digest-bound closeout/verdict
evidence. FR5 (FR4 boundary) runs in parallel or folds into this card's review
boundary.

This selection is evidence-driven: the checkpoint's own resume point named the
P1 authority/budget/admission bypasses as the next blocker; FR4 closed the
search-governance foundation but did not touch this cluster.

---

## Required final inventories

### Foundation debt (unresolved, blocking)
- P1 authority seam (R-01/R-09/R-10/R-11/R-12/R-13 + R-03).

### Review debt
- FR5: FR4 LLM-issued failing-search end-to-end path.
- RB-SSG4-R3: mark superseded (retired machinery), do not review.

### Non-blocking debt
- R-04, R-05, R-06, R-07, R-08, R-14; two-durable-stack ownership; telemetry instrumentation.

### Superseded / legacy
- old RB-SSG default-deny + expansion-provenance machinery (FR4 RETIRED).
- `wrapGraphHooks`, dormant Pi adapters, 17 one-shot closeout scripts.
- "P0–P10" roadmap label (no artifact; reconciled to codex P0–P3 + checkpoint P0/P1/P2).

### Runtime / deployment truth
- Governor/bridge source == repo vendor == installed `~/.pi` (SHA-equal).
- Structured `grep`/`find` active in coding mode; coarse Bash guard live;
  default timeout + failed-strategy registry wired; deployment script
  `scripts/deploy-rb-ssg-governor.sh` idempotent.
- FR4 work is **uncommitted** on branch `governance/reversible-lifecycle-draft-pr`.

---

## Final verdict

`PASS / AUTOLOOP_POST_FR4_SEARCH_POLICY_RELEASED_AND_P0_P10_ROADMAP_RECONCILED`

1. Recursive-search restriction status: **retired** (bounded recursion is normal).
2. Authoritative policy: **Bounded Search Execution Governance** (FR4).
3. Current roadmap state: P0 DONE; P1 PARTIAL (blocking authority cluster);
   P2/P3 PARTIAL/DEFERRED (non-blocking).
4. First genuinely unfinished mainline phase: **P1 (Pi-safe) — the authority
   /admission/verdict/evidence seam**.
5. Outstanding blocking foundation work: the P1 cluster (one root cause).
6. Outstanding review debt: FR5 (FR4 boundary); RB-SSG4-R3 superseded.
7. Exact next action: **open the "Single Authoritative Admission/Verdict/
   Evidence Seam" foundation card.**

---

## Core principles (held)

- **Search:** recursion is a normal capability; govern scope + resources + retry.
- **Roadmap:** position determined from authoritative reality, not card history.
- **Execution:** understand the dependency graph before opening the next card.
