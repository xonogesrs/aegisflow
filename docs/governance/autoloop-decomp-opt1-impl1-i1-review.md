# AUTOLOOP-DECOMP-OPT1-IMPL1 — I1 Decomposition Manifest Implementation Review

Review unit: Issue #7 I1 scope (`governance/decomp-opt1-impl1` @ `f28a0ae`, parent `fe07244` design-freeze, AUTH1 lineage).
Frozen design authority: Issue #6 design inventory `autoloop-decomp-opt1-design-inventory.md` Section 8/8b/8c (PASS / AUTOLOOP_DECOMP_OPT1_DESIGN_SPEC_REVIEWED_AND_IMPLEMENTATION_READY).

This document is the review material for the I1 implementation. The independent implementation review verdict is recorded at the bottom by the reviewer — the implementer does not self-certify.

## 1. Change surface (commit `f28a0ae`, 6 files, +825/−2)

| File | Change | Purpose |
|---|---|---|
| `src/v2/decomposition-manifest.mjs` (new) | builder + phase digest table | `autoloop.decomposition-manifest/v1`; 8 fail-closed presence gates; size bound; `manifest_id = sha256(canonicalJson(payload))`; pure CPU |
| `src/v2/checkpoint-bridge.mjs` | +`collectRepositoryTree` (one git read); `DECOMPOSITION_MANIFEST_WRITTEN` added to `POST_HEAD_EVENT_SEMANTICS.replaySafe` | F3A tree observation; crash-window event classification |
| `src/v2/durable-execution.mjs` | manifest build+write+journal+checkpoint after DAG_ACCEPTED; checkpoint pins `decomposition_manifest_sha256` via `snapshotOverrides`; resume three-way verification + artifact self-consistency + crash-window reconstruct | STACK_A durable path |
| `src/v2/durable-graph.mjs` | same wiring on the production graph path | production durable path |
| `test/v2/test-decomposition-manifest.mjs` (new) | T1–T8 | proof flags |
| `test/v2/test-durable-execution.mjs` | interruptedCheckpoint helper writes `decomposition-validation.json` | fixture parity with real durable artifacts |

Untouched (verified by git diff): `src/v2/runner.mjs`, `src/admission/*`, `src/budget/*`, `src/governance/*`, `src/c2d/*`, `src/runtime/*`, `src/memory/*` — 0 lines.

## 2. Frozen-contract traceability (Section 8/8b/8c)

| #6 frozen requirement | Implementation | Evidence |
|---|---|---|
| once per decomposition revision, after DAG_ACCEPTED | build emitted in `runDurableInner` / `runDurableGraph` after DAG_ACCEPTED event + checkpoint | code; T3 journal event count |
| deterministic / canonical payload | `canonicalJson` + IR declaration order | T2 |
| `manifest_id = sha256(canonical payload)` | builder | T1 |
| parent identity / revision, input fp, config fp, irSha, dagSha | payload fields | T1 |
| F3A repository identity snapshot (root/HEAD/tree) | run-level fingerprint (root/HEAD) + one `collectRepositoryTree` read | T1 (format); tree = deterministic field of commit |
| source/prompt hashes | `computeSourceHashes()` + `promptBuilderVersion` | T1 |
| phase table digests | `buildPhaseTableDigests` per phase | T1/T2 |
| evidence path (secret scan, size bound, durable semantics) | `store.writeArtifact` (secret-scan fail-closed) + builder size bound + journal + checkpoint | T3, T8 |
| identical bound inputs → identical digest | canonical payload | T2 |
| resume reads + verifies digest | three-way (recomputed == artifact == checkpoint) + artifact self-consistency | T4 |
| mismatch / malformed / stale → fail closed | `RESUME_FINGERPRINT_MISMATCH` on tampered/malformed/stale bindings; crash-window missing artifact → reconstruct (never silent skip) | T5/T6/T7 |

## 3. Proof flags (implementer-reported)

MANIFEST_SCHEMA_VALID=T1, CONTENT_ADDRESSING_VALID=T1, DETERMINISTIC_DIGEST=T2, EVIDENCE_PATH_BOUND=T3+T8, RESUME_BINDING_VERIFIED=T4, CORRUPTION_FAILS_CLOSED=T5/T6/T7, NO_CHILD_PACKET_IMPLEMENTATION=git status, NO_RUNNER_AUTHORITY_CHANGE=0-line diff, NO_CBM_INTEGRATION=grep.

## 4. Test evidence

- New suite `test/v2/test-decomposition-manifest.mjs`: 8/8 pass.
- Regression: `test-durable-execution` + `test-checkpoint-bridge` + `test-pre-decomposition-interruption`: 51/52 pass; `test-durable-graph`: 65/66 pass.

**Known pre-existing failures (NOT introduced by I1 — reproduced on unmodified baseline `/tmp/autoloop` @ fe07244 with identical src):**
- `test-durable-execution` "33: evidence write failure stops the run" — secret-sentinel does not trigger the scanner in this environment (node v26). Baseline fails identically.
- `test-durable-graph` "DE-2 production wiring: runSubagentGraph default durable … resume complete" — `RESUME_FINGERPRINT_MISMATCH: repository or scratch namespace changed`; baseline fails identically (colima/container-adjacent path).

## 5. Open points for the reviewer (explicit, not hidden)

1. **`promptBuilderVersion: "graph-input-ir"`** is a fixed sentinel on the production graph path (IR is caller-provided; there is no prompt pipeline). Confirm this is acceptable identity semantics vs. a real pipeline version, and that determinism is preserved (same sentinel across runs → same digest given same other inputs).
2. **Crash-window reconstruct**: if the manifest artifact is missing AND the checkpoint pins no id (crash between DAG_ACCEPTED and the manifest write), resume reconstructs the manifest from frozen inputs and persists it (journaled with `reconstructed: true`). This re-derives the artifact — confirm it does not violate the "produced exactly once" wording (normal path produces once; resume repairs an incomplete durable state, same class as the existing `tryReconstructIr` in durable-graph).
3. **Checkpoint additive field** is written via the sealed `snapshotOverrides` seam (existing mechanism) — confirm no second checkpoint authority was introduced.
4. **Coverage gap**: the durable-graph manifest wiring has NO passing integration test in this environment (the DE-2 suite's graph-execution test fails pre-existing for environment reasons). The manifest builder itself and the STACK_A durable path are fully tested; the graph-path emission/resume code paths are wired identically but only syntax/static-verified here. Reviewer should decide whether a container-capable environment must re-run `test-durable-graph` before I2.
5. **Event classification**: `DECOMPOSITION_MANIFEST_WRITTEN` is replay-safe (artifact written before the event; resume re-derives and verifies). Confirm the crash-window semantics (event present, checkpoint absent → resume re-verifies artifact; artifact absent, event absent → reconstruct) cover every ordering.
6. **`collectRepositoryTree` failure** yields `null` → manifest build fails closed (`MISSING_REPOSITORY_IDENTITY`) → run HOLDs. Confirm no legitimate path makes tree observation unavailable while the fingerprint itself succeeds (same git repo).

## 6. Non-goal compliance

I2 (child execution packet), I3 (identity dedup), I4 (verification layering), I5 (CAS serialization), I6 (recursive decomposition), CBM: NOT implemented. Sealed runner, admission, budget, governance, c2d stores: untouched. Note: durable-graph's existing per-run checkpoint serialization chain was observed (relevant to I5, not changed here).

## 7. Reviewer verdict

```text
VERDICT:
HOLD / AUTOLOOP_DECOMP_OPT1_IMPL1_I1_PARENT_BINDING_AND_CRASH_JOURNAL_GAPS
(resolved by I1-R1 below; re-review targeted, no full I1 re-review)
```

```text
FINDINGS:
1. parent identity/revision not truly bound in the manifest payload
   (only execution_id/chain_id; input_fingerprint ≠ parent revision)
2. crash ordering "artifact present / event absent / checkpoint absent"
   was not recovered (journal would never carry the emission record)
3. no passing integration proof for the production durable-graph path
Other open points (graph-input-ir sentinel, reconstruction semantics,
snapshotOverrides seam, tree fail-closed): ACCEPTED.
```

## 8. I1-R1 closure record (response to the HOLD)

| Fix | Change | Proof |
|---|---|---|
| A. parent revision binding | builder gains `parentRevision` (distinct field; STACK_A = sha256(canonicalJson(source)), graph = sha256(canonicalJson(parent))); payload `parent.revision`; gate `MISSING_PARENT_REVISION`; all four call sites (run+resume × both paths) | T1 (present, 64-hex, ≠ input_fingerprint), T2 (parent-revision change → digest change) |
| B. artifact-present/event-missing recovery | resume scans the journal for `DECOMPOSITION_MANIFEST_WRITTEN` after verification and appends it when absent (`recovered_journal_gap: true`, replay-safe; no duplicate event when present) — both durable paths | five crash orderings T-lock: (1) absent/absent/absent → reconstruct+event+pin; (2) present/absent/absent → verify+gap repaired; (3) present/present/absent → no duplicate; (4) present/present/pinned → three-way passes; (5) absent/pinned → HOLD |
| C. production graph-path integration proof | two targeted tests running the REAL production path (`runDurableGraph` / `resumeDurableGraph`, scripted adapters, `preserveInstance`, colima running): manifest artifact + event + checkpoint pin on run; three-way verification passes on resume | T14/T15 pass |

Also fixed while greening the suites (fixture-only, no production behavior change):
- `test-durable-graph` DE-2 wiring resume used a DIFFERENT scratchRoot than the run (namespace drift is correct fail-closed behavior; the fixture now reuses the same namespace) — suite 11/11.
- `test-durable-execution` test 33 sentinel never matched any `SECRET_PATTERNS` entry (github_token needs `gh[pousr]_` + 20+ chars) — sentinel now `ghp_0123…` — suite 23/23.

Final suite state: `test-decomposition-manifest` 15/15 (T1–T8 + 5 orderings + 2 graph proofs), `test-durable-execution` 23/23, `test-durable-graph` 11/11, checkpoint-bridge + pre-decomposition-interruption + autoloop-entrypoint 50/50. Zero failures.

## 9. Reviewer verdict (post-I1-R1)

```text
VERDICT:
<reviewer fills in: PASS / AUTOLOOP_DECOMP_OPT1_IMPL1_I1_DECOMPOSITION_MANIFEST_IMPLEMENTED_AND_VERIFIED
 or HOLD with findings>
```

```text
CONDITIONS FOR I2:
<reviewer fills in — gate to I2 (child execution packet)>
```
