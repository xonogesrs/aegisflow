# Operations

Running AegisFlow day to day: what to watch, how to inspect it, and how to
recover. Everything here is read-only unless stated otherwise.

## Normal operation

A healthy run:

1. is admitted (a frozen admission record exists);
2. executes in isolation with a metered budget;
3. writes harness-owned evidence;
4. receives a verdict from an independent reviewer;
5. passes the gate chain and produces a durable closeout.

Your job during a run is to **not interfere with shared runtime state**. Two
operations must never overlap on the same sandbox profile; the single-flight
lock enforces this and a second attempt fails fast with
`HOLD / COLIMA_PROFILE_BUSY`.

## Routine inspection

```bash
# What happened in a run
node scripts/aegisflow-operator.mjs --run <graphRunId>
node scripts/aegisflow-operator.mjs --run <graphRunId> --json

# Latest formal execution review
node scripts/gov-execution-review.mjs --status

# Evolution state
node scripts/evolution-operator.mjs --json
node scripts/evolution-kill-switch.mjs --store <dir> --status
```

Both operator views are read-only and safe against unknown, completed,
partially-retained, telemetry-disabled and partial runs. They report `UNKNOWN`
rather than inventing state.

## Reading a HOLD

A HOLD is a structured refusal with a stable code. The workflow:

1. **Get the code.** The reason string names it, e.g.
   `HOLD / COLIMA_PROFILE_BUSY` or `MUTATION_SCOPE_VIOLATION`.
2. **Locate the domain** from the prefix
   (see [governance.md § HOLD codes](governance.md#hold-codes-the-diagnostic-surface)).
3. **Read the structured detail.** The operator report and the journal carry
   the payload: which path, which digest, which identity.
4. **Fix the cause, not the symptom.** A HOLD exists because a fence was hit.
   Re-running rarely helps unless the fence was environmental.

### Common HOLDs and what they actually mean

| HOLD | Meaning | Safe action |
|---|---|---|
| `COLIMA_PROFILE_BUSY` | another operation holds the sandbox profile | wait for it to finish; do not retry in a loop, and do not "clean up" the lock file while the owner lives |
| `COLIMA_HOME_NOT_CANONICAL` | `COLIMA_HOME` is unset, relative, or under `$HOME` | set an absolute `COLIMA_HOME` outside `$HOME` |
| `COLIMA_MOUNT_IDENTITY_FAILED` | the configured volume's UUID does not match | verify the mount; do not bypass the gate |
| `COLIMA_SHADOW_MOUNT` | a shadow mount of the same volume name exists | unmount the shadow; AegisFlow will not guess which is real |
| `TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT` | the agent runtime changed under the pinned identity | re-pin the runtime identity deliberately |
| `TOOL_SELECTION_CONTRACT_MISSING` | the runtime could not be located | set `AEGISFLOW_PI_RUNTIME_PATH` |
| `MUTATION_SCOPE_VIOLATION` | a write landed outside the admitted scope | inspect the delta; the scope is the admission's, not the model's |
| `HARNESS_TEST_EVIDENCE_MISSING` | a writer phase had no harness-run verification command | check `verificationCommand` is configured for the phase |
| `HARNESS_EVIDENCE_IDENTITY_MISMATCH` | evidence belongs to a different execution identity | do not reconcile by hand; investigate which run produced it |
| `RESUME_FINGERPRINT_MISMATCH` | checkpoint and journal disagree | the durable record is inconsistent — treat as an incident, do not force resume |
| `JOURNAL_CHAIN_INVALID` | the append-only chain failed validation | do not repair the chain by hand; preserve the artifacts |
| `CROSS_SESSION_ROLLOVER_IN_PROGRESS_*` | a handover was interrupted | let the handover complete or fail; a stale generation must not act |
| `EXTERNAL_REVIEW_NOT_COMPLETE` | the review job lacks its required artifacts | check the job's required role list |
| `EVOLUTION_SCOPE_OUTSIDE_POLICY` | a policy does not declare that dimension | re-issue the policy if the intent is genuine |
| `EVOLUTION_RISK_CLASS_REFUSED` | the risk class is not allowed | do not widen; MEDIUM needs operator promotion, HIGH is denied |
| `GC_ARBITRARY_ROOT_DELETE` | a GC namespace outside the admitted shapes | do not widen the namespace to make a plan succeed |

## Crash and resume

1. **Do not restart from scratch while durable state exists.** AegisFlow's
   resume re-derives from the journal and checkpoints; a fresh run creates a
   second, conflicting execution.
2. **Check what the durable state says first:**

   ```bash
   node scripts/aegisflow-operator.mjs --run <graphRunId> --json
   ```

3. **Resume through the runner**, not by editing files:
   `resumeDurableGraph` / `resumeSubagentGraph` (or the corresponding
   `--resume` surface of your entrypoint).
4. **If resume refuses with a fingerprint mismatch — stop.** That is the
   system telling you the durable record is inconsistent. Preserve the
   evidence directory and investigate. Forcing past it destroys the property
   that makes the evidence worth anything.

See [durable-execution.md](durable-execution.md) for the model.

## Sandbox operations

```bash
# Is a profile in use?
# (The lock makes an overlap fail fast rather than corrupt state.)
node scripts/aegisflow-operator.mjs --run <graphRunId> --json
```

Rules that keep the sandbox predictable:

- **serialise sandbox work.** Never run two sandbox operations concurrently.
- **never `docker` by hand against an AegisFlow profile.** Use the adapter, so
  the mount allowlist and the socket pinning apply.
- **never create `~/.colima` as a fallback.** The gate refuses a `$HOME` Colima
  home on purpose: an unpremeditated VM state is how a sandbox ends up
  absorbing the wrong data.
- **never mount the runtime socket into a task container.** The adapter refuses
  it; do not work around it.

## Telemetry operations

```bash
# Read a run's telemetry through the report (bounded, safe)
node scripts/aegisflow-operator.mjs --run <graphRunId> --json
```

- A missing telemetry namespace surfaces as `NO_TELEMETRY_ROOT` — an explicit
  diagnostic, not an error and not a fabricated failure.
- Retention gaps (GC'd chunks) are reported as gaps. `UP`-to-date absence is
  never reported as "no events happened".
- Exceeding read bounds yields `PARTIAL` with the bounds named.
- **Never delete from the evidence namespace to reclaim space.** Use the GC
  planner, which knows the retention classes; deleting an R3/R4 artifact
  destroys authority evidence.

## Evolution operations

```bash
node scripts/evolution-operator.mjs --json                # inspect
node scripts/evolution-kill-switch.mjs --store <dir> --suspend          # stop the loop
node scripts/evolution-kill-switch.mjs --store <dir> --resume           # resume it
```

- **Suspend reactively when the loop misbehaves.** It stops new cycles only;
  normal operation continues, so suspending is a cheap, reversible action.
- **A circuit-breaker trip is information.** Read the failure pattern before
  resuming.
- **Issuing a policy is an operator act.** No component can issue its own.
- **Rollback is the backstop for a bad promotion.** The prior generation is
  archived durably, so a rollback target exists.

Emergency stop:

```bash
node scripts/evolution-kill-switch.mjs --store <dir> --suspend
```

## Budget operations

Budget is reserved before execution, so an unexpected "out of budget" HOLD
means the envelope was already committed — check for an orphaned in-flight run
before raising limits. Raising a limit to unblock a run that has an in-flight
allocation is how two runs end up spending one budget.

## Backup and retention

- **Back up the evidence root.** It is the authority record: no replication,
  no server-side recovery. `AEGISFLOW_EVIDENCE_ROOT` (default
  `$AEGISFLOW_HOME/evidence/autoloop`).
- **Telemetry is reproducible in principle, evidence is not.** If you must
  choose what to protect, protect evidence.
- **The learning store is derived.** Losing it costs accumulated experience,
  not correctness.
- **Treat the journal as append-only.** Never hand-edit; validation will fail
  and the failure will be correct.

## Routine checklist

| Interval | Check |
|---|---|
| each run | the operator report is `PASS` or a HOLD you understand |
| daily | no unexpected `AEGISFLOW_*` state outside your `AEGISFLOW_HOME` |
| daily | `git status` in the repo is clean of generated artifacts |
| weekly | evolution is in the state you expect (`--status`) |
| weekly | evidence root backup completed |
| on upgrade | re-pin the agent runtime identity deliberately |
| on failure | preserve the evidence directory before any remediation |

## When to stop and ask

Stop and preserve state, rather than remediate, when:

- a durable fingerprint or journal-chain validation fails;
- an evidence artifact's digest does not match its record;
- telemetry and evidence disagree about a terminal outcome;
- a scope violation is attributed to a path you did not expect;
- a reviewer verdict and the harness facts contradict each other.

Each of those means the *record* is in question. The correct move is to keep
the evidence intact and investigate, not to make the gate pass.
