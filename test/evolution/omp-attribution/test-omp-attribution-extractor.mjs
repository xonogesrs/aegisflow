// test/evolution/omp-attribution/test-omp-attribution-extractor.mjs
//
// AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1 — acceptance suite for the v1
// OMP session extractor. Everything runs against mkdtemp fixtures with an
// injected clock and an injected lsof: no real ~/.omp, no real evolution store,
// no network, no sleeps.
//
// Fake credentials are assembled at RUNTIME from fragments so that no
// secret-shaped literal lives in this repository.
//
// Run: node --test test/evolution/omp-attribution/test-omp-attribution-extractor.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync, chmodSync, existsSync, linkSync, statSync, rmSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  symlinkSync, truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { createHash } from "node:crypto";
import { clearInjectionHooks, setInjectionHook } from "../../../src/c2d/fs-atomic.mjs";
import { evolutionSuspensionPath, suspendEvolution } from "../../../src/evolution/kill-switch.mjs";
import {
  LIMITS, OMP_OBSERVATION_SCHEMA, validateObservation, observationIdFor,
} from "../../../src/evolution/omp-attribution/contract.mjs";
import {
  classifyLsofResult, cwdDecision, normalizeFsPath, observeSessionFile, readSessionBytes,
} from "../../../src/evolution/omp-attribution/extract.mjs";
import { KEY_ERRORS } from "../../../src/evolution/omp-attribution/cwd-key.mjs";
import {
  countObservationFiles, listTrustedObservations, paths, runIngest,
} from "../../../src/evolution/omp-attribution/ingest.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(REPO, "scripts", "omp-session-attribution.mjs");

const FAKE = Object.freeze({
  sk: "sk-" + "A".repeat(24),
  gh: "gh" + "p_" + "B".repeat(30),
  aws: "AK" + "IA" + "C".repeat(16),
  bearer: "Authorization: Bearer " + "D".repeat(24),
});
const ALL_FAKES = Object.values(FAKE);

const CWD = "/work/aegis-fixture";
const U1 = "01a176f5-93f4-7105-b221-def658434a45";
const U2 = "02b287a6-a4a5-7216-c332-efa769545b56";
const U3 = "03c398b7-b5b6-7327-d443-f0b87a656c67";
const U4 = "04d4a9c8-c6c7-7438-e554-01c98b767d78";
const MIN = 60_000;

function mkEnv() {
  const root = mkdtempSync(join(tmpdir(), "omp-attr-"));
  const store = join(root, "store");
  const sessions = join(root, "sessions");
  mkdirSync(store, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  return { root, store, sessions };
}

function entriesFor(uuid, { cwd = CWD, model = "model-a", extra = [] } = {}) {
  return [
    { type: "session", id: uuid, cwd, timestamp: "2026-10-26T06:00:00.000Z", version: 3 },
    { type: "model_change", id: "aaaa0001", model: `vendor/${model}`, resolvedModelIsFallback: false },
    { type: "message", id: "aaaa0002", message: { role: "user", content: `please use ${FAKE.sk} and ${FAKE.gh}` } },
    {
      type: "message", id: "aaaa0003",
      message: {
        role: "assistant", provider: "vendor", model, stopReason: "toolUse", duration: 1200.4,
        usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, reasoningTokens: 7 },
        content: [{ type: "text", text: `leak ${FAKE.aws}` }, { type: "toolCall", name: "read" }, { type: "toolCall", name: "bash" }],
        providerPayload: { header: FAKE.bearer },
      },
    },
    { type: "message", id: "aaaa0004", message: { role: "toolResult", toolName: "read", isError: false, content: FAKE.sk } },
    { type: "message", id: "aaaa0005", message: { role: "toolResult", toolName: "bash", isError: true, content: "boom" } },
    {
      type: "message", id: "aaaa0006",
      message: { role: "assistant", provider: "vendor", model, stopReason: "stop", duration: 800, usage: { input: 50, output: 10, totalTokens: 60 }, content: [] },
    },
    ...extra,
  ];
}

/** Real OMP files start with a `title` entry; the `session` header is line 2. */
function withTitleFirst(entries) {
  return [{ type: "title", title: "fixture title", source: "auto", updatedAt: 1, v: 1, pad: "" }, ...entries];
}

function fileNameFor(uuid) { return `2026-10-26T06-00-00-000Z_${uuid}.jsonl`; }

/** Write a session fixture; mtime is set `ageMs` before `clockNow`. */
function putSession(env, entries, { uuid, slug = "-work-aegis-fixture", ageMs = 180 * MIN, clockNow }) {
  const dir = join(env.sessions, slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileNameFor(uuid));
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const t = new Date(clockNow - ageMs);
  utimesSync(file, t, t);
  return file;
}

/** Default per-store key location: outside the store, parent dir pre-created. */
function keyPathFor(env) {
  const dir = join(env.root, "keys");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, "omp.key");
}

function run(env, { write = false, now, lsof = () => "not_held", fault = null, envVars = {}, allow = [CWD], deny = [], keyFile } = {}) {
  return runIngest({
    storeRoot: env.store, sessionsRoot: env.sessions, allowRoots: allow, denyRoots: deny,
    write, nowMs: () => now, lsof, synthetic: true, env: envVars, fault,
    keyFile: keyFile === undefined ? keyPathFor(env) : keyFile,
  });
}

const dispOf = (report, uuid) => report.results.find((r) => r.session_id === uuid)?.disposition;

function treeText(dir) {
  let out = "";
  const walk = (d) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p); else out += `\n${p}\n${readFileSync(p, "utf8")}`;
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

function snapshot(dir) {
  const list = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else list.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return list.sort();
}

/** Drive a session from first sight to RECORDED with two write runs. */
function recordOnce(env, uuid, T0, extraOpts = {}) {
  const first = run(env, { write: true, now: T0, ...extraOpts });
  const second = run(env, { write: true, now: T0 + 31 * MIN, ...extraOpts });
  return { first, second };
}

// ── A: contract ─────────────────────────────────────────────────────────────

test("A1 a recorded observation satisfies the closed v1 schema and is UNVERIFIED", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const { first, second } = recordOnce(env, U1, T0);
  assert.equal(dispOf(first, U1), "PENDING_FIRST_OBSERVATION");
  assert.equal(dispOf(second, U1), "RECORDED");
  const [o] = listTrustedObservations(env.store);
  assert.equal(o.schema, OMP_OBSERVATION_SCHEMA);
  assert.equal(o.outcome, "UNVERIFIED");
  assert.equal(o.task_class, "OMP_GENERAL");
  assert.equal(o.evidence_class, "OBSERVED_NATIVE_SESSION");
  assert.equal(o.synthetic, true);
  assert.equal(o.observation_id, observationIdFor(U1));
  assert.ok(validateObservation(o).ok);
});

test("A2 the schema is closed: extra keys, VERIFIED outcomes and bad tokens are refused", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.ok(!validateObservation({ ...o, extra: 1 }).ok);
  assert.ok(!validateObservation({ ...o, outcome: "VERIFIED_PASS" }).ok);
  assert.ok(!validateObservation({ ...o, outcome: "PASS" }).ok);
  assert.ok(!validateObservation({ ...o, model: { ...o.model, models: ["has space"] } }).ok);
  assert.ok(!validateObservation({ ...o, cwd_ref: { ...o.cwd_ref, allowlisted: false } }).ok);
  assert.ok(!validateObservation({ ...o, source: { ...o.source, session_id: "not-a-uuid" } }).ok);
  // Credential-shaped values satisfy the token regex; the validator's own scan
  // (independent of the extractor's raw-value scan) must still refuse them.
  assert.ok(validateObservation({ ...o, model: { ...o.model, models: [FAKE.gh] } }).errors.includes("sensitive_pattern"));
  assert.ok(validateObservation({ ...o, tools: { ...o.tools, counts: { [FAKE.sk]: 1 } } }).errors.includes("sensitive_pattern"));
});

test("A3 extraction is faithful: counts, usage, tools, errors, strategy projection", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.deepEqual(o.model.providers, ["vendor"]);
  assert.deepEqual(o.model.models.sort(), ["model-a", "vendor/model-a"]);
  assert.equal(o.model.fallback_used, false);
  assert.deepEqual(o.tools.counts, { bash: 1, read: 1 });
  assert.equal(o.usage.assistant_messages, 2);
  assert.equal(o.usage.input_tokens, 150);
  assert.equal(o.usage.output_tokens, 30);
  assert.equal(o.usage.total_tokens, 185);
  assert.equal(o.usage.reasoning_tokens, 7);
  assert.equal(o.usage.duration_ms, 2000);
  assert.deepEqual(o.stop_reasons, { stop: 1, toolUse: 1 });
  assert.deepEqual(o.errors, { tool_results: 2, tool_result_errors: 1 });
  assert.equal(o.strategy_projection.MODEL_ROUTING, "vendor/model-a");
  assert.match(o.strategy_projection.TOOL_SELECTION, /^toolset_[0-9a-f]{12}$/);
  for (const d of ["DECOMPOSITION", "FANOUT_PARALLELISM", "RETRY_REPAIR", "CONTEXT_ALLOCATION"]) {
    assert.equal(o.strategy_projection[d], null, `${d} must not be fabricated`);
  }
});

test("A4 a session that ended cleanly is still UNVERIFIED (end != success)", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 }); // last stopReason is "stop"
  recordOnce(env, U1, T0);
  for (const o of listTrustedObservations(env.store)) assert.equal(o.outcome, "UNVERIFIED");
});

// ── B: privacy ──────────────────────────────────────────────────────────────

test("B1 prompt/output/providerPayload secrets never reach observation, state, report or store", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const { first, second } = recordOnce(env, U1, T0);
  const everything = treeText(env.store) + JSON.stringify(first) + JSON.stringify(second);
  for (const f of ALL_FAKES) assert.ok(!everything.includes(f), "a fake credential leaked");
  assert.ok(!everything.includes("please use"), "prompt text leaked");
  assert.ok(!everything.includes("boom"), "tool output leaked");
});

test("B2 a credential-shaped tool or model name drops the WHOLE record", () => {
  for (const [label, mutate] of [
    ["tool", (e) => e[3].message.content.push({ type: "toolCall", name: FAKE.gh })],
    ["model", (e) => { e[3].message.model = FAKE.sk; }],
    ["provider", (e) => { e[3].message.provider = FAKE.aws; }],
  ]) {
    const env = mkEnv();
    const T0 = Date.now();
    const entries = entriesFor(U1);
    mutate(entries);
    putSession(env, entries, { uuid: U1, clockNow: T0 });
    const { second } = recordOnce(env, U1, T0);
    assert.equal(dispOf(second, U1), "EXCLUDED", label);
    assert.equal(second.results[0].reason, "sensitive_pattern", label);
    assert.equal(countObservationFiles(env.store), 0, label);
    for (const f of ALL_FAKES) assert.ok(!treeText(env.store).includes(f), label);
  }
});

test("B3 non-token names are bucketed, never kept; session id must be a UUID matching the file name", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const entries = entriesFor(U1);
  entries[3].message.content.push({ type: "toolCall", name: "has space & symbols" });
  entries[3].message.provider = "bad provider!";
  putSession(env, entries, { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.equal(o.tools.other_count, 1);
  assert.ok(o.model.other_count >= 1);
  assert.ok(!JSON.stringify(o).includes("has space"));

  const env2 = mkEnv();
  const bad = entriesFor(U1);
  bad[0].id = U2; // header id != file name uuid
  putSession(env2, bad, { uuid: U1, clockNow: T0 });
  assert.equal(dispOf(run(env2, { now: T0 }), U1), "EXCLUDED");
});

test("B4 cwd is stored only as a hash; cwd allowlist and deny roots decide", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1, { cwd: `${CWD}/sub` }), { uuid: U1, clockNow: T0 });
  putSession(env, entriesFor(U2, { cwd: "/elsewhere/proj" }), { uuid: U2, clockNow: T0, slug: "-elsewhere" });
  putSession(env, entriesFor(U3, { cwd: "/tmp/scratch" }), { uuid: U3, clockNow: T0, slug: "-tmp" });
  const r1 = run(env, { write: true, now: T0, allow: [CWD, "/tmp"], deny: ["/private/tmp"] });
  const r2 = run(env, { write: true, now: T0 + 31 * MIN, allow: [CWD, "/tmp"], deny: ["/private/tmp"] });
  assert.equal(dispOf(r2, U1), "RECORDED");
  assert.equal(r2.results.find((r) => r.session_id === U2).reason, "cwd_not_allowlisted");
  assert.equal(r2.results.find((r) => r.session_id === U3).reason, "cwd_denied", "/tmp must be normalised to /private/tmp");
  const text = treeText(env.store) + JSON.stringify(r1);
  assert.ok(!text.includes("/work/aegis-fixture"));
  assert.ok(!text.includes("elsewhere"), "a non-allowlisted session must leave no trace");
  assert.equal(normalizeFsPath("/tmp/x"), "/private/tmp/x");
  assert.equal(cwdDecision({ cwd: CWD, allowRoots: [], denyRoots: [] }).ok, false);
});

// ── C: input boundary ───────────────────────────────────────────────────────

test("C1 symlinks, hardlinks, odd names and subagent files are never read", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const real = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });

  const outside = mkdtempSync(join(tmpdir(), "omp-attr-out-"));
  const outFile = join(outside, fileNameFor(U2));
  writeFileSync(outFile, entriesFor(U2).map((e) => JSON.stringify(e)).join("\n") + "\n");
  const dir = join(env.sessions, "-work-aegis-fixture");
  symlinkSync(outFile, join(dir, fileNameFor(U2)));                         // file symlink out
  symlinkSync(outside, join(env.sessions, "-linked-slug"));                 // slug symlink out
  linkSync(real, join(dir, fileNameFor(U3)));                               // hardlink alias
  writeFileSync(join(dir, "not-a-session.jsonl"), "{}\n");                  // odd name
  mkdirSync(join(dir, `2026-10-26T06-00-00-000Z_${U1}`), { recursive: true }); // subagent dir
  writeFileSync(join(dir, `2026-10-26T06-00-00-000Z_${U1}`, "Reviewer.jsonl"), "{}\n");

  putSession(env, entriesFor(U4), { uuid: U4, clockNow: T0, slug: "-control" });
  const r = run(env, { now: T0 });
  const seen = r.results.map((x) => x.session_id);
  assert.ok(!seen.includes(U2), "a symlinked file or symlinked slug dir must not be listed at all");
  // Both names of a hardlinked pair have nlink 2: BOTH are refused.
  for (const u of [U1, U3]) {
    assert.equal(r.results.find((x) => x.session_id === u)?.disposition, "EXCLUDED");
    assert.equal(r.results.find((x) => x.session_id === u)?.reason, "hardlink");
  }
  // A plain control file is processed normally.
  assert.equal(r.results.find((x) => x.session_id === U4)?.disposition, "PENDING_FIRST_OBSERVATION");
  // The odd name, the subagent file and both symlinks are never discovered.
  assert.equal(r.results.length, 3);
});

test("C1b a file reached through a symlinked parent directory is refused as path_escape", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const outside = mkdtempSync(join(tmpdir(), "omp-attr-out-"));
  writeFileSync(join(outside, fileNameFor(U1)), entriesFor(U1).map((e) => JSON.stringify(e)).join("\n") + "\n");
  symlinkSync(outside, join(env.sessions, "-escape"));
  const direct = observeSessionFile(join(env.sessions, "-escape", fileNameFor(U1)), { sessionsRoot: env.sessions });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, "path_escape");
  const viaSymlinkedFile = (() => {
    const dir = join(env.sessions, "-real");
    mkdirSync(dir);
    symlinkSync(join(outside, fileNameFor(U1)), join(dir, fileNameFor(U2)));
    return observeSessionFile(join(dir, fileNameFor(U2)), { sessionsRoot: env.sessions });
  })();
  assert.equal(viaSymlinkedFile.reason, "symlink");
  assert.equal(run(env, { now: T0 }).results.length, 0, "discovery must not follow either link");
});

test("C2 oversize files and an empty allowlist fail closed", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const big = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  truncateSync(big, LIMITS.MAX_FILE_BYTES + 1); // sparse: cheap
  const r = run(env, { now: T0 });
  assert.equal(r.results[0].disposition, "EXCLUDED");
  assert.equal(r.results[0].reason, "too_large");
  assert.throws(() => run(env, { now: T0, allow: [] }), /allowlist is empty/);
  assert.throws(() => runIngest({ storeRoot: join(env.root, "missing"), sessionsRoot: env.sessions, allowRoots: [CWD] }), /store root does not exist/);
});

test("C3 a file that changes while it is read is excluded, not recorded", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  const r = run(env, {
    write: true, now: T0 + 31 * MIN,
    fault: (step) => { if (step === "after_read") appendFileSync(file, JSON.stringify({ type: "custom", id: "zz000001" }) + "\n"); },
  });
  assert.equal(dispOf(r, U1), "EXCLUDED");
  assert.equal(r.results[0].reason, "changed_during_read");
  assert.equal(countObservationFiles(env.store), 0);
});

// ── D: state machine, quiescence, lsof ──────────────────────────────────────

test("D1 first sight records nothing; quiet + unchanged + two observations records exactly once", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  assert.equal(dispOf(run(env, { write: true, now: T0 }), U1), "PENDING_FIRST_OBSERVATION");
  assert.equal(countObservationFiles(env.store), 0);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 5 * MIN }), U1), "PENDING_NOT_QUIET");
  assert.equal(dispOf(run(env, { write: true, now: T0 + 31 * MIN }), U1), "RECORDED");
  assert.equal(dispOf(run(env, { write: true, now: T0 + 40 * MIN }), U1), "ALREADY_RECORDED");
  assert.equal(countObservationFiles(env.store), 1);
});

test("D2 a recently modified file is not quiet even after two observations", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0, ageMs: 1 * MIN });
  run(env, { write: true, now: T0 });
  assert.equal(dispOf(run(env, { write: true, now: T0 + 10 * MIN }), U1), "PENDING_NOT_QUIET");
  assert.equal(countObservationFiles(env.store), 0);
});

test("D3 an identity change resets the quiet window", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  appendFileSync(file, JSON.stringify({ type: "custom", id: "bb000001" }) + "\n");
  const t = new Date(T0 - 120 * MIN); utimesSync(file, t, t);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 31 * MIN }), U1), "PENDING_IDENTITY_CHANGED");
  assert.equal(dispOf(run(env, { write: true, now: T0 + 63 * MIN }), U1), "RECORDED");
});

test("D4 lsof: only exit 1 with empty stdout/stderr means not-held; everything else is excluded", () => {
  const ok = { status: 1, stdout: "", stderr: "" };
  assert.equal(classifyLsofResult(ok), "not_held");
  assert.equal(classifyLsofResult({ status: 0, stdout: "p123\n", stderr: "" }), "held");
  for (const bad of [
    { status: 0, stdout: "", stderr: "" },
    { status: 1, stdout: "p9\n", stderr: "" },
    { status: 1, stdout: "", stderr: "lsof: WARNING" },
    { status: 2, stdout: "", stderr: "" },
    { status: null, signal: "SIGTERM", stdout: "", stderr: "" },
    { status: null, error: Object.assign(new Error("x"), { code: "ENOENT" }), stdout: "", stderr: "" },
    { status: null, error: Object.assign(new Error("x"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" },
    null,
  ]) assert.notEqual(classifyLsofResult(bad), "not_held");
});

test("D5 held or unknown holders block recording (conservative)", () => {
  for (const verdict of ["held", "unknown"]) {
    const env = mkEnv();
    const T0 = Date.now();
    putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
    run(env, { write: true, now: T0, lsof: () => verdict });
    const r = run(env, { write: true, now: T0 + 31 * MIN, lsof: () => verdict });
    assert.equal(dispOf(r, U1), "PENDING_HELD_OR_UNKNOWN");
    assert.equal(countObservationFiles(env.store), 0);
  }
});

// ── E: resume, rewrite, crash safety ────────────────────────────────────────

test("E1 append after recording: extended, never recounted, observation untouched", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const before = readFileSync(join(paths(env.store).observations, `${observationIdFor(U1)}.json`), "utf8");
  appendFileSync(file, JSON.stringify({ type: "custom", id: "cc000001" }) + "\n");
  const r = run(env, { write: true, now: T0 + 90 * MIN });
  assert.equal(dispOf(r, U1), "EXTENDED_AFTER_RECORD");
  assert.equal(countObservationFiles(env.store), 1);
  assert.equal(readFileSync(join(paths(env.store).observations, `${observationIdFor(U1)}.json`), "utf8"), before);
  assert.equal(listTrustedObservations(env.store).length, 1);
});

test("E2 a rewritten prefix is PREFIX_MISMATCH and leaves the trusted set", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const tampered = entriesFor(U1, { model: "model-b" });
  writeFileSync(file, tampered.map((e) => JSON.stringify(e)).join("\n") + "\n" + JSON.stringify({ type: "custom", id: "dd000001" }) + "\n");
  const r = run(env, { write: true, now: T0 + 90 * MIN });
  assert.equal(dispOf(r, U1), "PREFIX_MISMATCH");
  assert.equal(listTrustedObservations(env.store).length, 0);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 120 * MIN }), U1), "ALREADY_RECORDED", "PREFIX_MISMATCH is sticky");
});

test("E3 crash between the observation write and the state write: rerun reconciles, one observation", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  assert.throws(() => run(env, {
    write: true, now: T0 + 31 * MIN,
    fault: (step) => { if (step === "after_observation_written") throw new Error("simulated crash"); },
  }), /simulated crash/);
  assert.equal(countObservationFiles(env.store), 1, "observation is durable");
  assert.equal(listTrustedObservations(env.store).length, 0, "but not trusted until the state settles");
  // The run lock was released by the finally block; a real kill -9 is covered by E5.
  const r = run(env, { write: true, now: T0 + 40 * MIN });
  assert.equal(dispOf(r, U1), "RECONCILED");
  assert.equal(countObservationFiles(env.store), 1);
  assert.equal(listTrustedObservations(env.store).length, 1);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 50 * MIN }), U1), "ALREADY_RECORDED");
});

test("E4 crash INSIDE the observation write leaves only a temp file, which never counts", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  setInjectionHook("before_exclusive_link", () => { throw new Error("simulated crash before link"); });
  try {
    assert.throws(() => run(env, { write: true, now: T0 + 31 * MIN }), /before link/);
  } finally {
    clearInjectionHooks();
  }
  const leftovers = readdirSync(paths(env.store).observations).filter((n) => n.includes(".tmp."));
  assert.ok(leftovers.length >= 1, "a temp file remains");
  assert.equal(countObservationFiles(env.store), 0);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 40 * MIN }), U1), "RECORDED");
  assert.equal(countObservationFiles(env.store), 1);
  assert.equal(listTrustedObservations(env.store).length, 1);
});

test("E5 a busy (or stale) run lock is never stolen and nothing is written", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const p = paths(env.store);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.lock, JSON.stringify({ process_id: 999999 }) + "\n");
  const r = run(env, { write: true, now: T0 });
  assert.equal(r.lock, "busy");
  assert.ok(existsSync(p.lock), "the lock is left for an operator");
  assert.ok(!existsSync(p.state));
  assert.equal(countObservationFiles(env.store), 0);
});

test("E6 a corrupt state file is reported and never overwritten", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  const sp = join(paths(env.store).state, `${observationIdFor(U1)}.json`);
  writeFileSync(sp, "{ not json");
  const r = run(env, { write: true, now: T0 + 31 * MIN });
  assert.equal(dispOf(r, U1), "STATE_CORRUPT");
  assert.equal(readFileSync(sp, "utf8"), "{ not json");
  assert.equal(countObservationFiles(env.store), 0);
});

// ── F: dry-run, kill switch, scope ──────────────────────────────────────────

test("F1 dry-run persists nothing at all, state included", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const before = snapshot(env.root);
  const r = run(env, { write: false, now: T0 });
  run(env, { write: false, now: T0 + 31 * MIN });
  assert.equal(r.mode, "dry-run");
  assert.deepEqual(snapshot(env.root), before);
  assert.ok(!existsSync(paths(env.store).root));
});

test("F2 kill switch (env or durable marker) blocks every write", () => {
  const T0 = Date.now();
  for (const variant of ["env", "marker"]) {
    const env = mkEnv();
    putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
    let envVars = {};
    if (variant === "env") envVars = { AUTO_EVOLUTION: "SUSPENDED" };
    else suspendEvolution(env.store, { reason: "test" });
    const before = snapshot(env.store);
    const r = run(env, { write: true, now: T0, envVars });
    assert.equal(r.counts.SUSPENDED, 1, variant);
    assert.ok(!existsSync(paths(env.store).root), variant);
    assert.deepEqual(snapshot(env.store), before, variant);
  }
});

test("F3 writes land only under <store>/omp-observations/", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const before = new Set(snapshot(env.store));
  const sessionsBefore = treeText(env.sessions);
  recordOnce(env, U1, T0);
  const added = snapshot(env.store).filter((f) => !before.has(f));
  assert.ok(added.length > 0);
  for (const f of added) assert.ok(f.startsWith(paths(env.store).root + "/"), f);
  assert.equal(treeText(env.sessions), sessionsBefore, "the sessions root is never modified");
});

test("F4 the output gate refuses anything credential-shaped", async () => {
  const { assertOutputSafe } = await import("../../../src/evolution/omp-attribution/contract.mjs");
  assert.throws(() => assertOutputSafe({ a: [FAKE.sk] }), /sensitive/);
  assert.throws(() => assertOutputSafe({ [FAKE.gh]: 1 }), /sensitive/);
  assert.doesNotThrow(() => assertOutputSafe({ ok: "ompobs_" + "a".repeat(32) }));
});

// ── G: separation (static, transitive) ──────────────────────────────────────

function importClosure(entryFiles) {
  const seen = new Set();
  const stack = [...entryFiles];
  const re = /(?:^|\n)\s*(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  while (stack.length > 0) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !spec.startsWith(".")) continue;
      stack.push(resolve(dirname(f), spec));
    }
  }
  return seen;
}

test("G1 the OMP observation domain cannot reach strategy memory, the feed, triggers or promotion", () => {
  const dir = join(REPO, "src", "evolution", "omp-attribution");
  const entries = readdirSync(dir).filter((n) => n.endsWith(".mjs")).map((n) => join(dir, n));
  entries.push(CLI);
  assert.ok(entries.length >= 4);
  const closure = [...importClosure(entries)];
  const evo = join(REPO, "src", "evolution") + "/";
  for (const f of closure) {
    if (!f.startsWith(evo)) continue;
    const ok = f.startsWith(dir + "/") || f === join(REPO, "src", "evolution", "kill-switch.mjs");
    assert.ok(ok, `forbidden transitive import: ${f.slice(REPO.length + 1)}`);
  }
  for (const f of closure) {
    assert.ok(!f.includes("/src/admission/") && !f.includes("/src/governance/"), f.slice(REPO.length + 1));
  }
});

// ── H: CLI ──────────────────────────────────────────────────────────────────

function cli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 60_000 });
}

test("H1 the CLI has no defaults: missing store/sessions/allowlist is a usage error", () => {
  assert.equal(cli([]).status, 2);
  const env = mkEnv();
  assert.equal(cli(["--store", env.store, "--sessions-root", env.sessions]).status, 2);
  assert.equal(cli(["--sessions-root", env.sessions, "--allow-cwd", CWD]).status, 2);
  assert.equal(cli(["--store", env.store, "--allow-cwd", CWD]).status, 2);
  assert.equal(cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--write", "--dry-run"]).status, 2);
  assert.equal(cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--bogus"]).status, 2);
});

test("H2 CLI default is dry-run: zero writes; --json output passes the safety gate", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const before = snapshot(env.root);
  const r = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, "dry-run");
  for (const f of ALL_FAKES) assert.ok(!r.stdout.includes(f));
  assert.deepEqual(snapshot(env.root), before);
});

test("H3 CLI --write on an empty sessions root creates only the omp-observations domain", () => {
  const env = mkEnv();
  const keyFile = keyPathFor(env);
  const r = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--write", "--key-file", keyFile]);
  assert.equal(r.status, 0, r.stderr);
  const top = readdirSync(env.store);
  assert.deepEqual(top, ["omp-observations"]);
  assert.ok(existsSync(keyFile), "the key is created OUTSIDE the store");
});


// ── I: review follow-ups ────────────────────────────────────────────────────

test("I1 parse failures: a few bad lines are tolerated, too many exclude the session", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const f1 = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  appendFileSync(f1, "{ broken\nnot json at all\n");
  const t1 = new Date(T0 - 180 * MIN); utimesSync(f1, t1, t1);
  const f2 = putSession(env, entriesFor(U2), { uuid: U2, clockNow: T0, slug: "-other-slug" });
  appendFileSync(f2, Array.from({ length: LIMITS.MAX_PARSE_ERRORS + 5 }, (_, i) => `garbage ${i}`).join("\n") + "\n");
  const t2 = new Date(T0 - 180 * MIN); utimesSync(f2, t2, t2);
  run(env, { write: true, now: T0 });
  const r = run(env, { write: true, now: T0 + 31 * MIN });
  assert.equal(dispOf(r, U1), "RECORDED");
  assert.equal(r.results.find((x) => x.session_id === U2).reason, "parse_errors");
  assert.equal(countObservationFiles(env.store), 1);
});

test("I2 two files claiming one session id are both excluded (no identity flapping)", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  putSession(env, entriesFor(U1, { model: "model-b" }), { uuid: U1, clockNow: T0, slug: "-copy" });
  run(env, { write: true, now: T0 });
  const r = run(env, { write: true, now: T0 + 31 * MIN });
  assert.equal(r.results.length, 2);
  for (const x of r.results) { assert.equal(x.disposition, "EXCLUDED"); assert.equal(x.reason, "duplicate_session_id"); }
  assert.ok(!existsSync(paths(env.store).state) || readdirSync(paths(env.store).state).length === 0);
  assert.equal(countObservationFiles(env.store), 0);
});

test("I3 a settled session that is currently held is not re-read or re-judged", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const sp = join(paths(env.store).state, `${observationIdFor(U1)}.json`);
  const stateBefore = readFileSync(sp, "utf8");
  appendFileSync(file, JSON.stringify({ type: "custom", id: "ee000001" }) + "\n");
  for (const verdict of ["held", "unknown"]) {
    const r = run(env, { write: true, now: T0 + 90 * MIN, lsof: () => verdict });
    assert.equal(dispOf(r, U1), "PENDING_HELD_OR_UNKNOWN");
    assert.equal(readFileSync(sp, "utf8"), stateBefore, "state must not be touched while held");
  }
  assert.equal(dispOf(run(env, { write: true, now: T0 + 91 * MIN }), U1), "EXTENDED_AFTER_RECORD");
});

test("I4 kill switch fails closed: corrupt marker, dangling symlink marker, and suspension mid-run", () => {
  const T0 = Date.now();
  for (const variant of ["corrupt", "symlink"]) {
    const env = mkEnv();
    putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
    const marker = evolutionSuspensionPath(env.store);
    if (variant === "corrupt") writeFileSync(marker, "{ not json");
    else symlinkSync(join(env.root, "does-not-exist"), marker);
    const r = run(env, { write: true, now: T0 });
    assert.equal(r.counts.SUSPENDED, 1, variant);
    assert.ok(!existsSync(paths(env.store).root), variant);
  }
  const env = mkEnv();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  putSession(env, entriesFor(U2), { uuid: U2, clockNow: T0, slug: "-second" });
  let tripped = false;
  const r = run(env, {
    write: true, now: T0,
    fault: (step) => { if (step === "after_open" && !tripped) { tripped = true; suspendEvolution(env.store, { reason: "mid-run" }); } },
  });
  assert.equal(r.counts.SUSPENDED_MID_RUN, 1);
  assert.equal(r.results.length, 1, "files after the suspension are not processed");
});

test("I5 CLI --deny-root is additive: the default tmp exclusion can never be dropped", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1, { cwd: "/tmp/scratch-proj" }), { uuid: U1, clockNow: T0 });
  const r = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", "/tmp", "--deny-root", "/somewhere/else", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.results[0].reason, "cwd_denied");
});

test("I6 a credential in the cwd name, or a non-UUID session id, excludes the session and leaves no trace", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1, { cwd: `${CWD}/${FAKE.gh}` }), { uuid: U1, clockNow: T0 });
  const bad = entriesFor(U2);
  bad[0].id = "not-a-uuid";
  putSession(env, bad, { uuid: U2, clockNow: T0, slug: "-bad-id" });
  const r1 = run(env, { write: true, now: T0 });
  const r2 = run(env, { write: true, now: T0 + 31 * MIN });
  assert.equal(r2.results.find((x) => x.session_id === U1).reason, "sensitive_pattern");
  assert.equal(r2.results.find((x) => x.session_id === U2).reason, "session_id_mismatch");
  const all = treeText(env.store) + JSON.stringify(r1) + JSON.stringify(r2);
  for (const f of ALL_FAKES) assert.ok(!all.includes(f));
});

test("I7 nlink is re-checked after open (a link made between lstat and open)", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const alias = join(env.root, "alias-observe");
  const a = observeSessionFile(file, { sessionsRoot: env.sessions, fault: (step) => { if (step === "after_open") linkSync(file, alias); } });
  assert.equal(a.ok, false);
  assert.equal(a.reason, "hardlink");

  const env2 = mkEnv();
  const file2 = putSession(env2, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const pre = observeSessionFile(file2, { sessionsRoot: env2.sessions });
  const alias2 = join(env2.root, "alias-full");
  const b = readSessionBytes(file2, { sessionsRoot: env2.sessions, identity: pre.identity, fault: (step) => { if (step === "after_open_full") linkSync(file2, alias2); } });
  assert.equal(b.ok, false);
  assert.equal(b.reason, "hardlink");
});

test("I8 tool names outside the fixed allowlist are counted, never kept; long/segmented key-like names drop the record", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const e = entriesFor(U1);
  e[3].message.content.push({ type: "toolCall", name: "mcp__some_server__do_thing" }, { type: "toolCall", name: "grep" });
  putSession(env, e, { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.deepEqual(o.tools.counts, { bash: 1, grep: 1, read: 1 });
  assert.equal(o.tools.other_count, 1);
  assert.ok(!JSON.stringify(o).includes("mcp__some_server"));
  assert.ok(!validateObservation({ ...o, tools: { ...o.tools, counts: { not_a_known_tool: 1 } } }).ok);

  const segmented = "sk-" + "ab12-".repeat(6) + "cd34";
  const longRun = "x".repeat(45);
  for (const [label, name] of [["segmented", segmented], ["long-run", longRun]]) {
    const envX = mkEnv();
    const eX = entriesFor(U1);
    eX[3].message.model = name;
    putSession(envX, eX, { uuid: U1, clockNow: T0 });
    const { second } = recordOnce(envX, U1, T0);
    assert.equal(second.results[0].reason, "sensitive_pattern", label);
    assert.ok(!treeText(envX.store).includes(name), label);
  }
});

test("I9 crash-then-append: the late reconcile settles as EXTENDED_AFTER_RECORD, not PREFIX_MISMATCH", () => {
  const env = mkEnv();
  const T0 = Date.now();
  const file = putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  run(env, { write: true, now: T0 });
  assert.throws(() => run(env, {
    write: true, now: T0 + 31 * MIN,
    fault: (step) => { if (step === "after_observation_written") throw new Error("simulated crash"); },
  }), /simulated crash/);
  const obsPath = join(paths(env.store).observations, `${observationIdFor(U1)}.json`);
  const obsBefore = readFileSync(obsPath, "utf8");
  appendFileSync(file, JSON.stringify({ type: "custom", id: "ff000001" }) + "\n");
  const old = new Date(T0 - 180 * MIN); utimesSync(file, old, old);
  assert.equal(dispOf(run(env, { write: true, now: T0 + 40 * MIN }), U1), "PENDING_IDENTITY_CHANGED");
  const r = run(env, { write: true, now: T0 + 80 * MIN });
  assert.equal(dispOf(r, U1), "EXTENDED_AFTER_RECORD");
  assert.equal(r.results[0].reason, "reconciled_after_crash");
  assert.equal(readFileSync(obsPath, "utf8"), obsBefore, "the original observation is never rewritten");
  assert.equal(countObservationFiles(env.store), 1);
  assert.equal(listTrustedObservations(env.store).length, 1);
});

test("I4b an unreadable marker location (permission error, not ENOENT) also suspends", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  chmodSync(env.store, 0o000);
  try {
    const r = run(env, { write: true, now: T0 });
    assert.equal(r.counts.SUSPENDED, 1);
    assert.match(r.suspended, /unreadable/);
  } finally {
    chmodSync(env.store, 0o700);
  }
  assert.ok(!existsSync(paths(env.store).root));
});


// ── K: per-store keyed cwd identity (HMAC) ──────────────────────────────────

const sha = (t) => createHash("sha256").update(t).digest("hex");

function codeOf(fn) {
  try { fn(); } catch (e) { return e.code; }
  return null;
}

test("K1 cwd_ref is a keyed HMAC (schema v2), not a bare hash; the key is 0600 and outside the store", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.equal(o.schema, "aegisflow.omp-attribution/v2");
  assert.equal(o.cwd_ref.alg, "hmac-sha256-v1");
  assert.match(o.cwd_ref.key_id, /^[0-9a-f]{16}$/);
  assert.match(o.cwd_ref.mac, /^[0-9a-f]{64}$/);
  assert.notEqual(o.cwd_ref.mac, sha(`cwd:${CWD}`), "must not equal the unsalted hash");
  assert.notEqual(o.cwd_ref.mac, sha(CWD));
  const keyFile = keyPathFor(env);
  assert.equal(statSync(keyFile).mode & 0o777, 0o600);
  assert.match(readFileSync(keyFile, "utf8").trim(), /^[0-9a-f]{64}$/);
  assert.ok(!keyFile.startsWith(env.store + "/"));
  const identity = JSON.parse(readFileSync(paths(env.store).identity, "utf8"));
  assert.equal(identity.key_id, o.cwd_ref.key_id);
});

test("K2 the same cwd under different store keys yields different, non-comparable references", () => {
  const T0 = Date.now();
  const macs = [];
  for (let i = 0; i < 2; i++) {
    const env = mkEnv();
    putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
    recordOnce(env, U1, T0);
    macs.push(listTrustedObservations(env.store)[0].cwd_ref);
  }
  assert.notEqual(macs[0].mac, macs[1].mac);
  assert.notEqual(macs[0].key_id, macs[1].key_id);
});

test("K3 the key never appears in the store, the report, errors or CLI output", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const { first, second } = recordOnce(env, U1, T0);
  const keyHex = readFileSync(keyPathFor(env), "utf8").trim();
  const everything = treeText(env.store) + JSON.stringify(first) + JSON.stringify(second);
  assert.ok(!everything.includes(keyHex));
  const keyFile = keyPathFor(env);
  const out = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--key-file", keyFile, "--json"]);
  assert.ok(!(out.stdout + out.stderr).includes(keyHex));
  const bad = join(env.root, "keys", "wrong.key");
  writeFileSync(bad, keyHex.replace(/^./, "0") + "\n", { mode: 0o600 });
  const err = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--key-file", bad, "--write"]);
  assert.equal(err.status, 4);
  assert.ok(!(err.stdout + err.stderr).includes(keyHex));
});

test("K4 a lost key fails closed: no new key is minted over an existing store identity", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const keyFile = keyPathFor(env);
  const trusted = readFileSync(join(paths(env.store).observations, `${observationIdFor(U1)}.json`), "utf8");
  rmSync(keyFile);
  for (const write of [true, false]) {
    assert.equal(codeOf(() => run(env, { write, now: T0 + 90 * MIN })), KEY_ERRORS.MISSING, `write=${write}`);
    assert.ok(!existsSync(keyFile), "a key must not be re-created");
  }
  assert.equal(readFileSync(join(paths(env.store).observations, `${observationIdFor(U1)}.json`), "utf8"), trusted);
});

test("K5 a different key (same path) is detected via key_id and refused", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const keyFile = keyPathFor(env);
  rmSync(keyFile);
  writeFileSync(keyFile, "ab".repeat(32) + "\n", { mode: 0o600 });
  assert.equal(codeOf(() => run(env, { write: true, now: T0 + 90 * MIN })), KEY_ERRORS.MISMATCH);
});

test("K6 data without an identity record fails closed (never adopts or re-mints)", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  rmSync(paths(env.store).identity);
  assert.equal(codeOf(() => run(env, { write: true, now: T0 + 90 * MIN })), KEY_ERRORS.IDENTITY_MISSING);
  writeFileSync(paths(env.store).identity, "{ broken");
  assert.equal(codeOf(() => run(env, { write: true, now: T0 + 90 * MIN })), KEY_ERRORS.IDENTITY_CORRUPT);
});

test("K7 unsafe key files are refused: group-readable, symlink, wrong content, inside the store", () => {
  const T0 = Date.now();
  const env = mkEnv();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const keyFile = keyPathFor(env);

  writeFileSync(keyFile, "cd".repeat(32) + "\n", { mode: 0o644 });
  chmodSync(keyFile, 0o644);
  assert.equal(codeOf(() => run(env, { write: true, now: T0 })), KEY_ERRORS.INSECURE);

  rmSync(keyFile);
  const real = join(env.root, "keys", "real.key");
  writeFileSync(real, "ef".repeat(32) + "\n", { mode: 0o600 });
  symlinkSync(real, keyFile);
  assert.equal(codeOf(() => run(env, { write: true, now: T0 })), KEY_ERRORS.INSECURE);

  rmSync(keyFile);
  writeFileSync(keyFile, "not a key\n", { mode: 0o600 });
  assert.equal(codeOf(() => run(env, { write: true, now: T0 })), KEY_ERRORS.UNREADABLE);

  assert.equal(codeOf(() => run(env, { write: true, now: T0, keyFile: join(env.store, "inside.key") })), KEY_ERRORS.INSIDE_STORE);
  assert.ok(!existsSync(paths(env.store).state), "nothing may be written on a key failure");
  assert.equal(countObservationFiles(env.store), 0);
});

test("K8 write requires --key-file; dry-run without one uses an in-memory key and persists nothing", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  assert.throws(() => run(env, { write: true, now: T0, keyFile: null }), /--key-file is required/);
  const before = snapshot(env.root);
  const r = run(env, { write: false, now: T0, keyFile: null });
  assert.equal(r.mode, "dry-run");
  assert.deepEqual(snapshot(env.root), before);
  assert.equal(cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--write"]).status, 2);
});

test("K9 a kill-switched run does not create a key or an identity", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  const r = run(env, { write: true, now: T0, envVars: { AUTO_EVOLUTION: "SUSPENDED" } });
  assert.equal(r.counts.SUSPENDED, 1);
  assert.ok(!existsSync(join(env.root, "keys", "omp.key")));
});

test("K10 the v1 shape (unsalted sha256 cwd_ref, v1 schema) is no longer valid", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0 });
  recordOnce(env, U1, T0);
  const o = listTrustedObservations(env.store)[0];
  assert.ok(!validateObservation({ ...o, schema: "aegisflow.omp-attribution/v1" }).ok);
  assert.ok(!validateObservation({ ...o, cwd_ref: { sha256: "a".repeat(64), allowlisted: true } }).ok);
  assert.ok(!validateObservation({ ...o, cwd_ref: { ...o.cwd_ref, alg: "sha256" } }).ok);
});


test("L1 --slug limits discovery: other session directories are never opened", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, entriesFor(U1), { uuid: U1, clockNow: T0, slug: "-wanted" });
  putSession(env, entriesFor(U2), { uuid: U2, clockNow: T0, slug: "-other" });
  const all = run(env, { now: T0 });
  assert.equal(all.results.length, 2);
  const only = runIngest({
    storeRoot: env.store, sessionsRoot: env.sessions, allowRoots: [CWD], denyRoots: [], nowMs: () => T0,
    lsof: () => "not_held", onlySlugs: ["-wanted"], keyFile: null,
  });
  assert.deepEqual(only.results.map((r) => r.session_id), [U1]);
  const r = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--slug", "-wanted", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).results.map((x) => x.session_id), [U1]);
  // Real directory names start with "--": the = form must work.
  putSession(env, entriesFor(U3), { uuid: U3, clockNow: T0, slug: "--dashed-slug--" });
  const d = cli(["--store", env.store, "--sessions-root", env.sessions, "--allow-cwd", CWD, "--slug=--dashed-slug--", "--json"]);
  assert.equal(d.status, 0, d.stderr);
  assert.deepEqual(JSON.parse(d.stdout).results.map((x) => x.session_id), [U3]);
});


test("M1 real layout: a leading title entry before the session header is handled; a missing header is reported as such", () => {
  const env = mkEnv();
  const T0 = Date.now();
  putSession(env, withTitleFirst(entriesFor(U1)), { uuid: U1, clockNow: T0 });
  const noHeader = entriesFor(U2).slice(1); // header removed
  putSession(env, noHeader, { uuid: U2, clockNow: T0, slug: "-no-header" });
  const manyLines = [];
  for (let i = 0; i < 12; i++) manyLines.push({ type: "custom", id: `ab00000${i % 10}`, customType: "x" });
  putSession(env, [...manyLines, ...entriesFor(U3)], { uuid: U3, clockNow: T0, slug: "-late-header" });
  const { first, second } = recordOnce(env, U1, T0);
  assert.equal(dispOf(first, U1), "PENDING_FIRST_OBSERVATION");
  assert.equal(dispOf(second, U1), "RECORDED");
  assert.equal(second.results.find((r) => r.session_id === U2).reason, "no_session_header");
  assert.equal(second.results.find((r) => r.session_id === U3).reason, "no_session_header", "header beyond the scan window is not searched for");
  assert.equal(listTrustedObservations(env.store).length, 1);
});
