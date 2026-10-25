// test/test-security-findings-stress.mjs
//
// Stress-tests covering SEC-01 through SEC-07 and regression vectors:
// 1. Ephemeral vs forbidden vs reviewer delta evidence containment (SEC-01).
// 2. Admission authority deep-freeze, async drift detection, and memory provider gating (SEC-02).
// 3. Docker argv allowlist, network lockdown, intermediate symlink mount defense, and adapter path creation (SEC-03).
// 4. Review CAS replay determinism, public conflict rejection, timestamp immutability, and acceptance symlink refusal (SEC-04).
// 5. Risk and audit digest contract (SEC-05).
// 6. Scratch TTL deep-lock recursion preservation and symlinked root refusal (SEC-06).
// 7. Token alias freeze and payload stripping (SEC-07).
// 8. Strategy candidate derivation plan validation and dedup regression vector.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

// SEC-01 imports
import {
  captureScopeSnapshot,
  enforceScopeGate,
  computeDelta,
} from "../src/c2d/mutation-scope.mjs";
import { verifyWriteContainment } from "../src/c2d/write-containment.mjs";

// SEC-02 imports
import {
  freezeAdmission,
  validateAdmission,
  assertAdmissionFrozen,
  deepFreeze,
} from "../src/admission/admission-record.mjs";
import { classify, scanRiskSignals } from "../src/admission/classify.mjs";
import { buildAdmissionRecord } from "../src/admission/policy-projection.mjs";
import {
  runAdmittedGraph,
  assertProductionAdmission,
  PRODUCTION_GATE_HOLDS,
} from "../src/admission/admission-gate.mjs";

// SEC-03 imports
import {
  runTask,
  assertMountAllowlist,
  ColimaRuntimeError,
} from "../src/runtime/colima-runtime.mjs";
import { createColimaExecutorAdapter } from "../src/runtime/colima-executor-adapter.mjs";

// SEC-04 imports
import {
  createReviewJob,
  readReviewJob,
  advanceState,
  updateReviewJob,
  acceptReviewJob,
  findingsPath,
  verdictPath,
  readArtifactNoFollow,
} from "../src/governance/review-job.mjs";
import {
  persistFindings,
  persistVerdict,
  buildFindingsObject,
  buildVerdictObject,
  serializeArtifact,
  finalizePersisted,
  stageArtifacts,
  writeImmutableExclusive,
} from "../src/governance/review-job-writeback.mjs";
import { assertNotSymlink } from "../src/c2d/fs-atomic.mjs";

// SEC-05 imports
import { validateDecomposition } from "../src/validate-decomposition.mjs";

// SEC-06 imports
import { purgeScratchTtl } from "../src/shared/autoloop-paths.mjs";

// SEC-07 imports
import {
  createPayloadGuard,
  TRANSPORT_FREEZE,
} from "../src/v2/pi-transport-adapter.mjs";

// Strategy dedup imports
import { deriveStrategyCandidate, STRATEGY_CANDIDATE_HOLD } from "../src/evolution/candidate-strategy.mjs";
import { runEvolutionCycle } from "../src/evolution/loop.mjs";

function initGitRepo(dir) {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "audit@aegisflow.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Auditor"], { cwd: dir, stdio: "ignore" });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.js"), "// root\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// ── Stress-Test 1: Ephemeral versus forbidden versus reviewer delta evidence ─
test("STRESS-1: Forbidden paths ALWAYS win over ephemeral patterns and appear in delta & violations", () => {
  const repo = initGitRepo(mkdtempSync(join(tmpdir(), "stress1-repo-")));
  const secretDir = mkdtempSync(join(tmpdir(), "stress1-secret-"));
  const outsideSecret = join(secretDir, "secret.txt");

  try {
    const baseline = captureScopeSnapshot(repo);

    // Mutate only scratch/payload.js and root delivery.json
    mkdirSync(join(repo, "scratch"), { recursive: true });
    writeFileSync(join(repo, "scratch", "payload.js"), "console.log('payload');");
    writeFileSync(join(repo, "delivery.json"), JSON.stringify({ review: "bypass" }));

    const postMutation = captureScopeSnapshot(repo);

    // Admission: allow src/**, forbid scratch/** and delivery.json
    // Even with allowEphemeral: true, forbiddenPaths MUST fail closed
    const gateEphemeral = enforceScopeGate(
      repo,
      baseline,
      postMutation,
      ["src/**"],
      ["scratch/**", "delivery.json"],
      { allowEphemeral: true }
    );

    assert.equal(gateEphemeral.ok, false, "gate must fail when forbidden paths are modified");
    assert.equal(gateEphemeral.violations.length, 2, "both forbidden paths must be in violations");
    assert.ok(
      gateEphemeral.violations.every((v) => v.reason === "forbidden_path"),
      "violations must identify forbidden_path"
    );
    assert.equal(gateEphemeral.delta.length, 2, "complete changed-path inventory must remain in delta for reviewer");

    // Post-validation call with default / allowEphemeral: false and empty allow/forbid
    const postValidationGate = enforceScopeGate(
      repo,
      baseline,
      postMutation,
      [],
      [],
      { allowEphemeral: false }
    );
    assert.equal(postValidationGate.ok, false, "post-validation must reject any write");
    assert.equal(postValidationGate.delta.length, 2, "delta must contain all modified paths");

    // Traversal symlink under scratch pointing outside
    writeFileSync(outsideSecret, "secret-token");
    symlinkSync(outsideSecret, join(repo, "scratch", "leak-link"));

    const postSymlink = captureScopeSnapshot(repo);
    const gateSymlink = enforceScopeGate(
      repo,
      baseline,
      postSymlink,
      ["src/**"],
      [],
      { allowEphemeral: true }
    );
    assert.equal(gateSymlink.ok, false, "symlink escape must fail scope gate");
    assert.ok(
      gateSymlink.violations.some((v) => v.reason === "path_escape_or_symlink_or_git"),
      "must flag path_escape_or_symlink_or_git"
    );

    // Write containment walk
    const containment = verifyWriteContainment({
      root: repo,
      boundaries: ["src/**"],
    });
    assert.equal(containment.ok, false, "write containment must flag the symlink escape");
  } finally {
    rmSync(secretDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Stress-Test SEC-02: Admission authority deep freeze and async drift fence ─
const FULL_EVIDENCE = {
  affected_files: { score: 1, reasons: ["single README file"] },
  affected_subsystems: { score: 0, reasons: ["docs only"] },
  dependency_depth: { score: 0, reasons: ["no deps"] },
  ambiguity: { score: 0, reasons: ["exact text"] },
  expected_execution_steps: { score: 0, reasons: ["one edit"] },
  verification_burden: { score: 0, reasons: ["no tests"] },
  external_dependencies: { score: 0, reasons: ["none"] },
  concurrency_potential: { score: 0, reasons: ["none"] },
  statefulness: { score: 0, reasons: ["stateless"] },
  rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
};

test("STRESS-SEC02: Admission record is deep-frozen; async mutation or drift cannot inject memory provider", async () => {
  const c = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix typo") });
  const rawRecord = buildAdmissionRecord({ taskId: "TASK-SEC02", classification: c, mutationScope: ["docs/"] });
  rawRecord.memory_policy = { retrieval_allowed: false, query_allowed: false, writeback_allowed: false };

  const frozen = freezeAdmission(rawRecord);
  assert.ok(Object.isFrozen(frozen), "top-level record must be frozen");
  assert.ok(Object.isFrozen(frozen.memory_policy), "nested memory_policy must be deep-frozen");
  assert.ok(Object.isFrozen(frozen.budget), "nested budget must be deep-frozen");

  // Regression test: deepFreeze recurses into already-frozen nodes
  const nestedObj = { a: Object.freeze({ b: { c: 1 } }) };
  deepFreeze(nestedObj);
  assert.equal(Object.isFrozen(nestedObj.a.b), true, "inner object under already-frozen node must be frozen");

  // Attempting to mutate nested property in strict mode must throw
  assert.throws(
    () => {
      frozen.memory_policy.retrieval_allowed = true;
    },
    TypeError,
    "mutating nested property of deep-frozen admission must throw"
  );
  assert.equal(frozen.memory_policy.retrieval_allowed, false);

  // Async dispatch drift test: create admission and test runAdmittedGraph
  let runnerInvoked = false;
  let receivedMemory = null;
  const spyRunner = async (opts) => {
    runnerInvoked = true;
    receivedMemory = opts.memory ?? null;
    return { ok: true, nodeResults: [], transitions: [] };
  };

  // Normal run: retrieval_allowed is false -> runner never receives memory provider
  const res1 = await runAdmittedGraph({
    admission: frozen,
    runner: spyRunner,
  });
  assert.ok(runnerInvoked, "spy runner must be invoked for valid admission");
  assert.equal(receivedMemory, null, "runner must not receive memory provider when retrieval_allowed is false");

  // Positive test: retrieval_allowed is true -> runner DOES receive memory provider
  const rawPositive = buildAdmissionRecord({ taskId: "TASK-SEC02-POS", classification: c, mutationScope: ["docs/"] });
  rawPositive.memory_policy = { retrieval_allowed: true, query_allowed: true, writeback_allowed: true };
  const frozenPositive = freezeAdmission(rawPositive);
  runnerInvoked = false;
  receivedMemory = null;
  const resPositive = await runAdmittedGraph({
    admission: frozenPositive,
    runner: spyRunner,
  });
  assert.equal(resPositive.final ?? "OK", "OK");
  assert.ok(runnerInvoked, "runner must be invoked for valid admission with retrieval_allowed: true");
  assert.ok(receivedMemory !== null, "runner MUST receive memory provider when retrieval_allowed is true");
  assert.ok(typeof receivedMemory?.provider?.retrieveGraphMemory === "function", "memory provider must expose retrieveGraphMemory");

  // Accessor-based TOCTOU regression test: forging a getter that flips retrieval_allowed after N reads
  for (let K = 0; K <= 20; K++) {
    let reads = 0;
    const forged = {};
    for (const k of Object.keys(frozen)) {
      if (k === "memory_policy") continue;
      forged[k] = frozen[k];
    }
    Object.defineProperty(forged, "memory_policy", {
      enumerable: true,
      configurable: false,
      get() {
        reads++;
        return reads <= K
          ? { retrieval_allowed: false, query_allowed: false, writeback_allowed: false }
          : { retrieval_allowed: true, query_allowed: false, writeback_allowed: false };
      },
    });
    runnerInvoked = false;
    receivedMemory = null;
    const resAccessor = await runAdmittedGraph({
      admission: forged,
      runner: spyRunner,
    });
    if (runnerInvoked) {
      assert.equal(receivedMemory, null, `runner must NEVER receive memory provider when admission was signed with retrieval_allowed: false (failed at K=${K})`);
    } else {
      assert.equal(resAccessor.final, "HOLD", "drifted admission must hold");
    }
  }

  // Tampered admission: attempt to bypass with modified admission_id or memory_policy
  const tampered = { ...frozen, memory_policy: { ...frozen.memory_policy, retrieval_allowed: true } };
  runnerInvoked = false;
  const resTampered = await runAdmittedGraph({
    admission: tampered,
    runner: spyRunner,
  });
  assert.equal(resTampered.final, "HOLD");
  assert.equal(resTampered.holdCode, PRODUCTION_GATE_HOLDS.ADMISSION_DRIFT);
  assert.equal(runnerInvoked, false, "runner must never be invoked for drifted admission");
});

// ── Stress-Test 2: Docker argv allowlist, network lockdown, and mount canonicalization
test("STRESS-2: Docker argv reject dangerous flags, lock down network, intermediate symlinks, and adapter validates before mkdir", async () => {
  const dangerousArgs = [
    ["--net=host"],
    ["--net", "host"],
    ["--device=/dev/fuse"],
    ["--device", "/dev/fuse"],
    ["--volumes-from=x"],
    ["-v/etc:/etc"],
    ["--entrypoint=sh"],
    ["--entrypoint", "sh"],
    ["--user=root"],
    ["--env-file", "/tmp/env"],
    ["--privileged"],
    ["--cap-add=ALL"],
  ];

  for (const extraArgs of dangerousArgs) {
    assert.throws(
      () =>
        runTask({
          profile: "autoloop-w1",
          taskId: "stress-task",
          command: "true",
          extraArgs,
        }),
      (e) => e instanceof ColimaRuntimeError && e.message.includes("Forbidden docker argument in extraArgs"),
      `extraArgs ${JSON.stringify(extraArgs)} must throw ColimaRuntimeError`
    );
  }

  // Network lockdown: non-"none" must be rejected
  assert.throws(
    () =>
      runTask({
        profile: "autoloop-w1",
        taskId: "stress-task",
        command: "true",
        network: "host",
      }),
      (e) => e instanceof ColimaRuntimeError && e.message.includes("Forbidden docker network mode"),
    "network mode other than 'none' must be rejected"
  );

  const scratchRoot = mkdtempSync(join(tmpdir(), "stress2-scratch-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "stress2-repo-"));

  try {
    // 1. Lexical traversal "..": scratchRoot + "/../../etc"
    assert.throws(
      () =>
        assertMountAllowlist({
          roMounts: [],
          rwMounts: [{ source: `${scratchRoot}/../../etc`, target: "/work" }],
          scratchRoot,
        }),
      ColimaRuntimeError,
      "scratchRoot/../../etc must throw"
    );

    // 2. Intermediate symlink whose target is inside scratchRoot MUST be rejected
    const realSubDir = join(scratchRoot, "real-sub");
    mkdirSync(realSubDir, { recursive: true });
    const intermediateSymlink = join(scratchRoot, "link-sub");
    symlinkSync(realSubDir, intermediateSymlink);

    const sourceWithIntermediateLink = join(intermediateSymlink, "child.txt");
    assert.throws(
      () =>
        assertMountAllowlist({
          roMounts: [],
          rwMounts: [{ source: sourceWithIntermediateLink, target: "/scratch" }],
          scratchRoot,
        }),
      ColimaRuntimeError,
      "intermediate symlink component in mount source must throw"
    );

    // 3. Symlink inside scratch pointing outside scratch
    const secretDir = mkdtempSync(join(tmpdir(), "stress2-secret-"));
    const linkPath = join(scratchRoot, "escape-link");
    symlinkSync(secretDir, linkPath);

    assert.throws(
      () =>
        assertMountAllowlist({
          roMounts: [],
          rwMounts: [{ source: linkPath, target: "/work" }],
          scratchRoot,
        }),
      ColimaRuntimeError,
      "symlink pointing outside scratchRoot must throw"
    );

    // 4. Production Colima executor adapter must validate path BEFORE mkdirSync
    const illegalScratchPath = join(tmpdir(), `illegal-scratch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    assert.equal(existsSync(illegalScratchPath), false, "illegal path must not exist prior to test");

    const adapter = createColimaExecutorAdapter({
      profile: "autoloop-w1",
      repoPath: repoRoot,
      scratchRoot,
    });

    const reqIllegal = {
      phase: "executor",
      executionId: "exec-illegal-scratch",
      cwd: repoRoot,
      attempt: 1,
      timeoutMs: 1000,
      taskCard: {
        runtime: {
          mode: "readonly",
          command: "true",
          scratchPath: illegalScratchPath, // illegal caller-supplied scratch path outside scratchRoot
        },
      },
    };

    await assert.rejects(
      async () => {
        await adapter.runAdapter(reqIllegal);
      },
      ColimaRuntimeError,
      "adapter must reject caller-supplied scratchPath outside scratchRoot"
    );

    // The illegal path MUST NOT have been created on disk!
    assert.equal(existsSync(illegalScratchPath), false, "illegal scratch path must NOT be created on disk");

    rmSync(secretDir, { recursive: true, force: true });
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// ── Stress-Test 3: Review replay CAS, TOCTOU symlink refusal, and scratch TTL recursive mtime
test("STRESS-3: Review replay CAS idempotency, conflict rejection, acceptance symlink refusal, and deep-lock scratch preservation", async () => {
  const root = mkdtempSync(join(tmpdir(), "stress3-review-"));
  const candidateIdentity = {
    changedTreeIdentity: "a".repeat(64),
    patchSha256: "b".repeat(64),
    currentHead: "c".repeat(40),
    baseHead: "d".repeat(40),
    repository: "repo:test",
    branch: "main",
  };

  try {
    // Setup review job in RUNNING
    createReviewJob(
      {
        cardId: "CARD-STRESS",
        generation: 1,
        candidateIdentity,
        specId: "spec-stress",
        specDigest: "e".repeat(64),
      },
      { root }
    );

    // Timestamp guard: artifactCreatedAt cannot be updated prior to RUNNING
    const prematureTs = updateReviewJob("CARD-STRESS", {
      patch: { artifactCreatedAt: new Date().toISOString() },
    }, { root });
    assert.equal(prematureTs.ok, false);
    assert.equal(prematureTs.code, "REVIEW_JOB_TIMESTAMP_RUNNING_ONLY");

    advanceState("CARD-STRESS", "REQUIRED", "PREPARED", { root });
    const running = advanceState("CARD-STRESS", "PREPARED", "RUNNING", { root });
    assert.equal(running.ok, true);
    assert.ok(running.job.artifactCreatedAt, "artifactCreatedAt must be minted on RUNNING");

    // Timestamp guard: artifactCreatedAt cannot be modified once set
    const immutableTs = updateReviewJob("CARD-STRESS", {
      patch: { artifactCreatedAt: "2020-01-01T00:00:00.000Z" },
    }, { root });
    assert.equal(immutableTs.ok, false);
    assert.equal(immutableTs.code, "REVIEW_JOB_TIMESTAMP_IMMUTABLE");

    // Erase attempt via undefined must also fail with REVIEW_JOB_TIMESTAMP_IMMUTABLE
    const eraseTs = updateReviewJob("CARD-STRESS", {
      patch: { artifactCreatedAt: undefined },
    }, { root });
    assert.equal(eraseTs.ok, false);
    assert.equal(eraseTs.code, "REVIEW_JOB_TIMESTAMP_IMMUTABLE");

    // Probe P4 regression test: caller cannot spoof createdAt to break legitimate idempotent retry
    const fStress = [{ findingId: "f-p4", subject: "s", description: "d", recommendedDisposition: "fix" }];
    const rootP4 = mkdtempSync(join(tmpdir(), "stress4-p4-"));
    const ciP4 = { changedTreeIdentity: "a".repeat(64), patchSha256: "b".repeat(64), currentHead: "c".repeat(40), baseHead: "d".repeat(40), repository: "repo:test", branch: "main" };
    createReviewJob({ cardId: "CARD-P4", generation: 1, candidateIdentity: ciP4, specId: "s", specDigest: "e".repeat(64) }, { root: rootP4 });
    advanceState("CARD-P4", "REQUIRED", "PREPARED", { root: rootP4 });
    advanceState("CARD-P4", "PREPARED", "RUNNING", { root: rootP4 });
    const p1 = persistFindings({ cardId: "CARD-P4", reviewerIdentity: "reviewer:1", findings: fStress, summary: "x", createdAt: "1999-01-01T00:00:00.000Z" }, { root: rootP4 });
    assert.equal(p1.ok, true);
    const p2 = persistFindings({ cardId: "CARD-P4", reviewerIdentity: "reviewer:1", findings: fStress, summary: "x" }, { root: rootP4 });
    assert.equal(p2.ok, true, "legitimate idempotent retry must succeed regardless of caller createdAt");
    assert.equal(p2.idempotent, true);
    rmSync(rootP4, { recursive: true, force: true });

    // Concurrent persistFindings with identical findings without caller createdAt:
    const findings = [{ findingId: "f1", subject: "s", description: "d", recommendedDisposition: "fix" }];
    const [r1, r2] = await Promise.all([
      Promise.resolve().then(() => persistFindings({ cardId: "CARD-STRESS", reviewerIdentity: "reviewer:1", findings, summary: "sum" }, { root })),
      Promise.resolve().then(() => persistFindings({ cardId: "CARD-STRESS", reviewerIdentity: "reviewer:1", findings, summary: "sum" }, { root })),
    ]);
    assert.ok(r1.ok && r2.ok, "concurrent replay with identical content must succeed");
    assert.equal(r1.findingsDigest, r2.findingsDigest);

    // Public API conflict rejection on persistFindings:
    const conflictingFindings = [{ findingId: "f2", subject: "conflict", description: "d2", recommendedDisposition: "reject" }];
    const rConflictFindings = persistFindings(
      { cardId: "CARD-STRESS", reviewerIdentity: "reviewer:1", findings: conflictingFindings, summary: "conflict summary" },
      { root }
    );
    assert.equal(rConflictFindings.ok, false, "conflicting findings replay must be rejected by public API");
    assert.equal(rConflictFindings.code, "REVIEW_ARTIFACT_CONFLICTING_REPLAY");

    // Persist verdict
    const vResult = persistVerdict({
      cardId: "CARD-STRESS",
      reviewerIdentity: "reviewer:1",
      verdict: "PASS",
      summary: "verdict summary",
      recommendedNextAction: "proceed",
    }, { root });
    assert.equal(vResult.ok, true);

    // Public API conflict rejection on persistVerdict:
    const rConflictVerdict = persistVerdict({
      cardId: "CARD-STRESS",
      reviewerIdentity: "reviewer:1",
      verdict: "REPAIR", // Conflicting verdict
      summary: "conflicting verdict summary",
      recommendedNextAction: "repair",
    }, { root });
    assert.equal(rConflictVerdict.ok, false, "conflicting verdict replay must be rejected by public API");
    assert.equal(rConflictVerdict.code, "REVIEW_ARTIFACT_CONFLICTING_REPLAY");

    // Advance to STAGED
    const persisted = advanceState("CARD-STRESS", "VERDICT_PRODUCED", "PERSISTED", { root });
    assert.equal(persisted.ok, true);
    const staged = advanceState("CARD-STRESS", "PERSISTED", "STAGED", { root });
    assert.equal(staged.ok, true);

    // Symlink refusal in acceptance path:
    // Replace findingsPath with a symlink pointing to an identical findings file elsewhere
    const fPath = findingsPath("CARD-STRESS", 1, { root });
    const fBytes = readFileSync(fPath, "utf8");
    const outsideFindings = join(root, "outside-findings.json");
    writeFileSync(outsideFindings, fBytes);
    rmSync(fPath, { force: true });
    symlinkSync(outsideFindings, fPath);

    // Public acceptance call MUST REFUSE symlink
    const acceptResult = acceptReviewJob({
      cardId: "CARD-STRESS",
      authorizationSource: "controller",
      trustedReviewerIdentity: "reviewer:1",
    }, { root });
    assert.equal(acceptResult.ok, false, "acceptReviewJob must reject symlinked findings artifact");
    assert.equal(acceptResult.code, "REVIEW_ARTIFACT_SYMLINK_REFUSED");

    // Restore real file to verify clean acceptance
    rmSync(fPath, { force: true });
    writeFileSync(fPath, fBytes);
    const cleanAccept = acceptReviewJob({
      cardId: "CARD-STRESS",
      authorizationSource: "controller",
      trustedReviewerIdentity: "reviewer:1",
    }, { root });
    assert.equal(cleanAccept.ok, true, "clean acceptance must succeed");
    assert.equal(cleanAccept.job.state, "ACCEPTED");

    // Scratch TTL preservation of deep directory with .lock file (depth > 8)
    const scratchRoot = mkdtempSync(join(tmpdir(), "stress3-scratch-"));
    const taskDir = join(scratchRoot, "task-deep-active");
    // Create 10 levels of subdirectories
    let currentDir = taskDir;
    for (let i = 1; i <= 10; i++) {
      currentDir = join(currentDir, `level-${i}`);
    }
    mkdirSync(currentDir, { recursive: true });
    const deepLock = join(currentDir, "worker.lock");
    writeFileSync(deepLock, "pid=9999");

    // Backdate all directories from taskDir down to currentDir to 48 hours ago
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000);
    let backdateDir = taskDir;
    utimesSync(backdateDir, twoDaysAgo, twoDaysAgo);
    for (let i = 1; i <= 10; i++) {
      backdateDir = join(backdateDir, `level-${i}`);
      utimesSync(backdateDir, twoDaysAgo, twoDaysAgo);
    }

    // Run purgeScratchTtl with 24h threshold
    const purgeResult = purgeScratchTtl({
      scratchRoot,
      maxAgeMs: 24 * 3600 * 1000,
    });

    assert.equal(purgeResult.purged, 0, "directory with deep .lock file must NOT be purged");
    assert.equal(purgeResult.retained, 1, "task directory must be retained");
    assert.equal(existsSync(taskDir), true, "taskDir must still exist on disk");
    assert.equal(existsSync(deepLock), true, "deep lock file must still exist on disk");

    // Refusal of symlinked scratchRoot:
    const victimDir = mkdtempSync(join(tmpdir(), "stress3-victim-"));
    const victimFile = join(victimDir, "victim.txt");
    writeFileSync(victimFile, "do not delete");
    const symlinkScratch = join(root, "symlinked-scratch");
    symlinkSync(victimDir, symlinkScratch);

    const victimPurgeResult = purgeScratchTtl({
      scratchRoot: symlinkScratch,
      maxAgeMs: 0, // expired immediately
    });
    assert.equal(victimPurgeResult.errors, 1, "symlinked scratchRoot must trigger error and fail closed");
    assert.equal(victimPurgeResult.purged, 0, "must not purge victim files");
    assert.equal(existsSync(victimFile), true, "victim file must remain untouched");

    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(victimDir, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Stress-Test SEC-05: Risk and audit digest contract ───────────────────────
test("STRESS-SEC05: Audit-dependent implementation card requires consumes_digest === true", () => {
  const parentCard = {
    card_id: "parent-sec05",
    mode: "IMPLEMENT",
    worktree_path: "/tmp/autoloop",
    base_branch: "main",
    limits: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
    scope: { allowed_paths: ["src/"], forbidden_paths: [] },
  };

  const manifest = [{ requirement_id: "R1", text: "req 1" }];

  const baseDecomposition = () => ({
    verdict: "DECOMPOSED",
    parent_goal: "test goal",
    execution_policy: { executor: "INHERIT_PARENT", reviewer: "EXTERNAL_GPT", multi_model_orchestration: false },
    child_cards: [
      {
        card_id: "c1",
        role_id: "audit",
        goal: "Audit",
        card_type: "READ_ONLY_AUDIT",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: [], forbidden_commands: [] },
        risk_level: "LOW",
        allowed_paths: ["src/"],
      },
      {
        card_id: "c2",
        role_id: "impl",
        goal: "Impl",
        card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: true },
        verification: { required_commands: [], forbidden_commands: [] },
        risk_level: "MEDIUM",
        allowed_paths: ["src/"],
        // consumes_digest to be configured per subtest
      },
    ],
    edges: [{ from: "audit", to: "impl" }],
    deferred_items: [],
    unresolved_items: [],
    coverage_map: [{ requirement_id: "R1", role_id: "impl", verification: "done" }],
    decomposition_evidence: ["evidence"],
  });

  // Variant 1: consumes_digest absent on impl card
  const vAbsent = baseDecomposition();
  const rAbsent = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vAbsent });
  assert.equal(rAbsent.valid, false, "absent consumes_digest must be invalid");
  assert.ok(rAbsent.errors.some((e) => e.rule === "MISSING_CONTRACT_DIGEST"));

  // Variant 2: consumes_digest is boolean false
  const vFalse = baseDecomposition();
  vFalse.child_cards[1].consumes_digest = false;
  const rFalse = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vFalse });
  assert.equal(rFalse.valid, false, "consumes_digest: false must be invalid");
  assert.ok(rFalse.errors.some((e) => e.rule === "MISSING_CONTRACT_DIGEST"));

  // Variant 3: consumes_digest is string "false"
  const vStringFalse = baseDecomposition();
  vStringFalse.child_cards[1].consumes_digest = "false";
  const rStringFalse = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vStringFalse });
  assert.equal(rStringFalse.valid, false, "string 'false' must be rejected");

  // Variant 4: consumes_digest is string "true"
  const vStringTrue = baseDecomposition();
  vStringTrue.child_cards[1].consumes_digest = "true";
  const rStringTrue = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vStringTrue });
  assert.equal(rStringTrue.valid, false, "string 'true' must be rejected (schema requires boolean)");

  // Variant 5: edge says consumes_digest: true, but impl card is absent
  const vEdgeOnly = baseDecomposition();
  vEdgeOnly.edges[0].consumes_digest = true;
  const rEdgeOnly = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vEdgeOnly });
  assert.equal(rEdgeOnly.valid, false, "edge-only consumes_digest must not bypass implementation card");
  assert.ok(rEdgeOnly.errors.some((e) => e.rule === "MISSING_CONTRACT_DIGEST"));

  // Variant 6: consumes_digest: true on impl card -> VALID
  const vValid = baseDecomposition();
  vValid.child_cards[1].consumes_digest = true;
  const rValid = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: vValid });
  assert.equal(rValid.valid, true, "consumes_digest: true must be valid");

  // Multi-requirement NOT_BENEFICIAL rejection
  const multiManifest = [{ requirement_id: "R1", text: "r1" }, { requirement_id: "R2", text: "r2" }];
  const rMultiNotBeneficial = validateDecomposition({
    parentCard,
    requirementManifest: multiManifest,
    decomposition: { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "test", decomposition_evidence: ["e"] },
  });
  assert.equal(rMultiNotBeneficial.valid, false, "multi-requirement NOT_BENEFICIAL must be disallowed");
  assert.ok(rMultiNotBeneficial.errors.some((e) => e.rule === "NOT_BENEFICIAL_DISALLOWED"));

  // High-risk NOT_BENEFICIAL rejection
  const highRiskParent = { ...parentCard, risk_level: "HIGH" };
  const rHighRiskNotBeneficial = validateDecomposition({
    parentCard: highRiskParent,
    requirementManifest: manifest,
    decomposition: { verdict: "DECOMPOSITION_NOT_BENEFICIAL", reason: "test", decomposition_evidence: ["e"] },
  });
  assert.equal(rHighRiskNotBeneficial.valid, false, "HIGH risk NOT_BENEFICIAL must be disallowed");
  assert.ok(rHighRiskNotBeneficial.errors.some((e) => e.rule === "NOT_BENEFICIAL_DISALLOWED"));
});

// ── Stress-Test 4 (SEC-07): Token freeze stripping aliases ───────────────────
test("STRESS-4: Token freeze validates tokens and strips all alias fields from wire payload", () => {
  const guard = createPayloadGuard();

  const maliciousPayload = {
    model: TRANSPORT_FREEZE.model,
    reasoning_effort: TRANSPORT_FREEZE.reasoningEffort,
    thinking: { type: "enabled" },
    max_completion_tokens: 4096,
    max_tokens: 1000000, // inflated alias
  };

  assert.throws(
    () => guard(maliciousPayload, { provider: TRANSPORT_FREEZE.provider }),
    (e) => e.name === "TransportError" && e.code === "max_tokens",
    "must reject mismatched alias token count"
  );

  const validWithAlias = {
    model: TRANSPORT_FREEZE.model,
    reasoning_effort: TRANSPORT_FREEZE.reasoningEffort,
    thinking: { type: "enabled" },
    max_tokens: 4096,
    max_completion_tokens: 4096,
  };

  const guarded = guard(validWithAlias, { provider: TRANSPORT_FREEZE.provider });
  assert.equal(guarded[TRANSPORT_FREEZE.maxTokenField], 4096);
  assert.equal(guarded.max_tokens, undefined, "max_tokens alias must be completely deleted from wire payload");
});

// ── Stress-Test Strategy: Strategy candidate derivation validates plan before dedup
test("STRESS-STRATEGY: Strategy candidate derivation validates plan before dedup lookup", () => {
  const storeRoot = mkdtempSync(join(tmpdir(), "stress-strategy-store-"));
  const baselineHead = "1234567890123456789012345678901234567890";
  const triggerEvent = {
    trigger_id: "trig-strat-1",
    signature: "sig-strategy-dedup",
    signal_class: "RECURRING_HOLD_PATTERN",
    evidence_refs: ["ev-1"],
  };

  const validPlan = {
    schema: "autoloop.evolution-improvement-plan/v1",
    kind: "AGENT_STRATEGY",
    plan_id: "plan-strat-1",
    strategy_plan: {
      dimension: "FANOUT_PARALLELISM",
      surface: "strategy://fanout_parallelism",
      from_value: "concurrency_1",
      to_value: "concurrency_2",
      params: { max_concurrent: 2 },
    },
    measurement_plan: {
      metric: "strategy_success_rate",
      direction: "increase",
    },
  };

  try {
    // 1. First derivation creates candidate
    const first = deriveStrategyCandidate({
      plan: validPlan,
      triggerEvent,
      baselineHead,
      baselineRevision: 1,
      storeRoot,
    });
    assert.equal(first.status, "CREATED");
    assert.ok(first.candidate.candidate_id);

    // 2. An invalid plan with same signature@baseline MUST fail validation and NOT return EXISTING
    const invalidPlan = {
      schema: "autoloop.evolution-improvement-plan/v1",
      kind: "AGENT_STRATEGY",
      plan_id: "plan-strat-invalid",
      strategy_plan: {
        dimension: "unknown_dimension_injection",
        surface: "strategy://unknown",
        to_value: "unknown",
        params: {},
      },
    };

    assert.throws(
      () => {
        deriveStrategyCandidate({
          plan: invalidPlan,
          triggerEvent,
          baselineHead,
          baselineRevision: 1,
          storeRoot,
        });
      },
      (e) => e.code.includes("PLAN_INVALID"),
      "invalid plan must throw PLAN_INVALID, not return EXISTING candidate"
    );

    // 3. A changed plan for the same signature@baseline is refused (candidate_id mismatch)
    const changedPlan = {
      ...validPlan,
      plan_id: "plan-strat-changed",
      strategy_plan: {
        ...validPlan.strategy_plan,
        to_value: "concurrency_4",
        params: { max_concurrent: 4 },
      },
    };

    assert.throws(
      () => {
        deriveStrategyCandidate({
          plan: changedPlan,
          triggerEvent,
          baselineHead,
          baselineRevision: 1,
          storeRoot,
        });
      },
      (e) => e.code.includes("PLAN_REFUSED"),
      "changed plan for same signature@baseline must throw PLAN_REFUSED"
    );

    // 4. Identical plan returns EXISTING
    const identical = deriveStrategyCandidate({
      plan: validPlan,
      triggerEvent,
      baselineHead,
      baselineRevision: 1,
      storeRoot,
    });
    assert.equal(identical.status, "EXISTING");
    assert.equal(identical.candidate.candidate_id, first.candidate.candidate_id);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});
