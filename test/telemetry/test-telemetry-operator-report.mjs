// test/telemetry/test-telemetry-operator-report.mjs
//
// R-07 — telemetry aggregate operator surface card tests.
//
// Covers:
//   Phase C — operator contract: bounded read → aggregate → report; the
//             OBSERVED / DERIVED / UNKNOWN / NOT_APPLICABLE epistemic tags.
//   Phase D — authority fence: the reader/report performs ZERO writes
//             (mutation-path census); report is advisory-only.
//   Phase E — canonical reader: S16 location resolution only (no arbitrary
//             root, no cwd/repo fallback), bounded reads, retention-aware.
//   Phase F — aggregation: aggregate.mjs reuse, determinism for the same
//             retained bytes, duplicate-event safety, missing-telemetry
//             honesty, stale-generation distinguishability.
//   Phase G — CLI surface: --json and human output; safe against unknown /
//             malformed / disabled / partial runs.
//   Phase H — active-run semantics: no premature final state; partial
//             telemetry explicitly represented.
//   Phase J — multi-session representation: rollover transitions, successor
//             generation, dependency consumption, fan-out/fan-in.
//   Phase K — retention/GC view: GC'd rotated chunks become explicit
//             retention gaps; absence never fabricated as failure.
//   Phase L — negative matrix: unknown runId, malformed graphRunId, torn
//             chunk, malformed event, duplicate event, missing middle chunk,
//             symlink escape, byte/chunk bounds.
//   Phase M — operator value: the report alone answers the operator
//             questions (status, phases, repairs, rollover, generations,
//             dependencies, usage, gaps).
//   Phase N — bounds: reads bounded by the S16 retained set; no traversal
//             outside the graphRunId namespace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildOperatorReport,
  renderOperatorReportText,
  readRunTelemetry,
  OPERATOR_MAX_CHUNKS,
  OPERATOR_MAX_TOTAL_BYTES,
} from "../../src/telemetry/operator-report.mjs";
import { buildProductionTelemetryWiring } from "../../src/telemetry/production-observer.mjs";

const ROOTS = [];
function tmpRoot(label) {
  const r = mkdtempSync(join(tmpdir(), `r07-${label}-`));
  ROOTS.push(r);
  return r;
}
const envFor = (root) => ({ AUTOLOOP_TELEMETRY_STATE_ROOT: root });
const HEADER = JSON.stringify({ createdAt: null, schema: "autoloop.telemetry-store/v1", schemaVersion: 1 });

function wiring(root, graphRunId) {
  return buildProductionTelemetryWiring({ graphRunId, env: envFor(root) });
}

// ── Phase E — canonical reader ─────────────────────────────────────────────

test("E1. reader resolves ONLY through the S16 location contract (override honored, malformed identity refused)", () => {
  const root = tmpRoot("e1");
  const built = wiring(root, "g-e1");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  const read = readRunTelemetry({ graphRunId: "g-e1", env: envFor(root) });
  assert.equal(read.ok, true);
  assert.equal(read.stateRoot, root); // override IS the exact store root
  assert.ok(read.events.length >= 1);

  const refused = readRunTelemetry({ graphRunId: "../evil", env: envFor(root) });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /ROOT_RESOLUTION_REFUSED/);

  // $HOME override rejected by the S16 resolver (fail-closed, no fallback)
  const homeRefused = readRunTelemetry({ graphRunId: "g-e1", env: { AUTOLOOP_TELEMETRY_STATE_ROOT: "/Users/zhengfengqing/Desktop" } });
  assert.equal(homeRefused.ok, false);
});

test("E2. unknown graphRunId: ABSENT telemetry is UNKNOWN, never fabricated failure or state", () => {
  // Canonical-path absence: no override, unique graphRunId → the resolver
  // returns the canonical namespace child, which does not exist (read-only
  // ENOENT — the test never writes the canonical namespace).
  const uniqueRunId = `g-never-existed-${Date.now().toString(36)}-${process.pid}`;
  const report = buildOperatorReport({ graphRunId: uniqueRunId });
  assert.equal(report.availability.state, "ABSENT");
  assert.equal(report.runStatus.status.value, "UNKNOWN");
  assert.equal(report.runStatus.observedFinalState.value, null);
  assert.equal(report.runStatus.observedFinalState.evidence, "UNKNOWN");
  assert.equal(report.phases.count, 0);
  assert.equal(report.diagnostics.items.some((d) => d.code === "NO_TELEMETRY_ROOT"), true);
});

test("E2b. existing-but-empty store (telemetry-disabled run shape): safe UNKNOWN report, explicit diagnostics", () => {
  const root = tmpRoot("e2b");
  const report = buildOperatorReport({ graphRunId: "g-never", env: envFor(root) });
  assert.equal(report.availability.state, "AVAILABLE"); // root exists, nothing retained
  assert.equal(report.eventCount.value, 0);
  assert.equal(report.runStatus.status.value, "UNKNOWN");
  assert.equal(report.diagnostics.items.some((d) => d.code === "ACTIVE_CHUNK_ABSENT"), true);
});

// ── Phase F — aggregation ──────────────────────────────────────────────────

test("F1. report is deterministic for the same retained telemetry bytes", () => {
  const root = tmpRoot("f1");
  const built = wiring(root, "g-f1");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("phase.start", { phaseId: "P1" });
  em.emit("phase.terminal", { phaseId: "P1", outcome: "PASS" });
  em.emit("run.final", { outcome: "PASS" });
  const a = buildOperatorReport({ graphRunId: "g-f1", env: envFor(root) });
  const b = buildOperatorReport({ graphRunId: "g-f1", env: envFor(root) });
  assert.equal(a.reportIdentity, b.reportIdentity);
  // generatedAt is metadata, not part of the identity
  assert.notEqual(a.generatedAt, undefined);
});

test("F2. duplicate events are tolerated and reported, never double-counted into state", () => {
  const root = tmpRoot("f2");
  const built = wiring(root, "g-f2");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("phase.terminal", { phaseId: "P1", outcome: "PASS" });
  // duplicate an exact line (replay)
  const raw = readFileSync(join(root, "telemetry.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  appendFileSync(join(root, "telemetry.jsonl"), lines[1] + "\n");
  const report = buildOperatorReport({ graphRunId: "g-f2", env: envFor(root) });
  assert.equal(report.phases.detail.P1.completed.value, 1); // not 2
  assert.equal(report.diagnostics.items.some((d) => d.code === "DUPLICATE_EVENTS"), true);
});

test("F3. missing telemetry does not fabricate state (started phase without terminal stays UNKNOWN)", () => {
  const root = tmpRoot("f3");
  const built = wiring(root, "g-f3");
  built.wiring.lifecycle.emit("phase.start", { phaseId: "P1" });
  const report = buildOperatorReport({ graphRunId: "g-f3", env: envFor(root) });
  assert.equal(report.runStatus.status.value, "OBSERVED_ACTIVE_OR_INCOMPLETE");
  assert.equal(report.runStatus.observedFinalState.value, null);
  assert.equal(report.phases.detail.P1.completed.value, 0);
  assert.equal(report.phases.detail.P1.completed.evidence, "UNKNOWN");
});

test("F4. stale/foreign generation events remain distinguishable (multi-generation timeline diagnostic)", () => {
  const root = tmpRoot("f4");
  const built = wiring(root, "g-f4");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED", generation: 0 });
  em.emit("phase.start", { phaseId: "P1", generation: 3 }); // stale/foreign era stamp
  em.emit("phase.terminal", { phaseId: "P1", outcome: "PASS", generation: 3 });
  em.emit("run.final", { outcome: "PASS", generation: 0 });
  const report = buildOperatorReport({ graphRunId: "g-f4", env: envFor(root) });
  assert.deepEqual(report.multiSession.generations.value, [0, 3]);
  assert.equal(report.diagnostics.items.some((d) => d.code === "MULTI_GENERATION_TIMELINE"), true);
  // generation binding is observational: the run status still derives from
  // the OBSERVED run.final, never from the stale generation's events.
  assert.equal(report.runStatus.status.value, "OBSERVED_TERMINAL");
});

test("F5. aggregate reuse: the report aggregate IS the canonical aggregateGraphRun output", async () => {
  const { aggregateGraphRun } = await import("../../src/telemetry/aggregate.mjs");
  const root = tmpRoot("f5");
  const built = wiring(root, "g-f5");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("provider.usage", { phaseId: "x", outcome: "PROVIDER_REPORTED", detail: "input=100 output=50 cacheRead=0 cacheWrite=0" });
  em.emit("phase.terminal", { phaseId: "P1", outcome: "PASS" });
  em.emit("run.final", { outcome: "PASS" });
  const report = buildOperatorReport({ graphRunId: "g-f5", env: envFor(root) });
  const read = readRunTelemetry({ graphRunId: "g-f5", env: envFor(root) });
  const direct = aggregateGraphRun({ events: read.events, graphRunId: null });
  assert.equal(report.aggregate.value.finalVerdict, direct.finalVerdict);
  assert.equal(report.aggregate.value.eventCount, direct.eventCount);
});

// ── Phase G — CLI surface ──────────────────────────────────────────────────

test("G1. CLI --json produces the machine-readable contract; human output is the default", () => {
  const root = tmpRoot("g1");
  const built = wiring(root, "g-cli");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  built.wiring.lifecycle.emit("run.final", { outcome: "PASS" });
  const out = execFileSync("node", ["scripts/autoloop-operator.mjs", "--run", "g-cli", "--root", root, "--json"], { encoding: "utf8", cwd: process.cwd() });
  const parsed = JSON.parse(out);
  assert.equal(parsed.schema, "autoloop.telemetry-operator-report/v1");
  assert.equal(parsed.runStatus.status.value, "OBSERVED_TERMINAL");
  const text = execFileSync("node", ["scripts/autoloop-operator.mjs", "--run", "g-cli", "--root", root], { encoding: "utf8", cwd: process.cwd() });
  assert.match(text, /AutoLoop operator report — g-cli/);
  assert.match(text, /OBSERVED_TERMINAL/);
});

test("G2. CLI exits 0 on a safe report for unknown/malformed runs; usage error exits 2", () => {
  const root = tmpRoot("g2");
  const unknown = execFileSync("node", ["scripts/autoloop-operator.mjs", "--run", "g-absent", "--root", root], { encoding: "utf8", cwd: process.cwd() });
  assert.match(unknown, /status: UNKNOWN \[UNKNOWN\]/);
  assert.match(unknown, /ACTIVE_CHUNK_ABSENT/);
  let failed = false;
  try {
    execFileSync("node", ["scripts/autoloop-operator.mjs", "--run", "x", "--root", "relative/path"], { encoding: "utf8", cwd: process.cwd(), stdio: "pipe" });
  } catch (e) {
    failed = true;
    assert.equal(e.status, 2);
  }
  assert.equal(failed, true, "relative --root must be refused");
});

// ── Phase H — active-run semantics ─────────────────────────────────────────

test("H1. active run: no premature final state; latest lifecycle observation visible; partial telemetry explicit", () => {
  const root = tmpRoot("h1");
  const built = wiring(root, "g-active");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("phase.dispatch", { phaseId: "P1", outcome: "DISPATCHED" });
  em.emit("phase.start", { phaseId: "P1" });
  em.emit("provider.usage", { phaseId: "exec_x", outcome: "PROVIDER_REPORTED", detail: "input=10 output=5 cacheRead=0 cacheWrite=0" });
  // NO run.final — the run is still executing
  const report = buildOperatorReport({ graphRunId: "g-active", env: envFor(root) });
  assert.equal(report.runStatus.status.value, "OBSERVED_ACTIVE_OR_INCOMPLETE");
  assert.equal(report.runStatus.observedFinalState.value, null);
  assert.equal(report.runStatus.latestObservedStage.value.stage, "provider.usage");
  assert.equal(report.phases.detail.P1.started.value, 1);
  assert.equal(report.phases.detail.P1.completed.value, 0);
  assert.equal(report.usage.providerUsageObservations.value.count, 1);
});

// ── Phase J — multi-session representation ─────────────────────────────────

test("J1. rollover transitions, successor generation, and dependency consumption are exposed from telemetry alone", () => {
  const root = tmpRoot("j1");
  const built = wiring(root, "g-j1");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED", detail: "exec_a" });
  em.emit("phase.start", { phaseId: "SA-R1" });
  em.emit("phase.terminal", { phaseId: "SA-R1", outcome: "PASS" });
  em.emit("rollover.observed", { phaseId: "SA-R1", outcome: "OBSERVED", detail: "occupancy=6000" });
  em.emit("rollover.triggered", { phaseId: "SA-R1", outcome: "TRIGGERED", detail: "CONTEXT_THRESHOLD_REACHED" });
  em.emit("rollover.request", { outcome: "DISPATCHING", detail: "quiescent-boundary rollover intake" });
  em.emit("rollover.handover", { outcome: "OWNERSHIP_TRANSFER_COMMITTED", generation: 1, detail: "rolloverId=abc successorGen=1" });
  em.emit("resume.start", { outcome: "RESUMED", generation: 1, detail: "attempt=2 replayOf=exec_a" });
  em.emit("dependency.consumed", { phaseId: "SA-W1", outcome: "CONSUMING", detail: "SA-R1", generation: 1 });
  em.emit("run.final", { outcome: "PASS", generation: 1 });
  const report = buildOperatorReport({ graphRunId: "g-j1", env: envFor(root) });
  assert.equal(report.multiSession.rolloverObserved.value, true);
  assert.equal(report.multiSession.rolloverTransitions.value.length, 4);
  assert.deepEqual(report.multiSession.generations.value, [0, 1]);
  assert.equal(report.multiSession.successorSessions.value.generations.includes(1), true);
  assert.equal(report.multiSession.dependencyConsumption.value.length, 1);
  assert.equal(report.multiSession.dependencyConsumption.value[0].consumed, "SA-R1");
  assert.equal(report.multiSession.resumeObservations.value.length, 1);
});

test("J2. fan-out/fan-in observed without completion-order authority", () => {
  const root = tmpRoot("j2");
  const built = wiring(root, "g-j2");
  const em = built.wiring.lifecycle;
  em.emit("phase.dispatch", { phaseId: "B1" });
  em.emit("phase.dispatch", { phaseId: "B2" });
  em.emit("phase.dispatch", { phaseId: "B3" });
  // completion order deliberately NOT the dispatch order
  em.emit("phase.terminal", { phaseId: "B2", outcome: "PASS" });
  em.emit("phase.terminal", { phaseId: "B3", outcome: "PASS" });
  em.emit("phase.terminal", { phaseId: "B1", outcome: "PASS" });
  const report = buildOperatorReport({ graphRunId: "g-j2", env: envFor(root) });
  assert.equal(report.multiSession.fanOutFanIn.value.parallelDispatchObserved, true);
  assert.equal(report.multiSession.fanOutFanIn.value.completionOrderAuthoritative, false);
  assert.equal(report.multiSession.fanOutFanIn.value.fanOut, 3);
});

// ── Phase K — retention / GC view ──────────────────────────────────────────

test("K1. GC'd rotated chunks surface as explicit retention gaps; absence is never fabricated as failure", () => {
  const root = tmpRoot("k1");
  const built = wiring(root, "g-k1");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  built.wiring.lifecycle.emit("run.final", { outcome: "PASS" });
  // simulate retained-after-GC chunk set: 1 and 3 (2 was legitimately GC'd)
  const raw = readFileSync(join(root, "telemetry.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  writeFileSync(join(root, "telemetry-1.jsonl"), lines[0] + "\n" + lines[1] + "\n");
  writeFileSync(join(root, "telemetry-3.jsonl"), lines[0] + "\n");
  rmSync(join(root, "telemetry.jsonl"));
  const report = buildOperatorReport({ graphRunId: "g-k1", env: envFor(root) });
  assert.deepEqual(report.retentionGaps, [2]);
  assert.equal(report.diagnostics.items.some((d) => d.code === "RETENTION_GAP"), true);
  // the report still renders a safe, honest answer over the partial set
  assert.equal(report.availability.state, "AVAILABLE");
  assert.equal(report.diagnostics.items.some((d) => d.code === "ACTIVE_CHUNK_ABSENT"), true);
});

// ── Phase L — negative matrix ──────────────────────────────────────────────

test("L1. torn chunk line is surfaced explicitly, never silently dropped", () => {
  const root = tmpRoot("l1");
  const built = wiring(root, "g-l1");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  appendFileSync(join(root, "telemetry.jsonl"), '{"schema":"autoloop.telemetry-store/v1","torn\n');
  const report = buildOperatorReport({ graphRunId: "g-l1", env: envFor(root) });
  assert.equal(report.diagnostics.items.some((d) => d.code === "TORN_LINE_ACTIVE"), true);
  assert.equal(report.eventCount.value, 1); // the valid event survived
});

test("L2. malformed event (valid JSON, contract-invalid) is surfaced, never silently dropped", () => {
  const root = tmpRoot("l2");
  const built = wiring(root, "g-l2");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  appendFileSync(join(root, "telemetry.jsonl"), JSON.stringify({ schema: "bogus", eventType: "nope" }) + "\n");
  const report = buildOperatorReport({ graphRunId: "g-l2", env: envFor(root) });
  assert.equal(report.diagnostics.items.some((d) => d.code === "MALFORMED_EVENT"), true);
  assert.equal(report.eventCount.value, 1);
});

test("L3. symlink escape attempt: symlinked chunk content is never followed", () => {
  const root = tmpRoot("l3");
  // The override IS the exact store root — place the symlinked chunk there.
  writeFileSync(join(root, "victim.jsonl"), HEADER + "\n");
  symlinkSync(join(root, "victim.jsonl"), join(root, "telemetry.jsonl"));
  const report = buildOperatorReport({ graphRunId: "g-l3", env: envFor(root) });
  assert.equal(report.diagnostics.items.some((d) => d.code === "SYMLINK_ENTRY_SKIPPED"), true);
  assert.equal(report.eventCount.value, 0);
  // the victim file was never read through the link (content untouched)
  assert.equal(readFileSync(join(root, "victim.jsonl"), "utf8"), HEADER + "\n");
});

test("L4. chunk-count and byte bounds: reads stop, availability degrades to PARTIAL", () => {
  const root = tmpRoot("l4");
  for (let i = 1; i <= OPERATOR_MAX_CHUNKS + 5; i++) {
    writeFileSync(join(root, `telemetry-${i}.jsonl`), HEADER + "\n");
  }
  const report = buildOperatorReport({ graphRunId: "g-l4", env: envFor(root) });
  assert.equal(report.readBounds.chunksRead, OPERATOR_MAX_CHUNKS);
  assert.equal(report.readBounds.exceeded, false);
  assert.equal(report.diagnostics.items.some((d) => d.code === "READ_BOUNDS_CHUNKS"), true);

  const root2 = tmpRoot("l4b");
  writeFileSync(join(root2, "telemetry.jsonl"), HEADER + "\n" + "x".repeat(OPERATOR_MAX_TOTAL_BYTES + 10));
  const report2 = buildOperatorReport({ graphRunId: "g-l4b", env: envFor(root2) });
  assert.equal(report2.availability.state, "PARTIAL");
  assert.equal(report2.readBounds.exceeded, true);
});

test("L5. missing middle chunk: gap diagnostic + retained chunks still readable", () => {
  const root = tmpRoot("l5");
  const built = wiring(root, "g-l5");
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  const raw = readFileSync(join(root, "telemetry.jsonl"), "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  writeFileSync(join(root, "telemetry-1.jsonl"), lines[0] + "\n" + lines[1] + "\n");
  writeFileSync(join(root, "telemetry-4.jsonl"), lines[0] + "\n");
  rmSync(join(root, "telemetry.jsonl"));
  const report = buildOperatorReport({ graphRunId: "g-l5", env: envFor(root) });
  assert.deepEqual(report.retentionGaps, [2, 3]);
});

test("L6. telemetry-disabled run (empty store, no marker, no stream): safe report with explicit diagnostics", () => {
  const root = tmpRoot("l6");
  const report = buildOperatorReport({ graphRunId: "g-disabled", env: envFor(root) });
  assert.equal(report.availability.state, "AVAILABLE"); // root exists; nothing was ever instrumented
  assert.equal(report.eventCount.value, 0);
  assert.equal(report.runStatus.status.evidence, "UNKNOWN");
  assert.equal(report.diagnostics.items.some((d) => d.code === "ACTIVE_CHUNK_ABSENT"), true);
});

// ── Phase D — authority fence (read-only census) ───────────────────────────

test("D1. the operator surface performs ZERO writes (mutation-path census over the module source)", () => {
  const src = readFileSync(new URL("../../src/telemetry/operator-report.mjs", import.meta.url), "utf8");
  for (const banned of ["mkdirSync", "writeFileSync", "appendFileSync", "renameSync", "rmSync", "unlinkSync", "rmdirSync", "truncateSync", "chmodSync"]) {
    assert.equal(src.includes(`${banned}(`), false, `operator module must not call ${banned}`);
  }
  const cli = readFileSync(new URL("../../scripts/autoloop-operator.mjs", import.meta.url), "utf8");
  for (const banned of ["mkdirSync", "writeFileSync", "appendFileSync", "renameSync", "rmSync"]) {
    assert.equal(cli.includes(`${banned}(`), false, `operator CLI must not call ${banned}`);
  }
});

test("D2. the report never reads authoritative state as input (no durable/evidence imports)", () => {
  const src = readFileSync(new URL("../../src/telemetry/operator-report.mjs", import.meta.url), "utf8");
  assert.equal(src.includes("checkpoint"), false);
  assert.equal(src.includes("RunEvidenceStore"), false);
  assert.equal(src.includes("budget-ledger"), false);
  assert.equal(src.includes("closeout-state"), false);
});

// ── Phase M — operator value ───────────────────────────────────────────────

test("M1. the report alone answers the operator questions (no internal state consulted)", () => {
  const root = tmpRoot("m1");
  const built = wiring(root, "g-m1");
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("phase.start", { phaseId: "P1" });
  em.emit("provider.usage", { phaseId: "e1", outcome: "PROVIDER_REPORTED", detail: "input=530 output=25 cacheRead=0 cacheWrite=0" });
  em.emit("phase.terminal", { phaseId: "P1", outcome: "PASS" });
  em.emit("phase.repair", { phaseId: "P2", outcome: "REPAIR_REQUESTED" });
  em.emit("phase.terminal", { phaseId: "P2", outcome: "PASS" });
  em.emit("run.final", { outcome: "PASS" });
  em.emit("run.closeout", { outcome: "PASS", detail: "/evidence/closeout" });
  const report = buildOperatorReport({ graphRunId: "g-m1", env: envFor(root) });
  // Is this run active or terminal as observed?
  assert.equal(report.runStatus.status.value, "OBSERVED_TERMINAL");
  assert.equal(report.runStatus.observedFinalState.value.outcome, "PASS");
  // What has happened / which phases ran / retries?
  assert.equal(report.phases.detail.P1.completed.value, 1);
  assert.equal(report.phases.detail.P2.repairs.value, 1);
  // Retrieval/writeback observed?
  assert.equal(report.usage.retrieval.value.observations, 0);
  assert.equal(report.usage.providerUsageObservations.value.totals.input, 530);
  // Closeout observation present?
  assert.equal(report.runStatus.closeoutObservation.value.outcome, "PASS");
  // Degradation/gaps?
  assert.equal(report.diagnostics.count, 0);
  // The human renderer stays total over this report.
  const text = renderOperatorReportText(report);
  assert.match(text, /OBSERVED_TERMINAL/);
  assert.match(text, /final state: PASS/);
});

// ── Phase N — bounds ───────────────────────────────────────────────────────

test("N1. report generation is bounded by the retained set (chunk + byte budgets enforced)", () => {
  const root = tmpRoot("n1");
  const built = wiring(root, "g-n1");
  for (let i = 0; i < 50; i++) built.wiring.lifecycle.emit("phase.terminal", { phaseId: `P${i}`, outcome: "PASS" });
  const t0 = process.hrtime.bigint();
  const report = buildOperatorReport({ graphRunId: "g-n1", env: envFor(root) });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(report.eventCount.value, 50);
  assert.ok(ms < 1000, `report generation took ${ms.toFixed(1)}ms — must stay bounded`);
  assert.equal(report.readBounds.bytesRead <= OPERATOR_MAX_TOTAL_BYTES, true);
});

// no leakage: process-exit sweep of every temp root this suite created
process.on("exit", () => {
  for (const dir of ROOTS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
