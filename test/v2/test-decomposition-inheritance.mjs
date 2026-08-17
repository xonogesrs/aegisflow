// test/v2/test-decomposition-inheritance.mjs
//
// DECOMP-OPT1-PC1 — unit tests for the inheritance core（pure / deterministic）:
//   U-1  manifest deterministic identity
//   U-2  REUSE
//   U-3  REVALIDATE
//   U-4  RECOMPUTE
//   U-5  relevant drift invalidation
//   U-6  irrelevant drift preservation
//   U-7  corrupt manifest fail closed
//   U-8  missing evidence fail closed
//   U-9  child scope containment（packet never widens authority）
//   U-12 superseded parent
//   F3A guard + F3A/F3B baseline projection（R1-C）.
//
// Offline only（temp git worktree）.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  buildInheritanceManifest,
  verifyManifestIntegrity,
  computeManifestSha256,
  resolveFactDisposition,
  evaluateInvalidations,
  buildChildExecutionPacket,
  deriveF3ABaseline,
  guardRepositoryIdentity,
  createInheritedFact,
  FRESHNESS_POLICIES,
  INVALIDATION_CONDITIONS,
  INHERITANCE_HOLD,
  DECOMPOSITION_INHERITANCE_SCHEMA,
  CHILD_EXECUTION_PACKET_SCHEMA,
} from "../../src/v2/decomposition-inheritance.mjs";

const REPO_IDENTITY = {
  repository_root_identity: "/repo/root",
  worktree_identity: "/repo/worktree",
  git_common_dir_identity: "/repo/.git",
  expected_head: "a".repeat(40),
  expected_tree: "b".repeat(40),
  expected_ref: "master",
  origin_url: "https://example.com/repo.git",
  origin_master: "c".repeat(40),
  expected_worktree_state: "clean",
};
const INPUT_FP = "1".repeat(64);
const IR_SHA = "2".repeat(64);
const DAG_SHA = "3".repeat(64);
const PHASES = ["p_a", "p_b", "p_c"];
const EVIDENCE_REFS = ["4".repeat(64), "5".repeat(64)];

function manifestOverrides(overrides = {}) {
  return {
    parentCardId: "parent-1",
    parentGeneration: 1,
    graphRunId: "run-1",
    repositoryIdentity: REPO_IDENTITY,
    inputFingerprint: INPUT_FP,
    irSha: IR_SHA,
    dagSha: DAG_SHA,
    phaseIds: PHASES,
    authorityRefs: ["authority-a"],
    contractRefs: [{ key: "repair_budget", value: "0" }],
    dependencyRefs: ["dep-digest"],
    evidenceRefs: EVIDENCE_REFS,
    ...overrides,
  };
}

function gitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "inh-unit-"));
  execFileSync("git", ["init", "-b", "master", dir], { stdio: "ignore" });
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-m", "base"], { stdio: "ignore" });
  return dir;
}

// ── U-1 deterministic identity ───────────────────────────────────────────

test("U-1: identical inputs → identical manifest identity; any input change → new identity", () => {
  const a = buildInheritanceManifest(manifestOverrides());
  const b = buildInheritanceManifest(manifestOverrides());
  assert.equal(a.manifestSha256, b.manifestSha256);
  assert.equal(a.manifestIdentity, b.manifestIdentity);
  assert.equal(a.manifest.manifestSha256, computeManifestSha256(a.manifest));
  assert.equal(a.manifestIdentity, `decompInherit_${a.manifestSha256.slice(0, 16)}`);
  // wall-clock metadata never enters the digest
  const c = buildInheritanceManifest(manifestOverrides({ createdAt: "2099-01-01T00:00:00.000Z" }));
  assert.equal(a.manifestSha256, c.manifestSha256);
  // input change → new identity
  const d = buildInheritanceManifest(manifestOverrides({ irSha: "f".repeat(64) }));
  assert.notEqual(a.manifestSha256, d.manifestSha256);
  // head change（F3A drift）→ new identity
  const e = buildInheritanceManifest(manifestOverrides({ repositoryIdentity: { ...REPO_IDENTITY, expected_head: "d".repeat(40) } }));
  assert.notEqual(a.manifestSha256, e.manifestSha256);
});

test("U-1b: manifest is schema-correct and carries all required sections", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  assert.equal(manifest.schema, DECOMPOSITION_INHERITANCE_SCHEMA);
  assert.equal(manifest.parentCardId, "parent-1");
  assert.equal(manifest.parentGeneration, 1);
  assert.equal(manifest.graphRunId, "run-1");
  assert.deepEqual(manifest.repositoryIdentity.expected_head, REPO_IDENTITY.expected_head);
  assert.deepEqual(manifest.repositoryIdentity.expected_tree, REPO_IDENTITY.expected_tree);
  assert.ok(Array.isArray(manifest.facts) && manifest.facts.length > 0);
  const kinds = new Set(manifest.facts.map((f) => f.kind));
  for (const k of ["PARENT_SPEC", "DECOMPOSITION_IR", "REPOSITORY_IDENTITY", "REF_METADATA", "AUTHORITY_CONTRACT", "DEPENDENCY", "EVIDENCE_REF"]) {
    assert.ok(kinds.has(k), `manifest must carry a ${k} fact`);
  }
  // every fact carries the full schema shape
  for (const f of manifest.facts) {
    for (const field of ["factId", "kind", "sourceAuthority", "sourceIdentity", "observedAt", "freshnessPolicy", "invalidationConditions", "defaultDisposition"]) {
      assert.ok(field in f, `fact ${f.factId} missing ${field}`);
    }
  }
});

// ── U-7 corrupt manifest fail closed ─────────────────────────────────────

test("U-7: tampered manifest fails integrity（never reused）", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const tampered = { ...manifest, repositoryIdentity: { ...manifest.repositoryIdentity, expected_head: "e".repeat(40) } };
  const iv = verifyManifestIntegrity(tampered);
  assert.equal(iv.ok, false);
  assert.equal(iv.code, INHERITANCE_HOLD.IDENTITY_DRIFT);
  // and dispositions over the corrupt manifest HOLD（no silent REUSE）
  const d = resolveFactDisposition({ fact: manifest.facts[0], live: { manifestIntegrity: false } });
  assert.equal(d.disposition, "HOLD");
  assert.equal(d.reason, INHERITANCE_HOLD.FRESHNESS_UNPROVEN);
});

test("U-7b: manifestIdentity mismatch fails closed", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const broken = { ...manifest, manifestIdentity: "decompInherit_0000000000000000" };
  assert.equal(verifyManifestIntegrity(broken).ok, false);
});

// ── U-2 / U-3 / U-4 dispositions ─────────────────────────────────────────

test("U-2: immutable facts REUSE while the identity is unchanged", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const f2 = manifest.facts.find((f) => f.factId === "f2:decomposition-ir");
  const d = resolveFactDisposition({ fact: f2, live: { manifestIntegrity: true } });
  assert.equal(d.disposition, "REUSE");
});

test("U-3: FILE_DIGEST facts REVALIDATE on relevant file change; REUSE when unchanged; REVALIDATE when unobserved", () => {
  const fact = createInheritedFact({
    factId: "spec:file",
    kind: "PARENT_SPEC",
    value: "aa".repeat(32),
    sourceAuthority: "gitObservation",
    sourceIdentity: "run",
    observedAt: null,
    freshnessPolicy: FRESHNESS_POLICIES.FILE_DIGEST,
    invalidationConditions: [INVALIDATION_CONDITIONS.FILE_DIGEST_CHANGED],
    filePaths: ["src/spec.txt"],
    contentHash: "aa".repeat(32),
  });
  // unchanged → REUSE
  assert.equal(resolveFactDisposition({ fact, live: { relevantFileDigests: { "src/spec.txt": "aa".repeat(32) } } }).disposition, "REUSE");
  // changed → REVALIDATE
  assert.equal(resolveFactDisposition({ fact, live: { relevantFileDigests: { "src/spec.txt": "bb".repeat(32) } } }).disposition, "REVALIDATE");
  // unobserved → REVALIDATE（freshness unproven, never silent REUSE）
  assert.equal(resolveFactDisposition({ fact, live: { relevantFileDigests: {} } }).disposition, "REVALIDATE");
});

test("U-4: F3A head drift → fail-closed HOLD in-run; RECOMPUTE when allowed at run boundary", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const f3a = manifest.facts.find((f) => f.factId === "f3a:repository-identity");
  // in-run drift（phases cannot commit）→ HOLD
  const d = resolveFactDisposition({ fact: f3a, live: { manifestIntegrity: true, head: "e".repeat(40), allowRecompute: false } });
  assert.equal(d.disposition, "HOLD");
  assert.equal(d.reason, INHERITANCE_HOLD.REPOSITORY_DRIFT);
  // run-boundary drift（manifest rebuild path）→ RECOMPUTE
  const d2 = resolveFactDisposition({ fact: f3a, live: { manifestIntegrity: true, head: "e".repeat(40), allowRecompute: true } });
  assert.equal(d2.disposition, "RECOMPUTE");
  // unchanged head → REUSE
  const d3 = resolveFactDisposition({ fact: f3a, live: { manifestIntegrity: true, head: REPO_IDENTITY.expected_head } });
  assert.equal(d3.disposition, "REUSE");
});

test("U-4b: TIME_SENSITIVE facts REVALIDATE（never silent REUSE）", () => {
  const fact = createInheritedFact({
    factId: "runtime:gen",
    kind: "DECOMPOSITION_IR",
    value: "x",
    sourceAuthority: "runtime",
    sourceIdentity: "run",
    observedAt: null,
    freshnessPolicy: FRESHNESS_POLICIES.TIME_SENSITIVE,
    invalidationConditions: [INVALIDATION_CONDITIONS.RUNTIME_GENERATION_CHANGED],
  });
  assert.equal(resolveFactDisposition({ fact, live: { manifestIntegrity: true } }).disposition, "REVALIDATE");
});

// ── U-5 / U-6 relevant vs irrelevant drift ──────────────────────────────

test("U-5/U-6: relevant drift invalidates only relevant facts; irrelevant drift preserves", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides({
    specFileDigests: [{ path: "src/owned.txt", sha256: "aa".repeat(32) }],
  }));
  const f3a = manifest.facts.find((f) => f.factId === "f3a:repository-identity");
  const spec = manifest.facts.find((f) => f.factId === "f1:spec-file:src/owned.txt");
  const ir = manifest.facts.find((f) => f.factId === "f2:decomposition-ir");

  // irrelevant drift（unrelated file digest changes; head/tree stable）
  const dispositions = evaluateInvalidations({
    manifest,
    live: { manifestIntegrity: true, head: REPO_IDENTITY.expected_head, treeSha: REPO_IDENTITY.expected_tree, relevantFileDigests: { "src/unrelated.txt": "ff".repeat(32) } },
  });
  const byId = Object.fromEntries(dispositions.map((d) => [d.factId, d.disposition]));
  assert.equal(byId[f3a.factId], "REUSE", "F3A preserved under irrelevant drift");
  assert.equal(byId[ir.factId], "REUSE", "IR preserved under irrelevant drift");
  // FILE_DIGEST fact with unobserved path → REVALIDATE（not stale REUSE）
  assert.equal(byId[spec.factId], "REVALIDATE");

  // relevant drift（owned file digest changed）
  const dispositions2 = evaluateInvalidations({
    manifest,
    live: { manifestIntegrity: true, head: REPO_IDENTITY.expected_head, treeSha: REPO_IDENTITY.expected_tree, relevantFileDigests: { "src/owned.txt": "bb".repeat(32) } },
  });
  const byId2 = Object.fromEntries(dispositions2.map((d) => [d.factId, d.disposition]));
  assert.equal(byId2[spec.factId], "REVALIDATE");
  assert.equal(byId2[f3a.factId], "REUSE", "F3A still preserved（file drift is not HEAD drift）");
});

// ── U-8 missing evidence fail closed ─────────────────────────────────────

test("U-8: evidence-missing invalidates EVIDENCE_REF facts（fail closed, never stale reuse）", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const ref = manifest.facts.find((f) => f.factId.startsWith("f6:evidence:"));
  const d = resolveFactDisposition({ fact: ref, live: { manifestIntegrity: true, evidenceMissing: true } });
  assert.equal(d.disposition, "HOLD");
  assert.equal(d.reason, INHERITANCE_HOLD.STALE_EVIDENCE_REUSED);
});

// ── U-9 child scope containment ─────────────────────────────────────────

test("U-9: packet carries child-local scope/mutation authority and never widens it", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const phase = {
    phase_id: "p_b",
    depends_on: ["p_a"],
    effects: { artifact_mutation: "required", boundaries: { artifact: ["src/b/"] } },
    covers: [{ requirement_id: "R2", completeness: "complete" }],
  };
  const dispositions = evaluateInvalidations({ manifest, live: { manifestIntegrity: true, head: REPO_IDENTITY.expected_head } });
  const { packet, packetSha256 } = buildChildExecutionPacket({
    childCardId: "p_b",
    manifest,
    phase,
    dispositions,
    inheritedEvidenceRefs: EVIDENCE_REFS,
    childLocalEvidenceRequirements: ["mutation-scope-gate", "writer-test-evidence"],
    authorizedScope: ["src/b"],
    unauthorizedScope: ["src/forbidden"],
    mutationAuthority: "writer-lease",
    dependencyBoundary: ["p_a"],
  });
  assert.equal(packet.schema, CHILD_EXECUTION_PACKET_SCHEMA);
  assert.equal(packet.childCardId, "p_b");
  assert.equal(packet.parentCardId, "parent-1");
  assert.equal(packet.inheritanceManifestSha256, manifest.manifestSha256);
  assert.equal(packet.mutationAuthority, "writer-lease");
  assert.deepEqual(packet.dependencyBoundary, ["p_a"]);
  assert.deepEqual(packet.authorizedScope, ["src/b"]);
  assert.deepEqual(packet.unauthorizedScope, ["src/forbidden"]);
  assert.deepEqual(packet.containment.artifactBoundaries, ["src/b/"]);
  assert.ok(/^[0-9a-f]{64}$/.test(packetSha256));
  // packet is deterministic
  const again = buildChildExecutionPacket({ childCardId: "p_b", manifest, phase, dispositions, inheritedEvidenceRefs: EVIDENCE_REFS, childLocalEvidenceRequirements: ["mutation-scope-gate", "writer-test-evidence"], authorizedScope: ["src/b"], unauthorizedScope: ["src/forbidden"], mutationAuthority: "writer-lease", dependencyBoundary: ["p_a"] });
  assert.equal(again.packetSha256, packetSha256);
  // mutation authority is derived from the phase, never inherited from parent
  const readOnlyPhase = { ...phase, effects: { artifact_mutation: "forbidden", boundaries: { artifact: [] } } };
  const { packet: roPacket } = buildChildExecutionPacket({ childCardId: "p_a", manifest, phase: readOnlyPhase, dispositions: [], authorizedScope: [], unauthorizedScope: [], mutationAuthority: "none", dependencyBoundary: [] });
  assert.equal(roPacket.mutationAuthority, "none");
});

// ── U-12 superseded parent ──────────────────────────────────────────────

test("U-12: superseded parent generation fails closed", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides({ parentGeneration: 2 }));
  const f4 = manifest.facts.find((f) => f.factId === "f4:authority-contract");
  const d = resolveFactDisposition({ fact: f4, live: { manifestIntegrity: true, supersededGeneration: true } });
  assert.equal(d.disposition, "HOLD");
  assert.equal(d.reason, INHERITANCE_HOLD.IDENTITY_DRIFT);
});

// ── F3A guard + baseline projection ─────────────────────────────────────

test("F3A guard: one rev-parse HEAD == frozen head → ok; drift → fail closed", () => {
  const dir = gitFixture();
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const ok = guardRepositoryIdentity({ cwd: dir, expectedHead: head });
    assert.equal(ok.ok, true);
    assert.equal(ok.head, head);
    assert.equal(ok.tree_implied, head);
    const bad = guardRepositoryIdentity({ cwd: dir, expectedHead: "e".repeat(40) });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, INHERITANCE_HOLD.REPOSITORY_DRIFT);
    const nogit = guardRepositoryIdentity({ cwd: "/definitely/not/a/git/repo", expectedHead: head });
    assert.equal(nogit.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F3A/F3B baseline projection carries the frozen snapshot with explicit inheritance marker", () => {
  const { manifest } = buildInheritanceManifest(manifestOverrides());
  const baseline = deriveF3ABaseline(manifest);
  assert.ok(baseline, "baseline must project");
  assert.equal(baseline.head, REPO_IDENTITY.expected_head);
  assert.equal(baseline.branch, "master");
  assert.equal(baseline.expected_worktree_state, "clean");
  assert.equal(baseline.__inheritance.manifest_identity, manifest.manifestIdentity);
  assert.equal(baseline.__inheritance.manifest_sha256, manifest.manifestSha256);
  assert.equal(baseline.__inheritance.no_per_child_freshness_claim, true);
  assert.equal(baseline.__inheritance.guard_command, "git rev-parse HEAD");
  // F3B fields are the run-level snapshot（never re-observed per child）
  assert.equal(typeof baseline.ahead, "number");
  assert.equal(typeof baseline.behind, "number");
});
