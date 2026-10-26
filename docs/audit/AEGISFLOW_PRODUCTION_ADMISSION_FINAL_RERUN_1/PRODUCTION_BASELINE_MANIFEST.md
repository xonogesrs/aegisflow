# Production baseline manifest

Card: `AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1`

Observed: 2026-10-22 UTC, read only. Production was not stopped, restarted, or edited.

| Surface | Current observation | Comparison with 2026-10-21 baseline |
| --- | --- | --- |
| OMP binary | `~/.local/bin/omp`, SHA-256 `f2a657b3320fcafa23055053940a45b26a8d3254e1412a158838013d670d6ec5` | Exact match |
| Deployed `no-poll-waits.js` | `11d8628ba5deb2671670956b3b4d04ea82228c004971904f7aa670fd96e6f8ef` | Exact match; R4 version not installed |
| Deployed `cbm-query.js` | `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e` | Exact match; C1 version not installed |
| `config.yml` | `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66` | Exact match |
| `models.yml` | `e2346f8ff347171c3e024da292d255947199288943e4def6a6a86ae6ec06c641` | Exact match |
| `mcp.json` | `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4` | Exact match |
| CBM MCP binary | `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e` | Exact match |
| AutoLoop | `al-omp status`: `OFF`, dispatch `native` | Same state |
| Live sessions | OMP PID 4905; CBM child PID 4922 observed by `ps` | Same live session as baseline; no intervention |
| Deployed extension tree | 10 files: five discovered top-level modules, `lib/poll-wait-policy.js`, four tests | Same file set as baseline; C1/R4 modules absent |

Deployed extension directory remains `~/.omp/agent/extensions`, owned by operator, mode `0755`; `~/.omp/agent` is `0700`. Production OMP has no controller client wiring. Prior baseline reports no authority marker, controller, state directory, or ledger; no such production state was created during this card. Process-environment inspection of live PID was not performed, so absence of a marker **inside that live process** is not newly proven here. Current `al-omp` mode and undeployed R4 modules support continued non-enablement.

The production extension is deliberately older than the `283b7e1` deployable tree. The installer's read-only `install --dry-run --json` classified 15 known files: 5 `replace`, 8 `copy`, 2 `unchanged`. That is an expected admission-to-deployment delta, not unexplained drift. In particular, the C1 `cbm-query.js` **will replace** the deployed copy. Do not use the older R3 change plan's four-file delta as today's install manifest.

The current interactive shell resolves `node` to `/opt/homebrew/bin/node` (SHA-256 `08dad0581f00a0cabf4d49ec92ca1f25fdfd01c2c18fa8e92b35f04d4c24c164`). `/opt/homebrew/bin` and Node's Cellar ancestors are owned and writable by the operator UID. The shell PATH also begins with operator-writable directories. This is the exact residual risk; deployment must use the pinned PATH in [DEPLOYMENT_RESTRICTIONS.md](DEPLOYMENT_RESTRICTIONS.md).

Reference baseline: [previous production manifest](../AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1/PRODUCTION_BASELINE_MANIFEST.md). Hashes above were re-read from live files, not copied from that manifest.
