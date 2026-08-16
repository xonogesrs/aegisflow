# AUTOLOOP-REVART-LC1-B0 — Authority/Binding Reconciliation (Issue #8)

## 0. Verdict

**RESOLVED → READY_FOR_B1.** No HOLD / REPLAN.

Every field the closeout bootstrap requires has exactly one designated frozen
source. The three fields with no existing machine-authoritative source
(`card_title`, `card_type`, `out_dir`) are added to the SINGLE existing
authority record (lifecycle-authorization v2 → v3 additive) at Controller
issuance — no second identity owner, no runtime guessing, no runner-opts
supplement. This document freezes the source table, the
`admission.extensions.review_closeout` contract, the cross-field invariants,
and the resume identity. Design-only: no production code changed by B0.

Scope boundary (Issue #8): independent of #7 DECOMP-OPT1. The I1 Decomposition
Manifest is NOT a source — verified it carries no card title/type/outDir and
is not yet implemented as production authority.

## 1. Verified authority-source reconciliation

| Binding field | Designated frozen source | Evidence |
|---|---|---|
| `card_id` | `lifecycle-authorization.json` (`autoloop.lifecycle-authorization/v2`) at `<execDir>/governance/lifecycle-authorization.json` — the ONLY digest-bound, machine-validated per-card contract; admission binds it via `authority_binding.authority_record_digest` | `src/governance/review-artifact-gate.mjs` chain comment (`task → authority_record_digest → card_id`); `lifecycle-authorization.mjs` `lifecycleAuthorizationPath`/`writeLifecycleAuthorization` (exclusive-create)/`authorityDigest`; `src/schema/lifecycle-authorization.schema.json` required `card_id`; controller + orchestrator resolve card_id from this record |
| `repository`, `worktree`, `branch`, `base`, `base_head`, `authorized_paths`, `bundle_path`, `spec_path` | same record, `TOP_LEVEL_BINDINGS` (schema-required) | `lifecycle-authorization.mjs` `TOP_LEVEL_BINDINGS`; schema required list; `scripts/gov-review-bundle.mjs` ("repository / branch / base / scope / bundle_path come ONLY from the authority record"); `deriveLiveReviewBinding` (record.repository / base / spec_path) |
| `spec_digest` | NOT stored anywhere today. Derived from `spec_path` bytes via `spec-identity.mjs` (frozen normalization: UTF-8 strict, BOM strip, CRLF→LF, path excluded) at admission-projection time; frozen in the binding | `spec-identity.mjs` `specDigestOf`; `review-job-context.mjs` `deriveReviewJobContext` ("digest is derived from its bytes, never caller-supplied"); orchestrator spec binding |
| `spec_id` | Nominal spec locator; existing convention `specId = cardId` (`flags.specId \|\| cardId`). Frozen explicitly in the binding (default `= card_id`) so runtime never re-derives by convention | `scripts/gov-review-job-orchestrator.mjs` `const specId = flags.specId \|\| cardId` |
| `card_title` | **NO existing machine-authoritative source.** `authority-record/v1` carries only free-text `card_body` (not a structured title); nothing else in any schema carries it. All historical values are human-authored claims (self-closeout scripts, baseline scripts, persisted state) | `authority-record.schema.json` (`card_body`, no title); `lifecycle-authorization.schema.json`; `task-decomposition.schema.json`; `task-understanding-payload.schema.json`; grep across `src/` + `scripts/` (no producer) |
| `card_type` | **NO existing machine-authoritative source** for top-level cards. `review-bundle.mjs` `CARD_TYPES` (`implementation|research|repair|integration|closeout`) is the validation vocabulary only; task-decomposition `card_type` is a different uppercase enum for CHILD cards; I1 manifest (decomp-opt1 design inventory) carries none | `review-bundle.mjs:103` `CARD_TYPES`; `task-decomposition.schema.json:57-60`; decomp-opt1-design-inventory.md (no match) |
| `out_dir` | **NO existing machine-authoritative source.** Historical convention `docs/pi-graph-output/<cardId-slug>/` — the slug is NOT derivable from `card_id` (`AUTOLOOP-PI-GRAPH-REPORT-LIFECYCLE-REPAIR-1` → `report-lifecycle-repair-1`). Review-job root default `docs/pi-graph-output` is a convention, not authority | `review-job.mjs` `reviewJobRoot`/`reviewJobDir`; persisted `closeout-state.json` samples (report-lifecycle-repair-1, fm3-rbi) |

**B0 gate finding:** `card_title` / `card_type` / `out_dir` cannot be proven
from any already-frozen authoritative task contract. Per Issue #8 B0, the
"explicit admission-bound additive contract" branch applies — with the
requirement that the admission issuer project those values from the authority
record at issuance, never from runner opts.

## 2. Locked decisions

1. **Extend the single authority record** `lifecycle-authorization` v2 → v3:
   additive optional top-level block `closeout_metadata`
   (`card_title`, `card_type`, `out_dir`). v2 records remain valid (block
   optional at schema level); a **review-required** card whose record lacks
   the block → HOLD at admission validation. Issued by the Controller
   (round-prepare / authority issuance), same exclusive-create artifact,
   same `authorityDigest` chain. This is the ONE identity owner; nothing else
   is invented.
2. **Frozen projection into admission**: `admission.extensions.review_closeout`
   (schema `autoloop.review-closeout/v1`), projected by the admission issuer
   BEFORE `freezeAdmission`, from the v3 record + spec bytes. `extensions` is
   the schema-sanctioned additive slot; `admission_id` =
   `sha256(canonical(record minus admission_id/decision_time))` binds it —
   any binding mutation is ADMISSION_DRIFT at the existing gate. Precedent:
   `extensions.budget` (ta3-verify).
3. **`authority_binding.authority_record_digest` MUST be non-zero and equal
   to `source_authority_digest`** for review-required admissions. The current
   `buildAdmissionRecord` default (`0000…0`) becomes a HOLD for
   review-required (unchanged for non-review-required).
4. **Prohibitions**: no runtime supplement from runner opts (`closeout.*`
   caller fields stay non-authoritative); no derivation of title/type from
   card text / `card_body`; no second bootstrap record type; no
   atomic-replace over a binding-inconsistent persisted state.

## 3. `review_closeout` contract (frozen, draft-07)

`$id: autoloop.review-closeout/v1`, `additionalProperties: false`, all
fields required (complete or HOLD — no partial binding):

```jsonc
{
  "schema": "autoloop.review-closeout/v1",
  "card_id":           "<string, == authority.card_id>",
  "card_title":        "<string, from authority.closeout_metadata.card_title>",
  "card_type":         "<enum implementation|research|repair|integration|closeout, from authority.closeout_metadata.card_type>",
  "out_dir":           "<repo-relative path, from authority.closeout_metadata.out_dir; no leading '/', no '..' segments>",
  "spec_id":           "<string, default = card_id>",
  "spec_path":         "<repo-relative path, == authority.spec_path>",
  "spec_digest":       "<sha256 of canonical spec bytes at projection time, derived via spec-identity.mjs>",
  "repository":        "<== authority.repository>",
  "worktree":          "<== authority.worktree>",
  "branch":            "<== authority.branch>",
  "base":              "<== authority.base>",
  "base_head":         "<== authority.base_head, ^[0-9a-f]{40}$>",
  "authorized_scope":  ["<== authority.authorized_paths, non-empty>"],
  "bundle_path":       "<== authority.bundle_path (may be '')>",
  "source_authority_digest": "<sha256 canonical lifecycle-authorization record == admission.authority_binding.authority_record_digest>"
}
```

Projection rule: every value is copied verbatim from the validated v3 record
except `spec_digest` (derived from `spec_path` bytes via `spec-identity.mjs`).
The admission issuer verifies the record validates
(`validateAuthorityRecord`) and re-derives `source_authority_digest` itself —
never accepts a caller-fed digest.

## 4. Cross-field invariants (I1–I12)

- **I1 presence ⇔ requirement**: `reviewRequired(admission)` (`review_policy.strength ∈ {independent, external}`) ⇔ binding present AND complete. Review-required + missing/incomplete binding → HOLD at admission validation (pre-dispatch, `nodeResults: []`). Non-review-required + binding present → HOLD (authority inflation).
- **I2 card identity**: `binding.card_id == authority.card_id == closeout-state.task.cardId == review-job.lineageId`. `admission.task_id` is the execution instance and may differ; never conflated.
- **I3 one digest chain**: `source_authority_digest == authorityDigest(record) == admission.authority_binding.authority_record_digest`, all non-zero (I4-zero-digest rule above).
- **I4 out_dir**: repo-relative in binding; resolved to worktree-absolute at bootstrap; persisted `closeout-state.outDir == resolved`; `closeoutStatePath(outDir) == outDir/closeout-state.json`. Resume re-resolves against the bound worktree; mismatch → HOLD (never re-path silently).
- **I5 scope**: `authorized_scope == authority.authorized_paths`; `admission.mutation_scope ⊆ authorized_scope`; `closeout-state.authorizedScope == authorized_scope`. Closeout gate identity/scope checks consume the same values.
- **I6 repo binding**: `repository/worktree/branch/base/base_head` verbatim from authority; bootstrap re-verifies live repo facts (`collectRepoFacts` / fingerprint) against `repository` + `base_head` before dispatch; resume re-verifies; mismatch → HOLD.
- **I7 spec**: `spec_path == authority.spec_path` (non-empty for review-required — `deriveLiveReviewBinding` throws `AUTHORITY_SPEC_PATH_MISSING` otherwise); `spec_digest` recomputed live at B2 job creation MUST equal the frozen binding digest → else HOLD (spec drift pre-check). `spec_id == card_id` unless the v3 record provides one.
- **I8 bundle_path**: projection equality only (`== authority.bundle_path`); relationship to generated bundle location verified during B1 wiring (see §8).
- **I9 admission determinism**: any binding change → `admission_id` change → existing gate ADMISSION_DRIFT. No runtime fallback, no second carrier.
- **I10 card-start baseline**: review-required bootstrap captures `captureBaselineInventory` (content-v1: `dirtyPaths` + `pathShas` + `contentDigest`) at card START and persists into `closeout-state.baseline`; `assertCardStartBaseline` HOLDs a delta-v1 closeout without it (`CARD_START_BASELINE_MISSING`) — unchanged.
- **I11 terminal semantics**: implementation PASS + bundle/delivery PASS + review outstanding = `REVIEW_PENDING` / `WAITING_FOR_EXTERNAL_REVIEW` — NEVER terminal PASS. Terminal PASS only via the acceptance chain (`assertFinalCardCloseout` + Controller `acceptReviewJob` + `assertReviewArtifactEnforced`).
- **I12 review-job ownership**: runtime may PREPARE/bind a job; only Controller-owned `acceptReviewJob` mints ACCEPTED (STAGED prerequisite, digest recompute from persisted bytes, reviewer independence, trusted-identity binding, candidate/spec/staged-set/repository recompute). Supersession/generation/CAS semantics unchanged.

## 5. Resume identity + bootstrap create-or-verify (B1 contract)

Resume identity tuple: `(admission_id, review_closeout binding digest, source_authority_digest, resolved out_dir, baseline.contentDigest)`.

`closeout-state.json` gains an additive `reviewCloseout` block:
`{ schema: "autoloop.review-closeout/v1", bindingDigest, admissionId }`
(`readCloseoutState` tolerates additive fields; `CLOSEOUT_REQUIRED_FIELDS`
unchanged — binding completeness is enforced at admission, not here).

`prepareReviewLifecycle()` (new small orchestrator, B1):
1. validate binding (I1–I3); resolve `out_dir` (I4); verify live repo facts (I6);
2. capture card-start baseline (I10);
3. **create-or-verify** state at `outDir/closeout-state.json`:
   - absent → write (atomic tmp+rename, secret-scanned) with task identity,
     `requiresReview: true`, `reviewRequiredAt`, scopes, baseline,
     `reviewCloseout` block;
   - present AND `bindingDigest` recomputes AND every identity field equals
     the binding AND `outDir` matches resolved AND baseline consistent
     → RESUME (no rewrite);
   - present but inconsistent → `HOLD / CLOSEOUT_BOOTSTRAP_BINDING_DRIFT`
     (never atomic-replace over a drifted state).

`completeReviewLifecycle()` (B1): at graph implementation completion,
`runAdmittedGraph` auto-invokes existing `runStateDrivenCloseout({statePath,
graphResult})` when the binding is present — no caller `closeout.*` opts.
Result semantics per I11: non-PASS dispositions
(`AWAITING_BUNDLE_DELIVERY`/`HOLD`) are retryable, never terminal.

`ensureCurrentReviewJob()` (B2a): post-implementation, post-delivery, bind a
REQUIRED review job from the live candidate (via `deriveReviewJobContext`)
only when the frozen `spec_digest` still matches; job created under
`docs/pi-graph-output/<card_id>/` (existing primitives: `createReviewJob`
exclusive-create, `createSuccessorReviewJob` supersede+CAS for drift).

## 6. Fail-closed mapping to Issue #8 negative acceptance

| #8 injection | Enforced by |
|---|---|
| 1. bootstrap failure → no dispatch / HOLD | B0/B1 admission-time gate (pre-dispatch, `nodeResults: []`) |
| 2. bundle emission/validation failure → no terminal PASS | existing `runMandatoryGraphCloseout` / `runCloseoutGate` (generation, secret scan, template residue, independent validation) |
| 3. delivery failure → no review-ready/PASS | existing `deliverToExternalReviewSurface` → `AWAITING_BUNDLE_DELIVERY` top-level |
| 4. missing/tampered review result → no ACCEPTED | `acceptReviewJob` digest recompute + `authorizationSource` + reviewer independence |
| 5. candidate/spec drift → stale acceptance cannot authorize | `REVIEW_CANDIDATE_DRIFT` / `REVIEW_SPEC_DRIFT` in `acceptReviewJob` + `assertReviewArtifactEnforced` live binding + I7 pre-creation spec check |
| 6. job persistence/CAS failure → HOLD | review-job exclusive-create / atomic-replace-under-lock / `updateReviewJob` CAS |

## 7. Planned B1 mutation set (freeze input; NOT executed by B0)

- `src/schema/lifecycle-authorization.schema.json` — v3 additive `closeout_metadata` (accepts v2/v3 `$id`).
- `src/governance/lifecycle-authorization.mjs` — v3 validation, `closeout_metadata` normalization, `projectReviewCloseout(record, {specBytes})` helper (single projection implementation).
- `src/admission/policy-projection.mjs` / `admission-record.mjs` — `buildAdmissionRecord` accepts the projection; review-required binding-completeness + non-zero-digest validation (I1/I3).
- `src/admission/admission-gate.mjs` — `runAdmittedGraph`: bootstrap `prepareReviewLifecycle` before dispatch; auto `completeReviewLifecycle` at completion (B1).
- `src/governance/closeout-state.mjs` — `reviewCloseout` block write/verify.
- NEW `src/governance/review-lifecycle.mjs` — `prepareReviewLifecycle` / `completeReviewLifecycle` / `ensureCurrentReviewJob` (coordination only; no new authority).
- `scripts/gov-controller-*` — issuance of v3 `closeout_metadata`.
- Tests: admission binding gate (I1/I3 negatives), bootstrap create-or-verify (RESUME / DRIFT), E2E zero-prompt, fault-injection per §6. Existing suites untouched.

## 8. Open items resolved during B1 wiring

- **`bundle_path` consistency rule — LOCKED (B1)**: `bundle_path` (when
  non-empty) MUST canonically resolve INSIDE `binding.out_dir`
  (enforced at bootstrap; `REVIEW_CLOSEOUT_BUNDLE_PATH_OUTSIDE_OUT_DIR`
  otherwise). It is a review-routing locator — the lifecycle NEVER writes to
  it; `runCloseoutGate` writes the canonical `card-closeout-bundle-*.txt`
  into `outDir` and the delivery trio (Current/ `review-bundle.txt` +
  `delivery.json` + `evidence.json`) stays the authoritative downstream
  surface. `gov-review-bundle.mjs` `READY_FOR_REVIEW.txt` stays a legacy
  manual flow, unchanged.
- **Admission issuer seam (B1)**: no in-repo script mints production
  admissions (verified: `writeLifecycleAuthorization` has no callers in
  `src/scripts/test`; `buildAdmissionRecord` callers are verification
  scripts/tests only). The issuer is the Controller/Pi harness outside this
  repo. B1 therefore exposes the sanctioned seam — `projectReviewCloseout`
  (lifecycle-authorization.mjs) + `buildAdmissionRecord({ reviewCloseout,
  authorityRecordDigest })` — and the pre-dispatch gate enforces the
  contract; NO second owner is created.
- `closeout-state` optional fields (`regression`, `risks`, …) remain
  card-content claims filled at closeout time by the graph result — the
  binding covers identity/scope/outDir only, never free-text content.

## 9. Evidence index

- `src/governance/closeout-state.mjs` — CLOSEOUT_REQUIRED_FIELDS (130–135), closeoutStatePath (138–140), materializeCloseoutContract (226+), write/readCloseoutState (150–225).
- `src/admission/admission-record.mjs` — schema + `extensions` + `authority_binding` (20–200), deriveAdmissionId, freezeAdmission.
- `src/admission/admission-gate.mjs` — `assertProductionAdmission`, `runAdmittedGraph` (161+) forwards opts unchanged (Gap 2).
- `src/admission/policy-projection.mjs` — `buildAdmissionRecord` (311–350), zero-digest default (347).
- `src/governance/lifecycle-authorization.mjs` — TOP_LEVEL_BINDINGS, effectiveAuthority, `authorityDigest`, `lifecycleAuthorizationPath`/`write`/`readLifecycleAuthorization`.
- `src/schema/lifecycle-authorization.schema.json` — v2 required set (no title/type/outDir).
- `src/schema/authority-record.schema.json` — card_body only.
- `src/governance/review-artifact-gate.mjs` — `reviewRequired`, `deriveLiveReviewBinding`, `assertReviewArtifactEnforced`.
- `src/governance/review-job.mjs` — `createReviewJob`, `createSuccessorReviewJob`, `updateReviewJob`, `acceptReviewJob`.
- `src/governance/review-job-context.mjs` — `deriveReviewJobContext` (candidate/spec identity).
- `src/governance/spec-identity.mjs` — frozen spec digest normalization.
- `src/governance/review-bundle.mjs` — CARD_TYPES (103), captureBaselineInventory (1229), assertCardStartBaseline (1298), runCloseoutGate (2331), runMandatoryGraphCloseout (3082), runStateDrivenCloseout (3492), externalReviewSurfaceDir (183), deliverToExternalReviewSurface (686).
- `src/runtime/colima-graph-runner.mjs` — caller-opt-in closeout branch (467–510).
- `src/control-plane/coordinator.mjs` — per-task `cardId`/`liveReviewBinding`/`admission` consumption (160–233, 300–376).
- `scripts/gov-review-job-orchestrator.mjs` — manual chain being automated (B2).
- Investigation: `docs/governance/autoloop-review-artifact-lifecycle-investigation.md` @ `origin/governance/decomp-opt1-impl1`.

## 10. Gate

B1 production mutation is authorized only against this frozen B0 contract.
Any discovery that a field cannot be projected from the §1 sources → STOP,
`HOLD / REPLAN`, return to Issue #8 — the design is never silently amended.
