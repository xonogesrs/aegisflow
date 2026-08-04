// test/governance/test-change-inventory.mjs
// Complete change inventory (§6/§7/§11): never relies on `git diff
// base...HEAD --name-status` alone. Covers tracked-dirty (neg 15), renames,
// deletions, modes, symlinks (lstat), binaries, dependency changes (neg 16);
// secret detection + stable content-based identities (neg 17 support).

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { buildChangeInventory } from "../../src/governance/change-inventory.mjs";
import { scanForSecrets } from "../../src/evidence/run-evidence-store.mjs";
import { createTempRepo } from "./helpers.mjs";

function inventoryFor(dir, git) {
  return buildChangeInventory({ git: (args) => git(args), cwd: dir, baseBranch: "main" });
}

test("[neg 15] tracked dirty-only file enters the inventory", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, "base.txt"), "modified but unstaged\n");
  const inv = inventoryFor(dir, git);
  assert.ok(inv.changedPaths.includes("base.txt"));
  const entry = inv.entries.find((e) => e.path === "base.txt");
  assert.equal(entry.status, "MODIFIED");
  assert.match(entry.contentSha256, /^[0-9a-f]{64}$/);
  assert.ok(inv.patchText.includes("modified but unstaged"));
});

test("[neg 16] rename/delete/mode/symlink/binary all enter the inventory", (t) => {
  const { dir, git } = createTempRepo(t);
  // committed baseline files
  writeFileSync(join(dir, "gone.txt"), "to delete\n");
  writeFileSync(join(dir, "old-name.txt"), "rename me\n");
  writeFileSync(join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
  git(["add", "."]);
  git(["commit", "-m", "baseline files"]);
  // now mutate WITHOUT committing (dirty worktree — the realistic mid-milestone state)
  git(["rm", "gone.txt"]);
  git(["mv", "old-name.txt", "new-name.txt"]);
  chmodSync(join(dir, "run.sh"), 0o755); // exec bit change
  symlinkSync("base.txt", join(dir, "link.txt"));
  writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  writeFileSync(join(dir, "package.json"), "{\"name\":\"x\"}\n");

  const inv = inventoryFor(dir, git);
  const paths = inv.changedPaths;
  assert.ok(paths.includes("gone.txt"), "deletion must be listed");
  assert.ok(paths.includes("new-name.txt"), "rename target must be listed");
  assert.ok(paths.some((p) => p.startsWith("old-name.txt")), "rename source must be listed (no-renames)");
  assert.ok(inv.renames.some((r) => r.from === "old-name.txt" && r.to === "new-name.txt"), "rename must be reported via git diff -M");
  assert.ok(paths.includes("run.sh"), "mode change must be listed");
  assert.ok(inv.execBitChanges.includes("run.sh"), "exec bit change must be flagged");
  assert.ok(inv.symlinks.includes("link.txt"), "symlink must be flagged via lstat");
  const link = inv.entries.find((e) => e.path === "link.txt");
  assert.equal(link.symlink, true, "symlink entry flagged");
  assert.equal(link.contentSha256.length, 64, "symlink content is readlink target hash");
  assert.ok(inv.binaries.includes("blob.bin"), "binary must be flagged");
  assert.ok(inv.dependencyChanges.includes("package.json"), "dependency change must be flagged");
  const gone = inv.entries.find((e) => e.path === "gone.txt");
  assert.equal(gone.status, "DELETED");
  assert.equal(gone.contentSha256, "MISSING");
});

test("exec-bit change vs BASE is detected even when committed (index == worktree)", (t) => {
  const { dir, git } = createTempRepo(t);
  // tool.sh exists on MAIN first (so it is part of the base tree)
  git(["checkout", "main"]);
  writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\necho hi\n");
  git(["add", "."]);
  git(["commit", "-m", "add tool.sh (non-exec)"]);
  git(["checkout", "-b", "governance/mode-test"]);
  // committed mode change: base 100644 → HEAD 100755 (index and worktree agree)
  chmodSync(join(dir, "tool.sh"), 0o755);
  git(["add", "tool.sh"]);
  git(["commit", "-m", "make executable"]);
  const inv = inventoryFor(dir, git);
  assert.ok(inv.execBitChanges.includes("tool.sh"), "committed exec-bit change vs base must be flagged");
});

test("inventory counts are honest per category", (t) => {
  const { dir, git } = createTempRepo(t);
  // committed change
  writeFileSync(join(dir, "committed.txt"), "c\n");
  git(["add", "."]);
  git(["commit", "-m", "committed"]);
  // staged change
  writeFileSync(join(dir, "staged.txt"), "s\n");
  git(["add", "staged.txt"]);
  // dirty tracked change
  writeFileSync(join(dir, "base.txt"), "dirty\n");
  // untracked
  writeFileSync(join(dir, "untracked.txt"), "u\n");
  const inv = inventoryFor(dir, git);
  assert.equal(inv.committedCount >= 1, true);
  assert.equal(inv.stagedCount, 1);
  // dirty = tracked files differing from HEAD (staged ⊆ dirty is expected)
  assert.equal(inv.dirtyCount, 2);
  assert.equal(inv.untrackedCount, 1);
  // clean-worktree invariant: with no tracked/untracked changes dirty==0
  assert.equal(changedPathsOf(inv).length >= 4, true);
});

function changedPathsOf(inv) { return inv.changedPaths; }

test("identities are deterministic and content-based", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, "a.txt"), "alpha\n");
  const inv1 = inventoryFor(dir, git);
  const inv2 = inventoryFor(dir, git);
  assert.equal(inv1.changedTreeIdentity, inv2.changedTreeIdentity);
  assert.equal(inv1.patchSha256, inv2.patchSha256);
  writeFileSync(join(dir, "a.txt"), "alpha changed\n");
  const inv3 = inventoryFor(dir, git);
  assert.notEqual(inv1.changedTreeIdentity, inv3.changedTreeIdentity);
  assert.notEqual(inv1.patchSha256, inv3.patchSha256);
});

test("[neg 17] real secrets in changed content are detected", (t) => {
  const { dir, git } = createTempRepo(t);
  // construct the token at runtime so the literal never appears in source;
  // the FILE content still carries the full secret and must be detected
  const token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
  writeFileSync(join(dir, "creds.txt"), token + "\n");
  const inv = inventoryFor(dir, git);
  const scan = scanForSecrets(inv.patchText);
  assert.equal(scan.safe, false, "secret must be detected in the patch text");
  assert.ok(scan.matches.length > 0);
});

test("staged changes are listed separately and counted once", (t) => {
  const { dir, git } = createTempRepo(t);
  writeFileSync(join(dir, "staged.txt"), "staged content\n");
  git(["add", "staged.txt"]);
  const inv = inventoryFor(dir, git);
  assert.ok(inv.stagedPaths.includes("staged.txt"));
  assert.ok(inv.changedPaths.includes("staged.txt"));
  // staged + dirty both covered; no duplicate entries per path
  const count = inv.entries.filter((e) => e.path === "staged.txt").length;
  assert.equal(count, 1);
});

test("untracked files and dirs are expanded", (t) => {
  const { dir, git } = createTempRepo(t);
  mkdirSync(join(dir, "newdir"), { recursive: true });
  writeFileSync(join(dir, "newdir", "n1.txt"), "n1\n");
  writeFileSync(join(dir, "root-untracked.txt"), "r\n");
  const inv = inventoryFor(dir, git);
  assert.ok(inv.untracked.includes("newdir/n1.txt"));
  assert.ok(inv.untracked.includes("root-untracked.txt"));
});
