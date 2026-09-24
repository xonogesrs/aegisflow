# Agent integration

AutoLoop is provider-neutral. It talks to two independent things:

| Layer | What it is | Today |
|---|---|---|
| **Agent runtime** | the process that executes a task and calls tools | Pi (`@earendil-works/pi-coding-agent`) |
| **Provider** | the model behind the agent | any provider the runtime is configured for, reached through `@earendil-works/pi-ai` |

AutoLoop does not bundle either one. You install the agent runtime; you
configure the provider in the runtime's own configuration.

## The pinned runtime identity

AutoLoop does not simply "run whatever `pi` is on PATH". The runtime it will
use is *pinned*: its resolved path and content digest are resolved before tool
selection runs, recorded in the admission contract, and re-checked on resume.

```js
// src/admission/policy-projection.mjs
frozenRuntimeIdentity()   // { realpath, sha256, version } — resolved lazily
```

Resolution order:

1. `AUTOLOOP_PI_RUNTIME_PATH` (must be absolute), with
   `AUTOLOOP_PI_RUNTIME_SHA256` / `AUTOLOOP_PI_RUNTIME_VERSION` to pin exactly;
2. otherwise, `pi` discovered through `PATH` / the platform default binary
   directories.

If the runtime cannot be located the call fails with
`TOOL_SELECTION_CONTRACT_MISSING` — there is no permissive fallback identity.

### Why pin a digest at all

Because "the agent that ran" is an authority-relevant fact. If you review a
run's evidence, the digest tells you the tool vocabulary could not have changed
underneath the decision. On resume, a mismatch between the recorded identity
and the live runtime is a fail-closed HOLD
(`TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT`) rather than a silent proceed.

Upgrading `pi` therefore requires an explicit re-pin:

```bash
export AUTOLOOP_PI_RUNTIME_PATH="$(command -v pi)"
export AUTOLOOP_PI_RUNTIME_SHA256=$(node -e '
  const c = require("node:crypto"), f = require("node:fs");
  process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"));
' "$AUTOLOOP_PI_RUNTIME_PATH")
export AUTOLOOP_PI_RUNTIME_VERSION="$(pi --version)"
```

## The tool vocabulary

Which tools the agent may select is derived from the admission record, not from
the runtime's own defaults. The runtime's *actual* builtin tool names are
captured from the real binary (`pi --help`) and parsed; names are never
invented. The captured set is compared against a frozen contract:

- a tool the runtime offers but the admission did not map is never
  auto-selected (`TOOL_SELECTION_UNKNOWN_CANONICAL_TOOL`,
  `TOOL_SELECTION_MAPPING_DRIFT`);
- a mapped tool missing from the runtime fails closed
  (`TOOL_SELECTION_REQUIRED_TOOL_UNAVAILABLE`);
- the vocabulary digest must match the frozen digest
  (`TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT`).

Two adapters exist today:

| `adapterKind` | Runtime | Notes |
|---|---|---|
| `pi-builtin` | Pi | the production adapter |
| *(scripted)* | none | `src/adapter/scripted-adapter.mjs` — deterministic, used by tests and the examples |

## Adapter contract

Any adapter must implement `runAdapter(request)` and return a result the
contract validator accepts (`src/adapter/contract.mjs`):

```js
{
  status: "completed" | "aborted" | "error",
  executionId,          // must echo the request's identity — never invented
  stdout, stderr,
  signal,
  error,
  metadata: { exitCode },
}
```

The request carries the projected authority, and an adapter must not act
outside it:

```js
{
  executionId, cwd, taskCard, phase, attempt, timeoutMs,
  environmentAllowlist,   // the ONLY env vars the child may see
  toolPolicy,             // projected from admission; reviewer gets no-tools
  abortSignal,
}
```

A malformed result is a HOLD (`MALFORMED_ADAPTER_RESULT`), not a retry that
hopes for better.

### Environment allowlist

The child process receives an explicit allowlist, not the ambient environment.
Credentials are **not** on it by default: the agent runtime authenticates from
its own credential store, so the harness never has to hand a secret to a child
process. If your runtime needs a specific variable, that is a deliberate
configuration change, not a default.

## Adding a runtime or provider

- **Another provider**: configure it in the agent runtime. AutoLoop's only
  provider-facing code is `src/v2/pi-transport-adapter.mjs`, which pins a
  provider/model/effort/token budget for the V2 structured transport and
  guards the request (host allowlist, single request, no retry). Adding a
  provider means adding a binding, not rewriting orchestration.
- **Another agent runtime**: implement the adapter contract above and register
  a new `adapterKind`. Tool-selection rows are adapter-kind scoped, so a new
  kind cannot perturb an existing projection — and it must ship its own
  projection constants, so there is still exactly one mapping authority.

Scheduled but not wired: OpenCode, Claude Code, Codex. The README's capability
table marks these `NOT_SUPPORTED` — treat any claim otherwise as stale.

## Revision drift

Provider and runtime versions move. Two defences:

- the runtime identity digest (above);
- the transport freeze (`TRANSPORT_FREEZE` in
  `src/v2/pi-transport-adapter.mjs`) pinning package version, provider, model,
  base URL, allowed host, reasoning effort, max tokens, timeout, retries and
  request count for the structured transport.

If you upgrade a provider's model and the pinned model id no longer exists, the
run fails closed and names the mismatch. That is the intended behaviour: a
silent model substitution would invalidate every prior review.

Third-party names and the trademark position:
[../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
