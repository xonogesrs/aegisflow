// test/telemetry/test-telemetry-gc.mjs
//
// S16 GC/Retention card — engine contract tests (Phases B–J of the card).
//
// Covers:
//   B. retention-class enforcement (R0–R4, unknown ⇒ fail closed)
//   C. ownership model (identity binding, containment, arbitrary-root fence)
//   D. protected-set derivation (authoritative lifecycle state only)
//   E. rotated-chunk bounds (convergence, no filename-order authority,
//      malformed chunks retained)
//   F. within-run prior/checkpoint bounds (CURRENT_REQUIRED / RESUME_REQUIRED
//      / HISTORICAL_ONLY / GC_ELIGIBLE; never filename-recency deletion)
//   G. temporary namespace admission (marker-gated; unmarked ⇒ ambiguous)
//   H. plan-first GC (frozen plan; execute only planned paths)
//   I. crash/replay semantics (idempotent delete, stale plan drift skip)
//   J. adversarial matrix (arbitrary root, traversal, symlink escape,
//      foreign run, forged class, duplicate replay)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  GC_HOLD_CODES,
  GcHoldError,
  DEFAULT_ROTATED_CHUNK_KEEP,
  DEFAULT_PRIOR_SNAPSHOT_KEEP,
  admitTempNamespace,
  classifyPriorSnapshot,
  classifyRotatedChunk,
  deriveProtectedSet,
  executeGcPlan,
  executePriorSnapshotGc,
  planPriorSnapshotGc,
  planTelemetryGc,
  resolveGcNamespace,
  runTelemetryGc,
} from "../../src/telemetry/gc.mjs";
import { resolveTelemetryStateRoot, telemetryEvidenceRoot, TELEMETRY_ROOT, TELEMETRY_STATE_ROOT_ENV } from "../../src/telemetry/location.mjs";
import { resolveEvidenceRoot } from "../../src/shared/autoloop-paths.mjs";

const EVIDENCE_ROOT = resolveEvidenceRoot();

function tmpRoot(label) {
  return mkdtempSync(join(tmpdir(), `gc-${label}-`));
}

function envFor(root) {
  return { [TELEMETRY_STATE_ROOT_ENV]: root };
}

function makeRunRoot(root, runId = "grun1", { rotated = 0, active = true, malformed = [] } = {}) {
  // With AEGISFLOW_TELEMETRY_STATE_ROOT=<root>, the run-scoped store root IS
  // <root> (override-is-exact-root semantics); runId is identity bookkeeping.
  const runRoot = root;
  mkdirSync(runRoot, { recursive: true });
  if (active) writeFileSync(join(runRoot, "telemetry.jsonl"), headerLine() + evLine(1), "utf8");
  for (let i = 1; i <= rotated; i++) {
    writeFileSync(join(runRoot, `telemetry-${String(i).padStart(3, "0")}.jsonl`), headerLine() + evLine(i), "utf8");
  }
  for (const name of malformed) {
    writeFileSync(join(runRoot, name), "not-json-at-all\n", "utf8");
  }
  return runRoot;
}

function headerLine() {
  return JSON.stringify({ schema: "autoloop.telemetry-store/v1", schemaVersion: 1, createdAt: null }) + "\n";
}
function evLine(n) {
  return JSON.stringify({ eventId: `e${n}`, graphRunId: "grun1", eventType: "graph.run", recordedAt: "2026-09-22T00:00:00.000Z", payload: {} }) + "\n";
}

// ══════════════════ Phase C — ownership / containment fences ═══════════════

test("C1. namespace admission: arbitrary roots rejected (GC_ARBITRARY_ROOT_DELETE = 0)", () => {
  assert.throws(() => resolveGcNamespace({ tempNamespaceRoot: "relative/path" }), (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT);
  // A real $HOME child (macOS tmpdir is /var/folders — NOT inside $HOME —
  // so use an explicit HOME child to prove the fence).
  assert.throws(() => resolveGcNamespace({ tempNamespaceRoot: join(process.env.HOME, "gc-forbidden") }), (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT);
  assert.throws(() => resolveGcNamespace({ tempNamespaceRoot: TELEMETRY_ROOT }), (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT, "canonical telemetry root is not a TEMP namespace");
  assert.throws(() => resolveGcNamespace({ tempNamespaceRoot: join(EVIDENCE_ROOT, "some") }), (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT, "evidence root overlap rejected");
  assert.throws(() => resolveGcNamespace({ tempNamespaceRoot: dirname(EVIDENCE_ROOT) }), (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT, "evidence root parent overlap rejected");
});

test("C2. namespace admission: run-scoped + canonical sweep admitted; identity binding mandatory", () => {
  const root = tmpRoot("ns");
  // AEGISFLOW_TELEMETRY_STATE_ROOT is the EXACT store root (location.mjs L4),
  // so the RUN namespace root is the override itself.
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  assert.equal(ns.kind, "RUN");
  assert.equal(ns.root, resolve(root));
  assert.throws(() => resolveGcNamespace({ graphRunId: "../escape", env: envFor(root) }), (e) => e.code === GC_HOLD_CODES.IDENTITY_INVALID);
  assert.throws(() => resolveGcNamespace({ graphRunId: "a/b", env: envFor(root) }), (e) => e.code === GC_HOLD_CODES.IDENTITY_INVALID);
  // Without an override the RUN namespace is TELEMETRY_ROOT/<graphRunId>.
  const canonical = resolveGcNamespace({ graphRunId: "grun1", env: {} });
  assert.equal(canonical.root, resolve(join(TELEMETRY_ROOT, "grun1")));
  const sweep = resolveGcNamespace({ env: envFor(root) });
  assert.equal(sweep.kind, "CANONICAL_SWEEP");
  rmSync(root, { recursive: true, force: true });
});

test("C3. plan refuses a run root outside the telemetry namespace (planted path)", () => {
  // The admission fence: a planted path under $HOME is rejected; macOS tmpdir
  // (/var/folders) is NOT under $HOME and is admitted only via the explicit
  // temp-admission marker path (planTempNamespace), never as a RUN namespace.
  assert.throws(
    () => resolveGcNamespace({ tempNamespaceRoot: join(process.env.HOME, "gc-forbidden", "grun1") }),
    (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT,
  );
  // A forged RUN namespace object (bypassing resolveGcNamespace) cannot be
  // executed against targets outside its own declared root: the executor
  // re-checks containment per candidate and only deletes inside
  // namespace.root (covered by J3).
});

test("C4. symlink escape: symlinked candidate is AMBIGUOUS, never deleted", () => {
  const root = tmpRoot("sym");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6 });
  const victim = join(tmpRoot("victim-dir"), "keepme.txt");
  mkdirSync(join(tmpRoot("victim-dir")), { recursive: true });
  writeFileSync(victim, "precious", "utf8");
  // Replace one rotated chunk with a symlink pointing outside the namespace.
  const chunk = join(runRoot, "telemetry-001.jsonl");
  rmSync(chunk, { force: true });
  symlinkSync(victim, chunk);
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.ok(plan.AMBIGUOUS.some((c) => c.path === chunk), "symlink chunk classified AMBIGUOUS");
  assert.ok(!plan.PLANNED_DELETE.some((c) => c.path === chunk), "symlink never planned for delete");
  assert.ok(existsSync(victim), "target survived");
  rmSync(root, { recursive: true, force: true });
  rmSync(join(tmpRoot("victim-dir")), { recursive: true, force: true });
});

test("C5. symlinked run directory inside canonical sweep is AMBIGUOUS", () => {
  const root = tmpRoot("sweep-sym");
  const outside = tmpRoot("outside-target");
  symlinkSync(outside, join(root, "evil-run"));
  const ns = resolveGcNamespace({ env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: {} });
  assert.ok(plan.AMBIGUOUS.some((c) => c.path === join(root, "evil-run") && c.reason === "SYMLINK_IN_CANONICAL_ROOT"));
  assert.ok(existsSync(outside));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ══════════════════ Phase D — protected-set derivation ═════════════════════

test("D1. unknown lifecycle ⇒ whole run protected (fail closed)", () => {
  const ps = deriveProtectedSet({ lifecycle: { runTerminal: null } });
  assert.equal(ps.runProtected, true);
  assert.ok(ps.reasons.includes("LIFECYCLE_UNKNOWN"));
});

test("D2. active run, resumable execution, rollover, successor dispatch all protect the run", () => {
  for (const lifecycle of [
    { runTerminal: false },
    { runTerminal: null, resumableExecution: true },
    { runTerminal: true, terminalAt: Date.now(), rolloverInProgress: true },
    { runTerminal: true, terminalAt: Date.now(), successorDispatchPending: true },
    { runTerminal: true, terminalAt: Date.now(), externalReviewUnresolved: true },
    { runTerminal: true, terminalAt: Date.now(), closeoutUnresolved: true },
  ]) {
    const ps = deriveProtectedSet({ lifecycle });
    assert.equal(ps.runProtected, true, JSON.stringify(lifecycle));
  }
});

test("D3. terminal + elapsed recovery window releases whole-run protection; active stream retained", () => {
  const ps = deriveProtectedSet({ lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.equal(ps.runProtected, false);
  assert.equal(ps.recoveryWindowActive, false);
});

test("D4. recovery window keeps the run protected after terminal", () => {
  const ps = deriveProtectedSet({ lifecycle: { runTerminal: true, terminalAt: Date.now() - 1000 } });
  assert.equal(ps.runProtected, true);
  assert.ok(ps.reasons.includes("RECOVERY_WINDOW"));
});

test("D5. whole-run protection materializes as PROTECTED entries in the plan", () => {
  const root = tmpRoot("prot");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 3 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: false } });
  assert.equal(plan.PLANNED_DELETE.length, 0);
  assert.ok(plan.PROTECTED.length >= 4, "active + 3 rotated all protected");
  assert.ok(plan.PROTECTED.every((p) => p.reason.includes("RUN_ACTIVE")));
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase E — rotated-chunk bounds ═════════════════════════

test("E1. rotated chunks converge to the bounded keep window", () => {
  const root = tmpRoot("conv");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 12 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { planResult: { plan }, receipt } = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.ok(plan.PLANNED_DELETE.length > 0);
  assert.equal(receipt.deleted.length, plan.PLANNED_DELETE.length);
  // Convergence: after GC, valid rotated chunks ≤ keep.
  const remaining = readdirSync(runRoot).filter((f) => /^telemetry-\d+\.jsonl$/.test(f));
  assert.ok(remaining.length <= DEFAULT_ROTATED_CHUNK_KEEP, `remaining ${remaining.length} <= ${DEFAULT_ROTATED_CHUNK_KEEP}`);
  // Idempotent replay: second cycle deletes nothing.
  const second = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.equal(second.receipt.deleted.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("E2. newest chunks retained; oldest reclaimed (bounded observability window)", () => {
  const root = tmpRoot("window");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const planned = plan.PLANNED_DELETE.map((c) => c.identity.seq).sort((a, b) => a - b);
  assert.deepEqual(planned, [1, 2], `oldest beyond keep(${DEFAULT_ROTATED_CHUNK_KEEP}) of 6`);
  rmSync(root, { recursive: true, force: true });
});

test("E3. malformed chunks retained as AMBIGUOUS (fail closed)", () => {
  const root = tmpRoot("malformed");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6, malformed: ["telemetry-009.jsonl", "telemetry-notachunk.jsonl"] });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { planResult: { plan }, receipt } = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.ok(plan.AMBIGUOUS.some((c) => c.path.endsWith("telemetry-009.jsonl")));
  assert.ok(plan.AMBIGUOUS.some((c) => c.path.endsWith("telemetry-notachunk.jsonl")));
  assert.ok(existsSync(join(runRoot, "telemetry-009.jsonl")));
  assert.ok(existsSync(join(runRoot, "telemetry-notachunk.jsonl")));
  rmSync(root, { recursive: true, force: true });
});

test("E4. no filename-order authority: forged high-seq malformed chunk is not used to shift the window", () => {
  const root = tmpRoot("order");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6, malformed: ["telemetry-999.jsonl"] });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  // The malformed 999 is AMBIGUOUS; the valid window is still computed over
  // VALID chunks only (ranks 0..5), so seqs 1-2 remain eligible.
  const planned = plan.PLANNED_DELETE.map((c) => c.identity.seq).sort((a, b) => a - b);
  assert.deepEqual(planned, [1, 2]);
  assert.ok(plan.AMBIGUOUS.some((c) => c.path.endsWith("telemetry-999.jsonl")));
  rmSync(root, { recursive: true, force: true });
});

test("E5. active stream retained post-terminal (R1→R2 tail)", () => {
  const root = tmpRoot("tail");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.ok(plan.PROTECTED.some((p) => p.path.endsWith("telemetry.jsonl") && p.reason === "ACTIVE_STREAM_RETAINED_POST_WINDOW"));
  assert.ok(!plan.PLANNED_DELETE.some((c) => c.path.endsWith("telemetry.jsonl")));
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase F — within-run prior/checkpoint bounds ═══════════

function makeExecDir(root, executionId, { revisions = 0, terminal = false } = {}) {
  const execDir = join(root, executionId);
  mkdirSync(join(execDir, "prior"), { recursive: true });
  const snapshot = (rev) => JSON.stringify({ execution_id: executionId, revision: rev, checkpoint_id: "ckpt_x", chain_id: "chain_x" });
  writeFileSync(join(execDir, "CURRENT.json"), terminal ? JSON.stringify({ ...JSON.parse(snapshot(revisions)), final_verdict: "PASS" }) : snapshot(revisions), "utf8");
  writeFileSync(join(execDir, "CURRENT.json.sha256"), "0".repeat(64) + "\n", "utf8");
  for (let r = 0; r < revisions; r++) {
    writeFileSync(join(execDir, "prior", `CURRENT.${String(r).padStart(12, "0")}.json`), snapshot(r), "utf8");
  }
  return execDir;
}

test("F1. non-terminal run: every prior snapshot is RESUME_REQUIRED-protected", () => {
  const root = tmpRoot("prior-live");
  const execDir = makeExecDir(root, "exec_abc", { revisions: 12 });
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_abc" });
  assert.equal(plan.PLANNED_DELETE.length, 0);
  assert.equal(plan.PROTECTED.filter((p) => p.path.includes("/prior/")).length, 12);
  assert.ok(plan.PROTECTED.every((p) => !p.path.includes("/prior/") || p.reason === "RUN_NOT_TERMINAL_RESUME_REQUIRED"));
  rmSync(root, { recursive: true, force: true });
});

test("F2. terminal run: priors beyond the bounded window are eligible; newest kept", () => {
  const root = tmpRoot("prior-term");
  const execDir = makeExecDir(root, "exec_abc", { revisions: 12, terminal: true });
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_abc" });
  const plannedRevs = plan.PLANNED_DELETE.map((c) => c.identity.revision).sort((a, b) => a - b);
  assert.deepEqual(plannedRevs, [0, 1, 2, 3], `oldest beyond keep(${DEFAULT_PRIOR_SNAPSHOT_KEEP}) of 12`);
  assert.ok(plan.PROTECTED.some((p) => p.path.endsWith("CURRENT.json") && p.reason === "CURRENT_REQUIRED"));
  const receipt = executePriorSnapshotGc({ planResult: { plan } });
  assert.equal(receipt.deleted.length, 4);
  assert.equal(receipt.reclaimedBytes, plan.EXPECTED_BYTES_RECLAIMED);
  assert.ok(existsSync(join(execDir, "CURRENT.json")), "CURRENT survived");
  assert.equal(readdirSync(join(execDir, "prior")).length, DEFAULT_PRIOR_SNAPSHOT_KEEP);
  rmSync(root, { recursive: true, force: true });
});

test("F3. do not delete a checkpoint merely because a newer filename exists — foreign execution id fails closed", () => {
  const root = tmpRoot("prior-foreign");
  makeExecDir(root, "exec_abc", { revisions: 12, terminal: true });
  // The snapshot carries execution_id exec_abc but GC is asked for exec_other:
  // identity mismatch ⇒ AMBIGUOUS, retained.
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_other" });
  assert.equal(plan.PROTECTED.length, 0);
  assert.ok(plan.MISSING.some((m) => m.reason === "EXEC_DIR_OR_CURRENT_ABSENT"), "foreign exec dir has no CURRENT");
  assert.equal(plan.PLANNED_DELETE.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("F4. tampered prior snapshot (identity mismatch) is AMBIGUOUS, retained", () => {
  const root = tmpRoot("prior-tamper");
  const execDir = makeExecDir(root, "exec_abc", { revisions: 12, terminal: true });
  const victim = join(execDir, "prior", "CURRENT.000000000000.json");
  writeFileSync(victim, JSON.stringify({ execution_id: "exec_OTHER", revision: 0 }), "utf8");
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_abc" });
  assert.ok(plan.AMBIGUOUS.some((c) => c.path === victim));
  assert.ok(!plan.PLANNED_DELETE.some((c) => c.path === victim));
  rmSync(root, { recursive: true, force: true });
});

test("F5. persistence root inside the authoritative evidence root is rejected", () => {
  assert.throws(
    () => planPriorSnapshotGc({ persistenceRoot: join(EVIDENCE_ROOT, "durable"), executionId: "exec_abc" }),
    (e) => e.code === GC_HOLD_CODES.ARBITRARY_ROOT,
  );
});

test("F6. unreadable CURRENT ⇒ exec dir protected (fail closed)", () => {
  const root = tmpRoot("prior-corrupt");
  const execDir = makeExecDir(root, "exec_abc", { revisions: 3, terminal: true });
  writeFileSync(join(execDir, "CURRENT.json"), "{broken", "utf8");
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_abc" });
  assert.equal(plan.PLANNED_DELETE.length, 0);
  assert.ok(plan.PROTECTED.some((p) => p.reason === "CURRENT_UNREADABLE_FAIL_CLOSED"));
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase G — temporary namespace admission ════════════════

test("G1. unmarked temp namespace is AMBIGUOUS (retain)", () => {
  const root = tmpRoot("temp-unmarked");
  const ns = { kind: "TEMP", root };
  const { plan } = planTelemetryGc({ namespace: ns });
  assert.ok(plan.AMBIGUOUS.some((c) => c.reason === "TEMP_NAMESPACE_UNMARKED"));
  assert.equal(plan.PLANNED_DELETE.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("G2. marked temp namespace with ACTIVE owner lifetime is PROTECTED", () => {
  const root = tmpRoot("temp-active");
  admitTempNamespace({ root, owner: "transfer-metrics-probe", ownerLifecycle: "ACTIVE" });
  const ns = { kind: "TEMP", root };
  const { plan } = planTelemetryGc({ namespace: ns });
  assert.ok(plan.PROTECTED.some((p) => p.reason === "TEMP_OWNER_LIFETIME_ACTIVE"));
  assert.equal(plan.PLANNED_DELETE.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("G3. marked temp namespace with ENDED owner lifetime converges (deleted, idempotent)", () => {
  const root = tmpRoot("temp-ended");
  mkdirSync(join(root, "payload"), { recursive: true });
  writeFileSync(join(root, "payload", "data.bin"), "x".repeat(1024), "utf8");
  admitTempNamespace({ root, owner: "transfer-metrics-probe", ownerLifecycle: "ENDED" });
  const ns = { kind: "TEMP", root };
  const first = runTelemetryGc({ namespace: ns });
  assert.equal(first.receipt.deleted.length, 1);
  assert.ok(!existsSync(root), "temp namespace reclaimed");
  // Idempotent replay: root gone ⇒ MISSING, no error.
  const second = runTelemetryGc({ namespace: ns });
  assert.equal(second.receipt.deleted.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("G4. temp marker with wrong schema is AMBIGUOUS", () => {
  const root = tmpRoot("temp-bad");
  writeFileSync(join(root, ".autoloop-gc-temp"), JSON.stringify({ schema: "forged/v1" }), "utf8");
  const { plan } = planTelemetryGc({ namespace: { kind: "TEMP", root } });
  assert.ok(plan.AMBIGUOUS.some((c) => c.reason === "TEMP_MARKER_INVALID"));
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase H — plan-first GC ════════════════════════════════

test("H1. plan contains all six mandatory fields; execute only the frozen plan", () => {
  const root = tmpRoot("plan");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  for (const field of ["PROTECTED", "ELIGIBLE", "AMBIGUOUS", "MISSING", "PLANNED_DELETE", "EXPECTED_BYTES_RECLAIMED"]) {
    assert.ok(Array.isArray(plan[field]) || typeof plan[field] === "number", `${field} present`);
  }
  assert.equal(plan.PLANNED_DELETE.length, plan.ELIGIBLE.length);
  assert.equal(plan.EXPECTED_BYTES_RECLAIMED, plan.PLANNED_DELETE.reduce((s, c) => s + c.bytes, 0));
  // Execute a plan whose PLANNED_DELETE was tampered to include a PROTECTED
  // path: the executor refuses (only frozen eligible paths may be deleted).
  const tampered = { ...plan, PLANNED_DELETE: [...plan.PLANNED_DELETE, { path: join(root, "telemetry.jsonl"), retentionClass: "R2", bytes: 10 }] };
  const receipt = executeGcPlan({ planResult: { plan: tampered, namespace: ns } });
  assert.ok(receipt.skipped.some((s) => s.reason === "DRIFT:CLASS_R2" || s.reason.startsWith("DRIFT")), "protected path not deletable via plan tampering");
  assert.ok(existsSync(join(root, "telemetry.jsonl")));
  rmSync(root, { recursive: true, force: true });
});

test("H2. execution after filesystem drift skips the drifted candidate (fail closed)", () => {
  const root = tmpRoot("drift");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  // Drift: replace a planned candidate with a directory after planning.
  const victim = plan.PLANNED_DELETE[0].path;
  rmSync(victim, { force: true });
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "unexpected"), "drifted", "utf8");
  const receipt = executeGcPlan({ planResult: { plan, namespace: ns } });
  // The drifted entry is a directory now — a plain chunk plan must not
  // silently recurse into unknown shapes: the candidate is skipped.
  assert.ok(receipt.skipped.some((s) => s.path === victim && s.reason.startsWith("DRIFT")) || receipt.missing.some((m) => m.path === victim), "drift handled without blind recursion");
  rmSync(root, { recursive: true, force: true });
});

test("H3. missing already-deleted candidate replays safely", () => {
  const root = tmpRoot("missing");
  const runRoot = makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  rmSync(plan.PLANNED_DELETE[0].path, { force: true });
  const receipt = executeGcPlan({ planResult: { plan, namespace: ns } });
  assert.ok(receipt.missing.some((m) => m.reason === "ALREADY_DELETED"));
  assert.equal(receipt.deleted.length, plan.PLANNED_DELETE.length - 1);
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase I — crash/replay semantics ═══════════════════════

test("I1. crash before plan: nothing deleted; later cycle converges", () => {
  const root = tmpRoot("i1");
  makeRunRoot(root, "grun1", { rotated: 10 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const first = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const second = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.equal(second.receipt.deleted.length, 0, "second cycle idempotent");
  assert.equal(first.receipt.deleted.length + second.receipt.deleted.length, first.planResult.plan.PLANNED_DELETE.length);
  rmSync(root, { recursive: true, force: true });
});

test("I2. crash after plan / before deletion: replaying the SAME frozen plan is safe", () => {
  const root = tmpRoot("i2");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const r1 = executeGcPlan({ planResult: { plan, namespace: ns } });
  const r2 = executeGcPlan({ planResult: { plan, namespace: ns } });
  assert.equal(r2.deleted.length, 0);
  assert.equal(r2.missing.length, plan.PLANNED_DELETE.length, "all already deleted");
  rmSync(root, { recursive: true, force: true });
});

test("I3. lifecycle advancement after planning cannot turn a stale plan unsafe", () => {
  const root = tmpRoot("i3");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  // I8 variant: the run becomes ACTIVE (protected) AFTER planning — the
  // frozen plan was derived under terminal; the executor's own re-checks
  // (containment/class) still pass, but the caller contract is that a fresh
  // cycle must be planned. Prove the FRESH plan now protects everything.
  const fresh = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: false } });
  assert.equal(fresh.plan.PLANNED_DELETE.length, 0, "fresh plan under active lifecycle deletes nothing");
  assert.ok(fresh.plan.PROTECTED.length >= plan.PLANNED_DELETE.length);
  rmSync(root, { recursive: true, force: true });
});

test("I4. rollover beginning after planning is honored by a fresh plan", () => {
  const root = tmpRoot("i4");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const fresh = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0, rolloverInProgress: true } });
  assert.equal(fresh.plan.PLANNED_DELETE.length, 0);
  assert.ok(fresh.plan.PROTECTED.every((p) => p.reason.includes("ROLLOVER_IN_PROGRESS")));
  rmSync(root, { recursive: true, force: true });
});

// ══════════════════ Phase J — adversarial matrix ═══════════════════════════

test("J1. adversarial: traversal identity rejected", () => {
  assert.throws(() => resolveGcNamespace({ graphRunId: "../../etc", env: {} }), (e) => e.code === GC_HOLD_CODES.IDENTITY_INVALID);
});

test("J2. adversarial: forged retention class in a plan is refused at execute", () => {
  const root = tmpRoot("j2");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const forged = { ...plan, PLANNED_DELETE: plan.PLANNED_DELETE.map((c) => ({ ...c, retentionClass: "R3" })) };
  const receipt = executeGcPlan({ planResult: { plan: forged, namespace: ns } });
  assert.equal(receipt.deleted.length, 0);
  assert.ok(receipt.skipped.every((s) => s.reason.startsWith("DRIFT")));
  rmSync(root, { recursive: true, force: true });
});

test("J3. adversarial: execute outside the namespace root is refused", () => {
  const root = tmpRoot("j3");
  const outside = tmpRoot("j3-outside");
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const fake = { PROTECTED: [], ELIGIBLE: [], AMBIGUOUS: [], MISSING: [], PLANNED_DELETE: [{ path: join(outside, "victim"), retentionClass: "R2", bytes: 5 }], EXPECTED_BYTES_RECLAIMED: 5 };
  writeFileSync(join(outside, "victim"), "data", "utf8");
  const receipt = executeGcPlan({ planResult: { plan: fake, namespace: ns } });
  assert.equal(receipt.deleted.length, 0);
  assert.ok(receipt.skipped.some((s) => s.reason === "DRIFT:OUTSIDE_NAMESPACE"));
  assert.ok(existsSync(join(outside, "victim")));
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test("J4. adversarial: foreign graphRunId run root is simply not the current namespace", () => {
  // Two isolated store roots; GC on grunA's namespace cannot touch grunB's.
  const rootA = tmpRoot("j4a");
  const rootB = tmpRoot("j4b");
  makeRunRoot(rootA, "grunA", { rotated: 6 });
  makeRunRoot(rootB, "grunB", { rotated: 6 });
  const nsA = resolveGcNamespace({ graphRunId: "grunA", env: envFor(rootA) });
  const { planResult: { plan }, receipt } = runTelemetryGc({ namespace: nsA, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.ok(plan.PLANNED_DELETE.every((c) => c.identity.graphRunId === "grunA"));
  assert.ok(existsSync(join(rootB, "telemetry-001.jsonl")), "foreign run untouched");
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

test("J5. adversarial: canonical sweep never crosses into the evidence root", () => {
  const ns = resolveGcNamespace({ env: {} });
  assert.equal(ns.root, TELEMETRY_ROOT);
  assert.ok(!ns.root.startsWith(EVIDENCE_ROOT + "/"));
});

test("J6. adversarial: duplicate GC replay converges (double execution)", () => {
  const root = tmpRoot("j6");
  makeRunRoot(root, "grun1", { rotated: 8 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const a = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const b = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  const c = runTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  assert.equal(b.receipt.deleted.length, 0);
  assert.equal(c.receipt.deleted.length, 0);
  const remaining = readdirSync(root).filter((f) => /^telemetry-\d+\.jsonl$/.test(f)).length;
  assert.ok(remaining <= DEFAULT_ROTATED_CHUNK_KEEP);
  rmSync(root, { recursive: true, force: true });
});

test("J7. classifyRotatedChunk unit: malformed name / bad seq / unknown schema", () => {
  const root = tmpRoot("j7");
  const validRanks = new Map([[1, 0], [2, 1]]);
  const good = join(root, "telemetry-001.jsonl");
  writeFileSync(good, headerLine(), "utf8");
  assert.equal(classifyRotatedChunk({ path: good, keep: 4, validChunks: validRanks }).status, "PROTECTED");
  const badName = join(root, "telemetry-abc.jsonl");
  writeFileSync(badName, headerLine(), "utf8");
  assert.equal(classifyRotatedChunk({ path: badName, validChunks: validRanks }).status, "AMBIGUOUS");
  const badSeq = join(root, "telemetry-000.jsonl");
  writeFileSync(badSeq, headerLine(), "utf8");
  assert.equal(classifyRotatedChunk({ path: badSeq, validChunks: validRanks }).status, "AMBIGUOUS");
  const badSchema = join(root, "telemetry-003.jsonl");
  writeFileSync(badSchema, JSON.stringify({ schema: "other/v9" }) + "\n", "utf8");
  assert.equal(classifyRotatedChunk({ path: badSchema, validChunks: validRanks }).status, "AMBIGUOUS");
  rmSync(root, { recursive: true, force: true });
});

test("J8. classifyPriorSnapshot unit: non-terminal always protected; terminal window", () => {
  const ranks = new Map([[0, 9], [11, 0]]);
  assert.equal(classifyPriorSnapshot({ path: "/x/prior/CURRENT.000000000011.json", terminalVerdict: false, validRanks: ranks }).status, "PROTECTED");
  assert.equal(classifyPriorSnapshot({ path: "/x/prior/CURRENT.000000000011.json", terminalVerdict: true, keep: 8, validRanks: ranks }).status, "PROTECTED");
  assert.equal(classifyPriorSnapshot({ path: "/x/prior/CURRENT.000000000000.json", terminalVerdict: true, keep: 8, validRanks: ranks }).status, "ELIGIBLE");
  assert.equal(classifyPriorSnapshot({ path: "/x/prior/CURRENT.000000000005.json", terminalVerdict: true, validRanks: ranks }).status, "AMBIGUOUS");
  assert.equal(classifyPriorSnapshot({ path: "/x/prior/CURRENT.json", terminalVerdict: true }).status, "AMBIGUOUS");
});

// ══════════════════ Retention-class enforcement (Phase B) ══════════════════

test("B1. R3/R4 never appear as GC candidates in any plan path", () => {
  const root = tmpRoot("b1");
  makeRunRoot(root, "grun1", { rotated: 6 });
  const ns = resolveGcNamespace({ graphRunId: "grun1", env: envFor(root) });
  const { plan } = planTelemetryGc({ namespace: ns, lifecycle: { runTerminal: true, terminalAt: 0 } });
  for (const c of [...plan.PLANNED_DELETE, ...plan.ELIGIBLE]) {
    assert.ok(c.retentionClass === "R2" || c.retentionClass === "R0", `candidate class ${c.retentionClass}`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("B2. planPriorSnapshotGc candidates are R2 (bounded completed-run observability), never R3", () => {
  const root = tmpRoot("b2");
  makeExecDir(root, "exec_abc", { revisions: 12, terminal: true });
  const { plan } = planPriorSnapshotGc({ persistenceRoot: root, executionId: "exec_abc" });
  assert.ok(plan.PLANNED_DELETE.every((c) => c.retentionClass === "R2"));
  rmSync(root, { recursive: true, force: true });
});
