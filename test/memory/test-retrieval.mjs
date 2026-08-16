// test/memory/test-retrieval.mjs
//
// CBM-3 §9-§16, §18-§20, §28 — Deterministic Retrieval Engine:
// eligibility, scope, trust, validity, ranking tuple, conflicts,
// relationships, limits/truncation, retrieval digest.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalMemoryStore,
  MEMORY_QUERY_SCHEMA,
  MEMORY_RETRIEVAL_RESULT_SCHEMA,
  insertRelationship,
  validateMemoryQueryV1,
  deriveLogicalKey,
} from "../../src/memory/index.mjs";
import {
  codeRecord,
  executionRecord,
  decisionRecord,
  conflictPair,
  relationship,
  REPO,
  REPO_OTHER,
  WT,
  WT_OTHER,
  TREE,
  TREE_OTHER,
} from "./helpers-cbm3.mjs";

const ROOTS = [];
function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "cbm3-retrieval-"));
  ROOTS.push(root);
  return root;
}
const silent = { info() {}, warn() {}, error() {} };
function store(root) {
  return new LocalMemoryStore({ stateRoot: root, log: silent });
}
const q = (over = {}) => validateMemoryQueryV1({ schema: MEMORY_QUERY_SCHEMA, context: { repository: REPO, tree: TREE }, ...over }).query;

before(() => {});
after(() => { for (const r of ROOTS) rmSync(r, { recursive: true, force: true }); });

test("R1. retrieval result contract shape", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ trust: "VERIFIED" }));
  const r = s.query(q());
  assert.equal(r.schema, MEMORY_RETRIEVAL_RESULT_SCHEMA);
  for (const k of ["queryIdentity", "storeSnapshotDigest", "retrievalDigest", "selectedRecords", "conflictGroups", "excludedSummary", "counts", "byteCount", "truncated", "limits"]) {
    assert.ok(k in r, `${k} present`);
  }
  assert.match(r.queryIdentity, /^[0-9a-f]{64}$/);
  assert.match(r.storeSnapshotDigest, /^[0-9a-f]{64}$/);
  assert.match(r.retrievalDigest, /^[0-9a-f]{64}$/);
  s.close();
});

test("R2. trust matrix: RAW/UNVERIFIED excluded at production default; VERIFIED/REVIEWED/CONFIRMED included", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  // distinct paths ⇒ distinct logicalKeys（same path + different content would
  // be a CONFLICT — correct CBM-2 model; promotion updates, it never creates
  // duplicate same-subject records）.
  s.explicitImport(codeRecord({ path: "src/trust-raw.mjs", trust: "RAW", statement: "raw claim", text: "raw content" }));
  s.explicitImport(codeRecord({ path: "src/trust-unv.mjs", trust: "UNVERIFIED", statement: "unverified claim", text: "unverified content" }));
  s.explicitImport(codeRecord({ path: "src/trust-ver.mjs", trust: "VERIFIED", statement: "verified claim", text: "verified content" }));
  s.explicitImport(codeRecord({ path: "src/trust-rev.mjs", trust: "REVIEWED", statement: "reviewed claim", text: "reviewed content" }));
  s.explicitImport(codeRecord({ path: "src/trust-con.mjs", trust: "CONFIRMED", statement: "confirmed claim", text: "confirmed content" }));
  const r = s.query(q({ trustFloor: "VERIFIED" }));
  assert.equal(r.selectedRecords.length, 3, "VERIFIED+REVIEWED+CONFIRMED selected");
  assert.equal(r.excludedSummary.trust, 2, "RAW+UNVERIFIED excluded by trust floor");
  const names = new Set(r.selectedRecords.map((x) => x.trust));
  assert.deepEqual([...names].sort(), ["CONFIRMED", "REVIEWED", "VERIFIED"]);
  s.close();
});

test("R3. validity matrix: CURRENT included; STALE/INVALIDATED/TOMBSTONED excluded; CONFLICTED surfaced", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const path = "src/validity.mjs";
  s.explicitImport(codeRecord({ path, validity: "CURRENT" }));
  s.explicitImport(codeRecord({ path: "src/stale.mjs", validity: "STALE" }));
  s.explicitImport(codeRecord({ path: "src/inv.mjs", validity: "INVALIDATED" }));
  s.explicitImport(codeRecord({ path: "src/tomb.mjs", validity: "TOMBSTONED" }));
  s.explicitImport(codeRecord({ path: "src/conf.mjs", validity: "CONFLICTED" }));
  const r = s.query(q());
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.excludedSummary.validity, 3, "STALE+INVALIDATED+TOMBSTONED excluded by validity");
  assert.equal(r.excludedSummary.conflict, 1, "CONFLICTED surfaced not silently dropped");
  assert.ok(r.conflictGroups.some((g) => g.reason.includes("CONFLICTED")), "CONFLICTED surfaced in conflictGroups");
  s.close();
});

test("R4. INCLUDE_STALE policy selects CURRENT+STALE and flags stale validity", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs", validity: "CURRENT" }));
  s.explicitImport(codeRecord({ path: "b.mjs", validity: "STALE" }));
  const r = s.query(q({ validityPolicy: "INCLUDE_STALE" }));
  assert.equal(r.selectedRecords.length, 2);
  const statuses = new Set(r.selectedRecords.map((x) => x.validity.status));
  assert.deepEqual([...statuses].sort(), ["CURRENT", "STALE"]);
  s.close();
});

test("R5. repository isolation: other-repo records never match", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ repo: REPO }));
  s.explicitImport(codeRecord({ repo: REPO_OTHER }));
  const r = s.query(q());
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].scope.repository, REPO);
  assert.equal(r.excludedSummary.repository, 1);
  s.close();
});

test("R6. worktree isolation: bound record requires query worktree match; unbound record is worktree-neutral", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ worktree: WT, path: "src/wt-a.mjs" }));
  s.explicitImport(codeRecord({ worktree: WT_OTHER, path: "src/wt-b.mjs" }));
  s.explicitImport(codeRecord({ path: "src/neutral.mjs" }));
  // no worktree in query → worktree-bound records are incompatible (fail closed)
  const r0 = s.query(q());
  assert.equal(r0.selectedRecords.length, 1);
  assert.equal(r0.selectedRecords[0].scope.path, "src/neutral.mjs");
  assert.equal(r0.excludedSummary.worktree, 2);
  // matching worktree → only that one + neutral
  const r1 = s.query(q({ context: { repository: REPO, tree: TREE, worktree: WT } }));
  assert.equal(r1.selectedRecords.length, 2);
  // other worktree → the other one + neutral
  const r2 = s.query(q({ context: { repository: REPO, tree: TREE, worktree: WT_OTHER } }));
  assert.equal(r2.selectedRecords.length, 2);
  assert.ok(r2.selectedRecords.some((x) => x.scope.path === "src/wt-b.mjs"));
  s.close();
});

test("R7. same path / same content / same symbol never bypass worktree isolation", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  // identical path + identical content, different worktrees
  const a = codeRecord({ worktree: WT, path: "src/dup.mjs" });
  const b = codeRecord({ worktree: WT_OTHER, path: "src/dup.mjs" });
  assert.equal(a.subject.contentHash, b.subject.contentHash, "content identical");
  assert.equal(a.identity.path, b.identity.path, "path identical");
  s.explicitImport(a);
  s.explicitImport(b);
  const r = s.query(q({ context: { repository: REPO, tree: TREE, worktree: WT } }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].scope.worktree, WT);
  s.close();
});

test("R8. ranking tuple: trust rank and path-specificity order deterministically", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const low = codeRecord({ path: "src/rank-low.mjs", trust: "VERIFIED", statement: "low trust version" });
  const high = codeRecord({ path: "src/rank-high.mjs", trust: "CONFIRMED", statement: "high trust version" });
  const other = codeRecord({ path: "src/elsewhere.mjs", trust: "CONFIRMED", statement: "elsewhere" });
  s.explicitImport(low);
  s.explicitImport(high);
  s.explicitImport(other);
  // no path: trust rank orders CONFIRMED before VERIFIED; recordId breaks ties
  const r = s.query(q());
  const ids = r.selectedRecords.map((x) => x.recordId);
  assert.equal(ids.length, 3);
  assert.ok(ids.indexOf(high.recordId) < ids.indexOf(low.recordId), "CONFIRMED beats VERIFIED");
  // path-pinned: the path match outranks trust（specificity 3 > 0）
  const rp = s.query(q({ path: "src/rank-low.mjs" }));
  const idsP = rp.selectedRecords.map((x) => x.recordId);
  assert.equal(idsP[0], low.recordId, "path-pinned record wins even at lower trust");
  s.close();
});

test("R9. identity selectors: exclusive point lookup; trust floor bypassed for the selected record only; isolation never bypassed", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = codeRecord({ trust: "RAW", path: "src/sel.mjs" }); // below trust floor
  const foreign = codeRecord({ repo: REPO_OTHER });
  s.explicitImport(rec);
  s.explicitImport(foreign);
  // explicit recordId selector retrieves the RAW record（deliberate lookup）
  const r = s.query(q({ identitySelectors: { recordIds: [rec.recordId] } }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].recordId, rec.recordId);
  // foreign-repo selector cannot bypass the repo boundary → empty
  const r2 = s.query(q({ identitySelectors: { recordIds: [foreign.recordId] } }));
  assert.equal(r2.selectedRecords.length, 0, "foreign-repo selector cannot retrieve foreign memory");
  assert.equal(r2.excludedSummary.repository, 1);
  s.close();
});

test("R10. logicalKey selector selects the exact logical subject", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const a = codeRecord({ path: "src/lk.mjs", statement: "subject X" });
  const b = codeRecord({ path: "src/lk-other.mjs", statement: "subject Y" });
  s.explicitImport(a);
  s.explicitImport(b);
  const lk = deriveLogicalKey(a);
  const r = s.query(q({ logicalKey: lk }));
  assert.equal(r.selectedRecords.length, 2, "exact logicalKey ranks first; other eligible records remain");
  assert.equal(r.selectedRecords[0].recordId, a.recordId, "exact logicalKey match ranks first");
  s.close();
});

test("R11. FTS candidate generation narrows; FTS score never enters digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "src/lexical.mjs", statement: "deterministic retrieval engine binding" }));
  s.explicitImport(codeRecord({ path: "src/unrelated.mjs", statement: "unrelated thing" }));
  const r = s.query(q({ terms: "deterministic binding" }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].scope.path, "src/lexical.mjs");
  // terms affect queryIdentity (and thus retrievalDigest) deterministically
  const r2 = s.query(q());
  assert.notEqual(r.retrievalDigest, r2.retrievalDigest);
  s.close();
});

test("R12. repeat-query determinism: identical result + digest", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.explicitImport(codeRecord({ path: "b.mjs" }));
  s.explicitImport(executionRecord());
  const query = q();
  const r1 = s.query(query);
  const r2 = s.query(query);
  assert.equal(r1.retrievalDigest, r2.retrievalDigest);
  assert.deepEqual(r1.selectedRecords.map((x) => x.recordId), r2.selectedRecords.map((x) => x.recordId));
  assert.deepEqual(r1.conflictGroups, r2.conflictGroups);
  assert.deepEqual(r1.excludedSummary, r2.excludedSummary);
  s.close();
});

test("R13. CURRENT logical-key conflict surfaced, never one picked", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const [a, b] = conflictPair();
  s.explicitImport(a);
  s.explicitImport(b);
  const r = s.query(q({ path: "src/conflict.mjs" }));
  assert.equal(r.selectedRecords.length, 0, "neither conflicting version is silently selected");
  assert.equal(r.conflictGroups.length, 1);
  const g = r.conflictGroups[0];
  assert.deepEqual(g.records.sort(), [a.recordId, b.recordId].sort());
  assert.ok(g.reason.includes("conflicting content versions"));
  s.close();
});

test("R14. conflict records count in excludedSummary.conflict, not validity", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const [a, b] = conflictPair();
  s.explicitImport(a);
  s.explicitImport(b);
  const r = s.query(q());
  assert.equal(r.excludedSummary.conflict, 2);
  assert.equal(r.excludedSummary.validity, 0);
  assert.equal(r.counts.conflictRecords, 2);
  s.close();
});

test("R15. CONFLICTS_WITH relationship records surfaced as conflicts", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const x = codeRecord({ path: "src/rel-x.mjs", statement: "X says red" });
  const y = codeRecord({ path: "src/rel-y.mjs", statement: "Y says blue" });
  s.explicitImport(x);
  s.explicitImport(y);
  insertRelationship(s.db, relationship({ id: "rel_1", recordId: x.recordId, targetRecordId: y.recordId, type: "CONFLICTS_WITH" }));
  const r = s.query(q());
  // CONFLICTS_WITH relationship alone does not change validity → both still
  // eligible; the relationship must be preserved as applicable provenance.
  assert.equal(r.selectedRecords.length, 2);
  const xOut = r.selectedRecords.find((z) => z.recordId === x.recordId);
  assert.ok(xOut.applicableRelationships.some((rel) => rel.relationshipType === "CONFLICTS_WITH"));
  s.close();
});

test("R16. relationship provenance preserved on selected records (SUPERSEDES/INVALIDATES/APPLIES_TO/VERIFIES/REVIEWS)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const old = codeRecord({ path: "src/old.mjs" });
  const next = codeRecord({ path: "src/next.mjs", statement: "newer binding" });
  const verifier = codeRecord({ path: "src/verify.mjs", statement: "verifier result" });
  s.explicitImport(old);
  s.explicitImport(next);
  s.explicitImport(verifier);
  insertRelationship(s.db, relationship({ id: "r1", recordId: next.recordId, targetRecordId: old.recordId, type: "SUPERSEDES" }));
  insertRelationship(s.db, relationship({ id: "r2", recordId: verifier.recordId, targetRecordId: next.recordId, type: "VERIFIES" }));
  insertRelationship(s.db, relationship({ id: "r3", recordId: next.recordId, targetRecordId: "src/scope.mjs", type: "APPLIES_TO" }));
  const r = s.query(q());
  const nextOut = r.selectedRecords.find((x) => x.recordId === next.recordId);
  assert.ok(nextOut.applicableRelationships.some((rel) => rel.relationshipType === "SUPERSEDES" && rel.targetRecordId === old.recordId));
  assert.ok(nextOut.applicableRelationships.some((rel) => rel.relationshipType === "VERIFIES"));
  assert.ok(nextOut.applicableRelationships.some((rel) => rel.relationshipType === "APPLIES_TO"));
  s.close();
});

test("R17. relationshipApplicability ranks related records above unrelated at equal trust", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const anchor = codeRecord({ path: "src/anchor.mjs", statement: "the anchor subject" });
  const related = codeRecord({ path: "src/related.mjs", statement: "related evidence" });
  const unrelated = codeRecord({ path: "src/unrelated.mjs", statement: "unrelated evidence" });
  s.explicitImport(anchor);
  s.explicitImport(related);
  s.explicitImport(unrelated);
  insertRelationship(s.db, relationship({ id: "r1", recordId: anchor.recordId, targetRecordId: related.recordId, type: "APPLIES_TO" }));
  const r = s.query(q({ identitySelectors: { recordIds: [anchor.recordId] } }));
  // related beats unrelated on the relationshipApplicability element
  const ids = r.selectedRecords.map((x) => x.recordId);
  assert.ok(ids.indexOf(related.recordId) < ids.indexOf(unrelated.recordId), "related record ranks before unrelated");
  s.close();
});

test("R18. limits: maxRecords and maxBytes truncate deterministically in stable order", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  for (let i = 0; i < 10; i++) {
    s.explicitImport(codeRecord({ path: `src/file-${String(i).padStart(2, "0")}.mjs`, statement: `statement number ${i}` }));
  }
  const r = s.query(q({ limits: { maxRecords: 3, maxBytes: 256 * 1024 } }));
  assert.equal(r.selectedRecords.length, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.limits.maxRecords, 3);
  // byte-budget truncation: tiny budget → fewer records, deterministic order
  const r2 = s.query(q({ limits: { maxRecords: 100, maxBytes: 200 } }));
  assert.ok(r2.selectedRecords.length < 10);
  assert.equal(r2.truncated, true);
  // the selected subset is a prefix of the ranked order
  const full = s.query(q({ limits: { maxRecords: 100, maxBytes: 256 * 1024 } }));
  const fullIds = full.selectedRecords.map((x) => x.recordId);
  const r2Ids = r2.selectedRecords.map((x) => x.recordId);
  assert.deepEqual(fullIds.slice(0, r2Ids.length), r2Ids, "truncation is a stable prefix of ranking");
  s.close();
});

test("R19. global-scope decision records are cross-repo eligible unless scope.global=false", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(decisionRecord({ global: true }));
  s.explicitImport(codeRecord({ repo: REPO }));
  const r = s.query(q());
  assert.equal(r.selectedRecords.length, 2, "global decision + repo record both selected");
  const r2 = s.query(q({ scope: { global: false } }));
  assert.equal(r2.selectedRecords.length, 1, "scope.global=false excludes the global decision");
  s.close();
});

test("R20. graphRun/task scope filters bind execution memory to the run", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(executionRecord({ graphRun: "run-abc", task: "task-1" }));
  s.explicitImport(executionRecord({ graphRun: "run-other", task: "task-9" }));
  const r = s.query(q({ context: { repository: REPO, tree: TREE, graphRunId: "run-abc", task: "task-1" } }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].scope.graphRun, "run-abc");
  s.close();
});

test("R21. recordType filter narrows selection", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "a.mjs" }));
  s.explicitImport(decisionRecord({ global: true }));
  const r = s.query(q({ recordTypes: ["DECISION"] }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].recordType, "DECISION");
  s.close();
});

test("R22. selected record carries full context (source identity, evidence identity, scope)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const rec = codeRecord({ trust: "REVIEWED" });
  s.explicitImport(rec);
  const r = s.query(q());
  const out = r.selectedRecords[0];
  assert.equal(out.sourceIdentity, rec.source.identity);
  assert.equal(out.evidenceIdentity.manifestDigest, rec.evidence.manifestDigest);
  assert.equal(out.evidenceIdentity.reviewResultIdentity, rec.evidence.reviewResultIdentity);
  assert.equal(out.trust, "REVIEWED");
  assert.equal(out.content.text, rec.content.text);
  s.close();
});

test("R23. same-path ancestor scope applies to query path (directory record applies to files under it)", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  s.explicitImport(codeRecord({ path: "src/", statement: "module dir invariant" }));
  s.explicitImport(codeRecord({ path: "other/", statement: "other dir" }));
  const r = s.query(q({ path: "src/module.mjs" }));
  assert.equal(r.selectedRecords.length, 1);
  assert.equal(r.selectedRecords[0].scope.path, "src/");
  s.close();
});

test("R24. symbol-pinned query ranks symbol matches above tree-pinned", () => {
  const root = freshRoot();
  const s = store(root);
  s.open();
  const sym = codeRecord({ path: "src/sym.mjs", symbol: "parseMemoryRecord", statement: "symbol binding" });
  const tree = codeRecord({ path: "src/tree.mjs", statement: "tree binding" });
  s.explicitImport(sym);
  s.explicitImport(tree);
  const r = s.query(q({ symbol: "parseMemoryRecord" }));
  const ids = r.selectedRecords.map((x) => x.recordId);
  assert.equal(ids[0], sym.recordId);
  s.close();
});
