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

- "Is a card AWAITING_EXTERNAL_REVIEW / what's its current review status?"
  → read `src/governance/review-bundle.mjs`'s `currentSurfaceReviewStatus()`
  (surface = `~/Desktop/AutoLoop-Review/Current/delivery.json`, or read that
  file directly — it holds at most one card at a time).
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
(`/Volumes/NVM2T/Development/autoloop`) or a path a task explicitly names.

If the evidence you need is not reachable from an authorized bounded root —
including "I don't know where the relevant file/repo/state lives" — stop and
report **HOLD / VERIFICATION_SCOPE_UNBOUNDED**. Do not widen the search root
on your own initiative to find it. Ask, or say so, instead of scanning
outward.

## Reference

`src/governance/verification-scope-guard.mjs` in this repo implements this
same contract in code (`checkVerificationRoot`/`assertVerificationRoot`) for
AutoLoop's own automated call sites. This file is the equivalent instruction
for you, since you are not invoked through that code path when run
interactively.
