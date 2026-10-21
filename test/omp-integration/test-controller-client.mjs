// test/omp-integration/test-controller-client.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1.
//
// Contract-level tests for `src/control-plane/controller-client.mjs`: the launch
// attestation matrix, the authority delegation rule, extension/TCB attestation,
// identity comparison, the commit state machine, and the durable-ledger probe.
//
// These are the cases that must be provable WITHOUT spawning a runtime. The
// transport-level facts live in `scripts/omp-rpc-controller-r3-suite.mjs`, which
// drives the real binary; a client that passes only one of the two is not
// accepted.
//
// Run: node --test test/omp-integration/test-controller-client.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { test } from "node:test";

import { signLedgerRecord } from "../../integrations/omp/extensions/lib/ledger-auth.mjs";
import {
	COMMIT_STATE,
	LAUNCH_DENIAL,
	attestExtension,
	attestRpcBinary,
	classifyCommitResult,
	commitFence,
	compareIdentity,
	createControllerGrant,
	isControllerGrant,
	launchGovernedRuntime,
	prepareControllerRoot,
	probeLedgerForCommit,
} from "../../src/control-plane/controller-client.mjs";

// Resolved, never hardcoded: a private absolute path in a published file is a
// publication-hygiene violation, and the scanner in this directory is right to
// refuse it. `AEGIS_RPC_BIN` names the binary under test; without it, the one on
// PATH is used, which is the same binary a user would run.
const RPC_BIN = process.env.AEGIS_RPC_BIN || execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
const EXTENSION = new URL("../../integrations/omp/extensions/no-poll-waits.js", import.meta.url).pathname;

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function scratch(prefix) {
	return mkdtempSync(join(tmpdir(), `r3-${prefix}-`));
}

// ── C1: RPC binary provenance ───────────────────────────────────────────────

test("an absolute, owner-controlled executable attests with a hash and its own version", () => {
	const attestation = attestRpcBinary(RPC_BIN);
	assert.equal(attestation.ok, true, `the test binary must attest: ${JSON.stringify(attestation)}`);
	// Measured by independent review: this assertion originally compared
	// `attestation.path` with itself, so it could never fail. The property that
	// actually matters is that the attested path is ABSOLUTE and RESOLVED — a
	// relative or symlink-bearing path would mean the hash was taken from a file
	// other than the one the OS executes.
	assert.equal(isAbsolute(attestation.path), true, `the attested path must be absolute: ${attestation.path}`);
	assert.equal(realpathSync(attestation.path), attestation.path, "the attested path must already be resolved");
	assert.match(attestation.sha256, /^[0-9a-f]{64}$/);
	assert.match(String(attestation.version), /omp\/\d+\.\d+\.\d+/, "the version must come from the attested file");
});

test("a relative binary path is refused, not resolved against PATH", () => {
	// Resolving `omp` through PATH would attest whichever directory happens to come
	// first in the launching environment, which is exactly the substitution this
	// check exists to prevent.
	const attestation = attestRpcBinary("omp");
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_NOT_ABSOLUTE);
});

test("an unset binary variable is a denial, not a default", () => {
	const attestation = attestRpcBinary(null, { env: {} });
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_UNRESOLVED);
});

test("a missing path is refused", () => {
	const attestation = attestRpcBinary("/nonexistent/r3/omp");
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_UNRESOLVED);
});

test("a non-executable file is refused", () => {
	const dir = scratch("noexec");
	const path = join(dir, "not-executable");
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
	chmodSync(path, 0o644);
	const attestation = attestRpcBinary(path);
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_NOT_EXECUTABLE);
});

test("a world-writable binary is refused even when it is executable", () => {
	const dir = scratch("worldwritable");
	const path = join(dir, "omp");
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
	chmodSync(path, 0o777);
	const attestation = attestRpcBinary(path);
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_WORLD_WRITABLE);
});

test("a binary under a world-writable directory is refused", () => {
	// The file itself is 0755; the DIRECTORY lets another user replace it, which
	// makes the file's own mode irrelevant.
	const dir = scratch("wwdir");
	const nested = join(dir, "bin");
	mkdirSync(nested, { mode: 0o777 });
	chmodSync(nested, 0o777);
	const path = join(nested, "omp");
	writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	chmodSync(path, 0o755);
	const attestation = attestRpcBinary(path);
	assert.equal(attestation.ok, false);
	assert.equal(attestation.denial, LAUNCH_DENIAL.BIN_PARENT_WORLD_WRITABLE);
});

// ── C2: authority is a delegation, never ambient ────────────────────────────

test("a grant requires a named controller and a stated basis", () => {
	assert.throws(() => createControllerGrant({ basis: "x" }), /controllerId/);
	assert.throws(() => createControllerGrant({ controllerId: "c" }), /basis/);
	const grant = createControllerGrant({ controllerId: "reviewer", basis: "card authorization" });
	assert.equal(isControllerGrant(grant), true);
	assert.equal(grant.kind, "controller-grant/v1");
	assert.equal(Object.isFrozen(grant), true, "a grant must not be mutable after creation");
});

test("anything that is not a grant is not accepted as one", () => {
	for (const value of [null, undefined, {}, "controller", { kind: "controller-grant/v1" }, { kind: "other", controllerId: "a", basis: "b" }]) {
		assert.equal(isControllerGrant(value), false, `accepted ${JSON.stringify(value)} as a grant`);
	}
});

test("a controller root is created 0700 and provisions a state dir and a private HOME", () => {
	const root = prepareControllerRoot({ root: join(scratch("root"), "controller") });
	assert.equal(statSync(root.dir).mode & 0o077, 0, "the controller root must not be group/other accessible");
	assert.equal(existsSync(root.stateDir), true);
	assert.equal(existsSync(root.childHome), true);
	// No key is minted here: a key file is single-use (the extension unlinks it at
	// load), so one root cannot serve two launches. Each launch mints its own.
	assert.equal(root.keyFile, undefined, "the root must not pre-provision a single-use key");
});

test("a controller root that is already group-accessible is refused", () => {
	const dir = join(scratch("loose"), "controller");
	mkdirSync(dir, { mode: 0o755 });
	chmodSync(dir, 0o755);
	assert.throws(() => prepareControllerRoot({ root: dir }), /group\/other accessible/);
});

// ── C1: extension / TCB attestation ────────────────────────────────────────

test("the extension attests only against a supplied hash", () => {
	assert.equal(attestExtension(EXTENSION, null).denial, LAUNCH_DENIAL.EXTENSION_UNVERIFIED);
	assert.equal(attestExtension(EXTENSION, "not-a-hash").denial, LAUNCH_DENIAL.EXTENSION_UNVERIFIED);
	const attested = attestExtension(EXTENSION, sha256(EXTENSION));
	assert.equal(attested.ok, true, JSON.stringify(attested));
	assert.ok(attested.tree.length >= 3, "the extension's lib siblings are part of the attested tree");
	assert.ok(attested.tree.every(entry => statSync(entry.path).isFile()));
	// Every sibling is HASHED, not merely present: presence is not integrity.
	assert.ok(
		attested.tree.every(entry => /^[0-9a-f]{64}$/.test(entry.sha256)),
		"every module in the tree must carry a digest",
	);
	// The digest keys must name the REAL sibling modules, derived from the directory
	// rather than from the attestation's own output. Comparing the output with itself
	// (which this line originally did) is vacuous — independent review caught it.
	const expectedSiblings = readdirSync(join(dirname(EXTENSION), "lib"))
		.filter(name => /\.(mjs|js|cjs)$/.test(name))
		.map(name => `lib/${name}`)
		.sort();
	assert.deepEqual(Object.keys(attested.digests).sort(), expectedSiblings, "the digest set must match the real lib/ modules");
	// And each digest must be the actual file's digest, recomputed here.
	for (const rel of expectedSiblings) {
		assert.equal(attested.digests[rel], sha256(join(dirname(EXTENSION), rel)), `${rel} digest must match the file`);
	}
	assert.equal(attested.treeVerified, false, "without an expected tree this is a first-run observation");
});

test("a mismatched extension hash is refused and names both digests", () => {
	const attested = attestExtension(EXTENSION, "0".repeat(64));
	assert.equal(attested.ok, false);
	assert.equal(attested.denial, LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH);
	assert.equal(attested.detail.actual, sha256(EXTENSION));
});

test("a missing extension path is refused", () => {
	assert.equal(attestExtension("/nonexistent/no-poll-waits.js", "0".repeat(64)).ok, false);
});

test("a governed launch requires a pinned tree and refuses to spawn without one", async () => {
	// Independent review's C1 FAIL: the helper could verify a tree, but the launch
	// never required one, so every real launch ran an observed-but-unverified module
	// set. The launch must fail closed instead.
	const dir = scratch("launch-tree");
	const root = prepareControllerRoot({ root: join(dir, "controller") });
	const grant = createControllerGrant({ controllerId: "tree-test", basis: "unit" });
	const entry = sha256(EXTENSION);
	const tree = attestExtension(EXTENSION, entry).digests;

	const unpinned = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot: root,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: entry,
	});
	assert.equal(unpinned.ok, false);
	assert.equal(unpinned.denial, LAUNCH_DENIAL.EXTENSION_UNVERIFIED);
	assert.equal(unpinned.pid, undefined, "an unpinned launch must spawn nothing");

	const tamperedTree = { ...tree };
	const victim = Object.keys(tamperedTree)[0];
	tamperedTree[victim] = "0".repeat(64);
	const drifted = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot: root,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: entry,
		extensionTree: tamperedTree,
	});
	assert.equal(drifted.ok, false);
	assert.equal(drifted.denial, LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH);
	assert.equal(drifted.pid, undefined, "a drifted tree must spawn nothing");
});

test("an additional extension requires a pinned tree, exactly like the primary", async () => {
	// Independent review's C1 FAIL: `entry.tree` was optional for additional
	// extensions, so a second module could import a `lib/` sibling and skip the
	// pinning required of the primary. Same TCB, same rule.
	const dir = scratch("additional-tree");
	const root = prepareControllerRoot({ root: join(dir, "controller") });
	const grant = createControllerGrant({ controllerId: "additional-tree", basis: "unit" });
	const entry = sha256(EXTENSION);
	const tree = attestExtension(EXTENSION, entry).digests;

	// A second module that DOES import a sibling: copy the extension under a new name.
	const secondDir = join(dir, "second");
	mkdirSync(join(secondDir, "lib"), { recursive: true });
	cpSync(EXTENSION, join(secondDir, "second.mjs"));
	cpSync(join(dirname(EXTENSION), "lib"), join(secondDir, "lib"), { recursive: true });
	const secondEntry = sha256(join(secondDir, "second.mjs"));
	const secondTree = attestExtension(join(secondDir, "second.mjs"), secondEntry).digests;

	// No tree at all -> refused before spawn.
	const noTree = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot: root,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: entry,
		extensionTree: tree,
		additionalExtensions: [{ path: join(secondDir, "second.mjs"), sha256: secondEntry }],
	});
	assert.equal(noTree.ok, false);
	assert.equal(noTree.denial, LAUNCH_DENIAL.EXTENSION_UNVERIFIED);
	assert.equal(noTree.pid, undefined);

	// A pinned tree whose sibling digest is wrong -> refused before spawn.
	const wrongTree = { ...secondTree };
	const victim = Object.keys(wrongTree)[0];
	wrongTree[victim] = "0".repeat(64);
	const drifted = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot: root,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: entry,
		extensionTree: tree,
		additionalExtensions: [{ path: join(secondDir, "second.mjs"), sha256: secondEntry, tree: wrongTree }],
	});
	assert.equal(drifted.ok, false);
	assert.equal(drifted.denial, LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH);
	assert.equal(drifted.pid, undefined);

	// A module with no siblings must supply `{}` — and that is accepted as a pin.
	const standalone = join(dir, "standalone.mjs");
	writeFileSync(standalone, "export default function () {}\n");
	const standaloneSha = sha256(standalone);
	const noSiblingTree = await launchGovernedRuntime({
		rpcBin: RPC_BIN,
		controllerRoot: root,
		grant,
		extensionPath: EXTENSION,
		extensionSha256: entry,
		extensionTree: tree,
		additionalExtensions: [{ path: standalone, sha256: standaloneSha, tree: { "lib/ghost.mjs": "0".repeat(64) } }],
	});
	// The module has no lib/, so a tree naming one is a layout mismatch.
	assert.equal(noSiblingTree.ok, false);
	assert.equal(noSiblingTree.denial, LAUNCH_DENIAL.EXTENSION_TREE_IMPURE);
});

test("the launching process's own authority marker is refused, not just a supplied env", async () => {
	// Independent review's C2 probe: the gate inspected the optional `env` argument
	// (default `{}`) instead of the ambient environment, so a process that really held
	// the marker launched anyway. This asserts the ambient check directly, without
	// spawning a child, by temporarily setting the marker in this process.
	const dir = scratch("ambient-authority-unit");
	const root = prepareControllerRoot({ root: join(dir, "controller") });
	const grant = createControllerGrant({ controllerId: "ambient-unit", basis: "unit" });
	const entry = sha256(EXTENSION);
	const tree = attestExtension(EXTENSION, entry).digests;

	const previous = process.env.OMP_TERMINAL_FENCE_AUTHORITY;
	process.env.OMP_TERMINAL_FENCE_AUTHORITY = "ambient-controller";
	try {
		const refused = await launchGovernedRuntime({
			rpcBin: RPC_BIN,
			controllerRoot: root,
			grant,
			extensionPath: EXTENSION,
			extensionSha256: entry,
			extensionTree: tree,
		});
		assert.equal(refused.ok, false);
		assert.equal(refused.denial, LAUNCH_DENIAL.AUTHORITY_INHERITED);
		assert.equal(refused.pid, undefined, "an inherited-authority launch must spawn nothing");
	} finally {
		if (previous === undefined) delete process.env.OMP_TERMINAL_FENCE_AUTHORITY;
		else process.env.OMP_TERMINAL_FENCE_AUTHORITY = previous;
	}
});

test("a pinned sibling tree is verified, and any drift is refused", () => {
	// Independent review's C1 point: verifying only the entry module leaves the
	// loaded module set unverified. A caller can now pin the whole tree.
	const entry = sha256(EXTENSION);
	const first = attestExtension(EXTENSION, entry);
	assert.equal(first.ok, true, JSON.stringify(first));

	// Re-attesting with the observed tree verifies.
	const pinned = attestExtension(EXTENSION, entry, { expectedTree: first.digests });
	assert.equal(pinned.ok, true, JSON.stringify(pinned));
	assert.equal(pinned.treeVerified, true, "a supplied tree must be marked verified");

	// One altered sibling digest is refused, and the refusal names the file.
	const tampered = { ...first.digests };
	const victim = Object.keys(tampered)[0];
	tampered[victim] = "0".repeat(64);
	const refused = attestExtension(EXTENSION, entry, { expectedTree: tampered });
	assert.equal(refused.ok, false);
	assert.equal(refused.denial, LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH);
	assert.equal(refused.detail.file, victim);

	// A missing or extra module is a layout change, not a hash mismatch.
	const missing = { ...first.digests };
	delete missing[victim];
	const layout = attestExtension(EXTENSION, entry, { expectedTree: missing });
	assert.equal(layout.ok, false);
	assert.equal(layout.denial, LAUNCH_DENIAL.EXTENSION_TREE_IMPURE);
	assert.deepEqual(layout.detail.expected, Object.keys(first.digests).filter(name => name !== victim).sort());

	const extra = { ...first.digests, "lib/injected.mjs": "0".repeat(64) };
	const extraVerdict = attestExtension(EXTENSION, entry, { expectedTree: extra });
	assert.equal(extraVerdict.ok, false);
	assert.equal(extraVerdict.denial, LAUNCH_DENIAL.EXTENSION_TREE_IMPURE);
	assert.ok(extraVerdict.detail.actual.length === Object.keys(first.digests).length);
});

// ── C3: binding ─────────────────────────────────────────────────────────────

test("binding compares every supplied field and ignores omitted ones", () => {
	const identity = { sessionId: "s1", runtimeInstanceId: "r1", generation: 4, identityState: "ALLOCATED" };
	assert.equal(compareIdentity(identity, {}), null, "an empty expectation must not fail");
	assert.equal(compareIdentity(identity, { sessionId: "s1", runtimeInstanceId: "r1", generation: 4 }), null);
	assert.equal(compareIdentity(identity, { sessionId: "s2" }), "TARGET_SESSION_MISMATCH");
	assert.equal(compareIdentity(identity, { runtimeInstanceId: "r2" }), "TARGET_RUNTIME_MISMATCH");
	assert.equal(compareIdentity(identity, { generation: 5 }), "TARGET_GENERATION_MISMATCH");
	assert.equal(compareIdentity(identity, { identityState: "EPHEMERAL" }), "IDENTITY_STATE_MISMATCH");
});

// ── C5: commit state machine ────────────────────────────────────────────────

test("the state machine distinguishes accepted, executed, attempted and committed", () => {
	const base = { commandAccepted: true, commandDispatched: true, handlerExecuted: true };
	assert.equal(classifyCommitResult({ ...base, commitExecuted: false, committed: false }), COMMIT_STATE.HANDLER_EXECUTED);
	assert.equal(
		classifyCommitResult({ ...base, commitExecuted: true, committed: false, denial: "HANDLER_EXCEPTION" }),
		COMMIT_STATE.DENIED,
	);
	assert.equal(classifyCommitResult({ ...base, commitExecuted: true, committed: false }), COMMIT_STATE.COMMIT_ATTEMPTED);
	assert.equal(classifyCommitResult({ ...base, commitExecuted: true, committed: true }), COMMIT_STATE.COMMITTED);
	assert.equal(
		classifyCommitResult({ commandAccepted: true, commandDispatched: false, handlerExecuted: false, commitExecuted: false, committed: false }),
		COMMIT_STATE.COMMAND_ACCEPTED,
	);
});

test("a denial never reads as a commit, and a landed fence with a denial still reads as committed", () => {
	assert.equal(
		classifyCommitResult({ commandAccepted: true, commitExecuted: false, committed: false, denial: "CONTROLLER_AUTHORITY_ABSENT" }),
		COMMIT_STATE.DENIED,
	);
	// The runtime's own record wins: it fenced, then reported the failure beside it.
	assert.equal(
		classifyCommitResult({ commandAccepted: true, commitExecuted: true, committed: true, denial: "LEDGER_WRITE_FAILED" }),
		COMMIT_STATE.COMMITTED,
	);
});

test("a verified frame reporting the wrong status is refused, with status supplied normally", async () => {
	// Independent review's probe: a correctly signed, correctly correlated frame that
	// answers FAIL to a request for PASS. The first version of the status check gated
	// on `expectation.status`, which normal callers never supply (they pass the bound
	// identity, which has no status field), so the check never ran.
	//
	// This drives `commitFence` with the SAME shape the suite uses: top-level `status`
	// plus `expectation` = bound identity. No transport is needed — the runtime is a
	// stub that returns the frame the client would have verified.
	const runtime = {
		boundIdentity: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 },
		stateDir: "/nonexistent-r3-status-test",
		request: async () => ({
			ok: true,
			result: {
				op: "commit",
				sessionId: "s1",
				runtimeInstanceId: "r1",
				generation: 1,
				status: "FAIL",
				commandAccepted: true,
				commandDispatched: true,
				handlerExecuted: true,
				commitExecuted: true,
				committed: true,
				denial: null,
				ledgerRecorded: true,
			},
		}),
	};
	const wrong = await commitFence(runtime, { status: "PASS", expectation: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 } });
	assert.equal(wrong.state, COMMIT_STATE.FAILED, "a FAIL result must not be accepted for a PASS request");
	assert.equal(wrong.reason, "COMMITTED_STATUS_MISMATCH");
	assert.equal(wrong.observedStatus, "FAIL");
	assert.equal(wrong.expectedStatus, "PASS");

	const right = await commitFence(runtime, { status: "FAIL", expectation: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 } });
	assert.equal(right.state, COMMIT_STATE.COMMITTED, "the matching status must still commit");

	// A caller that contradicts itself has asked for two different commits. Review
	// measured that the first version of this check ran AFTER dispatch, so a
	// contradictory caller could commit before being told its input was invalid.
	// It must now be refused BEFORE anything is sent.
	let dispatched = 0;
	const countingRuntime = { ...runtime, request: async (...args) => { dispatched += 1; return runtime.request(...args); } };
	const contradictory = await commitFence(countingRuntime, {
		status: "PASS",
		expectation: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1, status: "FAIL" },
	});
	assert.equal(contradictory.state, COMMIT_STATE.NOT_REQUESTED);
	assert.equal(contradictory.reason, "CONTRADICTORY_STATUS_EXPECTATION");
	assert.equal(contradictory.dispatched, false);
	assert.equal(dispatched, 0, "a contradictory request must not reach the transport");
});

test("an omitted expectation targets the BOUND identity, so drift is refused", async () => {
	// Review's finding: `commitFence(runtime, {status:"PASS"})` used to send an
	// UNPINNED command, so a controller that bound generation N and then saw the
	// runtime advance would commit N+1 believing it was committing N.
	const bound = { sessionId: "s1", runtimeInstanceId: "r1", generation: 7 };
	const calls = [];
	const runtime = {
		boundIdentity: bound,
		stateDir: "/nonexistent-r3-drift-test",
		request: async (id, expectation, command) => {
			calls.push({ expectation, command });
			return { ok: false, reason: "NO_ANSWER" };
		},
	};
	// Omitting expectation pins the bound generation.
	await commitFence(runtime, { status: "PASS", timeoutMs: 1 });
	assert.match(calls[0].command, /generation=7/, `the bound generation must be pinned: ${calls[0].command}`);
	assert.match(calls[0].command, /session=s1/);
	assert.match(calls[0].command, /runtime=r1/);

	// A target that is not the bound identity is refused before dispatch.
	const driftCalls = [];
	const driftRuntime = { ...runtime, request: async (...args) => { driftCalls.push(args); return { ok: false, reason: "NO_ANSWER" }; } };
	const drifted = await commitFence(driftRuntime, {
		status: "PASS",
		expectation: { sessionId: "s1", runtimeInstanceId: "other-runtime", generation: 7 },
	});
	assert.equal(drifted.state, COMMIT_STATE.NOT_REQUESTED);
	assert.equal(drifted.reason, "TARGET_DRIFT");
	assert.equal(drifted.dispatched, false);
	assert.equal(driftCalls.length, 0, "a drifted target must not reach the transport");

	// A commit with no bound identity and no target cannot be verified.
	const unbound = await commitFence({ boundIdentity: null, stateDir: "/x", request: async () => { throw new Error("must not send"); } }, { status: "PASS" });
	assert.equal(unbound.state, COMMIT_STATE.NOT_REQUESTED);
	assert.equal(unbound.reason, "TARGET_INCOMPLETE");
	assert.deepEqual(unbound.missing.sort(), ["generation", "runtimeInstanceId", "sessionId"]);
});

test("a committed frame whose generation differs from the target is refused", async () => {
	const runtime = {
		boundIdentity: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 },
		stateDir: "/nonexistent-r3-gen-test",
		request: async () => ({
			ok: true,
			result: {
				op: "commit",
				sessionId: "s1",
				runtimeInstanceId: "r1",
				generation: 9,
				status: "PASS",
				commandAccepted: true,
				handlerExecuted: true,
				commitExecuted: true,
				committed: true,
				denial: null,
				ledgerRecorded: true,
			},
		}),
	};
	const verdict = await commitFence(runtime, { status: "PASS", expectation: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 } });
	assert.equal(verdict.state, COMMIT_STATE.FAILED);
	assert.equal(verdict.reason, "COMMITTED_GENERATION_MISMATCH");
});

test("without a prior bind, a signed success naming another session or runtime is refused", async () => {
	// Independent review's exact C4 probe: a complete explicit target, NO prior bind,
	// and a CORRECTLY SIGNED frame naming a different session/runtime with the same
	// generation and status. The first version of this client accepted it as COMMITTED
	// because the correlator expectation was `{}` — the signature proved the frame came
	// from some runtime, not from the one that was asked.
	//
	// This uses the REAL ResultCorrelator and signResultFrame, so the frame would pass
	// every cryptographic check. Only the identity comparison can refuse it.
	const { ResultCorrelator, signResultFrame } = await import("../../integrations/omp/extensions/lib/controller-result.mjs");
	const key = randomBytes(32).toString("hex");
	const wanted = { sessionId: "wanted-session", runtimeInstanceId: "wanted-runtime", generation: 7 };

	const frameBody = identity => ({
		op: "commit",
		...identity,
		status: "PASS",
		commandAccepted: true,
		commandDispatched: true,
		handlerExecuted: true,
		commitExecuted: true,
		committed: true,
		denial: null,
		ledgerRecorded: true,
	});

	const signedRuntimeFor = identity => {
		const correlator = new ResultCorrelator(key);
		return {
			boundIdentity: null,
			stateDir: "/nonexistent-c4-test",
			request: async id => {
				correlator.expect(id, {});
				const verdict = correlator.accept(signResultFrame(key, { requestId: id, result: frameBody(identity) }));
				return verdict.ok ? { ok: true, result: verdict.result } : { ok: false, reason: verdict.reason };
			},
		};
	};

	const otherSession = await commitFence(signedRuntimeFor({ sessionId: "other-session", runtimeInstanceId: "wanted-runtime", generation: 7 }), {
		status: "PASS",
		expectation: wanted,
	});
	assert.equal(otherSession.state, COMMIT_STATE.FAILED, "a signed success naming another session must not be COMMITTED");
	assert.equal(otherSession.reason, "COMMITTED_SESSION_MISMATCH");
	assert.equal(otherSession.ok, false);

	const otherRuntime = await commitFence(signedRuntimeFor({ sessionId: "wanted-session", runtimeInstanceId: "other-runtime", generation: 7 }), {
		status: "PASS",
		expectation: wanted,
	});
	assert.equal(otherRuntime.state, COMMIT_STATE.FAILED, "a signed success naming another runtime must not be COMMITTED");
	assert.equal(otherRuntime.reason, "COMMITTED_RUNTIME_MISMATCH");

	const genuine = await commitFence(signedRuntimeFor(wanted), { status: "PASS", expectation: wanted });
	assert.equal(genuine.state, COMMIT_STATE.COMMITTED, "the genuine identity must still commit");

	// A DENIAL from a different identity must remain observable: refusing to surface it
	// would hide exactly what a controller needs when its target was wrong.
	const denyingCorrelator = new ResultCorrelator(key);
	const denyingRuntime = {
		boundIdentity: null,
		stateDir: "/nonexistent-c4-test",
		request: async id => {
			denyingCorrelator.expect(id, {});
			const verdict = denyingCorrelator.accept(
				signResultFrame(key, {
					requestId: id,
					result: {
						op: "commit",
						sessionId: "other-session",
						runtimeInstanceId: "other-runtime",
						generation: 7,
						status: "PASS",
						commandAccepted: true,
						handlerExecuted: true,
						commitExecuted: false,
						committed: false,
						denial: "TARGET_SESSION_MISMATCH",
						ledgerRecorded: false,
					},
				}),
			);
			return verdict.ok ? { ok: true, result: verdict.result } : { ok: false, reason: verdict.reason };
		},
	};
	const denial = await commitFence(denyingRuntime, { status: "PASS", expectation: wanted });
	assert.equal(denial.state, COMMIT_STATE.DENIED, "a denial must stay observable");
	assert.equal(denial.result.denial, "TARGET_SESSION_MISMATCH");
});

test("a committed frame with ledgerRecorded:false is COMMITTED_UNCONFIRMED, never a clean success", async () => {
	const runtime = {
		boundIdentity: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 },
		stateDir: "/nonexistent-r3-durable-test",
		request: async () => ({
			ok: true,
			result: {
				op: "commit",
				sessionId: "s1",
				runtimeInstanceId: "r1",
				generation: 1,
				status: "PASS",
				commandAccepted: true,
				handlerExecuted: true,
				commitExecuted: true,
				committed: true,
				denial: null,
				ledgerRecorded: false,
				ledgerError: "APPEND_FAILED: EACCES",
			},
		}),
	};
	const verdict = await commitFence(runtime, { status: "PASS", expectation: { sessionId: "s1", runtimeInstanceId: "r1", generation: 1 } });
	assert.equal(verdict.state, COMMIT_STATE.COMMITTED_UNCONFIRMED);
	assert.equal(verdict.ok, false, "a non-durable commit must not be reported as ok");
	assert.match(String(verdict.reason), /COMMITTED_NOT_DURABLE/);
});

test("no input classifies as committed except an observed commit", () => {
	for (const input of [null, undefined, {}, "committed", { committed: "true" }, { committed: 1 }]) {
		assert.notEqual(classifyCommitResult(input), COMMIT_STATE.COMMITTED, `misclassified ${JSON.stringify(input)}`);
	}
});

// ── C6: durable probe ───────────────────────────────────────────────────────

test("the ledger probe answers from the durable record, not from a frame", () => {
	const dir = scratch("probe");
	const stateDir = join(dir, "state");
	mkdirSync(stateDir);
	const key = "b".repeat(64);
	const runtime = { stateDir, controllerRoot: dir, ledgerKey: key };
	const sessionId = "probe-session";
	const expectation = { sessionId, generation: 2 };
	const ledger = join(stateDir, "ledger.jsonl");

	assert.equal(probeLedgerForCommit(runtime, expectation), "NOT_COMMITTED", "an absent ledger proves nothing was committed");

	const allocate = generation =>
		signLedgerRecord(key, { type: "allocate", sessionId, runtimeInstanceId: "r", generation, allocationToken: `t${generation}`, at: 1 });
	const commit = generation =>
		signLedgerRecord(key, {
			type: "commit",
			sessionId,
			runtimeInstanceId: "r",
			generation,
			allocationToken: `t${generation}`,
			status: "PASS",
			requestId: "q",
			at: 2,
		});

	writeFileSync(ledger, `${JSON.stringify(allocate(1))}\n`);
	assert.equal(probeLedgerForCommit(runtime, expectation), "NOT_COMMITTED", "an allocation is not a commit");

	writeFileSync(ledger, `${JSON.stringify(allocate(2))}\n${JSON.stringify(commit(2))}\n`);
	assert.equal(probeLedgerForCommit(runtime, expectation), "COMMITTED");

	// A different generation is not this request's commit.
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 3 }), "NOT_COMMITTED");
});

test("an unreadable ledger is UNKNOWN, never NOT_COMMITTED", () => {
	const dir = scratch("unreadable");
	const stateDir = join(dir, "state");
	mkdirSync(stateDir);
	const sessionId = "probe-session";
	// A DIRECTORY where the ledger file should be: readable as a path, not as a file.
	mkdirSync(join(stateDir, "ledger.jsonl"));
	assert.equal(probeLedgerForCommit({ stateDir, controllerRoot: dir }, { sessionId, generation: 1 }), "UNKNOWN");
});

test("the probe validates AUTHENTICATION, not shape (R4)", () => {
	const dir = scratch("probe-strict");
	const stateDir = join(dir, "state");
	mkdirSync(stateDir);
	const key = "c".repeat(64);
	const runtime = { stateDir, controllerRoot: dir, ledgerKey: key };
	const sessionId = "probe-session";
	const runtimeInstanceId = "rt-1";
	const ledger = join(stateDir, "ledger.jsonl");
	const allocate = signLedgerRecord(key, { type: "allocate", sessionId, runtimeInstanceId, generation: 1, allocationToken: "t", at: 1 });
	const commit = signLedgerRecord(key, {
		type: "commit",
		sessionId,
		runtimeInstanceId,
		generation: 1,
		allocationToken: "t",
		status: "PASS",
		requestId: "q",
		at: 2,
	});

	// AN UNSIGNED RECORD IS NOT EVIDENCE. This is the whole point of R4: a perfectly
	// shaped, correctly attributed line that the controller did not sign cannot
	// produce COMMITTED.
	writeFileSync(ledger, `${JSON.stringify({ type: "commit", sessionId, runtimeInstanceId, generation: 1, status: "PASS" })}\n`);
	assert.equal(
		probeLedgerForCommit(runtime, { sessionId, generation: 1 }),
		"UNKNOWN",
		"an unsigned record must not be read as a commit",
	);

	// A record signed with a DIFFERENT key is equally worthless.
	writeFileSync(
		ledger,
		`${JSON.stringify(signLedgerRecord("d".repeat(64), { type: "commit", sessionId, runtimeInstanceId, generation: 1, status: "PASS", at: 2 }))}\n`,
	);
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1 }), "UNKNOWN", "a wrong-key record must not be believed");

	// A signed record whose FIELDS were edited after signing does not verify.
	writeFileSync(ledger, `${JSON.stringify(allocate)}\n${JSON.stringify({ ...commit, status: "FAIL" })}\n`);
	assert.equal(
		probeLedgerForCommit(runtime, { sessionId, generation: 1, runtimeInstanceId }),
		"NOT_COMMITTED",
		"an edited record must not verify",
	);

	// A well-formed, AUTHENTICATED ledger with an allocation and no commit is a real
	// NOT_COMMITTED.
	writeFileSync(ledger, `${JSON.stringify(allocate)}\n`);
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1 }), "NOT_COMMITTED");

	// The commit is recognised, attributed to this session and runtime.
	writeFileSync(ledger, `${JSON.stringify(allocate)}\n${JSON.stringify(commit)}\n`);
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1, runtimeInstanceId }), "COMMITTED");

	// A commit recorded by a DIFFERENT runtime is not our commit.
	assert.equal(
		probeLedgerForCommit(runtime, { sessionId, generation: 1, runtimeInstanceId: "someone-else" }),
		"UNKNOWN",
		"another runtime's commit must not be reported as ours",
	);

	// A torn FINAL line does not erase the commit before it.
	writeFileSync(ledger, `${JSON.stringify(allocate)}\n${JSON.stringify(commit)}\n{"type":"comm`);
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1, runtimeInstanceId }), "COMMITTED");

	// UNSIGNED JUNK IS IGNORED, NOT FATAL. Treating a junk line as corruption would
	// hand the Agent a denial primitive: append one line, block every commit.
	writeFileSync(ledger, `{not json\n${JSON.stringify(allocate)}\n`);
	assert.equal(
		probeLedgerForCommit(runtime, { sessionId, generation: 1 }),
		"NOT_COMMITTED",
		"an unsigned junk line must not become a denial primitive",
	);

	// A SIGNED record for a foreign session is legitimate (one file per root) and
	// simply not this session's record.
	writeFileSync(
		ledger,
		`${JSON.stringify(signLedgerRecord(key, { type: "allocate", sessionId: "other", runtimeInstanceId: "r", generation: 1, allocationToken: "t", at: 1 }))}\n`,
	);
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1 }), "UNKNOWN");

	// An empty ledger proves nothing either way.
	writeFileSync(ledger, "");
	assert.equal(probeLedgerForCommit(runtime, { sessionId, generation: 1 }), "UNKNOWN");
});
