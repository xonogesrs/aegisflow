# Publication dry run

A read-only description of what becomes visible if this repository goes from
private to public at the remediated HEAD. It changes nothing: visibility is
untouched by this card.

## Repository state

| Field | Value |
|---|---|
| Repository | `xonogesrs/autoloop` (private, not a fork) |
| Default branch | `main` |
| Remote branches | `main` + 7 `governance/*` branches |
| Tags | none |
| Local-only refs | 6 local branches, 7 `refs/parks/autoloop/*` (salvage), 1 `refs/heads/reference/*` — **not pushed, not exposed** |
| Open issues | 5 (#4–#8) |
| PRs | 4 (#1–#4; #4 open draft) |
| Workflow files | none (no CI, therefore no Actions secret surface) |

Everything below is derived from the working tree, not assumed.

## File inventory (excluding `.git/` and `node_modules/`)

| Area | Files | Size |
|---|---|---|
| `src/**` | 233 | ~5.1 MB |
| `test/**` | 264 | ~2.3 MB |
| `docs/**` | 28 | ~150 KB |
| `scripts/**` | 24 | ~200 KB |
| `benchmarks/**` | 12 + results | ~60 KB |
| `examples/**` | 4 | ~30 KB |
| `pi-extensions/**` | 3 | ~64 KB |
| root files | 10 | ~128 KB |
| **Total** | **~580** | **~8.4 MB** |

(Before remediation the tree was 1006 tracked files; 467 internal-evidence and
operational files were archived out — see
[publication-triage.md](publication-triage.md).)

## Required public files — all present

| File | Status |
|---|---|
| `README.md` | present — public landing page (what it is, capabilities with status, requirements, quick start, examples, evolution, learning, safety, configuration, docs index, honest limitations, license) |
| `LICENSE` | present — unmodified Apache-2.0 (verified: 202 lines, canonical text, placeholder copyright retained) |
| `NOTICE` | present — AutoLoop copyright + attribution only (no dependency list) |
| `THIRD_PARTY_NOTICES.md` | present — generated from the lockfile; LINKED DEPENDENCY / OPTIONAL INTEGRATION / EXTERNAL TOOL / NETWORK SERVICE; trademark and non-endorsement statement |
| `CONTRIBUTING.md` | present |
| `SECURITY.md` | present — private vulnerability reporting, no invented email |
| `.gitignore` | present — platform litter, dependencies, secrets, local AutoLoop state, generated evidence, test litter |
| `package.json` / `package-lock.json` | present — `"license": "Apache-2.0"`, `"private": true`, `engines.node >= 24`, 53 scripts |
| `examples/minimal/`, `examples/subagent/` | present — both run to completion from a clean checkout |
| `docs/` public set | present — 12 new documents + 16 frozen governance contracts |

## Absolute-path exposure at the new HEAD

| Location | Finding |
|---|---|
| `src/**`, `scripts/**`, `pi-extensions/**` | **0** occurrences of `/Volumes/NVM2T`, `/Users/<name>`, or a Desktop path. Every state root resolves through `src/shared/autoloop-paths.mjs` (env + portable default). |
| `AGENTS.md` | **0** — repository location is derived (`git rev-parse --show-toplevel` / the launcher's own path) |
| `README.md`, `docs/*.md` (15 files) | readable paths only: `$AUTOLOOP_HOME`, `~/.autoloop`, env-var names, and `/Volumes/YourVolume/...` placeholders in the preserve-behaviour recipe. **0** operator-specific paths (verified after the recipe was neutralised). |
| `test/**` | fixtures use `/Users/example-user`, `/Users/testuser`, `/autoloop-fixture/scratch`, `join(homedir(), …)` — no real operator path |
| `docs/governance/*` | **7 of the 16 frozen contracts** reference the operator's original paths in their reconciliation tables and observed-command logs. See the decision record below. |

### Residual path exposure in the frozen contracts — decision record

| Contract | Occurrences | What they are |
|---|---|---|
| `rb-ssg3-pi-runtime-enforcement-acceptance.md` | 8 | live evidence of a `$HOME`-rooted `grep` being BLOCKED |
| `autoloop-s16-telemetry-authority-location-and-retention-contract.md` | 5 | canonical-path and retention-table entries |
| `rb-ssg4-rc1-search-governance-objective-and…md` | 3 | forbidden-root proof rows |
| `rb-ssg2-pi-command-admission-coverage.md` | 3 | the observed refused command |
| `rb-ssg4-fr4-bounded-search-execution-foundation.md` | 2 | forbidden-root proof rows |
| `phase-r-teaching-case.md` | 1 | a baseline-lineage table row |
| `control-plane-ownership-contract.md` | 1 | a repo/worktree table row |

Totals: **13 occurrences of the operator's username**, **19 of absolute volume
paths**.

**DECISION: ACCEPTED_FOR_PUBLICATION — not sanitised.**

Rationale:

1. **These are frozen records, not functioning paths.** The runtime coupling the
   card requires removing is elsewhere and is gone (0 occurrences in `src/`,
   `scripts/`, `pi-extensions/`). What remains is prose that *records* where a
   past run happened.
2. **Rewriting them would falsify the record.** They are cited by name from
   source, tests and the new `docs/` set as the authoritative contract for
   behaviour the code implements. Their Phase-A tables are dated provenance: "at
   opening, HEAD was X, at path Y". Substituting a placeholder would make the
   document claim something that was not observed.
3. **Sanitising the docs while history retains the same identifier is
   inconsistent.** Git history contains the same username and paths across 163
   commits, and the card explicitly forbids history rewrite. Removing it from
   seven documents would change nothing about what a reader can learn.
4. **It is the owner's own name and their own repository.** Nothing here is a
   third party's information, and no credential is involved. Compare the audit's
   section I: 0 real secrets ever committed.
5. **The card's own standard for personal information is to decide, not to
   sanitise.** The same standard is applied here.

**If the owner decides otherwise**, the change is mechanical and reversible:
each of the seven documents has a byte-identical copy in the archive, so either
(a) genericise the identifiers in place, or (b) drop all 16 contracts from the
publication tree (they would then live only in the archive and in
`docs/governance.md`'s description of what they bind). Neither is a code change.

`docs/governance.md` is the external-facing summary of what these contracts
bind, so an external reader is not dependent on the records themselves.

## Secret exposure at the new HEAD

Full-tree scan of tracked + new files (1045 paths, binaries skipped):

| Class | Result |
|---|---|
| Real credentials | **0** |
| AWS key IDs | 4 test files — all `AKIAIOSFODNN7EXAMPLE`, the AWS documentation sample |
| GitHub tokens | 4 test files — `ghp_0123…`, `ghp_abcdef…` sentinels |
| OpenAI-style keys | 19 test files — `sk-abcdef…`, `sk-live-ABCDEF…`, `sk-thisMustNeverBePersisted`, `sk-syntheticsentinel…` |
| PEM blocks | 2 test files — fake key headers in redaction tests |
| Bearer headers | 1 test file — a `sk-live-…` sentinel |
| Generic assignments | placeholder values only (`test-only-no-key`, `tok_…`, `fabricated-secret…`) |
| `.env` files | none |
| New files (docs, examples, benchmarks, LICENSE, NOTICE, scripts) | **0 hits** |
| `node_modules/**` | matched patterns only in upstream packages' own example strings; not tracked, not redistributed |

**All 30 hits are synthetic test fixtures.** No secret is introduced by this
remediation, and none exists in the current tree.

## History exposure

Unchanged by this card (no rewrite). See the audit's section I/O:

- 2504 reachable objects, 163 commits, 0 real secrets, 0 sensitive path names
  ever committed.
- Exposes: the author's name and email in commit metadata, internal absolute
  paths in some historical blobs, internal card identifiers, and provider
  routing.

## Pushed-ref surface

Going public exposes exactly: `main`, the 7 `governance/*` remote branches, all
163 commits, all file versions, 5 open issues, 4 PRs.

**Would NOT be exposed** unless separately pushed: the 7 `refs/parks/autoloop/*`
salvage refs, `refs/heads/reference/auth1-provisional-dc51b4a`, and the three
local branches not present on the remote. Recommendation stands: do not push
them.

## Issues and PRs

Audited earlier in this remediation: no secrets, no local paths, no credentials.
They contain internal card/branch/commit narrative, which becomes public.

## Verification performed for this dry run

| Check | Result |
|---|---|
| `npm run check` (syntax, all of `src/`) | pass |
| `npm test` (host-only suite) | run — see the final report |
| `node examples/minimal/run.mjs` | exits 0, prints PASS + a refused scope violation |
| `node examples/subagent/run.mjs` | exits 0, prints the projected envelopes + fail-closed join |
| `node benchmarks/runner/run-benchmark.mjs` | executes real agent runs; see `benchmarks/results/` |
| `node scripts/autoloop-operator.mjs --run <unknown> --json` | safe `UNKNOWN` report, exit 0 |
| every documented `npm run <script>` | exists in `package.json` |
| every documented `node scripts/*.mjs` | exists on disk |
| every documented env var (43) | read by code |
| every README/doc relative link | resolves |
| `LICENSE` unmodified | verified against the canonical text |
| `THIRD_PARTY_NOTICES.md` ↔ lockfile | 93 packages, 0 unknown licenses |

## Findings surfaced while verifying

### F1 — scope projection accepts a lexical traversal string (INFORMATIONAL, no authority gained) → fixed

While verifying the README's "the agent can never widen it" claim, this was
found:

```js
projectEnvelopeFields({ admission, nodeRole: "writer", mutationScopeFromPhase: ["src/../../etc/x"] })
// → ACCEPTED, mutationScope: ["src/../../etc/x"]
```

`projectEnvelopeFields`' subset check (`withinScope`, in
`src/admission/policy-projection.mjs`) compares trailing-slash-normalised
strings, so a boundary that *starts with* the admitted prefix passes even when
it escapes it lexically.

**Why this is not an authority bypass:** the enforcement point is
`enforceScopeGate` (`src/c2d/mutation-scope.mjs`), which canonicalises before
comparing. Measured:

| Input | `canonicalRepositoryPath` | Result |
|---|---|---|
| `src/a.mjs` | `"src/a.mjs"` | allowed |
| `src/../../outside.txt` | `null` | violation |
| `/etc/passwd` | `null` | violation |
| a real write to `outside.txt` under a `[src]` scope | — | `outside_allowlist` violation |

So the projection is a *declaration* check with a lexical weakness, and the
runtime gate is the enforcement boundary and is canonical. No write escapes.

**Fixed** in `AUTOLOOP_OPEN_SOURCE_SCOPE_PROJECTION_CANONICALIZATION_REPAIR_1`.
The projection no longer compares strings: `c2d/mutation-scope.mjs` is now the
single path-canonicalization seam (`canonicalScopePath` /
`canonicalRepositoryPath` / `canonicalScopeEntry` / `isWithinCanonicalScope`),
and the admission projection, the writer-result scope validation and the
host-side writer scope verification all resolve through it and fail closed on
anything unresolvable, ambiguous, absolute, or lexically/canonically escaping.
`projectEnvelopeFields` now refuses `src/../../etc/x` outright, and
`PROJECTION_DECISION === ENFORCEMENT_DECISION` is asserted over a boundary
fixture corpus (traversal, nested traversal, absolute, dot segments, trailing
separators, globs, `.git`, untracked-yet paths, symlink-adjacent
representations) in
`test/admission/test-scope-projection-canonicalization.mjs`. No previously
legitimate scope form changed: repo-relative, worktree-relative,
trailing-separator (`src/` ≡ `src`, the existing H5 equivalence) and explicit
allowlist entries still authorize exactly what they did before.

### F2 — `AUTOLOOP_HOME` did not govern two state roots (REMEDIATION_REQUIRED → fixed)

`docs/configuration.md` claimed relocating `AUTOLOOP_HOME` moves all AutoLoop
state, but the memory store and durable checkpoint roots hardcoded
`join(homedir(), ".autoloop", ...)` and bypassed it. Fixed in this card:
both now resolve through `autoloopDefault(...)` in
`src/shared/autoloop-paths.mjs`. Verified: the default value is unchanged
(`~/.autoloop/memory`), and `AUTOLOOP_HOME=/srv/al` now yields `/srv/al/memory`.

### F3 — the benchmark's `repairs` metric measured nothing (REMEDIATION_REQUIRED → fixed)

The runner counted repair transitions with:

```js
transitions.filter((t) => t.phase === "repair" || t.status === "repair").length
```

The lifecycle runner names its transitions by **phase** (`executor`,
`reviewer`, `runner`), never `repair`, so this always reported `0` — including
for runs that had genuinely repaired. That silently understated the treatment
effect and, worse, made a 17-point success gap look like it had no mechanism.

Fixed to derive from the observed attempt count
(`repairs = executor_attempts - 1`), which is cross-checked against the raw
adapter trace. The two committed samples were re-processed with the corrected
metric, and the benchmark doc now reports the attribution evidence
(runs that actually used a repair: **1 of 35**, not 0) rather than the raw gap.

### F4 — benchmark parameter name mismatch (REMEDIATION_REQUIRED → fixed)

The benchmark read `pref.params.max_repair_attempts`, but the bounded parameter
schema (`BOUNDED_STRATEGY_PARAMS.RETRY_REPAIR`) names it `max_attempts`. A
learned preference was therefore silently unobservable. Fixed on both the read
and write side; activation now succeeds for all three dimensions.

## Not done by this card

- No commit, no push, no branch change, no tag.
- No visibility change: the repository is still private.
- No history rewrite.
- No credential rotation.
