// test/v2/helpers/e3-lease-outage-fixtures.mjs
//
// E3 LEASE/OUTAGE SOAK — fixture-assembly helper (NEW file; E3-owned).
// Card: AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-IMPLEMENTATION-1 under the sealed
// admission AUTOLOOP-V1-STAGE-F-P5-SOAK-E3-ADMISSION-1-20260906T133000Z
// (frozen contracts: E3-SCENARIO-INVENTORY / E3-LEASE-SEMANTICS /
// E3-OUTAGE-SEMANTICS / E3-LEASE-OUTAGE-BOUNDARY / E3-DURABLE-AUTHORITY /
// E3-ORACLE-CONTRACT / E3-RECOVERY-RECONCILIATION / E3-TIME-AUTHORITY /
// E3-MUTATION-BUDGET / E3-EXECUTION-SURFACE / E3-CLOSURE-CONDITION).
//
// Authority boundaries (the sealed helper rule — fixture assembly ONLY,
// zero production semantics live here; mirrors e1-soak-fixtures.mjs and
// e2-reboot-fixtures.mjs, which are E1/E2-PROTECTED and never modified):
//   * Every production decision is CONSUMED, never re-implemented: the C2D
//     lease/permit machinery (acquireLease / releaseLease / validateLeaseOwner
//     / permitFromLease / assertWritePermit), the publication chain
//     (publishIntent / publishComplete / publishCurrent / readCurrent /
//     validateContinuity), the C3B mutation boundary (runMutation),
//     reconcileMutationIntent, and the transport adapter's frozen
//     TRANSPORT_FREEZE semantics are all re-exports of sealed src modules —
//     never redefinitions.
//   * LEASE IS OWNERSHIP, NOT TTL: every lease-remnant fixture is produced by
//     a REAL spawned holder process that dies by SIGKILL (the DE-2R injection
//     class; no cleanup path runs) or by an explicit secret-authorized
//     release through releaseLease. There is NO clock, NO sleep-based expiry,
//     NO fake time and NO TTL anywhere in this helper: lease validity is
//     (released_at == null) AND secret digests AND identity fields, read
//     fresh from disk by the production code itself (E3-TIME-AUTHORITY:
//     TIME_AUTHORITY = NONE).
//   * OUTAGE IS CONNECTIVITY LOSS, NOT AUTHORITY TRANSFER: class-6 profiles
//     are produced by (a) a transport/service refusal at the REAL production
//     adapter seam — createPiTransportAdapter with a scripted fetchImpl that
//     returns a real dependency refusal (HTTP 500-class), the same seam the
//     sealed transport tests use (test-pi-transport-adapter.mjs), with the
//     production TRANSPORT_FREEZE contract (maxRetries=0, maxRequests=1) left
//     UNMODIFIED and itself asserted — never by `throw new Error("outage")`
//     inside production-adjacent paths; (b) the sealed SIGKILL-during-
//     publication class for the torn-view/store face (the durable store IS
//     the dependency that becomes unverifiable).
//   * All fixture state lives in mkdtemp namespaces; fresh-process legs read
//     only durable bytes. Windows are proven by DURABLE MARKERS (journal
//     rows / CURRENT fields / ack files / lease bytes) — never by sleep.
//   * Zero production mutation. Zero VM lifecycle in ANY process (the only
//     runtime the C2D suites touch is git itself, via the sealed fixture
//     pattern).

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

// ── Sealed production primitives (re-exported verbatim; never re-implemented)
import { C2dHoldError, HOLD, setInjectionHook, clearInjectionHooks } from "../../../src/c2d/fs-atomic.mjs";
import {
  acquireLease, releaseLease, readLease, validateLeaseOwner, leasePath,
} from "../../../src/c2d/lease.mjs";
import { permitFromLease, assertWritePermit } from "../../../src/c2d/permit.mjs";
import {
  initExecutionDir, publishCurrent, readCurrent, createInitialSnapshot,
} from "../../../src/c2d/checkpoint-store.mjs";
import { publishIntent, publishComplete, validateContinuity } from "../../../src/c2d/journal.mjs";
import { runMutation } from "../../../src/c2d/mutation-run.mjs";
import { C3B_HOLD, createMutationAuthorization } from "../../../src/c2d/mutation-authority.mjs";
import { collectFingerprint } from "../../../src/c2d/fingerprint.mjs";
import {
  mintExecutionId, mintChainId, mintCheckpointId, mintSecret, secretDigest,
} from "../../../src/c2d/execution-id.mjs";
import {
  createPiTransportAdapter, TRANSPORT_FREEZE,
} from "../../../src/v2/pi-transport-adapter.mjs";
import { RunEvidenceStore, canonicalJson, sha256Text } from "../../../src/evidence/run-evidence-store.mjs";
import { reconcileMutationIntent } from "../../../src/c2d/reconcile.mjs";

export {
  C2dHoldError, HOLD, C3B_HOLD,
  acquireLease, releaseLease, readLease, validateLeaseOwner, leasePath,
  permitFromLease, assertWritePermit,
  initExecutionDir, publishCurrent, readCurrent, createInitialSnapshot,
  publishIntent, publishComplete, validateContinuity,
  runMutation, createMutationAuthorization, collectFingerprint,
  mintExecutionId, mintChainId, mintCheckpointId, mintSecret, secretDigest,
  createPiTransportAdapter, TRANSPORT_FREEZE,
  RunEvidenceStore, canonicalJson, sha256Text,
  setInjectionHook, clearInjectionHooks, reconcileMutationIntent,
  mkdtempSync, tmpdir, join, dirname, rmSync, writeFileSync, readFileSync,
  existsSync, mkdirSync,
};

// ═══════════════════════ Small shared helpers ═══════════════════════════════

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function fileDigest(path) {
  return sha256Hex(readFileSync(path));
}

/** git runner over a concrete repo dir; never throws. */
export function git(repo, args, opts = {}) {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Real temp git repo (clean, branch master, one initial commit). */
export function makeTempGitRepo(label) {
  const repo = mkdtempSync(join(tmpdir(), `e3-${label}-repo-`));
  git(repo, ["init", "-b", "master"]);
  git(repo, ["config", "user.email", "e3@fixture"]);
  git(repo, ["config", "user.name", "e3-fixture"]);
  writeFileSync(join(repo, "README.md"), "# e3 fixture\n");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

/** Fresh checkpoint root (mkdtemp) with an initialized execution dir. */
export function freshCheckpointRoot(label) {
  return mkdtempSync(join(tmpdir(), `e3-${label}-cp-`));
}

/**
 * Suite-end cleanup attestation: every tracked PID must be dead (zero
 * orphans) and every tracked path must be gone (zero tmp residue).
 * Mirrors the sealed E1/E2 cleanupAttestation shape.
 */
export function cleanupAttestation(pids, paths = []) {
  const alive = [];
  for (const pid of pids ?? []) {
    try { process.kill(pid, 0); alive.push(pid); } catch { /* dead — good */ }
  }
  const present = (paths ?? []).filter((p) => existsSync(p));
  return { alive, present, orphans: alive.length, residue: present.length };
}

// ═══════════════════════ Lease-store fixtures (class 5) ════════════════════

/**
 * A live, active, secret-proven mutation lease on a fixture store — the
 * authority-holder state every class-5 failure is measured against. The
 * holder "process" at this layer is the CALLING harness (the actor/session
 * secrets it holds); the SIGKILL-class scenarios replace it with a real
 * spawned holder process (spawnLeaseHolder) whose death orphans the record.
 */
export function makeLeaseFixture({ tag, holderId = null } = {}) {
  const repo = makeTempGitRepo(`lease-${tag}`);
  const root = freshCheckpointRoot(`lease-${tag}`);
  const execId = mintExecutionId();
  const execDir = initExecutionDir(root, execId);
  const actorId = holderId ?? `owner-${tag}`;
  const sessionId = `sess-${tag}`;
  const sessionSecret = `${tag}-session-secret`;
  const leaseSecret = `${tag}-lease-secret`;

  const fp = collectFingerprint(repo);
  const acquired = acquireLease(execDir, {
    execution_id: execId,
    chain_id: mintChainId(),
    checkpoint_id: mintCheckpointId(),
    repository_identity: fp.repository_root_identity,
    worktree_identity: fp.worktree_identity,
    actor_id: actorId,
    session_id: sessionId,
    session_secret: sessionSecret,
    lease_secret: leaseSecret,
    expected_head: fp.expected_head,
    mutation_capability: true,
  });
  const lease = acquired.lease;
  const secrets = acquired.secrets;

  // Durable snapshot through the REAL publication chain (the permit derives
  // from the active lease + secrets — the production path).
  const permit = permitFromLease(execDir, lease, secrets, true);
  const initial = createInitialSnapshot({
    checkpoint_id: lease.checkpoint_id,
    execution_id: execId,
    chain_id: lease.chain_id,
    repository_fingerprint: fp,
    repository_root_identity: fp.repository_root_identity,
    git_common_dir_identity: fp.git_common_dir_identity,
    expected_head: fp.expected_head,
    expected_ref: fp.expected_ref,
    origin_url: fp.origin_url,
    origin_master: fp.origin_master,
    expected_worktree_state: fp.expected_worktree_state,
    current_owner_actor: actorId,
    lease_identity: lease.lease_id,
    input_manifest: {},
  });
  publishCurrent(execDir, initial, { expectedRevision: 0, permit });

  return {
    tag, repo, root, checkpointRoot: root, execDir, executionId: execId,
    lease, secrets, actorId, sessionId, sessionSecret, leaseSecret, fp,
    frozenHead: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
    cleanup: baseCleanup([repo, root]),
  };
}

/**
 * Publish one INTENT-only transition (the open tail) through the REAL
 * journal chain with the holder's permit. sideEffectClass must be a class
 * the mutation reconciler owns ("mutation") — reconcileMutationIntent refuses
 * anything else by design (reconcile.mjs :176-178), which is exactly the
 * seam L2's recovery leg drives.
 */
export function publishOpenMutationTail(fixture, { revision, transitionId = null } = {}) {
  const { execDir, lease, secrets, executionId } = fixture;
  const permit = permitFromLease(execDir, lease, secrets, true);
  const intent = {
    format_version: "1.0.0",
    revision,
    transition_id: transitionId ?? `e3_tail_${revision}`,
    execution_id: executionId,
    checkpoint_id: lease.checkpoint_id,
    chain_id: lease.chain_id,
    record_kind: "intent",
    from_stage: "CHECKPOINT_CREATED",
    to_stage: "MUTATION",
    from_state: "CHECKPOINT_CREATED",
    to_state: "MUTATION_COMPLETE",
    actor_id: lease.actor_id,
    timestamp: new Date().toISOString(),
    side_effect_class: "mutation",
    expected_revision_before: revision - 1,
    evidence_refs: ["base.txt"],
    expected_evidence_manifest: null,
  };
  publishIntent(execDir, intent, permit);
  const cont = validateContinuity(execDir);
  if (cont.incompleteTail !== revision) {
    throw new Error(`open-tail fixture: incompleteTail ${cont.incompleteTail} != ${revision}`);
  }
  return intent;
}

/**
 * Complete the open tail the way the sealed reconcile path does — THROUGH
 * reconcileMutationIntent with the holder's secrets (never a fixture-side
 * COMPLETE write). `complete` and `snapshot` callbacks mirror the sealed
 * finishReconcileMutation wiring (mutation-run.mjs :583-608).
 */
export function reconcileTailWithSecrets(fixture, { revision, reRunGate = null } = {}) {
  const { execDir, lease, secrets, actorId } = fixture;
  return reconcileMutationIntentThroughProduction(execDir, {
    leaseId: lease.lease_id,
    actorId,
    leaseRevision: lease.lease_revision,
    secrets,
    revision,
    reRunGate: reRunGate ?? (() => ({ observed_at: new Date().toISOString(), classification: "RECOVERY_REQUIRED" })),
    buildCompleteRecord: ({ intent }) => ({
      format_version: "1.0.0",
      revision: intent.revision,
      transition_id: intent.transition_id,
      execution_id: intent.execution_id,
      checkpoint_id: intent.checkpoint_id,
      chain_id: intent.chain_id,
      record_kind: "verified_complete",
      from_stage: intent.from_stage,
      to_stage: intent.to_stage,
      from_state: intent.from_state,
      to_state: intent.to_state,
      actor_id: actorId,
      timestamp: new Date().toISOString(),
      side_effect_class: "mutation",
      expected_revision_before: intent.expected_revision_before,
      outcome_state: "RECOVERY_REQUIRED",
      lifecycle_transitions: [{ state: "RECOVERY_REQUIRED", at: new Date().toISOString() }],
      intent_digest: "",
    }),
    buildSnapshot: ({ previous, revision: rev, intent }) => ({
      ...previous,
      revision: rev,
      stage: "MUTATION",
      state: "RECOVERY_REQUIRED",
      c2d_control_state: "RECOVERY_REQUIRED",
      last_completed_transition: intent.transition_id,
      next_transition_candidate: { value: "NONE", advisory_only: true, not_authorization: true },
      current_owner_actor: actorId,
      lease_identity: lease.lease_id,
      updated_at: new Date().toISOString(),
    }),
  });
}

// reconcileMutationIntent (re-exported above) is the ONLY complete-tail
// writer: the harness never writes COMPLETE records itself.

/**
 * Issue the durable C3B mutation authorization artifact for a fixture store
 * through createMutationAuthorization (the ONLY lawful producer).
 */
export function issueMutationAuthorization(fixture, { allowedPaths = ["docs/**"], forbiddenPaths = ["src/**"] } = {}) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 3600_000).toISOString();
  const input = {
    execution_id: fixture.executionId,
    card_id: "E3-SOAK-AUTH",
    card_revision: "1",
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    validation_plan_id: "e3-soak-plan",
    authorized_by: "e3-fixture-authority",
    authorization_ref: `e3://${fixture.executionId}/auth`,
    expires_at: expires,
  };
  const r = createMutationAuthorization(fixture.execDir, input, fixture.fp);
  if (r.status !== "AUTHORIZED_CREATED" && r.status !== "AUTHORIZED_EXISTING_IDENTICAL") {
    throw new Error(`issueMutationAuthorization: unexpected status ${r.status}`);
  }
  return r.authorization;
}

// ═══════════════════════ SIGKILL lease-holder worker (class 5) ═════════════

const WORKER_HELPERS_DIR = join(tmpdir(), `e3-worker-helpers-${process.pid}`);

function holderBootstrapSrc() {
  return `
const { acquireLease, leasePath } = await import(process.env.E3_LEASE_URL);
const { publishCurrent, readCurrent, createInitialSnapshot } = await import(process.env.E3_C2DSTORE_URL);
const { publishIntent } = await import(process.env.E3_JOURNAL_URL);
const { permitFromLease } = await import(process.env.E3_PERMIT_URL);
const { collectFingerprint } = await import(process.env.E3_FINGERPRINT_URL);
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
function parentDir(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }
const execDir = arg("execDir"), ackPath = arg("ack"), mode = arg("mode");
const fp = collectFingerprint(arg("repo"));
const fields = JSON.parse(readFileSync(arg("fields"), "utf8"));
const acquired = acquireLease(execDir, {
  ...fields,
  repository_identity: fp.repository_root_identity,
  worktree_identity: fp.worktree_identity,
  expected_head: fp.expected_head,
  mutation_capability: true,
});
const lease = acquired.lease;
const secrets = acquired.secrets;
const permit = permitFromLease(execDir, lease, secrets, true);
const initial = createInitialSnapshot({
  checkpoint_id: lease.checkpoint_id,
  execution_id: lease.execution_id,
  chain_id: lease.chain_id,
  repository_fingerprint: fp,
  repository_root_identity: fp.repository_root_identity,
  git_common_dir_identity: fp.git_common_dir_identity,
  expected_head: fp.expected_head,
  expected_ref: fp.expected_ref,
  origin_url: fp.origin_url,
  origin_master: fp.origin_master,
  expected_worktree_state: fp.expected_worktree_state,
  current_owner_actor: lease.actor_id,
  lease_identity: lease.lease_id,
  input_manifest: {},
});
// The prior-snapshot guard (checkpoint-store :205-219) stores exactly ONE
// byte-shape per revision: the fixture already published revision 0, so the
// holder must NOT republish CURRENT (any second revision-0 shape — even
// fresh updated_at — makes the NEXT revision-0-keyed publish refuse with
// 'prior snapshot conflict'). The holder only JOURNALS the open INTENT tail
// under its valid lease; CURRENT stays the fixture's publication.
const markerBase = { lease_id: lease.lease_id, lease_revision: lease.lease_revision, pid: process.pid };
if (mode === "intent") {
  const intent = {
    format_version: "1.0.0",
    revision: 1,
    transition_id: "e3_holder_tail_1",
    execution_id: lease.execution_id,
    checkpoint_id: lease.checkpoint_id,
    chain_id: lease.chain_id,
    record_kind: "intent",
    from_stage: "CHECKPOINT_CREATED",
    to_stage: "MUTATION",
    from_state: "CHECKPOINT_CREATED",
    to_state: "MUTATION_COMPLETE",
    actor_id: lease.actor_id,
    timestamp: new Date().toISOString(),
    side_effect_class: "mutation",
    expected_revision_before: 0,
    evidence_refs: ["base.txt"],
    expected_evidence_manifest: null,
  };
  publishIntent(execDir, intent, permit);
}
// Durable marker for the parent: the holder identity (and, in the intent
// mode, the open tail) is NOW on disk. The ack lives OUTSIDE the store.
mkdirSync(parentDir(ackPath), { recursive: true });
writeFileSync(ackPath, JSON.stringify({ marker: mode === "intent" ? "INTENT_TAIL" : "LEASE_ACTIVE", ...markerBase }));
// Hold until SIGKILL arrives; no graceful shutdown, no flush, no cleanup.
await new Promise(() => {});
`;
}

/** Install + materialize the holder worker bootstrap (once per process). */
export function installWorkerHelpers() {
  mkdirSync(WORKER_HELPERS_DIR, { recursive: true });
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const holderPath = join(WORKER_HELPERS_DIR, "lease-holder.mjs");
  writeFileSync(holderPath, holderBootstrapSrc());
  const tornPath = join(WORKER_HELPERS_DIR, "torn-victim.mjs");
  writeFileSync(tornPath, tornVictimSrc());
  // E3 leg bootstrap: E3's corpus never drives the colima/VM runtime (zero
  // VM lifecycle in ANY process), but the C2D torn-window victim's only
  // runtime dependency is the C2D store itself. No VM redirect is needed:
  // the victim imports the c2d/* modules exclusively. (The E3 ENGINE_* env
  // keys below stay unset — the E2-owned shims are NOT loaded by E3 legs.)
  const env = {
    E3_REPO_ROOT: repoRoot,
    E3_LEASE_URL: `file://${repoRoot}src/c2d/lease.mjs`,
    E3_C2DSTORE_URL: `file://${repoRoot}src/c2d/checkpoint-store.mjs`,
    E3_JOURNAL_URL: `file://${repoRoot}src/c2d/journal.mjs`,
    E3_PERMIT_URL: `file://${repoRoot}src/c2d/permit.mjs`,
    E3_FINGERPRINT_URL: `file://${repoRoot}src/c2d/fingerprint.mjs`,
    E3_FSATOMIC_URL: `file://${repoRoot}src/c2d/fs-atomic.mjs`,
    E3_HOLDER_PATH: `file://${holderPath}`,
    E3_TORN_PATH: `file://${tornPath}`,
  };
  return { holderPath, tornPath, env, dir: WORKER_HELPERS_DIR };
}

/**
 * Spawn a REAL lease-holder process: it acquires the lease through the
 * production acquireLease, publishes the initial CURRENT through the
 * production chain, optionally journals the open INTENT tail, acks its
 * durable marker, and then WAITS TO BE SIGKILLED. The returned handle's
 * `secrets` are minted by the harness (supplied via fields) so the same
 * SESSION can later prove continuation — but the PROCESS that held them is
 * killed; only the digests survive on disk (the E3-SCENARIO-INVENTORY
 * authority model: "the killed writer process (actor/session secrets die
 * with it; only digests persist in lease.json)").
 */
export function spawnLeaseHolder({ execDir, repo, fields, mode = "lease", ackPath, helpers = null }) {
  const h = helpers ?? installWorkerHelpers();
  const fieldsPath = join(h.dir, `fields-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(fieldsPath, JSON.stringify(fields));
  const child = spawn(process.execPath, [h.holderPath,
    "--execDir", execDir, "--repo", repo, "--ack", ackPath, "--mode", mode, "--fields", fieldsPath,
  ], { env: { ...process.env, ...h.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", (c) => { stdout += c; });
  return { child, pid: child.pid, ackPath, fieldsPath, stderrText: () => stderr, stdoutText: () => stdout };
}

/** SIGKILL the victim. No TERM first, no graceful anything (DE-2R class). */
export function sigkill(victim) {
  try { process.kill(victim.pid, "SIGKILL"); } catch { /* already dead */ }
}

export async function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (e) => resolve({ code: -1, signal: null, error: String(e) }));
  });
}

/** Wait until the durable marker file appears (the ack IS the marker). */
export async function waitForMarker(ackPath, expect, timeoutMs = 20000, diag = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(ackPath)) {
      let ack = null;
      try { ack = JSON.parse(readFileSync(ackPath, "utf8")); } catch { /* torn write mid-marker; retry */ }
      if (ack && (!expect || ack.marker === expect)) return ack;
    }
    await new Promise((r) => setImmediate(r));
  }
  let detail = "";
  if (diag && typeof diag.stderrText === "function") {
    detail = ` | holder stderr: ${diag.stderrText().slice(0, 400) || "(none)"}`;
  }
  throw new Error(`E3: holder marker ${expect ?? "any"} not observed at ${ackPath} (timeout)${detail}`);
}

// ═══════════════════════ Outage faces (class 6) ════════════════════════════

/**
 * THE production transport adapter with a scripted fetchImpl returning a
 * REAL dependency refusal (HTTP 500-class response from the provider host).
 * This is the exact seam the sealed transport tests exercise
 * (test/v2/test-pi-transport-adapter.mjs + helpers/scripted-fetch.mjs); the
 * adapter's own TRANSPORT_FREEZE contract (maxRetries=0, maxRequests=1, no
 * repair/retry/resample/fallback) runs UNMODIFIED and is itself the oracle
 * surface. NEVER a synthetic throw inside production-adjacent paths.
 * allowMissingKey: the test-only bypass the adapter itself defines and
 * documents for scripted-fetch consumers; no ambient credential is touched.
 */
export function makeOutageTransportAdapter({ onCapture = null, onRequest = null } = {}) {
  let refusedResponses = 0;
  const fetchImpl = (input, init) => {
    onRequest?.(String(typeof input === "string" ? input : input?.url ?? input));
    refusedResponses += 1;
    return Promise.resolve(new Response(
      JSON.stringify({ error: { message: "upstream provider unavailable (scripted outage seam)" } }),
      { status: 500, headers: { "content-type": "application/json" } },
    ));
  };
  const adapter = createPiTransportAdapter({ fetchImpl, allowMissingKey: true, onEvent: (ev) => { if (ev?.kind === "request") onRequest?.(ev?.url?.raw ?? ev?.url); } });
  void onCapture;
  return { adapter, refusals: () => refusedResponses };
}

/**
 * The SAME adapter against a healthy scripted provider (the O-NEG control
 * seam): one strict-JSON completion, one request.
 */
export function makeHealthyTransportAdapter({ payload } = {}) {
  const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const DONE = "data: [DONE]\n\n";
  const chunks = [
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: JSON.stringify(payload ?? { ok: true, verdict: "DECOMPOSED" }) }, finish_reason: null }] }),
    sse({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } }),
    sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    DONE,
  ];
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream({ start(c) { while (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); c.close(); } });
  let requests = 0;
  const fetchImpl = () => { requests += 1; return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })); };
  const adapter = createPiTransportAdapter({ fetchImpl, allowMissingKey: true });
  return { adapter, requests: () => requests };
}

// ═══════════════════════ Torn-window victim (store face) ═══════════════════

/**
 * Spawn the torn-publication victim: a REAL holder process that acquires the
 * lease, publishes CURRENT, journals a closed transition, and then republishes
 * CURRENT through the production chain — with the sealed injection-hook seam
 * (before_checksum_rename) armed INSIDE the victim so the parent can observe
 * the REAL torn window (CURRENT replaced, sidecar not yet renamed) from its
 * durable marker and SIGKILL the writer inside it. The kill IS the injection;
 * no synthetic torn file is ever constructed (E2 R5 class, admission-frozen).
 * E3-REPAIR-1: the armed seam is `before_checksum_rename` (fired at
 * checkpoint-store :240 — AFTER the new CURRENT bytes are atomically in place
 * and BEFORE the sidecar write), which is the only hook position whose abort
 * leaves the true torn byte state (CURRENT = new publication, sidecar =
 * old/not-yet-rewritten). The previous E3 build armed `before_current_rename`
 * (:236, pre-CURRENT-rename) — a PRE-RENAME seam whose abort is a clean
 * publication abort (review-proven: torn=false there, unreachable torn state).
 * The TORN_WINDOW ack now also carries the byte proof captured INSIDE the
 * hook (sidecar-vs-CURRENT digests), so torn=true is OBSERVED FROM BYTES,
 * never inferred from the hook name.
 */
function tornVictimSrc() {
  return `
const fsatomic = await import(process.env.E3_FSATOMIC_URL);
const { setInjectionHook } = fsatomic;
const { acquireLease, readLease } = await import(process.env.E3_LEASE_URL);
const { publishCurrent, readCurrent, createInitialSnapshot } = await import(process.env.E3_C2DSTORE_URL);
const { publishIntent, publishComplete } = await import(process.env.E3_JOURNAL_URL);
const { permitFromLease } = await import(process.env.E3_PERMIT_URL);
const { collectFingerprint } = await import(process.env.E3_FINGERPRINT_URL);
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
function parentDir(p) { const i = p.lastIndexOf("/"); return i > 0 ? p.slice(0, i) : "."; }
function sha256HexBuf(b) { return createHash("sha256").update(b).digest("hex"); }
const execDir = arg("execDir"), ackPath = arg("ack"), repo = arg("repo");
const fp = collectFingerprint(repo);
const fields = JSON.parse(readFileSync(arg("fields"), "utf8"));
const acquired = acquireLease(execDir, {
  ...fields,
  repository_identity: fp.repository_root_identity,
  worktree_identity: fp.worktree_identity,
  expected_head: fp.expected_head,
  mutation_capability: true,
});
const lease = acquired.lease;
const secrets = acquired.secrets;
const permit = permitFromLease(execDir, lease, secrets, true);
// The harness fixture already published revision 0; the victim CONTINUES the
// lease (same secret proof) and performs exactly ONE further publication of
// revision 0 with fresh bookkeeping bytes — the publication whose torn window
// (between the CURRENT rename and the sidecar rename) the parent kills. (A
// second same-revision republish would trip the prior-snapshot guard; the
// torn window needs exactly this one real publication.)
const marker = { marker: "TORN_ARMED", pid: process.pid };
// Arm the REAL publication-window hook INSIDE this victim — at the TRUE torn
// byte seam: before_checksum_rename fires AFTER the new CURRENT bytes are
// already renamed into place and BEFORE the sidecar is rewritten, so any
// abort here leaves CURRENT = new publication with the sidecar still naming
// the OLD bytes (the exact sealed E2 R5 torn state). The ack written inside
// the hook is a BYTE PROOF read from the store itself: CURRENT's actual
// digest vs the sidecar's expected digest (mismatch = torn, observed from
// bytes, not inferred from the hook name). The injected throw only aborts
// publication if the parent is slow — the kill wins the race by design
// (E2 R5 class); the hook is also one-shot so the parent's own slower
// publication attempts cannot re-enter it.
setInjectionHook("before_checksum_rename", () => {
  fsatomic.setInjectionHook("before_checksum_rename", null);
  try {
    const curBytes = readFileSync(execDir + "/CURRENT.json");
    let sideExpected = null, sidePresent = false;
    try { sideExpected = readFileSync(execDir + "/CURRENT.json.sha256", "utf8").trim(); sidePresent = true; } catch {}
    const proof = {
      current_bytes_digest: sha256HexBuf(curBytes),
      sidecar_present: sidePresent,
      sidecar_expected_digest: sideExpected,
      torn: !sidePresent || sideExpected !== sha256HexBuf(curBytes),
    };
    if (!proof.torn) throw new Error("E3_TORN_PROOF_NOT_TORN_AT_SEAM");
    try { mkdirSync(parentDir(ackPath), { recursive: true }); writeFileSync(ackPath, JSON.stringify({ ...marker, marker: "TORN_WINDOW", torn_proof: proof })); } catch {}
  } catch (e) {
    if (e && String(e.message).startsWith("E3_TORN_PROOF")) throw e;
  }
  throw new Error("E3_TORN_MARKER_STOP");
});
const current0 = readCurrent(execDir);
const next = { ...current0.snapshot, updated_at: new Date().toISOString() };
mkdirSync(parentDir(ackPath), { recursive: true });
writeFileSync(ackPath, JSON.stringify(marker));
publishCurrent(execDir, next, { expectedRevision: current0.snapshot.revision, permit });
// If the parent has not killed us yet, hold.
await new Promise(() => {});
`;
}

/** Spawn the torn-window victim (mode: real publication chain + hook). */
export function spawnTornPublicationVictim({ execDir, repo, fields, ackPath, helpers = null }) {
  const h = helpers ?? installWorkerHelpers();
  const victimPath = h.tornPath;
  const fieldsPath = join(h.dir, `fields-torn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(fieldsPath, JSON.stringify(fields));
  const child = spawn(process.execPath, [victimPath,
    "--execDir", execDir, "--repo", repo, "--ack", ackPath, "--fields", fieldsPath,
  ], { env: { ...process.env, ...h.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (c) => { stderr += c; });
  child.stdout.on("data", (c) => { stdout += c; });
  return { child, pid: child.pid, ackPath, fieldsPath, stderrText: () => stderr, stdoutText: () => stdout };
}

/** The torn-window state read from durable bytes (CURRENT + sidecar). */
export function tornWindowState(execDir) {
  const cur = join(execDir, "CURRENT.json");
  const side = join(execDir, "CURRENT.json.sha256");
  if (!existsSync(cur)) return { cur: false };
  const bytes = readFileSync(cur);
  if (!existsSync(side)) return { cur: true, sidecar: false, torn: true };
  const expected = readFileSync(side, "utf8").trim();
  const actual = sha256Hex(bytes);
  return { cur: true, sidecar: true, torn: expected !== actual, expected, actual };
}

// ═══════════════════════ Fresh-process legs ════════════════════════════════

const WORKER_LEGS = [];

/**
 * Fresh-process leg: a brand-new node process that imports the production
 * modules and derives EVERYTHING from execDir bytes (sealed crossproc
 * protocol: KEY:json stdout lines). Modes:
 *   acquire-second-actor — a second actor with its own secrets attempts
 *     acquireLease on the SAME store (class-5 takeover attempt).
 *   release-public        — a caller knowing only the PUBLIC record
 *     (lease_id + revision) attempts releaseLease without secrets.
 *   continue-owner        — the same (actor_id, session_id) re-proofs WITH
 *     the original secrets (continuation arm).
 *   release-owner         — the holder releases via releaseLease WITH secrets
 *     (terminal L-NEG lifecycle arm).
 *   run-mutation          — full runMutation entry (L2/O3 recovery legs).
 *   mutation-reconcile    — reconcileMutationIntent with supplied secrets.
 *   validate-owner        — validateLeaseOwner with supplied secrets/revision.
 *   transport-outage      — ONE generate() against the production transport
 *     adapter with the scripted dependency refusal (O1).
 *   transport-healthy     — ONE generate() against the healthy scripted
 *     provider (O-NEG control arm).
 *   read-current          — production readCurrent adopt/refuse oracle (O2).
 *   transport-freeze-probe— reads TRANSPORT_FREEZE + request ledger facts
 *     from a refused adapter (O1 no-fallback oracle).
 */
export async function freshLeg({ mode, legArgs = {}, legKey = null } = {}) {
  const src = LEG_SRC();
  const legPath = join(tmpdir(), `e3-fresh-leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  writeFileSync(legPath, src);
  const repoRoot = new URL("../../../", import.meta.url).pathname;
  const args = [legPath, "--mode", mode, "--repoRoot", repoRoot];
  for (const [k, v] of Object.entries(legArgs)) {
    args.push(`--${k}`, typeof v === "string" ? v : JSON.stringify(v));
  }
  const child = spawn(process.execPath, args, {
    env: { ...process.env, E3_REPO_ROOT: repoRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  WORKER_LEGS.push({ path: legPath, pid: child.pid });
  const exit = await new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (e) => resolve({ code: -1, signal: null, error: String(e) }));
  });
  const leg = {
    pid: child.pid, exit, stdout, stderr,
    value: (key) => {
      const prefix = `${key}:`;
      for (const line of String(stdout).split("\n")) {
        if (line.startsWith(prefix)) {
          try { return JSON.parse(line.slice(prefix.length)); } catch { return null; }
        }
      }
      return null;
    },
  };
  if (legKey) leg.key = legKey;
  return leg;
}

// (freshLeg uses the `spawn` imported at the top of this module.)

function LEG_SRC() {
  return `
function arg(name) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : null; }
function jarg(name, dflt) { const v = arg(name); if (v == null) return dflt; try { return JSON.parse(v); } catch { return v; } }
const mode = arg("mode");
const REPO_ROOT = String(arg("repoRoot") ?? process.env.E3_REPO_ROOT ?? "").replace(/[\\\\/]$/, "");
const m = async (p) => import(REPO_ROOT + "/" + p);
const fsx = await import("node:fs");
const { acquireLease, releaseLease, readLease, validateLeaseOwner } = await m("src/c2d/lease.mjs");
const { permitFromLease } = await m("src/c2d/permit.mjs");
const { runMutation } = await m("src/c2d/mutation-run.mjs");
const { C3B_HOLD } = await m("src/c2d/mutation-authority.mjs");
const { reconcileMutationIntent } = await m("src/c2d/reconcile.mjs");
const { readCurrent } = await m("src/c2d/checkpoint-store.mjs");
const { createPiTransportAdapter, TRANSPORT_FREEZE } = await m("src/v2/pi-transport-adapter.mjs");

const out = { mode };
try {
  if (mode === "acquire-second-actor") {
    const fields = jarg("fields");
    try {
      const r = acquireLease(arg("execDir"), fields);
      out.acquired = { lease_id: r.lease?.lease_id ?? null, continued: r.continued ?? false };
    } catch (e) {
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200), details: e?.details ?? null };
    }
    const lease = readLease(arg("execDir"));
    out.leaseAfter = lease ? { lease_id: lease.lease_id, lease_revision: lease.lease_revision, actor_id: lease.actor_id, session_id: lease.session_id, released_at: lease.released_at } : null;
  } else if (mode === "release-public") {
    // PUBLIC-record-only release attempt: lease_id + revision are cleartext
    // in lease.json; the caller holds NO secrets (the L1/L3 negative arm).
    try {
      const r = await releaseLease(arg("execDir"), arg("leaseId"), Number(arg("leaseRevision")), null);
      out.released = r ? { released_at: r.released_at, lease_revision: r.lease_revision } : null;
    } catch (e) {
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
    }
    const lease = readLease(arg("execDir"));
    out.leaseAfter = lease ? { lease_id: lease.lease_id, lease_revision: lease.lease_revision, released_at: lease.released_at } : null;
  } else if (mode === "continue-owner" || mode === "release-owner") {
    const fields = jarg("fields");
    const secrets = jarg("secrets");
    try {
      if (mode === "continue-owner") {
        const r = acquireLease(arg("execDir"), fields);
        out.continued = { continued: r.continued === true, lease_id: r.lease?.lease_id ?? null, lease_revision: r.lease?.lease_revision ?? null };
      } else {
        const r = await releaseLease(arg("execDir"), arg("leaseId"), Number(arg("leaseRevision")), secrets);
        out.released = { released_at: r?.released_at ?? null, lease_revision: r?.lease_revision ?? null };
      }
    } catch (e) {
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
    }
  } else if (mode === "validate-owner") {
    try {
      const lease = validateLeaseOwner(arg("execDir"), arg("leaseId"), arg("actorId"), jarg("leaseRevision", null), jarg("secrets", null), true);
      out.validated = { lease_id: lease.lease_id, lease_revision: lease.lease_revision };
    } catch (e) {
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
    }
  } else if (mode === "run-mutation") {
    try {
      const r = await runMutation(jarg("args"));
      out.outcome = { outcome_state: r.outcome_state ?? null, mode: r.mode ?? null, lease_id: r.lease?.lease_id ?? null, released: r.released?.released_at ?? null };
    } catch (e) {
      out.hold = { code: e?.code ?? null, name: e?.name ?? null, message: String(e?.message ?? e).slice(0, 240) };
      out.isC3B = Object.values(C3B_HOLD).includes(e?.code);
    }
  } else if (mode === "mutation-reconcile") {
    const args = jarg("args");
    // reRunGate is a production-required callback: the reconciler re-derives
    // the current scope/validation state from it (never trusts stale
    // in-memory claims). The leg re-derives it from DURABLE bytes — the
    // gate's answer is a fresh observation timestamp + the durable
    // classification, exactly the sealed finishReconcileMutation wiring.
    args.reRunGate = () => ({ observed_at: new Date().toISOString(), classification: "RECOVERY_REQUIRED" });
    args.buildCompleteRecord = ({ intent }) => ({
      format_version: "1.0.0",
      revision: intent.revision,
      transition_id: intent.transition_id,
      execution_id: intent.execution_id,
      checkpoint_id: intent.checkpoint_id,
      chain_id: intent.chain_id,
      record_kind: "verified_complete",
      from_stage: intent.from_stage,
      to_stage: intent.to_stage,
      from_state: intent.from_state,
      to_state: intent.to_state,
      actor_id: args.actorId,
      timestamp: new Date().toISOString(),
      side_effect_class: "mutation",
      expected_revision_before: intent.expected_revision_before,
      outcome_state: "RECOVERY_REQUIRED",
      lifecycle_transitions: [{ state: "RECOVERY_REQUIRED", at: new Date().toISOString() }],
      intent_digest: "",
    });
    args.buildSnapshot = ({ previous, revision, intent }) => ({
      ...previous,
      revision,
      stage: "MUTATION",
      state: "RECOVERY_REQUIRED",
      c2d_control_state: "RECOVERY_REQUIRED",
      last_completed_transition: intent.transition_id,
      next_transition_candidate: { value: "NONE", advisory_only: true, not_authorization: true },
      current_owner_actor: args.actorId,
      lease_identity: args.leaseId,
      updated_at: new Date().toISOString(),
    });
    try {
      const r = reconcileMutationIntent(arg("execDir"), args);
      out.reconciled = { complete_digest: r.complete?.digest ?? null, snapshot_revision: r.snapshot?.snapshot?.revision ?? null };
    } catch (e) {
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 240) };
    }
  } else if (mode === "transport-truncated") {
    // P3 probe leg: the dependency DIES MID-STREAM — the SSE body aborts
    // after the first chunk (a real interrupted transport, no fabricated
    // completion). The intended assertion "interrupt is not success" DIES
    // if the adapter adopts the truncated answer as a completion.
    let httpResponses = 0;
    const fetchImpl = async () => {
      httpResponses += 1;
      const sse = (o) => \`data: \${JSON.stringify(o)}\\n\\n\`;
      const enc = new TextEncoder();
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] })));
          // Abort mid-stream: error() is a real transport break.
          c.error(new Error("E3 P3: dependency connection reset mid-stream"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const adapter = createPiTransportAdapter({ fetchImpl, allowMissingKey: true });
    const r = await adapter.generate({ systemPrompt: "e3 probe", input: "produce the frozen payload" });
    out.transport = {
      status: r.status ?? null,
      reason: r.reason ?? null,
      stopReason: r.stopReason ?? null,
      requestCount: r.requestCount ?? adapter.getRequestCount?.() ?? null,
      httpResponses,
      errorMessage: r.errorMessage ? String(r.errorMessage).slice(0, 160) : null,
      freeze: { maxRetries: TRANSPORT_FREEZE.maxRetries, maxRequests: TRANSPORT_FREEZE.maxRequests },
    };
  } else if (mode === "transport-outage" || mode === "transport-healthy") {
    // ONE generate() against the REAL adapter with a scripted fetchImpl:
    // refusal (500-class dependency refusal) or healthy strict-JSON payload.
    let httpResponses = 0;
    const fetchImpl = async () => {
      httpResponses += 1;
      if (mode === "transport-outage") {
        return new Response(JSON.stringify({ error: { message: "upstream provider unavailable (scripted outage seam)" } }), { status: 500, headers: { "content-type": "application/json" } });
      }
      const sse = (o) => \`data: \${JSON.stringify(o)}\\n\\n\`;
      const DONE = "data: [DONE]\\n\\n";
      const chunks = [
        sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: arg("payload") }, finish_reason: null }] }),
        sse({ id: "c", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1 } }),
        sse({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        DONE,
      ];
      const enc = new TextEncoder(); let i = 0;
      const body = new ReadableStream({ start(c) { while (i < chunks.length) c.enqueue(enc.encode(chunks[i++])); c.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const adapter = createPiTransportAdapter({ fetchImpl, allowMissingKey: true });
    const r = await adapter.generate({ systemPrompt: "e3 soak", input: "produce the frozen payload" });
    out.transport = {
      status: r.status ?? null,
      reason: r.reason ?? null,
      stopReason: r.stopReason ?? null,
      requestCount: r.requestCount ?? adapter.getRequestCount?.() ?? null,
      httpResponses,
      errorMessage: r.errorMessage ? String(r.errorMessage).slice(0, 160) : null,
      freeze: { maxRetries: TRANSPORT_FREEZE.maxRetries, maxRequests: TRANSPORT_FREEZE.maxRequests, allowedHost: TRANSPORT_FREEZE.allowedHost },
    };
    const lease = fsx.existsSync(arg("execDir") + "/lease.json") ? JSON.parse(fsx.readFileSync(arg("execDir") + "/lease.json", "utf8")) : null;
    out.leaseAfter = lease ? { lease_id: lease.lease_id, lease_revision: lease.lease_revision, released_at: lease.released_at, actor_id: lease.actor_id } : null;
  } else if (mode === "read-current") {
    try {
      const cur = readCurrent(arg("execDir"));
      out.adopted = true;
      out.revision = cur.snapshot.revision;
      out.digest = cur.digest;
    } catch (e) {
      out.adopted = false;
      out.hold = { code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) };
    }
  } else {
    out.error = "unknown mode " + String(mode);
  }
} catch (e) {
  out.fatal = { name: e?.name ?? null, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 240) };
}
process.stdout.write("LEG:" + JSON.stringify(out) + "\\n");
process.exit(0);
`;
}

/** Suite-end cleanup: remove leg scripts + worker helpers; return attestation. */
export function cleanupLegs() {
  const pids = WORKER_LEGS.map((l) => l.pid);
  const paths = WORKER_LEGS.map((l) => l.path);
  WORKER_LEGS.length = 0;
  for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* tmp */ } }
  return cleanupAttestation(pids);
}

function baseCleanup(paths) {
  return () => {
    for (const p of paths) {
      try { rmSync(p, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  };
}
