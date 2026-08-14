// P0-RS1 — isolated scratch ownership / recursive deletion boundary tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOwnedScratchRoot,
  prepareOwnedScratchRoot,
  getScratchAuthorityToken,
  removeOwnedScratchRoot,
  ScratchOwnershipError,
} from "../src/runtime/scratch-ownership.mjs";
import { runColimaGraph } from "../src/runtime/colima-graph-runner.mjs";
import { wipeScratchPreserving } from "../src/v2/durable-graph.mjs";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "p0-rs1-scratch-"));
  const repo = join(base, "repo");
  const namespace = join(base, "scratch");
  const external = join(base, "external");
  mkdirSync(repo, { recursive: true });
  mkdirSync(namespace, { recursive: true });
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, "sentinel.txt"), "must-survive\n");
  return { base, repo, namespace, external };
}

test("P0-RS1 owned child cleanup succeeds and leaves namespace/external data intact", () => {
  const f = fixture();
  try {
    const owned = prepareOwnedScratchRoot({ scratchRoot: f.namespace, executionId: "exec_" + "01".repeat(16), repoPath: f.repo });
    const authorityToken = getScratchAuthorityToken(owned);
    writeFileSync(join(owned, "owned.txt"), "remove-me\n");

    const result = removeOwnedScratchRoot({ scratchRoot: f.namespace, executionId: "exec_" + "01".repeat(16), repoPath: f.repo, authorityToken });
    assert.equal(result.removed, true);
    assert.equal(existsSync(owned), false, "owned execution child removed");
    assert.equal(existsSync(f.namespace), true, "caller namespace retained");
    assert.equal(readFileSync(join(f.external, "sentinel.txt"), "utf8"), "must-survive\n", "external data survives");
    assert.equal(removeOwnedScratchRoot({ scratchRoot: f.namespace, executionId: "exec_" + "01".repeat(16), repoPath: f.repo, authorityToken }).removed, false, "missing owned child is idempotent no-op");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("P0-RS1 rejects root/repo/relative/traversal/unmarked deletion targets", () => {
  const f = fixture();
  try {
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: "/", executionId: "exec_root", repoPath: f.repo }), ScratchOwnershipError);
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: f.repo, executionId: "exec_repo", repoPath: f.repo }), ScratchOwnershipError);
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: join(f.repo, "child"), executionId: "exec_desc", repoPath: f.repo }), ScratchOwnershipError);
    const missingInsideRepo = join(f.repo, "missing", "scratch");
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: missingInsideRepo, executionId: "exec_missing_repo", repoPath: f.repo }), ScratchOwnershipError);
    assert.equal(existsSync(missingInsideRepo), false, "unsafe missing namespace is not created");
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: "relative-scratch", executionId: "exec_relative", repoPath: f.repo }), ScratchOwnershipError);
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: `${f.namespace}/../unsafe`, executionId: "exec_traversal", repoPath: f.repo }), ScratchOwnershipError);
    const ancestorLink = join(f.base, "namespace-link");
    symlinkSync(f.namespace, ancestorLink, "dir");
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: join(ancestorLink, "child"), executionId: "exec_ancestor_link", repoPath: f.repo }), ScratchOwnershipError);
    const worktree = join(f.base, "worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: /isolated/worktrees/example\n");
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: worktree, executionId: "exec_worktree", repoPath: f.repo }), ScratchOwnershipError);
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: join(worktree, "scratch"), executionId: "exec_nested_worktree", repoPath: f.repo }), ScratchOwnershipError);
    assert.throws(() => assertOwnedScratchRoot({ ownedRoot: f.namespace }), ScratchOwnershipError);
    assert.throws(() => wipeScratchPreserving({ scratchRoot: f.repo, executionId: "exec_unowned", repoPath: f.repo, preserve: [] }), ScratchOwnershipError);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("P0-RS1 rejects symlink namespace/owned-root escape and never follows child symlink", () => {
  const f = fixture();
  try {
    const namespaceLink = join(f.base, "namespace-link");
    symlinkSync(f.namespace, namespaceLink, "dir");
    assert.throws(() => prepareOwnedScratchRoot({ scratchRoot: namespaceLink, executionId: "exec_link", repoPath: f.repo }), ScratchOwnershipError);

    const owned = prepareOwnedScratchRoot({ scratchRoot: f.namespace, executionId: "exec_" + "02".repeat(16), repoPath: f.repo });
    const executionId = "exec_" + "02".repeat(16);
    const authorityToken = getScratchAuthorityToken(owned);
    const escapeLink = join(owned, "escape");
    symlinkSync(f.external, escapeLink, "dir");
    wipeScratchPreserving({ scratchRoot: f.namespace, executionId, repoPath: f.repo, preserve: [], authorityToken });
    assert.equal(existsSync(escapeLink), false, "child symlink removed as link");
    assert.equal(readFileSync(join(f.external, "sentinel.txt"), "utf8"), "must-survive\n", "symlink target not recursively deleted");

    const preservedLink = join(owned, "results");
    symlinkSync(f.external, preservedLink, "dir");
    assert.throws(() => wipeScratchPreserving({ scratchRoot: f.namespace, executionId, repoPath: f.repo, preserve: ["results"], authorityToken }), ScratchOwnershipError, "preserved symlink must fail closed");
    rmSync(preservedLink, { force: true });

    rmSync(owned, { recursive: true, force: true });
    symlinkSync(f.external, owned, "dir");
    assert.throws(() => removeOwnedScratchRoot({ scratchRoot: f.namespace, executionId, repoPath: f.repo, authorityToken }), ScratchOwnershipError);
    assert.equal(readFileSync(join(f.external, "sentinel.txt"), "utf8"), "must-survive\n", "owned-root symlink target survives");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("P0-RS1 creates missing namespace but never accepts missing/unowned deletion root", () => {
  const f = fixture();
  try {
    const missingNamespace = join(f.base, "new", "scratch");
    const owned = prepareOwnedScratchRoot({ scratchRoot: missingNamespace, executionId: "exec_missing", repoPath: f.repo });
    assert.equal(existsSync(owned), true);
    assert.throws(() => assertOwnedScratchRoot({ ownedRoot: join(f.base, "new") }), ScratchOwnershipError);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("P0-RS1 forged marker cannot authorize recursive wipe", () => {
  const f = fixture();
  try {
    const executionId = "exec_" + "04".repeat(16);
    const owned = prepareOwnedScratchRoot({ scratchRoot: f.namespace, executionId, repoPath: f.repo });
    const marker = readFileSync(join(owned, ".autoloop-owner.json"), "utf8");
    const authorityToken = getScratchAuthorityToken(owned);
    removeOwnedScratchRoot({ scratchRoot: f.namespace, executionId, repoPath: f.repo, authorityToken });
    mkdirSync(owned, { recursive: true });
    writeFileSync(join(owned, ".autoloop-owner.json"), marker);
    mkdirSync(join(owned, "payload"), { recursive: true });
    assert.throws(
      () => wipeScratchPreserving({ scratchRoot: f.namespace, executionId, repoPath: f.repo, preserve: [], authorityToken: "f".repeat(64) }),
      ScratchOwnershipError,
    );
    assert.equal(existsSync(join(owned, "payload")), true, "forged marker payload survives rejected wipe");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("P0-RS1 production graph entry rejects repository scratch before runtime mount", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => runColimaGraph({
        ir: { phases: [{ phase_id: "R1", depends_on: [], effects: { artifact_mutation: "none" }, runtime: { mode: "readonly" } }] },
        parent: { scope: {} },
        cwd: f.repo,
        executionId: "exec_" + "03".repeat(16),
        repoPath: f.repo,
        scratchRoot: f.repo,
      }),
      ScratchOwnershipError,
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
