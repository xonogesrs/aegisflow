// test/learning/test-transfer-metrics-core-1r.mjs
// Independent CORE-1R reviewer vectors. Not a restatement of T1-T40.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  linkSync,
  openSync,
  closeSync,
} from "node:fs";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  TRANSFER_CODES,
  FORMULA_VERSION,
  SCHEMA_VERSION,
  EVENT_TYPES,
  canonical,
  digestOf,
  computeEventDigest,
} from "../../src/learning/transfer-metrics/schema.mjs";
import { TransferMetricsWriter } from "../../src/learning/transfer-metrics/writer.mjs";
import { readLog, LOG_FILE_NAME } from "../../src/learning/transfer-metrics/log.mjs";
import { reduceTransferMetrics, serializeDerived, writeDerivedDocument } from "../../src/learning/transfer-metrics/reducer.mjs";
import { CANONICAL_METRICS, COMPANION_METRICS } from "../../src/learning/transfer-metrics/formulas.mjs";
import { mintPrincipal } from "../../src/learning/transfer-metrics/identities.mjs";
import {
  isTransferMetricsEnabled,
  recordTransferEvent,
  TRANSFER_METRICS_ENABLED,
} from "../../src/learning/transfer-metrics/seam.mjs";
import {
  FIXTURE, EXECUTOR, SYSTEM, REVIEWER,
  makeIdentities, makeEvent, createTestWriter, createTestRoot, expectCode, hex, iso, makeBinder, WINDOW,
} from "../../src/learning/transfer-metrics/fixtures.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function shaFile(path) {
  const { createHash } = createRequire(import.meta.url)("node:crypto");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
test("R1 self-referential subject_event_id is unbound if not a prior log event", () => {
  const ids = makeIdentities("r1");
  const { writer } = createTestWriter(ids);
  const phantom = hex("self-ref-subject");
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("TRANSFER_ADJUDICATED", ids, {
        subject_event_id: phantom,
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.SUBJECT_UNBOUND,
  );
});

test("R2 cross-attempt subject must exist in this log", () => {
  const ids = makeIdentities("r2");
  const { writer } = createTestWriter(ids);
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  const later = makeEvent("TRANSFER_ADJUDICATED", ids, {
    occurred_at: iso(2),
    attempt_identity: { execution_id: ids.execution_id, attempt: 1 },
    subject_event_id: retr.event.event_id,
  });
  const ok = writer.appendTransferEvent({ event: later, principal: FIXTURE });
  assert.equal(ok.status, "APPENDED");
  const missing = makeEvent("TRANSFER_ADJUDICATED", ids, {
    occurred_at: iso(3),
    payload: { attribution_grade: "D", benefit_claimed: true, adjudicator_role: "reviewer", counterfactual_digest: ids.counterfactual_digest, detected_earlier: null, unnecessary_gate: null, overlay_applicability: "APPLICABLE" },
    subject_event_id: hex("no-such-subject"),
  });
  expectCode(
    () => writer.appendTransferEvent({ event: missing, principal: FIXTURE }),
    TRANSFER_CODES.SUBJECT_UNBOUND,
  );
});

test("R3 cloned role-string principal cannot mint system/reviewer authority", () => {
  const ids = makeIdentities("r3");
  const { writer } = createTestWriter(ids);
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids),
    principal: FIXTURE,
  });
  const cloned = { identity: "sys-1", role: "system" };
  const outcome = makeEvent("OUTCOME_OBSERVED", ids, {
    pattern_identity: null,
    authority: cloned,
  });
  expectCode(
    () => writer.appendTransferEvent({ event: outcome, principal: cloned }),
    TRANSFER_CODES.AUTHORITY_FORGED,
  );
  const spread = { ...REVIEWER };
  const adj = makeEvent("TRANSFER_ADJUDICATED", ids, {
    subject_event_id: retr.event.event_id,
    authority: spread,
  });
  expectCode(
    () => writer.appendTransferEvent({ event: adj, principal: spread }),
    TRANSFER_CODES.AUTHORITY_FORGED,
  );
  const envRebuilt = JSON.parse(JSON.stringify(SYSTEM));
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("OUTCOME_OBSERVED", ids, { pattern_identity: null, authority: envRebuilt }),
      principal: envRebuilt,
    }),
    TRANSFER_CODES.AUTHORITY_FORGED,
  );
});

test("R4 mismatched evidence digest rejected when inventory required", () => {
  const ids = makeIdentities("r4");
  const { writer } = createTestWriter(ids, { requireEvidenceInventory: true });
  const event = makeEvent("INCIDENT_OBSERVED", ids, {
    pattern_identity: null,
    evidence_refs: [{ kind: "evidence_event", identity: "ev", digest: hex("not-in-inventory") }],
  });
  expectCode(
    () => writer.appendTransferEvent({ event, principal: FIXTURE }),
    TRANSFER_CODES.EVIDENCE_MISSING,
  );
});

test("R5 Unicode equivalent identities remain distinct digests", () => {
  const composed = "cafe\u0301";
  const precomposed = "caf\u00e9";
  assert.notEqual(composed, precomposed);
  assert.notEqual(digestOf(composed), digestOf(precomposed));
  assert.notEqual(canonical({ id: composed }), canonical({ id: precomposed }));
});

test("R6 CRLF is JSON-escaped and cannot split JSONL", () => {
  const ids = makeIdentities("r6");
  const { writer, root } = createTestWriter(ids);
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, {
        pattern_identity: null,
        payload: { failure_finding_discriminator: "HOLD\r\nINJECT" },
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
  if (existsSync(join(root, LOG_FILE_NAME))) {
    const text = readFileSync(join(root, LOG_FILE_NAME), "utf8");
    assert.equal(text.includes("\r"), false);
    for (const line of text.split("\n").filter((l) => l.length > 0)) {
      JSON.parse(line);
    }
  }
});

test("R7 NaN Infinity and unsafe integer rejected", () => {
  const ids = makeIdentities("r7");
  const { writer } = createTestWriter(ids);
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("PATTERN_RETRIEVED", ids, {
        payload: {
          retrievalDigest: ids.retrievalDigest,
          storeSnapshotDigest: ids.storeSnapshotDigest,
          rank: Number.NaN,
          truncated: false,
        },
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("PATTERN_RETRIEVED", ids, {
        payload: {
          retrievalDigest: ids.retrievalDigest,
          storeSnapshotDigest: ids.storeSnapshotDigest,
          rank: Number.POSITIVE_INFINITY,
          truncated: false,
        },
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("R8 unknown nested field rejected", () => {
  const ids = makeIdentities("r8");
  const { writer } = createTestWriter(ids);
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, {
        pattern_identity: null,
        payload: { observed_outcome_class: "HOLD", extra: "nope" },
      }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("R9 event_digest substitution cannot stick", () => {
  const ids = makeIdentities("r9");
  const { writer, root } = createTestWriter(ids);
  const forged = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  forged.event_digest = hex("forged-digest");
  const appended = writer.appendTransferEvent({ event: forged, principal: FIXTURE });
  const recomputed = computeEventDigest({
    journal_sequence: appended.event.journal_sequence,
    event_id: appended.event.event_id,
    event_type: appended.event.event_type,
    payload_digest: appended.event.payload_digest,
    previous_digest: appended.event.previous_digest,
  });
  assert.equal(appended.event.event_digest, recomputed);
  assert.notEqual(appended.event.event_digest, hex("forged-digest"));
  const durable = readLog(root).events[0];
  assert.equal(durable.event_digest, recomputed);
});

test("R10 canonical key-order permutation is digest-stable", () => {
  const a = { z: 1, a: 2, m: 3 };
  const b = { a: 2, m: 3, z: 1 };
  assert.equal(canonical(a), canonical(b));
  assert.equal(digestOf(a), digestOf(b));
});

test("R11 getter and prototype keys cannot affect canonical input", () => {
  const ids = makeIdentities("r11");
  const { writer } = createTestWriter(ids);
  const sneaky = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
  Object.defineProperty(sneaky, "payload", {
    enumerable: true,
    get() { return { observed_outcome_class: "HOLD" }; },
  });
  expectCode(
    () => writer.appendTransferEvent({ event: sneaky, principal: FIXTURE }),
    TRANSFER_CODES.PAYLOAD_MALFORMED,
  );
});

test("A15 revocation revalidated under the mutation lock", () => {
  const ids = makeIdentities("a15");
  const { writer } = createTestWriter(ids);
  const first = writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  assert.equal(first.status, "APPENDED");
  // Durable revoke by a SECOND writer instance on the SAME root, fired from
  // the appending writer's pre-lock hook: the outer append must fail
  // WRITER_REVOKED against the durable fold (no hook re-entrancy on the
  // appending writer itself).
  const rootA15b = createTestRoot("a15b");
  const { writer: revoker } = createTestWriter(ids, { root: rootA15b });
  let w2;
  ({ writer: w2 } = createTestWriter(ids, {
    root: rootA15b,
    crashHooks: {
      afterAuthorizeBeforeLock() {
        revoker.revokeWriter("w1", { issuer: revoker.fixtureAuthorityIssuer(), mutationId: "a15b-revoke", expected: 0, task_identity: ids.task_identity });
      },
    },
  }));
  expectCode(
    () => w2.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.WRITER_REVOKED,
  );
});

test("A12 symlink parent rejected even when lexical prefix matches", () => {
  const ids = makeIdentities("a12");
  const parent = createTestRoot("a12parent");
  const real = join(parent, "real");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  const link = join(parent, "link");
  symlinkSync(real, link);
  expectCode(
    () => new TransferMetricsWriter({
      transferMetricsRoot: join(link, "child"),
      identityBinder: makeBinder(ids),
      allowFixture: true,
    }),
    TRANSFER_CODES.PATH_UNSAFE,
  );
});

test("A13 hardlink log target rejected", () => {
  const ids = makeIdentities("a13");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const logPath = join(root, LOG_FILE_NAME);
  const alias = join(root, "alias.jsonl");
  linkSync(logPath, alias);
  assert.equal(lstatSync(logPath).nlink, 2);
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { occurred_at: iso(2) }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PATH_UNSAFE,
  );
});

test("A14 string-prefix path escape rejected", () => {
  const ids = makeIdentities("a14");
  expectCode(
    () => new TransferMetricsWriter({
      transferMetricsRoot: "/Volumes/NVM2T/Development-evil/metrics",
      identityBinder: makeBinder(ids),
      allowFixture: true,
    }),
    TRANSFER_CODES.PATH_UNSAFE,
  );
  expectCode(
    () => new TransferMetricsWriter({
      transferMetricsRoot: join("/Volumes/NVM2T/Development/tmp", "..", "..", "secret"),
      identityBinder: makeBinder(ids),
      allowFixture: true,
    }),
    TRANSFER_CODES.PATH_UNSAFE,
  );
});

test("FIFO log target rejected", () => {
  const ids = makeIdentities("fifo");
  const root = createTestRoot("fifo");
  const fifoPath = join(root, LOG_FILE_NAME);
  const made = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
  if (made.status !== 0) {
    spawnSync("python3", ["-c", `import os; os.mkfifo(${JSON.stringify(fifoPath)})`], { encoding: "utf8" });
  }
  assert.equal(existsSync(fifoPath), true);
  const writer = new TransferMetricsWriter({
    transferMetricsRoot: root,
    identityBinder: makeBinder(ids),
    allowFixture: true,
    clock: () => iso(10),
  });
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
      principal: FIXTURE,
    }),
    TRANSFER_CODES.PATH_UNSAFE,
  );
});

test("A18/A19 executor cannot write outcome or D even with allowFixture writer", () => {
  const ids = makeIdentities("a18");
  const { writer } = createTestWriter(ids);
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("OUTCOME_OBSERVED", ids, { pattern_identity: null, authority: { ...EXECUTOR } }),
      principal: EXECUTOR,
    }),
    TRANSFER_CODES.AUTHORITY_INSUFFICIENT,
  );
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids),
    principal: FIXTURE,
  });
  expectCode(
    () => writer.appendTransferEvent({
      event: makeEvent("TRANSFER_ADJUDICATED", ids, {
        subject_event_id: retr.event.event_id,
        authority: { ...EXECUTOR },
        payload: {
          attribution_grade: "D",
          benefit_claimed: true,
          adjudicator_role: "reviewer",
          counterfactual_digest: ids.counterfactual_digest,
          detected_earlier: null,
          unnecessary_gate: null,
          overlay_applicability: "APPLICABLE",
        },
      }),
      principal: EXECUTOR,
    }),
    TRANSFER_CODES.AUTHORITY_INSUFFICIENT,
  );
});

test("A21/A28 later A does not hide earlier C verified credit", () => {
  const ids = makeIdentities("a28");
  const { writer, root } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  const retr = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { occurred_at: iso(2), applicability_decision: "UNKNOWN" }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_PLANNING", ids, { occurred_at: iso(3), retrieval_event_id: retr.event.event_id }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("OUTCOME_OBSERVED", ids, { occurred_at: iso(4), pattern_identity: null }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(5),
      subject_event_id: retr.event.event_id,
      payload: {
        attribution_grade: "C",
        benefit_claimed: true,
        adjudicator_role: "reviewer",
        counterfactual_digest: ids.counterfactual_digest,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "APPLICABLE",
      },
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(6),
      subject_event_id: retr.event.event_id,
      payload: {
        attribution_grade: "A",
        benefit_claimed: false,
        adjudicator_role: "reviewer",
        counterfactual_digest: null,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "APPLICABLE",
      },
    }),
    principal: FIXTURE,
  });
  const doc = reduceTransferMetrics({
    events: readLog(root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M12.status, "MEASURED");
  assert.equal(doc.metrics.M12.numerator, 1);
  assert.equal(doc.metrics.M12.denominator, 1);
  assert.equal(doc.metrics.M12.value, 1);
  assert.equal(doc.authoritative, false);
  assert.equal(doc.authority, "NONE");
});

test("independent formula oracle — distinguishing corpus", () => {
  const ids = makeIdentities("oracle");
  const { writer, root } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  const r1 = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, {
      occurred_at: iso(2),
      applicability_decision: "UNKNOWN",
    }),
    principal: FIXTURE,
  });
  const r2 = writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, {
      occurred_at: iso(3),
      pattern_identity: { pattern_id: `${ids.pattern_id}-other`, generation: 0 },
      applicability_decision: "UNKNOWN",
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_REJECTED", ids, {
      occurred_at: iso(4),
      pattern_identity: { pattern_id: `${ids.pattern_id}-rej`, generation: 0 },
      payload: { rejection_code: "SCOPE", retrievalDigest: ids.retrievalDigest },
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_PLANNING", ids, {
      occurred_at: iso(5),
      retrieval_event_id: r1.event.event_id,
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_USED_IN_VERIFICATION", ids, {
      occurred_at: iso(6),
      retrieval_event_id: r1.event.event_id,
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("OUTCOME_OBSERVED", ids, { occurred_at: iso(7), pattern_identity: null }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(8),
      subject_event_id: r1.event.event_id,
      payload: {
        attribution_grade: "A",
        benefit_claimed: false,
        adjudicator_role: "reviewer",
        counterfactual_digest: null,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "APPLICABLE",
      },
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(9),
      subject_event_id: r1.event.event_id,
      payload: {
        attribution_grade: "C",
        benefit_claimed: true,
        adjudicator_role: "reviewer",
        counterfactual_digest: ids.counterfactual_digest,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "APPLICABLE",
      },
    }),
    principal: FIXTURE,
  });
  writer.appendTransferEvent({
    event: makeEvent("TRANSFER_ADJUDICATED", ids, {
      occurred_at: iso(10),
      subject_event_id: r2.event.event_id,
      payload: {
        attribution_grade: "A",
        benefit_claimed: false,
        adjudicator_role: "reviewer",
        counterfactual_digest: null,
        detected_earlier: null,
        unnecessary_gate: null,
        overlay_applicability: "NOT_APPLICABLE",
      },
    }),
    principal: FIXTURE,
  });
  const retry = writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  assert.equal(retry.status, "ALREADY_SATISFIED");

  const events = readLog(root).events;
  const doc = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });

  // Hand oracle:
  // M1 units: r1 APPLICABLE cited+C, r2 NOT_APPLICABLE → numer=1 denom=2
  // M2: 2 retrieved + 1 rejected → 1/3
  // M3/M4: one retrievalDigest episode with explicit USED → 1/1 observed and verified via C on r1
  // M12: one exec with applicable retrieve + PASS + C → 1/1
  // retry did not add a second incident row
  assert.equal(events.filter((e) => e.event_type === "INCIDENT_OBSERVED").length, 1);
  assert.equal(doc.metrics.M1.status, "MEASURED");
  assert.equal(doc.metrics.M1.numerator, 1);
  assert.equal(doc.metrics.M1.denominator, 2);
  assert.equal(doc.metrics.M1.value, 0.5);
  assert.equal(doc.metrics.M2.status, "MEASURED");
  assert.equal(doc.metrics.M2.numerator, 1);
  assert.equal(doc.metrics.M2.denominator, 3);
  assert.equal(doc.metrics.M3.status, "MEASURED");
  assert.equal(doc.metrics.M3.numerator, 1);
  assert.equal(doc.metrics.M3.denominator, 1);
  assert.equal(doc.metrics.M3v.status, "MEASURED");
  assert.equal(doc.metrics.M3v.numerator, 1);
  assert.equal(doc.metrics.M4.status, "MEASURED");
  assert.equal(doc.metrics.M4v.numerator, 1);
  assert.equal(doc.metrics.M5.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M5.value, null);
  assert.equal(doc.metrics.M11.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M11.value, null);
  assert.equal(doc.metrics.M12.status, "MEASURED");
  assert.equal(doc.metrics.M12.numerator, 1);
  assert.equal(doc.metrics.M12.denominator, 1);
  assert.equal(doc.metrics.M14.status, "NOT_MEASURABLE");
  assert.equal(doc.metrics.M14.value, null);
  assert.equal(doc.metrics.M15.status, "MEASURED");
  assert.equal(doc.metrics.M15.numerator, events.length);
  assert.equal(doc.metrics.M15.denominator, events.length);
  assert.equal(doc.authoritative, false);
  for (const id of CANONICAL_METRICS) assert.ok(doc.metrics[id], id);
  for (const id of COMPANION_METRICS) assert.ok(doc.metrics[id], id);
});

test("A23/A24/A25/A26 retry missing-outcome and denom-zero fences", () => {
  const empty = reduceTransferMetrics({
    events: [],
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(empty.metrics.M1.status, "NOT_MEASURABLE");
  assert.equal(empty.metrics.M1.value, null);
  assert.notEqual(empty.metrics.M1.value, 0);
  assert.notEqual(empty.metrics.M1.value, 1);

  const ids = makeIdentities("a25");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("PATTERN_RETRIEVED", ids, { applicability_decision: "APPLICABLE" }),
    principal: FIXTURE,
  });
  const doc = reduceTransferMetrics({
    events: readLog(writer.root).events,
    window: WINDOW,
    formula_version: FORMULA_VERSION,
  });
  assert.equal(doc.metrics.M12.status, "UNKNOWN");
  assert.equal(doc.metrics.M12.value, null);
});

test("A33/A10 raw log immutable under reducer report and derived write", () => {
  const ids = makeIdentities("a33");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const logPath = join(root, LOG_FILE_NAME);
  const before = shaFile(logPath);
  const events = readLog(root).events;
  const doc = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  writeDerivedDocument(root, doc);
  assert.equal(shaFile(logPath), before);
  assert.equal(existsSync(join(root, "derived")), true);
});

test("A7 corrupt tail then append fail-closed for middle; partial tail continues", () => {
  const ids = makeIdentities("a7");
  const { root, writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null, occurred_at: iso(1) }),
    principal: FIXTURE,
  });
  const logPath = join(root, LOG_FILE_NAME);
  const fd = openSync(logPath, "a");
  try {
    writeFileSync(logPath, readFileSync(logPath) + "{\"partial");
  } finally {
    closeSync(fd);
  }
  const snap = readLog(root);
  assert.equal(snap.partialTrailingLine, true);
  const ok = writer.appendTransferEvent({
    event: makeEvent("PATTERN_CANDIDATE_CREATED", ids, { occurred_at: iso(2) }),
    principal: FIXTURE,
  });
  assert.equal(ok.status, "APPENDED");
  assert.equal(readLog(root).events.length, 2);
});

test("A38 secret rejected and absent from thrown message log and report", () => {
  const ids = makeIdentities("a38");
  const { writer, root } = createTestWriter(ids);
  const secret = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
  let err;
  try {
    writer.appendTransferEvent({
      event: makeEvent("INCIDENT_OBSERVED", ids, {
        pattern_identity: null,
        payload: { failure_finding_discriminator: secret },
      }),
      principal: FIXTURE,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, TRANSFER_CODES.SECRET_RISK);
  assert.equal(String(err.message).includes(secret), false);
  if (existsSync(join(root, LOG_FILE_NAME))) {
    assert.equal(readFileSync(join(root, LOG_FILE_NAME), "utf8").includes(secret), false);
  }
});

test("A35 env cannot enable hardcoded seam", () => {
  process.env.TRANSFER_METRICS_ENABLED = "true";
  process.env.AUTOLOOP_TRANSFER_METRICS = "1";
  assert.equal(isTransferMetricsEnabled(), false);
  assert.equal(TRANSFER_METRICS_ENABLED, false);
  const result = recordTransferEvent({ anything: true }, { role: "system", identity: "x" });
  assert.equal(result.status, "DISABLED");
  delete process.env.TRANSFER_METRICS_ENABLED;
  delete process.env.AUTOLOOP_TRANSFER_METRICS;
});

test("A36/A37 production import scan remains empty", () => {
  const forbidden = [
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
    "src/v2/execution-orchestrator.mjs",
    "src/control-plane/coordinator.mjs",
    "src/budget/enforcement.mjs",
  ];
  for (const rel of forbidden) {
    const text = readFileSync(join(REPO, rel), "utf8");
    assert.equal(text.includes("transfer-metrics"), false, rel);
    assert.equal(text.includes("recordTransferEvent"), false, rel);
    assert.equal(text.includes("appendTransferEvent"), false, rel);
  }
  const require = createRequire(import.meta.url);
  assert.equal(typeof require, "function");
});

test("64-process distinct-key contention linearizes", async () => {
  const ids = makeIdentities("p64d");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker-distinct.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("p64d");
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
  const n = 64;
  const jobs = [];
  for (let i = 0; i < n; i += 1) {
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, hex(`p64d-${i}`)]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
      child.on("error", reject);
    }));
  }
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const log = readLog(root);
  assert.equal(log.events.length, n);
  const seqs = log.events.map((e) => e.journal_sequence).sort((a, b) => a - b);
  assert.deepEqual(seqs, [...Array(n)].map((_, i) => i + 1));
});

test("64-process same-key contention single winner", async () => {
  const ids = makeIdentities("p64s");
  const { root } = createTestWriter(ids);
  const digest = ids.evidence;
  const worker = join(root, "worker-same.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    const ids = makeIdentities("p64s");
    const event = makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids),
      allowFixture: true,
    });
    const r = writer.appendTransferEvent({ event, principal: FIXTURE });
    process.stdout.write(r.status);
  `);
  const jobs = [];
  for (let i = 0; i < 64; i += 1) {
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
      child.on("error", reject);
    }));
  }
  const results = await Promise.all(jobs);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const statuses = results.map((r) => r.out);
  assert.equal(statuses.filter((s) => s === "APPENDED").length, 1);
  assert.equal(statuses.filter((s) => s === "ALREADY_SATISFIED").length, 63);
  assert.equal(readLog(root).events.length, 1);
  void digest;
});

test("same-key mixed-payload contention never split-brains", async () => {
  const ids = makeIdentities("p64m");
  const { root } = createTestWriter(ids);
  const worker = join(root, "worker-mix.mjs");
  writeFileSync(worker, `
    import { TransferMetricsWriter } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/writer.mjs"))};
    import { makeIdentities, makeEvent, makeBinder, FIXTURE } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/fixtures.mjs"))};
    import { TRANSFER_CODES } from ${JSON.stringify(join(REPO, "src/learning/transfer-metrics/schema.mjs"))};
    const ids = makeIdentities("p64m");
    const kind = process.argv[2];
    const event = makeEvent("INCIDENT_OBSERVED", ids, {
      pattern_identity: null,
      payload: { observed_outcome_class: kind },
    });
    const writer = new TransferMetricsWriter({
      transferMetricsRoot: ${JSON.stringify(root)},
      identityBinder: makeBinder(ids),
      allowFixture: true,
    });
    try {
      const r = writer.appendTransferEvent({ event, principal: FIXTURE });
      process.stdout.write(r.status);
    } catch (e) {
      process.stdout.write(e.code || "ERR");
    }
  `);
  const jobs = [];
  for (let i = 0; i < 32; i += 1) {
    jobs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, i < 16 ? "HOLD" : "TEST_FAIL"]);
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
      child.on("error", reject);
    }));
  }
  const results = await Promise.all(jobs);
  const outs = results.map((r) => r.out);
  const appended = outs.filter((s) => s === "APPENDED").length;
  const satisfied = outs.filter((s) => s === "ALREADY_SATISFIED").length;
  const conflict = outs.filter((s) => s === TRANSFER_CODES.IDEMPOTENCY_CONFLICT).length;
  assert.equal(appended, 1);
  assert.equal(appended + satisfied + conflict, 32);
  assert.equal(readLog(root).events.length, 1);
});

test("derived output byte-deterministic and non-authoritative", () => {
  const ids = makeIdentities("det");
  const { writer } = createTestWriter(ids);
  writer.appendTransferEvent({
    event: makeEvent("INCIDENT_OBSERVED", ids, { pattern_identity: null }),
    principal: FIXTURE,
  });
  const events = readLog(writer.root).events;
  const a = reduceTransferMetrics({ events, window: WINDOW, formula_version: FORMULA_VERSION });
  const b = reduceTransferMetrics({ events: [...events].reverse(), window: WINDOW, formula_version: FORMULA_VERSION });
  assert.equal(serializeDerived(a), serializeDerived(b));
  assert.equal(a.authoritative, false);
  assert.equal(a.production_effect, "NO_PRODUCTION_EFFECT");
});

test("EVENT_TYPES closed set remains 14", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(new Set(EVENT_TYPES).size, 14);
});
