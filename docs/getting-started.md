# Getting started

This walks a clean checkout to a real AutoLoop execution. If you only want to
see the machinery move without installing an agent runtime, do
[Step 4a](#step-4a-see-it-work-without-a-provider) first — it needs nothing
beyond Node.

## Step 1 — Clone and install

Requirements: **Node >= 24** (AutoLoop uses `node:sqlite` and the modern
`node:test` runner), npm, and git.

```bash
git clone https://github.com/xonogesrs/autoloop.git
cd autoloop
npm install
```

`npm install` pulls one runtime dependency (`@earendil-works/pi-ai`). The agent
runtime `pi` itself is **not** an npm dependency of this repository — you
install it separately in Step 3.

## Step 2 — Verify the checkout

```bash
npm run check     # syntax-check every source file
npm test          # host-only suite: no sandbox, no agent runtime, no credentials
```

`npm test` runs the host-only suite. Some suites need infrastructure you may
not have; they are listed and excluded rather than silently skipped:
```bash
node test/run-suite.mjs --list
```


```bash
node test/run-suite.mjs --list
```

You should see lines like:

```
# excluded (need external infrastructure):
#   test/test-c3-colima-pipeline.mjs — Colima + Docker (real container pipeline)
#   test/pi-rpc-real-smoke.mjs — real `pi` binary + live provider credential
```

If `npm test` passes, the governance core is healthy on your machine. Sandbox
suites come later.

## Step 3 — Configure

AutoLoop needs **no configuration** for local exploration: all state defaults
to one namespace.

| Variable | Default | Purpose |
|---|---|---|
| `AUTOLOOP_HOME` | `~/.autoloop` | root of all AutoLoop state |
| `AUTOLOOP_EVIDENCE_ROOT` | `$AUTOLOOP_HOME/evidence/autoloop` | durable evidence |
| `AUTOLOOP_TELEMETRY_ROOT` | `$AUTOLOOP_HOME/evidence/autoloop-telemetry` | telemetry stream |
| `AUTOLOOP_LEARNING_ROOT` | `$AUTOLOOP_HOME/learning` | cross-agent learning store |
| `COLIMA_HOME` | *(unset)* | Colima runtime home; required only for sandbox execution |

Two rules the resolver enforces, both fail-closed:

- A configured root must be **absolute**. A relative value is an error, never
  silently resolved against your shell's cwd.
- State may not be scattered outside the AutoLoop namespace. `$HOME` itself is
  rejected; a path inside `$HOME` must live under `AUTOLOOP_HOME`. A telemetry
  root inside the evidence namespace is rejected — keeping observability
  separate from authority is a structural fence, not a preference.

Full reference: [configuration.md](configuration.md).

## Step 4a — See it work without a provider

The minimal example runs the whole admitted-execution path with a scripted
adapter: no `pi`, no credentials, no container.

```bash
node examples/minimal/run.mjs
```

You will see the classifier's decision, the frozen admission record, the scope
that was enforced, the harness-collected evidence, and the reviewer verdict.
Because it is scripted, the model's output is deterministic — this demonstrates
the *harness*, not a model.

## Step 4b — Run against a real agent

To execute a real task you need an agent runtime and a provider credential.

```bash
# Agent runtime: Pi (bin name: `pi`)
npm install -g @earendil-works/pi-coding-agent

# Provider credential: provisioned in Pi's own auth store, NOT in this repo
pi auth check --provider <provider> --model <model>

# Tell AutoLoop where the runtime lives (needed only if `pi` is not on PATH)
export AUTOLOOP_PI_RUNTIME_PATH="$(command -v pi)"
```

AutoLoop pins the runtime it will use: the executable's resolved path and
content digest become part of the admission contract. If you later upgrade
`pi`, the pinned digest no longer matches and the gate **fails closed with a
drift HOLD** instead of silently running a different binary. That is
intentional. To accept a new runtime, re-pin it explicitly:

```bash
export AUTOLOOP_PI_RUNTIME_PATH=/path/to/pi            # new executable
export AUTOLOOP_PI_RUNTIME_SHA256=<sha256 of that file> # pin it explicitly
export AUTOLOOP_PI_RUNTIME_VERSION=<version>
```

Compute the digest with:

```bash
node -e 'const c=require("node:crypto"),f=require("node:fs");
console.log(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$(command -v pi)"
```

Details of the runtime contract: [agent-integration.md](agent-integration.md).

## Step 5 — Run a task

A task enters AutoLoop as a **task card**: a goal, an acceptance criterion, and
whatever scope hints the operator wants to give. The harness — not the model —
decides the rest.

```bash
# Execute a task card through the admitted graph (agent runtime required)
node scripts/c3-colima-task.mjs --card <path-to-card.json> --repo "$PWD"
```

`--help` on any script prints its arguments. The card shape and the admission
fields it maps onto are in [governance.md](governance.md).

## Step 6 — Inspect the result

Two read-only operator surfaces, both safe against unknown, partial, or
telemetry-disabled runs and both performing zero writes:

```bash
# What did a graph run actually do?
node scripts/autoloop-operator.mjs --run <graphRunId>
node scripts/autoloop-operator.mjs --run <graphRunId> --json

# What has the autonomous evolution loop done?
node scripts/evolution-operator.mjs --json
```

The operator report gives you: run status, per-phase outcomes, rollover
transitions, provider usage, and explicit diagnostics. When telemetry is
missing it says `UNKNOWN` — it never fabricates state.

## Step 7 — Where things live

```
$AUTOLOOP_HOME/
  evidence/autoloop/            durable evidence, checkpoints, journals
  evidence/autoloop-telemetry/  telemetry stream (separate namespace)
  learning/                     transfer-metrics log, incident records
  review/                       human-facing review surfaces
  colima-locks/                 sandbox profile single-flight locks
```

Each root is independently relocatable — see
[configuration.md](configuration.md).

## Step 8 — Sandbox execution (optional)

Container isolation needs Colima + Docker. AutoLoop refuses to run sandbox
work without an explicit runtime home rather than silently falling back to host
execution:

```bash
export COLIMA_HOME=/path/to/colima-runtime
COLIMA_HOME="$COLIMA_HOME" npm run test:colima
```

If your runtime home sits on a dedicated volume and you want the mount-identity
gate (so a mis-mounted or shadow volume can never absorb sandbox state):

```bash
export AUTOLOOP_COLIMA_MOUNT=/Volumes/YourVolume
export AUTOLOOP_COLIMA_MOUNT_UUID=$(diskutil info -plist /Volumes/YourVolume | plutil -extract VolumeUUID raw -o - -)
```

With both set, AutoLoop verifies the volume UUID and refuses to run when a
shadow mount of the same name exists.

## Where to go next

- How the pieces fit: [architecture.md](architecture.md)
- Every configuration knob: [configuration.md](configuration.md)
- Running and diagnosing it: [operations.md](operations.md)
- When something breaks: [troubleshooting.md](troubleshooting.md)
