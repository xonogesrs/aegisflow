# Troubleshooting

Known failure modes, in the form: **symptom → likely cause → inspection → safe
action**.

The general rule throughout: AutoLoop fails closed on purpose. A refusal is
information about a fence, not a bug to route around. Preserve evidence before
changing anything.

---

## Installation and startup

### `npm test` reports failures in suites you never touched

**Likely cause** — you are running the suite inside a checkout where generated
state (`docs/pi-graph-output/`, a local evidence root) has accumulated, or the
sandbox suites are running concurrently.

**Inspection**

```bash
node test/run-suite.mjs --list          # exact file list + what is excluded
git status --short                      # anything unexpected?
```

**Safe action** — run the host suite exactly as documented (`npm test`). Suites
needing Colima or a real `pi` are excluded there and must be run explicitly; if
you ran them concurrently you will have hit
`HOLD / COLIMA_PROFILE_BUSY`, which is the single-flight lock working.

### `Cannot find module` on an imported `node:` builtin

**Likely cause** — Node is older than 24. AutoLoop uses `node:sqlite` and the
modern `node:test` runner.

**Inspection** — `node --version`

**Safe action** — upgrade to Node ≥ 24 (tested on 26).

### Everything imports fine but every run HOLDs immediately

**Likely cause** — no admission could be established, or the entrypoint is a
non-production dead-end.

**Inspection** — look at the `reason`. `NON_PRODUCTION_ENTRYPOINT` means you
called a fail-closed library entrypoint (`runAutoLoop`) rather than the admitted
path (`runAdmittedGraph` / the admitted wrappers). This is intentional: the
production entrypoints are unconditionally refused for non-production callers.

**Safe action** — use an admitted entrypoint or an operator CLI.

---

## Agent runtime

### `TOOL_SELECTION_CONTRACT_MISSING`

**Likely cause** — the `pi` executable could not be located, or
`AUTOLOOP_PI_RUNTIME_PATH` points at a non-existent/relative path.

**Inspection**

```bash
command -v pi
echo "$AUTOLOOP_PI_RUNTIME_PATH"
```

**Safe action** — install the runtime, or set `AUTOLOOP_PI_RUNTIME_PATH` to an
absolute path. There is no fallback identity by design.

### `TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT`

**Likely cause** — the runtime changed under the pinned identity (you upgraded
`pi`, or a different `pi` resolves now). This is the pin working.

**Inspection** — compare the live runtime's digest with the recorded one:

```bash
node -e 'const c=require("node:crypto"),f=require("node:fs");
console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$(command -v pi)"
```

**Safe action** — re-pin deliberately
([agent-integration.md](agent-integration.md#the-pinned-runtime-identity)).
**Do not** delete the pin to make the gate pass: the pin is what makes the run's
tool vocabulary evidence meaningful.

### `MALFORMED_ADAPTER_RESULT` / `MALFORMED_REVIEWER_VERDICT`

**Likely cause** — the adapter returned something outside the contract: invalid
JSON, a missing field, a `PASS` without `confidence: HIGH`, or an unexpected
enum value.

**Inspection** — the HOLD detail names the failures. For reviewer verdicts the
required fields are `verdict`, `confidence`, `model`, `summary`,
`recommended_next_action`.

**Safe action** — fix the adapter/provider output. A soft-pass is not an
option; `PASS` with blocking issues or evidence gaps is rejected by the
normalizer.

---

## Scope and evidence

### `MUTATION_SCOPE_VIOLATION`

**Likely cause** — a write landed outside the admission's `mutation_scope`. The
scope comes from the admission, never from the model's intent.

**Inspection**

```bash
node scripts/autoloop-operator.mjs --run <graphRunId> --json
```

The detail carries the changed paths and the classification
(`outside_allowlist`, `forbidden_path`, `path_escape_or_symlink_or_git`).

**Safe action** — decide whether the *admission* was wrong or the *change* was
wrong. If the admission was too narrow, that is an operator decision made before
the run — not something to patch afterwards. Never widen a scope to retro-fit a
change that already happened.

A related HOLD appears *before* execution: `ADMISSION_MUTATION_SCOPE_VIOLATION`
raised by the envelope projection means the admission's `mutation_scope` or a
declared phase artifact boundary is not a canonical repository-relative path —
absolute, containing `.`/`..`, a glob, a non-normalized spelling, a symlink
component, or outside the admission scope. The projection canonicalizes with
the same rules as the scope gate, so this is refused at declaration time rather
than after a write; restate the boundary as a canonical repo-relative path
(`src/` and `src` are the same entry).

The recorded scope checks name which layer refused. `post_mutation` /
`post_validation` are the git-delta gate (`outside_allowlist`,
`forbidden_path`, `path_escape_or_symlink_or_git`).
`pre_mutation_write_containment` and `post_mutation_write_containment` are the
git-independent filesystem audit (`src/c2d/write-containment.mjs`): the
worktree contains a symlink — resolvable or dangling — that resolves outside
the worktree root, or a declared writable boundary whose literal path is a
symlink. A pre-execution refusal means the mutation command never ran
(`symlink_escape`, `symlink_scope_component`, `containment_scan_failed`).
Remove the symlink (or re-declare the boundary) — the containment layer only
ever narrows authority.

### `HARNESS_TEST_EVIDENCE_MISSING`

**Likely cause** — a writer phase has no `verificationCommand`, so the harness
has no system-observed test process to record.

**Inspection** — check the phase card. Verification is required for writer
phases: an executor claiming success is not evidence.

**Safe action** — configure a verification command for the phase. Do not
hand-write a test result into the evidence.

### `HARNESS_EVIDENCE_IDENTITY_MISMATCH`

**Likely cause** — evidence carries an execution/phase identity that is not this
run's. Usually a stale artifact from an earlier run being reused.

**Inspection** — compare the identity in the artifact with the run's.

**Safe action** — do not reconcile by hand. Find out which run produced the
artifact; reusing evidence across runs is exactly what this gate exists to
prevent.

### Evidence writes fail with a secret-scan HOLD

**Likely cause** — the artifact contains something matching a credential
pattern, or it exceeds the size bound.

**Inspection** — the HOLD names the pattern class, never the value.

**Safe action** — remove the offending content at the source. A scanner hit is
a HOLD, not a warning, and it will not be downgraded.

---

## Durable state

### `RESUME_FINGERPRINT_MISMATCH`

**Likely cause** — the checkpoint and the journal disagree, or an artifact's
content no longer matches its recorded digest.

**Inspection** — preserve the evidence directory first, then look at the
recorded digest and the current bytes.

**Safe action** — treat this as an incident. **Do not force a resume.** The
whole value of the durable record is that a mismatch is detectable; bypassing it
makes every prior review unfounded.

### `JOURNAL_CHAIN_INVALID`

**Likely cause** — a journal row was edited, reordered, or truncated (by a tool
outside AutoLoop, or by truncating an append that was in flight).

**Inspection** — the validator reports which row.

**Safe action** — do not hand-repair the chain. Preserve and investigate; the
recovery path depends on how the state was damaged.

### A resume "hangs" with `CROSS_SESSION_ROLLOVER_IN_PROGRESS_*`

**Likely cause** — a session handover was interrupted. The successor generation
is not yet authoritative.

**Inspection** — the operator report shows the rollover transition and the
generation.

**Safe action** — let the handover complete or fail. Do not start a fresh run
against the same execution, and do not let a stale generation continue: that is
the exact failure the generation fence prevents.

---

## Storage roots

### A state root under `/tmp` is refused

**Symptom** — `TRANSFER_PATH_UNSAFE: symlink component rejected: /tmp` (or any
error naming a symlink component of a state root), when the configured root
lives under a path that contains a symlink.

**Likely cause** — AutoLoop rejects a **symlink component** anywhere in a
storage root. This is deliberate: a symlinked component can be repointed after
validation, so accepting one would make the containment check meaningless.

The common trigger is macOS itself: `/tmp` is a symlink to `private/tmp`, so a
state root configured as `/tmp/...` — or a `$HOME` that happens to live under a
symlinked path — trips the guard.

**Inspection**

```bash
readlink /tmp                 # → private/tmp on macOS
python3 -c 'import os; print(os.path.realpath("<your root>"))'
```

**Safe action** — configure the **resolved** path:

```bash
export AUTOLOOP_SCRATCH_ROOT=/private/tmp/autoloop-scratch
```

Do **not** work around it by disabling the check. If you need ephemeral scratch,
point `AUTOLOOP_SCRATCH_ROOT` at a real directory (or the OS temp directory's
resolved form); the guard only rejects the symlink, not the location.

---

## Sandbox (Colima)

### `HOLD / COLIMA_PROFILE_BUSY`

**Likely cause** — another AutoLoop operation holds the profile lock. This is
the single-flight lock doing its job, not a defect.

**Inspection** — figure out which operation is running. If you launched a
sandbox suite and another was already active, that is the whole explanation.

**Safe action** — wait for the owner to finish. **Never** delete the lock file
while its owner process is alive: the lock carries the owner's process identity,
and removing it lets two operations interleave stop/start on one profile.

### `COLIMA_HOME_NOT_CANONICAL`

**Likely cause** — `COLIMA_HOME` is unset, relative, or inside `$HOME`.

**Inspection**

```bash
echo "COLIMA_HOME=[${COLIMA_HOME:-unset}]"
```

**Safe action** — set an absolute `COLIMA_HOME` outside `$HOME`. AutoLoop
refuses to fall back to `~/.colima` deliberately: an unplanned VM state is how a
sandbox ends up holding the wrong data.

### `COLIMA_MOUNT_IDENTITY_FAILED` / `COLIMA_SHADOW_MOUNT`

**Likely cause** — the configured volume is not mounted, its UUID does not
match, or a shadow mount of the same name exists (e.g. `MyVolume 1`).

**Inspection**

```bash
diskutil info -plist /Volumes/YourVolume | plutil -extract VolumeUUID raw -o - -
ls /Volumes
```

**Safe action** — remount cleanly, remove the shadow, retry. Do not disable the
gate to get past it: the gate exists because a wrong volume absorbing sandbox
state is unrecoverable.

### Containers start but the task fails immediately

**Likely cause** — the task needs network or a capability the sandbox refuses
(`network none`, `--cap-drop ALL`, `no-new-privileges`).

**Inspection** — the adapter result carries the container's stderr.

**Safe action** — redesign the task so it does not need them. Widening the
sandbox turns isolation into a claim rather than a property.

---

## Telemetry and operator views

### The operator report says `UNKNOWN` for a run that completed

**Likely cause** — telemetry was disabled, was GC'd, or the run's telemetry
namespace was never created.

**Inspection** — the report's diagnostics name the reason
(`NO_TELEMETRY_ROOT`, `READ_BOUNDS_EXCEEDED`, retention gaps).

**Safe action** — read the durable evidence instead
(`readCloseoutState()` / the evidence directory). Telemetry absence is not
failure, and the report will not fabricate state either way.

### The report says `PARTIAL`

**Likely cause** — read bounds were hit, or chunks are missing.

**Inspection** — `readBounds` in the JSON names the limit and whether it was
exceeded; retention gaps list missing chunks.

**Safe action** — raise the bounds for that inspection, or accept a partial
view. Never "fix" it by filling gaps with inferred events.

### Explicit "torn line" or "malformed event" diagnostics

**Likely cause** — a crash during an append, or a contract-invalid event was
recorded.

**Inspection** — the diagnostic identifies the chunk and row.

**Safe action** — treat as a durability incident for that chunk; the store
already refuses to serve it silently. Do not delete the chunk to make the
diagnostic go away.

---

## Evolution

### `EVOLUTION_SCOPE_OUTSIDE_POLICY` / `EVOLUTION_RISK_CLASS_REFUSED`

**Likely cause** — the candidate targets a dimension or risk class the issued
policy does not allow. This is by design; adaptation cannot be enabled by
implication.

**Inspection**

```bash
node scripts/evolution-operator.mjs --json
```

**Safe action** — if the intent is genuine, re-issue the policy with the
dimension declared. If the candidate is MEDIUM, it needs operator promotion; if
HIGH, it is structurally denied and no policy can authorise it.

### The loop stops proposing anything

**Likely cause** — the circuit breaker opened, or no signal clears its
minimum-evidence floor.

**Inspection** — the operator view shows the breaker state and the trigger
history.

**Safe action** — read the failure pattern before resuming. A quiet loop with
insufficient evidence is the intended behaviour in a small deployment, not a
malfunction.

### Evolution will not start at all

**Likely cause** — no resolvable production declaration.

**Inspection** — check `AUTOLOOP_EVOLUTION_DEPLOYMENT_CONFIG` resolves to a
readable declaration.

**Safe action** — author one with
`node scripts/evolution-declare-production.mjs`.

---

## Repository hygiene

### Generated files appear in `git status`

**Likely cause** — an evidence or telemetry root inside the checkout, or a test
suite writing to a cwd-relative path.

**Inspection**

```bash
git status --short
git check-ignore -v <path>
```

**Safe action** — for state, point the roots outside the checkout
(`AUTOLOOP_EVIDENCE_ROOT`, `AUTOLOOP_TELEMETRY_ROOT`). `.gitignore` covers the
common cases, including `/file:` and `/learning-incidents*`. If a **suite**
created them, that is a bug worth reporting: suites must write to the OS temp
directory.

### Stray directories named `file:` or `learning-incidents-*`

**Likely cause** — a test path was interpreted as literal rather than as a URL,
so something created a directory with a `file:` name.

**Inspection** — find the writing test.

**Safe action** — delete the directory (it is not tracked) and report the test.
`.gitignore` already prevents it being committed.

---

## Getting help

When reporting an issue, include:

- the HOLD code and its structured detail (not just the message);
- what you ran (entrypoint, card, config — **redact credentials**);
- the durable state description from the operator report;
- the output of `node test/run-suite.mjs --list` if the problem is in testing.

**Never paste a credential into an issue.** See
[../SECURITY.md](../SECURITY.md).
