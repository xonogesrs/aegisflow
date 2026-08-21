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
/Volumes/NVM2T/Development/repos/autoloop
```

If a task mentions AutoLoop, a card, a closeout, or an external-review
verdict and you are not already in this repo, `cd` here first. You should
not need to search for this repo's location — you were told it here.

## AUTHORITATIVE_SOURCE_FIRST (mandatory)

When you need to know AutoLoop state, read the structured authoritative
source directly. Do not answer a state question by grepping the filesystem
for a status string.

- "What's the latest formal execution's review?" (the FIXED human-facing
  entrypoint for a just-finished execution) → read
  `~/Desktop/AutoLoop-Review/Latest/review.txt` directly — the most recent
  execution review; every previous one rotates into
  `~/Desktop/AutoLoop-Review/Latest/archive/`. Structured answer:
  `node scripts/gov-execution-review.mjs --status`. This is Domain A
  (`LATEST_EXECUTION_REVIEW`, `src/governance/execution-review.mjs`).
- "Is a card AWAITING_EXTERNAL_REVIEW / what's the external-review inbox
  status?" (a DIFFERENT question — the unresolved external review awaiting a
  verdict) → read `src/governance/review-bundle.mjs`'s
  `currentSurfaceReviewStatus()` (surface =
  `~/Desktop/AutoLoop-Review/Current/delivery.json`, or read that file
  directly — it holds at most one card at a time). A pending inbox occupant
  never blocks the Latest execution review, and vice versa.
- "What's a card's closeout state / requiresReview / evidence?"
  → read `src/governance/closeout-state.mjs`'s `readCloseoutState()` against
  that card's own `outDir`.
- Anything else structured (admission, budget, evidence manifests) has an
  equivalent module under `src/governance/`, `src/admission/`, or
  `src/budget/` — read the module, don't grep for its output.

## Verification scope (hard rule)

Never construct or run a command whose search root is `/`, `~`, `$HOME`, or
`/Users/zhengfengqing` — including a dynamically-resolved path (e.g. a
`../..` chain, or `cd` with no argument) that lands there. Bound every
verification command's root to this repository
(`/Volumes/NVM2T/Development/repos/autoloop`) or a path a task explicitly names.

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
