# Minimal example

```bash
node examples/minimal/run.mjs      # or: npm run example:minimal
```

Runs the whole AutoLoop pipeline once, against a throwaway git repo, with a
scripted adapter instead of a real agent. Nothing to install beyond Node.

## What it walks through

| Step | Module | What you see |
|---|---|---|
| 1. Classify | `src/admission/classify.mjs` | size, risk and profile derived from evidence scores, with no model call |
| 2. Admit | `src/admission/admission-record.mjs` | the frozen admission record: capabilities, mutation scope, isolation and durability policy, plus its content-addressed `admission_id` |
| 3. Project | `src/v2/phase-task-card.mjs` | the per-phase contract actually handed to the executor: allowed paths, tool policy |
| 4+5. Execute + review | `src/lifecycle-runner.mjs` | two separate role adapters, harness-owned evidence, then the reviewer gate |
| 6. Verdict | — | `PASS` |
| 7. Negative | `src/c2d/mutation-scope.mjs` | the same pipeline with a scope violation: the gate refuses, and a `PASS` from the reviewer cannot rescue it |

## What is real here and what is scripted

**Real:** classification, admission construction and validation, envelope
projection, harness-owned evidence assembly (including running the
verification command), the mutation-scope gate, and the reviewer verdict
normalisation and its fail-closed guards.

**Scripted:** the executor's *output* (a fixture), and the reviewer's verdict
(a fixed `PASS`). They are deterministic on purpose — the example demonstrates
the harness's behaviour, not a model's.

Note in step 7 that the reviewer says `PASS` the whole time and the run still
cannot pass. That is the design: a model opinion cannot overrule a fact the
harness observed for itself.

## Why the executor's output must satisfy a schema

The scripted executor emits a full `autoloop.implementation-evidence/v1`
document — read from `test/fixtures/implementation-evidence-valid.json`. That
is not decoration: the harness validates the schema, binds the phase execution
identity, and refuses a malformed or identity-mismatched payload. The example
reuses the fixture rather than inlining a shorter object precisely so you can
see the real shape the contract expects.

## Doing it against a real agent

See [../../docs/getting-started.md](../../docs/getting-started.md) step 4b.
You will need a `pi` installation and a provider credential; the flow is the
same, but the adapters become real.
