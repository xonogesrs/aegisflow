CARD: AUTOLOOP-PI-GRAPH-DE2R
CARD_TITLE: Production Sub-agent Resume Closure + DE-2 Repair Scope Resolution (DE-2R)
CARD_TYPE: implementation
RISK: MEDIUM
MODE: CONTROLLED_EXTENSION_AFTER_EXTERNAL_HOLD

SOURCE REVIEW

`DE-2` external review verdict — HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED
(reviewer: External Reviewer, bound to bundle 90d8676f1666bb186f9ea4a7aa25b5b3336072cd00f82b7fd0755843f9678690,
REVIEW_BUNDLE_SHA256 1309e24d5cdc5cb07575da405bf80df734db4a5c4161554d177aeb43193a0dcf,
implementationDigest 981822a8fb99217ecfbb35aeb6938cb233e2aaa06655344fe41db52bb85a0605)

SOURCE VERDICT

`HOLD / DE2_EXTERNAL_EXTENSION_REQUIRED`

The reviewer's two blocking findings:

1. **Production resume is not fully wired.** DE-2 proved Colima-graph-shape
   recovery（runDurableGraph → runColimaGraph crash matrix C0-C15）but the
   PRODUCTION sub-agent resume entry was missing: a fresh process resuming a
   crashed sub-agent graph had to manually re-inject the sub-agent
   hooks/adapters（resultsDir wiring + review agent）. DE-2's own bundle listed
   "sub-agent resume wiring is the documented next step before Autonomous
   Research" — i.e. production initial execution is durable-by-default, but
   production new-process resume was NOT fully wired.

2. **Repair scope exceeded the authorized list.** Section 6 of the DE-2 bundle
   authorized only src/v2/durable-graph.mjs, checkpoint-bridge, durable-execution,
   colima-graph-runner, telemetry, DE-2 scripts/tests/docs — yet the final
   implementation inventory also modified src/subagent/subagent-graph-runner.mjs
   and src/v2/review-evidence.mjs（both production source）+ 6 extra v2 tests +
   3 subagent tests. Governance requires an explicit scope resolution, not a
   retrospective assumption that the original card always included them.

The reviewer's instruction: open a NARROW DE-2R card（do not touch DE-2, whose
REPAIR_BUDGET is exhausted at 1/1）that（A）formally implements + verifies the
production sub-agent resume closure and（B）formally resolves the repair scope.

OBJECTIVE

Close the last production-wiring layer of DE-2:

* **A. Production Sub-agent Resume Closure** — implement and verify, with real
  process death, the production resume chain:

      fresh process
        → resumeSubagentGraph（the production recovery entry, same module as
          runSubagentGraph）
        → resumeDurableGraph reconstructs the SAME graph identity from durable
          truth（IR, phase states, side-effect ids, repair budget, permitted
          dirty digest）
        → sub-agent hooks/adapters re-injected（resultsDir persistence hooks,
          executor/reviewer dispatchers, independent review agent）
        → continue the same graph → correct closeout

  Crash at least once at: after an RO node result, after the writer/result
  boundary, and around the review stage（before/after）; prove no duplicate
  execution, no lost result, no hook loss.

* **B. Scope Resolution** — formally record why the DE-2 repair necessarily
  touched src/subagent/subagent-graph-runner.mjs, src/v2/review-evidence.mjs,
  and the 6+3 extra test files, converting them into an explicitly authorized
  extension scope（this card）instead of retrospectively pretending the original
  card included them.

DE-2's accepted results are NOT redone: the durable engine（F1/F2-F3, writer
fail-closed, CBM idempotency, D7 telemetry, repair-budget persistence,
quantified performance, canonical colima 42/42）all carry over.

BASELINE

* `HEAD=2e897e995202c0c8c079c5fdc96b9f5d42d50d25`（unchanged from DE-2's bundle;
  no commit / push / merge / seal）
* worktree expected dirty（all prior card outputs untracked, by design）
* new files limited to the DE-2R authorized scope below

CURRENT ASSESSMENT（accepted from DE-2）

* runSubagentGraph（the production Graph entry every card closeout script
  invokes）runs under native durable execution by default（durable:false is a
  test-only escape hatch with a no-bypass regression guard）
* DurableGraphRun journals + checkpoints every safe boundary; resume
  reconstructs the ready set from durable truth（crash matrix C0-C15, real
  SIGKILL, fresh-process resume）
* writer crash boundaries fail closed（only ALREADY_APPLIED auto-recovers）
* repair budget survives restart; CBM write-back idempotent; D7 telemetry
  replay-aware; quantified performance（disabled 643 ms / enabled 2335 ms /
  resume reconstruction 46 ms / D7 ~0 ms）; canonical colima-all 42/42
* **GAP（this card）**: production sub-agent resume entry（fresh-process
  recovery through runSubagentGraph's module with adapters/hooks/resultsDir/
  review agent re-injected）did not exist

IN SCOPE（DE-2R AUTHORIZED SCOPE）

* src/subagent/subagent-graph-runner.mjs — the PRODUCTION entry module:
  add resumeSubagentGraph（fresh-process resume entry）; extract the shared
  sub-agent hook composition + adapter dispatchers so run and resume can never
  drift apart
* src/v2/durable-graph.mjs — surgical resume plumbing: scratchPreserve（keep
  the crashed run's resultsDir across the resume scratch wipe）; caller-IR
  adoption for hook/phase object identity; wipeScratchPreserving
* src/runtime/colima-graph-runner.mjs — AWAIT the composed onPhaseStart /
  onPhaseTerminal / lifecycle hooks: the durable layer's handlers are async
  and were racing the executor（the writer's mutationScope / dependency
  wiring could land after the adapter read the runtime — the root cause the
  probe exposed）; awaiting makes the durable-first guarantee deterministic
* src/v2/review-evidence.mjs — DE-2 repair's evidence-path correction（the
  attempt-prefixed evidence artifact reference alignment）is hereby formally
  absorbed into DE-2R's extension scope（already landed in the DE-2 repair;
  DE-2R records + keeps it）
* scripts/de2r-*.mjs — the probe + worker + closeout scripts
* test/v2/test-durable-subagent-resume.mjs（pure regression guards: wipe
  semantics, id mapping, fail-closed entry）+ test/test-durable-subagent-
  resume.mjs（colima integration, joins the serial colima-all suite）
* test/v2/test-durable-graph.mjs — minimal test-only fix: the no-bypass guard
  regex matched the literal prose `durable: false` inside de2-self-closeout.mjs
  design-decision text; the guard now scans actual runner-call bodies only
  （intent unchanged）
* docs/pi-graph-output/de2r/ — DE-2R evidence + closeout bundle

OUT OF SCOPE

* modifying DE-2's binding（implementationDigest 981822a8… stays bound to the
  reviewed snapshot; DE-2's REPAIR_BUDGET stays exhausted at 1/1）
* add Temporal / Restate / any external workflow engine
* redesign Graph topology / change scheduler policy
* model routing / cost optimization / self-evolution
* alter CBM trust ladder / enable automatic CONFIRMED memory
* Autonomous Research implementation
* commit / push / merge / seal

SCOPE RESOLUTION（TASK B — the formal governance record）

Why the DE-2 repair's final inventory included files outside DE-2 Section 6,
and why they are now explicitly authorized as DE-2R extension scope:

1. **src/subagent/subagent-graph-runner.mjs** — production wiring NECESSARILY
   touches the production entry. DE-2's objective was "wire durability behind
   the PRODUCTION Graph path"; the production Graph path IS runSubagentGraph.
   Routing it through runDurableGraph by default cannot be done without editing
   the entry module. The DE-2 repair made exactly that change（durable default +
   hook/DI forwarding）; DE-2R extends the same module with the resume entry.
   Scope: AUTHORIZED（production wiring is the card's own objective）.

2. **src/v2/review-evidence.mjs** — the DE-2 repair renamed the durable
   evidence artifacts to attempt-prefixed names（g0-executor-output-N.json /
   g0-implementation-evidence-N.json / g0-reviewer-system-delta-N.{json,patch}）
   to make repair/resume generations collision-free. review-evidence.mjs
   referenced the OLD name in durable_references.evidence_artifact_path; the
   one-line alignment keeps the evidence path contract truthful. This is an
   evidence-path correction REQUIRED by the durable-wiring change, not a scope
   expansion. Scope: AUTHORIZED（evidence-path correction within the durability
   change's blast radius）.

3. **The 6 extra v2 suites + 3 subagent suites** — the repair aligned 6 focused
   v2 suites that asserted the pre-rename artifact names, and the 3 sub-agent
   suites exercise the production entry now running durable-by-default
   （opting out via the documented test-only escape hatch）. Tests that assert
   the changed contract MUST be updated in the same change. Scope: AUTHORIZED
   （test alignment to the same-card contract change）.

4. **Governance posture** — DE-2R records this resolution as an explicit
   extension of DE-2's authorized scope. The alternative（claiming the original
   card always included these files）would misstate the record; the alternative
   of silently shipping un-authorized diffs would break the review chain. This
   card is the narrow, honest vehicle: DE-2 stays bound at its reviewed digest;
   DE-2R's own closeout binds ITS final source with a NEW implementationDigest
   that includes the extension scope.

REQUIRED VERIFICATION

* scripts/de2r-subagent-resume-probe.mjs（real SIGKILL + fresh-process resume
  through resumeSubagentGraph）:
  - A1 crash after RO node result        -> resume PASS, recovered phase not
                                            re-run（duplicateSuppressed>=1）,
                                            resultsDir intact
  - A2 crash after writer/result boundary-> resume PASS, writer NOT re-run
                                            （ALREADY_APPLIED recovery）
  - A3 crash before review               -> fail-closed RECOVERY_REQUIRED
  - A4 crash after review                -> fail-closed RECOVERY_REQUIRED
  - A5 terminal resume                   -> stage=complete, zero re-execution
  Gates: 0 duplicate execution / 0 lost result / 0 hook loss / 0 false PASS
* test:de2r + test:v2（no parallel colima conflict）+ canonical test:colima-all
  （serial）green

NOTES

* The colima environment quirk（virtiofs subdirectory bind persistence,
  per-instance mount sets）is a documented environment constraint; the probe
  uses the DE-2 session's proven pattern（$HOME-mounted instance + per-point
  fresh scratch that is never re-mounted after its final wipe）.
* The durable engine is unchanged; DE-2R adds the production resume entry +
  deterministic hook ordering only.
