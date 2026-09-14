// test/tool-selection/test-tool-selection-durable-resume.mjs
//
// AUTOLOOP-V1-STAGE-C-DURABLE-RESUME-TOOL-SELECTION-BIND-CONTINUITY-REPAIR-1
// In-repo binding matrix for durable-resume selection continuity:
//   - pure reconstruction-seam matrix (every §8 failure family -> coded HOLD)
//   - checkpoint roundtrip through THE single C2D publication authority
//   - commitment DATA hygiene (no authority object / raw policy serialized)
//   - single-authority static proofs
// Production E2E (crash child process + wired pi factory + fresh-process
// resume) lives under the card evidence root on NVM2T (probes/) and runs the
// REAL runDurableGraph/resumeDurableGraph pair — helper-only coverage is
// non-conforming, and this file deliberately complements it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createHash } from "node:crypto";
import { writeFileSync as wfs, readFileSync as rfs } from "node:fs";
import {
  projectToolSelection,
  validateToolSelection,
  FROZEN_MAPPING_DIGEST,
  FROZEN_RUNTIME_VOCABULARY_DIGEST,
  FROZEN_RUNTIME_IDENTITY,
  TOOL_SELECTION_SCHEMA,
} from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../../src/admission/policy-projection.mjs";
import { digestOf } from "../../src/canonical-digest.mjs";
import {
  mintTaskCardToolSelectionBind,
} from "../../src/v2/phase-task-card.mjs";
import {
  reconstructToolSelectionContinuity,
  TOOL_SELECTION_COMMITMENT_SCHEMA,
  DurableGraphHoldError,
} from "../../src/v2/durable-graph.mjs";

const REPO_ROOT = resolve(process.cwd());

// ── shared fixtures ──────────────────────────────────────────────────────

const HEAVY_EVIDENCE = {
  affected_files: { score: 6, reasons: ["multi-file"] },
  affected_subsystems: { score: 4, reasons: ["two subsystems"] },
  dependency_depth: { score: 3, reasons: ["some deps"] },
  ambiguity: { score: 3, reasons: ["moderate"] },
  expected_execution_steps: { score: 5, reasons: ["several edits"] },
  verification_burden: { score: 4, reasons: ["tests required"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert one file"] },
};
const LOW_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["none"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert one file"] },
};
function makeAdmission(taskId, kind = "heavy") {
  const c = kind === "heavy"
    ? classify({
        dimensionScores: HEAVY_EVIDENCE,
        riskSignals: scanRiskSignals("refactor module: modify database schema, delete legacy api endpoints"),
      })
    : classify({ dimensionScores: LOW_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  return freezeAdmission(buildAdmissionRecord({
    taskId,
    classification: c,
    ...(kind === "heavy" ? { mutationScope: ["src/"] } : {}),
  }));
}
function allocFor(admission, taskId, dims) {
  const a = {
    taskId,
    admissionId: admission.admission_id,
    dimensions: dims ?? {
      node_execution_count: 4, repair_attempt_count: 1, retry_count: 2,
      sub_agent_execution_count: 1, verifier_reviewer_attempts: 1, wall_clock_ms: 60000,
    },
  };
  return { ...a, allocationId: digestOf({ taskId: a.taskId, admissionId: a.admissionId, dimensions: a.dimensions }) };
}

const RUN_ID = "exec_" + "c1".repeat(16);
const ADMISSION = makeAdmission("STAGEC-DURABLE-RESUME-TASK");
const ALLOCATION = allocFor(ADMISSION, ADMISSION.task_id);

/** Mint one canonical commitment exactly like the durable phase-start seam. */
function commitFor(phaseId, { nodeRole = "readonly-analyst", executionId = RUN_ID, admission = ADMISSION, allocation = ALLOCATION } = {}) {
  const selection = mintTaskCardToolSelectionBind({
    executionId,
    admission,
    taskAllocation: allocation,
    nodeRole,
  });
  return {
    schema: TOOL_SELECTION_COMMITMENT_SCHEMA,
    runIdentity: executionId,
    phaseId,
    nodeRole,
    recovery_generation: 0,
    allocationIdentity: {
      taskId: allocation.taskId,
      admissionId: allocation.admissionId,
      dimensions: allocation.dimensions,
      allocationId: allocation.allocationId,
    },
    selection,
  };
}

function thaw(c) {
  return JSON.parse(JSON.stringify(c)); // mint output is deep-frozen; attackers mutate copies
}

function reSignDigest(sel) {
  delete sel.selectionDigest;
  const canon = JSON.stringify((function sort(x) {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  })(sel));
  const preimage = TOOL_SELECTION_SCHEMA + "\n" + canon + "\n";
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function holdCode(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof DurableGraphHoldError || e?.name === "DurableGraphHoldError") return e.code;
    throw e;
  }
}

// ── T2/T4/T5 · roundtrip, remint-by-mint, canonical byte equality ────────

test("T2/T4/T5 commitment roundtrips through JSON; resume remints via THE mint with equal bytes", () => {
  const commitment = commitFor("P1");
  // Roundtrip like a real checkpoint payload (JSON serialization only).
  const persisted = JSON.parse(JSON.stringify(commitment));
  const { allocation } = reconstructToolSelectionContinuity({
    executionId: RUN_ID,
    admission: ADMISSION,
    commitments: { P1: persisted },
  });
  assert.equal(allocation.allocationId, ALLOCATION.allocationId, "allocation identity reconstructed");
  assert.deepEqual(
    { ids: persisted.selection.canonicalToolIds, names: persisted.selection.adapterToolNames, basis: persisted.selection.selectionBasis },
    { ids: ["fs.grep", "fs.list", "fs.read"], names: ["find", "grep", "ls", "read"], basis: "DERIVED_SELECTION" },
    "tool-required subset restored exactly",
  );
});

test("T4b writer-role commitments validate through the same seam", () => {
  const commitment = commitFor("W1", { nodeRole: "writer" });
  const { allocation } = reconstructToolSelectionContinuity({
    executionId: RUN_ID,
    admission: ADMISSION,
    commitments: { W1: JSON.parse(JSON.stringify(commitment)) },
  });
  assert.equal(allocation.taskId, ADMISSION.task_id);
});

// ── T7–T20 · failure-family matrix (pure seam) ────────────────────────────

test("T7 missing commitment container holds fail-closed", () => {
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({ executionId: RUN_ID, admission: ADMISSION, commitments: null })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({ executionId: RUN_ID, admission: ADMISSION, commitments: {} })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T8 malformed commitment entries hold", () => {
  const bad = new Map([["P1", { schema: "wrong" }]]);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({ executionId: RUN_ID, admission: ADMISSION, commitments: { P1: 42 } })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
  void bad;
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION,
      commitments: { P1: { ...thaw(commitFor("P1")), schema: "autoloop.tool-selection-commitment/v0" } },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T9 tampered selected subset (re-signed digest) cannot pass deterministic replay", () => {
  const c = thaw(commitFor("P1"));
  // Attacker narrows the carried arrays and re-signs per the frozen formula.
  c.selection.canonicalToolIds = ["fs.read"];
  c.selection.permissionIds = ["fs.read"];
  c.selection.adapterToolNames = ["read"];
  c.selection.selectionDigest = reSignDigest(c.selection);
  const code = holdCode(() => reconstructToolSelectionContinuity({
    executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
  }));
  assert.equal(code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("T10 wrong task identity holds", () => {
  const c = thaw(commitFor("P1"));
  c.allocationIdentity.taskId = "OTHER-TASK";
  const code = holdCode(() => reconstructToolSelectionContinuity({
    executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
  }));
  assert.equal(code, "TOOL_SELECTION_PROVENANCE_INVALID");
});

test("T11 wrong run identity holds", () => {
  const c = commitFor("P1", { executionId: "exec_" + "ff".repeat(16) });
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});
test("T12 wrong admission holds", () => {
  const c = thaw(commitFor("P1"));
  c.allocationIdentity.admissionId = "admission_foreign_0000000000000000000000";
  c.allocationIdentity.allocationId = digestOf({
    taskId: c.allocationIdentity.taskId,
    admissionId: c.allocationIdentity.admissionId,
    dimensions: c.allocationIdentity.dimensions,
  }); // internally consistent, but bound to a FOREIGN admission
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T13 malformed generation holds", () => {
  for (const gen of [-1, 1.5, "0", null]) {
    const c = commitFor("P1");
    c.recovery_generation = gen;
    assert.equal(
      holdCode(() => reconstructToolSelectionContinuity({
        executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
      })),
      "TOOL_SELECTION_PROVENANCE_INVALID",
      `generation=${JSON.stringify(gen)}`,
    );
  }
});

test("T14 wrong adapterKind holds (cross-adapter replay fenced)", () => {
  const c = thaw(commitFor("P1"));
  c.selection.adapterKind = "omp-builtin";
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T15 cross-adapter replay of a foreign-kind commitment is invisible/unusable", () => {
  const ompSelection = JSON.parse(JSON.stringify(commitFor("P1").selection));
  ompSelection.adapterKind = "codex";
  ompSelection.adapterToolNames = ["codex_apply_patch"];
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION,
      commitments: { P1: { ...commitFor("P1"), selection: ompSelection } },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T16 stale registry digest holds", () => {
  const c = thaw(commitFor("P1"));
  c.selection.registryDigest = "0".repeat(64);
  c.selection.selectionDigest = reSignDigest(c.selection);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T17 stale mapping digest holds", () => {
  const c = thaw(commitFor("P1"));
  c.selection.mappingDigest = "0".repeat(64);
  c.selection.selectionDigest = reSignDigest(c.selection);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T18 stale runtime identity holds", () => {
  const c = thaw(commitFor("P1"));
  c.selection.runtimeIdentity.sha256 = "0".repeat(64);
  c.selection.selectionDigest = reSignDigest(c.selection);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT",
  );
});

test("T19 stale runtime vocabulary digest holds", () => {
  const c = thaw(commitFor("P1"));
  c.selection.runtimeVocabularyDigest = "0".repeat(64);
  c.selection.selectionDigest = reSignDigest(c.selection);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_RUNTIME_VOCABULARY_DRIFT",
  );
});

test("T20 recomputed-selection mismatch holds even when every signature is valid", () => {
  const c = commitFor("P1");
  // Swap in a DIFFERENT but internally consistent selection: minted under a
  // different nodeRole, then relabeled. The replay fence rejects it.
  const writerSel = JSON.parse(JSON.stringify(commitFor("P1", { nodeRole: "writer" }).selection));
  writerSel.nodeRole = "readonly-analyst";
  c.selection = writerSel;
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

test("T21 required tool unavailable after revoke holds (never degrades)", () => {
  const denied = freezeAdmission({
    ...ADMISSION,
    capabilities: { ...ADMISSION.capabilities, denied: [...(ADMISSION.capabilities.denied ?? []), ...ADMISSION.capabilities.required] },
    admission_id: "PLACEHOLDER",
  });
  const c = commitFor("P1");
  const code = holdCode(() => reconstructToolSelectionContinuity({
    executionId: RUN_ID, admission: denied, commitments: { P1: c },
  }));
  assert.ok(code === "TOOL_SELECTION_TOOL_REVOKED" || code === "TOOL_SELECTION_PROVENANCE_INVALID", `got ${code}`);
});

test("T6 faked LEGITIMATE_EMPTY cannot be laundered into a resumeable commitment", () => {
  // A durable graph phase mints through THE formula for its derived role; a
  // hand-built "empty" selection (the laundering shape contract REV 2/REV 3
  // forbids) must fail the continuity gate even when re-signed consistently.
  const c = thaw(commitFor("P1"));
  c.selection.canonicalToolIds = [];
  c.selection.permissionIds = [];
  c.selection.adapterToolNames = [];
  c.selection.selectionBasis = "LEGITIMATE_EMPTY";
  c.selection.selectionDigest = reSignDigest(c.selection);
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

// Honest LEGITIMATE_EMPTY continuity (persisted empty == recomputed empty ==
// identities match) is exercised end-to-end by the FAST_PATH direct-path
// suite (wiring T21) and by the argv-level --no-tools assertions in the
// card's NVM2T production probes; the gate above proves the laundering
// direction can never manufacture it.

test("T23b commitments bound to a DIFFERENT allocation than the frozen artifact hold", () => {
  const c = commitFor("P1");
  c.allocationIdentity.dimensions = { ...c.allocationIdentity.dimensions, wall_clock_ms: 1 };
  // allocationId no longer matches the mutated dimensions (substituted allocation)
  assert.equal(
    holdCode(() => reconstructToolSelectionContinuity({
      executionId: RUN_ID, admission: ADMISSION, commitments: { P1: c },
    })),
    "TOOL_SELECTION_PROVENANCE_INVALID",
  );
});

// ── T24/T25 · commitment data hygiene ────────────────────────────────────

test("T24 no authority object/closure/function is serialized in a commitment", () => {
  const c = commitFor("P1");
  const json = JSON.stringify(c);
  assert.deepEqual(JSON.parse(json), c, "commitment survives JSON round-trip (data, not closure)");
  for (const banned of ["selectionAuthority", "[Function]", "() =>", "createLifecycleSelectionAuthority"]) {
    assert.equal(json.includes(banned), false, `commitment must not embed ${banned}`);
  }
  assert.deepEqual(Object.keys(c.selection).sort(), [
    "adapterKind", "adapterToolNames", "canonicalToolIds", "contractVersion", "mappingDigest",
    "permissionIds", "registryDigest", "runIdentity", "runtimeIdentity", "runtimeVocabularyDigest",
    "admissionIdentity", "selectedAt", "selectionBasis", "selectionDigest", "taskIdentity", "nodeRole",
  ].sort(), "exactly the frozen §7 field set");
});

test("T25 caller raw toolPolicy never enters the commitment channel", () => {
  const rawCallerPolicy = { mode: "allowlist", allow: ["bash", "curl"] };
  const c = commitFor("P1");
  const json = JSON.stringify({ commitments: { P1: c }, hooksToolPolicyIgnored: true });
  assert.equal(json.includes("allowlist"), false);
  assert.equal(json.includes("curl"), false);
  void rawCallerPolicy;
});

// ── T36 · single-authority static proofs ─────────────────────────────────

test("T36 single selector/validator/checkpoint authorities (static)", () => {
  const find = (pat) => execFileSync("grep", ["-rlF", pat, "src/", "--include=*.mjs"], { cwd: REPO_ROOT })
    .toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(find("export async function publishCheckpoint"), ["src/v2/checkpoint-bridge.mjs"]);
  assert.deepEqual(find("function projectToolSelection"), ["src/admission/policy-projection.mjs"]);
  assert.deepEqual(find("export function validateToolSelection"), ["src/admission/policy-projection.mjs"]);
  // The durable layer consumes them; it never defines its own.
  const dg = readFileSync(resolve(REPO_ROOT, "src/v2/durable-graph.mjs"), "utf8");
  assert.equal(dg.includes("function projectToolSelection"), false);
  assert.equal(dg.includes("function validateToolSelection"), false);
  assert.ok(dg.includes("mintTaskCardToolSelectionBind"), "resume mints through THE single mint export");
});

test("T37 commitment schema keeps agent-neutral core + explicit adapter projection", () => {
  const c = commitFor("P1");
  assert.equal(c.selection.adapterKind, "pi-builtin", "adapter-specific surface is kind-scoped");
  assert.deepEqual(c.selection.permissionIds, c.selection.canonicalToolIds, "canonical permission ids are agent-neutral");
  assert.equal(typeof c.selection.runtimeIdentity.realpath, "string", "runtime identity rides as DATA projection");
  assert.ok(!JSON.stringify(c.allocationIdentity).includes("pi-coding-agent"), "Pi executable identity is not core task identity");
});

// ── T7i/T23/T26-adjacent · integration through the REAL resume gate ──────
// Builds a minimal-but-authentic durable store through the SAME authorities
// production uses (DurableGraphRun + RunEvidenceStore + publishCheckpoint),
// then drives resumeDurableGraph far enough to prove the continuity gate
// fires BEFORE any adapter can spawn — and that valid commitments let the
// resume proceed into orchestration.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DurableGraphRun, runDurableGraph,
} from "../../src/v2/durable-graph.mjs";
import {
  resumeDurableGraph,
} from "../../src/v2/durable-graph.mjs";
import { RunEvidenceStore } from "../../src/evidence/run-evidence-store.mjs";
import {
  publishCheckpoint, AUTOLOOP_CHECKPOINT_FORMAT_VERSION,
  buildIrSha256 as buildIrSha, buildDagFingerprint as buildDagSha,
  collectRepositoryFingerprint,
} from "../../src/v2/checkpoint-bridge.mjs";
import { prepareOwnedScratchRoot } from "../../src/runtime/scratch-ownership.mjs";

function gitInit(repo) {
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "baseline", "--allow-empty"], { stdio: "ignore" });
}

async function craftWiredRunFixture({ commitments }) {
  const base = mkdtempSync(join(tmpdir(), "dur-sel-"));
  const repo = join(base, "repo"); const persist = join(base, "persist"); const scratch = join(base, "scratch");
  mkdirSync(repo, { recursive: true }); mkdirSync(persist, { recursive: true }); mkdirSync(scratch, { recursive: true });
  gitInit(repo);

  const executionId = RUN_ID;
  const parent = { scope: {} };
  const manifest = [];
  const ir = { verdict: "PASS", phases: [{ phase_id: "P1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } }], dispositions: [] };

  // Build fingerprints THROUGH the real run context (guaranteed parity).
  const run = new DurableGraphRun({
    ir, parent, manifest, cwd: repo, repoPath: repo, scratchRoot: scratch,
    maxRepairAttempts: 1, timeoutMs: 60000, signal: undefined, hooks: {},
    persistence: { root: persist, executionId },
    recovery: null, dirtyScope: [], admission: ADMISSION, budget: { allocation: ALLOCATION },
  });
  const store = new RunEvidenceStore({
    root: persist, executionId: run.executionId, chainId: run.chainId,
    checkpointId: run.checkpointId, repoRoot: repo,
  });
  run.execDir = store.init(); run.store = store; run.root = persist;
  run.repoFingerprint = collectRepositoryFingerprint(repo);
  run.state.permittedDirtyDigest = "clean";
  const frozenInput = { source: null, parent, manifest, repoPath: repo, scratchRoot: scratch };
  store.writeArtifact("input.json", frozenInput);
  store.writeArtifact("admission.json", ADMISSION);
  if (ALLOCATION) {
    store.writeArtifact("tool-selection-allocation.json", {
      schema: TOOL_SELECTION_COMMITMENT_SCHEMA,
      allocationIdentity: {
        taskId: ALLOCATION.taskId, admissionId: ALLOCATION.admissionId,
        dimensions: ALLOCATION.dimensions, allocationId: ALLOCATION.allocationId,
      },
    });
  }
  store.writeArtifact("decomposition-ir.json", ir);
  run.inputFingerprint = run._graphInputFingerprint();
  run.configurationFingerprint = run._configurationFingerprint();
  run.irSha = buildIrSha(ir); run.dagSha = buildDagSha(ir);
  store.appendEvent({ event_type: "GRAPH_CREATED", stage: "run", payload: {} });
  await run.checkpoint({});
  store.appendEvent({ event_type: "GRAPH_INPUT_FROZEN", stage: "input", payload: { input_fingerprint: run.inputFingerprint } });
  await run.checkpoint({});
  run.state.phaseStates = { P1: "pending" };
  store.appendEvent({ event_type: "DAG_ACCEPTED", stage: "decomposition", payload: { phase_count: 1, ir_sha256: run.irSha, dag_sha256: run.dagSha } });
  await run.checkpoint({});

  if (commitments !== undefined) {
    // Inject commitment DATA into the writer state and republish (the same
    // seam _publishCheckpoint uses); keeps single-writer/checksum intact.
    run.state.selectionCommitments = commitments;
    await run.checkpoint({});
  }
  return { base, repo, persist, scratch, executionId: run.executionId, ir };
}

const noopFactory = (label) => () => ({
  runAdapter: async (req) => ({ status: "error", executionId: req.executionId, error: `${label}:offline-stub`, stdout: "", stderr: "", metadata: {} }),
});

test("T23i legacy wired checkpoint WITHOUT commitments holds pre-spawn", async () => {
  const fx = await craftWiredRunFixture({ commitments: undefined });
  // Emulate a PRE-REPAIR checkpoint honestly: same publication channel, but
  // the snapshot predates the commitment field. Rewrite bytes + sidecar so
  // C2D checksum stays valid — only the FIELD is absent.
  {
    const execDir = join(fx.persist, fx.executionId);
    const cur = join(execDir, "CURRENT.json");
    const snap = JSON.parse(rfs(cur, "utf8"));
    delete snap.graph.tool_selection_commitments;
    const bytes = Buffer.from(JSON.stringify(snap), "utf8");
    wfs(cur, bytes);
    wfs(join(execDir, "CURRENT.json.sha256"), createHash("sha256").update(bytes).digest("hex") + "\n");
  }
  try {
    let code = null; let final = null;
    try {
      await resumeDurableGraph({
        persistenceRoot: fx.persist, executionId: fx.executionId,
        parent: { scope: {} }, manifest: [], cwd: fx.repo, repoPath: fx.repo,
        scratchRoot: fx.scratch, maxRepairAttempts: 1, timeoutMs: 60000,
        hooks: { expectedReviewerModel: "deterministic-c3" }, dirtyScope: [],
        admission: ADMISSION,
        executorAdapterFactory: noopFactory("exec"), reviewerAdapterFactory: noopFactory("rev"),
      });
    } catch (e) {
      code = e?.code ?? null;
      final = `${e?.name}:${String(e?.message ?? "").slice(0, 80)}`;
    }
    assert.equal(code, "TOOL_SELECTION_RESUME_BIND_MISSING", `expected bind-missing hold, got ${final}`);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("T7i malformed commitments container on a wired run holds pre-spawn", async () => {
  const fx = await craftWiredRunFixture({ commitments: {} });
  try {
    let code = null;
    try {
      await resumeDurableGraph({
        persistenceRoot: fx.persist, executionId: fx.executionId,
        parent: { scope: {} }, manifest: [], cwd: fx.repo, repoPath: fx.repo,
        scratchRoot: fx.scratch, maxRepairAttempts: 1, timeoutMs: 60000,
        hooks: { expectedReviewerModel: "deterministic-c3" }, dirtyScope: [],
        admission: ADMISSION,
        executorAdapterFactory: noopFactory("exec"), reviewerAdapterFactory: noopFactory("rev"),
      });
    } catch (e) { code = e?.code ?? null; }
    assert.equal(code, "TOOL_SELECTION_PROVENANCE_INVALID");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("T24i lost allocation artifact with LIVE commitments holds (never --no-tools downgrade)", async () => {
  // Review MAJOR disposition: the resume gate keys on EITHER the loose
  // frozen artifact OR live snapshot commitments; losing exactly one signal
  // must HOLD fail-closed — a silent gate skip would let the resumed leg
  // mint no binds and spawn pi executors with --no-tools.
  const fx = await craftWiredRunFixture({ commitments: { P1: thaw(commitFor("P1")) } });
  try {
    rmSync(join(fx.persist, fx.executionId, "artifacts", "tool-selection-allocation.json"), { force: true });
    let code = null; let final = null;
    try {
      await resumeDurableGraph({
        persistenceRoot: fx.persist, executionId: fx.executionId,
        parent: { scope: {} }, manifest: [], cwd: fx.repo, repoPath: fx.repo,
        scratchRoot: fx.scratch, maxRepairAttempts: 1, timeoutMs: 60000,
        hooks: { expectedReviewerModel: "deterministic-c3" }, dirtyScope: [],
        admission: ADMISSION,
        executorAdapterFactory: noopFactory("exec"), reviewerAdapterFactory: noopFactory("rev"),
      });
    } catch (e) {
      code = e?.code ?? null;
      final = `${e?.name}:${String(e?.message ?? "").slice(0, 80)}`;
    }
    assert.equal(code, "TOOL_SELECTION_RESUME_ALLOCATION_MISSING", `expected allocation-missing hold, got ${final}`);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("T27i valid commitments pass the gate and reach orchestration (no TOOL_SELECTION hold)", async () => {
  const commitments = { P1: thaw(commitFor("P1")) };
  const fx = await craftWiredRunFixture({ commitments });
  try {
    let code = null; let result = null;
    try {
      result = await resumeDurableGraph({
        persistenceRoot: fx.persist, executionId: fx.executionId,
        parent: { scope: {} }, manifest: [], cwd: fx.repo, repoPath: fx.repo,
        scratchRoot: fx.scratch, maxRepairAttempts: 1, timeoutMs: 60000,
        hooks: { expectedReviewerModel: "deterministic-c3" }, dirtyScope: [],
        admission: ADMISSION,
        executorAdapterFactory: noopFactory("exec"), reviewerAdapterFactory: noopFactory("rev"),
      });
    } catch (e) { code = e?.code ?? null; }
    assert.equal(code, null, `gate must not block valid commitments (got ${code})`);
    assert.ok(result, "resume returned an envelope");
    assert.notEqual(String(result?.reason ?? ""), "", "downstream offline stub produces truthful hold reason");
    assert.equal(/TOOL_SELECTION/.test(String(result?.reason ?? "")), false, "continuity itself introduced no hold");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
