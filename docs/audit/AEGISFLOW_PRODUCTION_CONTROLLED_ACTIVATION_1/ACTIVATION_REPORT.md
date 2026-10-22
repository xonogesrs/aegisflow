# Activation report

Card: `AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1`. Phase 4.

## Gate evaluation

| Gate | Required | Observed |
| --- | --- | --- |
| `BACKUP` | PASS | PASS — [manifest](PRODUCTION_BACKUP_MANIFEST.md), 26 files, byte-verified against live |
| `DEPLOYMENT` | PASS | PASS — [manifest](DEPLOYMENT_MANIFEST.md), 15/15 MATCH at `283b7e1` |
| `PRODUCTION_SMOKE` | 8/8 | 8/8 — [report](PRODUCTION_SMOKE_REPORT.md) |
| `AUTHORITY_ISOLATION` | PASS | PASS — marker absent, descriptors closed, ledger/key/extension writes denied, nested commit denied |
| `LEDGER_WITNESS` | VERIFIED | VERIFIED — and **independently reproducible**: `probes/verify-witness.mjs` recomputes every MAC from the retained witness bundle with the deployed verifier (`evidence/witness-verification.json`, `ok: true`) |
| `ROLLBACK_READY` | true | true — [readiness](ROLLBACK_READINESS.md), dry run plans 5 restore / 8 delete / 2 leave |

All six held, so enablement proceeds.

## What "active" means here, precisely

| Statement | Basis |
| --- | --- |
| The verified extension set is deployed and loads in every new OMP session | P01 + `evidence/command-and-tool-inventory.json` (54 commands incl. the three fence commands, no load error) |
| Ordinary sessions have **no** commit authority | `/fence-generation` on an ungoverned start → `CONTROLLER_AUTHORITY_ABSENT`, no ledger created; P05 |
| A governed session **does** commit, durably and authentically | P06 + P07, and again with the production model config in `evidence/production-governed-real.json`; the commit MAC is recomputable by anyone with the retained bundle (`verify-witness.mjs`) |
| The controller client is available at a durable operator path | `/Volumes/NVM2T/Development/aegisflow-production-controller` @ `283b7e1`, byte-identical to the verified blobs |
| Authority is provisioned per launch, never globally | no `OMP_TERMINAL_FENCE_*` / `OMP_CONTROLLER_*` in any shell rc, `config.yml`, `models.yml` or `mcp.json`; the marker is not set at all in the current model |
| OMP, AutoLoop and CBM are unchanged in behaviour | P01/P02/P03/P08; `config.yml`, `models.yml`, `mcp.json`, `.env` byte-identical; AutoLoop still `OFF`/`native` |

## Operator invocation

No orchestrator was installed (CHG-1 is explicit: the controller client is a caller, not an extension). A governed production session is started by the operator from the durable checkout:

```js
// run from /Volumes/NVM2T/Development/aegisflow-production-controller
import { prepareControllerRoot, createControllerGrant, attestExtension, launchGovernedRuntime }
  from "./src/control-plane/controller-client.mjs";

const extension = "/Users/zhengfengqing/.omp/agent/extensions/no-poll-waits.js";
const sha = /* sha256 of that file */;
const root = prepareControllerRoot({ root: "/absolute/private/0700/root/for/this/session" });
const runtime = await launchGovernedRuntime({
  rpcBin: "/Users/zhengfengqing/.local/bin/omp",
  controllerRoot: root,
  grant: createControllerGrant({ controllerId: "…", basis: "…" }),
  extensionPath: extension, extensionSha256: sha,
  extensionTree: attestExtension(extension, sha).digests,
  additionalExtensions: [{ path: "/Users/zhengfengqing/.omp/agent/extensions/cbm-query.js",
                           sha256: /* sha */, tree: /* same pinned tree */ }],
  args: ["--session-dir", "<session dir>", "--no-skills", "--no-rules"],
  cwd: "<trusted repo root>",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", AEGISFLOW_REPO_ROOT: "<trusted repo root>" },
});
```

Rules that remain mandatory (unchanged from admission):

1. One controller root and one live controller **per session**; reuse the same root for that session's successors (C2).
2. `PATH` pinned to `/usr/local/bin:/usr/bin:/bin`; recheck the Node digest before launch (C1).
3. Ledger is durable truth; an unreadable ledger is `UNKNOWN` and is never retried (C4).
4. Do not export the authority marker anywhere. The launch provisions it; the shell never carries it.
5. AutoLoop dispatch stays `OFF` unless separately authorized. This card did not turn it on.

## What is retained for future verification

| Artifact | Location | Purpose |
| --- | --- | --- |
| install record | `evidence/install-record.json` | exact rollback input |
| strict drift check | `evidence/post-install-check.json` | 15/15 MATCH |
| witness bundle (ledger, key, identity) | `/Volumes/NVM2T/Development/backups/aegisflow-production-activation-witness-2026-10-22/` `0700` | independent MAC recomputation |
| witness verification | `evidence/witness-verification.json` | `ok: true` |
| pre-install originals | `/Volumes/NVM2T/Development/backups/aegisflow-production-activation-2026-10-22T10-58-12Z/` `0700` | restore |

The witness key is per-launch and test-only. It is not a production credential and it authorises nothing outside that isolated ledger.

## Status

```
PRODUCTION_ENABLEMENT = true
CONTROLLER_AUTHORITY = ACTIVE
OMP_NORMAL_OPERATION = PASS
AUTOLOOP_OPERATION = PASS
CBM_OPERATION = PASS
PRODUCTION_STATUS = ACTIVE
```

The deployment is in effect for sessions started from now on. The OMP process that was already running (PID 4905) keeps the pre-install extension set it loaded at start; restarting it is **not** required for the deployment to be valid, and this card did not restart it.
