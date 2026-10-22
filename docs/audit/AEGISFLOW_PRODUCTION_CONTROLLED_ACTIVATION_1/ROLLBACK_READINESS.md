# Rollback readiness

Card: `AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1`. Phase 1/4. Rollback was **prepared and dry-run**, never executed: no abort condition fired.

## Reversal is exact, not best-effort

`scripts/omp-rollback-integration.mjs` reverses the recorded install step by step from `evidence/install-record.json` — no inference, no heuristics:

| Action in the record | Reversal |
| --- | --- |
| `replace` (5 files) | restore the installer's byte-for-byte backup |
| `copy` (8 files) | delete the file the install created |
| `unchanged` (2 files) | leave alone |

Dry run against the live tree: `ok: true`, 15 steps — **5 restore, 8 delete, 2 leave**, `prunedDirectories: []` (`evidence/rollback-dry-run.json`). It refuses to act if any deployed byte has drifted since the install, which is why the post-smoke `check --strict-bytes` (15/15 MATCH) matters: the record still describes the tree.

`uninstall` is **not** the rollback and is not used: it would restore `no-poll-waits.js` and then delete `lib/poll-wait-policy.js`, leaving an extension that cannot import its dependency.

## Independent recovery material

Even if the install record were lost, the frozen tree at
`/Volumes/NVM2T/Development/backups/aegisflow-production-activation-2026-10-22T10-58-12Z`
restores the exact pre-deployment state: 26 files, hashes in
[`PRODUCTION_BACKUP_MANIFEST.md`](PRODUCTION_BACKUP_MANIFEST.md), manifest digest `2c851cdd42d3aa9cfb72118a30dc076af686f1aa3066eea27d6eb4f8ce32d683`. Restoring it is a plain copy of `extensions/` plus the four config files; nothing else in `~/.omp/agent` was touched. A restore rehearsal (copy into a throwaway directory, hash, diff) reproduced the frozen hashes byte-for-byte (`RESTORE_BYTE_IDENTICAL=true`).

Both backup roots are operator-UID owned. Neither is a tamper-proof archive — the dated root is outside `~/.omp` but same-UID, and the installer's root is inside `~/.omp/agent`. Rollback protects against a bad deployment, not against a same-UID attacker who has already rewritten the backups.

## What a rollback does not need to do

| Surface | Why no reversal is required |
| --- | --- |
| `config.yml`, `models.yml`, `mcp.json`, `.env` | byte-identical to the backup; never written |
| `~/.local/bin/omp`, `/usr/local/bin/node`, CBM binary, `al-omp` | never written |
| AutoLoop pilot config | never written; still `OFF`/`native` |
| Sessions | never written; no session was killed or resumed by the deployment |
| Production EKM store | read-only throughout; hashes unchanged |
| Controller ledger | no production controller root or ledger was created |

## Abort triggers and their status

| Trigger | Status |
| --- | --- |
| Controller authority leaked to the agent | not observed — P05 |
| Agent forged a valid commit | not observed — P05 (nested commit denied, zero records) |
| CBM / AutoLoop major regression | not observed — P02, P03 |
| Ledger state inconsistent | not observed — P07 |
| Deployed files differ from the verified version | not observed — 15/15 MATCH at `283b7e1` |
| Existing session interrupted | not observed — P08 |
| Rollback not feasible | not the case — dry run plans all 15 steps |

```
ROLLBACK_READY = true
ROLLBACK_EXECUTED = false
```
