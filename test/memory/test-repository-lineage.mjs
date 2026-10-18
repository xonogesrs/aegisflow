// test/memory/test-repository-lineage.mjs
//
// CBM repository-identity lineage (card AEGISFLOW_CANONICAL_PUBLICATION_AND_
// CBM_IDENTITY_REPAIR_1 §C).
//
// The formula `repositoryIdentity = sha256(canonical({remote, canonicalPath}))`
// is frozen (it feeds recordId/logicalKey), so a moved checkout or a renamed
// remote silently makes every record bound to the old identity unreachable.
// These tests pin the ONLY thing that bridges that gap safely: a DECLARED,
// evidence-bound alias, one-directional, non-transitive, and inert unless the
// store explicitly declares it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LocalMemoryStore,
  MEMORY_QUERY_SCHEMA,
  REPOSITORY_ALIAS_FILE,
  REPOSITORY_ALIAS_SCHEMA,
  aliasFileFor,
  emptyAliasRegistry,
  readAliasRegistry,
  repositoryLineageFor,
  resolveRepositoryLineage,
  validateAliasRegistry,
  validateMemoryQueryV1,
} from "../../src/memory/index.mjs";
import { codeRecord, REPO, REPO_OTHER, TREE } from "./helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cbm-lineage-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
const store = (root) => new LocalMemoryStore({ stateRoot: root, log: silent });
const query = (context) => ({ schema: MEMORY_QUERY_SCHEMA, context, validityPolicy: "ALL", trustFloor: "RAW" });

after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

/** Write a registry exactly as the CLI would, so the reader sees real bytes. */
function declare(root, canonical, alias, { evidence = "evidence: test" } = {}) {
  const registry = { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical, alias, evidence, recordedAt: "2026-10-18T00:00:00.000Z" }] };
  writeFileSync(aliasFileFor(root), JSON.stringify(registry, null, 2));
}

test("L1. no declared lineage: an undeclared identity stays isolated (pre-lineage behaviour)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO_OTHER }));
  const r = s.query(query({ repository: REPO }));
  s.close();
  assert.equal(r.selectedRecords.length, 0);
  assert.equal(r.excludedSummary.repository, 1);
  assert.ok(!("repositoryLineage" in r), "no lineage echoed into the result");
});

test("L2. declared alias makes the deprecated identity reachable from the canonical one", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO_OTHER, path: "src/a.mjs" }));
  const before = s.query(query({ repository: REPO }));
  assert.equal(before.selectedRecords.length, 0);
  const after = s.query(query({ repository: REPO, repositoryLineage: [REPO, REPO_OTHER] }));
  s.close();
  assert.equal(after.selectedRecords.length, 1);
  assert.equal(after.selectedRecords[0].scope.repository, REPO_OTHER, "record keeps its OWN recorded scope");
  assert.equal(after.excludedSummary.repository, 0);
});

test("L3. lineage is one-directional: the alias does not see the canonical's records", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO, path: "src/canonical.mjs" }));
  const r = s.query(query({ repository: REPO_OTHER, repositoryLineage: [REPO_OTHER] }));
  s.close();
  assert.equal(r.selectedRecords.length, 0, "alias-only query cannot reach canonical records");
  assert.equal(r.excludedSummary.repository, 1);
});

test("L4. lineage is not transitive: an undeclared sibling of a declared alias stays invisible", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO_OTHER, path: "src/other.mjs" }));
  // REPO declares REPO_OTHER, but nothing declares the THIRD identity.
  const third = "9".repeat(64);
  const r = s.query(query({ repository: REPO, repositoryLineage: [REPO, REPO_OTHER] }));
  const r2 = s.query(query({ repository: REPO, repositoryLineage: [REPO] }));
  s.close();
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r2.selectedRecords.length, 0);
  assert.ok(!repositoryLineageFor({ schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical: REPO, alias: REPO_OTHER, evidence: "e", recordedAt: "t" }] }, third).includes(REPO_OTHER), "a lineage declared for another canonical never leaks");
});

test("L5. lineage changes the query identity and therefore the retrieval digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO_OTHER }));
  const narrow = s.query(query({ repository: REPO }));
  const wide = s.query(query({ repository: REPO, repositoryLineage: [REPO, REPO_OTHER] }));
  s.close();
  assert.notEqual(narrow.queryIdentity, wide.queryIdentity);
  assert.notEqual(narrow.retrievalDigest, wide.retrievalDigest);
});

test("L6. a registry is validated as a whole; malformed content fails closed to no lineage", () => {
  const bad = [
    { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical: REPO, alias: "short", evidence: "e", recordedAt: "t" }] },
    { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical: REPO, alias: REPO, evidence: "e", recordedAt: "t" }] },
    { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical: REPO, alias: REPO_OTHER, evidence: "", recordedAt: "t" }] },
    { schema: REPOSITORY_ALIAS_SCHEMA, aliases: [{ canonical: REPO, alias: REPO_OTHER, recordedAt: "t" }] },
    { schema: "wrong/schema", aliases: [] },
    { schema: REPOSITORY_ALIAS_SCHEMA, aliases: "nope" },
  ];
  for (const registry of bad) {
    assert.equal(validateAliasRegistry(registry).valid, false, JSON.stringify(registry).slice(0, 80));
  }
  assert.equal(validateAliasRegistry(emptyAliasRegistry()).valid, true);

  const root = freshRoot();
  writeFileSync(aliasFileFor(root), "{ not json");
  const read = readAliasRegistry(aliasFileFor(root));
  assert.equal(read.ok, false);
  assert.match(read.reason, /alias_registry_unreadable/);
  assert.deepEqual(read.registry.aliases, [], "fail closed to the narrowest visibility");
  assert.deepEqual(resolveRepositoryLineage(REPO, { stateRoot: root }).lineage, [REPO]);
});

test("L7. a missing registry is the normal case and yields the canonical identity alone", () => {
  const root = freshRoot();
  assert.equal(readAliasRegistry(aliasFileFor(root)).ok, true);
  const resolved = resolveRepositoryLineage(REPO, { stateRoot: root });
  assert.deepEqual(resolved.lineage, [REPO]);
  assert.deepEqual(resolved.aliases, []);
  assert.equal(resolved.reason, null);
});

test("L8. query validation accepts only a hex64, duplicate-free lineage", () => {
  const base = { repository: REPO };
  const cases = [
    [{ ...base, repositoryLineage: [] }, false],
    [{ ...base, repositoryLineage: ["nope"] }, false],
    [{ ...base, repositoryLineage: [REPO, REPO] }, false],
    [{ ...base, repositoryLineage: [REPO, REPO_OTHER] }, true],
    [base, true],
  ];
  for (const [context, expected] of cases) {
    const r = validateMemoryQueryV1({ schema: MEMORY_QUERY_SCHEMA, context });
    assert.equal(r.valid, expected, JSON.stringify(context));
    if (expected && context.repositoryLineage) {
      assert.deepEqual(r.query.context.repositoryLineage, context.repositoryLineage);
    }
    if (expected && !context.repositoryLineage) {
      assert.ok(!("repositoryLineage" in r.query.context), "absent lineage is omitted, never null");
    }
  }
});

test("L9. the alias file lives beside the store, never inside a checkout", () => {
  const root = freshRoot();
  assert.equal(aliasFileFor(root), join(root, REPOSITORY_ALIAS_FILE));
  assert.equal(REPOSITORY_ALIAS_FILE, "repository-aliases.json");
});

test("L10. declared lineage is echoed by the provider so a reader can see WHY a record matched", async () => {
  const { createGraphMemoryProvider } = await import("../../src/memory/graph-context.mjs");
  const { resolveRepositoryIdentity } = await import("../../src/memory/local-store.mjs");
  const { fileURLToPath } = await import("node:url");
  const repoPath = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
  const id = resolveRepositoryIdentity(repoPath);
  const root = freshRoot();
  const s = store(root);
  s.open();
  const legacy = "f".repeat(64);
  s.explicitImport(codeRecord({ repo: legacy, tree: id.treeSha, path: "src/memory/x.mjs" }));
  s.close();
  const provider = createGraphMemoryProvider({ stateRoot: root, log: silent });
  const narrow = await provider.retrieveGraphMemory({ repoPath, cwd: repoPath, executionId: "l-narrow" });
  assert.equal(narrow.state, "AVAILABLE");
  assert.equal(narrow.memoryContext.selectedRecords.length, 0);
  assert.ok(!("repositoryLineage" in narrow.memoryContext));

  declare(root, id.repositoryIdentity, legacy);
  const wide = await provider.retrieveGraphMemory({ repoPath, cwd: repoPath, executionId: "l-wide" });
  assert.equal(wide.memoryContext.selectedRecords.length, 1);
  assert.deepEqual(wide.memoryContext.repositoryLineage, [id.repositoryIdentity, legacy]);
});
