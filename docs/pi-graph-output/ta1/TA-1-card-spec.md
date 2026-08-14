CARD: AUTOLOOP-TA1
CARD_TITLE: Task Admission + Risk Tier + Capability Usage Policy Research & Design (TA-1)
CARD_TYPE: research
RISK: MEDIUM
MODE: CONTROLLED_RESEARCH_AND_DESIGN

SOURCE REVIEW

`FM-3` external review verdict — PASS / FM3_FINAL_REVIEW_SURFACE_CHAIN_COMPLETE
(reviewer: GPT-5.6 Sol, reviewedAt 2026-08-09,
bound to bundle d82c70109150e94e41fa28176ab99212bef904b602e882efde6743859f2dd23c,
REVIEW_BUNDLE_SHA256 d30369239ce89484595c7f4958209f2af4a28baef9a317d29126342273298256,
findings digest 6575605590dd0f3051e44b1186563d0f66258e4728b42e0b2864337e8ac92c84)

FM-3 formally closed 2026-08-09 (see
~/Desktop/AutoLoop-Review/archive/20260809-AUTOLOOP-REVIEW-BUNDLE-INVENTORY-REPAIR-1-d82c7010-PASS-verdict.txt).

OBJECTIVE

Establish AutoLoop's unified Task Admission Policy — ONE decision system that,
before a task enters Graph execution, decides in a single machine-readable
admission result:

  1. task size / complexity
  2. risk tier
  3. lifecycle weight
  4. required / allowed / denied capabilities & tools
  5. review / repair / evidence strength
  6. execution / isolation / durability requirements
  7. human/controller gates
  8. "one card, one review surface" governance

Task Admission and Capability Usage Policy MUST be the same decision system —
never a separate size classifier plus a separate tool policy plus runtime
guessing. This card produces research, inventory, design and a verifiable
contract ONLY. No admission runtime is implemented here.

BASELINE

* `HEAD=2e897e995202c0c8c079c5fdc96b9f5d42d50d25`（unchanged; no commit / push /
  merge / seal — non-goal of this card）
* worktree expected dirty（all prior card outputs untracked, by design）
* new files limited to the TA-1 authorized scope below

CURRENT ASSESSMENT（accepted from prior cards）

* Graph scheduler (runColimaGraph / runSubagentGraph → runExecutionOrchestrator,
  deterministic DAG, sealed runner + single-writer lease); durable graph layer
  (runDurableGraph / resumeSubagentGraph) since DE-2/DE-2R.
* Sub-agent contract (readonly-analyst / writer / repairer / reviewer /
  verifier / join) with per-role TOOL_PERMISSIONS + mutationScope already
  carried in the envelope — enforcement surface for capability policy exists.
* Independent review agent (isolated Colima container, read-only mounts,
  structured review result); bounded repair (effective_repair_cap).
* Colima isolation (pinned instance/socket, mount allowlist, network none,
  cap-drop ALL, no-new-privileges, limits); worktree isolation (dedicated git
  worktree per task, verify/capture/revoke).
* Durable execution + checkpoint/resume (c2d CURRENT.json CAS, journal hash
  chain, resume from durable truth, interrupted-writer fail-closed).
* Codebase Memory read-only retrieval (deterministic) + governed write-back
  gate (trust ladder, idempotent, conflict-surfacing); telemetry
  (allowlisted, identity-bound, budgets simulated only); review bundle +
  external review delivery + closeout state; risk normalization
  (LOW/MEDIUM/HIGH/CRITICAL single canonical authority); lifecycle governance
  (authorization / review-unit / checkpoint / integration / push / draft-PR).
* Pi Agent execution pinned: provider=deepseek, model=deepseek-v4-flash,
  reasoningEffort=high, no fallback/retry (pi-transport-adapter.mjs).
  NOTE for TA-2: card-input.schema.json executor allowlist currently mentions
  deepseek/deepseek-v4-flash AND deepseek/deepseek-v4-pro — TA-1 records the
  single-model constraint (R9) but does NOT modify the schema.
* GAP (this card): no size classification, no unified admission decision, no
  capability usage contract, no one-card-one-review-surface admission rule.

IN SCOPE (TA-1 AUTHORIZED SCOPE)

* docs/pi-graph-output/ta1/ — all research & design deliverables
* scripts/ta1-*.mjs — verification + closeout scripts (local-only, no runtime
  wiring into production scheduler / sub-agents / memory / telemetry)
* test/governance/ — NONE (no production test modified; regression proof only)

OUT OF SCOPE

* implement Task Admission runtime / modify production Graph scheduler behavior
* modify existing capability routing / sub-agent adapters / memory write-back
  wiring / telemetry budgets / model policy
* modify Current/ semantics, FM-3 sealed evidence, or any historical bundle
* commit / push / merge / release / seal
* entering TA-2（implementation）before this card closes

REVIEW REQUIREMENTS

* internal verification（scripts/ta1-verify.mjs — machine-verifiable contract）
* independent review（single authoritative review bundle, graph R1→W1→V1）
* Controller external review of ONE authoritative bundle（one-card-one-review-surface）
* no splitting into multiple manual review cards

EXIT CRITERIA

1. size model and risk model are separated axes
2. admission and capability policy unified in one decision
3. every major capability has Why / When / Who / Where / How / When-not
4. small-task fast path explicit
5. high-risk escalation explicit
6. one-card-one-review-surface contract explicit
7. machine-readable schema implementable
8. integration boundary confirmed
9. negative cases complete（R11 1-12）
10. no new mechanism added just for report completeness
11. next implementation card (TA-2) scope directly derivable from this card's results
