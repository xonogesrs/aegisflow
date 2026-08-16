// src/governance/review-lifecycle.mjs
//
// AUTOLOOP-REVART-LC1-B1 — admission-driven review lifecycle (coordination
// only; owns NO new authority).
//
// This module is the B0/B1 seam between the frozen admission and the existing
// state-driven closeout machinery:
//
//   resolveReviewCloseout(admission)   — pre-dispatch authority gate
//     review-required ⇔ complete `extensions.review_closeout` binding;
//     authority digest chain non-zero + equal; mutation_scope ⊆ authorized.
//   prepareReviewLifecycle(...)        — bootstrap closeout-state.json
//     create-or-verify against the frozen binding + FM-3 card-start baseline
//   completeReviewLifecycle(...)       — completion trigger: run the existing
//     runStateDrivenCloseout and remap the terminal: bundle/delivery PASS is
//     REVIEW_PENDING while an authoritative review is outstanding — never a
//     terminal PASS (RB2R1).
//
// It reuses every existing primitive (review-bundle / closeout-state /
// review-artifact-gate). No new artifact format, no second identity owner,
// no runtime metadata derivation. Caller closeout opts are NON-authoritative
// once a binding is present — they never redirect this seam.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { reviewRequired } from "./review-artifact-gate.mjs";
import {
  REVIEW_CLOSEOUT_SCHEMA,
  validateReviewCloseoutBinding,
  reviewCloseoutBindingDigest,
  scopeCovers,
} from "./lifecycle-authorization.mjs";
import {
  closeoutStatePath,
  readCloseoutState,
  writeCloseoutState,
  closeoutStateForBinding,
  verifyCloseoutStateAgainstBinding,
  deriveCloseoutStage,
} from "./closeout-state.mjs";
import { captureBaselineInventory, runStateDrivenCloseout } from "./review-bundle.mjs";

export const REVIEW_LIFECYCLE_HOLDS = Object.freeze({
  BINDING_MISSING: "REVIEW_CLOSEOUT_BINDING_MISSING",
  BINDING_UNREQUIRED: "REVIEW_CLOSEOUT_BINDING_UNREQUIRED",
  BINDING_INVALID: "REVIEW_CLOSEOUT_BINDING_INVALID",
  AUTHORITY_DIGEST_MISMATCH: "REVIEW_CLOSEOUT_AUTHORITY_DIGEST_MISMATCH",
  SCOPE_MISMATCH: "REVIEW_CLOSEOUT_SCOPE_MISMATCH",
  WORKTREE_MISSING: "REVIEW_CLOSEOUT_WORKTREE_MISSING",
  REPO_RESOLVE_FAILED: "REVIEW_CLOSEOUT_REPO_RESOLVE_FAILED",
  OUT_DIR_ESCAPE: "REVIEW_CLOSEOUT_OUT_DIR_ESCAPE",
  BASELINE_FAILED: "REVIEW_CLOSEOUT_BASELINE_FAILED",
  BUNDLE_PATH_OUTSIDE_OUT_DIR: "REVIEW_CLOSEOUT_BUNDLE_PATH_OUTSIDE_OUT_DIR",
  BOOTSTRAP_FAILED: "REVIEW_CLOSEOUT_BOOTSTRAP_FAILED",
  BINDING_DRIFT: "CLOSEOUT_BOOTSTRAP_BINDING_DRIFT",
  COMPLETION_STATE_ABSENT: "REVIEW_CLOSEOUT_COMPLETION_STATE_ABSENT",
});

const ZERO64 = /^0+$/;

function holdResult(holdCode, reason) {
  return { ok: false, holdCode, reason };
}

/**
 * Pre-dispatch authority gate (B0 I1/I3/I5). PURE — no I/O.
 *
 * @param {object|null} admission — frozen admission
 * @returns {{ok:true, active:false} | {ok:true, active:true, binding:object}
 *          | {ok:false, holdCode:string, reason:string}}
 */
export function resolveReviewCloseout(admission) {
  const required = reviewRequired(admission);
  const binding = admission?.extensions?.review_closeout ?? null;
  if (required && !binding) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BINDING_MISSING,
      "REVIEW_CLOSEOUT_BINDING_MISSING: review-required admission (review_policy.strength independent|external) must carry a frozen extensions.review_closeout binding (B0)");
  }
  if (!required && binding) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BINDING_UNREQUIRED,
      "REVIEW_CLOSEOUT_BINDING_UNREQUIRED: review_closeout binding present on a non-review-required admission (authority inflation)");
  }
  if (!required) return { ok: true, active: false };

  const v = validateReviewCloseoutBinding(binding);
  if (!v.ok) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BINDING_INVALID,
      `REVIEW_CLOSEOUT_BINDING_INVALID: ${v.errors.slice(0, 5).join("; ")}`);
  }
  const bound = admission.authority_binding?.authority_record_digest ?? null;
  if (typeof bound !== "string" || ZERO64.test(bound) || bound !== binding.source_authority_digest) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.AUTHORITY_DIGEST_MISMATCH,
      `REVIEW_CLOSEOUT_AUTHORITY_DIGEST_MISMATCH: admission.authority_binding.authority_record_digest must be non-zero and equal binding.source_authority_digest (bound ${String(bound).slice(0, 12)})`);
  }
  const scope = Array.isArray(admission.mutation_scope) ? admission.mutation_scope : [];
  if (scope.length > 0 && !scope.every((p) => scopeCovers(p, binding.authorized_scope))) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.SCOPE_MISMATCH,
      "REVIEW_CLOSEOUT_SCOPE_MISMATCH: admission.mutation_scope must be a subset of binding.authorized_scope (authority scope)");
  }
  return { ok: true, active: true, binding };
}

function isWithin(child, parent) {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

function readdirSafe(dir) {
  try {
    return existsSync(dir) && statSync(dir).isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** Resolve the git top-level of a worktree, or null (fail-closed). */
export function gitTopLevel(worktree) {
  try {
    const r = spawnSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Bootstrap the review lifecycle BEFORE execution dispatch (B1): materialize
 * and persist the canonical closeout-state.json from the frozen binding with
 * create-or-verify semantics:
 *   absent  → capture FM-3 card-start baseline + write (atomic, secret-scanned)
 *   present → verify binding/admission/outDir/baseline → RESUME
 *   drifted → HOLD / CLOSEOUT_BOOTSTRAP_BINDING_DRIFT (never atomic-replace)
 * Any bootstrap failure HOLDs BEFORE the runner is invoked.
 *
 * @param {object} opts.admission — frozen admission (owns admission_id)
 * @param {object} opts.binding — validated review_closeout binding
 * @returns {{ok:true, created:boolean, resumed:boolean, statePath:string,
 *            repoRoot:string, outDir:string}
 *          | {ok:false, holdCode:string, reason:string}}
 */
export async function prepareReviewLifecycle({ admission, binding } = {}) {
  const worktree = binding?.worktree ?? null;
  if (typeof worktree !== "string" || worktree.length === 0 || !existsSync(worktree) || !statSync(worktree).isDirectory()) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.WORKTREE_MISSING,
      `REVIEW_CLOSEOUT_WORKTREE_MISSING: binding.worktree must be an existing directory (got ${worktree})`);
  }
  const repoRoot = gitTopLevel(worktree);
  if (!repoRoot) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.REPO_RESOLVE_FAILED,
      `REVIEW_CLOSEOUT_REPO_RESOLVE_FAILED: cannot resolve git top-level under binding.worktree ${worktree}`);
  }
  const outDir = resolve(repoRoot, binding.out_dir);
  if (!isWithin(outDir, repoRoot)) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.OUT_DIR_ESCAPE,
      `REVIEW_CLOSEOUT_OUT_DIR_ESCAPE: binding.out_dir ${binding.out_dir} resolves outside the repository root`);
  }
  // B0 §8 locked rule: authority bundle_path (when non-empty) MUST resolve
  // inside the card's out_dir — the closeout gate writes the canonical
  // bundle into outDir; bundle_path is a routing locator, never a redirect.
  if (typeof binding.bundle_path === "string" && binding.bundle_path.length > 0
    && !isWithin(resolve(repoRoot, binding.bundle_path), outDir)) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BUNDLE_PATH_OUTSIDE_OUT_DIR,
      `REVIEW_CLOSEOUT_BUNDLE_PATH_OUTSIDE_OUT_DIR: authority bundle_path ${binding.bundle_path} resolves outside binding.out_dir ${binding.out_dir}`);
  }
  const digest = reviewCloseoutBindingDigest(binding);
  const statePath = closeoutStatePath(outDir);

  const existing = readCloseoutState(statePath);
  if (existing.ok) {
    const chk = verifyCloseoutStateAgainstBinding(existing.state, {
      binding,
      bindingDigest: digest,
      admissionId: admission?.admission_id ?? null,
      resolvedOutDir: outDir,
    });
    if (!chk.ok) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.BINDING_DRIFT,
        `CLOSEOUT_BOOTSTRAP_BINDING_DRIFT: persisted closeout-state drifts from the frozen binding: ${chk.drift.join(",")}`);
    }
    return { ok: true, created: false, resumed: true, statePath, repoRoot, outDir };
  }

  let baseline;
  try {
    baseline = captureBaselineInventory(repoRoot, { cardId: binding.card_id });
  } catch (e) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BASELINE_FAILED,
      `REVIEW_CLOSEOUT_BASELINE_FAILED: card-start baseline capture failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }
  const state = closeoutStateForBinding({
    binding,
    bindingDigest: digest,
    admissionId: admission?.admission_id ?? null,
    resolvedOutDir: outDir,
    baseline,
  });
  const w = writeCloseoutState({ path: statePath, state });
  if (!w.ok) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.BOOTSTRAP_FAILED,
      `REVIEW_CLOSEOUT_BOOTSTRAP_FAILED: closeout-state write failed: ${w.reason}`);
  }
  return { ok: true, created: true, resumed: false, statePath, repoRoot, outDir };
}

/**
 * Completion trigger (B1): at graph implementation PASS, run the existing
 * state-driven closeout against the bootstrapped state, then remap the
 * terminal (B0 I11): bundle generation + delivery PASS is REVIEW_PENDING
 * while no authoritative review is accepted — a review-required run NEVER
 * returns terminal PASS from this seam. HOLD / AWAITING_BUNDLE_DELIVERY
 * propagate fail-closed (never a successful terminal without artifacts).
 *
 * @param {object} opts.graphResult — the runAdmittedGraph-level result (PASS)
 * @returns {Promise<object>} closeout outcome { applied, final, stage,
 *          holdCode, reason, bundlePath, bundle, externalReview, statePath }
 */
export async function completeReviewLifecycle({
  admission,
  binding,
  graphResult,
  repoRoot,
  surfaceDir = null,
  timeoutMs = 30000,
} = {}) {
  const outDir = resolve(repoRoot, binding.out_dir);
  const statePath = closeoutStatePath(outDir);
  const st = readCloseoutState(statePath);
  if (!st.ok) {
    return {
      applied: true,
      final: "HOLD",
      holdCode: REVIEW_LIFECYCLE_HOLDS.COMPLETION_STATE_ABSENT,
      reason: `REVIEW_CLOSEOUT_COMPLETION_STATE_ABSENT: bootstrapped closeout-state missing at completion: ${st.errors.join(";")}`,
      statePath,
    };
  }
  // FM-3 delta inventory: the persisted card-start baseline activates the
  // CARD_INVENTORY_MODEL contract, which requires every delta path to be
  // accounted. The lifecycle declares the outputs IT writes (the closeout
  // state record + the graph-closeout evidence snapshot) into
  // cardFiles.closeoutOutputs; any OTHER touched path the graph produced
  // must be declared by the graph/card — otherwise the gate fails closed
  // (inventory_unauthorized_touched / missing implementation file). This is
  // machine-output accounting, NOT metadata supplementation (identity stays
  // binding-owned).
  const evidenceName = `${graphResult?.executionId ?? "graph-unknown"}-graph-closeout-evidence.json`;
  const machineOutputs = [
    relative(repoRoot, statePath),
    relative(repoRoot, join(outDir, evidenceName)),
    // Previously generated canonical bundles (a retry re-validates with the
    // earlier bundle present as a dirty delta path — it is a lifecycle
    // output and must be accounted).
    ...readdirSafe(outDir)
      .filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"))
      .map((f) => relative(repoRoot, join(outDir, f))),
  ];
  const declared = Array.isArray(st.state.cardFiles?.closeoutOutputs) ? st.state.cardFiles.closeoutOutputs : [];
  const missing = machineOutputs.filter((p) => !declared.includes(p));
  if (missing.length > 0) {
    const next = { ...st.state, cardFiles: { ...(st.state.cardFiles ?? {}), closeoutOutputs: [...declared, ...missing] } };
    const w = writeCloseoutState({ path: statePath, state: next });
    if (!w.ok) {
      return { applied: true, final: "HOLD", holdCode: REVIEW_LIFECYCLE_HOLDS.BOOTSTRAP_FAILED, reason: `closeout outputs declaration failed: ${w.reason}`, statePath };
    }
  }

  const r = await runStateDrivenCloseout({
    statePath,
    graphResult,
    repoPath: repoRoot,
    cwd: binding.worktree ?? repoRoot,
    surfaceDir: surfaceDir ?? null,
    timeoutMs,
  });

  // RB2R1 terminal remap: persisted/bundle PASS is descriptive only.
  let final = r.final ?? "HOLD";
  if (final === "PASS") {
    const status = r.externalReview?.externalReviewStatus
      ?? st.state.closeout?.externalReviewStatus
      ?? "AWAITING_EXTERNAL_REVIEW";
    // An authoritative accepted review is the ONLY thing that makes a
    // review-required card terminal PASS; everything else is REVIEW_PENDING.
    if (status !== "PASS") final = "REVIEW_PENDING";
  }

  const updated = readCloseoutState(statePath);
  const stage = updated.ok ? deriveCloseoutStage(updated.state) : null;
  return { ...r, final, stage, statePath };
}

// Re-exported for callers that need the requirement predicate without pulling
// the whole artifact gate.
export { reviewRequired, REVIEW_CLOSEOUT_SCHEMA };
