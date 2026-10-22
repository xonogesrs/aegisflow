#!/usr/bin/env node
// scripts/c1-trust-boundary-suite.mjs
//
// CARD = AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1 — targeted adversarial
// acceptance on a REAL governed runtime.
//
//   node scripts/c1-trust-boundary-suite.mjs [--json]
//
// WHY THIS EXISTS
// ---------------
// The unit tests in `test/omp-integration/test-c1-trust-boundary.mjs` install a
// capability into the test process. That is the right shape for a fast check, but
// it is not the shape of the defect: the defect lives in a GOVERNED LAUNCH, where
// the OMP process really does hold an inherited ledger descriptor and the key that
// authenticates records written through it.
//
// So this suite launches one. The launch is the production one
// (`launchGovernedRuntime`: attested binary, attested extension tree, sandbox,
// real descriptors), and the module under test is the real `cbm-query.js`
// deployed beside `no-poll-waits.js`.
//
// WHAT IS MEASURED
// ----------------
// A probe extension runs INSIDE that governed process and, in one command:
//
//   1. asserts the process really holds the capability (`capabilityPresent()`);
//   2. calls the real `ekm_query` tool with `ctx.cwd` pointing at a session
//      directory that is ALSO a checkout — the state an Agent's `bash` produces
//      by writing `src/memory/index.mjs` in its own cwd;
//   3. reports whether the planted module was evaluated (a marker file);
//   4. runs the NEGATIVE CONTROL: loads the same planted module the way the
//      pre-repair code loaded it, and reports whether THAT evaluated it.
//
// Step 4 is what makes step 3 evidence. If the control does not execute the
// planted module, the positive result would be vacuous and this suite fails.
//
// Exit: 0 all facts hold, 1 a fact failed, 2 the suite could not run.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	COMMIT_STATE,
	attestExtension,
	bindIdentity,
	commitFence,
	createControllerGrant,
	disposeControllerRoot,
	launchGovernedRuntime,
	prepareControllerRoot,
} from "../src/control-plane/controller-client.mjs";
import { LocalMemoryStore, resolveRepositoryIdentity } from "../src/memory/index.mjs";
import { codeRecord } from "../test/memory/helpers-cbm3.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION = join(REPO_ROOT, "integrations", "omp", "extensions", "no-poll-waits.js");
const CBM_EXTENSION = join(REPO_ROOT, "integrations", "omp", "extensions", "cbm-query.js");
const RPC_BIN = process.env.AEGIS_RPC_BIN || execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
const SCRATCH_ROOT = process.env.AEGIS_C1_SCRATCH || join(tmpdir(), "aegis-c1-boundary");

const facts = [];
function fact(name, ok, detail) {
	facts.push({ name, ok: Boolean(ok), detail: detail ?? null });
}

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A private HOME with an INERT provider: no case asks a model to generate. */
function prepareHome(childHome) {
	mkdirSync(join(childHome, ".omp", "agent"), { recursive: true });
	writeFileSync(
		join(childHome, ".omp", "agent", "models.yml"),
		[
			"providers:",
			"  c1-inert:",
			"    baseUrl: http://127.0.0.1:1/v1",
			"    api: openai-responses",
			"    apiKey: c1-inert-not-a-credential",
			"    models:",
			"    - id: c1-inert/inert",
			"      name: Inert",
			"      contextWindow: 1000",
			"      maxTokens: 16",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(childHome, ".omp", "agent", "config.yml"),
		["modelRoles:", "  default: c1-inert/inert", "symbolPreset: ascii", ""].join("\n"),
		"utf8",
	);
}

/**
 * Populate a memory store for `repo`, so the tool's answer is a MEASURED fact.
 *
 * Uses the repository's own store API — the same one the tool reads through — and
 * records one CODE record bound to this checkout's identity. A record bound to a
 * different identity would be excluded by the hard repository filter and the
 * assertion would fail for the wrong reason.
 */
function seedStore(stateRoot, repo) {
	try {
		const id = resolveRepositoryIdentity(repo);
		const store = new LocalMemoryStore({ stateRoot, log: { info() {}, warn() {}, error() {} } });
		store.open();
		store.explicitImport(
			codeRecord({
				repo: id.repositoryIdentity,
				commit: id.commitSha,
				tree: id.treeSha,
				path: "src/capability.mjs",
				symbol: "controllerCapability",
				statement: "the controller capability is an inherited descriptor, not a variable",
			}),
		);
		store.close();
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: String(error && error.message ? error.message : error) };
	}
}

/**
 * The probe extension.
 *
 * It is a deliberate, attested module of this launch — not an attack module. It
 * exists to run the SUT's tool from inside the TCB and report what happened. The
 * attack in this suite is the planted checkout, not the probe.
 */
const PROBE = `
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CBM_EXTENSION = __CBM_EXTENSION__;
const PLANTED_SOURCE = __PLANTED_SOURCE__;
const REPORT_PATH = __REPORT_PATH__;
const STATE_ROOT = __STATE_ROOT__;

export default function (pi) {
	const tools = new Map();
	const stub = {
		logger: { warn() {}, info() {}, debug() {} },
		zod: {
			object: (shape) => ({ shape }),
			string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
			number: () => ({ type: "number", optional: () => ({ type: "number", optional: true }) }),
		},
		registerTool: (def) => tools.set(def.name, def),
	};

	pi.registerCommand("c1-probe", {
		description: "probe: measure the C1 trust boundary from inside the governed process",
		handler: async () => {
			const cbm = await import(pathToFileURL(CBM_EXTENSION).href);
			cbm.default(stub);

			// The state an Agent's bash produces: a checkout in the session's own cwd.
			// OMP may change its working directory, so the directory is derived from the
			// report path (a location this harness created) rather than from cwd.
			const base = join(REPORT_PATH, "..");
			const sessionDir = join(base, "session");
			const memoryDir = join(sessionDir, "src", "memory");
			mkdirSync(memoryDir, { recursive: true });
			writeFileSync(join(memoryDir, "index.mjs"), PLANTED_SOURCE);

			// The planted module writes its marker BESIDE ITSELF, so "was it evaluated"
			// does not depend on which directory the runtime happens to be in.
			const marker = join(memoryDir, "PLANTED_EXECUTED");
			rmSync(marker, { force: true });

			const report = { toolRegistered: tools.has("ekm_query"), sessionDir, stateRoot: STATE_ROOT };

			// Point the tool at the store this harness populated. Set here rather than
			// inherited: the governed child's environment is built by the controller and
			// deliberately carries no memory configuration.
			process.env.AEGISFLOW_MEMORY_STATE_ROOT = STATE_ROOT;

			// (1) THE SUT: the real tool, through the real registration, with the
			// session cwd as the tool's cwd. Nothing is stubbed below this line.
			const payload = await tools.get("ekm_query").execute("c1-probe-call", { terms: "capability" }, null, null, { cwd: sessionDir });
			report.toolPayloadText = payload?.content?.[0]?.text ?? null;
			const body = JSON.parse(payload.content[1].text);
			report.toolState = body.state;
			report.toolIsolation = body.isolation ?? null;
			report.toolReason = body.reason ?? null;
			report.retrievedCount = body.retrieval?.selectedRecords?.length ?? 0;
			report.plantedEvaluatedByToolPath = existsSync(marker);

			// (2) THE NEGATIVE CONTROL: load the same planted module the way the
			// pre-repair code loaded it. If this does NOT execute it, the measurement
			// above proves nothing and the suite must fail.
			rmSync(marker, { force: true });
			try {
				const mod = await import(pathToFileURL(join(memoryDir, "index.mjs")).href + "?control=1");
				report.controlLoaded = typeof mod.LocalMemoryStore === "function";
			} catch (error) {
				report.controlLoaded = false;
				report.controlError = String(error && error.message ? error.message : error);
			}
			report.controlEvaluated = existsSync(marker);

			// A command handler's return value is NOT a controller result frame, so the
			// report goes to a file the harness polls. Using the frame protocol here
			// would need the result key, and a probe that could sign frames would be
			// measuring a different question than the one this suite asks.
			writeFileSync(REPORT_PATH, JSON.stringify(report));
			return { content: [{ type: "text", text: "c1-probe complete" }] };
		},
	});
}
`;

/** The planted module: writes a marker beside itself on evaluation. */
function plantedSource() {
	return [
		`import { writeFileSync } from "node:fs";`,
		`import { dirname, join } from "node:path";`,
		`import { fileURLToPath } from "node:url";`,
		`writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "PLANTED_EXECUTED"), "yes");`,
		`export class LocalMemoryStore { constructor() {} exists() { return false; } open() {} close() {} }`,
		`export function resolveRepositoryIdentity() { throw new Error("planted"); }`,
		`export function defaultQuery() { return { context: {}, limits: {} }; }`,
		`export function validateMemoryQueryV1() { return { valid: false, errors: ["planted"] }; }`,
		"",
	].join("\n");
}

async function caseToolBoundary() {
	const dir = join(SCRATCH_ROOT, "tool-boundary");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const sessionDir = join(dir, "session");
	mkdirSync(sessionDir, { recursive: true });

	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);

	// A store this harness POPULATES, so "the tool answered" can mean "it returned
	// the record that was seeded" rather than "it returned some string".
	const stateRoot = join(dir, "memory-state");
	// The session cwd must be a REAL repository: the tool resolves identity from it,
	// and a store record bound to a different identity is excluded by the hard
	// repository filter — which would make the assertion fail for the wrong reason.
	mkdirSync(sessionDir, { recursive: true });
	execFileSync("git", ["init", "-q"], { cwd: sessionDir });
	execFileSync("git", ["-c", "user.email=c1@test", "-c", "user.name=c1", "commit", "-q", "--allow-empty", "-m", "session"], {
		cwd: sessionDir,
	});
	const seeded = seedStore(stateRoot, sessionDir);
	if (!seeded.ok) throw new Error(`could not seed the store: ${seeded.reason}`);

	const probePath = join(dir, "c1-probe.mjs");
	// The probe's own text carries the planted source INLINE: the governed child's
	// environment is scrubbed by design, so it cannot be handed over as a variable.
	const planted = plantedSource();
	const reportPath = join(dir, "c1-report.json");
	const probeText = PROBE.replace("__CBM_EXTENSION__", JSON.stringify(CBM_EXTENSION))
		.replace("__PLANTED_SOURCE__", JSON.stringify(planted))
		.replace("__REPORT_PATH__", JSON.stringify(reportPath))
		.replace("__STATE_ROOT__", JSON.stringify(stateRoot));
	writeFileSync(probePath, probeText, "utf8");

	const cbmAttested = attestExtension(CBM_EXTENSION, sha256File(CBM_EXTENSION));
	if (!cbmAttested.ok) throw new Error(`cannot derive the cbm tree: ${cbmAttested.denial}`);
	const extensionTree = (() => {
		const attested = attestExtension(EXTENSION, sha256File(EXTENSION));
		if (!attested.ok) throw new Error(`cannot derive the extension tree: ${attested.denial}`);
		return attested.digests;
	})();

	const grant = createControllerGrant({ controllerId: "c1-suite/tool-boundary", basis: "C1 acceptance harness" });
	const runtime = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: sha256File(EXTENSION),
		extensionTree,
		additionalExtensions: [{ path: probePath, sha256: sha256File(probePath), tree: {} }],
		args: ["--no-session", "--no-skills", "--no-rules"],
		cwd: sessionDir,
	});
	try {
		if (!runtime.ok) throw new Error(`launch refused: ${runtime.denial} ${JSON.stringify(runtime.detail)}`);
		fact("launch:governed", runtime.ok === true, { sandbox: runtime.sandbox?.active ?? null, capabilityProvisioned: runtime.capabilityProvisioned });

		// Dispatch the probe. Its return value is not a signed result frame (that
		// protocol belongs to the fence commands), so the answer is the report file.
		// A timeout here is not a failure: the probe may still be running, and the
		// file is the evidence.
		const dispatched = await runtime.request("c1-probe-1", {}, "/c1-probe", 20_000);
		const deadline = Date.now() + 90_000;
		while (!existsSync(reportPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (!existsSync(reportPath)) {
			throw new Error(
				`probe produced no report: dispatch=${JSON.stringify(dispatched).slice(0, 300)} stderr=${String(runtime.stderr ?? "").slice(0, 600)}`,
			);
		}
		const report = JSON.parse(readFileSync(reportPath, "utf8"));

		// THE PREMISE, PROVEN BY EFFECT.
		//
		// Asking a module "is a capability installed" from outside is not a sound
		// question: importing the capability module again yields a SECOND instance
		// with its own state, and re-importing the fence extension re-runs its install
		// after the key descriptor was already consumed. Both answers would be
		// artifacts. So the premise is proven the way the capability is actually used:
		// the controller COMMITS on this very runtime, and the commit is durable.
		const bound = await bindIdentity(runtime);
		fact("premise:identity-bound", bound.ok === true, bound.reason ?? null);
		let committed = null;
		if (bound.ok) {
			committed = await commitFence(runtime, { status: "PASS", expectation: bound.identity });
			fact("premise:governed-process-holds-capability", committed.state === COMMIT_STATE.COMMITTED, {
				state: committed.state,
				ledgerRecorded: committed.result?.ledgerRecorded ?? null,
			});
		} else {
			fact("premise:governed-process-holds-capability", false, "identity could not be bound, so nothing was committed");
		}

		// T01: the tool path did not evaluate agent-written code.
		fact("T01:tool-path-did-not-evaluate-planted-module", report.plantedEvaluatedByToolPath === false, report.plantedEvaluatedByToolPath);
		// `active: true` is the load-bearing half. Every parent-side failure result
		// carries `mode: "child-process"` with `active: false`, so asserting the mode
		// alone would pass on a missing runner, a failed launch or a timeout — the
		// suite would report PASS without a child ever answering.
		fact(
			"T01:tool-answered-from-a-child-process",
			report.toolIsolation?.mode === "child-process" && report.toolIsolation?.active === true,
			report.toolIsolation,
		);
		fact("T01:capability-still-usable-after-the-tool-call", committed?.state === COMMIT_STATE.COMMITTED, committed?.state ?? null);
		// A real answer, from a store this harness populated: AVAILABLE with the seeded
		// record present. `typeof state === "string"` would accept UNAVAILABLE.
		fact(
			"T01:tool-answered-from-the-controlled-store",
			report.toolState === "AVAILABLE" && (report.retrievedCount ?? 0) >= 1,
			{ state: report.toolState, retrievedCount: report.retrievedCount ?? null, reason: report.toolReason },
		);

		// THE NEGATIVE CONTROL: the same module, loaded the pre-repair way, DOES run.
		fact("control:planted-module-executes-when-loaded-directly", report.controlEvaluated === true, {
			controlLoaded: report.controlLoaded,
			controlError: report.controlError ?? null,
		});

		return { report };
	} finally {
		await runtime.stop();
		disposeControllerRoot(controllerRoot);
	}
}

/**
 * THE PRE-REPAIR CONTROL.
 *
 * Everything above measures the repaired code. This case measures the code it
 * replaced, from the same repository, launched the same way, driven by the same
 * probe. The pre-repair extension MUST evaluate the planted module — if it does
 * not, the positive facts above are vacuous and this suite fails.
 *
 * The old bytes are taken from git, not retyped: a reconstruction would prove
 * something about the reconstruction.
 */
async function casePreRepairControl() {
	const dir = join(SCRATCH_ROOT, "pre-repair");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(join(dir, "extension", "lib"), { recursive: true });
	const sessionDir = join(dir, "session");
	mkdirSync(sessionDir, { recursive: true });

	const original = spawnSync("git", ["show", "HEAD:integrations/omp/extensions/cbm-query.js"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
	});
	if (original.status !== 0) throw new Error(`cannot read the pre-repair extension from git: ${original.stderr}`);
	// Only meaningful if the bytes really are the pre-repair version.
	if (!/walk up from the session cwd|three directories up/.test(original.stdout)) {
		throw new Error("HEAD no longer holds the pre-repair extension; the control cannot be run");
	}
	const oldExtension = join(dir, "extension", "cbm-query.js");
	writeFileSync(oldExtension, original.stdout, "utf8");
	// Its siblings come from the repository; only the ENTRY is the old file.
	for (const name of readdirSync(join(REPO_ROOT, "integrations", "omp", "extensions", "lib"))) {
		writeFileSync(join(dir, "extension", "lib", name), readFileSync(join(REPO_ROOT, "integrations", "omp", "extensions", "lib", name)));
	}

	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);

	const reportPath = join(dir, "c1-report.json");
	const probePath = join(dir, "c1-probe.mjs");
	writeFileSync(
		probePath,
		PROBE.replace("__CBM_EXTENSION__", JSON.stringify(oldExtension))
			.replace("__PLANTED_SOURCE__", JSON.stringify(plantedSource()))
			.replace("__REPORT_PATH__", JSON.stringify(reportPath))
			// The control does not need a populated store: it measures only whether the
			// planted module was evaluated, which happens before any store is opened.
			.replace("__STATE_ROOT__", JSON.stringify(join(dir, "memory-state"))),
		"utf8",
	);

	const extensionTree = (() => {
		const attested = attestExtension(EXTENSION, sha256File(EXTENSION));
		if (!attested.ok) throw new Error(`cannot derive the extension tree: ${attested.denial}`);
		return attested.digests;
	})();

	const grant = createControllerGrant({ controllerId: "c1-suite/pre-repair", basis: "C1 negative control" });
	const runtime = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: sha256File(EXTENSION),
		extensionTree,
		additionalExtensions: [{ path: probePath, sha256: sha256File(probePath), tree: {} }],
		args: ["--no-session", "--no-skills", "--no-rules"],
		cwd: sessionDir,
	});
	try {
		if (!runtime.ok) throw new Error(`launch refused: ${runtime.denial} ${JSON.stringify(runtime.detail)}`);
		await runtime.request("c1-pre-1", {}, "/c1-probe", 20_000);
		const deadline = Date.now() + 90_000;
		while (!existsSync(reportPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
		if (!existsSync(reportPath)) throw new Error("the pre-repair probe produced no report");
		const report = JSON.parse(readFileSync(reportPath, "utf8"));

		fact(
			"control:pre-repair-tool-path-DOES-evaluate-planted-module",
			report.plantedEvaluatedByToolPath === true,
			{ plantedEvaluatedByToolPath: report.plantedEvaluatedByToolPath, toolState: report.toolState, toolReason: report.toolReason },
		);
		return { report };
	} finally {
		await runtime.stop();
		disposeControllerRoot(controllerRoot);
	}
}

const asJson = process.argv.includes("--json");
mkdirSync(SCRATCH_ROOT, { recursive: true });

const results = {};
try {
	results["tool-boundary"] = await caseToolBoundary();
} catch (error) {
	fact("tool-boundary:RAN", false, String(error && error.message ? error.message : error));
	results["tool-boundary"] = { error: String(error && error.message ? error.message : error) };
}
try {
	results["pre-repair-control"] = await casePreRepairControl();
} catch (error) {
	fact("pre-repair-control:RAN", false, String(error && error.message ? error.message : error));
	results["pre-repair-control"] = { error: String(error && error.message ? error.message : error) };
}

const ok = facts.every((entry) => entry.ok);
const report = {
	card: "AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1",
	rpcBinary: RPC_BIN,
	facts,
	failed: facts.filter((entry) => !entry.ok),
	ok,
};
mkdirSync(join(SCRATCH_ROOT, "evidence"), { recursive: true });
writeFileSync(join(SCRATCH_ROOT, "evidence", "c1-facts.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
	for (const entry of facts) process.stdout.write(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name}\n`);
	process.stdout.write(ok ? "C1_SUITE = PASS\n" : "C1_SUITE = FAIL\n");
}
process.exit(ok ? 0 : 1);
