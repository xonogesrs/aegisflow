# OMP Attribution Extractor v1 — implementation notes

Scope: the minimal extractor authorized after the design review (DESIGN.md,
§3.1–§3.5, §4). Descriptive observations only. Not evolution evidence.

## What exists

| File | Role |
|---|---|
| `src/evolution/omp-attribution/contract.mjs` | closed v1 schema, validator, token / secret gates, fixed tool allowlist |
| `src/evolution/omp-attribution/extract.mjs` | safe file observation (lstat, `O_NOFOLLOW`, fstat re-checks, nlink), header peek, whitelist projection, conservative `lsof` |
| `src/evolution/omp-attribution/ingest.mjs` | per-session state machine, crash-safe writes, run lock, kill switch |
| `scripts/omp-session-attribution.mjs` | manual CLI, dry-run by default |
| `test/evolution/omp-attribution/test-omp-attribution-extractor.mjs` | host-only suite (injected clock and `lsof`, mkdtemp fixtures, runtime-assembled fake credentials) |

Nothing else changed: no OMP, pilot, admission, strategy-memory, policy,
attribution-feed or reviewer change. A static test walks the transitive import
graph and fails if the domain can reach anything under `src/evolution/` other
than `kill-switch.mjs`, or anything under `src/admission` / `src/governance`.

## Usage

```
node scripts/omp-session-attribution.mjs \
  --store <evolution store dir> --sessions-root <omp sessions dir> \
  --allow-cwd <dir> [--allow-cwd <dir> ...] [--deny-root <dir> ...] \
  [--quiescence-minutes 30] [--synthetic] [--write] [--json]
```

- Dry-run unless `--write`. Dry-run persists nothing, state included.
- No defaults for `--store`, `--sessions-root` or `--allow-cwd`; an empty
  allowlist refuses to run. `--deny-root` is **additive** to the built-in
  `/private/tmp` and `/private/var/folders`.
- Output lands only under `<store>/omp-observations/{observations,state}/`.
- Exit codes: 0 ok · 2 usage · 3 run lock busy (never stolen; an operator
  removes a stale `.run.lock`).

## Behaviour that matters

- **Quiescence**: OMP writes no end marker. A session is recorded only after
  two observations with identical `(dev, ino, size, mtime_ns, tail digest)`, a
  stable window ≥ T (default 30 min), mtime older than T, and `lsof` reporting
  *not held*. Only `lsof` exit 1 with empty stdout and stderr counts as not
  held; spawn error, timeout, signal, stderr noise or any other status is
  treated as held/unknown and the file is skipped. The gate runs before every
  other branch, settled sessions included.
- **Resume**: a recorded session that only grew becomes
  `EXTENDED_AFTER_RECORD` (nothing re-counted, observation never rewritten); a
  rewritten prefix is `PREFIX_MISMATCH` (sticky, leaves the trusted set).
  Two files claiming one session id are both excluded.
- **Crash safety**: observation is created exclusively first, state replaced
  atomically second. A rerun reconciles (`RECONCILED`), or settles a
  crash-then-append case as `EXTENDED_AFTER_RECORD`. The count is the number of
  final `ompobs_<hex>.json` files, so a double count is impossible; `*.tmp.*`
  leftovers never count.
- **Kill switch**: `AUTO_EVOLUTION=SUSPENDED`, or the mere presence of the
  marker path (valid, corrupt, symlink, or unreadable location), blocks every
  write; re-checked before each file.
- **Privacy**: fixed field whitelist; free text, tool output, titles, paths and
  `providerPayload` are never copied; model / provider / tool names are
  token-regex-limited and sensitive-pattern scanned (extra patterns for
  hyphen-segmented `sk-` keys and long unbroken runs); tool names must be on a
  fixed list or are counted as `other`; any hit drops the whole record.
- **Outcome** is always `UNVERIFIED` in v1 — `VERIFIED_*` is not representable.

## Deviations from DESIGN.md (explicit)

1. A third module, `ingest.mjs`, holds the state machine and persistence (DESIGN §4
   listed contract + extract + CLI). It is part of the extractor, not a new framework.
2. The sessions root is an explicit argument with no default, instead of a
   hard-wired `~/.omp/agent/sessions`. Stricter than the design for Phase 1.
3. The cwd allowlist is matched on the session **header** `cwd`, not on the
   directory slug (the slug encoding is not reliably reversible). The slug is
   only validated as a plain name; only top-level `<ts>_<uuid>.jsonl` files are read.
4. `cwd_ref.sha256` is an unsalted hash of the normalised cwd, as specified;
   a path that can be guessed can be confirmed by someone holding the store.
   A per-store keyed hash is an open question for the Controller.

## Not done / follow-ups

- No run against real `~/.omp` data and none against the production
  evolution store (Phase 1 is fixtures only, per authorization).
- No hook or daemon; manual CLI only.
- `VERIFIED_*` sources remain deferred (D6).
