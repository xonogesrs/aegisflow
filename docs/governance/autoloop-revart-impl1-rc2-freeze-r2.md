# AUTOLOOP-REVART-IMPL1-RC2-FREEZE-R2 — Review Authority Domain Convergence Freeze

## Status

`A3_PASS` → **`FROZEN_AND_IMPL_READY`** (this document)

## Verdict

```
PASS / RC2_FREEZE_R2_IMPLEMENTATION_CONTRACT_FROZEN_AND_IMPL_READY
```

This freeze is the sole implementation contract for RC2 (revision R2). It
consumes the four converged decisions of `RC2-D1A-A3` (S1 / H2 / C1A / E1-A)
and freezes them into an executable, non-reinterpretable contract. It does
**not** authorize production/test source mutation; it authorizes the mutation
set that the next card — RC2 implementation authorization — will execute.

---

# 1. Context Binding

```text
repo:      git@github.com:xonogesrs/autoloop.git
worktree:  /Volumes/NVM2T/Development/autoloop
branch:    governance/reversible-lifecycle-draft-pr
HEAD:      56bb281fee0ac3735cdff08949e9d71997e6011c
staged:    0 files
```

Predecessor authority: `PASS / RC2_D1A_A3_REVIEW_AUTHORITY_DOMAIN_CONVERGED_AND_FREEZE_R2_READY`
(no source mutation authorized by A3 itself).

---

# 2. Frozen Decisions (the four, resolved together)

## D1 / S1 — Canonical Spec Authority (authority-record-owned binding)

```text
authority.spec = { path: <repo-relative canonical spec path> }
```

Frozen as a **top-level authority-record binding `spec_path`** (string,
repo-relative, `minLength 1`, `maxLength 512`), added to
`lifecycle-authorization.schema.json` alongside the existing top-level
bindings (`repository/worktree/branch/base/base_head`). Semantically it is
`authority.spec.path`.

Mandatory invariants:

- **S1.1** `--spec-path` is **not authority**. It is a creation-time locator
  used by the controller to bind the authority record; it may not redirect
  review authority to arbitrary bytes.
- **S1.2** The authority record owns which spec source applies.
- **S1.3** The path is a locator; authority is
  `specDigest = SHA256(canonicalSpecBytes)` via `spec-identity.mjs`
  (frozen normalization: strict UTF-8 → strip one BOM → CRLF→LF only; path
  excluded from digest).
- **S1.4** Creation and acceptance resolve the **same** authority-bound
  `spec_path`.
- **S1.5** If `spec_path` changes, the existing review generation is invalid
  unless explicitly superseded/re-created.
- **S1.6** Both `docs/pi-graph-output/<card>/<CARD>-card-spec.md` and
  `docs/governance/<card>-implementation-spec.md` layouts may exist, but an
  active review binds **exactly one**; no filename inference overrides the
  authority record.

Compatibility / migration:

- Existing **active** records: explicitly amended with `spec_path` before any
  RC2 review creation. No automatic fallback.
- Historical **closed** records: retain historical representation; no
  retroactive mutation.
- New/current review generations: `spec_path` **required** at creation
  (orchestrator fails closed when absent).

## D2 / H2 — Global Evidence / Governance-Lineage Domain

Canonical review evidence and governance lineage are **globally outside** the
implementation candidate domain (semantic exclusion, not arbitrary path
exclusion).

```text
candidateDomain(path) = INCLUDE
  unless path positively matches a canonical generated governance/evidence class
```

- **INCLUDE**: implementation source, tests, schemas, configs, explicit
  human-authored spec/card inputs, other candidate-relevant material.
- **EXCLUDE** (lifecycle-generated, canonical classes under
  `docs/pi-graph-output/<card>/`):

| Canonical class | Producer | Pattern |
|---|---|---|
| review-job state | lifecycle | `review-job.json` (exact) |
| findings | reviewer/lifecycle | `review-findings.g*.json` (all generations) |
| verdict | reviewer/lifecycle | `review-verdict.g*.json` (all generations) |
| closeout bundle | closeout | `card-closeout-bundle-*.txt` |
| graph/self closeout evidence | closeout | `*-graph-closeout-evidence.json`, `*-self-closeout-*.json` |
| external-review delivery | external review | `external-review-delivery-*.json` |
| generated evidence / state | lifecycle | `*-evidence.json`, `*-verification.json`, `*-decision.json`, `*-baseline.json`, `*-lifecycle-state.json`, `*-independent-review.json`, `closeout-state.json`, `checkpoint-*/*.md`, `vca1/*.md`, `cp2/*.md` |

- **Exception (must remain INCLUDE)**: `docs/pi-graph-output/<card>/<CARD>-card-spec.md`
  (human-authored card spec) is **positively preserved**. The classifier
  therefore EXCLUDES everything under the canonical root **except**
  `*-card-spec.md`. A bare `docs/pi-graph-output/**` exclusion WITHOUT
  positively preserving card specs is forbidden.
- `buildChangeInventory` remains the **sole** candidate identity owner; no
  `buildReviewCandidateInventory` or second identity algorithm.
- The exclusion applies at the **single `record` point** in
  `change-inventory.mjs`, covering committed (`base...HEAD`), dirty (`HEAD`),
  and untracked (`ls-files --others`) sources equally — evidence committed
  into HEAD cannot re-enter the candidate inventory.

## D3 / C1A — Semantic Candidate Identity (correct implementation)

`changedTreeIdentity` must be **semantic**, independent of incidental Git
transport state. The current `status` (`ADDED/MODIFIED/DELETED`) field is
Git-state-sensitive and is **removed from the identity digest**.

Frozen identity (change-inventory.mjs):

```text
changedTreeIdentity = digestOfPayload(
  sorted "path\tcontentSha256\tmode\tsymlink\tbinary"
)
```

- `status` is dropped; `patchSha256` is already status-independent and is
  unchanged.
- Deletion remains detectable: deleted entries carry `contentSha256="MISSING"`.
- `UNTRACKED/STAGED/COMMITTED/MODIFIED` are Git provenance, not semantic
  candidate content. Git transport state belongs in provenance/context
  evidence, not candidate identity.

Commit / promotion semantics:

| Situation | Frozen rule |
|---|---|
| commit **before** ACCEPTED | allowed iff the resulting projection relative to the authority-bound base is identical; otherwise `REVIEW_CANDIDATE_DRIFT` |
| commit **after** ACCEPTED | controlled promotion step (projection still the reviewed candidate) |
| base advancement | invalidates unless explicitly rebased/re-derived with a new generation |
| rebase | default `REVIEW_GENERATION_SUPERSEDED`; else requires proof of same authoritative base semantics + same projection |
| merge to target/base | terminates the reviewed candidate lifecycle; new authority baseline |
| evidence committed into HEAD | stays excluded (H2) |

## D4 / E1-A — Exclusion Security (static canonical classifier)

A single authority-owned policy module owns classification:

```text
src/governance/candidate-domain-policy.mjs   (NEW)
  candidateDomain(path) -> "INCLUDE" | "EXCLUDE"
```

- A path is excludable **only if all four dimensions match**:
  `canonical governance root` AND `recognized producer/domain` AND
  `recognized artifact class` AND `valid card/generation naming`
  (where applicable).
- Default is **INCLUDE**. Filename alone is insufficient.
  `src/foo/review-findings.g0001.json` is **not** excludable (root check fails).
- No production caller may supply `excludePaths / excludeGlob / excludePredicate /
  ignoreRoot / ignorePattern` as unrestricted authority. Any low-level
  exclusion primitive is constructed only by the authority-owned policy.
- Classification is centralized in one module; no scattered filename checks
  across orchestrator / acceptance / closeout.

---

# 3. Authority Ownership Map (final)

| Authority Datum | Final Owner |
|---|---|
| repository expected | authority record |
| repository live verification | `collectFingerprint` + `productionRemoteMatch` |
| worktree binding | `assertLiveBindings` |
| branch / currentHead | `buildChangeInventory` |
| base / baseHead | authority record + `buildChangeInventory` |
| canonical spec path | **authority record `spec_path` (S1)** |
| spec digest | `spec-identity.mjs` |
| candidate projection | `buildChangeInventory` + `candidate-domain-policy` |
| findings/verdict digest | `persistFindings` / `persistVerdict` |
| reviewer trusted identity | controller second-channel (`--reviewer-identity`) |
| required staged set | `stageArtifacts` + acceptance re-verification |
| lifecycle sequencing | `gov-review-job-orchestrator.mjs` |
| governance/evidence classification | `candidate-domain-policy.mjs` |

Every load-bearing datum has exactly one owner.

---

# 4. Final Lifecycle Model

```text
Authority Record { repo, base, spec_path }
        ↓
Candidate Projection = semantic changes − generated review/governance lineage
        ↓
Review Generation { review-job, findings, verdict }   [evidence domain]
        ↓
Git staging of evidence   [does not alter candidate projection]
        ↓
Acceptance { reverify repo/context + recompute projection + recompute spec
             + verify evidence + verify reviewer + verify staged-set }
        ↓
ACCEPTED → Delivery / Closeout   [outside candidate domain]
        ↓
Controlled Commit / Promotion   [same semantic projection]
        ↓
New authority baseline / next review
```

Creation and acceptance use the **same** authority-bound spec, the **same**
candidate-domain policy, and the **same** candidate identity algorithm.

---

# 5. Frozen Mutation Set

## MODIFY (production)

```text
src/governance/change-inventory.mjs
```
- C1A: drop `status` from `changedTreeIdentity` (semantic identity).
- H2: consume `candidate-domain-policy`; apply exclusion at the single `record`
  point across committed/dirty/untracked.
- No policy injected → behavior identical to today (Flow-1 compatible).

```text
src/schema/lifecycle-authorization.schema.json
src/governance/lifecycle-authorization.mjs
```
- Add top-level binding `spec_path` (S1); include it in the identity/binding
  intersection; fail-closed when required and absent.

```text
src/governance/review-job-context.mjs
```
- Resolve spec from authority `spec_path` (not caller `--spec-path`);
  consume candidate-domain policy and pass it into `buildChangeInventory`.

```text
scripts/gov-review-job-orchestrator.mjs
scripts/gov-controller-ingest-result.mjs
```
- Supply authority-bound `spec_path`; `--spec-path` demoted to binding
  locator; carry-forward `--summary` required (minor).

## ADD (production)

```text
src/governance/candidate-domain-policy.mjs
```
- Static canonical classifier (E1-A): `candidateDomain(path)`.

## Preserve (no change beyond RC2-C1)

The RC2-C1 authorized MODIFY/ADD set (`review-job.mjs`,
`review-job-writeback.mjs`, `spec-identity.mjs`, `gov-review-job-orchestrator.mjs`)
is preserved unless A3 proves otherwise (it did not).

## REUSE_AS_IS (byte-identical; import/call only)

```text
src/governance/review-context.mjs
src/governance/spec-identity.mjs
src/c2d/fingerprint.mjs
src/canonical-digest.mjs
src/evidence/run-evidence-store.mjs
src/c2d/fs-atomic.mjs
scripts/shared/gov-args.mjs
scripts/gov-controller-prepare-round.mjs
scripts/gov-external-review-surface.mjs
```

(`change-inventory.mjs` and `lifecycle-authorization.mjs` move
REUSE_AS_IS → MODIFY under R2. All other RC2-freeze §9 REUSE_AS_IS remain.)

Mutating any REUSE_AS_IS file → `REPLAN_REQUIRED / RC2_R2_REUSE_AS_IS_CONTRACT_BROKEN`.

## FORBIDDEN

```text
src/schema/reviewer-verdict.schema.json      (INTERNAL_ONLY)
scripts/gov-review-bundle.mjs                 (retired)
external-review-result.json legacy path        (superseded)
```

Also forbidden: new Git authority implementation; new candidate-identity
algorithm (`buildReviewCandidateInventory`); new repository-fingerprint
algorithm; caller-supplied exclusion authority; cryptographic reviewer
redesign; opportunistic cleanup; legacy path revival.

---

# 6. Frozen Test Contract

New tests (Freeze-R2 must authorize; see RC2-C1 ADD tests for the already
authorized set).

## Spec authority (S1)

- caller cannot redirect spec;
- authority-bound `spec_path` resolves;
- wrong/missing spec path fails closed;
- spec mutation → `REVIEW_SPEC_DRIFT`;
- two candidate spec locations cannot create ambiguity.

## Global evidence boundary (H2)

- current review evidence ignored by candidate identity;
- closeout evidence ignored;
- historical unrelated-card evidence ignored;
- card spec remains included;
- disguised source file not ignored (not excluded).

## Commit semantics (C1A)

- dirty → staged → committed (same bytes) → same semantic identity;
- actual byte mutation changes identity;
- base advancement invalidates;
- evidence committed into HEAD stays excluded;
- rebase behavior matches frozen rule.

## Cross-card (H2)

- another card writes evidence during current review → candidate stable;
- another card modifies actual source → candidate drift where applicable.

## Exclusion security (E1-A)

- `src/foo/review-findings.g0001.json` not excluded;
- caller exclude predicate rejected;
- invalid naming not excluded.

## Flow-1 compatibility

- `buildChangeInventory(existing args)` (no policy injected) before/after R2
  identical.

## Mandatory production-chain proof (§31)

```text
g0001 create → findings/verdict → staging → ACCEPTED → delivery → closeout
→ controlled commit → g0002 create → findings/verdict → ACCEPTED
```

Must prove, on the real repo:

- governance/evidence accumulation does not change candidate identity;
- dirty → staged → committed does not change semantic identity;
- real source/spec mutation still invalidates;
- caller cannot redirect authority spec;
- source disguised as evidence is not wrongly EXCLUDED.

---

# 7. Known Residuals

| Residual | Classification |
|---|---|
| acceptance recompute → ACCEPTED TOCTOU | `KNOWN_BOUNDED_RACE / NOT_RC2_BLOCKING` (CAS/`stateVersion` + single-controller + delivery re-verify) |
| reviewer second-channel non-cryptographic | `KNOWN_LIMITATION / REVIEWER_SECOND_CHANNEL_NOT_CRYPTOGRAPHICALLY_AUTHENTICATED` |

---

# 8. Final Contradiction Scan

| # | Question | Answer |
|---|---|---|
| 1 | Can any generated artifact enter candidate identity? | NO |
| 2 | Can any candidate source be accidentally excluded? | NO |
| 3 | Can caller input choose authority-bearing spec bytes? | NO |
| 4 | Can staging change semantic candidate identity? | NO |
| 5 | Can commit alone change semantic candidate identity? | NO |
| 6 | Can closeout invalidate the review it documents? | NO |
| 7 | Can another card's evidence invalidate this review? | NO |
| 8 | Can old generations contaminate new generations? | NO |
| 9 | Can evidence committed into HEAD re-enter candidate inventory? | NO |
| 10 | Can path naming disguise real source as governance evidence? | NO |
| 11 | Can base advancement silently preserve stale review authority? | NO |
| 12 | Are creation and acceptance using identical domain rules? | YES |

No unresolved YES. No A3-closed contradiction is reopened.

---

# 9. Implementation PASS / HOLD / REPLAN Rules (next card)

The next card (`RC2 implementation authorization`) must:

- mutate only files in §5;
- not mutate any REUSE_AS_IS file;
- not introduce a second candidate-identity or Git/context authority;
- not accept caller-supplied exclusion or spec authority;
- not add production owners/store beyond §5;
- preserve IMPL1 proven-good behavior (canonical paths, persisted artifacts,
  digest recompute, supersession terminality, replay semantics, delivery-
  requires-ACCEPTED, artifact/digest verification at delivery).

Any substantive divergence from this freeze or from A3 →
`HOLD / REPLAN`, never silently rewritten.

---

# 10. Next Step

```
PASS / RC2_FREEZE_R2_IMPLEMENTATION_CONTRACT_FROZEN_AND_IMPL_READY
→ open RC2 implementation authorization (consume this freeze exactly)
→ implementation + tests → production-chain acceptance
```

No source was mutated by this freeze. No new discovery card is required.
