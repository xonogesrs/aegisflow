// src/governance/card-inventory.mjs
//
// AUTOLOOP FM-3 — REVIEW BUNDLE INVENTORY CONSISTENCY（authorized /
// actually-touched / CARD_IMPLEMENTATION_FILES cross-check）.
//
// The review bundle previously derived `authorizedScope`（card claim）,
// `git actually-touched paths`（final dirty tree）and
// `CARD_IMPLEMENTATION_FILES`（card claim）from independent sources with NO
// structural cross-check: a file could be authorized + actually touched +
// card-owned yet missing from the implementation inventory and the bundle
// still validated（DE-2R `package.json` instance）.
//
// This module owns the PURE inventory model（no I/O — every input is an
// explicit argument, which makes the invariants directly unit-testable）:
//
//   - computeInventoryDelta: the ONE delta derivation（final dirty − baseline
//     dirty）. The production repo is NEVER expected to be clean, so the
//     "current-card-owned touched paths" are a DELTA over a captured
//     baseline snapshot, never the whole dirty tree. Pre-existing dirty
//     paths can therefore never be misclassified as current-card changes
//     （R3）.
//   - validateCardInventoryConsistency: the fail-closed invariant checks
//     （R1/R2/R3/R4/T1–T8）over the bundle's structured inventory model.
//
// The git capture side lives in review-bundle.mjs（captureBaselineInventory /
// collectRepoFacts）so there is exactly ONE repo-diff truth（the shared
// porcelain parser）; this module stays dependency-free（no circular
// imports）.
//
// Classification model（each path belongs to exactly one role per card）:
//   authorizedScope        — the card's granted paths（card claim, section 6）
//   baselinePaths          — dirty at card START（machine-captured snapshot）
//   finalDirtyPaths        — dirty at card CLOSEOUT（machine-captured, git）
//   deltaPaths             — finalDirtyPaths − baselinePaths = current-card
//                            touched candidates（machine-derived, single truth）
//   implementationPaths    — CARD_IMPLEMENTATION_FILES（card claim, section 9）
//   closeoutOutputPaths    — GRAPH_CLOSEOUT_OUTPUTS（card claim, section 9）
//   preExistingDirtyPaths  — PRE_EXISTING_DIRTY_FILES（card claim, section 9;
//                            must ⊆ baselinePaths — C3）
//   deletedPaths           — worktree-derived DELETED（machine truth, section 9）
//   exceptions             — structured authorization exceptions
//                            [{path, reason}]（never free-text only）

export const CARD_INVENTORY_BASELINE_SCHEMA = "autoloop.card-inventory.baseline/v1";
export const CARD_INVENTORY_MODEL = "delta-v1";

/** Normalize a path list: trim, drop empties, dedupe（order-preserving）. */
export function normalizePaths(list) {
  const seen = new Set();
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== "string") continue;
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * The ONE delta derivation. `deltaPaths` = the current-card touched
 * candidates:
 *   - final dirty paths that were NOT dirty in the baseline snapshot
 *     （membership delta）; plus
 *   - pre-existing dirty paths（dirty at card start AND at closeout）whose
 *     CONTENT changed during the card — proven by per-path sha256 identity
 *     when `baselinePathShas` / `finalPathShas` are supplied（TA-2R
 *     attribution model, NEG14/TA2_DELTA_ATTRIBUTION）.
 *
 * A path dirty at both ends with UNCHANGED content stays pre-existing
 *（excluded）— R3. A path dirty at both ends whose card-start sha is
 * unavailable（baseline predates content-identity capture）is pushed to
 * `unattributable` so the caller can FAIL CLOSED instead of guessing
 * attribution. When no sha maps are supplied the legacy membership-only
 * derivation is unchanged（historical / non-content cards）.
 *
 * Pure; the same function is used by collectRepoFacts, the closeout source
 * builder and the validator so no second repo-diff truth can diverge.
 */
export function computeInventoryDelta({ baselinePaths = [], finalDirtyPaths = [], baselinePathShas = null, finalPathShas = null } = {}) {
  const baseline = new Set(normalizePaths(baselinePaths));
  const final = normalizePaths(finalDirtyPaths);
  const contentMode = baselinePathShas && typeof baselinePathShas === "object" && !Array.isArray(baselinePathShas);
  const membershipDelta = final.filter((p) => !baseline.has(p));
  const contentModified = [];
  const unattributable = [];
  if (contentMode) {
    for (const p of final) {
      if (!baseline.has(p)) continue; // membership delta handles it
      const bs = baselinePathShas[p];
      const fs = finalPathShas && typeof finalPathShas === "object" ? finalPathShas[p] : undefined;
      if (bs === undefined || bs === null || fs === undefined) {
        unattributable.push(p); // card-start content identity unavailable -> fail closed
        continue;
      }
      if (String(bs) !== String(fs)) contentModified.push(p);
    }
  }
  const deltaPaths = [...membershipDelta, ...contentModified];
  const dedupe = [...new Set(deltaPaths)].sort();
  unattributable.sort();
  return {
    baselinePaths: [...baseline],
    finalDirtyPaths: final,
    deltaPaths: dedupe,
    membershipDelta: [...new Set(membershipDelta)].sort(),
    contentModified: [...new Set(contentModified)].sort(),
    unattributable,
  };
}

function exceptionPaths(exceptions) {
  const out = new Set();
  for (const e of Array.isArray(exceptions) ? exceptions : []) {
    if (typeof e === "string") { const t = e.trim(); if (t) out.add(t); }
    else if (e && typeof e === "object" && typeof e.path === "string" && e.path.trim()) out.add(e.path.trim());
  }
  return out;
}

/**
 * R1–R4 invariant checks（fail-closed）. Returns { ok, errors } where every
 * error is a stable `inventory_<rule>:<detail>` string. All set-algebra is
 * done over normalized path lists; errors are sorted for determinism.
 *
 *   C1  implementation completeness（R1/T1/T7）: every delta path that is
 *       authorized and NOT otherwise accounted（implementation / closeout
 *       output / deleted）is a MISSING implementation file.
 *   C2  no unauthorized implementation（R2/T4）: every CARD_IMPLEMENTATION_FILES
 *       entry must be in the authorized scope or a STRUCTURED exception.
 *   C2b unauthorized touched（T4）: every delta path must be authorized / a
 *       structured exception / a closeout output. Declaring it in
 *       CARD_IMPLEMENTATION_FILES does NOT bypass this（C2 still fails it）.
 *   C3  pre-existing provenance（R3）: every declared PRE_EXISTING_DIRTY_FILES
 *       entry must be present in the machine-captured baseline snapshot.
 *   C4  closeout classification（R4）: a path cannot be BOTH an implementation
 *       file and a closeout output（categories stay explicit and disjoint）.
 *   C5  delta integrity: the declared CURRENT_CARD_DELTA_PATHS must equal the
 *       recomputed finalDirtyPaths − baselinePaths（tamper/rendering check）.
 *       When `deltaKinds`（[{path, kind}] — the rendered DELTA_ATTRIBUTION）is
 *       supplied, the recompute is the content-aware one（membership delta ∪
 *       content-modified pre-existing dirty）so the two never diverge.
 *   C6  attribution classification（TA-2R content-v1）: every delta path must
 *       carry a rendered kind; ADDED implies not-in-baseline; MODIFIED /
 *       DELETED implies the path was pre-existing dirty（content-identity
 *       attribution only ever applies to pre-existing dirty paths）.
 *
 * Deleted / renamed paths（T8）: rename records contribute BOTH source and
 * destination to the delta（the porcelain parser keeps source provenance）,
 * so a rename that only declares the new path fails C1 on the old path;
 * deleted authorized paths must be declared in the implementation inventory
 * or the worktree-derived DELETED list.
 */
export function validateCardInventoryConsistency({
  authorizedPaths = [],
  implementationPaths = [],
  closeoutOutputPaths = [],
  preExistingDirtyPaths = [],
  baselinePaths = [],
  finalDirtyPaths = [],
  deletedPaths = [],
  deltaPaths = null,
  deltaKinds = null,
  exceptions = [],
} = {}) {
  const errors = [];
  const A = new Set(normalizePaths(authorizedPaths));
  const I = new Set(normalizePaths(implementationPaths));
  const O = new Set(normalizePaths(closeoutOutputPaths));
  const P = new Set(normalizePaths(preExistingDirtyPaths));
  const B = new Set(normalizePaths(baselinePaths));
  const D = new Set(normalizePaths(deletedPaths));
  const X = exceptionPaths(exceptions);

  const derived = computeInventoryDelta({ baselinePaths: [...B], finalDirtyPaths: finalDirtyPaths });
  const delta = derived.deltaPaths;
  // When the rendered DELTA_ATTRIBUTION kinds are supplied, the recomputed
  // delta（for C5）uses the SAME content-aware derivation the generator used:
  // the kinds ARE the single-truth delta（membership ∪ content-modified）.
  const kindPaths = Array.isArray(deltaKinds)
    ? [...new Set(deltaKinds.filter((k) => k && typeof k === "object" && typeof k.path === "string").map((k) => k.path.trim()).filter(Boolean))].sort()
    : null;

  // Directory-scoped authorization: an authorized entry ending in `/` grants
  // every path beneath it（the existing scope convention uses prefixes like
  // `docs/pi-graph-output/<card>/`）. Exact entries grant exactly one path.
  const authList = [...A];
  const inAuthorized = (p) => A.has(p) || authList.some((a) => a.endsWith("/") && p.startsWith(a));

  // C5 — declared delta must equal the recomputed delta（single truth）.
  if (deltaPaths !== null) {
    const decl = new Set(normalizePaths(deltaPaths));
    const declSorted = [...decl].sort().join("\u0000");
    const recomputed = kindPaths ?? delta;
    const derivedSorted = recomputed.join("\u0000");
    if (declSorted !== derivedSorted) {
      errors.push("inventory_delta_mismatch:declared_vs_recomputed");
    }
  }

  // C6 — attribution classification（content-v1）: every delta path carries a
  // rendered kind; ADDED implies not-in-baseline; MODIFIED/DELETED implies
  // pre-existing dirty（content identity）.
  if (Array.isArray(deltaKinds)) {
    const kindsByPath = new Map();
    for (const k of deltaKinds) {
      if (!k || typeof k !== "object" || typeof k.path !== "string") { errors.push("inventory_delta_kind_malformed"); continue; }
      const p = k.path.trim();
      if (!p || kindsByPath.has(p)) { errors.push("inventory_delta_kind_duplicate_or_empty"); continue; }
      kindsByPath.set(p, k.kind ?? null);
    }
    const decl = new Set(normalizePaths(deltaPaths));
    for (const p of decl) {
      if (!kindsByPath.has(p)) errors.push(`inventory_delta_kind_missing:${p}`);
    }
    for (const [p, kind] of kindsByPath) {
      if (!decl.has(p)) errors.push(`inventory_delta_kind_not_in_delta:${p}`);
      if (kind === "ADDED") {
        if (B.has(p)) errors.push(`inventory_delta_kind_added_but_baseline:${p}`);
      } else if (kind !== "MODIFIED" && kind !== "DELETED") {
        errors.push(`inventory_delta_kind_invalid:${p}:${kind}`);
      }
      // MODIFIED / DELETED: no baseline-membership axiom — a membership
      // modification of a clean-at-start tracked file is a legitimate MODIFIED
      //（its membership IS the proof）; a pre-existing dirty file must carry
      // the content proof, which the validator's DELTA_ATTRIBUTION block check
      // enforces（inventory_delta_kind_missing_content_proof）.
    }
  }

  // C1 — implementation completeness（R1 / T1 / T7）. Fail-closed on every
  // missing path（the error carries the exact path so the reviewer can see
  // precisely which implementation file was not inventoried）. For content-v1
  // bundles the delta includes content-modified pre-existing dirty paths, so
  // they are checked here too（they must be declared implementation files）.
  for (const p of kindPaths ?? delta) {
    if (inAuthorized(p) && !I.has(p) && !O.has(p) && !D.has(p)) {
      errors.push(`inventory_missing_implementation:${p}`);
    }
  }

  // C2 — every declared implementation file must be in scope or carry a
  // STRUCTURED authorization exception（free-text justification alone is not
  // accepted — R2）.
  for (const p of I) {
    if (!inAuthorized(p) && !X.has(p)) {
      errors.push(`inventory_unauthorized_implementation:${p}`);
    }
  }

  // C2b — unauthorized touched（T4）: a delta path outside scope, not a
  // structured exception and not a closeout output fails closed. Listing it
  // in CARD_IMPLEMENTATION_FILES cannot bypass the scope gate（C2 fails）.
  for (const p of kindPaths ?? delta) {
    if (!inAuthorized(p) && !X.has(p) && !O.has(p)) {
      errors.push(`inventory_unauthorized_touched:${p}`);
    }
  }

  // C3 — pre-existing dirty preservation（R3）: the declared pre-existing set
  // must be a subset of the machine-captured baseline（reliable baseline /
  // delta provenance; a pre-existing path is never required in the current
  // card implementation inventory — it is excluded by the delta itself）.
  for (const p of P) {
    if (!B.has(p)) {
      errors.push(`inventory_pre_existing_not_in_baseline:${p}`);
    }
  }

  // C4 — closeout output classification（R4）: implementation and closeout
  // output are disjoint categories.
  for (const p of I) {
    if (O.has(p)) {
      errors.push(`inventory_classification_overlap:${p}`);
    }
  }

  errors.sort();
  return { ok: errors.length === 0, errors };
}
