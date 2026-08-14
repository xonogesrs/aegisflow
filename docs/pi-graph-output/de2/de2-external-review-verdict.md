# DE-2 External Review Verdict — HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED

## Review Identity

- CARD_ID: `AUTOLOOP-PI-GRAPH-DE2`
- CARD_TITLE: Native Durable Execution Hardening (DE-2)
- CARD_TYPE: implementation
- GRAPH_RUN_ID: `de2-self-closeout-20260808`
- REVIEW_BUNDLE_IDENTITY: `90d8676f1666bb186f9ea4a7aa25b5b3336072cd00f82b7fd0755843f9678690`
- REVIEW_BUNDLE_SHA256: `1309e24d5cdc5cb07575da405bf80df734db4a5c4161554d177aeb43193a0dcf`
- BUNDLE_PATH: `docs/pi-graph-output/de2/card-closeout-bundle-20260808-90d8676f.txt`
- REVIEWER_IDENTITY: Controller / External Reviewer
- REVIEWED_AT: `2026-08-08T22:47:00Z`
- VERDICT: **HOLD**
- HOLD_CODE: **DE2_EXTERNAL_EXTENSION_REQUIRED**
- FINDING_CODE: **DE2_PRODUCTION_SUB_AGENT_RESUME_INCOMPLETE + DE2_REPAIR_SCOPE_EXCEEDED**
- FINDINGS_DIGEST: sha256 of this document

## Verdict

`HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED`

This revision fixes both blockers from the previous round and the following
are accepted:

* production entry proven to be `runSubagentGraph → runDurableGraph →
  runColimaGraph`, durability on by default; `durable:false` restricted to
  test-only with a no-bypass regression guard
* final independent review bound to `implementationDigest = 981822a8…`;
  review identity updated to `c5bfe138…`
* performance evidence quantified: disabled 643 ms / enabled 2335 ms /
  resume reconstruction 46 ms / D7 ~0 ms; canonical `colima-all` 42/42

But the bundle cannot be formally closed as
`PASS / AUTOLOOP_NATIVE_DURABLE_PRODUCTION_GRAPH_CONFIRMED`, because two
blocking findings remain:

1. **Production resume is not fully wired.** The bundle itself admits
   "sub-agent graph RESUME (new-process) requires the resumer to re-inject the
   sub-agent hooks/adapters … sub-agent resume wiring is the documented next
   step before Autonomous Research". The production entry is now confirmed to
   be `runSubagentGraph`; what must be proven is not only the underlying
   `runDurableGraph → runColimaGraph` recovery, but the full chain:

       fresh process
         → production runSubagentGraph recovery entry
         → automatic restoration of the correct adapters/hooks/resultsDir/
           review agent
         → continue the same graph
         → correct closeout

   The crash matrix proves Colima-graph-shape recovery; the bundle says the
   production sub-agent resume wiring is still a next step. Therefore the
   accurate status is: production **initial execution durable-by-default —
   established**; production **new-process resume fully wired — not yet
   complete**. This cannot wait for Autonomous Research, which would be the
   first thing to hit it.

2. **Repair exceeded the authorized scope recorded in the card.** DE-2
   Section 6 authorizes only `src/v2/durable-graph.mjs`, `checkpoint-bridge`,
   `durable-execution`, `colima-graph-runner`, telemetry, and DE-2
   scripts/tests/docs. The final implementation inventory additionally lists
   modifications to `src/subagent/subagent-graph-runner.mjs`,
   `src/v2/review-evidence.mjs`, 6 additional v2 tests, and 3 subagent tests.
   The first two are production source. The changes look technically justified
   — production wiring necessarily touches `subagent-graph-runner` — but
   governance cannot simultaneously claim the authorized scope excludes them
   and list them as DE-2 implementation files. A formal scope resolution is
   required.

## Why HOLD, not REPAIR

DE-2 has:

* `REPAIR_BUDGET_MAX: 1`
* `REPAIR_BUDGET_USED: 1`

The card rule is explicit: when the external review finds another blocker, it
must not silently exceed the repair budget — the disposition is
**`HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED`**. A narrow **DE-2R** card should be
opened instead of modifying this DE-2 bundle.

## 1. Blocking Finding — Production Sub-agent Resume Incomplete

### The required proof

The production entry is `runSubagentGraph`. The proof that must be delivered:

```
fresh process
→ production runSubagentGraph recovery entry（resumeSubagentGraph）
→ load durable execution
→ recreate/reinject production sub-agent adapters + hooks + resultsDir +
  review agent
→ resume the SAME graph identity
→ preserve review/repair/CBM/telemetry semantics
→ final closeout
```

Crash at least once at:

* after an RO node
* after the writer/result boundary
* before review
* after review

and confirm that after resume there is **no duplicate execution / no lost
result / no hook loss**.

### What was proven vs not

| Layer | Status |
|---|---|
| Colima-graph-shape durable recovery（crash matrix C0–C15） | Proven by DE-2 |
| Production sub-agent fresh-process resume（adapters/hooks/resultsDir/review agent re-injected） | **Not yet wired**（bundle's documented next step） |

## 2. Blocking Finding — Repair Scope Exceeded Authorized Scope

DE-2 Section 6 authorized:

* `docs/pi-graph-output/de2/`
* `src/v2/durable-graph.mjs`
* `src/v2/checkpoint-bridge.mjs`
* `src/v2/durable-execution.mjs`
* `src/runtime/colima-graph-runner.mjs`
* `src/telemetry/contract.mjs`
* `src/telemetry/graph-observer.mjs`
* `scripts/de2-*.mjs`
* `test/v2/test-durable-graph.mjs`

The final implementation inventory additionally contains:

* `src/subagent/subagent-graph-runner.mjs`（production source）
* `src/v2/review-evidence.mjs`（production source）
* 6 additional v2 tests
* 3 subagent tests

These appear technically justified — especially since production wiring must
touch `subagent-graph-runner` — but they were not in the recorded authorized
scope. The governance record cannot both say the authorized scope excludes
them and list them as DE-2 implementation files. **DE-2R must formally resolve
this scope**（make it an explicitly authorized extension scope, not a
retrospective assumption）.

## 3. Accepted Results（not overturned）

- production durable wiring: `runSubagentGraph`（the production Graph entry
  every card closeout script invokes）runs under native durable execution by
  default; `durable:false` is test-only with a no-bypass regression guard
- F1（post-head semantic classification）and F2/F3（resumed-orchestrator
  runner-view seeding）closed
- writer crash boundaries fail closed（only ALREADY_APPLIED recovers without
  re-mutation）
- repair budget survives restart（C10）
- CBM write-back idempotency untouched
- D7 telemetry replay-awareness added
- crash matrix C0–C15（real SIGKILL）safety hard gates all 0
- quantified performance（disabled 643 ms / enabled 2335 ms / resume
  reconstruction 46 ms / D7 ~0 ms）
- canonical `colima-all` 42/42; `test:v2` 368/368
- final-source independent review binding（implementationDigest `981822a8…`,
  review identity `c5bfe138…`）

## 4. Governance Disposition

- `REPAIR_BUDGET_MAX: 1`
- `REPAIR_BUDGET_USED: 1`（consumed）

Because the budget is exhausted, the honest disposition is:

**HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED**

Downstream（Autonomous Research Escalation）must stop until DE-2R closes.

## 5. Required DE-2R Work（narrow, no DE-2 modification）

**A. Production Sub-agent Resume Closure** — formally implement and verify the
fresh-process production resume chain（above）, with crash points after RO
node / writer-result boundary / before review / after review, and no duplicate
execution / lost result / hook loss.

**B. Scope Resolution** — formally record why the DE-2 repair necessarily
included `src/subagent/subagent-graph-runner.mjs`,
`src/v2/review-evidence.mjs`, and the corresponding tests, converting them
into an explicitly authorized extension scope.

Everything else stands as-is — F1, F2/F3, writer fail-closed, D7, CBM
idempotency, performance, canonical Colima are retained without rework.

## 6. Next Actions

- `NEXT_ACTION`: open **DE-2R — Production Sub-agent Resume Closure + DE-2
  Repair Scope Resolution**（see DE-2R-card-spec.md）.
- `DOWNSTREAM_BLOCKED`: Autonomous Research Escalation（and any claim of
  `PASS / AUTOLOOP_NATIVE_DURABLE_PRODUCTION_GRAPH_CONFIRMED`）until DE-2R
  closes.
- After DE-2R: re-apply the formal
  `PASS / AUTOLOOP_NATIVE_DURABLE_PRODUCTION_GRAPH_CONFIRMED` verdict, then
  Autonomous Research Escalation.

### END OF VERDICT
