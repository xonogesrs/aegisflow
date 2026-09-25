# Security policy

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security
problem.**

Report privately through GitHub's **private vulnerability reporting** for this
repository:

1. go to <https://github.com/xonogesrs/aegisflow/security/advisories/new>, or
2. from the repository page: **Security** → **Report a vulnerability**.

That channel opens a private advisory visible only to you and the maintainers.

There is **no security email address** for this project, and this policy does
not invent one. If private vulnerability reporting is unavailable for any
reason, open a minimal public issue that says only "I need a private channel to
report a security issue" — with no technical detail — and a channel will be
arranged.

> **Maintainer note (verify at publication):** private vulnerability reporting
> is a per-repository setting. It must be **enabled** for the channel above to
> work. Enable it before the repository is made public:
> *Settings → Code security → Private vulnerability reporting → Enable*. Until
> it is enabled, the fallback paragraph applies.

### What to include

- a description of the issue and its impact;
- reproduction steps or a proof of concept;
- the affected version / commit;
- any configuration needed to reproduce;
- whether you have already disclosed it elsewhere.

**Be careful with the payload.** AegisFlow's evidence path scans for credential
shapes and refuses to write them, but your report is not going through that
path. Redact real secrets — describe the shape, do not paste the value.

### What to expect

AegisFlow is a **community, best-effort project with no SLA**. Reports will be
read and taken seriously, and there is no response-time commitment. Please do
not interpret delay as dismissal.

We will:

- confirm receipt in the private advisory;
- say whether we can reproduce it;
- fix in a normal commit (this project does not maintain a release branch);
- credit you in the advisory unless you prefer otherwise.

Please do **not** publicly disclose before a fix lands or a decision is made.

## What counts as a security issue here

AegisFlow is a governance harness, so the interesting failures are *authority*
failures — a component doing something it was not admitted to do.

**In scope**

- **Authority bypass.** Any way to execute, mutate, commit, or promote outside
  the frozen admission record — including widening a tool set, a mutation
  scope, a budget envelope, or an isolation policy.
- **Gate bypass.** A path where a PASS is produced without the required
  independent review, harness-owned evidence, or digest re-verification; or
  where a self-certified result is accepted as authority.
- **Sandbox escape or isolation failure.** A container reaching the host, the
  network, the runtime socket, or a path outside its allowlist; a mount that is
  not allowlisted; a way around the `network none` / capability-drop
  configuration.
- **Secret exposure.** A credential reaching a place it should not: an evidence
  artifact, a telemetry row, a log, a commit, a report — or a scanner bypass
  that lets a real credential be written.
- **Durable-state forgery.** Making the journal, a checkpoint, or an evidence
  artifact accept content whose digest does not match, or replaying/reordering
  without detection.
- **Evolution boundary violation.** A candidate that modifies a HIGH-risk
  surface, a forbidden path, or the evolution policy itself; a promotion
  without its full gate set; a way to disable the kill switch or circuit
  breaker without operator action.
- **Denial of service on the control path.** Making the harness unable to make
  progress, or making a HOLD non-deterministic.
- **Path handling.** Path traversal, symlink escape, or an argument that
  escapes the declared root; a configured root being followed somewhere it was
  not meant to go.

**Probably not in scope**

- **A model producing bad code.** That is what the review gate is for; if the
  gate *fails to catch* it, that is an authority issue and is in scope — the
  model's output alone is not.
- **Evidence of a compromise in your own deployment** (a leaked key of yours,
  a compromised host). Rotate your credentials first; report here only if
  AegisFlow contributed to the exposure.
- **Missing hardening without a demonstrated impact** — e.g. "this could be
  stricter". Useful as an issue, not as a vulnerability. Note that
  host-process isolation without Colima is documented as weaker than sandboxed
  execution; that is a known limitation, not a vulnerability.
- **Findings in upstream dependencies** without a demonstrated impact through
  AegisFlow. Report those upstream; tell us if AegisFlow's integration makes them
  exploitable.
- **Volume/bundle size, UI/UX, documentation errors.**

## Known, documented limitations

Please read these before reporting — they are deliberate, not oversights:

| Limitation | Why it is accepted |
|---|---|
| Without Colima, execution uses host-process isolation | Documented as **not a security boundary**. Sandboxed execution requires a sandbox runtime. |
| The reviewer's verdict is a **model judgement** | Independence is structural (separate role, no mutation authority, self-approval refused); correctness is not guaranteed. |
| Durability is local filesystem only | No replication. Disk loss is unrecoverable by design; back up your evidence root. |
| Single-operator, single-machine | Multi-tenancy is explicitly `NOT_SUPPORTED`. |
| The kill switch does not stop in-flight execution | Deliberate: a control-plane stop would be a denial-of-service lever. |
| `docs/` historical card records | Not in the public tree; internal operational records are archived outside it. |
| A transient symlink created **and removed inside one authorized command** is not observable | No post-hoc filesystem audit can see it, and this path has no syscall-level mediation. Requires a raw operator-supplied mutation command (see below). |
| Writes to a **git-ignored** path are invisible to the change gate | The gate classifies git's changed-path inventory, which excludes ignored paths by construction. Confined to the ephemeral isolated worktree; both downstream consumers fail closed. |
| Promotion's live-HEAD fence is cycle-time, not live (**M2**) | A mid-cycle HEAD advance is undetected and can yield a stale-base promotion onto the **dedicated** evolution branch only. |

## Mutation containment — what it guarantees

AegisFlow fences mutation with several independent layers: the admission gate and
its canonical `mutation_scope` projection, a git-delta scope gate over the
isolated worktree, and a **git-independent filesystem write-containment audit**
(`src/c2d/write-containment.mjs`) that runs immediately before and after an
authorized mutation. The layers can only narrow authority; none of them widens it.

What that buys, precisely:

- A mutation whose isolated worktree contains a symlink resolving outside the
  worktree root — **resolvable or dangling**, pre-existing or declared as a
  writable boundary — is refused. When the refusal comes from the pre-execution
  audit, the authorized command never runs and nothing is written outside.
- A dangling symlink is refused both as a declared artifact boundary and as a
  write target, and stays refused once its target appears.

What it does **not** buy — stated so that it is not mistaken for isolation:

- **AegisFlow is not a sandbox.** Without Colima there is no filesystem or
  syscall mediation. The containment audit is a *detection* control: it decides
  on the tree it can observe, and fails closed when the tree has already been
  changed in a way it can see.
- A command that creates a symlink, writes outside through it, and removes the
  symlink **within its own execution** leaves no observable artifact at either
  audit instant. The write succeeds. Reaching this requires an
  operator/controller-supplied raw mutation command
  (`mutationCommandOverride`); the default patch-based evolution path cannot
  produce it — `git apply` refuses any path behind a symlink, including one the
  same patch creates (measured), and the writer agents' write paths are fixed
  by a host-generated script, not chosen by the model.
- A write into a git-ignored path inside the worktree is not classified by the
  change gate. It cannot escape the worktree without a symlink (covered above),
  it does not touch the production checkout, and it cannot reach authority state
  (which lives outside the worktree) — but it is not enumerated as a change.
  An ignored-only mutation yields an **empty** changed-path set, which the
  writer-result validator (`no_changes_no_diff`) and candidate capture
  (`CAPTURE_PRECONDITION_FAILED`) both reject, so it cannot be accepted as work.

## Telemetry deletion containment

Telemetry GC deletes only inside an admitted namespace: the canonical telemetry
root, or a temp namespace it has resolved and checked. Everything else fails
closed (`GC_ARBITRARY_ROOT_DELETE`). The admission fence treats `$HOME` as
forbidden and resolves both the candidate **and** the home boundary to their
real paths before comparing, so an OS-level path alias cannot disable it — an
asymmetry there would silently authorize a sweep inside the user's home
directory.

## Reporting a containment problem

If you believe a containment layer can be bypassed, that is a vulnerability —
see the top of this document. Include the platform, the `$HOME` canonical form
(`realpath "$HOME"`), and whether a symlink is involved: an aliased home
directory is the usual reason a path boundary behaves differently on two
machines.

## Terminal fence authority (OMP integration)

The optional OMP extension in
[`integrations/omp/`](integrations/omp/README.md) commits a *terminal fence* —
the act that invalidates a run generation's pending background deliveries. That
act is authority-relevant, so it is not something an agent can perform:

- The governed agent has **no tool** that commits a fence. Its only tool is
  `request_terminal_fence`, which records a disposition and always reports
  `committed: false`. The hook additionally refuses the legacy tool name
  `fence_background_waiters` outright, fail closed.
- The commit is reachable only from the host prompt-command channel
  (`/fence-generation <STATUS> [reason]`), which a governed model cannot dispatch
  into its own session.
- The commit requires the environment marker `OMP_TERMINAL_FENCE_AUTHORITY`,
  which the **orchestrator that launched the governed process** sets. Without it
  the command is denied (`CONTROLLER_AUTHORITY_ABSENT`) and the generation stays
  active, so pending deliveries keep being delivered.

`OMP_TERMINAL_FENCE_AUTHORITY` is a launcher-supplied marker, **not** a
capability an agent can obtain. It is not derived from model output, not exposed
as a tool, and not grantable by prompt text or tool payload. Any claim that an
agent holds it — or any code path that lets a model reach the commit primitive —
is a security defect; report it as one. Do not place a credential, token or key
in that variable: it is a presence marker, and the extension tests only whether
it is non-empty.

## Handling credentials

- AegisFlow never requires a credential to be placed in this repository.
- Provider credentials belong in your shell environment or the agent runtime's
  own credential store.
- The child-process environment is an explicit **allowlist**; credentials are
  not on it by default.
- Evidence and telemetry are secret-scanned on write; a hit is a HOLD, not a
  warning.
- **If you believe a credential was exposed**: rotate it first. Revocation is
  the only reliable containment; then report so the exposure path can be fixed.

## Supported versions

There are no releases and no supported-version matrix. Development happens on
`main`, and fixes land there. If you need stability, pin a commit.

## Third-party components

AegisFlow redistributes no third-party source code. Each dependency is resolved
at install time from the public npm registry and carries its own license and
security posture. The dependency, integration and trademark inventory is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
