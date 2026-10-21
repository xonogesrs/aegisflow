#!/usr/bin/env node
// scripts/omp-controller-ledger-worker.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1 — C6.
//
// A single-process worker the cross-process exclusivity tests spawn N of. It does
// exactly one ledger transaction and prints the observed outcome as JSON, so the
// test can compare what several processes independently recorded rather than
// trusting one process's summary of the others.
//
//   node scripts/omp-controller-ledger-worker.mjs allocate <stateDir> <sessionId> <runtimeId> [barrierFile]
//   node scripts/omp-controller-ledger-worker.mjs commit   <stateDir> <sessionId> <runtimeId> <generation> [barrierFile]
//
// `barrierFile` makes every worker wait until that file exists, so N processes
// reach the ledger at the same instant instead of drifting apart during startup.
// Without it the test would measure process startup jitter, not contention.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [mode, stateDir, sessionId, runtimeInstanceId, extra] = process.argv.slice(2);

const moduleRoot = new URL("../integrations/omp/extensions/lib/", import.meta.url);
const { allocateGeneration, recordCommitAndClaimNext } = await import(new URL("runtime-identity.mjs", moduleRoot).href);
const { installControllerCapability } = await import(new URL("controller-capability.mjs", moduleRoot).href);

/**
 * R4: this worker is acting as the CONTROLLER (it is the party that writes the
 * ledger), so it installs the controller's capability before touching it.
 *
 * The key comes from the controller root, exactly as the real client obtains it.
 * A worker without one would be refused — which is the boundary working, and is
 * asserted separately by the no-capability cases.
 *
 * The ledger path is one file per root (`ledger.jsonl`), not per session, because
 * the controller must open it before the session id exists.
 */
const ledgerKeyPath = join(stateDir, "..", "ledger.key");
let capability = { ok: false, denial: "CAPABILITY_ABSENT" };
try {
	const key = readFileSync(ledgerKeyPath, "utf8").trim();
	capability = installControllerCapability({ key });
} catch (error) {
	capability = { ok: false, denial: "CAPABILITY_KEY_UNREADABLE", detail: String(error && error.message ? error.message : error) };
}

// The barrier: wait for a file the parent creates after all workers are alive.
const barrier = mode === "allocate" && extra && extra !== "-" ? extra : mode === "commit" && process.argv[7] ? process.argv[7] : null;
if (barrier) {
	const deadline = Date.now() + 30_000;
	while (!existsSync(barrier) && Date.now() < deadline) {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
	}
}

const env = { OMP_TERMINAL_FENCE_STATE_DIR: stateDir };
const ledgerPath = join(stateDir, "ledger.jsonl");
let output;
if (mode === "allocate") {
	const allocation = allocateGeneration({ sessionId, runtimeInstanceId, env });
	output = {
		mode,
		pid: process.pid,
		runtimeInstanceId,
		identityState: allocation.identityState,
		identityError: allocation.identityError,
		generation: allocation.generation,
		allocationToken: allocation.allocationToken,
		ledgerPath: allocation.ledgerPath,
		capability: capability.ok ? "installed" : capability.denial,
	};
} else if (mode === "commit") {
	const generation = Number(extra);
	const result = recordCommitAndClaimNext({
		ledgerPath,
		sessionId,
		runtimeInstanceId,
		generation,
		status: "PASS",
		requestId: `worker-${process.pid}`,
	});
	output = { mode, pid: process.pid, runtimeInstanceId, generation, ...result };
} else {
	console.error(`usage: node ${process.argv[1]} <allocate|commit> <stateDir> <sessionId> <runtimeId> [generation|barrier] [barrier]`);
	process.exit(2);
}

process.stdout.write(`${JSON.stringify(output)}\n`);
