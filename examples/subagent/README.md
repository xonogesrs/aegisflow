# Subagent fan-out example

```bash
node examples/subagent/run.mjs     # or: npm run example:subagent
```

Shows the authority model for splitting one task across several agent nodes.
Runs on the host with no agent runtime and no container.

## What it walks through

| Step | What you see |
|---|---|
| 1. Parent admission | one frozen admission record with a scope of two paths — the only place authority is minted |
| 2. Fan-out | two writer children, each projected its **own** envelope from the parent |
| 3. Role separation | an out-of-scope child boundary refused *before* any work starts; a read-only role projected with `mutationScope = null` |
| 4. Join | fail-closed: one child `HOLD` blocks the parent |

## The property being demonstrated

A child node cannot widen its own authority. `projectEnvelopeFields` accepts a
child's declared boundary only if it is a **subset** of the parent admission
scope, and narrows to it:

```js
projectEnvelopeFields({
  admission: parent,
  nodeRole: "writer",
  mutationScopeFromPhase: ["README.md"],   // ⊆ parent scope, accepted
});
```

An out-of-scope declaration throws `ADMISSION_MUTATION_SCOPE_VIOLATION`. A
read-only role — `reviewer`, `verifier`, `join` — projects an empty
`mutationScope` and read-only tools, so "the reviewer fixed it up" is not a
reachable state.

The join is where split work succeeds or fails as a whole: every child must
pass, and a child `HOLD` is never averaged away.

## What this example does not do

It does **not** start containers or drive a real agent. Real fan-out:

- runs each node in its own container — network off, capabilities dropped,
  pids/memory/cpu limited, runtime socket never mounted in;
- gives each node its own durable checkpoint, so a crash mid-fan-out resumes
  from durable truth instead of restarting;
- binds each node's evidence to its own execution identity, so one node's
  result can never be presented as another's.

Those paths are exercised by the sandbox suites:

```bash
COLIMA_HOME=/path/to/colima npm run test:colima
```

See [../../docs/architecture.md](../../docs/architecture.md) for the authority
map and [../../docs/durable-execution.md](../../docs/durable-execution.md) for
the checkpoint/resume model.
