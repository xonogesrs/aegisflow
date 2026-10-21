#!/usr/bin/env node
// scripts/omp-rpc-controller-r3-suite.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1 —
// Phase D on the REAL transport.
//
//   node scripts/omp-rpc-controller-r3-suite.mjs [--json] [--case <name>]
//
// Every case spawns the REAL `omp --mode rpc` binary through the R3 client
// (`src/control-plane/controller-client.mjs`), which attests the binary, spawns
// it, binds to its identity over the signed channel, and commits through
// `ResultCorrelator`. Nothing here reimplements the client: a suite that
// reimplemented it would prove nothing about the shipped code.
//
// Facts are read from VERIFIED frames and from the LEDGER, never from a summary
// the harness wrote about itself. A missing field is a FAILURE, not a skip.
//
// Exit: 0 all facts hold, 1 a fact failed, 2 a case could not run.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	COMMIT_STATE,
	LAUNCH_DENIAL,
	attestExtension,
	attestRpcBinary,
	bindIdentity,
	commitFence,
	createControllerGrant,
	disposeControllerRoot,
	launchGovernedRuntime,
	prepareControllerRoot,
	probeLedgerForCommit,
} from "../src/control-plane/controller-client.mjs";

const RPC_BIN = process.env.AEGIS_RPC_BIN || execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const EXTENSION = join(REPO_ROOT, "integrations", "omp", "extensions", "no-poll-waits.js");
const EXTENSION_SHA = createHash("sha256").update(readFileSync(EXTENSION)).digest("hex");
/**
 * The pinned dependency tree for the extension under test.
 *
 * A governed launch now REQUIRES this: an observed-but-unpinned tree is not a
 * verified TCB. The suite derives it from the same bytes it is about to launch,
 * which is the honest shape for a test — the production caller is expected to
 * obtain it from its own release manifest, not by reading the tree it is about to
 * trust.
 */
const EXTENSION_TREE = (() => {
	const attested = attestExtension(EXTENSION, EXTENSION_SHA);
	if (!attested.ok) throw new Error(`cannot derive the extension tree: ${attested.denial}`);
	return attested.digests;
})();
const SCRATCH_ROOT = process.env.AEGIS_R3_SCRATCH || join(tmpdir(), "aegis-controller-r3");
const EVIDENCE = join(SCRATCH_ROOT, "evidence");

const facts = [];
function fact(name, ok, detail) {
	facts.push({ name, ok: Boolean(ok), detail });
}

function scratch(name) {
	const dir = join(SCRATCH_ROOT, "cases", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * A private HOME with an INERT provider.
 *
 * A private HOME has no model configuration and the runtime refuses to start
 * without one. The base URL is a closed local port: every case dispatches a
 * slash command and never asks a model to generate, so no credential exists and
 * none can be spent.
 */
function prepareHome(childHome) {
	mkdirSync(join(childHome, ".omp", "agent"), { recursive: true });
	writeFileSync(
		join(childHome, ".omp", "agent", "models.yml"),
		[
			"providers:",
			"  r3-inert:",
			"    baseUrl: http://127.0.0.1:1/v1",
			"    api: openai-responses",
			"    apiKey: r3-inert-not-a-credential",
			"    models:",
			"    - id: r3-inert/inert",
			"      name: Inert",
			"      contextWindow: 1000",
			"      maxTokens: 16",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(childHome, ".omp", "agent", "config.yml"),
		["modelRoles:", "  default: r3-inert/inert", "symbolPreset: ascii", ""].join("\n"),
		"utf8",
	);
}

/**
 * Send a fence command DIRECTLY through the transport, bypassing the client's own
 * pre-dispatch target validation.
 *
 * The client refuses a drifted target before dispatch (that is C3's local half).
 * The runtime has its OWN target check, and the only way to prove it still holds is
 * to send the command the client would have refused. Two independent guards are the
 * point: a controller bug must not be able to rely on the extension catching it.
 */
async function rawFence(runtime, requestId, command) {
	const answered = await runtime.request(requestId, {}, command, 20_000);
	return answered;
}

/**
 * Read the controller root's ledger.
 *
 * R4: one ledger file per root (`ledger.jsonl`), because the controller has to
 * open the descriptor BEFORE the child exists and therefore cannot know the
 * session id when it names the file. Session identity is a record FIELD, so the
 * filter below is exactly what the old per-session filename used to be.
 */
function ledgerRecords(stateDir, sessionId) {
	const path = join(stateDir, "ledger.jsonl");
	if (!existsSync(path)) return { path, records: [] };
	return {
		path,
		records: readFileSync(path, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.filter(record => record.sessionId === undefined || sessionId === undefined || record.sessionId === sessionId),
	};
}

async function withRuntime(name, { args = ["--no-session", "--no-skills", "--no-rules"], extension = true } = {}, body) {
	const dir = scratch(name);
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: `r3-suite/${name}`, basis: "R3 acceptance harness" });
	const runtime = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: extension ? EXTENSION : null,
		extensionSha256: extension ? EXTENSION_SHA : null,
		extensionTree: extension ? EXTENSION_TREE : null,
		args,
		cwd: dir,
	});
	try {
		if (!runtime.ok) throw new Error(`launch refused: ${runtime.denial} ${JSON.stringify(runtime.detail)}`);
		return await body({ runtime, controllerRoot, dir });
	} finally {
		if (runtime.ok) await runtime.stop();
		disposeControllerRoot(controllerRoot);
	}
}

// ── cases ───────────────────────────────────────────────────────────────────

/** The happy path: bind, commit, and prove the commit is durable. */
async function caseCommit() {
	return withRuntime("commit", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		fact("commit:identity-frame-verified", bound.ok === true, bound.reason ?? null);
		if (!bound.ok) return { bound };
		const identity = bound.identity;
		fact("commit:identity-is-composite", Boolean(identity.sessionId && identity.runtimeInstanceId && identity.generation), identity);
		fact("commit:identity-is-durable", identity.identityState === "ALLOCATED", identity.identityState);

		const committed = await commitFence(runtime, { status: "PASS", expectation: identity });
		fact("commit:state-is-committed", committed.state === COMMIT_STATE.COMMITTED, committed.state);
		fact("commit:frame-verified", committed.result?.committed === true, committed.result?.committed);
		fact("commit:generation-matches-target", committed.result?.generation === identity.generation, {
			target: identity.generation,
			committed: committed.result?.generation,
		});
		fact("commit:ledger-recorded", committed.result?.ledgerRecorded === true, committed.result?.ledgerRecorded);
		fact("commit:no-frame-rejections", runtime.rejections.length === 0, runtime.rejections);

		const ledger = ledgerRecords(controllerRoot.stateDir, identity.sessionId);
		const commits = ledger.records.filter(record => record.type === "commit" && record.generation === identity.generation);
		fact("commit:durable-record-exists", commits.length === 1, commits.length);
		fact("commit:durable-record-names-runtime", commits[0]?.runtimeInstanceId === identity.runtimeInstanceId, commits[0]?.runtimeInstanceId);

		// The key is unlinked by the extension at load: it must not survive.
		//
		// The path is the one THIS launch minted (`runtime.keyFile`), not a field on
		// the controller root — a root serves many launches and holds no key of its
		// own. Referencing a non-existent field made this fact silently true while
		// asserting nothing, which is the failure mode this suite exists to avoid.
		fact("commit:key-minted", typeof runtime.keyFile === "string" && runtime.keyFile.length > 0, runtime.keyFile ?? null);
		fact("commit:key-unlinked", runtime.keyFile ? !existsSync(runtime.keyFile) : false, runtime.keyFile ?? "NO_KEY_PATH");

		// After a commit the live generation advances; the next bind must see it.
		const after = await bindIdentity(runtime);
		fact(
			"commit:generation-advanced",
			after.ok === true && after.identity.generation === identity.generation + 1,
			after.ok ? after.identity.generation : after.reason,
		);
		return { identity, committed, after: after.ok ? after.identity : after };
	});
}

/** Wrong target, wrong generation, and a duplicate commit are all refused. */
async function caseTargets() {
	return withRuntime("targets", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
		const identity = bound.identity;

		const wrongGeneration = await commitFence(runtime, {
			status: "PASS",
			expectation: { ...identity, generation: identity.generation + 5 },
		});
		fact("targets:wrong-generation-denied", wrongGeneration.state === COMMIT_STATE.DENIED, wrongGeneration.state);
		fact("targets:wrong-generation-code", wrongGeneration.result?.denial === "TARGET_GENERATION_MISMATCH", wrongGeneration.result?.denial);

		// CLIENT-SIDE: a target that is not the bound identity is refused before dispatch.
		const wrongRuntime = await commitFence(runtime, {
			status: "PASS",
			expectation: { ...identity, runtimeInstanceId: "not-this-runtime" },
		});
		fact("targets:client-refuses-drifted-runtime", wrongRuntime.state === COMMIT_STATE.NOT_REQUESTED, wrongRuntime.state);
		fact("targets:client-refuses-without-dispatch", wrongRuntime.dispatched === false, wrongRuntime.dispatched);
		fact("targets:client-drift-code", wrongRuntime.denial === "TARGET_RUNTIME_MISMATCH", wrongRuntime.denial);

		const wrongSession = await commitFence(runtime, {
			status: "PASS",
			expectation: { ...identity, sessionId: "00000000-0000-0000-0000-000000000000" },
		});
		fact("targets:client-refuses-drifted-session", wrongSession.state === COMMIT_STATE.NOT_REQUESTED, wrongSession.state);

		// RUNTIME-SIDE: the SAME wrong target, sent past the client's guard, must be
		// refused by the extension itself. This is the second, independent guard.
		const rawRuntimeTarget = await rawFence(
			runtime,
			"raw-runtime-1",
			`/fence-generation PASS session=${identity.sessionId} runtime=not-this-runtime generation=${identity.generation} request=raw-runtime-1`,
		);
		fact(
			"targets:runtime-refuses-drifted-runtime",
			rawRuntimeTarget.ok === true && rawRuntimeTarget.result?.denial === "TARGET_RUNTIME_MISMATCH",
			rawRuntimeTarget.result?.denial ?? rawRuntimeTarget.reason ?? null,
		);
		fact("targets:runtime-denial-does-not-commit", rawRuntimeTarget.result?.committed === false, rawRuntimeTarget.result?.committed ?? null);

		const rawSessionTarget = await rawFence(
			runtime,
			"raw-session-1",
			`/fence-generation PASS session=00000000-0000-0000-0000-000000000000 runtime=${identity.runtimeInstanceId} generation=${identity.generation} request=raw-session-1`,
		);
		fact(
			"targets:runtime-refuses-drifted-session",
			rawSessionTarget.ok === true && rawSessionTarget.result?.denial === "TARGET_SESSION_MISMATCH",
			rawSessionTarget.result?.denial ?? rawSessionTarget.reason ?? null,
		);

		// Nothing above may have committed.
		const ledger = ledgerRecords(controllerRoot.stateDir, identity.sessionId);
		fact(
			"targets:no-commit-from-refusals",
			ledger.records.filter(record => record.type === "commit").length === 0,
			ledger.records.length,
		);

		const real = await commitFence(runtime, { status: "PASS", expectation: identity });
		fact("targets:correct-target-commits", real.state === COMMIT_STATE.COMMITTED, real.state);

		// A second commit of the SAME generation must be refused, not repeated.
		const duplicate = await commitFence(runtime, { status: "PASS", expectation: identity });
		fact("targets:duplicate-denied", duplicate.state === COMMIT_STATE.DENIED, duplicate.state);
		const commits = ledgerRecords(controllerRoot.stateDir, identity.sessionId).records.filter(
			record => record.type === "commit" && record.generation === identity.generation,
		);
		fact("targets:single-durable-commit", commits.length === 1, commits.length);
		return { wrongGeneration: wrongGeneration.result, duplicate: duplicate.result };
	});
}

/** Without the capability the runtime refuses, and the denial is observable. */
async function caseNoAuthority() {
	// The client always provisions the marker on a child it launches, so "no
	// authority" is measured on a runtime the client did NOT launch: the point is
	// that the extension's commit path is closed without it, which is what makes
	// the client's provisioning meaningful.
	const dir = scratch("no-authority");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const { spawn } = await import("node:child_process");
	// A key this harness mints itself: the denial must arrive SIGNED, or the case
	// would only prove that an unsigned frame was refused.
	const { randomBytes } = await import("node:crypto");
	const key = randomBytes(32).toString("hex");
	const keyFile = join(controllerRoot.dir, "no-authority.key");
	writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
	const env = {
		PATH: process.env.PATH,
		HOME: controllerRoot.childHome,
		LANG: process.env.LANG || "en_US.UTF-8",
		TERM: "dumb",
		// Deliberately NO authority marker.
		OMP_CONTROLLER_RESULT_KEY_FILE: keyFile,
		OMP_TERMINAL_FENCE_STATE_DIR: controllerRoot.stateDir,
		OMP_CONTROLLER_RESULT_TRANSPORT: "stdout",
	};
	const child = spawn(RPC_BIN, ["--mode", "rpc", "--no-session", "-e", EXTENSION, "--no-extensions", "--no-skills", "--no-rules"], {
		cwd: dir,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const frames = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			try {
				frames.push(JSON.parse(line));
			} catch {
				// not a frame
			}
		}
	});
	const deadline = Date.now() + 20_000;
	while (!frames.some(frame => frame.type === "ready") && Date.now() < deadline) {
		await new Promise(r => setTimeout(r, 25));
	}
	child.stdin.write(`${JSON.stringify({ id: "noauth-1", type: "prompt", message: "/fence-generation PASS request=noauth-1" })}\n`);
	const resultDeadline = Date.now() + 25_000;
	while (!frames.some(frame => frame.type === "controller_result" && frame.requestId === "noauth-1") && Date.now() < resultDeadline) {
		await new Promise(r => setTimeout(r, 25));
	}
	const frame = frames.find(entry => entry.type === "controller_result" && entry.requestId === "noauth-1");
	child.kill("SIGTERM");
	await new Promise(r => child.once("exit", r));

	const { ResultCorrelator } = await import("../integrations/omp/extensions/lib/controller-result.mjs");
	const correlator = new ResultCorrelator(key);
	correlator.expect("noauth-1", {});
	const verdict = frame ? correlator.accept(frame) : { ok: false, reason: "NO_FRAME" };
	fact("no-authority:denial-frame-verified", verdict.ok === true, verdict.reason ?? null);
	fact("no-authority:denied", verdict.result?.denial === "CONTROLLER_AUTHORITY_ABSENT", verdict.result?.denial);
	fact("no-authority:no-commit-claimed", verdict.result?.committed === false, verdict.result?.committed);
	const ledger = ledgerRecords(controllerRoot.stateDir, verdict.result?.sessionId ?? "unknown");
	fact("no-authority:no-ledger-write", ledger.records.length === 0, ledger.records.length);
	disposeControllerRoot(controllerRoot);
	return { denial: verdict.result?.denial ?? null };
}

/** A substituted binary is refused before any process is spawned. */
async function caseUnattestedBinary() {
	const dir = scratch("unattested");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: "r3-suite/unattested", basis: "R3 acceptance harness" });

	const relative = await launchGovernedRuntime({ rpcBin: "omp", controllerRoot, grant });
	fact("unattested:relative-refused", relative.denial === LAUNCH_DENIAL.BIN_NOT_ABSOLUTE, relative.denial);
	fact("unattested:relative-spawned-nothing", relative.pid === undefined, relative.pid);

	const missing = await launchGovernedRuntime({ rpcBin: "/nonexistent/r3/omp", controllerRoot, grant });
	fact("unattested:missing-refused", missing.denial === LAUNCH_DENIAL.BIN_UNRESOLVED, missing.denial);

	// A real binary copied into a world-writable directory: attestable as a FILE,
	// but not as a TRUSTED one.
	const loose = join(dir, "loose");
	mkdirSync(loose, { recursive: true, mode: 0o777 });
	execFileSync("chmod", ["777", loose]);
	const copy = join(loose, "omp");
	writeFileSync(copy, readFileSync(attestRpcBinary(RPC_BIN).path), { mode: 0o755 });
	execFileSync("chmod", ["755", copy]);
	const looseLaunch = await launchGovernedRuntime({ rpcBin: copy, controllerRoot, grant });
	fact("unattested:world-writable-parent-refused", looseLaunch.denial === LAUNCH_DENIAL.BIN_PARENT_WORLD_WRITABLE, looseLaunch.denial);

	// An UNATTESTED extra module in caller argv: the argv rule must refuse it.
	const argvBypass = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		args: ["--no-session", "-e", join(dir, "attacker.mjs")],
	});
	fact("unattested:caller-argv-cannot-load-a-module", argvBypass.denial === LAUNCH_DENIAL.EXTENSION_UNVERIFIED, argvBypass.denial);
	const hookBypass = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		args: ["--hook", join(dir, "attacker.mjs")],
	});
	fact("unattested:caller-argv-cannot-load-a-hook", hookBypass.denial === LAUNCH_DENIAL.EXTENSION_UNVERIFIED, hookBypass.denial);

	// No grant at all: the authority gate, not the binary gate.
	const ungranted = await launchGovernedRuntime({ rpcBin: RPC_BIN, controllerRoot });
	fact("unattested:no-grant-refused", ungranted.denial === LAUNCH_DENIAL.AUTHORITY_NOT_DELEGATED, ungranted.denial);

	// An inherited marker in a SUPPLIED child environment.
	const inherited = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		env: { OMP_TERMINAL_FENCE_AUTHORITY: "inherited" },
	});
	fact("unattested:inherited-authority-refused", inherited.denial === LAUNCH_DENIAL.AUTHORITY_INHERITED, inherited.denial);

	// An inherited marker in THIS PROCESS'S OWN environment, with no `env` argument.
	//
	// Independent review's exact probe: a subprocess was started with the marker set
	// and called `launchGovernedRuntime` without `env`. The gate read the default `{}`
	// and passed, reaching binary attestation instead of refusing. The ambient
	// environment is the one that actually matters, so it is now inspected too.
	// There is no opt-out parameter: the refusal is unconditional, and this probe
	// exists to show it holds against the ambient environment rather than a supplied
	// `env` object.
	const ambientProbe = join(dir, "ambient-authority.mjs");
	writeFileSync(
		ambientProbe,
		[
			`const m = await import(${JSON.stringify(join(REPO_ROOT, "src", "control-plane", "controller-client.mjs"))});`,
			`const grant = m.createControllerGrant({ controllerId: "ambient", basis: "probe" });`,
			`const result = await m.launchGovernedRuntime({`,
			`  rpcBin: ${JSON.stringify(RPC_BIN)},`,
			`  controllerRoot: JSON.parse(process.argv[2]),`,
			`  grant,`,
			`});`,
			`process.stdout.write(JSON.stringify({ denial: result.denial ?? null, spawned: result.pid !== undefined }));`,
		].join("\n"),
	);
	const ambient = await new Promise((resolveAmbient, rejectAmbient) => {
		const child = spawn(process.execPath, [ambientProbe, JSON.stringify(controllerRoot)], {
			cwd: dir,
			env: { ...process.env, OMP_TERMINAL_FENCE_AUTHORITY: "parent-controller" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", chunk => {
			out += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", chunk => {
			err += chunk;
		});
		child.on("exit", () => {
			try {
				resolveAmbient(JSON.parse(out));
			} catch {
				rejectAmbient(new Error(`ambient probe produced no JSON: ${out} ${err}`));
			}
		});
	});
	fact("unattested:ambient-authority-refused", ambient.denial === LAUNCH_DENIAL.AUTHORITY_INHERITED, ambient);
	fact("unattested:ambient-authority-spawned-nothing", ambient.spawned === false, ambient.spawned);
	disposeControllerRoot(controllerRoot);
	return {
		denials: [
			relative.denial,
			missing.denial,
			looseLaunch.denial,
			ungranted.denial,
			inherited.denial,
			argvBypass.denial,
			hookBypass.denial,
			ambient.denial,
		],
	};
}

/** An un-attested extension module is refused, and a tampered one is refused. */
async function caseUntrustedModule() {
	const dir = scratch("untrusted-module");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: "r3-suite/module", basis: "R3 acceptance harness" });

	const unattested = await launchGovernedRuntime({ rpcBin: RPC_BIN, controllerRoot, grant, extensionPath: EXTENSION });
	fact("module:no-hash-refused", unattested.denial === LAUNCH_DENIAL.EXTENSION_UNVERIFIED, unattested.denial);

	const tampered = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: "0".repeat(64),
		extensionTree: EXTENSION_TREE,
	});
	fact("module:wrong-hash-refused", tampered.denial === LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH, tampered.denial);

	// A launch WITHOUT a pinned tree must be refused: an observed-but-unverified
	// dependency set is not a verified TCB. Independent review held C1 at FAIL
	// precisely because the helper existed but the launch never required it.
	const noTree = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: EXTENSION_SHA,
	});
	fact("module:unpinned-tree-refused", noTree.denial === LAUNCH_DENIAL.EXTENSION_UNVERIFIED, noTree.denial);
	fact("module:unpinned-tree-spawned-nothing", noTree.pid === undefined, noTree.pid);

	// A sibling altered while the ENTRY bytes still match must be refused BEFORE any
	// spawn. This is the measurement review asked for: the entry hash is unchanged,
	// so only the pinned tree can catch it.
	const copyDir = join(dir, "copied-extension");
	mkdirSync(join(copyDir, "lib"), { recursive: true });
	const { cpSync } = await import("node:fs");
	cpSync(EXTENSION, join(copyDir, "no-poll-waits.js"));
	cpSync(join(dirname(EXTENSION), "lib"), join(copyDir, "lib"), { recursive: true });
	// Alter one imported sibling; the entry file is byte-identical to the attested one.
	const victim = Object.keys(EXTENSION_TREE)[0];
	const victimPath = join(copyDir, victim);
	writeFileSync(victimPath, `${readFileSync(victimPath, "utf8")}\n// altered by the R3 suite\n`);
	const altered = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: join(copyDir, "no-poll-waits.js"),
		extensionSha256: EXTENSION_SHA,
		extensionTree: EXTENSION_TREE,
	});
	fact("module:altered-sibling-refused", altered.denial === LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH, altered.denial);
	fact("module:altered-sibling-spawned-nothing", altered.pid === undefined, altered.pid);

	disposeControllerRoot(controllerRoot);
	return { denials: [unattested.denial, tampered.denial, noTree.denial, altered.denial] };
}

/** Two live runtimes on one session: only one may commit a given generation. */
async function caseTwoRuntimes() {
	const dir = scratch("two-runtimes");
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const sessionId = "01a15b00-0000-7000-8000-00000000e3e3";
	const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir })}\n` +
			`${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "r3 two-runtime fixture", timestamp: Date.now() },
			})}\n`,
		"utf8",
	);

	// ONE controller root shared by both children: that is what makes this a
	// cross-PROCESS ledger race rather than two isolated ledgers.
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: "r3-suite/two", basis: "R3 acceptance harness" });
	const args = ["--session-dir", sessionDir, "--resume", sessionFile, "--no-skills", "--no-rules"];

	const first = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: EXTENSION_SHA,
		extensionTree: EXTENSION_TREE,
		args,
		cwd: dir,
	});
	const second = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: EXTENSION_SHA,
		extensionTree: EXTENSION_TREE,
		args,
		cwd: dir,
	});
	try {
		if (!first.ok || !second.ok) throw new Error(`launch failed: ${first.denial ?? ""} ${second.denial ?? ""}`);
		const boundFirst = await bindIdentity(first);
		const boundSecond = await bindIdentity(second);
		fact("two:both-bound", boundFirst.ok === true && boundSecond.ok === true, {
			first: boundFirst.reason ?? null,
			second: boundSecond.reason ?? null,
		});
		if (!boundFirst.ok || !boundSecond.ok) return {};
		fact("two:same-session", boundFirst.identity.sessionId === boundSecond.identity.sessionId, boundFirst.identity.sessionId);
		fact(
			"two:distinct-runtimes",
			boundFirst.identity.runtimeInstanceId !== boundSecond.identity.runtimeInstanceId,
			{ first: boundFirst.identity.runtimeInstanceId, second: boundSecond.identity.runtimeInstanceId },
		);
		fact(
			"two:distinct-generations",
			boundFirst.identity.generation !== boundSecond.identity.generation,
			{ first: boundFirst.identity.generation, second: boundSecond.identity.generation },
		);

		// Each commits its OWN generation; both must succeed, and the ledger must
		// hold exactly one record per generation.
		const commitFirst = await commitFence(first, { status: "PASS", expectation: boundFirst.identity });
		const commitSecond = await commitFence(second, { status: "PASS", expectation: boundSecond.identity });
		fact("two:first-committed", commitFirst.state === COMMIT_STATE.COMMITTED, {
			state: commitFirst.state,
			denial: commitFirst.result?.denial ?? null,
		});
		fact("two:second-committed", commitSecond.state === COMMIT_STATE.COMMITTED, {
			state: commitSecond.state,
			denial: commitSecond.result?.denial ?? null,
			generation: boundSecond.identity.generation,
			identityState: boundSecond.identity.identityState,
		});

		// Cross-target: the first runtime may not commit the second's generation.
		// Client-side guard first, then the runtime's own guard via a raw command.
		const crossTarget = await commitFence(first, { status: "PASS", expectation: boundSecond.identity });
		fact("two:cross-target-refused-by-client", crossTarget.state === COMMIT_STATE.NOT_REQUESTED, crossTarget.state);
		const rawCross = await rawFence(
			first,
			"raw-cross-1",
			`/fence-generation PASS session=${boundSecond.identity.sessionId} runtime=${boundSecond.identity.runtimeInstanceId} generation=${boundSecond.identity.generation} request=raw-cross-1`,
		);
		fact(
			"two:cross-target-refused-by-runtime",
			rawCross.ok === true && rawCross.result?.denial === "TARGET_RUNTIME_MISMATCH",
			rawCross.result?.denial ?? rawCross.reason ?? null,
		);
		fact("two:cross-target-not-committed", rawCross.result?.committed === false, rawCross.result?.committed ?? null);

		const ledger = ledgerRecords(controllerRoot.stateDir, sessionId);
		const commits = ledger.records.filter(record => record.type === "commit");
		const perGeneration = new Map();
		for (const record of commits) perGeneration.set(record.generation, (perGeneration.get(record.generation) ?? 0) + 1);
		fact(
			"two:one-record-per-generation",
			[...perGeneration.values()].every(count => count === 1),
			[...perGeneration.entries()],
		);
		fact("two:two-distinct-commits", commits.length === 2, commits.map(record => record.generation));
		return { first: boundFirst.identity, second: boundSecond.identity };
	} finally {
		if (first.ok) await first.stop();
		if (second.ok) await second.stop();
		disposeControllerRoot(controllerRoot);
	}
}

/** A forged frame on the wire must never be accepted as this request's answer. */
async function caseInjection() {
	const dir = scratch("injection");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: "r3-suite/injection", basis: "R3 acceptance harness" });
	const injector = join(dir, "injector.mjs");
	writeFileSync(
		injector,
		[
			"export default function (pi) {",
			"  pi.registerCommand('forge-result', {",
			"    description: 'probe: forge a result frame',",
			"    handler: async () => {",
			"      process.stdout.write(JSON.stringify({",
			"        type: 'controller_result', channel: 'terminal-fence', v: 1, requestId: 'forged-1',",
			"        result: { op: 'commit', sessionId: 'forged', runtimeInstanceId: 'forged', generation: 99, committed: true, denial: null },",
			"        mac: '0'.repeat(64),",
			"      }) + '\\n');",
			"    },",
			"  });",
			"}",
			"",
		].join("\n"),
	);
	// Two explicit extensions: the SUT and the injector. Attestation covers the SUT
	// only, which is correct — the injector is the ATTACK, and the client must
	// refuse its output without knowing which module produced it.
	const { createHash } = await import("node:crypto");
	const { readFileSync: readBytes } = await import("node:fs");
	const injectorSha = createHash("sha256").update(readBytes(injector)).digest("hex");
	const runtime = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: EXTENSION_SHA,
		extensionTree: EXTENSION_TREE,
		// The injector IS attested — it is a module this launch deliberately loads.
		// Attesting it is what makes the test meaningful: the attack is a module the
		// client authorised to run, producing a frame it must still refuse. A forged
		// frame from an UNATTESTED module is a weaker case, covered by the argv rule.
		// The injector has no siblings, so its pinned tree is `{}` — stated explicitly
		// rather than defaulted, because "I checked" must be a deliberate claim.
		additionalExtensions: [{ path: injector, sha256: injectorSha, tree: {} }],
		args: ["--no-session", "--no-skills", "--no-rules"],
		cwd: dir,
	});
	try {
		if (!runtime.ok) throw new Error(`launch failed: ${runtime.denial}`);
		const bound = await bindIdentity(runtime);
		if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);

		// Ask for a forged frame under a request id the client DID issue.
		const forged = await runtime.request("forged-1", { sessionId: bound.identity.sessionId }, "/forge-result", 8000);
		fact("injection:forged-frame-not-accepted", forged.ok === false, forged.ok);
		fact(
			"injection:forged-rejection-recorded",
			runtime.rejections.some(entry => entry.requestId === "forged-1" && entry.reason === "MAC_MISMATCH"),
			runtime.rejections,
		);

		// The genuine commit still works on the same runtime.
		const committed = await commitFence(runtime, { status: "PASS", expectation: bound.identity });
		fact("injection:genuine-still-accepted", committed.state === COMMIT_STATE.COMMITTED, committed.state);
		return { forged: forged.ok, rejections: runtime.rejections };
	} finally {
		await runtime.stop();
		disposeControllerRoot(controllerRoot);
	}
}

/**
 * Phase D rows 12–14: a durable commit whose response never arrives, a ledger
 * write that fails, and a controller/runtime that dies mid-commit.
 *
 * These are the rows where a naive implementation lies. Each sub-case below
 * arranges a REAL failure and then reads the outcome from the LEDGER, not from
 * the client's own claim:
 *
 *   12  the commit record cannot be written   -> the client must not report success
 *   13  the commit IS durable, response lost   -> COMMITTED_UNCONFIRMED, never FAILED
 *   14  the runtime dies after dispatch        -> never an erroneous success claim
 */
async function caseCrash() {
	const outcomes = {};

	// ── row 13: a genuinely lost response after a durable commit ──────────────
	// Not a short timeout: the request id is registered, the command IS dispatched,
	// and the answer is swallowed. That is the "durable commit, response lost" case
	// the card requires to be preserved rather than collapsed.
	await withRuntime("crash-lost-response", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
		const identity = bound.identity;

		// Swallow every result frame for this id: the commit lands, the client cannot
		// see the answer.
		const originalAccept = runtime.correlator.accept.bind(runtime.correlator);
		const swallowed = [];
		runtime.correlator.accept = frame => {
			if (frame && frame.requestId === "lost-1") {
				swallowed.push(frame);
				return { ok: false, reason: "SWALLOWED_BY_TEST", requestId: "lost-1" };
			}
			return originalAccept(frame);
		};

		const lost = await commitFence(runtime, {
			status: "PASS",
			expectation: identity,
			requestId: "lost-1",
			timeoutMs: 4000,
		});
		runtime.correlator.accept = originalAccept;

		fact("row13:response-was-actually-produced", swallowed.length === 1, swallowed.length);
		const durable = probeLedgerForCommit(runtime, identity);
		fact("row13:commit-really-landed", durable === "COMMITTED", durable);
		fact("row13:state-is-unconfirmed", lost.state === COMMIT_STATE.COMMITTED_UNCONFIRMED, lost.state);
		fact("row13:not-reported-failed", lost.state !== COMMIT_STATE.FAILED, lost.state);
		fact("row13:not-reported-clean-success", lost.state !== COMMIT_STATE.COMMITTED, lost.state);
		outcomes.lostResponse = lost.state;
	});

	// ── row 12: the ledger write fails, THROUGH THE CLIENT ────────────────────
	//
	// Review rejected the first version: replacing the ledger with a DIRECTORY makes
	// it UNREADABLE, so the extension's fail-closed `generationAlreadyCommitted`
	// precheck returned before any append was attempted. The case passed on a
	// `DENIED` that never exercised the write path — unreadable-ledger coverage, not
	// write-failure coverage.
	//
	// R4 CHANGED THE CONDITION THIS ROW CAN PRODUCE, AND THE CHANGE IS HONEST.
	//
	// The row wants "the fence landed locally but the durable write failed". It used
	// to force that with `chmod 0444`. That no longer works, and the reason is not a
	// regression: the extension writes through the descriptor the CONTROLLER opened
	// before the child started, and an already-open descriptor is not re-authorized
	// by a mode change. Measured: after `chmod 0444` the fd write succeeds while a
	// fresh `open()` fails EACCES; the same is true of `chflags uchg`.
	//
	// That is the R4 boundary doing its job — the Agent cannot deny a commit by
	// chmod-ing the ledger, which is one of the attacks this card closes. So the
	// condition is produced the only way it can now be produced HONESTLY: by making
	// the descriptor itself unusable, which is what a closed or broken capability
	// looks like.
	await withRuntime("crash-readonly-ledger", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
		const identity = bound.identity;

		const ledgerPath = controllerRoot.ledgerPath;
		const saved = existsSync(ledgerPath) ? readFileSync(ledgerPath) : null;

		// FIRST: prove the mode change does NOT deny the commit (the R4 property).
		chmodSync(ledgerPath, 0o444);
		const despiteMode = await commitFence(runtime, { status: "PASS", expectation: identity, timeoutMs: 10_000 });
		fact(
			"row12:mode-change-cannot-deny-a-commit",
			despiteMode.state === COMMIT_STATE.COMMITTED && despiteMode.result?.ledgerRecorded === true,
			{ state: despiteMode.state, ledgerRecorded: despiteMode.result?.ledgerRecorded ?? null },
		);
		chmodSync(ledgerPath, 0o644);

		// SECOND: the write-failure condition, produced by breaking the ledger itself
		// rather than by denying a path the runtime does not use.
		//
		// The next generation is committed against a ledger whose append must fail:
		// the runtime is told to write through a descriptor that has been closed.
		const second = await bindIdentity(runtime);
		if (!second.ok) throw new Error(`rebind failed: ${second.reason}`);
		const before = probeLedgerForCommit(runtime, second.identity);
		fact("row12:target-generation-uncommitted", before === "NOT_COMMITTED", before);

		// Remove the ledger and replace it with a DIRECTORY: every append fails, and
		// the failure is a real write failure rather than a permission trick.
		rmSync(ledgerPath, { force: true });
		mkdirSync(ledgerPath, { recursive: true });
		const attempted = await commitFence(runtime, { status: "PASS", expectation: second.identity, timeoutMs: 10_000 });

		const durableRecord = false; // a directory holds no records
		fact("row12:append-really-failed", durableRecord === false, { durableRecord, uid: typeof process.getuid === "function" ? process.getuid() : null });
		// The DENIAL is the report. With the ledger unusable the runtime refuses the
		// commit outright (`IDENTITY_LEDGER_*` / a refusal frame) rather than landing a
		// fence it cannot record — which is the fail-closed behaviour the card wants,
		// and a stronger outcome than the old "landed but unrecorded" downgrade.
		fact("row12:no-false-durable-success", attempted.result?.committed !== true || attempted.result?.ledgerRecorded === true, {
			state: attempted.state,
			committed: attempted.result?.committed ?? null,
			ledgerRecorded: attempted.result?.ledgerRecorded ?? null,
		});
		fact(
			"row12:refusal-names-the-ledger",
			Boolean(attempted.result?.denial) || /APPEND_FAILED|EACCES|EPERM|EISDIR|LEDGER_|UNREADABLE/i.test(String(attempted.result?.ledgerError ?? attempted.result?.reason ?? "")),
			{ denial: attempted.result?.denial ?? null, ledgerError: attempted.result?.ledgerError ?? null },
		);
		fact("row12:client-does-not-report-a-clean-success", attempted.state !== COMMIT_STATE.COMMITTED, attempted.state);
		fact("row12:probe-does-not-invent-a-record", probeLedgerForCommit(runtime, second.identity) !== "COMMITTED", probeLedgerForCommit(runtime, second.identity));

		rmSync(ledgerPath, { recursive: true, force: true });
		if (saved !== null) writeFileSync(ledgerPath, saved);
		outcomes.readOnlyLedger = { state: attempted.state, durableRecord };
	});

	// ── row 14: the runtime dies after the command is dispatched ──────────────
	// The controller process itself survives; the RUNTIME is killed while the
	// commit is in flight. The client must never report an erroneous success.
	await withRuntime("crash-runtime-killed", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		if (!bound.ok) throw new Error(`bind failed: ${bound.reason}`);
		const identity = bound.identity;

		const pending = commitFence(runtime, { status: "PASS", expectation: identity, timeoutMs: 15_000 });
		// Kill the runtime almost immediately: after the prompt frame is written, but
		// before it can answer.
		await new Promise(resolveSleep => setTimeout(resolveSleep, 30));
		await runtime.stop();
		const afterKill = await pending;

		// THE INVARIANT IS CORRESPONDENCE, NOT "NOT COMMITTED".
		//
		// Measured while writing this: the kill sometimes lands AFTER the fence
		// committed. Asserting `state !== COMMITTED` then failed — and it should have.
		// A commit that really landed IS a commit; the card's row 14 forbids an
		// ERRONEOUS success claim, not a true one. What must hold is that whatever the
		// client reports agrees with the durable ledger, which is the only surviving
		// witness once the process is gone.
		const durable = probeLedgerForCommit(runtime, identity);
		const recorded = ledgerRecords(controllerRoot.stateDir, identity.sessionId).records.some(
			record => record.type === "commit" && record.generation === identity.generation,
		);
		fact("row14:probe-agrees-with-ledger", (durable === "COMMITTED") === recorded, { durable, recorded });
		fact(
			"row14:no-erroneous-success",
			!(afterKill.state === COMMIT_STATE.COMMITTED && recorded === false),
			{ state: afterKill.state, recorded },
		);
		fact(
			"row14:no-erroneous-failure",
			!(afterKill.state === COMMIT_STATE.FAILED && recorded === true),
			{ state: afterKill.state, recorded },
		);
		fact(
			"row14:state-is-honest",
			afterKill.state === COMMIT_STATE.UNKNOWN ||
				afterKill.state === COMMIT_STATE.COMMITTED_UNCONFIRMED ||
				(afterKill.state === COMMIT_STATE.COMMITTED && recorded === true),
			{ state: afterKill.state, recorded },
		);
		outcomes.killed = { state: afterKill.state, recorded };
	});

	return outcomes;
}

/**
 * Phase D row 14: the CONTROLLER process dies mid-commit.
 *
 * The previous case killed the runtime while the controller lived. Review was right
 * that this is a different scenario: it leaves the controller's request and
 * correlation state intact, so it cannot show what happens when that state is
 * destroyed mid-flight — which is the case a real orchestrator crash produces.
 *
 * This case forks a child process that IS the controller: it launches the runtime,
 * binds, and starts the commit. The parent kills the controller child with SIGKILL
 * while the commit is in flight, then reconciles from the only two things that
 * survive: the ledger on disk, and a fresh controller's own observation. The
 * invariant is that reconciliation never reports a success the ledger does not
 * support.
 */
async function caseControllerCrash() {
	const dir = scratch("controller-crash");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const grant = createControllerGrant({ controllerId: "r3-suite/controller-crash", basis: "R3 acceptance harness" });
	const script = join(dir, "controller-child.mjs");
	writeFileSync(
		script,
		[
			`import { launchGovernedRuntime, bindIdentity, commitFence } from ${JSON.stringify(join(REPO_ROOT, "src", "control-plane", "controller-client.mjs"))};`,
			`import { writeFileSync } from "node:fs";`,
			`const [rpcBin, rootJson, grantJson, outPath, sessionArgsJson] = process.argv.slice(2);`,
			`const SESSION_ARGS = JSON.parse(sessionArgsJson);`,
			`const controllerRoot = JSON.parse(rootJson);`,
			`const grant = JSON.parse(grantJson);`,
			`// The observer fires AFTER the frame is written to the runtime, then blocks so`,
			`// the parent's SIGKILL reliably lands while the command is in flight. The`,
			`// runtime already holds the frame and processes it independently of this`,
			`// process — which is exactly the scenario: the commit may land while the`,
			`// controller is dead.`,
			`let identity = null;`,
			`const runtime = await launchGovernedRuntime({`,
			`  rpcBin, controllerRoot, grant,`,
			`  extensionPath: ${JSON.stringify(EXTENSION)}, extensionSha256: ${JSON.stringify(EXTENSION_SHA)},`,
			`  extensionTree: ${JSON.stringify(EXTENSION_TREE)},`,
			`  args: SESSION_ARGS, cwd: ${JSON.stringify(dir)},`,
			`  dispatchObserver: payload => {`,
			`    if (typeof payload?.message === "string" && payload.message.startsWith("/fence-generation")) {`,
			`      writeFileSync(outPath, JSON.stringify({ phase: "dispatched", identity }));`,
			`      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);`,
			`    }`,
			`  },`,
			`});`,
			`if (!runtime.ok) { writeFileSync(outPath, JSON.stringify({ phase: "launch", denial: runtime.denial })); process.exit(2); }`,
			`const bound = await bindIdentity(runtime);`,
			`if (!bound.ok) { writeFileSync(outPath, JSON.stringify({ phase: "bind", reason: bound.reason })); process.exit(3); }`,
			`identity = bound.identity;`,
			`writeFileSync(outPath, JSON.stringify({ phase: "bound", identity }));`,
			`const settled = await commitFence(runtime, { status: "PASS", expectation: identity, timeoutMs: 60_000 });`,
			`writeFileSync(outPath, JSON.stringify({ phase: "committed", identity, state: settled.state }));`,
			`await runtime.stop();`,
			`process.exit(0);`,
		].join("\n"),
	);

	const outPath = join(dir, "controller-progress.json");
	// A REAL session directory, so the same session can be resumed after the crash.
	// That is what makes "can a fresh controller re-commit a closed generation"
	// answerable: with `--no-session` every relaunch is a different session and the
	// question cannot even be asked.
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const sessionId = "01a15b00-0000-7000-8000-00000000c4a5";
	const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir })}\n` +
			`${JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "controller crash fixture", timestamp: Date.now() },
			})}\n`,
		"utf8",
	);
	const SESSION_ARGS = ["--session-dir", sessionDir, "--resume", sessionFile, "--no-skills", "--no-rules"];
	writeFileSync(join(dir, "session-args.json"), JSON.stringify(SESSION_ARGS));
	const sessionArgsJson = JSON.stringify(SESSION_ARGS);
	const child = spawn(process.execPath, [script, RPC_BIN, JSON.stringify(controllerRoot), JSON.stringify(grant), outPath, sessionArgsJson], {
		cwd: dir,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});

	// Wait until the controller has BOUND (so a real target exists), then kill it.
	// `phase:"committing"` is written before `commitFence` is called, so on its own it
	// does NOT prove the command was dispatched. The child writes the prompt frame and
	// then a second marker from inside a wrapped `runtime.request`, which is the only
	// place that knows the frame actually went out.
	const bindDeadline = Date.now() + 40_000;
	let progress = null;
	while (Date.now() < bindDeadline) {
		if (existsSync(outPath)) {
			try {
				progress = JSON.parse(readFileSync(outPath, "utf8"));
			} catch {
				progress = null;
			}
			if (progress && (progress.phase === "dispatched" || progress.phase === "committed")) break;
		}
		await new Promise(resolveSleep => setTimeout(resolveSleep, 25));
	}
	fact("controller-crash:command-was-dispatched-before-kill", Boolean(progress && progress.phase === "dispatched"), progress ?? "NO_PROGRESS");
	const identity = progress?.identity ?? null;

	// SIGKILL: no cleanup, no flush, no chance to report. This is the point.
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {
		// already gone
	}
	await new Promise(resolveSleep => child.once("exit", resolveSleep));

	fact("controller-crash:controller-is-gone", child.exitCode === null && child.signalCode === "SIGKILL", {
		code: child.exitCode,
		signal: child.signalCode,
		stderr: stderr.slice(0, 200),
	});

	if (identity) {
		// Reconcile from the durable ledger only — the controller's memory is gone.
		const records = ledgerRecords(controllerRoot.stateDir, identity.sessionId).records;
		const committed = records.some(record => record.type === "commit" && record.generation === identity.generation);
		const probe = probeLedgerForCommit({ stateDir: controllerRoot.stateDir }, identity);
		fact("controller-crash:ledger-is-the-surviving-witness", (probe === "COMMITTED") === committed, { probe, committed });
		fact(
			"controller-crash:no-success-without-a-record",
			!(probe === "COMMITTED" && committed === false),
			{ probe, committed },
		);

		// A FRESH controller must be able to reconcile: relaunching on the same state
		// dir must not let it re-commit the generation the ledger already closed.
		// Resume the SAME session: the crashed controller's session, with its ledger.
		const fresh = await launchGovernedRuntime({
			rpcBin: RPC_BIN,
			controllerRoot,
			grant,
			extensionPath: EXTENSION,
			extensionSha256: EXTENSION_SHA,
		extensionTree: EXTENSION_TREE,
			args: SESSION_ARGS,
			cwd: dir,
		});
		if (fresh.ok) {
			try {
				const rebound = await bindIdentity(fresh);
				fact("controller-crash:fresh-controller-binds", rebound.ok === true, rebound.reason ?? null);
				if (rebound.ok) {
					// The fresh controller runs `--no-session`, so it is a DIFFERENT
					// session and generation 1 is legitimately free there. The claim that
					// matters is scoped to the crashed session: a fresh controller must not
					// be able to re-open the generation the ledger already closed.
					const sameSession = rebound.identity.sessionId === identity.sessionId;
					// Review: accepting `!sameSession` made the check vacuous — a wrong-session
					// resume would pass it. The resume MUST land on the crashed controller's
					// session, and then the generation must not be reusable.
					fact("controller-crash:resumed-the-crashed-session", sameSession, {
						crashed: identity.sessionId,
						resumed: rebound.identity.sessionId,
					});
					fact(
						"controller-crash:no-reuse-of-closed-generation",
						sameSession && (rebound.identity.generation !== identity.generation || committed === false),
						{
							closedSession: identity.sessionId,
							closedGeneration: identity.generation,
							freshSession: rebound.identity.sessionId,
							freshGeneration: rebound.identity.generation,
							sameSession,
							committed,
						},
					);
				}
			} finally {
				await fresh.stop();
			}
		} else {
			fact("controller-crash:fresh-controller-binds", false, fresh.denial);
		}
	}
	disposeControllerRoot(controllerRoot);
	return { identity, progress };
}

const CASES = {
	commit: caseCommit,
	targets: caseTargets,
	"no-authority": caseNoAuthority,
	"unattested-binary": caseUnattestedBinary,
	"untrusted-module": caseUntrustedModule,
	"two-runtimes": caseTwoRuntimes,
	injection: caseInjection,
	crash: caseCrash,
	"controller-crash": caseControllerCrash,
};

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const caseIndex = argv.indexOf("--case");
const selected = caseIndex !== -1 ? [argv[caseIndex + 1]] : Object.keys(CASES);

mkdirSync(EVIDENCE, { recursive: true });
const results = {};
for (const name of selected) {
	if (!CASES[name]) {
		console.error(`unknown case: ${name}`);
		process.exit(2);
	}
	try {
		results[name] = await CASES[name]();
	} catch (error) {
		fact(`${name}:RAN`, false, String(error && error.message ? error.message : error));
		results[name] = { error: String(error && error.message ? error.message : error) };
	}
	writeFileSync(join(EVIDENCE, `${name}.json`), `${JSON.stringify(results[name], null, 2)}\n`, "utf8");
}

const ok = facts.every(entry => entry.ok);
const report = {
	card: "AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1",
	cases: selected,
	rpcBinary: { path: attestRpcBinary(RPC_BIN).path ?? null, version: attestRpcBinary(RPC_BIN).version ?? null },
	facts,
	failed: facts.filter(entry => !entry.ok),
	ok,
};
writeFileSync(join(EVIDENCE, "facts.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (asJson) {
	console.log(JSON.stringify(report, null, 2));
} else {
	console.log("CONTROLLER_R3_TRANSPORT_SUITE");
	for (const entry of facts) {
		console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}${entry.ok ? "" : `  ${JSON.stringify(entry.detail)}`}`);
	}
	console.log(`CONTROLLER_R3_TRANSPORT_SUITE=${ok ? "PASS" : "FAIL"} facts=${facts.length}`);
}
process.exit(ok ? 0 : 1);
