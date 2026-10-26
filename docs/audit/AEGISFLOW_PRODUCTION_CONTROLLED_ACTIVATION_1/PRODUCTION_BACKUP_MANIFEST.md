# Production backup manifest

Card: `AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1`. Phase 1. Captured 2026-10-22T10:58Z, **before** any production write.

## Backup roots

| Root | Purpose | Contents | Digest |
| --- | --- | --- | --- |
| `/Volumes/NVM2T/Development/backups/aegisflow-production-activation-2026-10-22T10-58-12Z` (mode `0700`) | frozen originals, operator-restorable | 26 files: full `extensions/` tree, `config.yml`, `models.yml`, `mcp.json`, `.env`, `launchers/` (`al-omp`, its symlink record, pilot `lib/*.js`, `lib/pty-proxy.py`, `MANIFEST.sha256`), `omp-binary.stat.txt` | manifest of the 26 file hashes: `2c851cdd42d3aa9cfb72118a30dc076af686f1aa3066eea27d6eb4f8ce32d683` |
| `~/.omp/agent/omp-integration-backups/2026-10-22T11-08-09-953Z` | installer's own byte-for-byte copies of every replaced file | `no-poll-waits.js`, `cbm-query.js`, `test/{waiter-fence,terminal-fence-authority,terminal-fence-ordering}.acceptance.ts` | recorded per-file in `evidence/install-record.json` |

Ownership, stated precisely — an earlier draft of this line was wrong and is corrected here:

- The dated backup root is on the durable volume, mode `0700`, owned by the operator UID. It is **not** under `~/.omp`, but it is still owned by the same UID as the agent; it is not a separate-UID immutable store.
- The installer's backup root (`~/.omp/agent/omp-integration-backups/<stamp>`) is **inside** `~/.omp/agent`. `~/.omp/agent` is mode `0700`, so it is not readable or writable by other users, but it *is* inside the agent's own writable surface. It is a rollback input, not a tamper-proof archive.
- Neither root is a defence against a same-UID attacker. The defence against tampering with the *running* system is the launch sandbox denying writes to the attested tree, not the location of the backups.

## Pre-change production state (SHA-256, verified byte-identical to the live files)

| Surface | Path | SHA-256 | Mode / owner |
| --- | --- | --- | --- |
| extension | `~/.omp/agent/extensions/no-poll-waits.js` | `11d8628ba5deb2671670956b3b4d04ea82228c004971904f7aa670fd96e6f8ef` | `0644 zhengfengqing:staff` |
| extension | `~/.omp/agent/extensions/cbm-query.js` | `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e` | `0644` |
| extension | `~/.omp/agent/extensions/lib/poll-wait-policy.js` | `7c2eae224fd0965cc58f4a1f36c00c865059f18e59a7c91c6e4490f9b98090b0` | `0644` |
| extension (unrelated, untouched) | `orca-agent-status.ts` | `49a8b7e673a36c95dc3b801cf43408231653e70ed1224e8e349feeb1397bb0ed` | `0644` |
| extension (unrelated, untouched) | `orca-prefill.ts` | `5e18bf52a7ed8e04e9ba9f00b7c35f74d93e9dc981a81956e23fd5bfb1c5dc1a` | `0644` |
| extension (unrelated, untouched) | `orca-titlebar-spinner.ts` | `16b0ff9134ec39527cc06f31664cf5e43170a2b6c3cb5a2a251a20f5a565329c` | `0644` |
| test (deployed) | `extensions/test/poll-wait-policy.test.mjs` | `723c3932e7b6732595f779ec91c1cf77022c5b3231a2036e2fb8bf10d7697285` | `0644` |
| test (deployed) | `extensions/test/terminal-fence-authority.acceptance.ts` | `ae16f1142914a9ecfecfa18006b5adef5e897c38f67994a9c16375a507e3135a` | `0644` |
| test (deployed) | `extensions/test/terminal-fence-ordering.acceptance.ts` | `7fae4534919c1fb6ad024bced1b3656362a20f08eee9c18f58c060a523318244` | `0644` |
| test (deployed) | `extensions/test/waiter-fence.acceptance.ts` | `d36c62f8fa355e963d9d4b8bd14bcb1020e68f35ebd4fedaa65b416b2306c65e` | `0644` |
| config | `~/.omp/agent/config.yml` | `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66` | `0600` |
| config | `~/.omp/agent/models.yml` | `e2346f8ff347171c3e024da292d255947199288943e4def6a6a86ae6ec06c641` | `0600` |
| config | `~/.omp/agent/mcp.json` | `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4` | `0644` |
| config | `~/.omp/agent/.env` | `8811b9b38f70f0909e2bc7da1cbe94678df99f62f7c93896ef2d7783f00b37f4` | `0600` |
| binary | `~/.local/bin/omp` | `f2a657b3320fcafa23055053940a45b26a8d3254e1412a158838013d670d6ec5` | `0755`, omp/18.12.3 |
| launcher | `~/.local/bin/al-omp` → `/Volumes/NVM2T/Development/autoloop-omp-pilot/bin/al-omp` | `5408ce021dfa24bbaf9206806845fc98be58bb2aed8940100aec462d8e569ce4` | `0711` |
| pinned runtime | `/usr/local/bin/node` | `450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf` | `0755 root:wheel`, v22.22.2 |
| CBM binary | `~/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp` | `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e` | `0755` |

`al-omp` and the pinned Node binary are **not** modified by this deployment; they are recorded so a later divergence is detectable.

## Controller state / ledger baseline

No production controller state existed before this card and none was created by it:

- no `~/.omp` state directory, no `ledger.jsonl`, no `ledger.key`;
- `OMP_TERMINAL_FENCE_AUTHORITY`, `OMP_TERMINAL_FENCE_STATE_DIR`, `OMP_CONTROLLER_*` are absent from `~/.zshrc`, `~/.zprofile`, `~/.zshenv`, `~/.profile`, `config.yml`, `models.yml` and `mcp.json` (grep: `NO_AUTHORITY_VARS_IN_SHELL_OR_CONFIG`);
- `al-omp status` = `OFF`, dispatch `native`; `al-omp is-on` exit 1.

Governed launches provision their own private `0700` root per launch; the per-session ledger lives there, outside `~/.omp`. That is unchanged by the install.

## Live-usage check before writing

| Observation | Value |
| --- | --- |
| OMP process | PID 4905, parent 838 (`-zsh`), running 1d22h — this agent session |
| CBM children | PID 4922 (stdio server) and 4925 (`--cbm-daemon-internal`) under 4905 |
| OMP worker brokers | PID 13553, 25746 under 4905 |
| Existing sessions | 1810 `*.jsonl` session files at capture time (1811 later, the extra file being the reviewer's own session); no process was signalled, restarted or killed |
| AutoLoop | `OFF` / `native` |

No process was terminated to perform the deployment. The running OMP (4905) loaded the **pre-install** extension set at its own start; the install changes the bytes on disk and therefore takes effect for sessions started afterwards. That is the documented behaviour of extension discovery and is why P01/P03 were run as new processes.

## Restorability rehearsal

| Check | Command | Result |
| --- | --- | --- |
| tree readable | `tar -cf /dev/null <backup root>` | exit 0, `BACKUP_TREE_READABLE=true` |
| restore reproduces the frozen state | copy `extensions/` + the four config files into a throwaway directory, hash, diff against the backup hashes | `RESTORE_BYTE_IDENTICAL=true` (no diff) |
| installer record still describes the live tree | `check --strict-bytes` after install and after smoke | 15/15 `MATCH` both times |

The rehearsal restored into a temporary directory, never into production. A real restore would be `cp -a` of `extensions/` plus the four config files back to `~/.omp/agent` — nothing else in that directory was modified, so nothing else needs restoring.

```
PRODUCTION_BACKUP = PASS
ROLLBACK_READY = true
```
