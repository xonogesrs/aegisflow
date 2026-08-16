# AUTOLOOP-REVART-IMPL1-RC2-FREEZE — Identity / Provenance Authority Completion

## Status

`READY` → **`FROZEN_AND_EXECUTABLE`** (this document)

## Verdict

```
PASS / RC2_GATE_B_EXECUTABLE_FREEZE_FINALIZED
```

This freeze is the sole implementation contract for RC2. It resolves the four
open authority decisions (D1–D4), records the root-cause correction from
RC2-A1, and proves every required invariant has exactly one authorized
production owner. No production/test source mutation is authorized by this
document; it authorizes the mutation set that RC2-C1 will execute.

---

# 1. Context Binding

```text
repo:      git@github.com:xonogesrs/autoloop.git
worktree:  /Volumes/NVM2T/Development/autoloop
branch:    governance/reversible-lifecycle-draft-pr
HEAD:      56bb281fee0ac3735cdff08949e9d71997e6011c
```

Pre-mutation baseline is frozen in §15.

---

# 2. Root-Cause Correction (from RC2-A1)

The provenance layer is **not globally absent**. Flow 1 already owns
candidate/context/repository authority through:

- `buildChangeInventory` — changedTree/patch/head/baseHead/branch
- `computeReviewContext` — context assembly
- `assertLiveBindings` — live worktree/branch/base binding
- `productionRemoteMatch` — repository remote policy
- `collectFingerprint` — repository origin URL

The actual failure:

> IMPL1 review-job lifecycle created a parallel **caller-fed authority domain**
> instead of delegating candidate/context/repository authority to these
> existing owners.

Genuinely missing responsibilities are limited to:

1. canonical spec-text identity;
2. production review-job orchestration;
3. trusted reviewer-identity binding.

Staging also requires strengthening inside the existing lifecycle.

RC2 MUST reuse existing authority machinery. A second Git/context authority
implementation is FORBIDDEN.

---

# 3. Authority Ownership Map (final)

| Authority Datum              | Final Owner                                        |
| ---------------------------- | -------------------------------------------------- |
| repository expected identity | lifecycle authorization record                      |
| repository live verification | `collectFingerprint` + `productionRemoteMatch`      |
| worktree binding             | `assertLiveBindings`                                |
| branch                       | `buildChangeInventory`                              |
| currentHead                  | `buildChangeInventory`                              |
| base                         | lifecycle authorization record (`base`)             |
| baseHead                     | authority `base_head` + `buildChangeInventory`      |
| changedTreeIdentity          | `buildChangeInventory`                              |
| patchSha256                  | `buildChangeInventory`                              |
| specDigest                   | NEW `spec-identity.mjs`                             |
| findingsDigest               | `persistFindings`                                   |
| verdictDigest                | `persistVerdict`                                    |
| reviewer trusted identity    | controller second-channel (`--reviewer-identity`)   |
| reviewer binding enforcement | `acceptReviewJob`                                   |
| required staged artifact set | `stageArtifacts` + acceptance re-verification       |
| lifecycle sequencing         | NEW `gov-review-job-orchestrator.mjs`               |

No authority-bearing datum has two competing production owners.

---

# 4. Frozen Authority Decisions

## D1 — Canonical Spec Source

`specDigest` authority derives from the canonical implementation-spec
Markdown file explicitly bound to the review/card. A caller-supplied digest is
never authoritative.

- Spec path is a **locator** supplied at creation (default convention:
  `docs/governance/<card-slug>-implementation-spec.md`; the orchestrator
  accepts an explicit `--spec-path`). The path locates bytes; it is not itself
  authority.
- `specDigest = SHA-256(canonicalSpecBytes(fileBytes))`.

Normalization (single owner, `spec-identity.mjs`), exactly the IMPL1 freeze §7
contract — **no silent broadening**:

1. read file as bytes;
2. require valid UTF-8 (decode fail → fail closed);
3. strip one leading UTF-8 BOM if present;
4. normalize CRLF → LF;
5. standalone CR is **not** normalized (outside the frozen contract);
6. filesystem path is excluded from digest input;
7. SHA-256 over normalized bytes.

Creation: read spec, compute digest, persist into review job; fail closed on
missing/unreadable/malformed input. Acceptance: re-read the **same** canonical
path, re-derive, compare against job-bound `specDigest`. Mismatch →
`REJECT / REVIEW_SPEC_DRIFT`.

## D2 — Repository Source of Truth

```
authority.repository     = authoritative expected identity
live git remote          = derived verification fact
productionRemoteMatch(authority.repository, liveRemote) = gate
```

The authority record is authority; the live remote is derived evidence and
never rewrites the record. Fail closed when: live remote unestablishable,
absent where required, mismatched, or execution is in another repository. The
review-job may persist the **verified** repository identity; authority
originates from the record plus successful live verification. No second
repository-identity algorithm.

## D3 — Base / Base-HEAD Ownership

The authority record owns the review base (`base`, `base_head`). The
orchestrator SHALL pass `record.base` into `buildChangeInventory`; the library
default `"main"` SHALL NOT determine review authority. Acceptance verifies
`base_head` and rejects base/baseHead drift. `change-inventory.mjs` remains
REUSE_AS_IS (explicit-argument reuse, no mutation).

## D4 — Reviewer Second-Channel Trust Boundary

RC2 uses the existing controller/operator second-channel as the trusted
reviewer identity boundary. No token/HMAC/cryptographic trust-root work.

Required guarantees:

- trusted reviewer identity must be present (controller `--reviewer-identity`);
- it is passed into `acceptReviewJob`;
- `verdict.reviewerIdentity === trustedReviewerIdentity` (else
  `REVIEWER_IDENTITY_MISMATCH`);
- reviewer satisfies existing `/^agent:/` and `!= implementer` rules;
- missing/mismatch fail closed;
- artifact/CLI self-declaration alone cannot create reviewer authority.

Explicit limitation:

```
KNOWN_LIMITATION / REVIEWER_SECOND_CHANNEL_NOT_CRYPTOGRAPHICALLY_AUTHENTICATED
```

RC2 guarantees **binding**, not cryptographic proof of operator identity.

---

# 5. Frozen Drift Semantics

| Drift case | Behavior |
|---|---|
| candidate changes after creation | `REJECT / REVIEW_CANDIDATE_DRIFT` |
| spec changes after creation | `REJECT / REVIEW_SPEC_DRIFT` |
| findings/verdict mutated | `REJECT / REVIEW_ARTIFACT_DIGEST_MISMATCH` |
| staged-set mutated after STAGED | `REJECT / REVIEW_STAGED_SET_DRIFT` |
| worktree/HEAD/branch mismatch | fail closed (live binding + recompute) |
| reviewer mismatch | `REJECT / REVIEWER_IDENTITY_MISMATCH` |

No context rebinding during acceptance.

---

# 6. Full Recompute Policy at Acceptance

Acceptance uses **full recomputation + field comparison** (not only a broad
boolean `inventoryMatches`). At minimum compare: repository verification,
worktree/live binding, branch, currentHead, base/baseHead,
changedTreeIdentity, patchSha256, specDigest, required staged artifact set,
finalized artifact bytes/digests, reviewer identity binding.

Existing helpers (`buildChangeInventory`, `computeReviewContext`,
`assertLiveBindings`, `productionRemoteMatch`, `collectFingerprint`,
`spec-identity`) are reused internally; their algorithms are not duplicated.

---

# 7. Dependency Reachability Result (audit PASS)

Findings that shape the module split:

1. **No `src/` module imports `scripts/`** (verified). Therefore
   `assertLiveBindings` and `productionRemoteMatch` (in
   `scripts/shared/gov-args.mjs`, REUSE_AS_IS) are invoked by the
   **scripts-layer** orchestrator and ingest entry, NOT by the `src/` context
   module. This is the exact owner boundary that keeps layering intact and
   avoids both a src→scripts import and any REUSE_AS_IS mutation.
2. `collectFingerprint(repoRoot)` (src/c2d) already derives the origin remote
   URL — repository live verification is importable from `src/`.
3. `buildChangeInventory({git, cwd, baseBranch, fs})` accepts an explicit
   base — D3 needs no mutation.
4. `--reviewer-identity` flag already exists on the controller ingest entry —
   D4 needs wiring, not a new channel.
5. Canonical spec convention exists
   (`docs/governance/autoloop-revart-impl1-review-artifact-lifecycle-implementation-spec.md`)
   — D1 is executable with an explicit `--spec-path` locator.
6. No new persistent store is required (artifacts remain under
   `docs/pi-graph-output/<cardId>/`).
7. Git runner (`git()`, execFileSync) is available to both staging and
   acceptance paths (both are scripts-layer entries with `cwd` = repo root).

Required exports verified present: `buildChangeInventory`, `computeReviewContext`,
`collectFingerprint`, `assertLiveBindings`, `productionRemoteMatch`, `git`,
`sha256Text`, `sha256Hex`, `writeJsonExclusiveCreate`,
`writeJsonAtomicReplaceUnderLock`.

---

# 8. Final Mutation Set

## MODIFY (3)

```text
src/governance/review-job.mjs
```
- acceptance-time candidate/context/spec recompute comparison;
- exact staged-set re-verification;
- trusted reviewer identity binding;
- fail-closed drift checks (candidate/spec/context/staged-set/reviewer).

```text
src/governance/review-job-writeback.mjs
```
- prohibit no-git STAGED transition (fail closed);
- prove exact required staged set (bidirectional equality);
- verify staged bytes/digests;
- reject partial/extra/wrong-generation staging.

```text
scripts/gov-controller-ingest-result.mjs
```
- propagate trusted reviewer identity into `acceptReviewJob`;
- supply verified context/git dependencies (via `review-job-context` +
  `assertLiveBindings` + `productionRemoteMatch`);
- never let self-declared artifact identity substitute controller authority.

## ADD production (3)

```text
src/governance/spec-identity.mjs
```
- `canonicalSpecBytes(bytes) -> bytes`; `specDigestOf(bytes) -> hex`;
- exactly one normalization implementation (D1).

```text
src/governance/review-job-context.mjs
```
- authoritative adapter over existing `src/` owners ONLY:
  `buildChangeInventory` (candidate), `computeReviewContext` (assembly),
  `collectFingerprint` (repository remote), `spec-identity` (spec digest);
- git runner injected by the caller;
- produces the authoritative `candidateIdentity` + `specIdentity` +
  `repositoryRemote` for review-job creation and acceptance recompute;
- delegates, never reimplements.

```text
scripts/gov-review-job-orchestrator.mjs
```
- production entry: load authority record → `assertLiveBindings` →
  `productionRemoteMatch` → derive context (`review-job-context`) →
  `createReviewJob` → `persistFindings` → `persistVerdict` →
  `finalizePersisted` → `stageArtifacts` (real git) → acceptance handoff;
- coordinates authoritative primitives; is not a second lifecycle state store.

## ADD tests (5)

```text
test/v2/test-spec-identity.mjs
test/v2/test-review-job-context.mjs
test/v2/test-reviewer-identity-binding.mjs
test/v2/test-staged-set-exact.mjs
test/v2/test-review-job-orchestrator.mjs
```

---

# 9. REUSE_AS_IS (byte-identical; import/call only)

```text
src/governance/change-inventory.mjs
src/governance/review-context.mjs
src/c2d/fingerprint.mjs
src/canonical-digest.mjs
src/governance/lifecycle-authorization.mjs
src/evidence/run-evidence-store.mjs
src/c2d/fs-atomic.mjs
scripts/shared/gov-args.mjs
scripts/gov-controller-prepare-round.mjs
scripts/gov-external-review-surface.mjs
```

Mutating any of these → `REPLAN_REQUIRED / RC2_REUSE_AS_IS_CONTRACT_BROKEN`.

---

# 10. FORBIDDEN

```text
src/schema/reviewer-verdict.schema.json      (INTERNAL_ONLY)
scripts/gov-review-bundle.mjs                 (retired)
external-review-result.json legacy path        (superseded)
```

Also forbidden: new Git authority implementation; new candidate-identity
algorithm; new repository-fingerprint algorithm; cryptographic reviewer
identity redesign; generalized credential system; unrelated governance
refactor; opportunistic cleanup; legacy path revival.

---

# 11. Invariant-to-Owner Matrix (executability audit)

Each row: required invariant → exact owner → authorized file → dependency →
dependency mutation status.

| # | Required invariant | Owner | Authorized file | Dependency | Dep status |
|---|---|---|---|---|---|
| 1 | derive repository truth (expected) | authority record `repository` | lifecycle-authorization.schema.json | `loadRecord` | REUSE_AS_IS |
| 2 | derive repository remote (live) | `collectFingerprint` | src/c2d/fingerprint.mjs | `git remote get-url` | REUSE_AS_IS |
| 3 | verify repository remote | `productionRemoteMatch` | scripts/shared/gov-args.mjs | record + remote | REUSE_AS_IS |
| 4 | worktree live binding | `assertLiveBindings` | scripts/shared/gov-args.mjs | `realpath` | REUSE_AS_IS |
| 5 | derive branch | `buildChangeInventory` | change-inventory.mjs | `git branch --show-current` | REUSE_AS_IS |
| 6 | derive currentHead | `buildChangeInventory` | change-inventory.mjs | `git rev-parse HEAD` | REUSE_AS_IS |
| 7 | bind base | record `base` → `baseBranch` arg | orchestrator + change-inventory.mjs | record.base | REUSE_AS_IS |
| 8 | derive baseHead | `buildChangeInventory` | change-inventory.mjs | `git rev-parse base` | REUSE_AS_IS |
| 9 | derive changedTreeIdentity | `buildChangeInventory` | change-inventory.mjs | git diffs | REUSE_AS_IS |
| 10 | derive patchSha256 | `buildChangeInventory` | change-inventory.mjs | git diffs | REUSE_AS_IS |
| 11 | derive specDigest | `specDigestOf` | spec-identity.mjs | `sha256Text` | ADD |
| 12 | create review job | `createReviewJob` | review-job.mjs | schemas + fs-atomic | MODIFY |
| 13 | persist findings | `persistFindings` | review-job-writeback.mjs | fs-atomic | MODIFY |
| 14 | persist verdict | `persistVerdict` | review-job-writeback.mjs | fs-atomic | MODIFY |
| 15 | finalize artifacts | `finalizePersisted` | review-job-writeback.mjs | fs reads | MODIFY |
| 16 | prove exact git staging | `stageArtifacts` | review-job-writeback.mjs | injected git | MODIFY |
| 17 | bind trusted reviewer identity | `acceptReviewJob` + ingest flag | review-job.mjs + ingest | controller `--reviewer-identity` | MODIFY |
| 18 | detect candidate drift | `acceptReviewJob` compare | review-job.mjs | recomputed context | MODIFY |
| 19 | detect spec drift | `acceptReviewJob` compare | review-job.mjs | spec-identity | MODIFY |
| 20 | detect context drift | `assertLiveBindings` + `acceptReviewJob` | gov-args + review-job.mjs | git | REUSE/MODIFY |
| 21 | detect staged-set drift | `acceptReviewJob` index re-read | review-job.mjs | injected git | MODIFY |
| 22 | acceptance transition | `acceptReviewJob` | review-job.mjs | state machine + CAS | MODIFY |
| 23 | delivery bound to ACCEPTED | `buildReviewJobDeliveryProjection` | review-bundle.mjs | readReviewJob + artifacts | IMPL1 (kept) |

Every row has exactly one executable authority path. Gate B executability
audit: **PASS**.

---

# 12. Required Negative Probes (RC2-C1 verification)

Candidate: fake changedTree/patch/head/baseHead/repository/branch; wrong
worktree; candidate changed after creation. Spec: caller specDigest; BOM
variation; CRLF/LF; spec changed after creation; wrong bytes vs digest.
Reviewer: self-declared "independent"; CLI claim vs trusted channel; ==
implementer; missing trusted identity. Staging: no git staging; one/two
artifacts only; extra artifact; correct paths mutated bytes; stage then
unstage before acceptance; wrong generation. Context: create under HEAD A /
accept under HEAD B; worktree swap; branch change; repository mismatch.

---

# 13. Implementation PASS / HOLD / REPLAN Rules

During RC2-C1:

- mutate only files in §8;
- no REUSE_AS_IS mutation (any need → REPLAN);
- no new production owner/store beyond §8;
- no second Git/context authority;
- no cryptographic reviewer redesign;
- preserve IMPL1 proven-good behavior (canonical paths, persisted artifacts,
  digest recompute, supersession terminality, replay semantics, legacy
  bypass closure, strict authoritative verdict schema, delivery-requires-
  ACCEPTED, artifact/digest verification at delivery).

---

# 14. Known Limitation

```text
KNOWN_LIMITATION / REVIEWER_SECOND_CHANNEL_NOT_CRYPTOGRAPHICALLY_AUTHENTICATED
```

The controller second-channel is operator-provided metadata, not a
cryptographic identity. RC2 guarantees binding, not proof of operator
identity. Future hardening item — out of RC2 scope.

---

# 15. Pre-Mutation Identity Baseline

```text
repo:      git@github.com:xonogesrs/autoloop.git
worktree:  /Volumes/NVM2T/Development/autoloop
branch:    governance/reversible-lifecycle-draft-pr
HEAD:      56bb281fee0ac3735cdff08949e9d71997e6011c
staged:    0 files

AUTH1 candidate (preserved, byte-identical):
  13 tracked files, +133 / -33
  untracked: test/admission/test-retrieval-authority.mjs
             ef10d4900e15e00fb6cd556359eef504351cde45aacdfdc38ea4e09626fb269a

IMPL1 current dirty (inherited, not part of RC2 mutation):
  5 MODIFY + 5 ADD production + 3 ADD tests
```

REUSE_AS_IS byte digests (sha256):

```text
change-inventory.mjs           87c6e6501968a5f84d4a5b2082a64c15c8a2bd9150f90db486af226b6c05d8cd
review-context.mjs             14826cb88c12bf152f07a2d191b7671aa9364ca4f999610d6e193b2ecb9a4a36
fingerprint.mjs                d9a6e3ad68bf201d38b06a04e5a5e0330be0cd9091ddac4e149df7738232abfa
canonical-digest.mjs           2b52f710ea8b23c9729f5e020a720e7f16aaf91576276149de5545085f737117
lifecycle-authorization.mjs    1d5f809029e0679afc22eef9e0584ca83a69ae95cca2e022dd481e4efb0732b1
run-evidence-store.mjs         a7b52eb6132b6e76ff3affbbd60e005fe74f6ea1c937adfb40c19e1cda5a6dcd
fs-atomic.mjs                  57241ead24d096f431ccf959df8453856f7ad9f3692accf50e87a90392314e9b
gov-args.mjs                   c4bf55eb615ce87618490fce317e1c4d1a6661bb1f9c87f1b6b28d46406e69c2
gov-controller-prepare-round.mjs be1768f9dd1befbc34ac9e5a81653fac567eabb6cd737282db8cf2d45d92faa5
gov-external-review-surface.mjs 303d630899f57291b50fb1fa29859f88e20b051b202626d813607f87aa1a7885
```

---

# 16. Next Step

```
PASS / RC2_GATE_B_EXECUTABLE_FREEZE_FINALIZED
→ open RC2-C1 — Frozen Implementation Execution (consume this freeze exactly)
```
