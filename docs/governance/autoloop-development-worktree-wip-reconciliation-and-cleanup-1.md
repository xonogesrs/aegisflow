# AUTOLOOP — DEVELOPMENT WORKTREE WIP RECONCILIATION AND CLEANUP

Card: `AUTOLOOP_DEVELOPMENT_WORKTREE_WIP_RECONCILIATION_AND_CLEANUP_1`
Date: 2026-09-24
Branch: `governance/rsl2-universal-execution-review-surface`
HEAD at opening: `1473b0c991997a36fae0ffa727299e1853293f4b`
Method: INVENTORY_FIRST — inventory → classify → reconcile → cleanup → verify.
Core rule applied: **dirty ≠ garbage**. No blanket `git clean -fd`, no `git reset --hard`,
no history rewrite, no push. `UNKNOWN` was never converted into `DELETE_SAFE`.

---

## Phase A — Worktree inventory

`git worktree list --porcelain` over the canonical repo returns exactly ONE worktree; the
repo has no `.git/worktrees` directory (no linked worktrees exist).

| # | PATH | BRANCH | HEAD | TRACKING | AHEAD/BEHIND | STAGED | MODIFIED | UNTRACKED | STASH | LOCKED/PRUNABLE |
|---|---|---|---|---|---|---|---|---|---|---|
| W1 | `/Volumes/NVM2T/Development/repos/autoloop` | `governance/rsl2-universal-execution-review-surface` | `1473b0c9` | none (remote `origin/<same branch>` exists at `1473b0c9`) | 8 / 0 vs `origin/<same branch>` | 0 | 3 | 188 (130 probe JSON + 58 `rrc/`) | 0 | not locked / not prunable |

`git worktree prune -n -v` → no candidates. Ignored paths in W1: `.DS_Store` (3), `node_modules/`
— all expected build/OS artifacts, untouched.

Adjacent AutoLoop-named checkouts (inventoried, **out of canonical scope**, not modified):

| PATH | IDENTITY | STATE | CLASS |
|---|---|---|---|
| `/Volumes/NVM2T/Development/autoloop-dsh-plugin` | own repo, `master` @ `c1c8315` | clean, no worktrees, no stash | PRESERVE (separate project) |
| `/Volumes/NVM2T/Development/autoloop-omp-pilot-{real-task-trial-1,2,3,raw-bash-trial-1}/{trial-a,trial-b}` | **8 git worktrees of `/Users/zhengfengqing/auracore`** (the `aura` repo), detached `30d70d1f` | each 70 MB, 6 untracked `ios/AuracoreGo/*` (pilot deliverable, unique) | PRESERVE (another repo's worktrees; unique WIP; stale-proof unavailable) |
| `/Volumes/NVM2T/Development/autoloop-omp-pilot` | non-git pilot workspace (`MANIFEST.sha256`, `evidence/`, `lib/`, `runtime/`) | `runtime/` has pilot runs dated 2026-09-24 (recent) | PRESERVE — ACTIVE (recent activity) |
| `/Volumes/NVM2T/Development/autoloop-omp-pilot-fence-repair-1` | non-git closed pilot evidence (`VERDICT.md`, `CLOSING-STATE.md`, `MANIFEST.sha256`) | `PILOT_STATE = OFF`, closed, `COMMIT = NO` | PRESERVE (closed evidence record) |

No stale worktree satisfied the removal condition (clean or reconciled **and** branch/commit
safe **and** no unique WIP **and** no active process dependency **and** not a canonical route);
`STALE_WORKTREES_REMOVED = 0`. `BRANCH_DELETE = NO` (no branch removed).

## Phase B/C — Dirty content inventory and provenance reconciliation

W1 dirty set at opening, grouped (never enumerated per-file in the record):

| Group | Paths | Size | Provenance (verified) |
|---|---|---|---|
| G1 pre-WP1 probe evidence | `docs/pi-graph-output/pre-wp1-probe-*.json` (31) | 130 files, 656 KB total | `scripts/multi-session-pre-wp1-probe.mjs` runs; mtimes 2026-09-21…23 |
| G2 WP1 Phase F/G/H/J/L probe evidence | `docs/pi-graph-output/wp1-{f-continuity,g-multihop,h-fanout,j-adversarial,l-bounds-l}-*.json` (99) | (same 656 KB) | WP1 multi-session probes (WP1 FINAL_CLOSED) |
| G3 RUNG-7 journal forensics | `rrc/**` (58: `section-03..21`, `workers/`, `review1/`, `out/`) | 544 KB | RRC rung probes, mtime 2026-09-22T17:17 |
| G4 AUTH1 g0002 review-job binding | `docs/pi-graph-output/autoloop-auth1/review-job.json` (modified) | 1.6 KB | AUTH1 review generation 2 |
| G5 R-11 manifestation narrative | `docs/pi-graph-output/checkpoint-20260809/risk-and-debt-register.md` (modified) | +26 lines | AUTH1 promotion, 2026-08-16 |
| G6 RLD2 re-capture | `docs/pi-graph-output/rld2/rld2-reproduction.json` (modified) | 14 lines | 2026-09-19 reproduction re-run |

Checks performed on every group:

- **Blob reachability** — `git rev-list --all --objects` vs `git hash-object` per path: all 188
  untracked blobs are **UNREACHABLE** (unique; no duplicate of committed content). The 3 modified
  worktree blobs (`a8e400a7`, `f2e2d9f0`, `b5186430`) are likewise not in history.
- **Content duplication (E)** — G5's narrative is already carried by the tracked record
  `docs/pi-graph-output/autoloop-auth1/promotion-reconciliation-20260816.md` (§1–§3: bundle
  `aab376bb…`/`93f0002b…`, `PUSH_GATE_RETIRED_ARTIFACT_DEPENDENCY_DISCOVERED`, R-11 P1, PGMA1
  dependency, `assertScopeCoversInventory`, PR #4) and by the register's own `R-11 | CLOSED` row
  → `ALREADY_LANDED`. G6 differs from the tracked capture only in `capturedAtUtc`/`attemptedAt`/
  `surfaceDir` metadata (identical scenario results).
- **Digest binding (G4)** — the worktree `review-job.json` (g0002) has
  `findingsDigest 6e08b91c…` == sha256 of the tracked `review-findings.g0002.json`, and
  `verdictDigest b4435406…` == sha256 of the tracked `review-verdict.g0002.json`; its
  `priorFindingsDigest 8a138cc0…` / `priorVerdictDigest 5515075d…` == the tracked g0001 pair.
  Tracked state carried a **g0001** job record next to **g0002** artifacts — internally
  inconsistent.
- **Prior intent (C)** — landed records that explicitly govern this WIP:
  `docs/pi-graph-output/autoloop-background-dedup-audit-1.md` (names all three G4/G5/G6 files as
  preserved byte-stable WIP), `docs/governance/autoloop-s16-telemetry-authority-location-and-retention-contract.md`
  (G3 = surface #21, FORENSIC R4; G1/G2 = surface #13, EVIDENCE R3 "retained by git"),
  `docs/governance/autoloop-post-wp1-roadmap-reconciliation-and-semantic-drift-gate.md` (G3
  "preserve as evidence, do not land"), `docs/pi-graph-output/checkpoint-20260809/dirty-tree-attribution.md`
  (checkpoint-scoped "do not clean/stash/revert/commit" instruction, 2026-08-09).
- **Convention (F)** — probe evidence landing is the repo's established pattern: commits
  `d551c52` ("land probe evidence history — Phase F/G/H/J/L intermediate and final verification
  artifacts", 12 files) and `ac8bfa5` (5 files); 240 `docs/pi-graph-output` files were already
  tracked. R3 probe evidence is a git-retained class in its canonical location.
- **Secrets (G/L)** — pattern scan (GitHub PAT/`ghp_`, `sk-`, AWS `AKIA`/secret key, PEM private
  key, bearer token, `"password"`/`"apiKey"`) over `rrc/**` and all probe JSONs: **0 matches**.
- **JSON validity** — all 130 probe JSONs parse (`json.load`): 0 invalid.
- **Coupling (H)** — no tracked file imports, executes or path-references `rrc/**`; the
  `test/learning/lifecycle/test-rrc-separation.mjs` name collision is unrelated (it scans
  `test/learning/lifecycle` only). `git check-ignore` on both dirty groups: not ignored.

## Phase D/E — Classification

| Group | Class | Basis |
|---|---|---|
| G1, G2 | **LAND** | `VALID_UNLANDED_WORK`: R3 evidence, canonical location = repo tree, retention "by git"; unique blobs; closed WP1/pre-WP1 card family; landing is the established convention |
| G3 | **ARCHIVE** | R4 FORENSIC; frozen contract requires explicit promotion + an explicit retirement authority (this card, section G); contract's location table places `rrc/`-class outputs in ARCHIVE/FORENSIC surfaces, not the repo |
| G4 | **LAND** | `VALID_UNLANDED_WORK`: the attribution record for the landed AUTH1 g0002 artifacts; digest-verified; landing repairs the tracked g0001-job/g0002-artifact inconsistency |
| G5 | **ARCHIVE** (`ALREADY_LANDED` content) | narrative already in the tracked promotion-reconciliation record and the register's `R-11 | CLOSED` row |
| G6 | **ARCHIVE** | re-run evidence of a closed card, unowned by any card; landing would overwrite the closed RLD2 card's capture-time metadata |

`DELETE_SAFE = 0`, `UNKNOWN_HOLD = 0`, `PRESERVE_UNCOMMITTED = 0` (canonical repo).

## Phase F — Landings (2 commits, no push)

| Commit | Content | Verification |
|---|---|---|
| `0165afa` | `docs(evidence): … — land probe evidence history (130 pre-WP1 / Phase F/G/H/J/L probe outputs)` — 130 files, 12 070 insertions | `git show --stat`, all paths under `docs/pi-graph-output/` |
| `7af9b53` | `docs(attribution): … — record the landed AUTH1 g0002 review-job binding` — 1 file | digest binding recomputed: findings/verdict/prior digests match the tracked g0001/g0002 artifacts |

No unrelated WIP was mixed into either commit; historical commits were not squashed, rebased or
amended.

## Phase G — Archive (byte-verified)

Archive root (mount-gated authoritative evidence root):
`/Volumes/NVM2T/Development/evidence/autoloop/AUTOLOOP_DEVELOPMENT_WORKTREE_WIP_RECONCILIATION_AND_CLEANUP_1-20260924`

| Content | Files | Bytes |
|---|---|---|
| `rrc-forensics/rrc/**` (G3) | 58 | 544 KB |
| `reconciled-worktree-versions/risk-and-debt-register.worktree-20260809-checkpoint.md` (G5) | 1 | 8 KB |
| `reconciled-worktree-versions/rld2-reproduction.worktree-20260919-recapture.json` (G6) | 1 | 15 KB |
| `PROVENANCE.md` | 1 | — |
| `MANIFEST.sha256` | 61 entries | sha256 of MANIFEST = `4a04a24b9473a038bfe433878e5a427830f542514c4c52e7bba2e184bb9d1f0e` |

Byte-identity verified before any deletion/restore: source-vs-archive sha256 listing diff =
identical (58/58 for `rrc/`; both single files byte-identical). No secret entered the archive
(scan above). Provenance kept: origin path, source repo/branch/HEAD, probe/card identity, mtime,
`R4` retention class, and a restore recipe (`PROVENANCE.md` §3).

## Phase H — Safe cleanup

`DELETE_MANIFEST` (emitted before deletion):

```
TARGET_SET : rrc/ (58 untracked files)
REASON     : ARCHIVE class — byte-identical copy verified in the evidence root (58/58)
ARCHIVE    : <archive root>/rrc-forensics/rrc
METHOD     : targeted `rm -rf rrc` (NOT `git clean -fd`)
```

After the archive verified: `rm -rf rrc` executed, and the two content-duplicate tracked files
(G5, G6) were restored to HEAD with a targeted `git restore -- <2 paths>` after their worktree
bytes were archived. No `git clean -fd`, no `git reset --hard`, no `git stash`, no blind
recursive deletion; untracked-and-unverified content was never removed.

## Phase I/J — Stale worktrees and stash audit

`STALE_WORKTREES_REMOVED = 0` (see Phase A). Stash: `git stash list` in the canonical repo →
**empty** (`STASHES_FOUND = 0`, `STASHES_DROPPED = 0`). Adjacent checkouts hold 3 stashes on the
`aura` repo worktrees — out of canonical scope, untouched.

## Phase K — Final cleanliness

```
$ git status --porcelain -uall     → (empty)               DIRTY = NO
$ git worktree list --porcelain    → 1 worktree (canonical)
$ git stash list                   → (empty)
$ git rev-list --left-right --count HEAD...origin/governance/rsl2-universal-execution-review-surface
                                   → 11  0                 (ahead 11, behind 0)
```

`DEVELOPMENT_WORKTREE_STATE = CLEAN`. Remaining dirty worktrees: 0 in canonical scope; the
adjacent out-of-scope checkouts listed in Phase A remain preserved by design and are reported,
not silently cleaned.

## Phase L — Verification

- `npm run test:governance` → **573 pass / 0 fail** (identical to the pre-change baseline 573/0).
- `npm run test:lifecycle` → **172 pass / 0 fail** (identical to baseline 172/0).
- Both suites were baselined before any mutation and re-run after the landings, the archive and
  the removals; no regression from the added evidence files or the removed forensic tree.
- Archive integrity re-verified post-mutation via `MANIFEST.sha256`.

Integrity invariants:

```
NO_VALID_WIP_LOST           = YES   (G1/G2/G4 landed; G3/G5/G6 archived byte-identical)
NO_UNIQUE_EVIDENCE_LOST     = YES   (every unique blob is now tracked or archived; hashes verified)
NO_SECRET_ARCHIVED          = YES   (0 secret-pattern matches)
NO_UNRELATED_HISTORY_REWRITE= YES   (2 additive commits; no squash/rebase/amend)
NO_RESET_HARD               = YES
NO_BLIND_GIT_CLEAN          = YES
PUSH                        = NO
BRANCH_DELETE               = NO
UNKNOWN                     = 0
```

## Verdict

```
CARD   = AUTOLOOP_DEVELOPMENT_WORKTREE_WIP_RECONCILIATION_AND_CLEANUP_1
VERDICT= PASS
DEVELOPMENT_WORKTREE_STATE = CLEAN
NEXT   = NORMAL_OPERATION
```
