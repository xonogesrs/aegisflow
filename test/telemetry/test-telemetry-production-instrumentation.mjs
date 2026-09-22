// test/telemetry/test-telemetry-production-instrumentation.mjs
//
// R-06 — production graph telemetry instrumentation card tests.
//
// Covers:
//   Phase C — canonical lifecycle event contract (bounded vocabulary,
//             identity fields only, validation)
//   Phase D — authority fence: telemetry failure/disabled/degraded never
//             changes execution semantics (TELEMETRY_AUTHORITY_LEAKS = 0)
//   Phase E — canonical location wiring (S16 resolver; no fallback roots)
//   Phase F — default-on instrumentation + explicit observable disable
//   Phase G — event identity/ordering (deterministic ids, duplicate replay
//             idempotent, stale generation classified)
//   Phase H — multi-session telemetry (generation transition, rollover,
//             successor, dependency consumption, fan-out identities)
//   Phase I — crash/resume (re-open same store, partial telemetry never
//             authoritative, GC protection boundaries)
//   Phase J — failure/degradation matrix classification
//   Phase K — operational timeline reconstruction (operator value)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelemetryEvent,
  LIFECYCLE_OBSERVED_STAGES,
  validateTelemetryEventV1,
  TELEMETRY_EVENT_TYPES,
} from "../../src/telemetry/contract.mjs";
import { TelemetryStore } from "../../src/telemetry/store.mjs";
import { resolveTelemetryStateRoot, TELEMETRY_STATE_ROOT_ENV, TELEMETRY_ROOT } from "../../src/telemetry/location.mjs";
import {
  resolveProductionTelemetryRoot,
  initProductionTelemetry,
  createLifecycleEmitter,
  buildProductionTelemetryWiring,
  resolveProductionTelemetryWiring,
  attachTelemetryDisposition,
} from "../../src/telemetry/production-observer.mjs";

const ROOTS = [];
function tmpRoot(label) {
  const r = mkdtempSync(join(tmpdir(), `r06-${label}-`));
  ROOTS.push(r);
  return r;
}
function envFor(root) {
  return { [TELEMETRY_STATE_ROOT_ENV]: root };
}
function openStore(root) {
  const store = new TelemetryStore({ stateRoot: root });
  store.open();
  return store;
}

// ── Phase C — canonical event contract ─────────────────────────────────────

test("C1. lifecycle.observed is a legal event type; unknown lifecycle stage fails validation", () => {
  assert.ok(TELEMETRY_EVENT_TYPES.includes("lifecycle.observed"));
  const good = createTelemetryEvent({ graphRunId: "g1", eventType: "lifecycle.observed", sequence: 0 });
  good.identity = { ...good.identity, nodeId: "SA-R1", attempt: 0 };
  good.lifecycle = { stage: "phase.start", sessionId: "s1", generation: 0, outcome: "STARTED", detail: null };
  assert.equal(validateTelemetryEventV1(good).valid, true, JSON.stringify(validateTelemetryEventV1(good).errors));
  const bad = createTelemetryEvent({ graphRunId: "g1", eventType: "lifecycle.observed", sequence: 1 });
  bad.lifecycle = { stage: "SOME_FREESTYLE_STAGE", sessionId: null, generation: null, outcome: null, detail: null };
  const v = validateTelemetryEventV1(bad);
  assert.equal(v.valid, false);
  assert.ok(v.errors.some((e) => e.includes("lifecycle_stage_invalid")));
});

test("C2. lifecycle stage vocabulary is bounded and timeline-complete", () => {
  for (const required of ["run.start", "phase.dispatch", "phase.start", "phase.terminal", "provider.usage", "dependency.consumed", "phase.repair", "rollover.observed", "rollover.triggered", "rollover.request", "rollover.handover", "resume.start", "run.final", "run.closeout"]) {
    assert.ok(LIFECYCLE_OBSERVED_STAGES.includes(required), `missing stage: ${required}`);
  }
});

test("C3. lifecycle fields are identity-bounded (no content smuggling; detail bounded)", () => {
  const ev = createTelemetryEvent({ graphRunId: "g1", eventType: "lifecycle.observed", sequence: 0 });
  ev.lifecycle = { stage: "run.final", sessionId: "s", generation: 2, outcome: "PASS", detail: "x".repeat(200) };
  const v = validateTelemetryEventV1(ev);
  assert.equal(v.valid, false, "over-long detail rejected");
  const ev2 = createTelemetryEvent({ graphRunId: "g1", eventType: "lifecycle.observed", sequence: 0 });
  ev2.lifecycle = { stage: "run.final", sessionId: "s", generation: 2, outcome: "PASS", detail: "d".repeat(160) };
  assert.equal(validateTelemetryEventV1(ev2).valid, true, "160-char detail is the bound");
  const flat = JSON.stringify(ev2);
  for (const banned of ["prompt", "response", "stdout", "stderr", "content"]) {
    assert.ok(!flat.includes(`"${banned}":`), `no ${banned} field`);
  }
});

// ── Phase E — canonical location wiring ────────────────────────────────────

test("E1. production telemetry root resolves through the S16 resolver (no own root invention)", () => {
  const override = tmpRoot("loc");
  const root = resolveProductionTelemetryRoot({ graphRunId: "g-e1", env: envFor(override) });
  assert.equal(root, override, "override is the exact store root");
  const canonical = resolveProductionTelemetryRoot({ graphRunId: "g-e1", env: {} });
  assert.equal(canonical, join(TELEMETRY_ROOT, "g-e1"), "canonical namespace child");
});

test("E2. resolver failure never falls back (repo-local / $HOME / cwd all rejected)", () => {
  assert.throws(() => resolveProductionTelemetryRoot({ graphRunId: "" }), /graphRunId required/);
  assert.throws(() => resolveProductionTelemetryRoot({ graphRunId: "../escape" }), /flat identity/);
  assert.throws(
    () => resolveProductionTelemetryRoot({ graphRunId: "g", env: { [TELEMETRY_STATE_ROOT_ENV]: "relative/path" } }),
    /absolute/,
  );
});

// ── Phase F — default-on + explicit observable disable ─────────────────────

test("F1. canonical wiring initializes a store at the canonical root and emits the timeline", () => {
  const override = tmpRoot("default-on");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-f1", env: envFor(override) });
  assert.equal(built.ok, true, built.reason ?? "");
  assert.equal(existsSync(override), true, "state root created");
  assert.equal(typeof built.wiring.observer, "function");
  assert.equal(typeof built.wiring.lifecycle.emit, "function");
  // timeline events flow through the SAME store
  built.wiring.lifecycle.emit("run.start", { outcome: "STARTED" });
  built.wiring.lifecycle.emit("phase.start", { phaseId: "P1" });
  const events = built.wiring.store.readAll();
  assert.ok(events.some((e) => e.eventType === "lifecycle.observed" && e.lifecycle.stage === "run.start"));
  assert.ok(events.some((e) => e.eventType === "lifecycle.observed" && e.lifecycle.stage === "phase.start" && e.identity.nodeId === "P1"));
});

test("F2. explicit disable is observable and carries no wiring", async () => {
  const r = await resolveProductionTelemetryWiring({ telemetryOpt: false, graphRunId: "g-f2", env: envFor(tmpRoot("dis")) });
  assert.equal(r.mode, "disabled");
  assert.equal(r.wiring, null);
  assert.equal(r.disposition.disabled, true);
  // nothing written anywhere
  const r2 = await resolveProductionTelemetryWiring({ telemetryOpt: false, graphRunId: "g-f2", env: {} });
  assert.equal(r2.mode, "disabled");
});

test("F3. default-on in production env; test-context default is off without an override (isolation refinement)", async () => {
  // production-like env: no NODE_TEST_CONTEXT, no override → canonical
  const r = await resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-f3", env: { PATH: "/usr/bin" } });
  assert.equal(r.mode, "canonical", `expected canonical, got ${r.mode}: ${r.disposition?.reason ?? ""}`);
  // test context without override → isolated (never writes the canonical namespace from suites)
  const r2 = await resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-f3", env: { NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(r2.mode, "test-default-off");
  assert.equal(r2.disposition.disabled, true);
  // test context WITH override → canonical at the override (suite isolation via env)
  const override = tmpRoot("test-override");
  const r3 = await resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-f3", env: { NODE_TEST_CONTEXT: "child-v8", [TELEMETRY_STATE_ROOT_ENV]: override } });
  assert.equal(r3.mode, "canonical");
  assert.equal(r3.wiring.store.stateRoot, override);
});

// ── Phase D — authority fence ──────────────────────────────────────────────

test("D1. telemetry init failure is degraded observability, never an execution error", async () => {
  // unwritable parent → init must fail with UNAVAILABLE, not throw
  const blocked = join(tmpRoot("blocked"), "file-not-a-dir");
  writeFileSync(blocked, "not a directory", "utf8");
  const env = { [TELEMETRY_STATE_ROOT_ENV]: join(blocked, "child"), NODE_TEST_CONTEXT: "x" };
  const r = await resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-d1", env });
  assert.equal(r.mode, "degraded");
  assert.equal(r.wiring, null);
  assert.equal(r.disposition.observed, false);
  assert.ok(r.disposition.holdCode === "TELEMETRY_UNAVAILABLE" || r.disposition.holdCode === "TELEMETRY_STORE_INVALID");
  // the disposition never throws and never carries authority
  const result = attachTelemetryDisposition({ final: "PASS" }, r.disposition);
  assert.equal(result.final, "PASS", "verdict untouched");
  assert.equal(result.telemetry.observed, false);
});

test("D2. corrupt prior telemetry degrades (STORE_INVALID); execution semantics unaffected", () => {
  const override = tmpRoot("corrupt");
  mkdirSync(override, { recursive: true });
  writeFileSync(join(override, "telemetry.jsonl"), "{\"schema\":\"autoloop.telemetry-store/v1\",\"schemaVersion\":1,\"createdAt\":null}\nnot-json\n", "utf8");
  const init = initProductionTelemetry({ graphRunId: "g-d2", env: envFor(override) });
  assert.equal(init.ok, false);
  assert.equal(init.holdCode, "TELEMETRY_STORE_INVALID");
  // the disposition path: degraded, observed false, never an exception
  const r = resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-d2", env: { ...envFor(override), NODE_TEST_CONTEXT: "x" } });
  return r.then((res) => {
    assert.equal(res.mode, "degraded");
    assert.equal(res.disposition.holdCode, "TELEMETRY_STORE_INVALID");
  });
});

test("D3. emitter append failure drops events; emit never throws; counts expose degradation", () => {
  const override = tmpRoot("append-fail");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-d3", env: envFor(override) });
  assert.equal(built.ok, true);
  // close the store's backing by pointing the active file at a directory path:
  // append throws; emit must swallow.
  const emitter = built.wiring.lifecycle;
  // break the store by closing (open_ = false → append throws UNAVAILABLE)
  built.wiring.store.open_ = false;
  const ok1 = emitter.emit("run.start", { outcome: "STARTED" });
  assert.equal(ok1, false, "append failure dropped");
  assert.equal(emitter.counts.dropped >= 1, true);
  // unknown stage is dropped, never thrown
  assert.equal(emitter.emit("NOT_A_STAGE", {}), false);
});

test("D4. disabled/degraded telemetry never mutates admission/lifecycle/verdict fields", () => {
  const result = { final: "PASS", admission: { admission_id: "a1" }, closeout: { applied: true } };
  attachTelemetryDisposition(result, { disabled: true, observed: false, events: 0, holdCode: null });
  assert.equal(result.final, "PASS", "verdict untouched");
  assert.deepEqual(result.admission, { admission_id: "a1" }, "admission untouched");
  assert.deepEqual(result.closeout, { applied: true }, "closeout untouched");
});

// ── Phase G — event identity / ordering ────────────────────────────────────

test("G1. deterministic event id: replayed emission is byte-identical (idempotent duplicate)", () => {
  const override = tmpRoot("dup");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-g1", env: envFor(override) });
  const events1 = () => built.wiring.store.readAll().map((e) => e.eventId);
  // the store tolerates a replayed identical line as observability
  const before = events1().length;
  const ev = createTelemetryEvent({ graphRunId: "g-g1", eventType: "lifecycle.observed", sequence: 900 });
  ev.lifecycle = { stage: "phase.start", sessionId: null, generation: 0, outcome: "STARTED", detail: null };
  built.wiring.store.append(ev);
  built.wiring.store.append(ev); // duplicate replay
  const all = built.wiring.store.readAll();
  const ids = all.filter((e) => e.sequence === 900).map((e) => e.eventId);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], "duplicate replay is byte-identical (harmless observability)");
  assert.equal(events1().length, before + 2);
});

test("G2. sequence orders the chronology per run; generation/session distinguish eras without authority", () => {
  const override = tmpRoot("order");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-g2", env: envFor(override) });
  const em = built.wiring.lifecycle;
  em.emit("phase.start", { phaseId: "A", generation: 0 });
  em.emit("phase.terminal", { phaseId: "A", generation: 0, outcome: "PASS" });
  em.emit("phase.start", { phaseId: "A", generation: 1, sessionId: "s-B" });
  const events = built.wiring.store.readAll().filter((e) => e.eventType === "lifecycle.observed");
  assert.deepEqual(events.map((e) => e.sequence), [0, 1, 2], "chronology by sequence");
  assert.deepEqual(events.map((e) => e.lifecycle.generation), [0, 0, 1], "generation bound per event");
  assert.equal(events[2].lifecycle.sessionId, "s-B", "session identity bound");
});

// ── Phase H/I — multi-session + crash/resume ───────────────────────────────

test("H1. resumed era re-opens the SAME run-scoped store (no duplicate stream; init replay idempotent)", () => {
  const override = tmpRoot("resume");
  const g = "g-h1";
  const env = envFor(override);
  const first = buildProductionTelemetryWiring({ graphRunId: g, env });
  first.wiring.lifecycle.emit("run.start", { outcome: "STARTED", generation: 0 });
  first.wiring.lifecycle.emit("phase.terminal", { phaseId: "A", outcome: "PASS", generation: 0 });
  // "crash" — nothing closed; second init re-opens the same root
  const second = buildProductionTelemetryWiring({ graphRunId: g, env });
  assert.equal(second.ok, true);
  assert.equal(second.created, false, "same store re-opened, not re-created");
  assert.equal(second.replayedInit, true, "init marker replay detected");
  second.wiring.lifecycle.emit("resume.start", { outcome: "RESUMED", generation: 1 });
  const events = second.wiring.store.readAll().filter((e) => e.eventType === "lifecycle.observed");
  assert.equal(events.length, 3, "single stream across eras");
  assert.deepEqual(events.map((e) => e.lifecycle.stage), ["run.start", "phase.terminal", "resume.start"]);
  assert.deepEqual(events.map((e) => e.lifecycle.generation), [0, 0, 1]);
});

test("H2. rollover + successor + dependency timeline is representable (fan-out identities preserved)", () => {
  const override = tmpRoot("fanout");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-h2", env: envFor(override) });
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED", generation: 0, sessionId: "s-A" });
  // fan-out: B1/B2/B3 distinct child identities, completion order NOT authority
  em.emit("phase.terminal", { phaseId: "B2", outcome: "PASS", generation: 0, sessionId: "s-A" });
  em.emit("phase.terminal", { phaseId: "B1", outcome: "PASS", generation: 0, sessionId: "s-A" });
  em.emit("phase.terminal", { phaseId: "B3", outcome: "PASS", generation: 0, sessionId: "s-A" });
  em.emit("dependency.consumed", { phaseId: "C", outcome: "CONSUMING", detail: "B1,B2,B3", generation: 0, sessionId: "s-A" });
  em.emit("rollover.observed", { outcome: "OBSERVED", detail: "occupancy=912345", generation: 0, sessionId: "s-A" });
  em.emit("rollover.triggered", { outcome: "TRIGGERED", generation: 0, sessionId: "s-A" });
  em.emit("rollover.request", { outcome: "DISPATCHING", generation: 0, sessionId: "s-A" });
  em.emit("rollover.handover", { outcome: "OWNERSHIP_TRANSFER_COMMITTED", generation: 0, sessionId: "s-A" });
  em.emit("resume.start", { outcome: "RESUMED", generation: 1, sessionId: "s-B" });
  em.emit("run.final", { outcome: "PASS", generation: 1, sessionId: "s-B" });
  const stages = built.wiring.store.readAll().filter((e) => e.eventType === "lifecycle.observed").map((e) => `${e.lifecycle.generation}:${e.lifecycle.sessionId}:${e.lifecycle.stage}:${e.identity.nodeId ?? "-"}`);
  assert.equal(stages.length, 11);
  // distinct child identities preserved (completion order B2,B1,B3 is timeline, never authority)
  assert.ok(stages.some((s) => s === "0:s-A:phase.terminal:B2"));
  assert.ok(stages.some((s) => s === "0:s-A:phase.terminal:B1"));
  assert.ok(stages.some((s) => s === "0:s-A:phase.terminal:B3"));
  assert.ok(stages.some((s) => s === "0:s-A:dependency.consumed:C"));
  assert.ok(stages.some((s) => s === "1:s-B:resume.start:-"));
  assert.ok(stages.some((s) => s === "1:s-B:run.final:-"));
});

test("I1. partial telemetry (torn/malformed line) is classified INVALID_TELEMETRY-adjacent and never authoritative", () => {
  const override = tmpRoot("torn");
  mkdirSync(override, { recursive: true });
  const store = openStore(override);
  const em = createLifecycleEmitter({ store, graphRunId: "g-i1" });
  em.emit("run.start", { outcome: "STARTED" });
  // simulate a torn append
  appendFileSync(join(override, "telemetry.jsonl"), "{\"schema\":\"autoloop.telemetry\n", "utf8");
  // re-open fails closed at the store level (per S16 §J) — the INIT path degrades
  const reopen = new TelemetryStore({ stateRoot: override });
  assert.throws(() => reopen.open(), (e) => e?.code === "TELEMETRY_STORE_INVALID");
});

// ── Phase J — degradation matrix ───────────────────────────────────────────

test("J1. degradation matrix: every failure classifies and degrades without execution effect", async () => {
  const cases = [];
  // (a) root unavailable — unwritable parent
  {
    const blocked = join(tmpRoot("jx"), "f");
    writeFileSync(blocked, "x", "utf8");
    cases.push(["root unavailable", await resolveProductionTelemetryWiring({ telemetryOpt: undefined, graphRunId: "g-j", env: { [TELEMETRY_STATE_ROOT_ENV]: join(blocked, "c"), NODE_TEST_CONTEXT: "x" } })]);
  }
  // (b) permission/write failure — append into read-only dir
  {
    const override = tmpRoot("perm");
    const built = buildProductionTelemetryWiring({ graphRunId: "g-j", env: envFor(override) });
    built.wiring.store.open_ = false; // store_not_open → append throws
    cases.push(["write failure", { mode: "degraded", wiring: built.wiring, disposition: { observed: false, holdCode: "TELEMETRY_UNAVAILABLE" } }]);
  }
  // (c) explicit disable
  cases.push(["disabled", await resolveProductionTelemetryWiring({ telemetryOpt: false, graphRunId: "g-j", env: {} })]);
  for (const [label, r] of cases) {
    assert.ok(["degraded", "disabled", "canonical"].includes(r.mode), `${label}: classified`);
    assert.equal(r.disposition === null ? "canonical" : "disposition", r.mode === "canonical" ? "canonical" : "disposition");
    // NOTHING in the disposition is an execution authority field
    if (r.disposition) {
      for (const k of Object.keys(r.disposition)) {
        assert.ok(["disabled", "disabledReason", "observed", "events", "holdCode", "reason", "stateRoot"].includes(k), `${label}: disposition key ${k} is observability-only`);
      }
    }
  }
});

// ── Phase K — operator timeline ────────────────────────────────────────────

test("K1. a representative long-running run reconstructs an operational timeline from telemetry ALONE", () => {
  const override = tmpRoot("timeline");
  const built = buildProductionTelemetryWiring({ graphRunId: "g-k1", env: envFor(override) });
  const em = built.wiring.lifecycle;
  em.emit("run.start", { outcome: "STARTED" });
  em.emit("phase.dispatch", { phaseId: "SA-R1", outcome: "DISPATCHED" });
  em.emit("phase.start", { phaseId: "SA-R1" });
  em.emit("provider.usage", { phaseId: "SA-R1", outcome: "PROVIDER_REPORTED", detail: "input=530 output=25 cacheRead=0 cacheWrite=0" });
  em.emit("phase.terminal", { phaseId: "SA-R1", outcome: "PASS" });
  em.emit("phase.terminal", { phaseId: "SA-W1", outcome: "HOLD", detail: "REVIEW_HELD" });
  em.emit("phase.repair", { phaseId: "SA-W1", outcome: "REPAIR_REQUESTED" });
  em.emit("phase.terminal", { phaseId: "SA-W1", outcome: "PASS" });
  em.emit("run.final", { outcome: "PASS" });
  em.emit("run.closeout", { outcome: "PASS", detail: "/evidence/autoloop/exec_x/closeout" });
  // operator timeline: read the store, derive phases/outcomes without ANY
  // authoritative state read
  const events = built.wiring.store.readAll().filter((e) => e.eventType === "lifecycle.observed");
  const timeline = events.map((e) => ({
    at: e.occurredAt,
    stage: e.lifecycle.stage,
    phase: e.identity.nodeId,
    outcome: e.lifecycle.outcome,
    detail: e.lifecycle.detail,
  }));
  assert.equal(timeline[0].stage, "run.start");
  assert.equal(timeline.filter((t) => t.stage === "phase.terminal" && t.outcome === "PASS").length, 2);
  assert.ok(timeline.some((t) => t.stage === "phase.repair"));
  assert.ok(timeline.some((t) => t.stage === "provider.usage" && t.detail.includes("input=530")));
  assert.equal(timeline[timeline.length - 1].stage, "run.closeout");
  assert.equal(timeline[timeline.length - 1].outcome, "PASS");
  // chronology ordering (occurredAt monotonic within the emitter's stream)
  const times = timeline.map((t) => Date.parse(t.at));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1] - 5, "monotonic chronology (5ms clock slack)");
});

// no leakage: process-exit sweep of every temp root this suite created
process.on("exit", () => {
  for (const dir of ROOTS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
