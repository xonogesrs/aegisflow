# RB-SSG4-RC1 — Search Governance Objective & Enforcement Boundary Reconciliation

Status: **RB_SSG_SEARCH_GOVERNANCE_OBJECTIVE_AND_ENFORCEMENT_BOUNDARY_RECONCILED**

Verdict: **PASS**

Card: `RB-SSG4-RC1` (Architecture / Foundation Reconciliation — no production mutation).

Scope note: this document is the RC1 closeout artifact. It freezes the objective
and enforcement boundary, formally disposes FR3, and classifies the existing
RB-SSG machinery. It does NOT implement the new model; that is the next card's
scope (see §14).

---

## 1. Verdict

`PASS / RB_SSG_SEARCH_GOVERNANCE_OBJECTIVE_AND_ENFORCEMENT_BOUNDARY_RECONCILED`

The authoritative execution architecture was established from live source (not
old documentation), all fourteen questions are answerable, and one authoritative
model is selected. The remaining step is an implementation card (RB-SSG4-FR4)
written against the frozen boundary below — no unresolved architectural
decisions remain.

---

## 2. Frozen Objective

RB-SSG SHALL provide **Bounded Search Execution Governance**:

> Recursive filesystem search remains available to Agents, but its scope,
> resource consumption, and retry behavior must remain bounded and governable.

RB-SSG SHALL NOT require Pi/AutoLoop to become a general-purpose shell
interpreter.

The original operational harm to prevent (frozen):

> An Agent issues recursive searches over excessively broad filesystem scopes,
> causing long execution time, high CPU use, excessive output/context
> consumption, or repeated no-progress traversal.

---

## 3. Frozen Non-Goals

RB-SSG does **not** guarantee, unless separately justified:

- complete Bash/Zsh semantic interpretation
- arbitrary variable-expansion evaluation
- arbitrary command-substitution evaluation
- exact wrapper semantic equivalence
- universal quote/re-tokenization equivalence
- exact resolution of every tilde form
- arbitrary nested `sh -c` reconstruction
- proof of arbitrary runtime-computed filesystem paths

If a recursive root cannot be statically established as acceptable, the
behavior is **reject or require an explicit bounded root** — never infer shell
runtime semantics.

---

## 4. FR3 Disposition

`VALID_FINDINGS / REPAIR_DIRECTION_PENDING_OBJECTIVE_RECONCILIATION` →
**RECONCILED** by this card. FR3 is not marked false or ignored.

Confirmed by read-only diagnostic against BOTH the installed vendor copy and
the latest repo source (§12 appendix):

1. **`~user` / `~root` / `~user/path` tilde expansion** — `normalizeSearchPath`
   resolves only `~`, `~/…`, `$HOME`, `${HOME}`. A named-user tilde is treated
   as a concrete cwd-relative path and admitted (`SAFE_BOUNDED` / allowlist),
   while the shell expands it to a forbidden root. **This is valid against the
   latest repo source**, not merely the stale vendor copy.
2. **Wrapper / `find -exec` / `bash -c` re-tokenization loses runtime-expansion
   provenance** — the execution-extraction pipeline (`rejoinTokens` →
   re-parse) carries the `~user` token through wrappers, `sh -c`, `find -exec`
   without ever marking it as "shell expansion pending", so the bypass survives
   indirection.

Both prove the same root cause: **unknown path provenance is classified as a
concrete bounded path and dropped into the ADMIT lane**. The prior
provenance-preservation repair direction is therefore **paused/retired**, not
extended. FR3 is closed as *superseded by boundary change*, not as *syntax
repaired*.

---

## 5. Discovery — Live Execution Chain

Source of truth inspected live (not inferred):

| # | Stage | Owner | Data representation | Policy authority | Scope info | Runtime info | Boundary |
|---|-------|-------|---------------------|------------------|-------------|--------------|----------|
| 1 | Agent intent | LLM | tool call (`bash` string / structured tool params) | none | raw command string | none | — |
| 2 | Pi tool selection | Pi core (`dist/core/tools/index.js`) | `allToolNames = {read,bash,edit,write,grep,find,ls}` | toolset config | tool-specific | none | tool availability |
| 3 | Bash tool admission | extension `~/.pi/agent/extensions/search-scope-governor/index.ts` → `pi.on("tool_call")` | `{command, cwd}` | governor (static) | parsed roots | none | pre-spawn block/rewrite |
| 4 | `user_bash` (`!`/`!!`) | same extension → `pi.on("user_bash")` | `{command, cwd}` | governor (static) | parsed roots | none | blocking result |
| 5 | Bash execution | `dist/core/tools/bash.js` → `createLocalBashOperations` | spawn args | none | none | optional timeout | `child_process.spawn` |
| 6 | Runtime observation | `dist/core/bash-executor.js` + `bash.js` OutputAccumulator | streamed chunks | none | none | bytes/lines, elapsed | truncation to temp file |
| 7 | Result / timeout / failure | bash tool `execute()` | result object | none | none | exit code / timeout / abort | error → agent |
| 8 | Agent retry or replan | LLM | next tool call | none | — | — | — |

### 5.1 Key facts (Layer A — structured search)

- Pi already ships **native bounded structured search tools**:
  - `find` — `{pattern, path?, limit?}` (default limit 1000), respects
    `.gitignore`, default `ignore: ["**/node_modules/**", "**/.git/**"]`.
  - `grep` — `{pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`
    (default limit 100), respects `.gitignore`, `GREP_MAX_LINE_LENGTH=500`.
- These tools expose **explicit root + exclusions + limits** by construction —
  exactly the `search(pattern, root, exclusions, limits)` shape in G2/G4.
- **But** the toolset split is: `createCodingTools = [read, bash, edit, write]`
  and `createReadOnlyTools = [read, grep, find, ls]`. Coding mode (this
  session) exposes **bash but not `find`/`grep`**; read-only mode exposes
  `find`/`grep`/`ls` but not `bash`. Therefore the Agent is structurally pushed
  toward shell-string search, and the governor must parse shell strings.

### 5.2 Key facts (Layer B — bash guard, current state)

- The governor is a **pure static shell-string parser** (~1700 lines) with, in
  the latest repo source: family detection (`find`/`rg`/`grep`/`git grep`/`ls-files`/`log`),
  wrapper contracts (`env`/`sudo`/`nohup`/`timeout`/`nice`/`busybox`), shell
  `-c` flag-cluster parsing, `env -S` split-string tokenizer, `xargs -I`
  replacement tracking, `find -exec` payload extraction, positional-parameter
  substitution (`$1`/`${n}`/`$@`/`$*`), and a per-token expansion classifier
  (FR2).
- This is exactly the drift the card names: each review round added another
  syntax special case (FR2 `$VAR`, R1 wrappers, R3 `env -S`/`xargs -I`, R5
  positionals, R7 quote-aware positionals), and FR3 still found `~user` plus
  re-tokenization provenance loss. The boundary is structurally incomplete.

### 5.3 Key facts (Layer C — runtime resource guard, current state)

- Bash `timeout` is **optional and Agent-specified**; there is **no default
  wall-clock limit**.
- Output is bounded to `DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES=50KB`
  (full output to temp file); `killProcessTree` handles timeout/abort.
- There is **no no-progress detection**, **no default heavy-directory exclusion
  at runtime** (`.gitignore` handling exists only in the native `find`/`grep`
  tools), and **no runtime→governance feedback loop**.

### 5.4 Key facts (wiring gaps — decisive for G5)

- The failed-strategy registry (`createFailedStrategyRegistry`) and
  `REPLAN_REQUIRED`/`SEARCH_STRATEGY_FAILED` ladder exist in the governor but
  are **not wired into the live extension**: `index.ts` calls
  `governPiCommand({ command, cwd })` with **no `registry` and no
  `declaration`**. The ladder is only exercised by unit tests.
- Even if wired, the registry is in-memory and non-persistent; no runtime
  outcome (timeout / no-progress / interrupt) is recorded back into it.
- **Deployment drift (confirmed):** the installed vendor copy
  `~/.pi/agent/extensions/search-scope-governor/vendor/search-scope-governor.mjs`
  is **stale** — it lacks FR2 (`$VAR`/`${VAR}`/`$(...)` default-deny), R5
  (positional substitution), and R7 (quote-aware positionals) that are present
  in the repo source. The RB-SSG3 integrity test pins only
  `src/admission/* ↔ pi-extensions/…/vendor/*` (both in the repo); it does **not**
  verify the installed `~/.pi/.../vendor` copy. Live enforcement therefore lags
  the source-of-record undetected.

### 5.5 Confirmed current behavior (read-only diagnostics)

| Command (cwd=repo) | Installed vendor (live) | Latest repo source |
|---|---|---|
| `grep -R x /Users/zhengfengqing` | REJECT `UNBOUNDED_HOME_TRAVERSAL` | REJECT `UNBOUNDED_HOME_TRAVERSAL` |
| `grep -R x ~root` | **ADMIT** `SAFE_BOUNDED` | **ADMIT** `SAFE_BOUNDED` |
| `grep -R x ~zhengfengqing` | **ADMIT** | **ADMIT** |
| `grep -R x $ROOT` | **ADMIT** | REJECT `INDETERMINATE_SEARCH_ROOT` |
| `grep -R x $(pwd)` | **ADMIT** | REJECT `INDETERMINATE_SEARCH_ROOT` |
| `timeout 5 grep -R x ~root` | **ADMIT** | **ADMIT** |
| `find . -exec grep -R x ~root \;` | **ADMIT** | **ADMIT** |
| `bash -c "grep -R x ~root"` | **ADMIT** | **ADMIT** |

---

## 6. Answers to the Fourteen Questions

1. **Operational harm** — unbounded/wasteful recursive traversal: long runtime,
   high CPU, excessive output/context, repeated no-progress traversal (§2).
2. **Must remain legal** — bounded recursive search inside the active repo, a
   known source/test directory, or an explicitly authorized artifact directory
   (G1).
3. **Bounded root** — a statically-concrete path that is (a) not a forbidden
   root and (b) equal-to-or-under an authorized/allowlisted root, OR carries an
   explicit boundary (exclusions/`.gitignore`/index). "Bounded by result
   filtering" (`-name`, `| head`) is NOT a boundary.
4. **Forbidden / special-authority scopes** — `$HOME`, any user home, Desktop,
   filesystem root, multi-user/repo-collection parent (`/Users`, `/home`).
   These stay forbidden absent explicit allowlist/declaration.
5. **Unknown root** — `root not proven bounded → reject/rewrite-to-bounded or
   require an explicit bounded root`. Never guess. (This is the existing
   `INDETERMINATE_SEARCH_ROOT` principle, generalized to cover `~user` and any
   unresolved provenance — not implemented as another syntax table.)
6. **Structured search preferred** — **YES**. Pi already has bounded `find`/
   `grep` tools with explicit root + `.gitignore` + limits. They must be
   exposed in the coding toolset and advertised as the primary discovery path;
   the shell-string parser becomes a coarse fallback, not the primary seam.
7. **Minimum Bash guard** — a coarse three-way classifier over a recognized
   recursive-search command: `explicit bounded root → eligible`; `explicit
   forbidden/oversized root → reject`; `unresolved recursive root → reject/
   rewrite`. No wrapper/`-c`/`xargs`/`-exec`/positional reconstruction.
8. **Resource limits (independent of static analysis)** — default wall-clock
   timeout; output/result bound (already 50KB/2000 lines; keep); heavy-directory
   exclusion (`.git`, `node_modules`, build/cache/db/generated); no-progress
   detection; repeated/overlapping-scope detection.
9. **No-progress** — a read-only discovery command that exceeds the default
   timeout, is manually interrupted, produces no useful progress within a
   threshold, or (when measurable) repeats a previously failed traversal
   fingerprint. Definition must be a small explicit threshold set, frozen in
   FR4.
10. **Retry → REPLAN** — a materially equivalent traversal strategy (same
    normalized root × recursive mode × discovery intent; tool/pattern changes
    do NOT reset it) that has already failed → second attempt is
    `REPLAN_REQUIRED`, third+ is mechanical block. The fingerprint is already
    correct; it must be **wired + persisted** and fed by runtime outcomes.
11. **Still useful** — forbidden-root invariants (`classifySearchRoot`),
    family/root extraction, tracked-indexed admit (`git grep`/`ls-files`/`log`),
    bounded-rewrite-to-authoritative-root *as a coarse narrowing*, strategy
    fingerprint + registry, telemetry, the `tool_call`/`user_bash` seams, the
    subagent `assertAuthorizedPathsBounded` guard.
12. **Unnecessary (objective drift)** — wrapper contracts, shell `-c` cluster
    parsing, `env -S` tokenizer, `xargs -I` replacement tracking, `find -exec`
    payload extraction, positional-parameter substitution, per-token expansion
    classification (FR2), and their tests as *correctness-critical* machinery.
13. **Expansion-provenance machinery** — **delete or demote** from
    correctness-critical status. The `~user`/`$VAR`/`$(...)`/backtick/glob/
    positional provenance table is replaced by a single coarse rule: *a root
    not statically concrete → reject/rewrite*. The mechanism becomes a ~10-line
    predicate, not a shell interpreter.
14. **Compatibility impact** — normal bounded searches (repo-root `grep -r`,
    `git grep`, `find src/`) keep working; the native `find`/`grep` tools carry
    the primary load; shell-string recursive searches whose root is not
    statically concrete become rejections with a clear "restate using an
    explicit bounded root or the `find`/`grep` tool" message. This is a behavior
    change only for the previously-admitted unknown-provenance lane.

---

## 7. Alternatives Analysis

| Criterion | A: keep shell-semantic model | B: structured-primary + coarse bash | C: runtime-only | D: hybrid (selected) |
|---|---|---|---|---|
| Correctness | Low — FR3/`~user` disproves completeness | High — root explicit by construction | Medium — cannot stop a fast harmful scan early | **High** |
| Implementation complexity | High (grows per review) | Low | Low | Medium (two layers + backstop) |
| Bypass surface | Large and growing | Small (root param + coarse 3-way) | Static bypass possible | **Smallest** |
| Maintainability | Poor (syntax whack-a-mole) | Good | Good | Good |
| Compatibility | High (no change) | Medium (promote tools) | High (minimal change) | Medium |
| Agent usability | Poor (deny-only dead-ends) | Good (bounded tools) | Neutral | **Best** |
| Runtime-waste prevention | Partial (static only) | Partial | Strong | **Strong** |
| Extensibility | Poor | Good | Good | Good |

**Selected model: Option D (Hybrid)**, decomposed as:

- **Primary (Layer A)** — promote Pi's native `find`/`grep` bounded tools into
  the coding toolset as the preferred discovery path; policy-check the explicit
  `path` root before execution.
- **Fallback (Layer B)** — coarse bash three-way guard only (`eligible` /
  `reject` / `reject-or-rewrite`), no shell-semantic reconstruction.
- **Backstop (Layer C)** — default timeout, output bound, heavy-dir exclusion,
  no-progress detection, and a **wired + persisted** failed-strategy registry
  that turns runtime failure into REPLAN evidence.

This is B + C, with B's primary path carrying the correctness load and C as the
independent protection for syntactically-valid-but-harmful commands (G4/G5).

---

## 8. Component Classification (KEEP / MODIFY / RETIRE / SUPERSEDE)

Governor source: `src/admission/search-scope-governor.mjs`
(`~/.pi/agent/extensions/search-scope-governor/vendor/…` at runtime).

| Component | Verdict | Rationale |
|---|---|---|
| `classifySearchRoot` + forbidden-root invariants (B) | **KEEP** | Correct, mechanical, minimal. Core of the coarse guard. |
| `normalizeSearchPath` (`~`, `~/…`, `$HOME`) | **MODIFY** | Keep for concrete paths; treat `~user`/`~user/…` as *unresolved*, never literal. |
| Family/root extraction (`parseFind`/`parseRg`/`parseGrep`, `git grep`/`ls-files`/`log`) | **MODIFY → coarse** | Keep family detection + root extraction for the 3-way classification; drop depth/prune/glob/regex semantics. |
| `strategyFingerprint` + `createFailedStrategyRegistry` | **KEEP + WIRE + PERSIST** | Already correct (tool/pattern-agnostic); currently dead in live path. Wire into extension + persist across sessions + feed from runtime. |
| `deriveSafeSearchReplacement` (bounded rewrite) | **MODIFY → demote** | Keep "narrow to authoritative root" for structurally-simple commands; replace auto-rewrite of complex shell with "restate using explicit root / structured tool". |
| `validateSearchDeclaration` (invariant G) | **SUPERSEDE** | The bash tool cannot carry declarations. The structured tool's explicit `path` param becomes the declaration; keep a root/boundary requirement message for bash. |
| `buildSearchGovernorTelemetry` | **KEEP** | Execution evidence for replan. |
| `governPiCommand` bridge + `index.ts` seams | **KEEP + MODIFY** | Seams are correct (pre-spawn `tool_call` / `user_bash`). Add: registry wiring, runtime-outcome ingestion, structured-tool guidance. |
| `assertAuthorizedPathsBounded` (subagent envelope) | **KEEP** | Separate, still-valid seam. |
| Wrapper contracts (`env`/`sudo`/`nohup`/`timeout`/`nice`/`busybox`) | **RETIRE** | Non-goal: "exact wrapper semantic equivalence". |
| `extractShellCommand` (`-c` cluster parsing) | **RETIRE** | Non-goal: "nested `sh -c` reconstruction". |
| `extractEnvSplitString` / `env -S` | **RETIRE** | Non-goal. |
| `extractXargsCommand` / `-I` replacement tracking | **RETIRE** | Non-goal: "arbitrary runtime-computed paths". |
| `extractFindExecPayloads` / `{}` placeholder | **RETIRE** | Non-goal: "exact `find -exec` equivalence". |
| `substituteShellPositionals` (R5/R7) | **RETIRE** | Non-goal: "arbitrary variable/positional evaluation". |
| `tokenizeWithExpansion` (FR2 per-token expansion table) | **SUPERSEDE** | Principle (G3) kept; implementation replaced by coarse "not statically concrete → reject". |
| `splitShellSegments` / `tokenize` / `extractSubcommands` | **MODIFY → coarse** | Keep a minimal segment/token splitter for the coarse guard only. |
| Vendor-integrity test | **MODIFY** | Also verify the **installed** `~/.pi/.../vendor` copy at runtime; current pin covers only repo↔repo. |

---

## 9. Readiness Gate Check-off

- [x] Original problem statement frozen (§2)
- [x] Non-goals frozen (§3)
- [x] Recursive search legality explicit (G1, Q2)
- [x] Enforcement boundary explicit (§5, §7)
- [x] Structured-search role decided (§7: primary)
- [x] Bash guard responsibility bounded (§7: coarse 3-way)
- [x] Runtime resource-control responsibility explicit (§7: backstop)
- [x] Unknown-root behavior explicit (G3/Q5: reject/rewrite, never guess)
- [x] Retry/REPLAN behavior explicit (G5/Q10)
- [x] FR3 findings formally disposed (§4)
- [x] Existing components classified KEEP/MODIFY/RETIRE/SUPERSEDE (§8)
- [x] Next implementation card writable without unresolved decisions (§10)

---

## 10. Next Card (scope only — not frozen implementation)

**RB-SSG4-FR4 — Bounded Search Execution Foundation Implementation**, implementing:

1. Expose bounded `find`/`grep` tools in the coding toolset and advertise them
   as the primary discovery path; policy-check the explicit root before exec.
2. Reduce the bash governor to the coarse three-way guard; delete/demote the
   wrapper/`-c`/`xargs`/`-exec`/positional/expansion machinery and its
   correctness-critical tests.
3. Make `~user`/unknown-provenance roots fail closed (reject/rewrite) via the
   single "not statically concrete" predicate — no new syntax table.
4. Wire + persist the failed-strategy registry; ingest runtime timeout/no-progress
   as REPLAN evidence.
5. Add default wall-clock timeout + no-progress detection + heavy-directory
   exclusions to the bash runtime layer.
6. Fix deployment convergence: verify the installed `~/.pi/.../vendor` copy at
   runtime (not only repo↔repo) and re-bundle the frozen source.

---

## 11. Core Principle (frozen)

> The system is not trying to stop Agents from searching recursively.
> It is trying to stop recursive discovery from becoming an unbounded,
> resource-wasting, repeated execution strategy.

Therefore: **bound the capability and execution resources; do not model more
shell semantics than the governance objective actually requires.**

---

## 12. Evidence Appendix (read-only diagnostics)

- Live block observed in this session: `find /Users/zhengfengqing` →
  `search_scope_governor:UNBOUNDED_HOME_TRAVERSAL:unbounded traversal from
  /Users/zhengfengqing: home directory`.
- Installed vendor copy admits `~root`/`~zhengfengqing`/`~zhengfengqing/…`,
  `$ROOT`, `${ROOT}`, `$(pwd)` as `SAFE_BOUNDED` (stale copy: no FR2).
- Latest repo source: `$ROOT`/`$(pwd)` → `INDETERMINATE_SEARCH_ROOT` (FR2 works),
  but `~root`/`~zhengfengqing` still `SAFE_BOUNDED` → **FR3 valid against latest**.
- `diff src/admission/search-scope-governor.mjs ~/.pi/.../vendor/search-scope-governor.mjs`
  → installed vendor lacks FR2/R5/R7 (deployment drift).
- Repo RB-SSG suite: **275/275 pass** (source, not installed copy).
- Pi `bash` tool: optional timeout, 50KB/2000-line truncation, no default
  timeout, no no-progress detection.
- Pi toolset split: coding `[read,bash,edit,write]`; read-only `[read,grep,find,ls]`;
  native `find`/`grep` expose explicit `path` + `.gitignore` + limit.
