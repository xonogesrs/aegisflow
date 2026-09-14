// test/learning/test-transfer-metrics-writer.mjs
// T8-T18, T38-T40

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, lstatSync, openSync, writeSync, closeSync,
} from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TRANSFER_CODES } from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, lastCompleteEvent, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import {
  FIXTURE, makeIdentities, makeEvent, createTestWriter, createTestRoot, expectCode, hex, iso, makeBinder,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

test("T8 same-key same-payload retry is AlreadySatisfied", () => {
  const ids = makeIdentities("t8");
  const { root, writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  const a = writer.appendTransferEvent({ event, principal: FIXTURE });
  const b = writer.appendTransferEvent({ event, principal: FIXTURE });
  assert.equal(a.status, "APPENDED");
  assert.equal(b.status, "ALREADY_SATISFIED");
  assert.equal(readLog(root).events.length, 1);
});

test("T9 same-key conflicting payload rejected", () => {
  const ids = makeIdentities("t9");
  const { writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  writer.appendTransferEvent({ event, principal: FIXTURE });
  const conflict = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    payload: { observed_outcome_class: "TEST_FAIL" },
  });
  expectCode(
    () => writer.appendTransferEvent({ event: conflict, principal: FIXTURE }),
    TRANSFER_CODES.IDEMPOTENCY_CONFLICT,
  );
});

test("T10 concurrent same-key writers serialize", async () => {
  const ids = makeIdentities("t10");
  const { root, writer } = createTestWriter(ids);
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  const results = await Promise.all([
    Promise.resolve(writer.appendTransferEvent({ event, principal: FIXTURE })),
    Promise.resolve(writer.appendTransferEvent({ event, principal: FIXTURE })),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["ALREADY_SATISFIED", "APPENDED"]);
  assert.equal(readLog(root).events.length, 1);
});

test("T11 concurrent distinct-key writers both persist", async () => {
  const ids = makeIdentities("t11");
  const evidenceB = hex("evidence-t11-b");
  const { root, writer } = createTestWriter(ids, {
    evidence: new Set([ids.evidence, evidenceB]),
  });
  const a = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  const b = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    evidence_refs: [{ kind: "evidence_event", identity: "ev2", digest: evidenceB }],
    payload: { source_record_id: "src-t11-b" },
  });
  const results = await Promise.all([
    Promise.resolve(writer.appendTransferEvent({ event: a, principal: FIXTURE })),
    Promise.resolve(writer.appendTransferEvent({ event: b, principal: FIXTURE })),
  ]);
  assert.ok(results.every((r) => r.status === "APPENDED"));
  const log = readLog(root);
  assert.equal(log.events.length, 2);
  assert.notEqual(log.events[0].journal_sequence, log.events[1].journal_sequence);
});

test("T12 crash before append writes nothing", () => {
  const ids = makeIdentities("t12");
  const { root, writer } = createTestWriter(ids, {
    crashHooks: { beforeAppend() { throw new Error("crash-before"); } },
  });
  const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  assert.throws(() => writer.appendTransferEvent({ event, principal: FIXTURE }), /crash-before/);
  assert.equal(existsSync(join(root, LOG_FILE_NAME)), false);
});

test("T13 crash/partial tail is detected and not success", () => {
  const ids = makeIdentities("t13");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const crashing = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
    crashHooks: {
      writeLine(fd, line) {
        writeSync(fd, line.slice(0, 24));
        throw new Error("crash-partial");
      },
    },
  });
  const second = makeEvent("PATTERN_CANDIDATE_CREATED", ids);
  assert.throws(() => crashing.appendTransferEvent({ event: second, principal: FIXTURE }), /crash-partial/);
  const snap = lastCompleteEvent(root);
  assert.equal(snap.partialTrailingLine, true);
  assert.equal(snap.event.event_type, "INCIDENT_OBSERVED");
});

test("T14 restart/reconcile continues from last complete event", () => {
  const ids = makeIdentities("t14");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const crashing = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
    crashHooks: {
      writeLine(fd, line) {
        writeSync(fd, line.slice(0, 24));
        throw new Error("crash-partial");
      },
    },
  });
  assert.throws(() => crashing.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids),
    principal: FIXTURE,
  }), /crash-partial/);
  const restarted = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  const ok = restarted.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids),
    principal: FIXTURE,
  });
  assert.equal(ok.status, "APPENDED");
  const log = readLog(root);
  assert.equal(log.partialTrailingLine, false);
  assert.equal(log.events.length, 2);
  assert.equal(log.events[1].journal_sequence, 2);
});

test("T15 corrupt middle record fail-closed", () => {
  const ids = makeIdentities("t15");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { occurred_at: iso(2) }),
    principal: FIXTURE,
  });
  const path = join(root, LOG_FILE_NAME);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  lines[1] = "{not-json";
  writeFileSync(path, lines.join("\n"));
  expectCode(() => readLog(root), TRANSFER_CODES.LOG_CHAIN_INVALID);
  const w2 = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  expectCode(() => w2.appendTransferEvent({
    event: makeEvent("PATTERN_QUALIFIED", ids, { occurred_at: iso(3) }),
    principal: FIXTURE,
  }), TRANSFER_CODES.LOG_CHAIN_INVALID);
});

test("T16 revoked writer fail-closed", () => {
  const ids = makeIdentities("t16");
  const { writer } = createTestWriter(ids);
  writer.revokeWriter("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "t16-revoke", expected: 0, task_identity: ids.task_identity });
  expectCode(() => writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  }), TRANSFER_CODES.WRITER_REVOKED);
});

test("T17 stale/wrong generation fail-closed", () => {
  const ids = makeIdentities("t17");
  const { writer } = createTestWriter(ids);
  writer.setWriterGeneration("w1", { issuer: writer.fixtureAuthorityIssuer(), mutationId: "t17-advance", expected: 0, task_identity: ids.task_identity });
  expectCode(() => writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      writer: { writer_id: "w1", writer_generation: 0 },
    }),
    principal: FIXTURE,
  }), TRANSFER_CODES.STALE_GENERATION);
  const { writer: w2 } = createTestWriter(ids, {
    truthGenerations: new Map([[ids.pattern_id, 3]]),
    root: createTestRoot("t17b"),
  });
  expectCode(() => w2.appendTransferEvent({
    event: makeEvent("PATTERN_QUALIFIED", ids, { revocation_generation: null }),
    principal: FIXTURE,
  }), TRANSFER_CODES.WRONG_GENERATION);
});

test("T18 symlink / path escape / non-regular target rejected", () => {
  const ids = makeIdentities("t18");
  expectCode(() => new TransferMetricsWriter({
    transferMetricsRoot: "/tmp/transfer-metrics-escape",
    identityBinder: makeBinder(ids),
    allowFixture: true,
  }), TRANSFER_CODES.PATH_UNSAFE);
  expectCode(() => new TransferMetricsWriter({
    transferMetricsRoot: join("/Volumes/NVM2T/Development/tmp", "..", "..", "..", "etc"),
    identityBinder: makeBinder(ids),
    allowFixture: true,
  }), TRANSFER_CODES.PATH_UNSAFE);
  const root = createTestRoot("t18sym");
  symlinkSync("/etc/passwd", join(root, LOG_FILE_NAME));
  const w = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  expectCode(() => w.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  }), TRANSFER_CODES.PATH_UNSAFE);
  const rootDir = createTestRoot("t18dir");
  mkdirSync(join(rootDir, LOG_FILE_NAME));
  const wdir = new TransferMetricsWriter({
    transferMetricsRoot: rootDir,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  expectCode(() => wdir.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  }), TRANSFER_CODES.PATH_UNSAFE);
});

test("T38 multi-process concurrency", async () => {
  const ids = makeIdentities("t38");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("t38");
    const digest = process.argv[2];
    const event = makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      evidence_refs: [{ kind: "evidence_event", identity: "ev", digest }],
      payload: { source_record_id: "src-" + digest.slice(0, 16) },
    });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids, { evidence: new Set([ids.evidence, digest]) }),
      allowFixture: true,
    });
    const r = writer.appendTransferEvent({ event, principal: FIXTURE });
    process.stdout.write(r.status + " " + r.event.journal_sequence);
  `);
  function run(digest) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, digest], { encoding: "utf8" });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
      child.on("error", reject);
    });
  }
  const [a, b] = await Promise.all([run(hex("t38-a")), run(hex("t38-b"))]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const log = readLog(root);
  assert.equal(log.events.length, 2);
  const seqs = log.events.map((e) => e.journal_sequence).sort((x, y) => x - y);
  assert.deepEqual(seqs, [1, 2]);
});

test("T39 payload/file boundary permissions", () => {
  const ids = makeIdentities("t39");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const logPath = join(root, LOG_FILE_NAME);
  assert.equal(lstatSync(logPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(root).mode & 0o777, 0o700);
});

test("T40 no second durable engine and no decision-module imports", () => {
  const srcDir = join(REPO, "src/learning/transfer-metrics");
  const names = ["schema.mjs", "writer.mjs", "log.mjs", "redact.mjs", "identities.mjs", "reducer.mjs", "formulas.mjs", "report.mjs", "seam.mjs", "fixtures.mjs"];
  for (const name of names) {
    const text = readFileSync(join(srcDir, name), "utf8");
    assert.equal(text.includes("better-sqlite3"), false, name);
    assert.equal(text.includes("durable-graph.mjs"), false, name);
    assert.equal(/from ["'].*sqlite/.test(text), false, name);
  }
  const forbiddenImporters = [
    "src/lifecycle-runner.mjs",
    "src/governance/pass-oracle.mjs",
    "src/admission/admission-gate.mjs",
    "src/admission/policy-projection.mjs",
    "src/sop/proportional-sop.mjs",
    "src/memory/retrieval.mjs",
    // P7 subtraction re-point: the production pipeline moved to the optional
    // orchestration layer; the scan target moves with it.
    "src/orchestration/decomposition/production-pipeline.mjs",
    "src/subagent/subagent-graph-runner.mjs",
    "src/v2/durable-graph.mjs",
  ];
  for (const rel of forbiddenImporters) {
    const text = readFileSync(join(REPO, rel), "utf8");
    assert.equal(text.includes("transfer-metrics"), false, rel);
  }
  const ids = makeIdentities("t40");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  assert.equal(existsSync(join(root, "transfer-events.jsonl")), true);
  assert.equal(existsSync(join(root, "journal.sqlite")), false);
  assert.equal(existsSync(join(root, "state.db")), false);
});
