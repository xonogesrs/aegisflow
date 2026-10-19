# Autonomous evolution

AegisFlow can improve its own **operating strategy** — never its authority. This
document describes the loop, what each stage guarantees, and the boundaries that
make it safe to leave switched on.

## The loop

```
evidence → trigger → candidate → fitness → review → promotion → canary → accept | rollback
```

### 1. Evidence (always on)

Every eligible run writes a **secret-free attribution record** through
`src/evolution/attribution-feed.mjs`, independent of whether any trigger fires.
The record carries bounded identifiers, digests, enums and numbers only:

run identity, phase and stage identity, parent/graph relation, provider/model,
adapter, task class, decomposition identity, terminal outcome, HOLD code,
generation — plus repair, retry, latency, occupancy, fan-out counts.

No prompt text. No model response text. No credential. This is enforced by
construction (the projection copies only those fields), not by filtering.

### 2. Trigger

`src/evolution/trigger.mjs` recognises exactly seven closed signal classes:

| Signal class | Minimum evidence |
|---|---|
| `REPEATED_EQUIVALENT_FAILURE` | 3 |
| `REPEATED_REPAIR_REQUIREMENT` | 3 |
| `RECURRING_HOLD_PATTERN` | 3 |
| `ABNORMAL_RETRY_FREQUENCY` | 5 |
| `LATENCY_REGRESSION` | 3 |
| `TOKEN_INEFFICIENCY` | 3 |
| `QUALIFIED_PATTERN_EVIDENCE` | 1 (a qualified pattern already consolidates ≥2 incidents) |

A policy may only **raise** these floors, never lower them. The consequence:
**a single failure can never fire a trigger.** On top of the floor:

- an **observation window** — stale evidence never accumulates into a trigger;
- **dedup** — the same signature is suppressed;
- **cooldown** — a per-signal quiet period;
- **per-window frequency cap**;
- a **circuit breaker** in durable trigger state, which opens on repeated
  candidate failure and halts the loop without operator action.

Every trigger event pins its evidence references (journal event ids), the
observation instant, and its source.

### 3. Candidate

A candidate proposes a change to a **declared strategy dimension**. The
dimensions are:

`MODEL_ROUTING`, `DECOMPOSITION`, `CONTEXT_ALLOCATION`, `RETRY_REPAIR`,
`FANOUT_PARALLELISM`, `TOOL_SELECTION`, `PROMPT_EVOLUTION`.

A dimension is in scope only if the operator's issued policy lists it. `ABSENT`
means refused — so agent-strategy adaptation **cannot be enabled by
implication**, and an operator must re-issue a policy deliberately.

Candidate change is delivered as a patch against an isolated worktree. The
production checkout is never mutated during evaluation.

### 4. Fitness

The candidate must beat the baseline under the declared validation plan, in
isolation. Validation runs the declared commands with an explicit plan identity;
a missing or mismatched plan is a HOLD, not a default.

### 5. Review

An independently identified reviewer with **no mutation authority**. The
reviewer receives a handoff; it cannot issue authorizations. Independence is
checked: an identity that is the agent itself, or that self-identifies as the
evolution component, is refused — self-approval is structurally impossible, not
merely discouraged.

### 6. Promotion — all gates, simultaneously

| Gate | Failure code |
|---|---|
| policy pre-authorization, re-read and re-verified | `EVOLUTION_SCOPE_OUTSIDE_POLICY` |
| risk class allowed by the policy | `EVOLUTION_RISK_CLASS_REFUSED` |
| fitness PASS | fitness HOLD |
| regression PASS | regression HOLD |
| independent review PASS | review HOLD |
| candidate digest re-derivation | digest mismatch HOLD |
| live HEAD equals the frozen baseline | baseline drift HOLD |
| semantic drift gate | drift HOLD |

Any single mismatch aborts the promotion with a specific code. There is no
"mostly promoted" state.

### 7. Canary and rollback

A promoted change runs against real work under observation. Rollback restores
the prior generation, and the prior generation is archived durably
(`<store>/evolution-policy-history/`) so a rollback target always exists.

## Risk classes

| Class | Autonomy | Scope |
|---|---|---|
| **LOW** | fully autonomous within an issued policy | the six strategy dimensions, and only those the policy declares |
| **MEDIUM** | operator promotion required | `PROMPT_EVOLUTION` |
| **HIGH** | **structurally denied, never autonomous in any policy** | see below |

The HIGH-risk classes — which no policy can authorise, because the validator
requires them in `forbidden_risk_classes`:

```
SECURITY_OR_CREDENTIALS        GOVERNANCE_AUTHORITY
ADMISSION_AUTHORITY            PROMOTION_AUTHORITY
SECRET_HANDLING                DESTRUCTIVE_PERSISTENCE_MIGRATION
IRREVERSIBLE_DATA_OPERATION    EVOLUTION_POLICY_SELF
```

Plus forbidden **path patterns** that must always be present in a policy:
`src/governance/**`, `src/admission/**`, `src/evolution/**`, `.git/**`, and the
governance record root. A policy that omits them fails validation
(`forbidden_risk_classes_incomplete`).

`EVOLUTION_POLICY_SELF` deserves a sentence: the subsystem cannot mint or amend
its own policy. Policy issuance is an operator act.

## Operator controls

```bash
# Declare this deployment's evolution inputs once
node scripts/evolution-declare-production.mjs --out <path> \
  --store-root <dir> --checkpoint-root <dir> --repo-root <dir> \
  [--task-class <token>] [--strategy-baseline DIM=value ...]

# Issue a policy (operator act)
node scripts/evolution-issue-policy.mjs --store <dir>
node scripts/evolution-issue-policy.mjs --store <dir> --successor [--previous-digest <64hex>]

# Inspect (read-only, zero writes)
node scripts/evolution-operator.mjs [--store <dir>] [--json]

# Kill switch
node scripts/evolution-kill-switch.mjs --store <dir> --status
node scripts/evolution-kill-switch.mjs --store <dir> --suspend
node scripts/evolution-kill-switch.mjs --store <dir> --resume
```

The declaration is read through `AEGISFLOW_EVOLUTION_DEPLOYMENT_CONFIG`. Without
a resolvable declaration, evolution refuses to run.

### What the kill switch does and does not do

`AUTO_EVOLUTION = ENABLED | SUSPENDED`.

- **SUSPENDED blocks new evolution cycles only.**
- Normal operation, telemetry, and in-flight execution are **untouched**.

This is deliberate. A kill switch that stopped the control plane would be a
denial-of-service lever; the thing being halted is the loop that proposes
changes, not the machinery that runs work.

## What the operator view shows

- the issued policy, its generation, and its history;
- circuit-breaker state;
- triggers, candidates, reviews, canary state, rollbacks;
- the active strategy policy;
- the strategy performance memory;
- the every-run attribution feed and any feed failures;
- the resolved production declaration.

## Proposal-only mode

A second, **default-OFF** execution ceiling: the loop analyses evidence and
saves a reviewable proposal, then stops. It is a governed setting — it cannot
be raised by a plan, a trigger event, or the agent.

```
node scripts/evolution-declare-production.mjs --out <path> ... --proposal-only
# or per run/process:
AEGISFLOW_EVOLUTION_PROPOSAL_ONLY=1
# or runnerOpts.evolution.proposalOnly = true
```

With it on, one qualifying cycle runs:

```
evidence (qualified) → trigger → plan → candidate → DERIVED → durable write
                                                        ↓
                                              PROPOSAL_RECORDED  (STOP)
```

and **never** enters authorization, mutation, fitness, review, promotion,
canary, commit, push, or strategy activation. The returned
`loop_verdict` is `PROPOSAL_RECORDED`; the cycle result carries the proposal's
`candidate_id`, `candidate_digest`, durable path, evidence references and
measurement plan so it can be reviewed from the operator surface. Nothing is
applied, so there is nothing to roll back — the disable path is the setting
itself plus the existing kill switch.

Fail-closed rules:

| Condition | Result |
|---|---|
| `proposalOnly` is not a boolean (caller object, env, or declaration) | `HOLD / EVOLUTION_LOOP_PROPOSAL_ONLY_INVALID`; the consumer reports `CONFIGURATION_INVALID` and starts no cycle |
| the deployment declaration does not validate, or cannot be read | `CONFIGURATION_INVALID` — the declaration's ceiling is unknowable, so it is never assumed OFF. A declared `proposalOnly:true` beside an unrelated bad key is still honoured as a ceiling and still blocks the deployment |
| evidence is synthetic, test-only, or not a durable journal row | `HOLD / EVOLUTION_LOOP_EVIDENCE_UNQUALIFIED` before trigger evaluation, before any durable trigger write, and before any cooldown is consumed — on **both** loop entry modes |
| the proposal cannot be durably written or read back | `HOLD / EVOLUTION_LOOP_CANDIDATE_NOT_PERSISTED` — a proposal is never claimed without its artifact |
| the proposal artifact is durable but its derivation index is not | `HOLD / EVOLUTION_LOOP_CANDIDATE_NOT_INDEXED` with `artifact_durable: true` — the artifact exists and a retry repairs the index; this is never reported as "not persisted" |
| `AUTO_EVOLUTION = SUSPENDED` | unchanged: the cycle never starts |

With it off, the loop behaves exactly as documented above.

### Configuration precedence

Highest surface first, and at every surface an explicit boolean **stops** the
search — a narrower `false` is never overridden by a broader `true`:

1. `runnerOpts.evolution.proposalOnly`
2. `AEGISFLOW_EVOLUTION_PROPOSAL_ONLY` (`1`/`true`/`0`/`false`)
3. `proposalOnly` in the deployment declaration

The declaration's ceiling is read from the **raw** record, so an unrelated
validation failure elsewhere in the same file cannot discard it.

## Proposal durability

A strategy proposal is written to the **existing** candidate store
(`<store>/evolution-candidates/`, `autoloop.evolution-candidate/v1`) with the
same exclusive-create, identity-dedup and derivation-index semantics the source
family uses — no second store and no new format. The write happens **before**
authorization, so a proposal survives a cycle that is later refused or
rejected, and it is visible to `scripts/evolution-operator.mjs` and to crash
reconciliation.

Identity is deterministic: the same trigger at the same baseline re-derives the
same `candidate_id`, a retry is an `EXISTING` no-op, and an artifact whose
immutable content differs is a conflict that fails closed. `created_at` is not
part of that identity — a replayed event keeps the first write's record.

### Candidate families are separate index namespaces

The derivation index (`<store>/evolution-derivation-index.json`) keys one entry
per **candidate family**, not one per signature:

| Family | Key |
|---|---|
| `SOURCE` | `<signature>@<baseline-head>` (the historical key — unchanged) |
| `AGENT_STRATEGY` | `AGENT_STRATEGY:<signature>@<baseline-head>` |

The two families share the store directory, the schema and the dedup semantics,
but never a key. A strategy proposal can therefore not become the
"already derived" answer for a later source derivation of the same
signature@baseline (or the reverse) — both orders derive both candidates. A
legacy unqualified entry left by an earlier build is reclaimed by the family
that owns that key; the other family's artifact stays on disk under its own
identity.

### Persistence failures are classified

The artifact write, its read-back and the index write are separate facts:

| Fact | Code |
|---|---|
| the artifact did not land | `EVOLUTION_CANDIDATE_PERSIST_FAILED` → `HOLD / EVOLUTION_LOOP_CANDIDATE_NOT_PERSISTED` |
| the artifact landed, the index did not | `EVOLUTION_CANDIDATE_INDEX_WRITE_FAILED` → `HOLD / EVOLUTION_LOOP_CANDIDATE_NOT_INDEXED`, `artifact_durable: true` |
| two different candidates claim one identity | `EVOLUTION_CANDIDATE_CONFLICT` → `HOLD / EVOLUTION_LOOP_CANDIDATE_CONFLICT`, `artifact_durable: true`, `conflict: { kind, owner_id, key }` — the index is healthy and refused to repoint an owner; first writer wins and nothing was unwritable |

An identity conflict is **not** an I/O failure. Reporting it as
`INDEX_WRITE_FAILED` sent the operator to inspect storage instead of the
competing proposal, so the store classifies it by code before it reads
`artifact_durable`.

A retry after an index failure re-writes nothing (the artifact is authoritative)
and indexes the existing derivation, so recovery needs no cleanup.

## Evidence qualification

Synthetic evidence is refused at the **trigger entry**, not only by the
attribution feed:

- a deployment that declares itself synthetic;
- a durable record declaring `payload.synthetic` / `payload.test_only`, or
  carrying a `SYNTHETIC_EVIDENCE` row;
- a row that is not a verifiable journal row (no durable event id / sequence).

Detection is declared, never guessed: a record that declares nothing is
production evidence. The refusal is reported on the envelope
(`evolutionObservation.evidence_qualified: false`, `evidence_exclusion`) and by
the consumer as `NO_QUALIFIED_TRIGGER` with its reason — no trigger is recorded
and no cycle starts.

**One rule, both entry modes.** The observer, the every-run feed and
`runEvolutionCycle` call the same predicate
(`assessEvidenceProvenance`, `attribution-feed.mjs`). The check runs before
trigger evaluation, before any durable trigger write and before any cooldown or
window slot is consumed, so unqualified evidence can neither fire nor suppress
the next real signal for its signature. A self-deriving caller therefore
refuses exactly what production refuses; a caller that supplies an
already-recorded trigger is re-checked as well. Refusals carry the provenance
reason (`synthetic_evidence:…`, `untrusted_evidence_row`, `no_evidence_rows`),
never a bare `NO_TRIGGER`.

### The consumer re-establishes provenance itself

`observation.evidence_qualified` is a field on an object the caller hands in, so
a non-production caller could forge it. The consumer therefore re-reads the
durable journal (same reader) and re-applies the same predicate **before** the
trigger gate, and additionally requires every fired signal to cite at least one
journal-shaped reference (`evt_<n>_<hex>`) that the journal actually holds.

`QUALIFIED_PATTERN_EVIDENCE` is the one class whose evidence is not a journal
row, and the consumer has no durable view of pattern qualification on this path.
Rather than exempt it (which accepted a forged signal with an empty pattern list
and empty refs), the class is **refused here** — fail closed on the class that
cannot be re-established until pattern qualification becomes durably readable
from the consumer. No production path supplies `qualifiedPatterns` today, so
this narrows an unreachable path rather than changing live behaviour.

A refusal at this point is total — `NO_QUALIFIED_TRIGGER` with
`evidence_reverified: true`, zero trigger records, zero cooldown consumed, zero
cycles. A caller that supplies no journal identity cannot be verified and is
refused, never trusted by default.

### `synthetic` typing

`synthetic` is a boolean or absent, on all three surfaces (runner object, env,
declaration). Anything else — a string, a number, `null`, an object — is a
governed-configuration failure (`CONFIGURATION_INVALID`, no cycle), never
coerced to `false`. The env accepts the strings `1`/`true`/`0`/`false` and the
legacy `AUTOLOOP_EVOLUTION_SYNTHETIC` alias is the same surface. A **non-string**
env value (`1`, `0`, `null`, `{}`, `[]`) is rejected rather than read as unset:
the shared config reader ignores non-strings, and treating that silence as
production evidence is exactly the fail-open this closes. Precedence is
unchanged — a usable brand value wins and the legacy name is not consulted.

## Honest limitations

- **LOW-risk only.** The dimension set is genuinely narrow.
- **Needs volume.** Minimum-evidence floors mean a small deployment will rarely
  fire a trigger. That is the intent: the alternative is acting on noise.
- **Fitness is a proxy.** A candidate that wins on the declared plan may still
  lose in a dimension the plan does not measure.
- **Canary is not a guarantee.** It is observation, and rollback is the
  backstop.
- **EXPERIMENTAL.** Interfaces may change; the safety structure is what is
  stable.

## Cross-agent learning

Strategy transfer across agents is a separate concern — see
[cross-agent-learning.md](cross-agent-learning.md).
