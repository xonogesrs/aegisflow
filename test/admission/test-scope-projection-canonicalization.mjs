// test/admission/test-scope-projection-canonicalization.mjs
//
// F1 — SCOPE PROJECTION CANONICALIZATION
// CARD: AUTOLOOP_OPEN_SOURCE_SCOPE_PROJECTION_CANONICALIZATION_REPAIR_1
//
// The admission scope projection（projectEnvelopeFields /
// assertMutationWithinAdmissionScope）and the C3B enforcement gate
//（enforceScopeGate）must agree on every path boundary. A boundary the
// projection reports as authorized while the gate canonicalizes it away
//（"looks allowed, refused at the end"）is an authority discrepancy: the
// projection accepted `src/../../outside.txt` under a `src` scope purely
// because it prefix-matched the string.
//
// This suite is the regression for that repair:
//   A  the corpus below covers parent traversal, nested traversal, absolute
//      paths, dot segments, trailing separators, globs, `.git`, untracked-yet
//      paths and symlink-adjacent representations;
//   D  PROJECTION_DECISION === ENFORCEMENT_DECISION for every fixture, both
//      root-aware and（for the resolvable subset）root-less;
//   C  every unresolvable / ambiguous / escaping fixture is refused by the
//      projection outright（throws — never "authorized");
//   E  no legitimate form was widened or lost: repo-relative, worktree-
//      relative, trailing-separator and explicit allowlist entries still pass.
//
// Zero provider, zero Pi, zero credential, zero container.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { classify } from "../../src/admission/classify.mjs";
import {
  AdmissionEnvelopeError,
  assertMutationWithinAdmissionScope,
  buildAdmissionRecord,
  projectEnvelopeFields,
} from "../../src/admission/policy-projection.mjs";
import { freezeAdmission } from "../../src/admission/admission-record.mjs";
import {
  canonicalScopeEntries,
  canonicalScopeEntry,
  captureScopeSnapshot,
  enforceScopeGate,
  matchesAnyPattern,
} from "../../src/c2d/mutation-scope.mjs";
import { deriveScopePatterns } from "../../src/v2/phase-task-card.mjs";
import { buildSubagentGraphHooks } from "../../src/subagent/subagent-graph-runner.mjs";
import { validateWriterSubagentResult } from "../../src/subagent/subagent-contract.mjs";

const EVIDENCE = {
  affected_files: { score: 1, reasons: ["fixture"] },
  affected_subsystems: { score: 0, reasons: ["fixture"] },
  dependency_depth: { score: 0, reasons: ["fixture"] },
  ambiguity: { score: 0, reasons: ["fixture"] },
  expected_execution_steps: { score: 0, reasons: ["fixture"] },
  verification_burden: { score: 0, reasons: ["fixture"] },
  external_dependencies: { score: 0, reasons: ["fixture"] },
  concurrency_potential: { score: 0, reasons: ["fixture"] },
  statefulness: { score: 0, reasons: ["fixture"] },
  rollback_complexity: { score: 0, reasons: ["fixture"] },
};

/** MEDIUM profile（writer capability granted）with one declared scope entry. */
const admissions = new Map();
function admissionForScope(scopeEntry) {
  if (admissions.has(scopeEntry)) return admissions.get(scopeEntry);
  const classification = classify({
    dimensionScores: { ...EVIDENCE, affected_files: { score: 2, reasons: ["two files"] }, affected_subsystems: { score: 1, reasons: ["scope seam"] } },
    riskSignals: [{ signal_id: "RS.AMBIGUOUS_SIGNAL", class: "MEDIUM", triggered: true, reason: "ambiguous" }],
    evidenceSufficient: true,
  });
  const admission = freezeAdmission(buildAdmissionRecord({ taskId: `F1-${scopeEntry}`, classification, mutationScope: [scopeEntry] }));
  admissions.set(scopeEntry, admission);
  return admission;
}

/** A real git worktree with an outside target dir for symlink-adjacent fixtures. */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "f1-scope-projection-"));
  const outside = mkdtempSync(join(tmpdir(), "f1-scope-outside-"));
  mkdirSync(join(dir, "src", "sub", "dir"), { recursive: true });
  writeFileSync(join(dir, "src", "a.txt"), "a\n");
  writeFileSync(join(dir, "outside.txt"), "o\n");
  symlinkSync(outside, join(dir, "escape-link"));
  symlinkSync("src", join(dir, "in-repo-link"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "f1@example.invalid"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "f1"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir, stdio: "ignore" });
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  return { dir, outside };
}

// ── the two decision functions under test ───────────────────────────────

/**
 * PROJECTION_DECISION — would the admission scope projection authorize this
 * declared boundary? Any fail-closed refusal is a DENY (the projection never
 * returns a partial grant: it either throws or returns a non-empty scope).
 */
function projectionDecision(scopeEntry, boundary, repositoryRoot) {
  const admission = admissionForScope(scopeEntry);
  try {
    const projected = projectEnvelopeFields({
      admission,
      nodeRole: "writer",
      mutationScopeFromPhase: [boundary],
      repositoryRoot,
    });
    return Array.isArray(projected.mutationScope) && projected.mutationScope.length > 0 ? "ALLOW" : "DENY";
  } catch (e) {
    if (e instanceof AdmissionEnvelopeError) return "DENY";
    throw e;
  }
}

/**
 * ENFORCEMENT_DECISION — would the C3B enforcement gate authorize a change at
 * this declared boundary? This is the gate's own canonicalizer plus the
 * production pattern derivation（phase-task-card canonicalizes a declared
 * boundary, then the orchestrator expands it to subtree globs, then
 * matchesAnyPattern decides）. An entry the gate cannot canonicalize grants
 * nothing — the declaration never becomes a scope.
 */
function enforcementDecision(scopeEntry, boundary, repositoryRoot) {
  const entries = canonicalScopeEntries([scopeEntry], repositoryRoot);
  if (entries === null || entries.length === 0) return "DENY";
  const canonical = canonicalScopeEntry(boundary, repositoryRoot);
  if (!canonical) return "DENY";
  return matchesAnyPattern(canonical, deriveScopePatterns(entries)) ? "ALLOW" : "DENY";
}

// ── A / D — the boundary fixture corpus ─────────────────────────────────

const BOUNDARY_FIXTURES = [
  // Legitimate forms（E）— these MUST stay ALLOW on both sides.
  { name: "repo-relative file inside scope", scope: "src/", boundary: "src/a.txt", expect: "ALLOW" },
  { name: "nested repo-relative path inside scope", scope: "src/", boundary: "src/sub/dir/deep.txt", expect: "ALLOW" },
  { name: "canonical in-scope directory", scope: "src/", boundary: "src", expect: "ALLOW" },
  { name: "trailing separator on the declared boundary", scope: "src/", boundary: "src/", expect: "ALLOW" },
  { name: "not-yet-existing in-scope path", scope: "src/", boundary: "src/new.txt", expect: "ALLOW" },
  { name: "scope entry and boundary identical", scope: "src/a.txt", boundary: "src/a.txt", expect: "ALLOW" },

  // Outside the declared root.
  { name: "sibling outside the scope root", scope: "src/", boundary: "outside.txt", expect: "DENY" },
  // A declared file-shaped entry is still a subtree root — pre-existing
  // semantics, unchanged by this repair（the gate expands it to `entry/**`）.
  { name: "path under a file-shaped entry", scope: "src/a.txt", boundary: "src/a.txt/child", expect: "ALLOW" },

  // Traversal.
  { name: "parent traversal", scope: "src/", boundary: "../outside.txt", expect: "DENY" },
  { name: "nested parent traversal", scope: "src/", boundary: "src/../../outside.txt", expect: "DENY" },
  { name: "deep parent traversal", scope: "src/", boundary: "src/sub/dir/../../../../outside.txt", expect: "DENY" },
  { name: "traversal scope entry", scope: "src/../..", boundary: "src/a.txt", expect: "DENY" },

  // Absolute.
  { name: "absolute boundary", scope: "src/", boundary: "/etc/passwd", expect: "DENY" },
  { name: "absolute scope entry", scope: "/src", boundary: "/src/a.txt", expect: "DENY" },

  // Non-canonical spellings.
  { name: "dot segment inside the path", scope: "src/", boundary: "src/./a.txt", expect: "DENY" },
  { name: "dot boundary", scope: "src/", boundary: ".", expect: "DENY" },
  { name: "empty boundary", scope: "src/", boundary: "", expect: "DENY" },
  { name: "untrimmed boundary", scope: "src/", boundary: " src/a.txt", expect: "DENY" },
  { name: "backslash boundary", scope: "src/", boundary: "src\\a.txt", expect: "DENY" },
  { name: "duplicate separator", scope: "src/", boundary: "src//a.txt", expect: "DENY" },

  // `.git`.
  { name: ".git boundary", scope: ".git", boundary: ".git/config", expect: "DENY" },
  { name: "nested .git boundary", scope: "src/", boundary: "src/.git/hooks/pre-commit", expect: "DENY" },

  // Ambiguous（glob）declarations.
  { name: "glob scope entry", scope: "src/**", boundary: "src/a.txt", expect: "DENY" },
  { name: "glob boundary", scope: "src/", boundary: "src/**", expect: "DENY" },

  // Symlink-adjacent representations（resolvable only with a repository root）.
  { name: "symlink-adjacent boundary, target outside the repo", scope: "src/", boundary: "escape-link/child.txt", expect: "DENY", requiresRoot: true },
  { name: "symlink scope entry, target outside the repo", scope: "escape-link/", boundary: "escape-link/child.txt", expect: "DENY", requiresRoot: true },
  { name: "symlink-adjacent representation, target inside the repo", scope: "in-repo-link/", boundary: "in-repo-link/a.txt", expect: "DENY", requiresRoot: true },
  { name: "symlink scope entry, target inside the repo", scope: "in-repo-link", boundary: "in-repo-link/a.txt", expect: "DENY", requiresRoot: true },
];

test("D: PROJECTION_DECISION === ENFORCEMENT_DECISION for every fixture (root-aware)", (t) => {
  const { dir } = makeRepo(t);
  for (const fixture of BOUNDARY_FIXTURES) {
    const projection = projectionDecision(fixture.scope, fixture.boundary, dir);
    const enforcement = enforcementDecision(fixture.scope, fixture.boundary, dir);
    assert.equal(
      projection,
      enforcement,
      `${fixture.name}: projection=${projection} enforcement=${enforcement}`,
    );
    assert.equal(
      projection,
      fixture.expect,
      `${fixture.name}: expected ${fixture.expect}, projection says ${projection}`,
    );
  }
});

test("D: the same agreement holds without a repository root (resolvable subset)", (t) => {
  const { dir } = makeRepo(t);
  for (const fixture of BOUNDARY_FIXTURES) {
    const projection = projectionDecision(fixture.scope, fixture.boundary, null);
    const enforcement = enforcementDecision(fixture.scope, fixture.boundary, null);
    assert.equal(
      projection,
      enforcement,
      `${fixture.name} (root-less): projection=${projection} enforcement=${enforcement}`,
    );
  }
  // Symlink-adjacent fixtures are the ONLY representations a root-less
  // projection cannot resolve（it is lexical by construction）, so the
  // root-backed decision is strictly stronger there — never the other way
  // round. Production wires the root（subagent-graph-runner passes the
  // isolated worktree root）; this assertion keeps the limitation visible.
  for (const fixture of BOUNDARY_FIXTURES.filter((f) => f.requiresRoot)) {
    assert.equal(projectionDecision(fixture.scope, fixture.boundary, dir), "DENY", `${fixture.name}: root-backed projection DENIES`);
    assert.equal(enforcementDecision(fixture.scope, fixture.boundary, dir), "DENY", `${fixture.name}: the gate DENIES`);
  }
  assert.equal(projectionDecision("escape-link/", "escape-link/child.txt", null), "ALLOW", "root-less projection is lexical for a symlink entry");
  assert.equal(projectionDecision("escape-link/", "escape-link/child.txt", dir), "DENY", "root-backed projection resolves the symlink");
});

test("A/D: the real gate agrees with the projection on materialized changes", (t) => {
  const { dir, outside } = makeRepo(t);
  const scope = "src/";
  const patterns = deriveScopePatterns(canonicalScopeEntries([scope], dir));
  const cases = [
    { name: "modify an in-scope file", boundary: "src/a.txt", mutate: () => writeFileSync(join(dir, "src", "a.txt"), "a2\n"), ok: true },
    { name: "add a nested in-scope file", boundary: "src/sub/dir/deep.txt", mutate: () => { mkdirSync(join(dir, "src", "sub", "dir"), { recursive: true }); writeFileSync(join(dir, "src", "sub", "dir", "deep.txt"), "d\n"); }, ok: true },
    { name: "modify a file outside the scope", boundary: "outside.txt", mutate: () => writeFileSync(join(dir, "outside.txt"), "o2\n"), ok: false },
    { name: "add a symlink-adjacent path inside the scope", boundary: "src/newlink", mutate: () => { writeFileSync(join(outside, "target.txt"), "t\n"); symlinkSync(join(outside, "target.txt"), join(dir, "src", "newlink")); }, ok: false },
  ];
  for (const c of cases) {
    const baseline = captureScopeSnapshot(dir);
    c.mutate();
    const gate = enforceScopeGate(dir, baseline, captureScopeSnapshot(dir), patterns, []);
    const projection = projectionDecision(scope, c.boundary, dir);
    assert.equal(gate.ok, c.ok, `${c.name}: gate=${gate.ok} violations=${JSON.stringify(gate.violations.map((v) => v.reason))}`);
    assert.equal(projection, c.ok ? "ALLOW" : "DENY", `${c.name}: projection must match the gate`);
    if (!c.ok) {
      const reasons = gate.violations.map((v) => v.reason);
      assert.ok(reasons.includes(c.boundary === "outside.txt" ? "outside_allowlist" : "path_escape_or_symlink_or_git"), `${c.name}: reasons=${JSON.stringify(reasons)}`);
    }
    // restore the worktree for the next case
    execFileSync("git", ["checkout", "--", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["clean", "-qfdx"], { cwd: dir, stdio: "ignore" });
  }
});

// ── C — fail closed, never "authorized" ────────────────────────────────

test("C: the projection refuses every undecidable declaration instead of authorizing it", (t) => {
  const { dir } = makeRepo(t);
  const medium = admissionForScope("src/");
  const refusals = [
    { name: "nested parent traversal boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["src/../../outside.txt"] } },
    { name: "absolute boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["/etc/passwd"] } },
    { name: "dot-segment boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["src/./a.txt"] } },
    { name: "glob boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["src/**"] } },
    { name: "empty boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: [""] } },
    { name: "non-string boundary", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: [42] } },
    { name: "symlink-adjacent boundary with a root", args: { admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["escape-link/child.txt"], repositoryRoot: dir } },
    { name: "absolute admission scope", args: { admission: admissionForScope("/src"), nodeRole: "writer", mutationScopeFromPhase: ["/src/a.txt"] } },
    { name: "traversal admission scope", args: { admission: admissionForScope("src/../.."), nodeRole: "writer", mutationScopeFromPhase: ["src/a.txt"] } },
    { name: "glob admission scope", args: { admission: admissionForScope("src/**"), nodeRole: "writer", mutationScopeFromPhase: ["src/a.txt"] } },
  ];
  for (const r of refusals) {
    assert.throws(
      () => projectEnvelopeFields(r.args),
      (e) => e instanceof AdmissionEnvelopeError && e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION",
      `${r.name} must fail closed`,
    );
  }
  for (const p of ["src/../../outside.txt", "/etc/passwd", "src/./a.txt", "src/**", ""]) {
    assert.throws(
      () => assertMutationWithinAdmissionScope(medium, [p]),
      (e) => e instanceof AdmissionEnvelopeError && e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION",
      `assertMutationWithinAdmissionScope must refuse ${JSON.stringify(p)}`,
    );
  }
});

// ── E — no authority expansion ─────────────────────────────────────────

test("E: legitimate repo-relative / worktree-relative scopes are unchanged", (t) => {
  const { dir } = makeRepo(t);
  const medium = admissionForScope("src/");
  const projected = projectEnvelopeFields({ admission: medium, nodeRole: "writer", mutationScopeFromPhase: ["src/sub/dir/deep.txt"], repositoryRoot: dir });
  // The envelope carries the CANONICAL boundary（trailing separators stripped）.
  assert.deepEqual(projected.mutationScope, ["src/sub/dir/deep.txt"]);
  assert.equal(projected.writerAllowed, true);
  // An admitted scope entry with a trailing separator still authorizes its own subtree.
  assert.equal(assertMutationWithinAdmissionScope(medium, ["src/a.txt", "src/sub/dir/deep.txt"]), true);
  assert.equal(assertMutationWithinAdmissionScope(medium, ["src"], { repositoryRoot: dir }), true);
  // …and the projection still narrows to the admission scope without widening it.
  const wide = admissionForScope("src");
  const narrowed = projectEnvelopeFields({ admission: wide, nodeRole: "writer", mutationScopeFromPhase: [] });
  assert.deepEqual(narrowed.mutationScope, ["src"]);
  // Read-only roles keep their previous shape exactly.
  const ro = projectEnvelopeFields({ admission: medium, nodeRole: "readonly-analyst" });
  assert.equal(ro.mutationScope, null);
});

// ── the writer-result scope validation shares the same seam ────────────

test("validateWriterSubagentResult: canonical containment, root-aware", (t) => {
  const { dir } = makeRepo(t);
  const HEAD = "h".repeat(40);
  const result = (filesChanged) => ({
    schema_version: "autoloop.subagent.writer-result/v1",
    status: "PASS",
    agentExecutionId: "agent_x",
    inputContextIdentity: "ctx",
    outputSchemaIdentity: "autoloop.subagent.writer-result/v1",
    filesChanged,
    testsExecuted: ["node -e 0"],
    diffSummary: "1 file changed",
    scopeVerification: { ok: true, violations: [] },
    testResults: { passed: 1, failed: 0, total: 1 },
    claims: [], evidenceReferences: [], filesInspected: [], commandsExecuted: [], assumptions: [], uncertainties: [],
    recommendedNextAction: "STOP",
    summary: "s",
    worktreeIdentity: { head: HEAD },
  });
  const validate = (filesChanged, { mutationScope = ["src/"], hostChangedPaths = filesChanged } = {}) =>
    validateWriterSubagentResult(result(filesChanged), {
      expectedAgentExecutionId: "agent_x",
      expectedInputContextIdentity: "ctx",
      expectedBaseCommit: HEAD,
      mutationScope,
      hostChangedPaths,
      repoHeadClean: true,
      repositoryRoot: dir,
    });

  assert.equal(validate(["src/a.txt"]).ok, true, "an in-scope writer result passes");

  const escaped = validate(["src/../../outside.txt"]);
  assert.ok(escaped.errors.includes("filesChanged_out_of_scope:src/../../outside.txt"), `escaped path must be out of scope: ${escaped.errors.join(",")}`);
  assert.ok(escaped.errors.includes("host_changed_out_of_scope:src/../../outside.txt"));

  const symlinkAdjacent = validate(["escape-link/a.txt"]);
  assert.ok(symlinkAdjacent.errors.includes("host_changed_out_of_scope:escape-link/a.txt"), "symlink-adjacent host path must be out of scope");

  const undecidableScope = validate(["src/a.txt"], { mutationScope: ["src/../../etc"] });
  assert.ok(undecidableScope.errors.includes("host_changed_out_of_scope:src/a.txt"), "an undecidable declared scope authorizes nothing");

  const absoluteScope = validate(["src/a.txt"], { mutationScope: ["/src"] });
  assert.ok(absoluteScope.errors.includes("host_changed_out_of_scope:src/a.txt"));
});

// ── the production wiring that supplies the root ───────────────────────

test("wiring: the writer envelope projection receives the isolated worktree root", async (t) => {
  const { dir } = makeRepo(t);
  const resultsDir = join(dir, "..", `f1-results-${process.pid}`);
  t.after(() => rmSync(resultsDir, { recursive: true, force: true }));
  // The symlink-adjacent boundary is INSIDE its declared scope lexically; only
  // the root lets the projection resolve the symlink away.
  const admission = admissionForScope("escape-link/");
  const boundaryFor = (artifact) => ({
    phases: [{
      phase_id: "P1",
      effects: { artifact_mutation: "required", boundaries: { artifact: [artifact] } },
      runtime: { mode: "subagent", agentRole: "writer" },
    }],
  });
  const start = (ir) => buildSubagentGraphHooks({
    ir, resultsDir, dependencyExecutionId: "exec_" + "ab".repeat(16), hooks: {}, admission, admissionDigest: null, durableGraphGeneration: 0, telemetry: null,
  }).onPhaseStart("P1");

  // With the worktree root the projection resolves the boundary exactly as the
  // gate does: a symlink-adjacent boundary is refused (fail closed).
  const withRoot = boundaryFor("escape-link/child.txt");
  withRoot.phases[0].runtime.worktreePath = dir;
  await start(withRoot);
  assert.equal(withRoot.phases[0].runtime.admissionViolation?.code, "ADMISSION_MUTATION_SCOPE_VIOLATION", "root-backed projection must refuse the symlink-adjacent boundary");

  // Without a worktree root（no isolated worktree known）the projection is
  // lexical — the assertion pins that it is the ROOT that carried the
  // symlink resolution, not some unconditional rejection.
  const withoutRoot = boundaryFor("escape-link/child.txt");
  await start(withoutRoot);
  assert.equal(withoutRoot.phases[0].runtime.admissionViolation, undefined, "without a root the projection is lexical");
  assert.deepEqual(withoutRoot.phases[0].runtime.mutationScope, ["escape-link/child.txt"]);

  // Normal operation: an in-scope boundary projects to its canonical scope.
  const normal = boundaryFor("src/sub/dir/");
  normal.phases[0].runtime.worktreePath = dir;
  const normalAdmission = admissionForScope("src/");
  await buildSubagentGraphHooks({
    ir: normal, resultsDir, dependencyExecutionId: "exec_" + "ab".repeat(16), hooks: {}, admission: normalAdmission, admissionDigest: null, durableGraphGeneration: 0, telemetry: null,
  }).onPhaseStart("P1");
  assert.equal(normal.phases[0].runtime.admissionViolation, undefined);
  assert.deepEqual(normal.phases[0].runtime.mutationScope, ["src/sub/dir"]);
  assert.ok(Array.isArray(normal.phases[0].runtime.toolPermissions) && normal.phases[0].runtime.toolPermissions.length > 0);
});
