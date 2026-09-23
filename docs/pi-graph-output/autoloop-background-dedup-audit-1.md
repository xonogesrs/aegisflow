CARD = AUTOLOOP_BACKGROUND_DEDUP_AUDIT_1
MODE = AUDIT_ONLY
CANONICAL_REPO = /Volumes/NVM2T/Development/repos/autoloop
BRANCH = governance/rsl2-universal-execution-review-surface
HEAD_AT_AUDIT = 3951ed2917080ef12442f5bf37515ab522306eed

## Pre-audit reconciliation
- Repo identity: PASS (origin git@github.com:xonogesrs/autoloop.git, toplevel matches CANONICAL_REPO).
- Branch: PASS (governance/rsl2-universal-execution-review-surface).
- HEAD recorded: 3951ed2.
- WIP reconciled, preserved untouched: 122 untracked paths + 3 modified tracked files
  (docs/pi-graph-output/autoloop-auth1/review-job.json,
   docs/pi-graph-output/checkpoint-20260809/risk-and-debt-register.md,
   docs/pi-graph-output/rld2/rld2-reproduction.json). Diffs re-verified identical after audit.
- Stashes: 0. No reset/clean/delete/push performed. UNRELATED_MUTATION = NO. REMOTE_MUTATION = NO. COMMIT = NO.

## Evidence source
Primary evidence = OMP harness session transcript
~/.omp/agent/sessions/--private-tmp--/2026-09-22T22-37-55-369Z_01a0cb44-bf29-7000-8396-5f0bcb312637.jsonl
(the AUTOLOOP_PRODUCT_STAGE_FINAL_CLOSEOUT_AND_RELEASE_READINESS_1 session, 2026-09-22T22:37Z → 23:42Z,
1164 lines). This is the multi-card AutoLoop session whose stale-echo symptom the defect card reports.
Instrumentation = forensic replay of that transcript (bash toolCall records, tool_execution_start
events, async-result delivery events with jobId/durationMs/label, assistant verdict texts).
No repo code was modified to instrument; counters derive from the harness's own durable event log.

## Findings

### Class 1 — WAITER_DUPLICATION (dominant)
- 37 sleep-wait background jobs were issued across the session (total 11,945 waiter-seconds of idle
  poll work) to "watch" 6 distinct logical work items (colima-all run, writeback run, closeout
  integration run, WP1-F E2E, WP1-G multihop, WP1-H fan-out).
- Peak concurrency per logical work item: colima-suite waits max 8 concurrent, wp1-h max 5,
  closeout 2, wp1-g 2. Excess concurrent waiters at peaks = 12.
- Every waiter is itself a background job; each fired its own completion notification. The 4
  notifications arriving after the final verdict (23:38:30 bg_2, 23:39:36 bg_6, 23:40:42 bg_10,
  23:42:45 bg_4) are exactly these redundant waiters draining late — each was a `sleep N; ps…`
  poll on the WP1-H fan-out probe that had already delivered its real result at 23:35:45.
- Per-consumer consumption fence HELD: no single logical consumer received the same terminal result
  twice (each of the 4 stale deliveries came from a distinct waiter). The defect card's phrasing
  ("already incorporated", "verdict unchanged") matches: the result was correct and singular; the
  waiters were redundant.
- The repo already carries the institutional fix attempt: AGENTS.md "Background jobs — never poll"
  rule (observed incident 2026-09-20) + harness extension ~/.omp/agent/extensions/no-poll-waits.js
  blocking sleep-only async jobs. The 2026-09-22 session bypassed it via the documented loophole:
  `sleep N; <status check>` compound commands whose second segment (ps/grep/ls) is not a bare sleep,
  i.e. poll jobs with a status-check tail that the extension's POLL_CHECK_CMDS segmentation treats
  as legitimate. The rule was also stated but not mechanically enforced mid-session: the agent kept
  re-issuing waits instead of yielding (root behavioral seam).

### Class 2 — SHARED_RESOURCE_CONCURRENCY (secondary, distinct)
- Two DIFFERENT logical work items collided on the shared `autoloop-graph` Colima profile:
  1. bg_44 `test:colima-all` (22:39:52 → 22:57:19, 1044s) overlapped bg_47 `test:writeback`
     (22:40:04 → 22:45:26, 311s). bg_47 was issued as a FOREGROUND call (async=None, timeout=1200)
     and was auto-backgrounded by the harness — the agent did not intend a concurrent run. bg_47
     failed with mount-fingerprint mismatch (desired 02b4f74a… vs runtime 6866191b…), the documented
     CONCURRENT-graph-runs failure signature (AGENTS.md / S16 reconciliation: mount generation
     interleave under overlapping runs).
  2. bg_44 also overlapped bg_70 WP1-F E2E probe (22:47:15 → 22:47:38, 22s), which failed
     GRAPH_EXCEPTION:ColimaRuntimeError.
- These are NOT execution duplication: each was a legitimately distinct logical work item. The seam
  is missing single-flight/serialization on the shared profile at the orchestration layer.
- Note: one true execution duplication exists — test:colima-all was launched twice ~16s apart
  (22:39:36 without COLIMA_HOME → failed fast in 4s; 22:39:52 with canonical COLIMA_HOME). The first
  was a config mistake (missing env), failed before reaching ensureInstance, so no profile overlap
  resulted; counted as 1 duplicate execution, benign.

### LOGICAL_WORK_ID_MODEL = INSUFFICIENT
- The harness assigns only per-session job ids (bg_N). There is no stable logical work identity:
  8 expensive async executions and 37 waiters carry no linkage to the work item they watch. The
  wait→notify chain is purely the agent's discipline, unenforced by the runtime. Without
  LOGICAL_WORK_ID, directions A/C/D/E cannot attach.

## Counters (measured over the audited session)
DUPLICATE_EXECUTION_COUNT = 1 (colima-all double launch, benign fast-fail)
DUPLICATE_EXPENSIVE_EXECUTION_COUNT = 2 (concurrent-profile overlaps: bg_44×bg_47, bg_44×bg_70;
  distinct logical items — SHARED_RESOURCE_CONCURRENCY class, not duplication of one work item)
DUPLICATE_WAITER_COUNT = 12 (peak excess concurrent waiters across logical targets)
DUPLICATE_NOTIFICATION_COUNT = 0 (per-consumer fence held; no consumer received a result twice)
STALE_POST_TERMINAL_POLLS = 4 (post-verdict waiter drains: bg_2, bg_6, bg_10, bg_4)

## VERDICT = PASS (audit completed; classification achieved)
DOMINANT_WASTE_CLASS = WAITER_DUPLICATION (primary waste: 37 waiter jobs / 11,945 idle seconds /
  4 stale post-terminal deliveries) with secondary SHARED_RESOURCE_CONCURRENCY (2 profile overlaps,
  2 real suite failures: fingerprint mismatch, ColimaRuntimeError). NOTIFICATION_DUPLICATION and
  EXECUTION_DUPLICATION are ruled out as dominant classes by evidence.
ROOT_CAUSE_SEAM =
  1. Harness background-job lifecycle: no logical-work identity or waiter coalescing; each
     `sleep N; <check>` waiter is an independent bg job with its own terminal notification
     (lifecycle steps 3/4/7 of the card's map — registration, ownership, cancellation).
  2. no-poll-waits.js segmentation loophole: status-check-tailed sleeps pass the poll filter.
  3. Orchestration layer: no single-flight/serialization on the shared autoloop-graph profile;
     auto-backgrounded foreground calls can silently join the contending set (lifecycle step 1).
SELECTED_REPAIR_DIRECTIONS = C, D, E, F, G (A/B deferred: they require LOGICAL_WORK_ID plumbing;
  C/E deliver the waiter/notification win with the least surface; F/G close the profile class.
  A+B are the follow-on once identity exists.)
RELEASE_BLOCKER = NO
UNRELATED_MUTATION = NO
REMOTE_MUTATION = NO
COMMIT = NO
PUSH = NO
NEXT_CANONICAL_TASK = AUTOLOOP_RELEASE_CANDIDATE_FREEZE_AND_DEPLOYMENT_1
POST_RELEASE_TASK = AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_PROFILE_SINGLEFLIGHT_1
  (scope: waiter coalescing on logical work id at harness seam; consumption fence per consumer;
  terminal cancellation of outstanding redundant waiters; no-poll-waits segmentation fix for
  status-check-tailed sleeps; single-flight lock on autoloop-graph profile mutating operations,
  covering auto-backgrounded foreground calls; acceptance targets carried unchanged from the
  defect card: AUTHORITATIVE_EXECUTIONS=1, TERMINAL_RESULTS=1, DUPLICATE_EXPENSIVE_EXECUTIONS=0,
  STALE_POST_TERMINAL_POLLS=0.)

## POST_RELEASE_TASK implementation record (2026-09-23, same day)

AUTOLOOP_BACKGROUND_WAITER_COALESCING_AND_PROFILE_SINGLEFLIGHT_1 executed against this
canonical repo. Scope: C/D/E/F/G + no-poll-waits segmentation fix; A/B DEFERRED per card
(no LOGICAL_WORK_ID invented).

Landed (UNCOMMITTED, on governance/rsl2-universal-execution-review-surface @ 3951ed2):

1. F/G — `src/runtime/colima-profile-lock.mjs` (NEW): per-profile single-flight lock.
   Standalone module (no colima-runtime import — E1/E2 shim link-safety); identity = profile
   (machine-level shared state, repository-mutation-lock affinity discipline); non-blocking
   acquire; contention → `HOLD / COLIMA_PROFILE_BUSY` naming the live holder; unowned
   profile → `COLIMA_PROFILE_LOCK_NOT_TEST_OWNED` (mirrors AUTOLOOP_TEST_PROFILES fence,
   parity asserted by test); crash recovery through c2d/lock.mjs forensic orphan reclaim
   (same-host dead-pid reclaims, cross-host never); unforgeable release capability
   (WeakMap, copied handles refused). Lock root: canonical runtime home `/autoloop-locks/`
   (env override AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT for test isolation).
2. F/G wiring — `runColimaGraph` (colima-graph-runner.mjs) and `runColimaTask`
   (colima-pipeline.mjs) hold the lock from BEFORE the instance reconcile until terminal
   cleanup; release in finally on every terminal path (PASS/HOLD/exception); a release
   failure is recorded on the result (`profileLockRelease`) and never masks the verdict.
   Ordering invariant inside runColimaGraph: scratch-namespace VALIDATION first (P0-RS1
   ScratchOwnershipError contract preserved), then lock (zero filesystem effect on busy),
   then owned-child creation + machine work. All production routes (colima/subagent/
   durable via runAdmittedGraph; c3 pipeline; 18 probe scripts) funnel through these two
   seams — one lock surface, no per-caller plumbing.
3. E1/E2 shim parity — `test/v2/helpers/e1-runtime-shim.mjs` and
   `e2-engine-runtime-shim.mjs` gained inert lock stubs (isolation rule 3: zero VM
   lifecycle ⇒ zero profile contention; no real lock file under isolation).
4. ALSO_FIX — `~/.omp/agent/extensions/no-poll-waits.js` (harness-owned, like AGENTS.md
   documents): pipeline stages (grep/awk/sort/uniq/… pure output filters) now count as
   pure status checks, closing the segmentation loophole. The 2026-09-22 incident's
   actual waiter shapes (`sleep N; ps aux | grep … | grep -v grep | wc -l; ls -t … |
   head -1`) are now BLOCKED; real work (`sleep N; npm run …`, wait loops, write
   redirects, `sed -i`) still passes; foreground untouched. Verified 10/10 cases
   against the extension hook.
5. Tests — `test/test-colima-runtime.mjs` +6 F/G tests (parity, path, unowned refusal,
   single-flight + distinct-profile independence, release/capability semantics,
   same-host reclaim + cross-host refusal): 44/44 (canonical COLIMA_HOME), lock tests
   env-independent.
6. Docs — AGENTS.md "Background jobs — never poll" section updated (filter coverage +
   enforced single-flight).

Acceptance mapping:
- STALE_POST_TERMINAL_POLLS = 0 going forward: the guard blocks new redundant poll
  waiters at the seam; existing per-consumer fence (audit: held) unchanged.
- REDUNDANT_WAITER_COUNT = 0 new: no poll waiter passes the fixed filter.
- DUPLICATE_NOTIFICATION_COUNT = 0: unchanged fence + no redundant waiters to drain.
- INCOMPATIBLE_COLIMA_PROFILE_OVERLAPS = 0: enforced by the lock (live-proven:
  cross-process holder → child fails closed with COLIMA_PROFILE_BUSY before any
  machine action; free lock → run proceeds).
- NO_POLL_GUARD_BYPASS = 0: verified against the incident's exact commands.
- NON-GOAL honored: distinct profiles (w1/w2) never contend (test-pinned); independent
  work is not serialized.

Regression evidence (canonical COLIMA_HOME unless noted): colima-runtime 44/44 (38
pre-existing + 6 new); admission graph-wiring 5/5 (with and without COLIMA_HOME);
scratch-ownership 6/6; memory graph-context 7/7; telemetry graph-invariance 4/4;
writeback-graph 8/8; telemetry production-instrumentation 19/19; v2
decomposition-manifest 16/16 (real graph path through the lock); v2 durable-graph 19/19;
E1 human-mutation-soak 21/21 (shimmed); E2 reboot-soak-crossproc 3/3 (shimmed);
graph-closeout-integration 3/3; subagent-graph 5/5. Pre-existing environment-only
failures (tool-selection production-wiring 12, without canonical COLIMA_HOME some R2A28
rows) reproduce identically at baseline HEAD 3951ed2 — untouched by this card.

Pre-existing WIP preserved byte-stable through the whole card (diff stats 45+/17−
identical at audit start and card end): review-job.json (g0002 binding),
risk-and-debt-register.md (R-11 note), rld2-reproduction.json (2026-09-19 re-capture).
COMMIT = NO. PUSH = NO.
