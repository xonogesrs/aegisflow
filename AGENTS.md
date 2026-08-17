# AutoLoop — operative instructions for Pi

This file is auto-discovered by Pi (AGENTS.md/CLAUDE.md discovery) whenever
a session's working directory is this repository. It exists to close
VCA1-F1 (UNBOUNDED_VERIFICATION_SCOPE): a fresh interactive Pi session that
does not know where this repo lives will otherwise try to discover it by
searching outward from wherever it was launched, which can turn into an
unbounded scan of the real filesystem.

## Where you are

This is the AutoLoop repo. Its canonical path is:

```
/Volumes/NVM2T/Development/autoloop
```

If a task mentions AutoLoop, a card, a closeout, or an external-review
verdict and you are not already in this repo, `cd` here first. You should
not need to search for this repo's location — you were told it here.

## AUTHORITATIVE_SOURCE_FIRST (mandatory)

When you need to know AutoLoop state, read the structured authoritative
source directly. Do not answer a state question by grepping the filesystem
for a status string.

- "Is a card AWAITING_EXTERNAL_REVIEW / what's its review status?"
  → resolve the DURABLE LEDGER entry: `src/governance/review-queue.mjs`
  `readReviewQueue()` + `findEntry`（or
  `src/governance/review-bundle.mjs` `resolveAuthoritativeExternalReviewRecord`
  — ledger-first）. The Current/ delivery record is a PRESENTATION projection
  that may hold a NEWER card; it is never the verdict authority for an
  arbitrary card.
- "What's a card's closeout state / requiresReview / evidence?"
  → read `src/governance/closeout-state.mjs`'s `readCloseoutState()` against
  that card's own `outDir`.
- Anything else structured (admission, budget, evidence manifests) has an
  equivalent module under `src/governance/`, `src/admission/`, or
  `src/budget/` — read the module, don't grep for its output.

## Review routing (CURRENT-LATEST-REVIEW-PRESENTATION-SEMANTICS-1)

Mechanically distinct questions, distinct authoritative surfaces
（`scripts/gov-external-review-surface.mjs --status` prints all of them）:

- **"What is the LATEST COMPLETED formal review?"** →
  `~/Desktop/AutoLoop-Review/Current/` — the presentation surface. A task
  completion ALWAYS publishes its review to Current immediately; no verdict
  on any previous review is required, and an unresolved review NEVER blocks
  publication（publish-always）. The latest published entry carries
  `isLatestPresented: true` in the ledger.
- **"What reviews are unresolved / what is the review order?"** → the durable
  review LEDGER: `~/Desktop/AutoLoop-Review/Queue/queue.json`（`--queue`）—
  every review（PENDING awaiting verdict, REVIEWED/REPAIR/HOLD verdicts,
  ARCHIVED legacy）with ordering, supersession lineage and the presentation
  pointer. Verdicts bind the LEDGER entry by cardId + bundleIdentity +
  bundleSha256（`--rotate --verdict PASS|REPAIR|HOLD --card <id>
  --identity <hex>`）— the reviewed card does NOT need to be Current, and a
  verdict NEVER changes Current.
- **"What is the NEWEST formal review generated?"** → the Latest pointer:
  `~/Desktop/AutoLoop-Review/Queue/latest.json`（`--latest`）— navigation
  ONLY, never verdict authority.
- **"What did AutoLoop just complete / what should I read as the latest
  report?"** → the Latest Human Report:
  `~/Desktop/AutoLoop-Review/LatestHuman/latest-report.txt` +
  `latest-report.json`（`--human-latest`）— the newest completed work report
  （formal review bundle OR operator closeout）. LATEST_HUMAN != CURRENT:
  operator closeouts update LatestHuman and never touch Current; Current is
  the newest completed FORMAL review only.

Recovery: after a crash（ledger persisted but Current publish lost）,
`--promote` / `--reconcile` re-publish the NEWEST eligible formal review to
Current（never an older one）. `--migrate` deterministically migrates legacy
ledger states（QUEUED/CURRENT/RESOLVED -> PENDING/ARCHIVED）and publishes the
newest eligible review. The harness `~/Desktop/AutoLoop-Review/Latest/
review.txt` remains the execution-review domain（Domain A）— do not conflate
it with the review-queue Latest pointer or the Latest Human Report.

## Verification scope (hard rule)

Never construct or run a command whose search root is `/`, `~`, `$HOME`, or
`/Users/zhengfengqing` — including a dynamically-resolved path (e.g. a
`../..` chain, or `cd` with no argument) that lands there. Bound every
verification command's root to this repository
(`/Volumes/NVM2T/Development/autoloop`) or a path a task explicitly names.

If the evidence you need is not reachable from an authorized bounded root —
including "I don't know where the relevant file/repo/state lives" — stop and
report **HOLD / VERIFICATION_SCOPE_UNBOUNDED**. Do not widen the search root
on your own initiative to find it. Ask, or say so, instead of scanning
outward.

## Search policy (post-RB-SSG4-FR4)

Recursive search is a **normal, supported Agent capability** when bounded.

ALLOWED: `rg pattern .` / `grep -R pattern src` / `find test ...` with a
statically-concrete root inside an authorized scope (this repo, a known
source/test dir, or a path a task explicitly names), plus the structured
`grep` / `find` tools with an explicit eligible path.

GOVERNED (not prohibited): forbidden or oversized roots (`/`, `~`, `$HOME`,
`/Users`, broad collections), roots that are not statically concrete
(`~user`, `$VAR`, `$(...)`, globs), and recursive search hidden behind
unresolved execution structure — these are REJECT/RESTATE, not banned
capability. Even eligible recursive searches remain subject to default
timeout, output limits, and failed-strategy → REPLAN escalation.

The rule is **scope + resources + retry**, never "avoid recursion".

## Reference

`src/governance/verification-scope-guard.mjs` in this repo implements this
same contract in code (`checkVerificationRoot`/`assertVerificationRoot`) for
AutoLoop's own automated call sites. This file is the equivalent instruction
for you, since you are not invoked through that code path when run
interactively.
