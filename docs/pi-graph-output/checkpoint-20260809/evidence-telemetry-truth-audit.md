# Checkpoint 2026-08-09 — Evidence and Telemetry Truth Audit

## Classification rules

- `MEASURED`: value produced by a real instrumented operation and stored with provenance.
- `DERIVED`: calculated from authorized structured files, git metadata, or known set relations.
- `SYNTHETIC`: authored/fixture/hardcoded value that resembles a measurement.
- `UNKNOWN`: required fact absent.
- `NOT_INSTRUMENTED`: capability has no meter.
- `NOT_AUTHORIZED`: evidence may exist outside this checkpoint’s allowed roots and was not accessed.

## Truth map

| Evidence | Classification | Reason |
|---|---|---|
| Repo branch/HEAD and dirty-path counts | DERIVED | Git metadata from bounded repo root |
| Current delivery identity, attemptedAt, status | DERIVED from structured state; timestamp MEASURED only as write time | `Current/delivery.json` is authority for delivery state; it has no external verdict |
| Current `externalReviewStatus` | MEASURED state / current authority | `AWAITING_EXTERNAL_REVIEW`; `verdict: null` |
| Current graph node statuses | DERIVED from recorded graph result | Internal result, not external acceptance |
| Current graph node timestamps | SYNTHETIC lineage concern | Values `1786400000000`–`1786401900000` convert to 2026-08-10, after 2026-08-09 artifact date; existing VCA1 evidence identifies hardcoded closeout timing patterns |
| Current TA3 915/915 accounting | DERIVED historical report | It includes 70 known duplicate results; not current post-W1A proof |
| VCA1 845 distinct / 70 duplicate | DERIVED | Set-overlap analysis in `docs/pi-graph-output/vca1/vca1-r1-r2-evidence.json` |
| W1A 913 distinct / zero double count | CLAIMED acceptance output | Future-run claim; no post-W1A full rerun in this checkpoint |
| W1A real suite wallMs | MEASURED when sourced from `runSuiteSync` | Future verifier path uses real elapsed duration; historical files may predate change |
| Node `timingSource` field | Contract classification | `review-bundle.mjs:2632-2634` labels finite timestamps `MEASURED`; caller can still inject synthetic finite timestamps |
| Token/tool-call/memory cost | NOT_INSTRUMENTED | TA3 limitations explicitly defer these meters |
| `test:colima-all` total duration | NOT_INSTRUMENTED | R1/R2 only establish `>420000 ms`, killed mid-suite |
| Telemetry outside Current/Archive/repo | NOT_AUTHORIZED | No `$HOME` telemetry path was searched |
| External reviewer identity/verdict | UNKNOWN | Current delivery has null verdict and no external verdict artifact |

Additional high-confidence provenance defects:

- `scripts/ta3-verify.mjs` emits suite `wallMs`, but historical TA3 closeout reduces verification records to counts/status and drops timing. Current graph evidence has no `wallMs`; finite start/end can be caller-authored and then labeled `MEASURED` by `review-bundle.mjs:2632-2634`.
- `src/telemetry/source-map.mjs` and `graph-observer.mjs` accept caller-provided test counts and provenance; `aggregate.mjs` can convert missing values to zero. A caller claim is not harness receipt.
- V2 `system_observed` evidence is incoming `evidence.test_results`; outcome/exit coherence does not independently prove the harness ran.
- COST1 aggregates 40 runs with `graphRunId: null` and labels the aggregate `g-enabled-0`; identity is misbound. Its overhead result is a controlled proxy, not production overhead.
- TA3 budget evidence contains fixed sample wall values (`5000`, `8000`, `3000`, `5000`); classify as SYNTHETIC sample.

## Main truth defect

The schema can label any finite node timestamps `MEASURED`, while historical closeout generators authored fixed timestamp sequences. W1A source now uses null/`UNKNOWN` when no real start/end exists, but existing TA3 artifacts were not rewritten. Evidence consumers must trust artifact provenance and card generation, not only field labels.

## Telemetry authority

`recordGraphTelemetry` is caller-supplied through an observer. No default production caller was found. `wallMs` is therefore available on some paths, not globally authoritative. Missing data must remain `NOT_INSTRUMENTED`; zero would fabricate evidence.

## Test-count truth

Do not merge these counts:

| Count | Meaning |
|---:|---|
| 915 | Historical TA3 recorded executions |
| 845 | Derived distinct executions from that report |
| 70 | Historical duplicate subset |
| 913 | W1A future acceptance claim |

Current status remains “internal graph PASS, external review pending.” No external PASS is present.

## Disposition

- P1: reclassify/reseal historical timing, count, test-receipt, and graph identity evidence before relying on it for current acceptance.
- P2: add authoritative telemetry location and provenance contract.
- P2: change `timingFields()` fallback from synthetic `Date.now()` to `UNKNOWN`; preserve event capture time separately from execution time.
- UNKNOWN remains UNKNOWN; no unauthorized telemetry access.
- No P0 finding established.
