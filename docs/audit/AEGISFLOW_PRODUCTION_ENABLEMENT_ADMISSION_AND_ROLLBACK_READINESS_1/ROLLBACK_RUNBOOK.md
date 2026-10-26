# Production rollback runbook

**Card:** `AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1`
**Phase:** F
**Rehearsed:** yes — see §7, which is the measured output, not a plan.
**Scope:** undoing CHG-2 (the only production write). CHG-1/3/4 are orchestrator
side and have their own reversal.

---

## 1. The one rule

**`uninstall` is not a rollback, and on this deployment it is destructive.**
Measured twice, on isolated trees seeded with the production bytes:

Run 1 (tree with only the pre-R3 extension + `poll-wait-policy.js`):

```
restore  no-poll-waits.js  <- backups/<stamp>/no-poll-waits.js
remove   cbm-query.js
remove   lib/poll-wait-policy.js
remove   lib/controller-result.mjs
remove   lib/runtime-identity.mjs
remove   lib/ledger-lock.mjs
remove   test/*  (5 files)
UNINSTALL_RESULT = RESTORED
```

Run 2 (same, plus a `cbm-query.js` byte-identical to the published one):

```
install actions:  no-poll-waits.js  replace   (backup taken)
                  cbm-query.js      unchanged (NO backup)
                  lib/poll-wait-policy.js  unchanged (NO backup)
                  … four new files  copy
uninstall actions: restore no-poll-waits.js
                   remove  cbm-query.js          ← a PRE-EXISTING production file
                   remove  lib/poll-wait-policy.js
                   remove  the four new files
UNINSTALL_RESULT = RESTORED
```

Two distinct damages, both from the same cause — `uninstall` removes every
`KNOWN_FILES` entry that has no backup, and `unchanged` files have no backup:

1. The restored extension imports `./lib/poll-wait-policy.js`, which is now gone.
   The runtime cannot load the extension.
2. **`cbm-query.js` is deleted.** That is a pre-existing production file,
   unrelated to R3, with no backup to restore from. Recovering it requires the
   repository or the pre-change `sha256` list plus a copy.

`UNINSTALL_RESULT = RESTORED` is therefore a true statement about the installer's
intent and a false one about the resulting tree. This is a property of the
installer as shipped at `2fa42d6`, not something this card introduced; it is
recorded here because the runbook is where an operator would reach for
`uninstall` under pressure.

The correct reversal is `scripts/omp-rollback-integration.mjs`, which replays the
install record:

| install action | rollback action |
|---|---|
| `copy` (file did not exist) | delete it |
| `replace` (file existed) | restore the backup bytes |
| `unchanged` | leave it alone |

Nothing is inferred. If the record and the target disagree — a file changed after
the install, a backup is missing — the rollback **refuses** and changes nothing.
A rollback that guesses is worse than one that stops.

## 2. Before the change: record

```bash
# 1. the bytes you are about to disturb
shasum -a 256 ~/.omp/agent/extensions/*.js ~/.omp/agent/extensions/*.ts \
              ~/.omp/agent/extensions/lib/* ~/.omp/agent/extensions/test/* \
              ~/.omp/agent/config.yml ~/.omp/agent/mcp.json \
  > ~/deploy-evidence/$(date -u +%Y%m%dT%H%M%SZ)-before.sha256

# 2. the deployment surface as the installer sees it
#    EXPECT exit 1 HERE. Before the install, production is behind the repository,
#    so this reports DRIFT (no-poll-waits.js) and MISSING (the three lib modules
#    and the contract test). That is the correct pre-change state and it is what
#    the post-change run is compared against. Do not "fix" it by installing early.
node scripts/install-omp-integration.mjs check --strict-bytes || true

# 3. the runtime identity
~/.local/bin/omp --version
shasum -a 256 ~/.local/bin/omp
```

Preserve all three. The first is how you prove the restore; the second is how you
know what was there; the third is how you know the binary did not move.

## 3. The change

```bash
node scripts/install-omp-integration.mjs install \
  --backup-root ~/deploy-evidence/omp-backups \
  --json > ~/deploy-evidence/install-record.json
```

**The install record is the rollback input.** Without it there is no precise
reversal. Copy it off the machine before proceeding.

Then, and only then:

```bash
node scripts/install-omp-integration.mjs check --strict-bytes
```

`MATCH` on all 11 files is the pass condition, and `check` must now **exit 0**.
Measured before the change on this host: `MATCH=6 EQUIVALENT=0 DRIFT=1 MISSING=4`,
`DRIFT_CHECK=MISSING`, exit **1**. Measured after a successful install:
`MATCH=11`, exit **0**. A post-install `MISSING` on any of the three new `lib/`
modules means the extension will not load (measured: OMP prints
`Failed to load extension … Cannot find module` and continues **without** it).

**After the ROLLBACK the expectation inverts, and that is the proof it worked.**
Measured on the rehearsed tree, checking the restored deployment against the R3
source:

```
MATCH=6 EQUIVALENT=0 DRIFT=1 MISSING=4
DRIFT_CHECK=MISSING
exit 1
```

That is byte-for-byte the same report as the pre-install baseline in §2 — which
is exactly the claim a rollback makes. An operator who expects `MATCH=11` after a
rollback will read a successful restore as a failure. The correct post-rollback
assertion is: **`check` reproduces the pre-change report**, and the restored
runtime answers a prompt (measured: `REHEARSAL_PROMPT_OK`).

## 4. Activation ordering, and where the atomic boundary is

```
1. stop starting new governed runs
2. CHG-4: stop provisioning the marker (the controller's launch env)
3. CHG-1: stop invoking the controller client
4. CHG-2: run the rollback
5. CHG-3: archive the state directory, then remove it
```

Authority is revoked **before** the code is removed. Reversing those two leaves a
window in which a loaded extension still has a marker it can act on.

The rollback is not atomic across the four files — the installer writes
file-by-file with temp+rename. The atomic boundary is the `check` that follows it:
until that report matches the pre-change baseline, the tree is in an undefined
state.

**The rollback is NOT idempotent, and a second run will refuse rather than
finish.** `scripts/omp-rollback-integration.mjs` preflights every step against the
current tree and refuses when a `copy` target it is supposed to delete is already
absent (measured: after one complete rollback, a second invocation returns
`REFUSED` and changes nothing). So a *partially* applied rollback cannot be
completed by running it again.

Correct recovery from a partial rollback is reconciliation, not re-execution:

1. read the install record's `actions` — it names every file, its action, and the
   `deployedSha256` the install wrote;
2. for each `copy`, delete if present (idempotent by hand, one file at a time);
3. for each `replace`, restore the recorded `backup` path and verify against the
   pre-change `sha256` list;
4. for each `unchanged`, verify it still matches — and if it is missing, restore it
   from the correct revision (§8);
5. re-run `check` and compare against the pre-change baseline.

## 4b. Revocation is a process operation

Three separate things are easy to conflate, and only the third revokes:

| Action | Effect |
|---|---|
| unset the variable in `~/.zshrc` | affects shells started later; nothing already running |
| unset it in the controller's environment | future `launchGovernedRuntime` calls launch ungoverned children |
| terminate the governed process tree | the only action that stops a process that **already holds** the marker |

A running governed child's environment is immutable from outside. Its `bash`
descendants inherit it. So "we removed the marker" is only true once no process
in the tree carries it, and that is verified with
`ps eww -p <pid> | grep OMP_TERMINAL_FENCE_AUTHORITY`, not with `env` in the
operator's shell.

## 4a. The marker is not a shell variable

`OMP_TERMINAL_FENCE_AUTHORITY` must exist **only** in the environment the
controller builds for the child it launches. Three consequences that have bitten
this card's own testing:

- Exporting it in `~/.zshrc`, or in the terminal that starts the controller, makes
  every governed launch fail with `AUTHORITY_INHERITED` — the client checks its
  own process environment as well as the child environment it is about to build.
- It is inherited by everything the governed agent spawns, including its `bash`
  tool. That is the C1 finding and the reason activation is not recommended.
- It is not a capability an agent can derive, print or reach through a tool. An
  agent that sets it in a child environment is refused by the same check.

## 5. Stop order

| Step | Action | Why this order |
|---|---|---|
| 1 | stop launching governed runs | no new commit can be attempted |
| 2 | unset any **inherited** `OMP_TERMINAL_FENCE_AUTHORITY` in the controller's own environment | clears a launch refusal, nothing more. `launchGovernedRuntime` PROVISIONS the marker in every child it launches regardless of its parent's environment, so this does **not** stop future governed launches. Those stop when orchestration stops calling the client, or when the launch path changes (step 3) |
| 2b | **revocation is by process, not by variable.** Unsetting the variable in the parent changes nothing about a child already spawned: that child's own environment still holds the marker, and so does every `bash` it spawns. Revoke by terminating the governed process **tree** (root pid and its descendants), then verify | an unset variable looks like revocation and is not |
| 2a | **also** confirm the *operator's own shell* does not export it | the client refuses to launch when its **parent** carries the marker (`AUTHORITY_INHERITED`). An operator who exports it "just to test" breaks every later governed launch, and the refusal looks like a controller bug |
| 3 | let running governed processes finish or terminate them by pid | killing mid-commit leaves `UNKNOWN`; the ledger, not the process, is the witness |
| 4 | verify no governed process remains: `ps -Ao pid,command \| grep -i omp`, and for each, `ps eww -p <pid> \| grep OMP_TERMINAL_FENCE_AUTHORITY` | a nested runtime left behind is a runtime with authority. The second command is the actual test; the first only finds candidates |
| 5 | run the rollback | now nothing is reading the extension for authority |
| 6 | `check --strict-bytes` | proves the tree |

## 6. Evidence to preserve, and why

| Artifact | Why it must not be deleted |
|---|---|
| install record JSON | the rollback input; also the proof of what was written |
| backup directory | the only copy of the replaced bytes |
| every ledger file (`<stateDir>/<sessionId>.jsonl`) | the only durable statement of what committed |
| every `.lock` file | evidence of whether a critical section was live at the time |
| signed result frames (RPC stdout captures) | the report about the ledger; needed to reconcile `UNKNOWN` |
| the before/after `sha256` lists | proof the restore was byte-identical |

A state directory is removed **only after** its ledger is archived. Removing it
destroys the only record of what happened.

## 7. Rehearsal — measured, not planned

Executed on an isolated tree seeded with the **production-shaped file set**, each
file from the revision this deployment actually runs — `no-poll-waits.js` from
`fb8ce6a`, `cbm-query.js` from `1ebb121`, and the five unchanged files from
`fb8ce6a`. Installed over with the R3 tree, then rolled back with the record the
install emitted.

An earlier version of this rehearsal seeded only two files, so `cbm-query.js` and
the four existing tests were `copy` actions and the rollback deleted them. The
byte-identical result was real but it described a two-file tree, not the
deployment. Independent review caught it; the seed is now the full set and the
action classes are asserted rather than assumed.

```
ROLLBACK:install-applied              replace,unchanged,unchanged,copy,copy,copy,unchanged,unchanged,unchanged,unchanged,copy
ROLLBACK:preexisting-files-unchanged  cbm-query.js:unchanged, lib/poll-wait-policy.js:unchanged, test/*:unchanged …
ROLLBACK:r3-files-copied              lib/controller-result.mjs, lib/runtime-identity.mjs, lib/ledger-lock.mjs, test/controller-contract.acceptance.ts
ROLLBACK:byte-identical-restore       { ok: true, identical: true }
ROLLBACK:preexisting-files-survived   cbm-query.js, lib/poll-wait-policy.js, test/waiter-fence.acceptance.ts
ROLLBACK:r3-files-removed             (none remaining)
ROLLBACK:restored-runtime-answers     "REHEARSAL_PROMPT_OK"
```

`ORIGINAL_FUNCTIONS_RESTORED = true` is therefore now a claim about the whole
tree: the six pre-existing files are `unchanged` at install, still present and
byte-identical after rollback, the four R3-only files are gone, and the restored
runtime answers.

The byte comparison is over the whole tree, not the extension alone:

```
$ (cd target && find . -type f | sort | xargs shasum -a 256) > before
$ node scripts/omp-rollback-integration.mjs install-record.json --json
$ (cd target && find . -type f | sort | xargs shasum -a 256) > after
$ diff before after && echo BYTE_IDENTICAL_RESTORE=true
BYTE_IDENTICAL_RESTORE=true
```

The distinction from `uninstall` is not stylistic: for the same record the
rollback's action list is `restore no-poll-waits.js`, `leave` the six
pre-existing files, `delete` the four R3-only files — where `uninstall` `remove`s
every file that has no backup, which is exactly the six `leave`s.

`EVIDENCE_PRESERVED = true`, measured separately because it is a different claim
from "the tree restored":

```
rollback ok: true
ledger survived byte-identical: true
evidence survived byte-identical: true
backup retained: true
```

The ledger and the evidence file both live outside the extension tree, and both
were byte-identical after the rollback. The backup directory was retained.

`TEST_AUTHORITY_REVOKED = true`: no marker was set in the rehearsal's rollback
path, and the rehearsal's own process environment carried none — verified by the
absence of `OMP_TERMINAL_FENCE_*` in the environment of every process it started.

## 8. If the rollback refuses

A refusal means the record and the target disagree. Do **not** force it.

| Refusal | Meaning | Correct response |
|---|---|---|
| a file changed after install | someone edited the deployed copy | preserve the current bytes, then decide: is the edit wanted? If not, restore from the backup by hand and record it |
| a backup is missing | the backup root was moved or pruned | reconstruct from the revision named per file in §8a, verify against the pre-change `sha256` list, and record the reconstruction |
| someone already ran `uninstall` | `cbm-query.js` and `lib/poll-wait-policy.js` are gone and the record still expects them | restore both from the revisions in §8a, then run the rollback; do not re-run `uninstall` |
| target names a path outside the deployment set | the record was tampered with | stop; the record is not trustworthy |

Forbidden throughout: `git reset --hard`, `git clean -fd`, `git push --force`,
`git stash drop`, and deleting a state directory without archiving its ledger.

## 8a. Which revision restores which file

**The deployed files do not all come from one commit.** Restoring everything from
`fb8ce6a` would silently downgrade the memory tool:

| File | Restore from | Expected SHA-256 |
|---|---|---|
| `no-poll-waits.js` (pre-R3) | `fb8ce6a:integrations/omp/extensions/no-poll-waits.js` | `c2382ffe…630` as committed; deployed copy is `11d8628b…f8ef` (one redacted UUID) |
| `cbm-query.js` | `1ebb121:integrations/omp/extensions/cbm-query.js` — **not** `fb8ce6a` | `03c08f43…b75e` |
| `lib/poll-wait-policy.js` | `fb8ce6a:…/lib/poll-wait-policy.js` | `7c2eae22…90b0` |
| `test/poll-wait-policy.test.mjs` | `fb8ce6a:…/test/poll-wait-policy.test.mjs` | `723c3932…285` |
| `test/waiter-fence.acceptance.ts` | `fb8ce6a:…/test/waiter-fence.acceptance.ts` | `d36c62f8…e65e` |
| `test/terminal-fence-authority.acceptance.ts` | `fb8ce6a:…` | `ae16f114…135a` |
| `test/terminal-fence-ordering.acceptance.ts` | `fb8ce6a:…` | `7fae4534…8244` |

`cbm-query.js` is at the later EKM revision (`1ebb121 feat(ekm): name the
first-party memory tool ekm_query`), which is an ancestor of the R3 head but not
of `fb8ce6a`. Verify by hash before writing, and never overwrite a file whose
current hash already matches.

## 9. What rollback does not restore

- **A committed generation stays committed.** Rollback restores code, not
  history. If a generation was fenced before the rollback, it stays fenced; the
  ledger says so and the ledger is kept.
- **Suppressed job deliveries stay suppressed.** Their identity was never
  durable (C4).
- **A leaked nested runtime is not stopped by the rollback.** It must be found by
  pid and terminated, which is why §5 step 4 exists.
