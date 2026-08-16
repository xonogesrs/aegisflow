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
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { reviewRequired } from "./review-artifact-gate.mjs";
import {
  REVIEW_CLOSEOUT_SCHEMA,
  validateReviewCloseoutBinding,
  reviewCloseoutBindingDigest,
  scopeCovers,
  authorityDigest,
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
import { readReviewJob, createReviewJob, jobIdFor } from "./review-job.mjs";
import { deriveReviewJobContext, candidateDrift, specDrift } from "./review-job-context.mjs";

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
  ROOT_BINDING_DRIFT: "REVIEW_JOB_ROOT_BINDING_DRIFT",
  JOB_BINDING_DRIFT: "REVIEW_JOB_BINDING_DRIFT",
  JOB_SPEC_DRIFT: "REVIEW_JOB_SPEC_DRIFT",
  JOB_CANDIDATE_DRIFT: "REVIEW_JOB_CANDIDATE_DRIFT",
  JOB_CREATE_FAILED: "REVIEW_JOB_CREATE_FAILED",
  JOB_READ_FAILED: "REVIEW_JOB_READ_FAILED",
  JOB_STATE_ABSENT: "REVIEW_JOB_STATE_ABSENT",
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

// ---------------------------------------------------------------------------
// REVART-LC1-B2 — review-job materialization (B2-1..B2-3, B2-7).
// ---------------------------------------------------------------------------
//
// The governed review job root is derived from the authority-bound closeout
// out_dir (B2-2, LOCKED): root = dirname(resolved out_dir) — NEVER
// process.cwd(). A mismatch between the binding-resolved out_dir and the
// persisted resolved identity HOLDs (REVIEW_JOB_ROOT_BINDING_DRIFT); no
// silent relocation, no fallback.
//
// ensureCurrentReviewJob (B2-1) is create-or-verify-or-HOLD:
//   absent                       → create exactly one job (REQUIRED, g0001)
//   present + chain-consistent   → RESUME / reuse (idempotent)
//   present + any chain drift    → HOLD (never silent replace)
// The job binds the LIVE candidate/spec (deriveReviewJobContext) plus the
// frozen lifecycle identity chain (B2-3): admission_id, binding digest,
// source authority digest, resolved out_dir, baseline content digest.

/** Default git runner (mirrors scripts/shared/gov-args.mjs `git`). */
export function defaultGitRunner(cwd) {
  return (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * B2-2 — derive the governed review-job root from the binding/state out_dir.
 * Pure. Returns { ok, root } or { ok:false, holdCode, reason }.
 */
export function resolveReviewJobRoot({ binding, repoRoot, state = null } = {}) {
  const resolvedOutDir = resolve(repoRoot, binding?.out_dir ?? "");
  const root = dirname(resolvedOutDir);
  if (state && typeof state === "object") {
    if (state.outDir !== resolvedOutDir) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.ROOT_BINDING_DRIFT,
        `REVIEW_JOB_ROOT_BINDING_DRIFT: persisted state.outDir ${state.outDir} != binding-resolved ${resolvedOutDir} (no relocation)`);
    }
  }
  return { ok: true, root, outDir: resolvedOutDir };
}

/** The frozen lifecycle identity chain bound into a governed job (B2-3). */
export function buildLifecycleIdentity({ admission, binding, resolvedOutDir, baselineContentDigest } = {}) {
  return {
    admissionId: admission?.admission_id ?? null,
    bindingDigest: binding ? reviewCloseoutBindingDigest(binding) : null,
    sourceAuthorityDigest: binding?.source_authority_digest ?? null,
    outDir: resolvedOutDir,
    baselineContentDigest,
  };
}

/** Field-level drift between a job's lifecycleIdentity and the expected chain. */
export function lifecycleIdentityDrift(job, expected) {
  const drift = [];
  const id = job?.lifecycleIdentity ?? null;
  if (!id || typeof id !== "object" || Array.isArray(id)) {
    drift.push("lifecycleIdentity");
    return drift;
  }
  if (id.admissionId !== expected?.admissionId) drift.push("admissionId");
  if (id.bindingDigest !== expected?.bindingDigest) drift.push("bindingDigest");
  if (id.sourceAuthorityDigest !== expected?.sourceAuthorityDigest) drift.push("sourceAuthorityDigest");
  if (id.outDir !== expected?.outDir) drift.push("outDir");
  if (id.baselineContentDigest !== expected?.baselineContentDigest) drift.push("baselineContentDigest");
  return drift;
}

/**
 * B2-1 — ensure the current review generation has exactly one governed
 * review job. Idempotent; never replaces a conflicting job.
 *
 * @param {object} opts.admission — frozen admission
 * @param {object} opts.binding — validated review_closeout binding
 * @param {string} opts.statePath — bootstrapped closeout-state path
 * @param {string} opts.repoRoot — git top-level of the authoritative worktree
 * @param {Function|null} [opts.git] — git runner (defaults to defaultGitRunner)
 * @returns {{ok:true, created:boolean, reused:boolean, job:object, path:string,
 *            root:string, outDir:string, ctx:object}
 *          | {ok:false, holdCode:string, reason:string}}
 */
export async function ensureCurrentReviewJob({ admission, binding, statePath, repoRoot, git = null } = {}) {
  const st = readCloseoutState(statePath);
  if (!st.ok) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_STATE_ABSENT,
      `REVIEW_JOB_STATE_ABSENT: bootstrapped closeout-state missing: ${st.errors.join(";")}`);
  }
  const state = st.state;

  const rootRes = resolveReviewJobRoot({ binding, repoRoot, state });
  if (!rootRes.ok) return rootRes;

  // Live candidate/spec from the authoritative context (never caller-fed).
  // cwd = repoRoot (git top-level of the authority worktree) so the spec
  // path and git commands resolve consistently with the binding (a raw
  // worktree path may differ only by symlink spelling).
  const gitFn = git ?? defaultGitRunner(repoRoot);
  const cwd = repoRoot;
  const specPath = resolve(repoRoot, binding.spec_path);
  let ctx;
  try {
    ctx = deriveReviewJobContext({
      git: gitFn,
      cwd,
      baseBranch: binding.base,
      specId: binding.spec_id,
      specPath,
      authority: { repository: binding.repository, spec_path: binding.spec_path },
    });
  } catch (e) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_CREATE_FAILED,
      `REVIEW_JOB_CREATE_FAILED: cannot derive review context: ${String(e?.code ?? e?.message ?? e).slice(0, 200)}`);
  }
  // B0 I7 / N7: the live spec digest MUST equal the frozen binding digest —
  // a spec change between admission and materialization is drift, not
  // something the runtime may silently re-bind.
  if (ctx.specIdentity.specDigest !== binding.spec_digest) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_SPEC_DRIFT,
      `REVIEW_JOB_SPEC_DRIFT: live spec digest ${ctx.specIdentity.specDigest.slice(0, 12)} != frozen binding.spec_digest ${binding.spec_digest.slice(0, 12)}`);
  }

  const expected = buildLifecycleIdentity({
    admission,
    binding,
    resolvedOutDir: rootRes.outDir,
    baselineContentDigest: state.baseline?.contentDigest ?? null,
  });

  const current = readReviewJob(binding.card_id, { root: rootRes.root });
  if (current.ok) {
    const job = current.job;
    // N9 — lineage/identity consistency.
    if (job.lineageId !== binding.card_id) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_BINDING_DRIFT,
        `REVIEW_JOB_BINDING_DRIFT: job lineageId ${job.lineageId} != binding.card_id ${binding.card_id}`);
    }
    if (job.jobId !== jobIdFor(binding.card_id, job.generation)) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_BINDING_DRIFT,
        `REVIEW_JOB_BINDING_DRIFT: jobId ${job.jobId} does not re-derive from lineage+generation`);
    }
    // N7 — spec identity consistency.
    if (job.specDigest !== binding.spec_digest) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_SPEC_DRIFT,
        `REVIEW_JOB_SPEC_DRIFT: job specDigest ${job.specDigest?.slice(0, 12)} != binding.spec_digest ${binding.spec_digest.slice(0, 12)}`);
    }
    // N4/N5/N6/N8 — lifecycle identity chain. A legacy job without the
    // governed block cannot satisfy a governed run.
    const drift = lifecycleIdentityDrift(job, expected);
    if (drift.length > 0) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_BINDING_DRIFT,
        `REVIEW_JOB_BINDING_DRIFT: job lifecycle identity drift [${drift.join(",")}]`);
    }
    // N11 — the job must still describe the live candidate.
    const cDrift = candidateDrift(job.candidateIdentity, ctx.candidateIdentity);
    const sDrift = specDrift(job.specDigest, ctx.specIdentity.specDigest);
    if (cDrift.length > 0 || sDrift) {
      return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_CANDIDATE_DRIFT,
        `REVIEW_JOB_CANDIDATE_DRIFT: ${cDrift.join(",")}${sDrift ? ",spec" : ""} changed since job creation`);
    }
    return {
      ok: true, created: false, reused: true, job, ctx,
      path: current.path, root: rootRes.root, outDir: rootRes.outDir,
    };
  }
  if (current.code !== "REVIEW_JOB_MISSING") {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_READ_FAILED,
      `REVIEW_JOB_READ_FAILED: ${current.code}`);
  }

  // Absent → create exactly one (exclusive-create enforces single-writer).
  const created = createReviewJob({
    cardId: binding.card_id,
    generation: 1,
    candidateIdentity: ctx.candidateIdentity,
    specId: ctx.specIdentity.specId,
    specDigest: ctx.specIdentity.specDigest,
    repoIdentity: binding.repository,
    worktreeIdentity: ctx.worktreeIdentity,
    lifecycleIdentity: expected,
  }, { root: rootRes.root });
  if (!created.ok) {
    return holdResult(REVIEW_LIFECYCLE_HOLDS.JOB_CREATE_FAILED,
      `REVIEW_JOB_CREATE_FAILED: ${created.code}`);
  }
  return {
    ok: true, created: true, reused: false, job: created.job, ctx,
    path: created.path, root: rootRes.root, outDir: rootRes.outDir,
  };
}

/**
 * B2-5 — Controller-ingest-side validation of a governed job's lifecycle
 * identity against the authority record + persisted closeout-state. The
 * ingest CLI has the record, not the admission object; the persisted state
 * block (admissionId + bindingDigest, bound at bootstrap) plus the
 * re-derivable authority digest form the cross-check chain. Returns
 * { ok, drift } — never trusts delivery.json claims or caller metadata.
 */
export function validateJobLifecycleIdentityForIngest({ job, record, state, repoRoot } = {}) {
  const drift = [];
  const id = job?.lifecycleIdentity ?? null;
  if (!id || typeof id !== "object" || Array.isArray(id)) {
    drift.push("lifecycleIdentity");
    return { ok: false, drift };
  }
  const expectedSource = authorityDigest(record);
  if (id.sourceAuthorityDigest !== expectedSource) drift.push("sourceAuthorityDigest");
  if (state?.reviewCloseout) {
    if (id.admissionId !== state.reviewCloseout.admissionId) drift.push("admissionId");
    if (id.bindingDigest !== state.reviewCloseout.bindingDigest) drift.push("bindingDigest");
  } else {
    drift.push("state.reviewCloseout");
  }
  if (state?.outDir && id.outDir !== state.outDir) drift.push("outDir");
  if (state?.baseline?.contentDigest && id.baselineContentDigest !== state.baseline.contentDigest) drift.push("baselineContentDigest");
  return { ok: drift.length === 0, drift };
}

// Re-exported for callers that need the requirement predicate without pulling
// the whole artifact gate.
export { reviewRequired, REVIEW_CLOSEOUT_SCHEMA };
