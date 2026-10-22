# C1 — the EKM read path and the controller capability

**Card:** `AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1`
**Predecessor:** `AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1` (PASS, `HEAD = 8fac453`)
**Verdict:** see `FINAL_DISPOSITION.md`

Every claim below is a measurement on this host. Where something was not
measured, the row says so instead of asserting it.

---

## 1. The defect, as measured

`cbm-query.js` is an OMP extension: OMP loads it into its own process. Under a
governed launch that process holds the controller capability — an inherited
ledger descriptor plus the key that authenticates records written through it
(R4). The extension's `ekm_query` tool imported
`<session-cwd>/src/memory/index.mjs`, located by walking **up from the session
cwd**, inside that process.

So this was the whole attack:

```
bash:  mkdir -p src/memory && cat > src/memory/index.mjs   # agent's own cwd
then:  ekm_query(...)                                       # any argument
```

Measured on a real governed launch (`PROBE_PRE_REPAIR.json`), with the planted
module's own text in the trace:

| Observation | Value |
|---|---|
| `plantedEvaluatedByToolPath` | **true** |
| tool answer | `UNAVAILABLE — repository identity could not be resolved: planted` |
| where it ran | the governed OMP process, which had just committed a fence |

The `planted` string is the planted module's own `throw`. Agent-written code ran
inside the trust boundary, and the capability was in scope the entire time.

`C1_REACHABILITY = CONFIRMED`.

---

## 2. The repair — two layers, both required

### Layer 1: the session cwd is not a trusted source

`resolveRepoRoot()` consults exactly two things:

1. `AEGISFLOW_REPO_ROOT` / `AUTOLOOP_REPO_ROOT` — explicit and documented;
2. the extension's own location (correct when running from the repo).

The session cwd is gone from that list. An `ekm_query` whose checkout cannot be
found answers `UNAVAILABLE` with the reason; it does not let the Agent choose
which module runs.

### Layer 2: the store does not load in the capability process at all

The read path moved to `lib/memory-query-core.mjs`, and the tool runs it in
`lib/memory-query-child.mjs` — a plain `node` process, started with a **scrubbed
environment**, with no descriptor and no key. The child refuses to run at all if
any authority variable is present in its environment, so a future caller cannot
quietly re-point it at a process that holds authority.

Why both layers: layer 1 alone leaves "whatever the extension can be made to
resolve" as the boundary; layer 2 alone leaves a session-controlled `import()`
running in a process that holds authority for the duration of the resolve. The
child is the decisive one — a fully attacker-controlled checkout still reaches
nothing from there.

There is **no in-process fallback**. A child that cannot start is an
`UNAVAILABLE` answer carrying the reason; a fallback would restore the defect
exactly in the unusual environment, which is the one an attacker arranges.

### Two things the measurement forced

- **The child is `node`, never `process.execPath`.** Under OMP, `process.execPath`
  is the OMP binary — starting it again would put the store back inside an OMP
  process. A `node` candidate that resolves to this process's own executable is
  refused for the same reason.
- **The spawn is asynchronous.** A synchronous spawn blocks the runtime's event
  loop, freezing the TUI and every pending delivery for as long as the query
  takes. The timeout kills the child instead.

### A functional break this also fixes

The pre-repair in-process path could not work under the OMP runtime at all:

```
bun  -e 'import("node:sqlite")'  ->  No such built-in module: node:sqlite
node -e 'require("node:sqlite")' ->  BUN_SQLITE_OK … (present)
```

OMP runs on bun; the store needs `node:sqlite`. Every pre-repair `ekm_query`
therefore answered `UNAVAILABLE — memory module failed to load: No such built-in
module: node:sqlite` (measured on a deployed copy). The child runs on `node`,
where the module exists, so the repair makes the tool work where it previously
could not.

---

## 3. What each mechanism now enforces

| Property | How | Measured |
|---|---|---|
| The tool never imports a checkout in the OMP process | `cbm-query.js` has **no** dynamic `import()`; the only one is `await import(index)` inside the core's loader, called only from the child | `test-c1-trust-boundary.mjs` (static) |
| The session cwd cannot redirect trusted loading | `resolveRepoRoot()` has no cwd source; `allowSessionCwd` is set **only** by the no-authority child | `C1_T02` + control |
| Agent-written code is not evaluated beside the capability | child process, scrubbed env | governed suite, `T01` |
| The child inherits no authority | parent passes only `PATH/HOME/TMPDIR/LANG` + memory/root variables; child refuses if an authority variable is present | `C1_T03/T04` |
| The capability still works | controller commits a fence on the same runtime after the tool call | governed suite, `premise` + `T01:capability-still-usable` |
| Absent inputs fail closed and say why | `UNAVAILABLE` with a located reason, never a crash and never a silent empty | `C1_T10` |
| Store configuration still reaches the child | explicit `CHILD_ENV_ALLOW`: `AEGISFLOW_HOME` / `*_MEMORY_STATE_ROOT` / `*_REPO_ROOT` and their legacy names | `C1_T04` (both directions) |
| A hostile store cannot grow this process without bound | settlement removes the `data` listeners and destroys both streams; the timeout kills the runner | hostile-store probe (below) |

### Two defects found in review, and what they were

Both were found by the independent reviewer against the first cut of this
repair, and both were real:

1. **The env scrub was too narrow.** It carried `AEGISFLOW_MEMORY_STATE_ROOT`
   but dropped `AEGISFLOW_HOME`, which is where the memory root *defaults from*
   (`src/shared/autoloop-paths.mjs`). A deployment that relocates state with
   `AEGISFLOW_HOME=/srv/aegis` would have queried `$HOME/.autoloop/memory` and
   reported `EMPTY_MEMORY` for a store that is populated. Fixed with an explicit
   allowlist that separates *configuration* (crosses) from *authority* (never
   crosses) — measured by pointing `AEGISFLOW_HOME` at an empty directory and
   observing `EMPTY_MEMORY`, which is only possible if the variable arrived.
2. **Output was consumed after settlement.** A hostile store can fork a
   descendant that inherits stdout; killing the runner does not close that pipe,
   so the `data` listener kept appending to a buffer inside OMP. Settlement now
   removes the listeners and destroys the streams first. Measured with a planted
   module that spawns a descendant writing 64 KiB chunks forever: the call
   returns `UNAVAILABLE` in ~11.7 s with heap growth of −0.9 MB over 1.5 s after
   settlement, and no descendant survives.

A third finding was about the evidence, not the code: the governed suite
accepted `typeof toolState === "string"`, which a parent-side failure satisfies.
It now requires `isolation.active === true` and `AVAILABLE` with at least one
record from a store the harness seeded itself.

---

## 4. Negative controls

A test that cannot fail is not evidence. Three controls run against the same
planted module:

| Control | Result |
|---|---|
| Loading a session-derived checkout directly **does** execute it, in a process holding a real capability | executes (`C1_T01` control) |
| The pre-repair `cbm-query.js` from `HEAD`, launched identically, **does** execute the planted module | executes (`control:pre-repair-tool-path-DOES-evaluate-planted-module`) |
| The walk-up the repair removed **does** locate the planted checkout | locates (`C1_T02` control) |

The pre-repair control reads its bytes from `git show HEAD:…`, not from a
reconstruction, and refuses to run if those bytes no longer contain the
walk-up — a control that cannot be silently repointed at the repaired code.

---

## 5. What this card does NOT claim

1. **The Agent and the controller are still the same uid.** This card removes a
   *code path* into the capability; it does not create an OS identity boundary.
   The R4 threat model already names a separate account as the durable answer.
2. **`sandbox-exec` is macOS-only.** On another platform a governed launch is
   refused outright rather than downgraded (R4 behaviour, unchanged).
3. **A fully compromised `node` on `PATH` is not addressed.** The child is chosen
   from `PATH`, so an agent-writable directory earlier in `PATH` could supply the
   interpreter. This does not yield the capability — the substituted executable is
   spawned with three stdio slots and a scrubbed environment, so it has no ledger
   descriptor and no key — and an attacker who can already run arbitrary code as
   this uid gains nothing from it. It is a residual, not a bypass, and it is not
   fixed here.
4. **The store itself is trusted input.** Records are DATA and the tool is
   read-only, but a corrupted store is still able to answer badly — it fails
   closed as `INVALID` rather than being sanitised.
