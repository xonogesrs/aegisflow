# Contributing

Thanks for considering it. AutoLoop is a community, best-effort project — see
[Support](#support) for what that means in practice.

## Before you start

**Open an issue first for anything non-trivial.** AutoLoop's whole point is
bounded, admitted change; a surprise 2000-line PR is not reviewable and will
likely be declined on that basis alone.

Small, obvious fixes (a typo, a broken link, a clear bug with a one-line fix)
are welcome as direct PRs.

## Development setup

Requirements: Node ≥ 24, npm, git. Nothing else for the host suite.

```bash
git clone https://github.com/xonogesrs/autoloop.git
cd autoloop
npm install
npm run check      # syntax-check all source
npm test           # host-only suite (no external infrastructure needed)
```

Sandbox and real-agent suites are separate and need infrastructure:

```bash
COLIMA_HOME=/path/to/colima npm run test:colima    # needs Colima + Docker
npm run test:pi                                    # needs a real `pi` install
node test/run-suite.mjs --list                     # what runs, what is excluded and why
```

**You do not need an agent runtime or a sandbox to contribute.** Most of the
governance core is testable on the host.

## Tests

- **Run the suite before opening a PR.** `npm test` must pass.
- **Add a test for behaviour you change.** AutoLoop's tests are mostly
  contract/negative tests: they assert that a fence *refuses*, not just that a
  happy path works. A change to a gate without a failing-before test is not
  reviewable.
- **Prefer negative tests.** "Holds when X" is more valuable here than "passes
  when Y".
- **Tests must be able to run in parallel and touch no shared state.** Use the
  OS temp directory. A test that writes into the checkout is a bug.
- **Never weaken a test to make a change pass.** If a gate is inconvenient,
  that is the gate working; open an issue.
- **Do not test incidental behaviour** — exact wording, internal call order,
  private field names. Those make refactoring impossible.

Useful patterns in this repository:

```bash
node --test test/governance/test-pass-oracle.mjs      # negative-heavy example
node test/run-suite.mjs --list                        # suite inventory
```

## Coding expectations

**Style**

- ES modules (`.mjs`), Node builtins only in `src/` — one runtime dependency
  (`@earendil-works/pi-ai`) and no additions without discussion.
- No new abstraction without a second caller. A helper for one call site is
  indirection, not structure.
- Comment the *why*, especially where a decision looks odd (a fence usually
  looks odd from the happy path).
- Follow the existing file conventions: a header comment stating the module's
  authority role, then the code.

**Design rules that are not negotiable**

1. **Authority is derived, never requested.** If a change lets a caller (or a
   model) *widen* a capability, scope, budget or tool set, it is wrong.
2. **Fail closed.** An unknown, missing or contradictory input produces a named
   HOLD. Never a permissive default.
3. **No silent fallbacks.** A path, identity or artifact that cannot be resolved
   is an error, not a substitute.
4. **Harness facts over model claims.** Anything evidentiary must be observed
   by the harness from the real filesystem/git object store.
5. **One owner per decision.** Do not add a second place where an authority is
   computed. Projections come from the admission record.
6. **Config is environment-driven and portable.** No absolute machine path in
   `src/` or `scripts/`. Use the resolvers in
   `src/shared/autoloop-paths.mjs`; a fresh clone must work with zero
   configuration.
7. **Secrets never enter the repository** — not in code, tests, fixtures,
   examples, docs, or commit messages. Use an obviously-synthetic sentinel in
   tests (e.g. `sk-syntheticsentinel-…`).

**Performance**

Hot paths (telemetry append, scope snapshots, evidence hashing) must stay
allocation-conscious. Do not add a full-file read or a serialization on a
per-event path.

## Scope

In scope:

- correctness of the governance core, gates, and durable layer;
- portability (the project must run from any clone on a supported host);
- documentation that describes what the code actually does;
- new agent-runtime adapters behind the existing contract;
- bug fixes with a regression test.

Out of scope without prior discussion:

- a second authority model, a parallel review framework, or a duplicate
  registry;
- adopting an external workflow engine or database tier;
- multi-tenancy, a distributed mode, or a web UI;
- widening the sandbox or the evolution risk classes;
- adding a dependency.

If you think something out-of-scope should be in scope, open an issue and make
the case with evidence. That is exactly how the durability decision was made.

## Pull request workflow

1. **Branch** from `main`. Name it descriptively
   (`fix/colima-shadow-mount`, `docs/troubleshooting`).
2. **Keep it small and single-purpose.** One concern per PR.
3. **Describe what and why**, including the failure mode you are fixing. For a
   behaviour change, state the observable difference.
4. **Include the test evidence**: the command you ran and its result. For a
   bugfix, the failing-before result matters as much as the passing-after.
5. **Update documentation** in the same PR when behaviour changes. A change to
   a configuration variable, a HOLD code, or a capability status must be
   reflected in `docs/` and, if status changed, in the README capability table.
6. **Do not mix reformatting with behaviour changes.** It makes review
   impossible.
7. **Respond to review.** Review comments here are usually about a design rule
   rather than style, so a reply that engages with the rule is faster than a
   re-push.

### What review will look for

- Does this widen any authority? (Usually the first question.)
- Does it fail closed on unknown input?
- Is there a test that would fail if the property regressed?
- Is the documentation consistent with the code?
- Does it introduce a machine-local assumption or a new dependency?

## Commit expectations

- **One logical change per commit.**
- **Imperative subject line**, ≤ 72 chars:
  `fix(sandbox): refuse a shadow mount of the configured volume`
- **Body explains why**, not what — the diff shows what. For anything touching
  a gate, state the failure mode being closed.
- **Reference the issue** (`Fixes #12`) where applicable.
- **Never commit**: credentials, `.env` files, generated evidence under the
  checkout, `node_modules/`, editor/OS litter.
- Check before pushing:

  ```bash
  npm run check && npm test
  git status --short          # nothing unexpected
  git diff --check            # no whitespace errors
  ```

## Reporting bugs

Include:

- what you ran and with what configuration (**redact credentials**);
- the HOLD code and its structured detail;
- what you expected and what happened;
- Node version, OS, and whether the sandbox was in use.

See [docs/troubleshooting.md](docs/troubleshooting.md) — several common failure
modes are already documented with their safe action, and checking there first
often resolves it.

## Reporting security issues

**Do not open a public issue.** See [SECURITY.md](SECURITY.md).

## Support

Community, best-effort. Issues and PRs are welcome; there is **no commercial
support, no SLA, and no guaranteed response time**. Please do not treat a
maintainer's silence as consent to merge your own change.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0 (see [LICENSE](LICENSE)). Do not submit code you did not
write, or code under a license incompatible with Apache-2.0 — including code
copied from a repository without a license. If you are adapting third-party
code, say so in the PR and in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
