# Production baseline manifest

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Collected:** 2026-10-21T10:28:40Z, read-only, on the live workstation
**Script:** [`probes/collect-baseline.sh`](probes/collect-baseline.sh) (re-runnable; writes nothing)
**Raw output:** [`evidence/production-baseline.txt`](evidence/production-baseline.txt)

Every value below is an OBSERVED value. A field this card could not establish is
written `UNKNOWN`; nothing is inferred from a document, a prior card, or an
expectation about how the machine "should" be configured.

---

## 1. OMP runtime

| Fact | Observed |
|---|---|
| Command `omp` resolves to | `$HOME/.bun/bin/omp` → symlink → `$HOME/.local/bin/omp` |
| Real path | `$HOME/.local/bin/omp` |
| SHA-256 | `f2a657b3320fcafa23055053940a45b26a8d3254e1412a158838013d670d6ec5` |
| Version | `omp/18.12.3` |
| Size / mode | 196,931,616 bytes, `-rwxr-xr-x operator:staff` |
| Ancestors world-writable? | No. `~/.local` and `~/.local/bin` are `drwx------`; `~` is `drwxr-x---` |
| Node | `/opt/homebrew/bin/node` v26.0.0 |

The binary the R3 client attests (`attestRpcBinary`) is this same file, and the
attestation succeeds: absolute path, `realpath`, regular, executable, no
world-writable file or ancestor, hash read from the file.

**Discrepancy with the prior baseline, stated:** the deployment evidence recorded
on 2026-10-19 (`~/.omp/agent/deploy-evidence/2026-10-19T11-03-45Z/BASELINE_OMP.txt`)
names `omp/18.12.1` with SHA-256 `fa41b27d…`. The installed binary today is
`18.12.3` / `f2a657b3…`. The OMP runtime was upgraded after that record. This is
not a drift introduced by any card in this line; it is simply the current state,
and it is the state this admission is about.

## 2. Extensions

Deployed directory: `~/.omp/agent/extensions`, mode `drwxr-xr-x
operator:staff` — group and other have READ and EXECUTE, not write.

| File | SHA-256 | Loaded by discovery? |
|---|---|---|
| `no-poll-waits.js` | `11d8628ba5deb2671670956b3b4d04ea82228c004971904f7aa670fd96e6f8ef` | yes |
| `cbm-query.js` | `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e` | yes |
| `orca-agent-status.ts` | `49a8b7e6…b0ed` | yes |
| `orca-prefill.ts` | `5e18bf52…dc1a` | yes |
| `orca-titlebar-spinner.ts` | `16b0ff91…329c` | yes |
| `lib/poll-wait-policy.js` | `7c2eae22…90b0` | imported, not discovered |
| `test/*.ts`, `test/*.mjs` (4 files) | `723c3932…`, `ae16f114…`, `7fae4534…`, `d36c62f8…` | no |

`lib/` today contains exactly one file: `poll-wait-policy.js`.

**Provenance of the deployed `no-poll-waits.js`:** it is the `fb8ce6a` revision of
`integrations/omp/extensions/no-poll-waits.js` — the tip of `main`, whose content
hash is `c2382ffe…630` — not the R3 revision. Verified by the installer's own
classifier: `classifyDeployment` returns `EQUIVALENT` (differs from the published
source only by one redacted session UUID). The R3 revision of that file hashes
`30336801…7e` and is **not** deployed.

**Provenance of the deployed `cbm-query.js`:** it is the R3-branch revision
introduced by `1ebb121 feat(ekm): name the first-party memory tool ekm_query`, and
it is byte-identical to `integrations/omp/extensions/cbm-query.js` at `2fa42d6`.
That commit is an ancestor of `2fa42d6` but **not** of `fb8ce6a`, so the two
deployed extensions come from two different points in the branch history. This is
why the repository delta `fb8ce6a..2fa42d6` shows a `cbm-query.js` change that an
install into this host does not perform: the installer compares bytes against the
live copy, finds them equal, and classifies it `unchanged`.

## 3. Config

| File | SHA-256 | Changed by this card? |
|---|---|---|
| `~/.omp/agent/config.yml` | `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66` | no |
| `~/.omp/agent/models.yml` | `e2346f8ff347171c3e024da292d255947199288943e4def6a6a86ae6ec06c641` | no |
| `~/.omp/agent/mcp.json` | `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4` | no |

`config.yml` carries model roles, symbol preset, theme, `toolCallLoopGuard`,
`dev.autoqaConsent: granted`, and per-agent model overrides. It contains **no**
`OMP_TERMINAL_FENCE_*` key, no extension path, and no controller setting. The R3
change requires no edit here (see the change plan, `DEPLOYMENT_CHANGE_PLAN.md`).

## 4. AutoLoop

| Fact | Observed |
|---|---|
| Shell entry | `~/.zshrc` defines an `omp()` function that asks `al-omp is-on` and routes to `al-omp omp -- "$@"` when ON |
| Pilot root | `$ALOMP_PILOT_ROOT` = a directory on the mounted work volume (`unexported`, shell-local; the exact path is recorded in `evidence/production-baseline.txt`) |
| Executable pinned | `PILOT_OMP_EXECUTABLE=~/.local/bin/omp` |
| Dispatch state | `AutoLoop OMP mode: OFF`, `OMP dispatch: native`, `is-on` exit 1 |
| One-shot launch args | `--no-extensions` is already present (`lib/launcher.js:114`) |
| Interactive launch args | `--tools … --config <overlay>`; **no** `--no-extensions`, so discovery runs |
| Child env | explicit allowlist: `PATH TMPDIR LANG HOME AUTOLOOP_OMP_ACTIVE` (+ optional `MERGE_GATEWAY_API_KEY`) plus caller `extraEnv` |
| Marker `OMP_TERMINAL_FENCE_AUTHORITY` set? | **no**, in either path |
| Supervises a commit? | **no** — no `fence-generation`, `fence-identity` or `release-final` anywhere in the pilot tree |

The shell function is the reason a bare `omp` can become governed without any
change to the binary: dispatch authority is `pilot-state.json` alone, and it
currently reads OFF.

## 5. CBM

| Fact | Observed |
|---|---|
| MCP server | `~/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp` |
| SHA-256 | `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e` |
| Version | `codebase-memory-mcp 0.12.1` |
| Transport | stdio, configured in `mcp.json` |
| Cache | a directory on the mounted work volume (exact path in `evidence/production-baseline.txt`) |
| Daemon | running since 2026-10-20 20:57:54, child of the live `omp` |
| Coupling to the extension | none. CBM is an MCP server; `cbm-query.js` is an OMP extension that reads the *AegisFlow EKM* store, not the CBM graph |

The R3 change does not touch `mcp.json`, the CBM binary, its cache, or the
`cbm-query.js` extension bytes.

## 6. Sessions and processes

| Fact | Observed |
|---|---|
| Live interactive OMP | pid 4905, started 2026-10-20 20:57:48, tty `stdin`, parent pid 838 (`-zsh`) |
| Worker daemons | pid 13553, 25746 — children of 4905 |
| CBM daemon | pid 4925 (child of 4922, which is a child of 4905) |
| Other OMP sessions running | none observed |
| Any session executing a governed task | **no** — no marker in any environment, no state dir, no ledger |
| Shell env of the live process | carries `PILOT_OMP_EXECUTABLE` only; no `OMP_TERMINAL_FENCE_*`, no `AEGIS_RPC_BIN` |

## 7. Controller authority

| Fact | Observed |
|---|---|
| Marker present anywhere in the live environment | **no** (`env` carries no `OMP_TERMINAL_FENCE_AUTHORITY`) |
| State directory | **none exists** — `~/.omp/*fence*` and `~/.omp/agent/*fence*` both absent |
| Any ledger file | **none** |
| Any controller process | **none** |
| Provisioned by a launcher | **no** — audited in the predecessor card and re-observed here: no launcher in the repository or in the pilot sets the marker |

`CONTROLLER_AUTHORITY = ABSENT` on this host today. The extension's commit path
is therefore closed on every ordinary `omp` start, which the rehearsal measures
directly (`CONTROLLER_AUTHORITY_DENIAL`, signed denial, zero ledger writes).

## 8. Filesystem

| Fact | Observed |
|---|---|
| Root filesystem | APFS, local, sealed, read-only volume + data volume |
| `~` | APFS, local, journaled, 9.6 GB free |
| Network mounts holding deployable state | none observed |
| `O_EXCL` semantics | native APFS — the lock's acquisition primitive is atomic here (measured on both local volumes) |
| Ledger file mode created by the extension | `-rw-------` (0600) |
| State dir mode created by the client | `drwx------` (0700) |

## 9. Plugin surface

`omp plugin list` reports four npm plugins: `@edlsh/omp-computer-use@0.1.0`,
`omp-grok-build@0.1.0`, `pi-jev@0.7.0`, `zmarketplace@0.7.8`.

These are a **load surface this card did not audit**. They are already installed
and are not part of the R3 delta, but they share the runtime with any extension
that is added later, and §C1's trust argument is about the whole loaded module
graph, not only the file the controller attests. Marked `UNKNOWN` for that
purpose rather than assumed benign.

## 10. Explicitly UNKNOWN

| Item | Why it cannot be stated |
|---|---|
| Whether the 18.12.1 → 18.12.3 upgrade changed extension-loading semantics | no changelog inspection was performed; the R3 facts were measured on 18.12.3 only |
| Behaviour of the ledger lock on a network filesystem | no network filesystem is in use, and the lock's foreign-host refusal is what would fire; not measured because there is nothing to measure |
| Whether any other host shares a state directory with this one | no state directory exists yet, so the question is vacuous today and becomes real at activation |
