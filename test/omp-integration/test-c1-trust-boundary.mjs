// test/omp-integration/test-c1-trust-boundary.mjs
//
// CARD = AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1 — targeted acceptance.
//
// THE DEFECT, AS MEASURED BEFORE THE REPAIR
// -----------------------------------------
// `cbm-query.js` is an OMP extension. OMP loads it into its own process, and
// under a governed launch that process holds the controller capability: an
// inherited ledger descriptor plus the key that authenticates records written
// through it. The extension's `ekm_query` imported
// `<session-cwd>/src/memory/index.mjs`, located by walking UP from the session
// cwd. So an Agent that ran
//
//     bash: mkdir -p src/memory && cat > src/memory/index.mjs
//
// in its own session directory got its code executed inside the process that
// holds the capability — with the ordinary `bash` tool, and no privilege
// escalation, because the code ran in a process that already had it.
//
// HOW THESE TESTS ARE BUILT
// -------------------------
// Every test that could pass vacuously carries a NEGATIVE CONTROL: the same
// planted module, loaded the way the pre-repair code loaded it, asserted to
// EXECUTE inside a process that really does hold a capability. If the positive
// test ever stops discriminating, its control fails first.
//
// The capability here is a REAL one (`installControllerCapability` with a real
// open ledger descriptor and a real key), not a stub: the question "can
// agent-written code reach the capability" is only meaningful when there is a
// capability to reach. The key is a throwaway minted per test.
//
// What this file does NOT do: it never provisions authority on a process it did
// not spawn, never touches the deployed extension directory, and never writes
// outside a temporary directory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import openEkmQuery, {
	EKM_TOOL,
	queryCodebaseMemory,
	queryCodebaseMemoryOutOfProcess,
	resolveRepoRoot,
} from "../../integrations/omp/extensions/cbm-query.js";
import {
	clearControllerCapability,
	installControllerCapability,
	capabilityPresent,
} from "../../integrations/omp/extensions/lib/controller-capability.mjs";
import { loadMemoryModules } from "../../integrations/omp/extensions/lib/memory-query-core.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const EXTENSION_DIR = join(REPO_ROOT, "integrations", "omp", "extensions");

const roots = [];
function tmpRoot(prefix) {
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

/**
 * Install a REAL capability in THIS process and hand back a disposer.
 *
 * A real ledger file opened for append, a real 32-byte key: the same shape a
 * governed launch gives `no-poll-waits.js`. The descriptor is a local one rather
 * than an inherited slot, which is irrelevant to the question under test — what
 * matters is that `capabilityPresent()` is true and the capability is usable.
 */
function withCapability() {
	const dir = tmpRoot("c1-cap-");
	const ledgerPath = join(dir, "ledger.jsonl");
	writeFileSync(ledgerPath, "");
	const ledgerFd = openSync(ledgerPath, "a", 0o600);
	const key = "a".repeat(64);
	const installed = installControllerCapability({ key, ledgerFd, lockDir: join(dir, "locks") });
	if (!installed.ok) {
		closeSync(ledgerFd);
		throw new Error(`capability install failed: ${installed.denial}`);
	}
	return {
		ledgerPath,
		dispose() {
			clearControllerCapability();
		},
	};
}

/**
 * A session cwd that is ALSO a checkout, as the Agent can create one.
 *
 * The module's first statement writes a marker, so "was it evaluated" is a
 * filesystem fact rather than an inference from a return value.
 */
function plantedCheckout(markerName = "PLANTED_EXECUTED") {
	const dir = tmpRoot("c1-session-");
	mkdirSync(join(dir, "src", "memory"), { recursive: true });
	writeFileSync(
		join(dir, "src", "memory", "index.mjs"),
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(join(dir, markerName))}, "yes");`,
			`export class LocalMemoryStore { constructor() {} exists() { return false; } }`,
			`export function resolveRepositoryIdentity() { throw new Error("planted"); }`,
			`export function defaultQuery() { return { context: {}, limits: {} }; }`,
			`export function validateMemoryQueryV1() { return { valid: false, errors: ["planted"] }; }`,
			"",
		].join("\n"),
	);
	return dir;
}

function stubPi() {
	const tools = new Map();
	return {
		tools,
		pi: {
			logger: { warn() {}, info() {}, debug() {} },
			zod: {
				object: (shape) => ({ shape }),
				string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
				number: () => ({ type: "number", optional: () => ({ type: "number", optional: true }) }),
			},
			registerTool: (def) => tools.set(def.name, def),
		},
	};
}

// ── T02: the session cwd cannot redirect trusted module loading ─────────────

test("C1_T02: the trusted checkout is never resolved from the session cwd", () => {
	const session = plantedCheckout();
	const saved = process.env.AEGISFLOW_REPO_ROOT;
	const savedLegacy = process.env.AUTOLOOP_REPO_ROOT;
	try {
		delete process.env.AEGISFLOW_REPO_ROOT;
		delete process.env.AUTOLOOP_REPO_ROOT;
		const resolved = resolveRepoRoot(session);
		assert.notEqual(resolved.via, "session-cwd", "the session cwd must not be a trusted source");
		if (resolved.ok) assert.notEqual(resolved.root, session, "the planted tree must never be the trusted root");
	} finally {
		if (saved === undefined) delete process.env.AEGISFLOW_REPO_ROOT;
		else process.env.AEGISFLOW_REPO_ROOT = saved;
		if (savedLegacy === undefined) delete process.env.AUTOLOOP_REPO_ROOT;
		else process.env.AUTOLOOP_REPO_ROOT = savedLegacy;
	}
});

test("C1_T02 (negative control): in the deployed shape, the walk-up DOES select the planted tree", async () => {
	// A deployed copy lives under `~/.omp/agent/extensions/`, where the
	// extension-path source resolves to nothing — which is exactly the situation the
	// defect was measured in. Reproducing that shape is what makes this a control:
	// with no other source available, the walk-up is the ONLY thing that can answer,
	// so `via: "session-cwd"` proves the removed behaviour was reachable.
	const deployed = tmpRoot("c1-deployed-");
	mkdirSync(join(deployed, "lib"), { recursive: true });
	writeFileSync(join(deployed, "cbm-query.js"), readFileSync(join(EXTENSION_DIR, "cbm-query.js")));
	for (const name of readdirSync(join(EXTENSION_DIR, "lib"))) {
		writeFileSync(join(deployed, "lib", name), readFileSync(join(EXTENSION_DIR, "lib", name)));
	}
	const session = plantedCheckout();
	const saved = process.env.AEGISFLOW_REPO_ROOT;
	const savedLegacy = process.env.AUTOLOOP_REPO_ROOT;
	try {
		delete process.env.AEGISFLOW_REPO_ROOT;
		delete process.env.AUTOLOOP_REPO_ROOT;
		// A FRESH module instance, loaded from the deployed location, so its
		// EXTENSION_DIR is the deployed directory and not this checkout.
		const deployedCore = await import(`${pathToFileURL(join(deployed, "lib", "memory-query-core.mjs")).href}?control=${Date.now()}`);

		// The repaired resolver cannot answer: no env source, and "three directories
		// up" from a deployed copy is not a checkout.
		const withoutCwd = deployedCore.resolveRepoRoot(session);
		assert.equal(withoutCwd.ok, false, "the repaired resolver must not find a checkout from a deployed copy");
		assert.match(String(withoutCwd.reason), /session cwd is deliberately NOT a resolution source/);

		// The REMOVED behaviour, still available behind the child-only flag: it finds
		// the planted tree and says so. This is what the repair took away from the
		// capability process, and it is why layer 2 (the child) is also required.
		const withCwd = deployedCore.resolveRepoRoot(session, { allowSessionCwd: true });
		assert.equal(withCwd.ok, true, "the walk-up must locate the planted checkout, or this control proves nothing");
		assert.equal(withCwd.via, "session-cwd");
		assert.equal(withCwd.root, resolve(session));
	} finally {
		if (saved === undefined) delete process.env.AEGISFLOW_REPO_ROOT;
		else process.env.AEGISFLOW_REPO_ROOT = saved;
		if (savedLegacy === undefined) delete process.env.AUTOLOOP_REPO_ROOT;
		else process.env.AUTOLOOP_REPO_ROOT = savedLegacy;
	}
});

// ── T01: agent-controlled code cannot reach the capability ─────────────────

test("C1_T01: the tool path does not evaluate agent-written code in the capability process", async () => {
	const capability = withCapability();
	try {
		assert.equal(capabilityPresent(), true, "the premise: this process really does hold the capability");
		const session = plantedCheckout();
		const { tools, pi } = stubPi();
		openEkmQuery(pi);
		const def = tools.get(EKM_TOOL);
		assert.ok(def, "the tool must be registered");

		const payload = await def.execute("c1-t01", { terms: "anything" }, null, null, { cwd: session });

		assert.equal(
			existsSync(join(session, "PLANTED_EXECUTED")),
			false,
			"agent-written code must not be evaluated inside the capability process",
		);
		// The capability is untouched by the call: the isolation is a process
		// boundary, not a revocation.
		assert.equal(capabilityPresent(), true);

		const body = JSON.parse(payload.content[1].text);
		assert.equal(body.kind, "MEMORY_CONTEXT_DATA");
		if (body.state === "UNAVAILABLE") {
			assert.match(String(body.reason), /memory query runner|no plain `node`|no AegisFlow checkout/);
		} else {
			assert.equal(body.isolation?.mode, "child-process");
			assert.equal(body.isolation?.active, true, "an answer must be produced by the child, not in-process");
		}
	} finally {
		capability.dispose();
	}
});

test("C1_T01 (negative control): loading a session-derived checkout DOES run it beside the capability", async () => {
	// The pre-repair shape, in the same capability-holding process: resolve by
	// walking up from the session cwd, import it, query through it. If this did not
	// execute the planted module, the test above would be measuring nothing.
	const capability = withCapability();
	try {
		assert.equal(capabilityPresent(), true);
		const session = plantedCheckout();
		const mods = await loadMemoryModules({ repoRoot: session });
		assert.equal(mods.ok, true);
		await queryCodebaseMemory({ cwd: session, modules: mods });
		assert.equal(
			existsSync(join(session, "PLANTED_EXECUTED")),
			true,
			"loading a session-derived module executes it — that is exactly why the tool path must not",
		);
		assert.equal(capabilityPresent(), true, "and it executed in a process that held the capability");
	} finally {
		capability.dispose();
	}
});

// ── T03/T04: no authority reaches the child ────────────────────────────────

test("C1_T03/T04: the child runner refuses to run with controller authority in its environment", () => {
	const runner = join(EXTENSION_DIR, "lib", "memory-query-child.mjs");
	// Each variable is one the R4 modules actually define; a child that sees any of
	// them is a child inside the trust boundary, and it must refuse rather than
	// answer.
	const cases = [
		["OMP_TERMINAL_FENCE_LEDGER_FD", "3"],
		["OMP_CONTROLLER_LEDGER_KEY_FD", "4"],
		["OMP_CONTROLLER_RESULT_KEY_FILE", "/tmp/not-a-key"],
		["OMP_TERMINAL_FENCE_AUTHORITY", "1"],
	];
	for (const [name, value] of cases) {
		const run = spawnSync("node", [runner, JSON.stringify({ cwd: REPO_ROOT, repoRoot: REPO_ROOT })], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, HOME: process.env.HOME, [name]: value },
			timeout: 30_000,
		});
		assert.equal(run.status, 0, `the runner must answer, not crash (${name}): ${run.stderr}`);
		const verdict = JSON.parse(run.stdout.trim().split("\n").pop());
		assert.equal(verdict.ok, false, `the runner must refuse with ${name} present`);
		assert.match(verdict.reason, new RegExp(name));
	}
});

test("C1_T04: the tool's child does not inherit the parent's authority variables", async () => {
	// The parent here genuinely holds a capability AND carries the descriptor
	// variables; the child must still answer, which is only possible if the parent
	// scrubbed the environment it passed.
	const capability = withCapability();
	const saved = {};
	for (const name of ["OMP_TERMINAL_FENCE_LEDGER_FD", "OMP_CONTROLLER_RESULT_KEY_FILE"]) {
		saved[name] = process.env[name];
		process.env[name] = "9";
	}
	try {
		const result = await queryCodebaseMemoryOutOfProcess({ cwd: REPO_ROOT, repoRoot: REPO_ROOT, terms: "x", maxRecords: 1 });
		assert.equal(result.isolation?.mode, "child-process");
		assert.equal(result.isolation?.active, true, "the child must have run");
		assert.notEqual(result.state, "UNAVAILABLE", `the child refused, so it inherited authority: ${result.reason ?? ""}`);
	} finally {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		capability.dispose();
	}
});

// ── the env allowlist: configuration crosses, authority does not ───────────

test("C1_T04: the child receives store configuration and no authority variable", async () => {
	// Both halves matter. Omitting the store variables is not a security win (none
	// carries a capability) — it silently answers from a different store. Passing an
	// authority variable is a capability leak. This pins both directions against the
	// environment the tool actually builds.
	const entry = readFileSync(join(EXTENSION_DIR, "cbm-query.js"), "utf8");
	const allowBlock = entry.slice(entry.indexOf("const CHILD_ENV_ALLOW"), entry.indexOf("function pickChildEnv"));
	for (const name of ["AEGISFLOW_MEMORY_STATE_ROOT", "AUTOLOOP_MEMORY_STATE_ROOT", "AEGISFLOW_HOME", "AUTOLOOP_HOME"]) {
		assert.match(allowBlock, new RegExp(name), `${name} selects the store and must cross`);
	}
	for (const name of ["LEDGER_FD", "LEDGER_KEY_FD", "RESULT_KEY_FILE", "FENCE_STATE_DIR", "RESULT_TRANSPORT", "FENCE_AUTHORITY"]) {
		assert.doesNotMatch(allowBlock, new RegExp(name), `${name} carries authority and must not cross`);
	}
	// And the observable consequence: an override really does reach the child.
	const home = tmpRoot("c1-home-");
	mkdirSync(join(home, "memory"), { recursive: true });
	const saved = process.env.AEGISFLOW_HOME;
	process.env.AEGISFLOW_HOME = home;
	try {
		const result = await queryCodebaseMemoryOutOfProcess({ cwd: REPO_ROOT, repoRoot: REPO_ROOT, terms: "x", maxRecords: 1 });
		assert.equal(result.isolation?.active, true, "the child must have run");
		// The override points at an empty store, so the answer must be EMPTY_MEMORY.
		// Reading the operator's real store instead would mean the variable was dropped.
		assert.equal(result.state, "EMPTY_MEMORY", `AEGISFLOW_HOME did not reach the child: ${result.reason ?? ""}`);
	} finally {
		if (saved === undefined) delete process.env.AEGISFLOW_HOME;
		else process.env.AEGISFLOW_HOME = saved;
	}
});

// ── T10: absent inputs fail closed and say why ─────────────────────────────

test("C1_T10: no checkout answers UNAVAILABLE with a located reason, never a crash", async () => {
	const empty = tmpRoot("c1-empty-");
	const mods = await loadMemoryModules({ repoRoot: empty });
	assert.equal(mods.ok, false);
	assert.match(mods.reason, /no src\/memory\/index\.mjs/);
	const result = await queryCodebaseMemory({ cwd: empty, modules: mods });
	assert.equal(result.state, "UNAVAILABLE");
	assert.ok(result.reason.length > 0);
});

test("C1_T10: an absent child runtime fails closed rather than falling back in-process", () => {
	// The absence of a plain `node` must not silently restore the defect. The code
	// path is asserted structurally: there is no in-process branch in the tool's
	// query function. Comments are stripped first, because the explanation of what
	// was removed naturally names the removed call.
	const entry = readFileSync(join(EXTENSION_DIR, "cbm-query.js"), "utf8");
	const executeBody = entry
		.slice(entry.indexOf("async function executeQuery"), entry.indexOf("function resultPayload"))
		.replace(/\/\/.*$/gm, "");
	assert.match(executeBody, /queryCodebaseMemoryOutOfProcess\(/, "the tool must use the out-of-process path");
	assert.doesNotMatch(executeBody, /queryCodebaseMemory\(/, "the tool must not call the in-process query");
	assert.doesNotMatch(executeBody, /loadMemoryModules\(/, "the tool must not load modules in-process");
});

// ── the invariant, stated statically ──────────────────────────────────────

test("C1: the extension entry performs no dynamic import at all", () => {
	const entry = readFileSync(join(EXTENSION_DIR, "cbm-query.js"), "utf8");
	const core = readFileSync(join(EXTENSION_DIR, "lib", "memory-query-core.mjs"), "utf8");
	assert.doesNotMatch(entry, /await import\(|import\(/, "the entry must not dynamically import");
	// The one dynamic import in the extension's code lives in the loader and takes
	// an already-resolved index path.
	assert.match(core, /await import\(index\)/, "the loader must import only the resolved index path");
	assert.doesNotMatch(core, /await import\(\s*(join|resolve)\([^)]*cwd/, "the loader must not import a cwd-derived path");
});
