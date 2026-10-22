# Final disposition

Card: `AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1`
Mode: controlled deployment → production smoke → activation → closeout
Date: 2026-10-22 UTC

```text
CARD = AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1

OWNER_AUTHORIZATION = GRANTED

PREVIOUS_LANDING = PASS
PRODUCTION_BACKUP = PASS
DEPLOYMENT = PASS

PRODUCTION_SMOKE = 8/8
AUTHORITY_ISOLATION = PASS
LEDGER_WITNESS = VERIFIED

AUTOLOOP = PASS
CBM = PASS
OMP = PASS

ROLLBACK_READY = true
ROLLBACK_EXECUTED = false

PRODUCTION_ENABLEMENT = true
PRODUCTION_STATUS = ACTIVE

DURABLE_LANDING = PASS
LANDED_HEAD = reported in the handoff (a commit cannot contain its own SHA)

GDR_1_APPROVED = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED = false

NEXT_ACTION = Operate AEGISFLOW normally; report problems. Deployment engineering stops here.
```

## Why this is PASS and not HOLD

| Card requirement | Where it is proved |
| --- | --- |
| Deployment matches the verified version | 15/15 files byte-equal to the `283b7e1` blobs, `check --strict-bytes` exit 0 ([deployment manifest](DEPLOYMENT_MANIFEST.md)) |
| Minimal production verification | P01–P08, [smoke report](PRODUCTION_SMOKE_REPORT.md) |
| Controller authority normal, not leaked | marker absent, descriptors closed, ledger/key/extension writes denied, nested commit denied with the explicit `CONTROLLER_AUTHORITY_ABSENT` line |
| Ledger witness consistent | authenticated record + matching identity + controller result, **recomputable** by `probes/verify-witness.mjs` from a retained `0700` bundle |
| OMP / AutoLoop / CBM not degraded | P01/P02/P03/P08; `config.yml`, `models.yml`, `mcp.json`, `.env` byte-identical; EKM store byte-identical |
| Rollback feasible | dry run plans 5 restore / 8 delete / 2 leave; restore rehearsal byte-identical |
| Independent review | `REVIEW = PASS` after one HOLD round; the HOLD trail is preserved in [the review](INDEPENDENT_REVIEW.md) |

## What was changed in production

Exactly one write: the extension directory, via `scripts/install-omp-integration.mjs install`. Nothing else.

| Surface | Changed? |
| --- | --- |
| `~/.omp/agent/extensions/` | **yes** — 5 replaced, 8 added, 2 unchanged, 3 unrelated `orca-*.ts` untouched |
| `~/.omp/agent/{config.yml,models.yml,mcp.json,.env}` | no |
| `~/.local/bin/omp`, `~/.local/bin/al-omp`, `/usr/local/bin/node` | no |
| AutoLoop pilot config and state | no (`OFF`/`native` before and after) |
| CBM binary, cache, `mcp.json` server definition | no |
| Production EKM store | no (read-only; hashes unchanged) |
| Sessions | no (no process signalled; 0 malformed lines in the 40 newest files) |

## Honest limits

- **Same-UID model.** The governed child runs as the operator UID. The boundary is the seatbelt profile plus descriptor/key inheritance, not OS account separation. This was admitted before deployment and is unchanged.
- **C2 is operator-enforced.** One state directory and one live controller per session. Code does not enforce the session→directory mapping.
- **Witness scope.** The retained bundle authenticates the smoke session it was produced with. It does not retroactively authenticate earlier ledgers whose roots were removed.
- **AutoLoop dispatch `ON` is untested.** The card did not enable it and did not test it.
- **The pre-existing OMP process (PID 4905)** still runs the extension set it loaded at start. New sessions get the deployed set. Restarting it was not required and was not done.
- **Unrelated pre-existing defect, left alone:** `mcp.json` points the `kicad` server at the dangling symlink `~/.local/bin/node` → removed `~/.hermes`. OMP prints a connection warning. Fixing it would be an out-of-scope production edit.

## Card rules honoured

- GDR-1 was **not** approved.
- The original generation was **not** retroactively committed.
- The hardening branch was **not** closed.
- No historical generation was rewritten or re-signed.
- No secret, authority key or sensitive ledger content was committed; the ledger key is retained only in a `0700` directory outside the repository.
