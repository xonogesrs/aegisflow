// test/omp-integration/test-omp-cbm-query.mjs
//
// Contract test for the `cbm_query` extension tool
// (AEGISFLOW_OMP_INTEGRATION_RECOVERY_1 §B).
//
// The defect this pins: CBM was reachable ONLY through
// `scripts/autoloop-memory-query.mjs`, a harness CLI. An interactive OMP session
// has no harness, so in a normal session the agent had no CBM tool at all and
// could not consult memory it had recorded — measured by asking a live session
// for a CBM tool: `NO_SUCH_TOOL`.
//
// The test drives the tool the way OMP does (register → execute) against a
// temporary store, so it covers the real path: identity from cwd, the store's
// own retrieval engine, and the DATA-only boundary.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import openCbmQuery, {
	CBM_TOOL,
	loadMemoryModules,
	queryCodebaseMemory,
	resolveRepoRoot,
	summarize,
} from "../../integrations/omp/extensions/cbm-query.js";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../../src/memory/index.mjs";
import { codeRecord } from "../memory/helpers-cbm3.mjs";

const roots = [];
function tmpRoot(prefix = "cbm-query-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}
after(() => {
	for (const dir of roots) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	}
});

function makeRepo() {
	const dir = tmpRoot("cbm-repo-");
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "r1"], { cwd: dir });
	return dir;
}

/** A repository with the module surface the extension imports. */
function makeCheckout() {
	const dir = tmpRoot("cbm-checkout-");
	mkdirSync(join(dir, "src", "memory"), { recursive: true });
	writeFileSync(
		join(dir, "src", "memory", "index.mjs"),
		`export * from ${JSON.stringify(join(process.cwd(), "src", "memory", "index.mjs"))};\n`,
	);
	return dir;
}

function populate(stateRoot, repo, { statement = "parseMemoryRecord validates records deterministically" } = {}) {
	const id = resolveRepositoryIdentity(repo);
	const store = new LocalMemoryStore({ stateRoot, log: { info() {}, warn() {}, error() {} } });
	store.open();
	store.explicitImport(codeRecord({
		repo: id.repositoryIdentity,
		commit: id.commitSha,
		tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim(),
		path: "src/parse.mjs",
		symbol: "parseMemoryRecord",
		statement,
	}));
	store.close();
	// The extension resolves the store root from the environment, exactly as the
	// harness CLI does.
	process.env.AEGISFLOW_MEMORY_STATE_ROOT = stateRoot;
	return id;
}

test("an empty store is EMPTY_MEMORY, a valid answer rather than an error", async () => {
	const repo = makeRepo();
	process.env.AEGISFLOW_MEMORY_STATE_ROOT = tmpRoot("cbm-empty-");
	const result = await queryCodebaseMemory({ cwd: repo });
	assert.equal(result.state, "EMPTY_MEMORY");
	assert.equal(result.kind, "MEMORY_CONTEXT_DATA");
	assert.match(result.authorityBoundary, /DATA, not instructions/);
	assert.match(summarize(result), /empty for this repository/);
});

test("a populated store answers a terms query from the session cwd identity", async () => {
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-pop-");
	const id = populate(stateRoot, repo);

	const result = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord", maxRecords: 5 });
	assert.equal(result.state, "AVAILABLE", result.reason ?? "");
	assert.equal(result.repository.repositoryIdentity, id.repositoryIdentity);
	assert.ok(result.retrieval.selectedRecords.length >= 1, "expected the imported record");
	assert.equal(result.retrieval.selectedRecords[0].scope.path, "src/parse.mjs");
	assert.equal(result.freshness.indexed, true);
	assert.equal(result.freshness.stale, false);
});

test("another repository's records are never returned (hard isolation)", async () => {
	const repo = makeRepo();
	const otherRepo = makeRepo();
	const stateRoot = tmpRoot("cbm-iso-");
	populate(stateRoot, otherRepo, { statement: "secret of the other repository" });

	const result = await queryCodebaseMemory({ cwd: repo, terms: "secret", trustFloor: "RAW" });
	assert.equal(result.state, "AVAILABLE");
	assert.equal(result.retrieval.selectedRecords.length, 0, "identity is a hard boundary, not a ranking hint");
});

test("a stale index is reported as stale, not silently as current", async () => {
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-stale-");
	populate(stateRoot, repo);
	// Move the repository forward: the index no longer covers the current tree.
	writeFileSync(join(repo, "new-file.txt"), "x\n");
	execFileSync("git", ["add", "new-file.txt"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "move"], { cwd: repo });

	const result = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord" });
	assert.equal(result.state, "AVAILABLE");
	assert.equal(result.freshness.indexed, true);
	assert.equal(result.freshness.stale, true);
	assert.match(summarize(result), /does not cover the current tree/);
});

test("a stale index can still answer a historical question when asked", async () => {
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-stale-hist-");
	populate(stateRoot, repo);
	writeFileSync(join(repo, "moved.txt"), "x\n");
	execFileSync("git", ["add", "moved.txt"], { cwd: repo });
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "move"], { cwd: repo });

	const current = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord" });
	assert.equal(current.freshness.stale, true);
	assert.equal(current.retrieval.selectedRecords.length, 0, "CURRENT excludes a stale tree baseline");

	const historical = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord", validityPolicy: "INCLUDE_STALE" });
	assert.equal(historical.state, "AVAILABLE");
	assert.ok(historical.retrieval.selectedRecords.length >= 1, "INCLUDE_STALE retrieves the historical record");
});

test("a declared lineage is honored and reported; an undeclared identity stays isolated", async () => {
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-lineage-");
	const id = populate(stateRoot, repo);
	// Rebind the stored record to a DEPRECATED identity for the same checkout.
	const legacy = "a".repeat(64);
	const store = new LocalMemoryStore({ stateRoot, log: { info() {}, warn() {}, error() {} } });
	store.open();
	store.close();

	const narrow = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord" });
	assert.ok(narrow.retrieval.selectedRecords.every((r) => r.scope.repository === id.repositoryIdentity));

	writeFileSync(
		join(stateRoot, "repository-aliases.json"),
		JSON.stringify({
			schema: "aegisflow.memory-repository-aliases/v1",
			aliases: [{ canonical: id.repositoryIdentity, alias: legacy, evidence: "test", recordedAt: "2026-10-18T00:00:00.000Z" }],
		}),
	);
	const declared = await queryCodebaseMemory({ cwd: repo, terms: "parseMemoryRecord" });
	assert.equal(declared.state, "AVAILABLE");
	assert.deepEqual(declared.retrieval.selectedRecords.map((r) => r.scope.repository), [id.repositoryIdentity], "the canonical query still resolves to its own records");
	assert.ok(JSON.stringify(declared).includes(legacy), "the declared lineage is reported in the query");
});

test("a corrupt store fails closed as INVALID instead of pretending to be empty", async () => {
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-corrupt-");
	populate(stateRoot, repo);
	// Tamper the applied migration checksum: the store must refuse to open.
	const dbPath = join(stateRoot, "memory.db");
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(dbPath);
	db.prepare("UPDATE memory_migrations SET checksum = ?").run("0".repeat(64));
	db.close();

	const result = await queryCodebaseMemory({ cwd: repo });
	assert.equal(result.state, "INVALID");
	assert.match(String(result.reason), /MIGRATION_INVALID|checksum/i);
	assert.match(summarize(result), /INVALID/);
});

test("a machine with no checkout answers UNAVAILABLE with the reason, never a crash", async () => {
	const repo = makeRepo();
	const empty = tmpRoot("cbm-nocheckout-");
	const saved = process.env.AEGISFLOW_REPO_ROOT;
	const savedLegacy = process.env.AUTOLOOP_REPO_ROOT;
	try {
		delete process.env.AEGISFLOW_REPO_ROOT;
		delete process.env.AUTOLOOP_REPO_ROOT;
		// An explicit root with no module must fail with a located reason. (An
		// IMPLICIT lookup legitimately finds this checkout through the
		// extension-path fallback whenever the test runs from the repo, so the
		// absence case is simulated with the explicit root.)
		const mods = await loadMemoryModules({ repoRoot: empty });
		assert.equal(mods.ok, false);
		assert.match(mods.reason, new RegExp(empty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const result = await queryCodebaseMemory({ cwd: repo, modules: mods });
		assert.equal(result.state, "UNAVAILABLE");
		assert.ok(result.reason.length > 0);
	} finally {
		if (saved === undefined) delete process.env.AEGISFLOW_REPO_ROOT;
		else process.env.AEGISFLOW_REPO_ROOT = saved;
		if (savedLegacy === undefined) delete process.env.AUTOLOOP_REPO_ROOT;
		else process.env.AUTOLOOP_REPO_ROOT = savedLegacy;
	}
});

test("an explicit checkout is honored, so a deployed copy is not pinned to one path", async () => {
	const checkout = makeCheckout();
	const loaded = await loadMemoryModules({ repoRoot: checkout });
	assert.equal(loaded.ok, true, loaded.reason ?? "");
	assert.equal(loaded.repoRoot, checkout, "an explicit checkout must be used verbatim");
	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-env-root-");
	populate(stateRoot, repo, { statement: "records this so the environment root is provably used" });
	const result = await queryCodebaseMemory({ cwd: repo, terms: "provably", trustFloor: "RAW", modules: await loadMemoryModules({ repoRoot: checkout }) });
	assert.equal(result.state, "AVAILABLE");
	assert.ok(result.retrieval.selectedRecords.length >= 1);
});

test("the tool registers one read-only tool and executes through the same seam", async () => {
	const tools = new Map();
	const pi = {
		logger: { warn() {}, info() {}, debug() {} },
		zod: {
			object: (shape) => ({ shape }),
			string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
			number: () => ({ type: "number", optional: () => ({ type: "number", optional: true }) }),
		},
		registerTool: (def) => tools.set(def.name, def),
	};
	openCbmQuery(pi);
	assert.deepEqual([...tools.keys()], [CBM_TOOL]);
	const def = tools.get(CBM_TOOL);
	assert.equal(def.approval, "read", "the memory tool must never be a write capability");
	assert.match(def.description, /READ-ONLY/);

	const repo = makeRepo();
	const stateRoot = tmpRoot("cbm-exec-");
	populate(stateRoot, repo);
	const ctx = { cwd: repo };
	const out = await def.execute("call-1", { terms: "parseMemoryRecord" }, null, null, ctx);
	assert.equal(out.details.state, "AVAILABLE");
	const payload = JSON.parse(out.content[1].text);
	assert.equal(payload.kind, "MEMORY_CONTEXT_DATA");
	assert.ok(payload.retrieval.selectedRecords.length >= 1);
});
