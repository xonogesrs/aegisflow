# RB-SSG4-FR4 — Bounded Search Execution Foundation Implementation

Status: **PASS / RB_SSG4_FR4_BOUNDED_SEARCH_EXECUTION_FOUNDATION_IMPLEMENTED_AND_VERIFIED**

Predecessor: `RB-SSG4-RC1` (PASS — objective & enforcement boundary frozen).

Next: `RB-SSG4-FR5 — Independent Foundation Review`.

---

## 1. What was implemented (phases A–E)

### Phase A — Structured Search Primary Path

- The Pi extension registers the native bounded `grep` / `find` tools (via
  `pi.registerTool` + SDK `createGrepToolDefinition` / `createFindToolDefinition`)
  into the **coding** toolset on `session_start`, and enables them additively.
- Explicit-root policy: `governStructuredRoot` / `governStructuredSearch`
  classify the `path` parameter as `ELIGIBLE` / `REJECT` / `INDETERMINATE`
  before the native tool executes.
- **Live proof:** fresh `pi --mode rpc` diagnostic reported
  `DIAG_ALL_TOOLS=["read","bash","edit","write","grep","find","ls"]` and
  `DIAG_ACTIVE_TOOLS=["read","bash","edit","write","grep","find"]`
  (`DIAG_HAS_GREP=true DIAG_HAS_FIND=true`).

### Phase B — Coarse Bash Guard

`src/admission/search-scope-governor.mjs` was rewritten from the ~1970-line
shell-semantic engine to a coarse three-way classifier:

- `EXPLICIT BOUNDED ROOT → ELIGIBLE`
- `EXPLICIT FORBIDDEN / OVERSIZED ROOT → REJECT`
- `ROOT NOT STATICALLY CONCRETE → REJECT / RESTATE`

New principle-based predicate `isConcreteRootToken` replaces the per-token
expansion table. New `classifyComplexForm` turns hidden indirection
(wrapper / shell `-c` / `xargs` / `find -exec` / command substitution) into
`UNRESOLVED_EXECUTION_STRUCTURE` restate, never reconstruction.

### Phase C — Runtime Resource Backstop

- `DEFAULT_RECURSIVE_SEARCH_TIMEOUT_SECONDS = 120` (centrally defined,
  overridable via `RB_SSG_DEFAULT_TIMEOUT_SECONDS`). Injected into recursive-
  search `bash` tool calls that specify no timeout. The Pi bash tool's
  `killProcessTree` provides descendant termination (verified in `dist/core/tools/bash.js`).
- Output bounds preserved (`DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50KB`).
- Heavy-directory exclusion: structured tools reuse native `.gitignore` +
  `node_modules`/`.git` ignore; bash searches rely on scope + timeout (no unsafe
  command rewriting to inject exclusions).
- No-progress signal: timeout / abort / non-zero exit surface as `isError` and
  are fed to the failed-strategy registry.

### Phase D — Failed Strategy → REPLAN

- The failed-strategy registry is now **wired into the live extension** (passed
  into `governPiCommand`), hydrated from session entries on `session_start`,
  persisted via `pi.appendEntry` on failure.
- Runtime outcomes are ingested on `tool_result` (`isError === true` records the
  pending recursive-search fingerprints).
- Ladder: 1st failure `SEARCH_STRATEGY_FAILED` (recorded) → 2nd equivalent
  `REPLAN_REQUIRED` → 3rd+ mechanical block. Tool/pattern changes do not reset.

### Phase E — Deployment Convergence

- `scripts/deploy-rb-ssg-governor.sh` provides idempotent, SHA-verified
  deployment: `src/admission/* → repo vendor → installed ~/.pi/*`.
- `test-rb-ssg-vendor-integrity.mjs` now verifies the **installed** runtime copy,
  not only repo↔repo.

---

## 2. Evidence (required by §11)

| Evidence | Value |
|---|---|
| Authoritative source SHA (governor) | `a994f33fbb9a1f1da9187c95a13034f8db58947df45ac65d63a69b24e3ff9e27` |
| Authoritative source SHA (bridge) | `ad2766f20ccefb9cc4d41e94f871dd9468e204e14473ba2899a6aa2f857fa3d1` |
| Installed runtime SHA (governor) | `a994f33fbb9a1f1da9187c95a13034f8db58947df45ac65d63a69b24e3ff9e27` (== source) |
| Installed runtime SHA (bridge) | `ad2766f20ccefb9cc4d41e94f871dd9468e204e14473ba2899a6aa2f857fa3d1` (== source) |
| Extension index.ts SHA | `f24299e11af4e2c6e36436ef3f104e6f1b9d46a004d72dc6c6b1ef0ab79dd76c` |
| Structured-search availability | live diagnostic: `grep`+`find` registered & active in coding mode |
| Forbidden-root proof | unit `B2`/`A2` + live `grep -R x /Users/zhengfengqing` → `UNBOUNDED_HOME_TRAVERSAL` |
| Unknown-root fail-closed proof | unit `B3`/`A3` + live `grep -R x ~root` → `INDETERMINATE_SEARCH_ROOT` |
| Complex-form restate proof | unit `B4` + live `bash -c 'grep -r x src'` → `UNRESOLVED_EXECUTION_STRUCTURE` |
| Runtime timeout | injected default 120s (code + centrally-defined + overridable); bash tool terminates process tree |
| Failed-strategy → REPLAN proof | unit `D1` (`UNBOUNDED_HOME_TRAVERSAL` → `REPLAN_REQUIRED` → `SEARCH_STRATEGY_FAILED`) |
| Compatibility proof | unit `B5` (non-recursive/non-search admitted) + live bounded `grep` returned real output |

### Live smoke (fresh `pi --mode rpc --no-session`, installed extension)

| Command | Result |
|---|---|
| `grep -R x ~root` | BLOCKED `INDETERMINATE_SEARCH_ROOT` |
| `grep -R x /Users/zhengfengqing` | BLOCKED `UNBOUNDED_HOME_TRAVERSAL` |
| `grep -R governPiCommand src/admission` | admitted, real output |
| `bash -c 'grep -r x src'` | BLOCKED `UNRESOLVED_EXECUTION_STRUCTURE` (restate) |

---

## 3. Regression counts

- `node --test test/admission/*.mjs` → **179/179 pass**.
- `test:rb-ssg4` (bounded-rewrite + fr4-foundation + vendor-integrity) → **47/47 pass**.
- `node --check` on all four governor/bridge/vendor files → pass.
- `test:governance` → **2 baseline failures, unrelated to FR4** (see §5).

---

## 4. Retired / superseded shell-semantic components

`RETIRED_BY_RC1_BOUNDARY_CHANGE` (see `test/admission/RETIRED_BY_RC1_BOUNDARY_CHANGE.md`):

- wrapper contracts (`env`/`sudo`/`nohup`/`timeout`/`nice`/`busybox`) — removed
- shell `-c` cluster parsing (`extractShellCommand`, `SHELL_LONG_OPTIONS`) — removed
- `env -S` split-string tokenizer (`splitEnvSplitString`, `extractEnvExecutionChildren`) — removed
- `xargs -I` replacement tracking (`extractXargsCommand`) — removed
- `find -exec` payload reconstruction (`extractFindExecPayloads`) — removed
- positional-parameter substitution (`substituteShellPositionals`) — removed
- per-token expansion-provenance table (`tokenizeWithExpansion`, `isKnownHomeRef`) — superseded by `isConcreteRootToken`
- command-substitution descent (`extractSubcommands`) — superseded by `classifyComplexForm` restate

Retired test files: `test-rb-ssg4-fr2-default-deny`, `test-rb-ssg4-r1-indirection`,
`test-rb-ssg4-r3-indirection`, `test-rb-ssg4-r5-positional-cwd`,
`test-rb-ssg4-r7-quote-aware-positional` (documented, not silently deleted).

**No correctness dependency remains on arbitrary shell reconstruction.** The
coarse guard's only shell-adjacent operations are a minimal segment splitter,
literal `cd` tracking, and family/root token extraction.

---

## 5. Known baseline failures (separated from FR4 regressions)

- `test/governance/test-git-status-parsing.mjs` "12. real repo A: package.json
  is no longer truncated" — expects `package.json` to be in the repo's
  `dirtyPaths`; `package.json` is currently clean (not modified by FR4).
- `test/governance/test-verification-timing.mjs` "S2/4" — cascade: it runs
  `test-git-status-parsing.mjs` as a subprocess and expects 0 failures.

Both are live-repo-state-sensitive and independent of the search governor.

---

## 6. Verification boundaries (handed to FR5)

- Default-timeout injection and `tool_result → registry` ingestion are wired and
  mechanism-verified (code + pure-governor unit tests + live `user_bash` smoke),
  but a full **LLM-issued failing `bash` tool call** end-to-end (which fires the
  `tool_call` + `tool_result` seams) was not exercised in this session; it
  requires a live model turn. FR5 must independently verify this path.
- The registry is session-scoped (persists via Pi session entries); cross-session
  durability is intentionally bounded (no unbounded global DB), per D4.

---

## 7. Core invariant (frozen)

> Recursive search is allowed. Unbounded, unresolved, resource-wasting, and
> repeatedly failed recursive search is not.

The system controls **scope + resources + retry**, not arbitrary shell semantics.
