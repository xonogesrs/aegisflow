# Deployment manifest

Card: `AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1`. Phase 2. Executed 2026-10-22T11:08Z with the pinned runtime `PATH=/usr/local/bin:/usr/bin:/bin`.

## Preflight gates

| Gate | Required | Observed | Result |
| --- | --- | --- | --- |
| Deployable source SHA | `283b7e155877a366a6b3dbf53288a4e54328f09e` | worktree `/Volumes/NVM2T/Development/aegisflow-production-controller` detached at that exact SHA, clean | PASS |
| Source equals the verified tree | `git diff 283b7e1..HEAD -- integrations src scripts` empty | empty (HEAD `7842144` adds only `docs/audit/**`) | PASS |
| Pinned Node digest | `450f27e2…26fbf` | exact match, `root:wheel 0755`, `realpath` = same file, ancestors not writable by the operator UID | PASS |
| `node:sqlite` | loads | `DatabaseSync,StatementSync,constants,backup` | PASS |
| Installer source layout | accepted | `validateSourceLayout` clean, no discovery aliases, no symlinks | PASS |
| Dry-run delta | 5 replace / 8 copy / 2 unchanged | exactly that (`evidence/pre-install-dry-run.json`) | PASS |
| Authority absent from global config | required | no `OMP_TERMINAL_FENCE_*` / `OMP_CONTROLLER_*` in shell rc files or OMP config | PASS |

## The write

One command, one writer, no manual file editing:

```
PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node \
  scripts/install-omp-integration.mjs install \
  --target "$HOME/.omp/agent/extensions" --json
```

Full stdout preserved as [`evidence/install-record.json`](evidence/install-record.json). Installer backup root: `~/.omp/agent/omp-integration-backups/2026-10-22T11-08-09-953Z`.

| File | Action | Deployed SHA-256 |
| --- | --- | --- |
| `no-poll-waits.js` | replace | `14ceb06ccfde59c0889c9e14078874ed4faf8ccd5988849821b655ce485b3596` |
| `cbm-query.js` | replace | `1de77827da2b8f10fb0a8b46050331e8a498537252ac8f607e33c7678ddf7b18` |
| `lib/memory-query-core.mjs` | copy | `7b5515d9071e7685e8292f8a2d0e27ad728e8427d24b1cb0dc0e2b55d6eb5b4a` |
| `lib/memory-query-child.mjs` | copy | `9d570ab6eefb3852ba37b4935dca5b0ff3b0cb530ca20785749f98b7f744f6b6` |
| `lib/poll-wait-policy.js` | unchanged | `7c2eae224fd0965cc58f4a1f36c00c865059f18e59a7c91c6e4490f9b98090b0` |
| `lib/controller-result.mjs` | copy | `365df82cbe7e8a6ca2c0fe8bbc733cdb314a1c4fa03165d7abc356f37897d21c` |
| `lib/runtime-identity.mjs` | copy | `d680f3b480763f5e8a0d90721ad99f0a4b309f3fd04d76478a040f48d93ad1cd` |
| `lib/ledger-lock.mjs` | copy | `72d1c2d544a79daaae9caec092372825a5eff1b8611a3cff7e16199d2b5c3d2d` |
| `lib/ledger-auth.mjs` | copy | `e8e0afb9e135d9a41eda64697ca96afd7d326d4b8db8fd247452c2644b2e7cea` |
| `lib/controller-capability.mjs` | copy | `0e39e9edb6b84129012ba52f22e2a49c3cf5caf4c14e34c9a4e98eb3a02c8534` |
| `test/poll-wait-policy.test.mjs` | unchanged | `723c3932e7b6732595f779ec91c1cf77022c5b3231a2036e2fb8bf10d7697285` |
| `test/waiter-fence.acceptance.ts` | replace | `e476cff69813b6fb663ac9bad618e1323351930ca7d50bbadd1aa31d27263f4d` |
| `test/terminal-fence-authority.acceptance.ts` | replace | `9a2d9e887f7e9d761a6c33632e13bf64028125096d7f4143744a6eaf10aa1ed8` |
| `test/terminal-fence-ordering.acceptance.ts` | replace | `146a2b404ee7775290aeefbf5b0557d9b466510ad272dd438cc47eac054646bc` |
| `test/controller-contract.acceptance.ts` | copy | `2fb750ac5ea2550173174af9c747b0886a7baa64e92a01f9604d584fac9fcffd` |

The deployed tree is `18` files total: these 15 known files plus the three unrelated `orca-*.ts` extensions, which are byte-identical to the backup.

## Post-install verification

| Check | Command | Result |
| --- | --- | --- |
| Byte drift | `install-omp-integration.mjs check --strict-bytes --json` | `ok:true`, **15/15 MATCH** (`evidence/post-install-check.json`) |
| Bytes equal the verified commit | per-file `git cat-file blob 283b7e1:<path>` vs deployed file | 15/15 identical |
| Modes | `stat` | files `0644`, dirs `0755`, owner `zhengfengqing:staff`; no world-writable file; no discovery alias (`index.js`, `index.ts`, `package.json`) |
| Unrelated surfaces | `shasum` vs backup | `config.yml`, `models.yml`, `mcp.json`, `.env`, all three `orca-*.ts` unchanged |
| Installer tests (pinned Node) | `node --test` | installer 13/13, ekm query 11/11, rollback 7/7 |
| Extension load | fresh OMP RPC process, deployed discovery tree | 54 commands incl. `fence-identity`, `fence-generation`, `release-final`; no `Failed to load extension` (`evidence/command-and-tool-inventory.json`) |

## Controller authority and topology (C2/C3/C4)

Nothing was configured globally. Per [DEPLOYMENT_RESTRICTIONS.md](../AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1/DEPLOYMENT_RESTRICTIONS.md):

- **C1** — governed launches load only the attested `no-poll-waits.js` + `cbm-query.js` with a pinned `lib/` tree digest, `--no-extensions`, and the pinned `PATH`. Attested tree recorded in `evidence/production-smoke.json`.
- **C2** — one private `0700` controller root per launch; the ledger is `state/ledger.jsonl` inside it, never in `~/.omp`; one live controller per session (enforced by the operator, not by code — unchanged restriction).
- **C3** — each launch mints its own result key and correlator; no key reuse across launches.
- **C4** — the ledger is durable truth; an unreadable ledger is `UNKNOWN` and is never retried.
- **Authority isolation** — the retired `OMP_TERMINAL_FENCE_AUTHORITY` marker is never set; authority is an inherited descriptor + per-launch key, neither of which survives into the agent's shell.

Durable operator location for the controller client (not deployed as an extension, per CHG-1):

```
/Volumes/NVM2T/Development/aegisflow-production-controller   (detached HEAD 283b7e1, clean)
```

Verified there: `src/control-plane/controller-client.mjs`, both extensions and `src/memory/index.mjs` are byte-identical to the `283b7e1` blobs. This gives the operator a stable, durable path for `launchGovernedRuntime` instead of the `/private/tmp` audit worktree. It is operator-UID owned like the rest of the deployment: C1 controls what the governed child loads by attestation, not by account separation, and the sandbox denies writes to the attested tree for the whole process tree.

```
DEPLOYMENT = PASS
DEPLOYED_TREE_SHA256 = 15/15 MATCH at 283b7e1
PRODUCTION_CONFIG_MUTATION = NONE (config.yml, models.yml, mcp.json, .env unchanged)
```
