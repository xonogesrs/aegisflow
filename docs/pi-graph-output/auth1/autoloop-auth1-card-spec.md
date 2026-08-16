# AUTOLOOP-AUTH1 — Canonical Production Authority Seam (Card Spec)

Canonical contract for the AUTH1 review unit. This is the WHAT; implementation
is the HOW and is reviewed against this contract.

## R-09 — Production Entrypoint Authority

Production execution is reachable ONLY through `runAdmittedGraph`
(`src/admission/admission-gate.mjs`), which enforces admission + allocation +
budget authority.

The legacy STACK_A entrypoints are UNCONDITIONALLY fail-closed dead-ends:

- `runAutoLoop` → `HOLD NON_PRODUCTION_ENTRYPOINT` (always)
- `runDurableAutoLoop` → throw `NON_PRODUCTION_ENTRYPOINT` (always)
- `resumeAutoLoop` → throw `NON_PRODUCTION_ENTRYPOINT` (always)

Invariants:

1. No caller-provided boolean / string / context can unlock these surfaces.
2. The internal engine is reachable ONLY via the `*Internal` harness surface
   (`src/v2/stack-a-internal.mjs`).
3. No production runner may reach execution below `runAdmittedGraph`.

## R-10 — Retrieval Authority

The single retrieval-authority predicate is `isRetrievalAuthorized(admission)`:

```text
admission?.memory_policy?.retrieval_allowed === true
```

Invariants:

1. Retrieval is authorized IFF `memory_policy.retrieval_allowed === true`
   (strict boolean).
2. missing `memory_policy` / missing `retrieval_allowed` / `false` /
   truthy non-boolean values → DENY (fail closed).
3. Provider availability is NEVER authority.
4. No duplicate authority owner; no direct retrieval bypass.
5. Authority is evaluated BEFORE any retrieval call.
6. Production runner and retrieval consumer share the same authority semantics.

## Scope

The candidate is exactly the frozen AUTH1 mutation set (13 tracked + 2
untracked implementation/test files). No unrelated workstream (p1-auth1, rb2,
CBM) is in scope.
