# DE-2R External Review Verdict — PASS / AUTOLOOP_PI_GRAPH_DE2R_EXTERNAL_REVIEW_CONFIRMED

## Review Identity

- CARD_ID: `AUTOLOOP-PI-GRAPH-DE2R`
- CARD_TITLE: Production Sub-agent Resume Closure + DE-2 Repair Scope Resolution (DE-2R)
- CARD_TYPE: implementation
- GRAPH_RUN_ID: `de2r-self-closeout-20260808`
- REVIEW_BUNDLE_IDENTITY: `98a2ba3b4b0e247dd540fa6b3a9a2a0dbb6baf772499f6e7fcf4f8905e427f83`
- REVIEW_BUNDLE_SHA256: `ccbcc07d3f1d37e75fdad6f6511be4122399fd4a5c2e949b7684805d5d419bd1`
- BUNDLE_PATH: `docs/pi-graph-output/de2r/card-closeout-bundle-20260808-98a2ba3b.txt`
- REVIEWER_IDENTITY: Controller / External Reviewer
- REVIEWED_AT: `2026-08-08T23:05:00Z`
- VERDICT: **PASS**
- VERDICT_CODE: **AUTOLOOP_PI_GRAPH_DE2R_EXTERNAL_REVIEW_CONFIRMED**
- FINDINGS_DIGEST: sha256 of this document

## Verdict

`PASS / AUTOLOOP_PI_GRAPH_DE2R_EXTERNAL_REVIEW_CONFIRMED`

The submitted DE-2R review bundle is the correct revision and matches the
delivery state:

* Bundle identity `98a2ba3b4b0e...5e427f83`, card `AUTOLOOP-PI-GRAPH-DE2R`,
  SHA-256 `ccbcc07d3f1d...d419bd1`, `SUPERSEDES` the DE-2 HOLD bundle
  `90d8676f...`, status `AWAITING_EXTERNAL_REVIEW`.
* Content is exactly the expected revision: `resumeSubagentGraph()` is now the
  production recovery entry — it rebuilds the shared `resultsDir`,
  re-injects the sub-agent hooks/adapters/review agent, and continues the SAME
  durable graph identity; the hook-await race was actually found and fixed.
* A1–A5 real-SIGKILL tests present; safety results:
  * duplicate execution = 0
  * lost result = 0
  * hook loss = 0
  * false PASS = 0
* A3/A4 `RECOVERY_REQUIRED` is treated as **expected fail-closed behavior, not
  a failure** — for ambiguous writer/review state, resumption must not guess
  the successor state in order to "auto-recover".
* Regression complete: `test:v2 372/372`, `colima-all 43/43`, focused durable
  11/11, DE-2R guards 4/4. Independent review bound to the new final
  implementation digest `8c7e1757...`.

## Non-Blocking Bookkeeping Note（recorded, does not affect the verdict）

Authorized Scope explicitly includes `package.json`（the `test:de2r` /
`colima-all` entries）, but Section 9 `CARD_IMPLEMENTATION_FILES` does not list
`package.json`. This does not affect the technical verdict — the test entry
points exist and the canonical suite ran — but the bundle generator should
eventually make "authorized + actually touched" file inventories
automatically consistent to avoid this small gap.

## Accepted Results（not overturned）

- `resumeSubagentGraph()` — the production fresh-process resume entry:
  same module as `runSubagentGraph`, same `durableExecutionIdFor` mapping,
  rebuilds `resultsDir`, re-injects the shared sub-agent hook composition +
  adapter dispatchers（`buildSubagentGraphHooks` /
  `buildSubagentAdapterFactories`）, continues the same graph identity from
  durable truth only, correct closeout.
- Root-cause fix: runColimaGraph now AWAITS the composed async durable hooks
  （onPhaseStart / onPhaseTerminal / lifecycle）— the writer wiring previously
  raced the executor and silently degraded; the A1/A2 crashes reproduced the
  degraded-writer failure before the fix and PASS after.
- Crash matrix A1–A5（real SIGKILL + fresh-process resume through
  resumeSubagentGraph）: after-RO-node / after-writer-result / before-review /
  after-review / terminal-resume — all pass with 0 duplicate execution, 0 lost
  result, 0 hook loss, 0 false PASS; interrupted writers fail closed
  （RECOVERY_REQUIRED）.
- Scope Resolution formalized（DE-2R-card-spec.md §Scope Resolution）: the
  DE-2 repair's touch of `src/subagent/subagent-graph-runner.mjs`,
  `src/v2/review-evidence.mjs`, and the 6+3 test files is recorded as an
  explicitly authorized extension scope; DE-2 stays bound at its reviewed
  digest `981822a8…`.
- Regression: `test:v2 372/372`, canonical `colima-all 43/43`（42 DE-2 +
  1 DE-2R）, focused durable 11/11, DE-2R guards 4/4.

## Governance Disposition

`PASS / AUTOLOOP_PI_GRAPH_DE2R_EXTERNAL_REVIEW_CONFIRMED` —
`externalReviewComplete=true`, bound to the current bundle.

DE-2R is sufficient to lift the DE-2 HOLD.

## Next Actions

- Apply the DE-2R PASS verdict + rotate the DE-2R surface.
- Lift the DE-2 HOLD（resolution record）→ DE-2 final formal
  `PASS / AUTOLOOP_NATIVE_DURABLE_PRODUCTION_GRAPH_CONFIRMED`.
- Durable execution / crash-recovery mainline closes →
  **Autonomous Research Escalation**.

### END OF VERDICT
