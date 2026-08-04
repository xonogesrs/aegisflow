// test/test-run-evidence-store.mjs
//
// C3 — durable evidence store tests（journal hash chain, secret policy,
// root safety, owner-only perms）. Offline only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync, readdirSync, symlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { RunEvidenceStore, canonicalJson, sha256Text, redactFreeText, scanForSecrets, EvidenceHoldError, journalFileName, DEFAULT_MAX_FREE_TEXT_BYTES } from "../src/evidence/run-evidence-store.mjs";
import { assertValidEvidenceRoot } from "../src/evidence/run-evidence-store.mjs";
import { validateRunIdentity } from "../src/v2/checkpoint-bridge.mjs";
import { mintExecutionId } from "../src/c2d/execution-id.mjs";
import { writeExclusiveCreate } from "../src/c2d/fs-atomic.mjs";

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "c3-evidence-"));
  execFileSync("git", ["init", "-b", "master"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeStore(root, repoRoot) {
  const { executionId, chainId, checkpointId } = validateRunIdentity(mintExecutionId());
  const store = new RunEvidenceStore({ root, executionId, chainId, checkpointId, repoRoot });
  store.init();
  return { store, executionId };
}

test("1: execution directory is owner-only (0700)", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-root-"));
  try {
    const { store } = makeStore(root, null);
    const mode = statSync(store.execDir).mode;
    assert.equal(mode & 0o077, 0, "no group/world permissions");
    assert.ok((mode & 0o700) === 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("2: evidence root inside the repository is rejected", () => {
  const repo = gitFixture();
  try {
    const root = join(repo, "evidence");
    mkdirSync(root);
    assert.throws(() => assertValidEvidenceRoot(root, repo), (e) => e && e.code === "PERSISTENCE_ROOT_INVALID");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("3: symlink evidence root is rejected", () => {
  const base = mkdtempSync(join(tmpdir(), "c3-sym-"));
  try {
    const target = join(base, "target");
    mkdirSync(target);
    const link = join(base, "link");
    symlinkSync(target, link);
    assert.throws(() => assertValidEvidenceRoot(link, null));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("4: journal sequence + hash chain are correct", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-jrn-"));
  try {
    const { store } = makeStore(root, null);
    store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: { a: 1 } });
    store.appendEvent({ event_type: "INPUT_FROZEN", stage: "input", payload: { b: "x" } });
    const v = store.verifyJournal();
    assert.equal(v.count, 2);
    assert.equal(v.head, store.journalHead.sha256);
    const e1 = store.readEvent(1).event;
    assert.equal(e1.sequence, 1);
    assert.equal(e1.previous_event_sha256, "genesis");
    const e2 = store.readEvent(2).event;
    assert.equal(e2.previous_event_sha256, e1.event_sha256, "hash chain links events");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("5: journal overwrite of an existing sequence is rejected", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-owr-"));
  try {
    const { store } = makeStore(root, null);
    store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: {} });
    const path = join(store.execDir, "journal", journalFileName(1));
    assert.throws(
      () => writeExclusiveCreate(path, canonicalJson({ forged: true }) + "\n"),
      (e) => e && (e.code === "JOURNAL_OUT_OF_ORDER" || /JOURNAL_OUT_OF_ORDER/.test(String(e.code))),
      "exclusive create must refuse to overwrite sequence 1",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("6: journal gap is detected", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-gap-"));
  try {
    const { store } = makeStore(root, null);
    store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: {} });
    // Manually place a seq-3 file（skipping seq 2）with a valid self-hash.
    const forged = {
      format_version: "1.0.0", sequence: 3, event_id: "evt_forged",
      execution_id: store.executionId, chain_id: store.chainId, timestamp: new Date().toISOString(),
      event_type: "FORGED", stage: null, phase_id: null, attempt: null, status: null,
      previous_event_sha256: store.journalHead.sha256, payload_sha256: sha256Text(canonicalJson({})),
      payload: {},
    };
    forged.event_sha256 = sha256Text(canonicalJson({ ...forged, event_sha256: undefined }) + "\n");
    writeFileSync(join(store.execDir, "journal", journalFileName(3)), canonicalJson(forged) + "\n");
    // seq 2 is missing → the chain must fail closed.
    assert.throws(() => store.verifyJournal(), (e) => e && e.code === "JOURNAL_INTEGRITY_FAILURE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("7: journal payload tamper is detected", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-tmp-"));
  try {
    const { store } = makeStore(root, null);
    store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: { original: "yes" } });
    const path = join(store.execDir, "journal", journalFileName(1));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.payload = { original: "NO - tampered" };
    writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
    assert.throws(() => store.verifyJournal(), (e) => e && e.code === "JOURNAL_INTEGRITY_FAILURE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("30: secret-like payload is never persisted", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-sec-"));
  try {
    const { store } = makeStore(root, null);
    assert.throws(
      () => store.appendEvent({ event_type: "X", stage: "s", payload: { note: "the key is sk-abcdefghijklmnopqrstuvwxyz123456" } }),
      (e) => e && e.code === "DURABLE_EVIDENCE_SECRET_RISK",
    );
    assert.throws(
      () => store.writeArtifact("leak.json", { token: "ghp_abcdefghijklmnopqrstuvwxyz123456" }),
      (e) => e && e.code === "DURABLE_EVIDENCE_SECRET_RISK",
    );
    // Nothing beyond the store scaffolding may have been written.
    const files = readdirSync(join(store.execDir, "journal"));
    assert.equal(files.length, 0, "no journal event may be persisted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("31: oversized free text is safely handled (truncation metadata / fail-closed)", () => {
  const root = mkdtempSync(join(tmpdir(), "c3-big-"));
  try {
    const { store } = makeStore(root, null);
    const big = "x".repeat(DEFAULT_MAX_FREE_TEXT_BYTES + 10_000);
    const evt = store.appendEvent({ event_type: "RUN_CREATED", stage: "run", payload: { blob: big } });
    assert.equal(evt.redaction.truncated, true, "truncation is recorded with metadata");
    assert.ok(Buffer.byteLength(evt.payload.blob, "utf8") <= DEFAULT_MAX_FREE_TEXT_BYTES, "persisted payload stays within budget");
    // Artifacts fail closed rather than silently truncate.
    assert.throws(
      () => store.writePhaseArtifact("p", "result.json", { blob: big }),
      (e) => e && e.code === "DURABLE_EVIDENCE_SECRET_RISK",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("redaction primitives: control characters rejected, scans classify only", () => {
  assert.throws(() => redactFreeText("line\x01break"), (e) => e && e.code === "DURABLE_EVIDENCE_SECRET_RISK");
  const scan = scanForSecrets("creds: sk-abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(scan.safe, false);
  assert.deepEqual(scan.matches, ["sk_key"]);
  assert.equal(scanForSecrets("plain text").safe, true);
});
