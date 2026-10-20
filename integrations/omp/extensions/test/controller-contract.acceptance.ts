// Deterministic acceptance harness for
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — R1, R2, R5.
//
// Drives the REAL extension module against a REAL AsyncJobManager with a fake
// `pi` host, and captures the REAL result frames the extension writes to
// process.stdout. No LLM, no timing luck, no hard-coded booleans: every
// assertion reads a frame, a ledger file, or an observed state transition.
//
// Run:  bun test/controller-contract.acceptance.ts
//
// WHY THE IMPORTS BELOW ARE DYNAMIC (the one deliberate exception to a static
// import in this repository): the controller's result key is read from a file
// ONCE, at extension module load, and unlinked immediately. A static import
// hoists above the provisioning block, so the extension would load with no key.
// The specifiers are literals, not runtime-selected plugins.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "aegis-controller-contract-"));
const STATE_DIR = join(ROOT, "state");
const KEY = randomBytes(32).toString("hex");
const KEY_FILE = join(ROOT, "controller-result.key");

// A real controller provisions the key as a file and hands over its path. Mode
// 0600 mirrors what the controller is expected to use.
writeFileSync(KEY_FILE, `${KEY}\n`, { mode: 0o600 });

process.env.OMP_TERMINAL_FENCE_STATE_DIR = STATE_DIR;
process.env.OMP_CONTROLLER_RESULT_KEY_FILE = KEY_FILE;
process.env.OMP_CONTROLLER_RESULT_TRANSPORT = "stdout";

const { AsyncJobManager } = await import("@oh-my-pi/pi-coding-agent/async");
const { default: openPollWaits, waiterStateSnapshot } = await import("../no-poll-waits.js");
const { RESULT_FRAME_TYPE, ResultCorrelator, canonicalJson, signResultFrame, verifyResultFrame } = await import(
	"../lib/controller-result.mjs"
);
const {
	allocateGeneration,
	createRuntimeInstanceId,
	generationAlreadyCommitted,
	recordCommitAndClaimNext,
	verifyOwnership,
	commitRecordState,
} = await import("../lib/runtime-identity.mjs");

interface RunOptions {
	key: string;
	root: string;
	stateDir: string;
	keyFile: string;
}

interface CommitResult {
	op: string;
	sessionId: string;
	runtimeInstanceId: string;
	generation: number;
	identityState: string;
	commandAccepted: boolean;
	commandDispatched: boolean;
	handlerExecuted: boolean;
	commitExecuted: boolean;
	committed: boolean;
	denial: string | null;
	status: string | null;
	targetVerified: boolean;
	jobIds?: string[];
	suppressed?: number;
	fenceAt?: number;
	FENCE_BEFORE_FINAL?: boolean;
	ledgerRecorded?: boolean;
	deliveryFenceSucceeded?: boolean;
	deliveryFenceError?: string | null;
}

interface ResultFrame {
	type: string;
	channel: string;
	requestId: string | null;
	mac: string | null;
	result: CommitResult;
}

interface SessionSnapshot {
	sessionId: string;
	runtimeInstanceId: string;
	identityState: string;
	identityError: string | null;
	generationDurable: boolean;
	ledgerPath: string | null;
	generation: number;
	fenceCalls: number;
	commitDenials: Array<{ denial: string }>;
}

async function runCases(options: RunOptions): Promise<{ results: Record<string, unknown>; failures: string[] }> {
	const OWNER = "Main";
	const COMMIT_COMMAND = "fence-generation";
	const RELEASE_COMMAND = "release-final";
	const REQUEST_TOOL = "request_terminal_fence";
	const AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY";
	const AUTHORITY = "harness-controller-not-provisioning";

	// ── typed views over unvalidated values ─────────────────────────────────────

	interface CommitResult {
		op: string;
		sessionId: string;
		runtimeInstanceId: string;
		generation: number;
		identityState: string;
		commandAccepted: boolean;
		commandDispatched: boolean;
		handlerExecuted: boolean;
		commitExecuted: boolean;
		committed: boolean;
		denial: string | null;
		status: string | null;
		targetVerified: boolean;
		jobIds?: string[];
		suppressed?: number;
		fenceAt?: number;
		FENCE_BEFORE_FINAL?: boolean;
		ledgerRecorded?: boolean;
	}

	interface ResultFrame {
		type: string;
		channel: string;
		requestId: string | null;
		mac: string | null;
		result: CommitResult;
	}

	interface SessionSnapshot {
		sessionId: string;
		runtimeInstanceId: string;
		identityState: string;
		identityError: string | null;
		generationDurable: boolean;
		ledgerPath: string | null;
		generation: number;
		fenceCalls: number;
		commitDenials: Array<{ denial: string }>;
	}

	/**
	 * The frame is produced by the module under test; this assertion is the test
	 * seam. Untrusted frames are validated by `verifyResultFrame`, not here.
	 */
	function asFrame(value: unknown): ResultFrame {
		return value as ResultFrame;
	}

	// ── frame capture ───────────────────────────────────────────────────────────
	// The extension writes frames with process.stdout.write. Capture them so the
	// assertions read exactly the bytes a controller would receive.

	const captured: string[] = [];
	const realWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: unknown) => {
		captured.push(typeof chunk === "string" ? chunk : String(chunk));
		return true;
	}) as typeof process.stdout.write;

	function drainFrames(): { frames: ResultFrame[]; unparsed: string[] } {
		const lines = captured.splice(0, captured.length);
		const frames: ResultFrame[] = [];
		const unparsed: string[] = [];
		for (const line of lines) {
			for (const part of line.split("\n")) {
				if (!part.trim()) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(part);
				} catch {
					unparsed.push(part);
					continue;
				}
				if (parsed !== null && typeof parsed === "object" && "type" in parsed && parsed.type === RESULT_FRAME_TYPE) {
					frames.push(asFrame(parsed));
				}
			}
		}
		return { frames, unparsed };
	}

	function resultFrames(): ResultFrame[] {
		return drainFrames().frames;
	}

	// ── fake host ───────────────────────────────────────────────────────────────

	interface FakeHost {
		session: {
			sessionManager: { getSessionId: () => string };
			asyncJobManager: unknown;
			ui: { notify: (...args: unknown[]) => void };
		};
		pi: { logger: { warn: (...args: unknown[]) => void } };
		tools: Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>;
		commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
		logs: unknown[];
		emit: (event: string, payload: unknown) => Promise<unknown[]>;
	}

	function makeHost(sessionId: string, manager: AsyncJobManager | undefined): FakeHost {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const logs: unknown[] = [];
		const session = {
			sessionManager: { getSessionId: () => sessionId },
			asyncJobManager: manager,
			ui: { notify: (...args: unknown[]) => logs.push(["notify", ...args]) },
		};
		const pi = {
			logger: { warn: (...args: unknown[]) => logs.push(args) },
			zod: {
				object: (shape: unknown) => ({ shape }),
				enum: (values: unknown) => ({ enum: values }),
				string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
			},
			pi: {
				AgentRegistry: {
					global: () => ({ list: () => [{ id: OWNER, session: manager === undefined ? null : session }] }),
				},
			},
			on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
				if (!handlers.has(event)) handlers.set(event, []);
				handlers.get(event)?.push(fn);
			},
			registerTool: (def: { name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }) =>
				tools.set(def.name, def),
			registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, { handler: options.handler }),
		};
		openPollWaits(pi);
		return {
			session,
			pi,
			tools,
			commands,
			logs,
			emit: async (event: string, payload: unknown) => {
				const out: unknown[] = [];
				for (const fn of handlers.get(event) ?? []) out.push(await fn(payload, session));
				return out;
			},
		};
	}

	function newManager() {
		const delivered: string[] = [];
		const manager = new AsyncJobManager({
			onJobComplete: () => {
				throw new Error("unowned delivery reached the default sink");
			},
		});
		manager.registerDeliverySink(OWNER, (jobId: string) => {
			delivered.push(jobId);
		});
		return { manager, delivered };
	}

	/** A host whose session owns one gated background job, announced as a bash job. */
	async function hostWithGatedJob(sessionId: string) {
		const { manager, delivered } = newManager();
		const host = makeHost(sessionId, manager);
		const gate = Promise.withResolvers<void>();
		const jobId = manager.register(
			"bash",
			"active task work",
			async () => {
				await gate.promise;
				return "ACTIVE_JOB_DONE";
			},
			{ ownerId: OWNER },
		);
		await host.emit("tool_result", {
			toolName: "bash",
			content: [{ type: "text", text: `Backgrounded as job ${jobId}; result will be delivered automatically.` }],
			isError: false,
		});
		return { host, manager, jobId, delivered, release: () => gate.resolve() };
	}

	function snapshotFor(sessionId: string): SessionSnapshot {
		const found = waiterStateSnapshot().find(entry => entry.sessionId === sessionId);
		if (!found) throw new Error(`no state for session ${sessionId}`);
		return found as SessionSnapshot;
	}

	async function commit(host: FakeHost, args: string) {
		const command = host.commands.get(COMMIT_COMMAND);
		if (!command) throw new Error("commit command is not registered");
		await command.handler(args, host.session);
	}

	const ledgerEnv = () => ({ ...process.env, OMP_TERMINAL_FENCE_STATE_DIR: options.stateDir });

	const results: Record<string, unknown> = {};
	const failures: string[] = [];

	function check(name: string, fn: () => void) {
		try {
			fn();
		} catch (error) {
			failures.push(`${name}: ${(error as Error).message}`);
			throw error;
		}
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// R1 — runtime / generation identity
	// ═══════════════════════════════════════════════════════════════════════════

	// ── R1_T1 — same session, same runtime, correct generation ──────────────────
	{
		const sessionId = "r1-t1";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const before = snapshotFor(sessionId);
			drainFrames();
			await commit(
				host,
				`PASS session=${sessionId} runtime=${before.runtimeInstanceId} generation=${before.generation} request=r1-t1`,
			);
			const frames = resultFrames();
			assert.equal(frames.length, 1, "exactly one result frame must be emitted");
			const [frame] = frames;
			assert.equal(frame.result.committed, true, "the pinned target must commit");
			assert.equal(frame.result.targetVerified, true);
			assert.equal(frame.result.runtimeInstanceId, before.runtimeInstanceId);
			assert.equal(frame.result.generation, before.generation);
			assert.equal(frame.requestId, "r1-t1");
			results.R1_T1 = "COMMITTED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T2 — same session, new runtime, generation must not repeat ───────────
	{
		const sessionId = "r1-t2";
		const first = await hostWithGatedJob(sessionId);
		process.env[AUTHORITY_ENV] = AUTHORITY;
		let firstGeneration: number;
		try {
			const before = snapshotFor(sessionId);
			firstGeneration = before.generation;
			await commit(first.host, `PASS session=${sessionId} runtime=${before.runtimeInstanceId} generation=${before.generation}`);
		} finally {
			delete process.env[AUTHORITY_ENV];
			first.release();
		}
		// A second runtime process is simulated by allocating again with a different
		// runtime instance id — exactly what a restarted process does at load.
		const second = allocateGeneration({
			sessionId,
			runtimeInstanceId: createRuntimeInstanceId(),
			env: ledgerEnv(),
		});
		check("R1_T2", () => {
			assert.equal(second.identityState, "ALLOCATED", "the ledger must allocate a generation");
			assert.equal(second.generationDurable, true);
			assert.notEqual(second.generation, firstGeneration, "a restarted runtime must not reuse the committed generation");
			assert.ok((second.generation ?? 0) > firstGeneration, "generations must move forward across restarts");
			assert.notEqual(second.runtimeInstanceId, snapshotFor(sessionId).runtimeInstanceId, "runtime identities must differ");
		});
		results.R1_T2 = { firstGeneration, secondGeneration: second.generation, distinctRuntime: true };
	}

	// ── R1_T3 — wrong runtime identity is refused before the fence ──────────────
	{
		const sessionId = "r1-t3";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, delivered, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			drainFrames();
			await commit(host, `PASS session=${sessionId} runtime=not-this-runtime generation=${state.generation}`);
			const [frame] = resultFrames();
			assert.equal(frame.result.committed, false);
			assert.equal(frame.result.denial, "TARGET_RUNTIME_MISMATCH");
			assert.equal(snapshotFor(sessionId).fenceCalls, 0, "a wrong target must not fence anything");
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
		release();
		await manager.getJob(jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 4000 });
		assert.ok(delivered.includes(jobId), "a refused target must leave the delivery path alive");
		results.R1_T3 = "DENIED";
	}

	// ── R1_T4 — wrong generation is refused before the fence ────────────────────
	{
		const sessionId = "r1-t4";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, delivered, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation + 7}`);
			const [frame] = resultFrames();
			assert.equal(frame.result.committed, false);
			assert.equal(frame.result.denial, "TARGET_GENERATION_MISMATCH");
			assert.equal(snapshotFor(sessionId).fenceCalls, 0);
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
		release();
		await manager.getJob(jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 4000 });
		assert.ok(delivered.includes(jobId));
		results.R1_T4 = "DENIED";
	}

	// ── R1_T5 — duplicate commit does not produce a second valid commit ─────────
	{
		const sessionId = "r1-t5";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			const generation = state.generation;
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${generation} request=dup-1`);
			drainFrames();
			// The same generation again: the fence already advanced, so this must be a
			// mismatch rather than a second commit of the same generation.
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${generation} request=dup-2`);
			const [frame] = resultFrames();
			assert.equal(frame.result.committed, false);
			assert.ok(
				frame.result.denial === "TARGET_GENERATION_MISMATCH" ||
					frame.result.denial === "GENERATION_ALREADY_COMMITTED",
				`duplicate commit must be refused, saw ${frame.result.denial}`,
			);
			assert.equal(snapshotFor(sessionId).fenceCalls, 1, "exactly one fence may be committed");
			// The ledger refuses a re-commit of the recorded generation outright, even
			// when the target check is bypassed — the durable half of the same rule.
			assert.equal(
				generationAlreadyCommitted(snapshotFor(sessionId).ledgerPath, generation),
				true,
				"the ledger must record the committed generation",
			);
			results.R1_T5 = "SINGLE_COMMIT";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T6 — resume after process exit: identity cannot be confused ──────────
	{
		const sessionId = "r1-t6";
		const runtimeA = createRuntimeInstanceId();
		const allocationA = allocateGeneration({ sessionId, runtimeInstanceId: runtimeA, env: ledgerEnv() });
		recordCommitAndClaimNext({
			ledgerPath: allocationA.ledgerPath,
			sessionId,
			runtimeInstanceId: runtimeA,
			generation: allocationA.generation ?? 0,
			status: "PASS",
			requestId: "resume-1",
		});
		const runtimeB = createRuntimeInstanceId();
		const allocationB = allocateGeneration({ sessionId, runtimeInstanceId: runtimeB, env: ledgerEnv() });
		check("R1_T6", () => {
			assert.notEqual(runtimeA, runtimeB);
			assert.equal(allocationB.identityState, "ALLOCATED");
			assert.ok((allocationB.generation ?? 0) > (allocationA.generation ?? 0), "resume must allocate a fresh generation");
			assert.equal(generationAlreadyCommitted(allocationB.ledgerPath, allocationB.generation ?? 0), false);
			assert.equal(generationAlreadyCommitted(allocationB.ledgerPath, allocationA.generation ?? 0), true);
		});
		results.R1_T6 = { a: allocationA.generation, b: allocationB.generation, distinctRuntimes: true };
	}

	// ── R1_T7 — a corrupt ledger fails closed instead of restarting at 1 ────────
	{
		const sessionId = "r1-t7";
		const first = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		writeFileSync(first.ledgerPath ?? "", "{not json\n", "utf8");
		const allocation = allocateGeneration({
			sessionId,
			runtimeInstanceId: createRuntimeInstanceId(),
			env: ledgerEnv(),
		});
		check("R1_T7", () => {
			assert.equal(allocation.identityState, "CORRUPT");
			assert.equal(allocation.generation, null, "a corrupt ledger must not yield a usable generation");
			assert.match(String(allocation.identityError), /MALFORMED_LINE/);
		});

		// …and the extension refuses to commit on that state.
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			assert.equal(state.identityState, "CORRUPT");
			await commit(host, "PASS");
			const [frame] = resultFrames();
			assert.equal(frame.result.committed, false);
			assert.equal(frame.result.denial, "IDENTITY_LEDGER_CORRUPT");
			assert.equal(snapshotFor(sessionId).fenceCalls, 0);
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
		results.R1_T7 = "FAIL_CLOSED";
	}

	// ── R1_T7b — a structurally incomplete record is corruption, not history ────
	// Measured in review: a ledger holding only `{"type":"allocate","generation":7}`
	// was accepted and yielded generation 8.
	{
		const sessionId = "r1-t7b";
		const first = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		writeFileSync(
			first.ledgerPath ?? "",
			`${JSON.stringify({ type: "allocate", generation: 7 })}\n`,
			"utf8",
		);
		const allocation = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		check("R1_T7b", () => {
			assert.equal(allocation.identityState, "CORRUPT", "a record without session/runtime identity is corruption");
			assert.equal(allocation.generation, null);
		});
		results.R1_T7b = "INCOMPLETE_RECORD_REFUSED";
	}

	// ── R1_T7c — a foreign session's record is corruption ──────────────────────
	{
		const sessionId = "r1-t7c";
		const first = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		writeFileSync(
			first.ledgerPath ?? "",
			`${JSON.stringify({ type: "allocate", sessionId: "someone-else", runtimeInstanceId: "rt-x", generation: 4 })}\n`,
			"utf8",
		);
		const allocation = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		check("R1_T7c", () => {
			assert.equal(allocation.identityState, "CORRUPT");
			assert.match(String(allocation.identityError), /FOREIGN_SESSION/);
		});
		results.R1_T7c = "FOREIGN_SESSION_REFUSED";
	}

	// ── R1_T7d — generation range exhaustion fails closed ──────────────────────
	// Measured in review: a ledger ending at MAX_SAFE_INTEGER produced a generation
	// that could not be incremented, so a fence left the number unchanged.
	{
		const sessionId = "r1-t7d";
		const first = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		writeFileSync(
			first.ledgerPath ?? "",
			`${JSON.stringify({
				type: "allocate",
				sessionId,
				runtimeInstanceId: "rt-exhausted",
				generation: Number.MAX_SAFE_INTEGER,
			})}\n`,
			"utf8",
		);
		const allocation = allocateGeneration({ sessionId, runtimeInstanceId: createRuntimeInstanceId(), env: ledgerEnv() });
		check("R1_T7d", () => {
			assert.equal(allocation.identityState, "EXHAUSTED");
			assert.equal(allocation.generation, null, "an unrepresentable next generation must not be handed out");
		});
		results.R1_T7d = "EXHAUSTION_REFUSED";
	}

	// ── R1_T7e — a configured but unusable state dir is not ephemeral ──────────
	// Measured in review: with the configured path occupied by an ordinary file,
	// allocation silently fell back to EPHEMERAL and the fence succeeded.
	{
		const sessionId = "r1-t7e";
		const blocker = join(options.root, "state-dir-is-a-file");
		writeFileSync(blocker, "not a directory\n", "utf8");
		const allocation = allocateGeneration({
			sessionId,
			runtimeInstanceId: createRuntimeInstanceId(),
			env: { ...process.env, OMP_TERMINAL_FENCE_STATE_DIR: blocker },
		});
		check("R1_T7e", () => {
			assert.equal(allocation.identityState, "UNWRITABLE", "a configured-but-unusable dir must not become ephemeral");
			assert.equal(allocation.generation, null);
			assert.equal(allocation.generationDurable, false);
		});
		results.R1_T7e = "UNUSABLE_DIR_REFUSED";
	}

	// ── R1_T7f — ownership is re-verified against the ledger before the fence ──
	// Measured in review: a peer's conflicting allocation appended AFTER the
	// allocation-time check did not stop the original runtime committing.
	{
		const sessionId = "r1-t7f";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			// The host's own state is the one that will commit; take its identity
			// BEFORE tampering, so the peer's claim targets the real generation.
			const before = snapshotFor(sessionId);
			assert.equal(before.identityState, "ALLOCATED");
			assert.ok(before.ledgerPath, "the host must have a ledger to tamper with");
			appendFileSync(
				before.ledgerPath,
				`${JSON.stringify({
					type: "allocate",
					sessionId,
					runtimeInstanceId: "peer-runtime",
					generation: before.generation,
					allocationToken: "peer-token",
				})}\n`,
				"utf8",
			);

			const ownership = verifyOwnership({
				ledgerPath: before.ledgerPath,
				sessionId,
				generation: before.generation,
				allocationToken: before.allocationToken,
			});
			check("R1_T7f-ownership", () => {
				assert.equal(ownership.owned, false, "a doubly-claimed generation is not owned by either side");
				assert.match(String(ownership.reason), /CLAIMED_2_TIMES/);
			});

			// …and the extension refuses to commit on it.
			drainFrames();
			await commit(host, "PASS");
			const [frame] = resultFrames();
			assert.equal(frame.result.committed, false, "a lost-ownership commit must be refused");
			assert.equal(frame.result.denial, "GENERATION_OWNERSHIP_LOST");
			assert.equal(snapshotFor(sessionId).fenceCalls, 0);
			results.R1_T7f = "OWNERSHIP_REVERIFIED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T7g — the automatic fence leg advances the durable identity ─────────
	// Measured in review: `agent_end` fenced and incremented the live generation
	// without claiming it, leaving identityState ALLOCATED for an unowned number.
	{
		const sessionId = "r1-t7g";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, release } = await hostWithGatedJob(sessionId);
		try {
			const before = snapshotFor(sessionId);
			assert.equal(before.identityState, "ALLOCATED");
			// Drive the automatic leg: a terminal agent_end with a bound job pending.
			release();
			await manager.getJob(jobId)?.promise;
			await host.emit("agent_end", { willContinue: false });
			const after = snapshotFor(sessionId);
			check("R1_T7g", () => {
				assert.ok(after.generation > before.generation, "the automatic leg must advance the generation");
				assert.equal(after.identityState, "ALLOCATED", "the advanced generation must be durably claimed");
				assert.equal(after.generationDurable, true);
				const ownership = verifyOwnership({
					ledgerPath: after.ledgerPath,
					sessionId,
					generation: after.generation,
					allocationToken: after.allocationToken,
				});
				assert.equal(ownership.owned, true, `the live generation must be owned: ${ownership.reason}`);
			});
			results.R1_T7g = "AUTO_LEG_DURABLE";
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
	}

	// ── R1_T7h — malformed identity tokens are refused, not silently dropped ───
	{
		const sessionId = "r1-t7h";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			for (const args of ["PASS generation=1junk", "PASS generation=", "PASS runtime=", "PASS generation=0"]) {
				drainFrames();
				await commit(host, args);
				const [frame] = resultFrames();
				check(`R1_T7h/${args}`, () => {
					assert.equal(frame.result.committed, false, `${args} must not commit`);
					assert.equal(frame.result.denial, "MALFORMED_IDENTITY_TARGET", args);
					assert.equal(frame.result.commitExecuted, false, `${args} must not claim the commit was attempted`);
				});
			}
			assert.equal(snapshotFor(sessionId).fenceCalls, 0, "no malformed target may fence anything");
			results.R1_T7h = "MALFORMED_REFUSED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T7j — a failed advance never writes a second commit record ──────────
	// Reproduced in independent review: after the durable advance failed, the
	// automatic `agent_end` leg fenced again and appended a duplicate `commit` for
	// a generation a peer had committed. The ledger is the durable statement of
	// what committed; two commit records for one generation is a corrupted
	// statement even though the local fence was legitimate.
	{
		const sessionId = "r1-t7j";
		const runtimeA = createRuntimeInstanceId();
		const allocationA = allocateGeneration({ sessionId, runtimeInstanceId: runtimeA, env: ledgerEnv() });
		assert.equal(allocationA.identityState, "ALLOCATED");
		// A peer commits this generation first.
		const peer = recordCommitAndClaimNext({
			ledgerPath: allocationA.ledgerPath,
			sessionId,
			runtimeInstanceId: "peer-runtime",
			generation: allocationA.generation ?? 0,
			status: "PASS",
		});
		assert.equal(peer.error, null, "the peer's commit must succeed");

		// This runtime tries to record the same commit: refused, nothing appended.
		const duplicate = recordCommitAndClaimNext({
			ledgerPath: allocationA.ledgerPath,
			sessionId,
			runtimeInstanceId: runtimeA,
			generation: allocationA.generation ?? 0,
			status: "PASS",
		});
		check("R1_T7j", () => {
			assert.match(String(duplicate.error), /ALREADY_COMMITTED/);
			const lines = readFileSync(allocationA.ledgerPath ?? "", "utf8")
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line));
			const commits = lines.filter(
				record => record.type === "commit" && record.generation === allocationA.generation,
			);
			assert.equal(commits.length, 1, "exactly one commit record may exist per generation");
			assert.equal(commits[0].runtimeInstanceId, "peer-runtime");
		});
		results.R1_T7j = "NO_DUPLICATE_COMMIT_RECORD";
	}

	// ── R1_T7i — the release command validates an explicit generation whole ─────
	// Same class as the commit target: `parseInt("1junk")` is 1, which would
	// release a generation the caller never named.
	{
		const sessionId = "r1-t7i";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			await commit(host, "PASS");
			for (const bad of ["1junk", "1.5", "-1", "abc"]) {
				drainFrames();
				const releaseCommand = host.commands.get(RELEASE_COMMAND);
				if (!releaseCommand) throw new Error("release command is not registered");
				await releaseCommand.handler(bad, host.session);
				const [frame] = resultFrames();
				check(`R1_T7i/${bad}`, () => {
					assert.ok(frame, `release ${bad} must still answer on the signed channel`);
					assert.equal(frame.result.released, false, `${bad} must not release`);
					assert.equal(frame.result.denial, "MALFORMED_GENERATION");
				});
			}
			results.R1_T7i = "RELEASE_GENERATION_VALIDATED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T7k — the automatic leg refuses a generation it does not own ────────
	// Reproduced in independent review: with the durable identity UNWRITABLE, the
	// `agent_end` leg fenced anyway, so a runtime fenced and committed a
	// generation it could not prove was its own.
	{
		const sessionId = "r1-t7k";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, release } = await hostWithGatedJob(sessionId);
		try {
			const before = snapshotFor(sessionId);
			// Make the live generation doubly-claimed, as a peer race would.
			appendFileSync(
				before.ledgerPath,
				`${JSON.stringify({
					type: "allocate",
					sessionId,
					runtimeInstanceId: "peer-runtime",
					generation: before.generation,
					allocationToken: "peer-token",
				})}\n`,
				"utf8",
			);
			release();
			await manager.getJob(jobId)?.promise;
			await host.emit("agent_end", { willContinue: false });
			const after = snapshotFor(sessionId);
			check("R1_T7k", () => {
				assert.equal(after.fenceCalls, 0, "an unowned generation must not be fenced by the automatic leg");
				assert.equal(after.generation, before.generation, "the generation must not advance");
			});
			results.R1_T7k = "AUTO_LEG_OWNERSHIP_CHECKED";
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
	}

	// ── R1_T7l — a denial after an earlier commit never reports committed:true ─
	// Reproduced in independent review: `landed` was inferred from "a fence
	// exists", so a later denial whose logging threw reported the EARLIER
	// generation as committed. The inference must be a delta for this call.
	{
		const sessionId = "r1-t7l";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			// One real commit, so a fence exists in `state.fenced`.
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation}`);
			assert.equal(snapshotFor(sessionId).fenceCalls, 1);

			// Now a denial that throws while logging inside the primitive.
			const logger = host.pi.logger as { warn: (...args: unknown[]) => void };
			const realWarn = logger.warn.bind(logger);
			logger.warn = (message: unknown) => {
				if (message === "no-poll-waits: terminal fence commit denied") throw new Error("logger failure");
				realWarn(message);
			};
			drainFrames();
			// Wrong generation: a denial, not a commit.
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=999 request=r1-t7l`);
			const [frame] = resultFrames();
			check("R1_T7l", () => {
				assert.ok(frame, "a denial must still produce a frame");
				assert.equal(frame.result.committed, false, "an earlier fence must not make this denial look committed");
				assert.equal(snapshotFor(sessionId).fenceCalls, 1, "no second fence may land");
			});
			results.R1_T7l = "NO_STALE_LANDED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T7m — the release command honors its identity pins ──────────────────
	// Measured in independent review: `/release-final session=foreign
	// runtime=foreign generation=999` released the live generation anyway. A
	// release mutates `finalReleaseAt`, so a pin mismatch must be refused BEFORE
	// the mutation, not reported after it.
	{
		const sessionId = "r1-t7m";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation}`);
			const releaseCommand = host.commands.get(RELEASE_COMMAND);
			if (!releaseCommand) throw new Error("release command is not registered");
			for (const [args, denial] of [
				["session=foreign", "TARGET_SESSION_MISMATCH"],
				["runtime=foreign", "TARGET_RUNTIME_MISMATCH"],
				[`generation=${state.generation + 99}`, "TARGET_GENERATION_MISMATCH"],
			] as const) {
				drainFrames();
				await releaseCommand.handler(args, host.session);
				const [frame] = resultFrames();
				check(`R1_T7m/${args}`, () => {
					assert.ok(frame, `${args} must answer on the signed channel`);
					assert.equal(frame.result.released, false, `${args} must not release`);
					assert.equal(frame.result.denial, denial);
				});
			}
			// Nothing was released, so the real generation is still releasable.
			drainFrames();
			await releaseCommand.handler(`generation=${state.generation}`, host.session);
			const [frame] = resultFrames();
			check("R1_T7m/matching", () => {
				assert.equal(frame.result.released, true, "a matching pin must release");
			});
			results.R1_T7m = "RELEASE_PINS_ENFORCED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R1_T8 — an ungoverned process keeps the legacy behaviour and no ledger ──
	{
		const sessionId = "r1-t8";
		const { host, release } = await hostWithGatedJob(sessionId);
		delete process.env[AUTHORITY_ENV];
		const state = snapshotFor(sessionId);
		check("R1_T8", () => {
			assert.equal(state.identityState, "EPHEMERAL", "no capability must mean no ledger");
			assert.equal(state.ledgerPath, null, "an ungoverned process must not open a ledger");
			assert.equal(state.generation, 1);
			assert.equal(state.generationDurable, false);
		});
		drainFrames();
		await commit(host, "PASS");
		const [frame] = resultFrames();
		assert.equal(frame.result.committed, false);
		assert.equal(frame.result.denial, "CONTROLLER_AUTHORITY_ABSENT");
		release();
		results.R1_T8 = "UNMANAGED_UNCHANGED";
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// R2 — structured commit result
	// ═══════════════════════════════════════════════════════════════════════════

	// ── R2_T1 — the result frame separates transport success from commit success
	{
		const sessionId = "r2-t1";
		const { host, release } = await hostWithGatedJob(sessionId);
		delete process.env[AUTHORITY_ENV];
		await commit(host, "PASS");
		const result = resultFrames()[0].result;
		check("R2_T1", () => {
			assert.equal(result.commandAccepted, true);
			assert.equal(result.commandDispatched, true);
			assert.equal(result.handlerExecuted, true);
			assert.equal(result.commitExecuted, false, "no commit may be claimed when authority is absent");
			assert.equal(result.committed, false);
			assert.equal(result.denial, "CONTROLLER_AUTHORITY_ABSENT");
			assert.equal(typeof result.sessionId, "string");
			assert.equal(typeof result.runtimeInstanceId, "string");
			assert.equal(typeof result.generation, "number");
		});
		release();
		results.R2_T1 = "DISTINGUISHED";
	}

	// ── R2_T2 — a committed result carries the real numbers ─────────────────────
	{
		const sessionId = "r2-t2";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, delivered, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation}`);
			const result = resultFrames()[0].result;
			check("R2_T2", () => {
				assert.equal(result.committed, true);
				assert.equal(result.commitExecuted, true);
				assert.equal(result.status, "PASS");
				assert.deepEqual(result.jobIds, [jobId], "the result must name the jobs it invalidated");
				assert.equal(typeof result.fenceAt, "number");
				assert.equal(result.FENCE_BEFORE_FINAL, true);
				assert.equal(result.ledgerRecorded, true, "the durable commit record must be written");
			});
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
		release();
		await manager.getJob(jobId)?.promise;
		await manager.drainDeliveries({ timeoutMs: 4000 });
		assert.equal(delivered.includes(jobId), false, "the fence the result reports must actually silence the job");
		results.R2_T2 = "REAL_NUMBERS";
	}

	// ── R2_T3 — a manager failure is observable, never a silent success ─────────
	// `committed` is the TERMINAL TRANSITION fact. Delivery invalidation is a
	// separate outcome, and `suppressed` cannot carry it: it counts QUEUED
	// deliveries dropped, which is normally 0 even on complete success. A
	// controller must therefore be able to read the failure from the frame.
	{
		const sessionId = "r2-t3";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			const realManager = host.session.asyncJobManager;
			host.session.asyncJobManager = {
				acknowledgeDeliveries() {
					throw new Error("simulated manager failure");
				},
				getRunningJobs: () => [],
				getDeliveryState: () => ({ queued: 0 }),
				isDeliverySuppressed: () => false,
			};
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation}`);
			host.session.asyncJobManager = realManager;
			const result = resultFrames()[0].result;
			check("R2_T3", () => {
				// The terminal transition really did commit…
				assert.equal(result.committed, true);
				assert.equal(result.commitExecuted, true);
				// …and the frame says, in a field, that invalidation failed.
				assert.equal(result.deliveryFenceSucceeded, false, "the frame must report the failed invalidation");
				assert.match(String(result.deliveryFenceError), /simulated manager failure/);
				// The counter cannot express it, which is why the field exists.
				assert.equal(result.suppressed, 0);
			});
			const failureLog = host.logs.find(
				entry => Array.isArray(entry) && entry[0] === "no-poll-waits: delivery fence failed",
			);
			assert.ok(failureLog, "a manager failure must be logged, not swallowed silently");
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
		results.R2_T3 = "FAILURE_IN_FIELD";
	}

	// ── R2_T3b — a successful invalidation is reported as success ──────────────
	{
		const sessionId = "r2-t3b";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, manager, jobId, delivered, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation}`);
			const result = resultFrames()[0].result;
			check("R2_T3b", () => {
				assert.equal(result.committed, true);
				assert.equal(result.deliveryFenceSucceeded, true);
				assert.equal(result.deliveryFenceError, null);
			});
			release();
			await manager.getJob(jobId)?.promise;
			await manager.drainDeliveries({ timeoutMs: 4000 });
			assert.equal(delivered.includes(jobId), false, "a reported success must mean the delivery really was suppressed");
			results.R2_T3b = "SUCCESS_MEANS_SUPPRESSED";
		} finally {
			delete process.env[AUTHORITY_ENV];
		}
	}


	// ── R2_T3c — a throw AFTER the fence reports the fence that actually landed ─
	// Reproduced in independent review: a logger throwing after the commit applied
	// produced `committed:false` for a generation that was committed — the same
	// lie in the other direction — and lost the result frame entirely.
	{
		const sessionId = "r2-t3c";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			// A logger that throws on the post-commit line only: exactly the shape
			// that used to lose the frame after the fence had already applied.
			const logger = host.pi.logger as { warn: (...args: unknown[]) => void };
			const realWarn = logger.warn.bind(logger);
			logger.warn = (message: unknown) => {
				// Thrown from INSIDE the commit primitive, after the fence applied.
				if (message === "no-poll-waits: terminal transition committed in order") {
					throw new Error("logger failure");
				}
				realWarn(message);
			};
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation} request=r2-t3c`);
			const frames = resultFrames();
			const after = snapshotFor(sessionId);
			check("R2_T3c", () => {
				assert.equal(frames.length, 1, "a post-fence logger failure must still produce a result frame");
				const result = frames[0].result;
				assert.equal(after.fenceCalls, 1, "the fence really landed");
				assert.equal(result.committed, true, "the frame must report the fence that landed");
				assert.equal(result.commitExecuted, true);
				assert.equal(result.generation, state.generation, "the committed generation, not the advanced one");
			});
			results.R2_T3c = "TRUTH_AFTER_FENCE";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R2_T3d — `ledgerRecorded` is false when no ledger exists ───────────────
	// Measured in independent review: in EPHEMERAL mode there is no ledger and no
	// error, so `ledgerRecorded: ledgerError === null` reported `true` for a commit
	// nothing durable recorded.
	{
		const sessionId = "r2-t3d";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const savedStateDir = process.env.OMP_TERMINAL_FENCE_STATE_DIR;
		delete process.env.OMP_TERMINAL_FENCE_STATE_DIR;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			assert.equal(state.identityState, "EPHEMERAL", "the fixture must be ungoverned-identity");
			assert.equal(state.ledgerPath, null);
			drainFrames();
			await commit(host, "PASS");
			const [frame] = resultFrames();
			check("R2_T3d", () => {
				assert.equal(frame.result.committed, true, "an ephemeral commit still lands locally");
				assert.equal(frame.result.ledgerRecorded, false, "no ledger means nothing durable was recorded");
				assert.equal(frame.result.ledgerError, "NO_LEDGER_EPHEMERAL");
			});
			results.R2_T3d = "EPHEMERAL_NOT_RECORDED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			// Restore the provisioned state dir: deleting it here made every later
			// case run EPHEMERAL, which is a test-isolation leak, not a scenario.
			if (savedStateDir !== undefined) process.env.OMP_TERMINAL_FENCE_STATE_DIR = savedStateDir;
			release();
		}
	}

	// ── R2_T3e — a denial whose logging throws is still reported as that denial ─
	// Measured in independent review: an authority denial threw while logging, and
	// the frame claimed `commitExecuted:true` with `fenceCalls:0`, contradicting
	// the denial the primitive had already built.
	{
		const sessionId = "r2-t3e";
		const { host, release } = await hostWithGatedJob(sessionId);
		delete process.env[AUTHORITY_ENV];
		try {
			const logger = host.pi.logger as { warn: (...args: unknown[]) => void };
			const realWarn = logger.warn.bind(logger);
			logger.warn = (message: unknown) => {
				if (message === "no-poll-waits: terminal fence commit denied") throw new Error("logger failure");
				realWarn(message);
			};
			drainFrames();
			await commit(host, "PASS");
			const [frame] = resultFrames();
			check("R2_T3e", () => {
				assert.ok(frame, "a denial must still produce a frame when its logging throws");
				assert.equal(frame.result.denial, "CONTROLLER_AUTHORITY_ABSENT", "the real denial must be reported");
				assert.equal(frame.result.committed, false);
				assert.equal(frame.result.commitExecuted, false, "a pre-fence denial did not execute a commit");
				assert.match(String(frame.result.handlerException), /logger failure/);
				assert.equal(snapshotFor(sessionId).fenceCalls, 0);
			});
			results.R2_T3e = "DENIAL_PRESERVED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R2_T3f — a durable commit record survives a failed next-generation claim
	// Measured in independent review with an injected write failure on the claim
	// append: `commit:g1` was on disk while the frame said `ledgerRecorded:false`.
	{
		const sessionId = "r2-t3f";
		const runtimeA = createRuntimeInstanceId();
		const allocationA = allocateGeneration({ sessionId, runtimeInstanceId: runtimeA, env: ledgerEnv() });
		const result = recordCommitAndClaimNext({
			ledgerPath: allocationA.ledgerPath,
			sessionId,
			runtimeInstanceId: runtimeA,
			generation: allocationA.generation ?? 0,
			status: "PASS",
		});
		check("R2_T3f", () => {
			assert.equal(result.error, null);
			assert.equal(result.committedRecorded, true, "the commit record is durable");
		});
		// A second attempt on the same generation is refused, and STILL reports that
		// the commit is recorded — the ledger knows, even though this call did not write it.
		const again = recordCommitAndClaimNext({
			ledgerPath: allocationA.ledgerPath,
			sessionId,
			runtimeInstanceId: runtimeA,
			generation: allocationA.generation ?? 0,
			status: "PASS",
		});
		assert.match(String(again.error), /ALREADY_COMMITTED/);
		assert.equal(again.committedRecorded, true, "a duplicate refusal must not claim the commit is unrecorded");
		results.R2_T3f = "PARTIAL_FAILURE_DISTINGUISHED";
	}

	// ── R2_T3g — an unreadable ledger is not "the commit is recorded" ──────────
	// Measured in independent review: with the ledger path replaced by a
	// directory, the commit append failed, the precheck reported "already
	// committed" because history was unreadable, and the frame claimed
	// `ledgerRecorded:true` for a commit that was never written.
	{
		const sessionId = "r2-t3g";
		const runtimeA = createRuntimeInstanceId();
		const allocationA = allocateGeneration({ sessionId, runtimeInstanceId: runtimeA, env: ledgerEnv() });
		const ledgerPath = allocationA.ledgerPath ?? "";
		// Replace the ledger with something unreadable as a ledger.
		rmSync(ledgerPath, { force: true });
		mkdirSync(ledgerPath, { recursive: true });

		check("R2_T3g/state", () => {
			assert.equal(commitRecordState(ledgerPath, 1, sessionId), "UNREADABLE");
			assert.equal(generationAlreadyCommitted(ledgerPath, 1, sessionId), true, "the gate stays fail-closed");
		});

		const result = recordCommitAndClaimNext({
			ledgerPath,
			sessionId,
			runtimeInstanceId: runtimeA,
			generation: allocationA.generation ?? 1,
			status: "PASS",
		});
		check("R2_T3g/report", () => {
			assert.notEqual(result.error, null, "an unreadable ledger must refuse the write");
			assert.equal(result.committedRecorded, false, "an unreadable ledger cannot claim the commit is recorded");
		});
		results.R2_T3g = "UNREADABLE_NOT_RECORDED";
	}

	// ── R2_T3h — the FRAME distinguishes a durable commit from a failed claim ──
	// The library was covered by R2_T3f; the frame was not. Reproduced in review
	// on an older snapshot: a peer pre-claims the next generation, so the commit
	// append succeeds but the claim fails, and the frame must still report the
	// commit as recorded — because it IS on disk.
	{
		const sessionId = "r2-t3h";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			// A peer claims the generation this commit will try to advance to.
			appendFileSync(
				state.ledgerPath,
				`${JSON.stringify({
					type: "allocate",
					sessionId,
					runtimeInstanceId: "peer-runtime",
					generation: state.generation + 1,
					allocationToken: "peer-token",
				})}\n`,
				"utf8",
			);
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation} request=r2-t3h`);
			const [frame] = resultFrames();
			const ledgerText = readFileSync(state.ledgerPath, "utf8");
			check("R2_T3h", () => {
				assert.ok(frame, "the commit must still answer");
				assert.equal(frame.result.committed, true, "the fence landed");
				assert.equal(
					ledgerText.includes(`"type":"commit","sessionId":"${sessionId}"`),
					true,
					"the fixture must have written the commit record",
				);
				assert.equal(
					frame.result.ledgerRecorded,
					true,
					"the commit record is on disk, so the frame must say it was recorded",
				);
				assert.notEqual(frame.result.ledgerError, null, "the failed claim is still reported as an error");
				assert.equal(snapshotFor(sessionId).identityState, "UNWRITABLE", "a failed claim stops further commits");
			});
			results.R2_T3h = "FRAME_REPORTS_DURABLE_COMMIT";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R2_T3i — "attempted and failed" is not "never attempted" ───────────────
	// Reproduced in independent review: a manager throwing inside
	// `acknowledgeDeliveries`, with the failure log also throwing before
	// `fenceCalls` incremented, reported `commitExecuted:false` after an observed
	// attempt. The card requires those two to be distinguishable.
	{
		const sessionId = "r2-t3i";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			const realManager = host.session.asyncJobManager as Record<string, unknown>;
			host.session.asyncJobManager = {
				acknowledgeDeliveries() {
					throw new Error("simulated manager failure");
				},
				getRunningJobs: () => [],
				getDeliveryState: () => ({ queued: 0 }),
				isDeliverySuppressed: () => false,
			};
			// Make the failure LOG throw too, so the throw escapes before the fence
			// counter moves: the exact shape the reviewer measured.
			const logger = host.pi.logger as { warn: (...args: unknown[]) => void };
			const realWarn = logger.warn.bind(logger);
			logger.warn = (message: unknown) => {
				if (message === "no-poll-waits: delivery fence failed") throw new Error("logger failure");
				realWarn(message);
			};
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation} request=r2-t3i`);
			host.session.asyncJobManager = realManager;
			const [frame] = resultFrames();
			check("R2_T3i", () => {
				assert.ok(frame, "the command must still answer");
				assert.equal(frame.result.commitExecuted, true, "a commit was attempted");
				assert.equal(frame.result.committed, false, "but no fence completed");
				assert.equal(frame.result.denial, "HANDLER_EXCEPTION");
			});
			results.R2_T3i = "ATTEMPT_DISTINGUISHED";
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
	}

	// ── R2_T4 — the agent tool surface cannot emit a result frame ───────────────
	{
		const sessionId = "r2-t4";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const requestTool = host.tools.get(REQUEST_TOOL);
			assert.ok(requestTool, "the report tool must exist");
			drainFrames();
			const receipt = await requestTool.execute(
				"report-1",
				{ status: "PASS", reason: "agent says done" },
				undefined,
				undefined,
				host.session,
			);
			assert.equal(receipt.details.committed, false, "the report tool must not commit");
			assert.equal(resultFrames().length, 0, "the agent tool must not emit a controller result frame");
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
		results.R2_T4 = "AGENT_CANNOT_EMIT";
	}

	// ═══════════════════════════════════════════════════════════════════════════
	// R5 — request correlation and transport integrity
	// ═══════════════════════════════════════════════════════════════════════════

	const KEY = options.key;
	const OTHER_KEY = "b".repeat(64);

	function makeFrame(requestId: string, overrides: Record<string, unknown> = {}) {
		return signResultFrame(KEY, {
			requestId,
			result: {
				op: "commit",
				sessionId: "s-1",
				runtimeInstanceId: "rt-1",
				generation: 3,
				status: "PASS",
				committed: true,
				...overrides,
			},
		});
	}

	// ── R5_T1 — valid request/result correlation ────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", { sessionId: "s-1", runtimeInstanceId: "rt-1", generation: 3 });
		const verdict = correlator.accept(makeFrame("req-1"));
		check("R5_T1", () => {
			assert.equal(verdict.ok, true);
			assert.equal(verdict.requestId, "req-1");
			assert.equal(correlator.accepted("req-1")?.committed, true);
		});
		results.R5_T1 = "ACCEPTED";
	}

	// ── R5_T2 — wrong request id ────────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", {});
		const verdict = correlator.accept(makeFrame("req-2"));
		check("R5_T2", () => {
			assert.equal(verdict.ok, false);
			assert.equal(verdict.reason, "UNSOLICITED_RESULT");
		});
		results.R5_T2 = "REJECTED";
	}

	// ── R5_T3 — duplicate result ────────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", {});
		const first = correlator.accept(makeFrame("req-1"));
		const second = correlator.accept(makeFrame("req-1"));
		check("R5_T3", () => {
			assert.equal(first.ok, true);
			assert.equal(second.ok, false);
			assert.equal(second.reason, "DUPLICATE_RESULT");
		});
		results.R5_T3 = "SECOND_REFUSED";
	}

	// ── R5_T4 — out-of-order result ─────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", {});
		correlator.expect("req-2", {});
		// req-2 answers first: responses may interleave, but the answer must be
		// attributed to req-2, not to whichever request is oldest.
		const verdict = correlator.accept(makeFrame("req-2"));
		check("R5_T4", () => {
			assert.equal(verdict.ok, true);
			assert.equal(verdict.requestId, "req-2");
			assert.equal(correlator.accepted("req-1"), undefined, "req-1 must still be outstanding");
		});
		results.R5_T4 = "ATTRIBUTED";
	}

	// ── R5_T5 — missing result ──────────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", {});
		correlator.cancel("req-1");
		check("R5_T5", () => {
			assert.deepEqual(correlator.pendingRequestIds(), []);
			assert.equal(correlator.accepted("req-1"), undefined, "a timed-out request must have no accepted result");
		});
		results.R5_T5 = "NO_RESULT";
	}

	// ── R5_T6 — malformed frame ─────────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", {});
		const genuine = makeFrame("req-1");
		const cases: Array<[string, unknown, string]> = [
			["not an object", "controller_result", "MALFORMED_FRAME"],
			["wrong type", { type: "response", requestId: "req-1" }, "NOT_A_RESULT_FRAME"],
			["truncated mac", { ...genuine, mac: "abc" }, "MAC_MISSING"],
			["no result body", { ...genuine, result: null }, "RESULT_MISSING"],
		];
		for (const [label, frame, reason] of cases) {
			const verdict = correlator.accept(frame);
			check(`R5_T6/${label}`, () => {
				assert.equal(verdict.ok, false, `${label} must be refused`);
				if (reason !== "UNSOLICITED_RESULT") assert.equal(verdict.reason, reason, label);
			});
		}
		results.R5_T6 = cases.length;
	}

	// ── R5_T7 — in-process stdout injection ────────────────────────────────────
	// A frame written by code that does not hold the key must not be accepted, and
	// a genuinely signed frame for another identity must not be accepted either.
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-1", { sessionId: "s-1", runtimeInstanceId: "rt-1", generation: 3 });

		const forged = signResultFrame(OTHER_KEY, {
			requestId: "req-1",
			result: { sessionId: "s-1", runtimeInstanceId: "rt-1", generation: 3, status: "PASS", committed: true },
		});
		const forgedVerdict = correlator.accept(forged);

		const genuine = makeFrame("req-1");
		const tampered = { ...genuine, result: { ...genuine.result, committed: false, denial: "FAKE" } };
		const tamperedVerdict = correlator.accept(tampered);

		const replayed = makeFrame("req-1", { generation: 2 });
		const replayVerdict = correlator.accept(replayed);

		check("R5_T7", () => {
			assert.equal(forgedVerdict.ok, false);
			assert.equal(forgedVerdict.reason, "MAC_MISMATCH");
			assert.equal(tamperedVerdict.ok, false);
			assert.equal(tamperedVerdict.reason, "MAC_MISMATCH");
			assert.equal(replayVerdict.ok, false);
			assert.equal(replayVerdict.reason, "GENERATION_MISMATCH");
			assert.equal(correlator.accepted("req-1"), undefined, "no injected frame may be accepted");
		});
		results.R5_T7 = {
			forgedKey: forgedVerdict.reason,
			tamperedBody: tamperedVerdict.reason,
			replayedGeneration: replayVerdict.reason,
		};
	}

	// ── R5_T8 — concurrent requests ────────────────────────────────────────────
	{
		const correlator = new ResultCorrelator(KEY);
		const ids = ["c-1", "c-2", "c-3", "c-4"];
		for (const id of ids) correlator.expect(id, { generation: 3 });
		const verdicts = ["c-3", "c-1", "c-4", "c-2"].map(id => correlator.accept(makeFrame(id)));
		check("R5_T8", () => {
			assert.equal(verdicts.filter(v => v.ok).length, 4);
			assert.deepEqual(
				verdicts.map(v => v.requestId),
				["c-3", "c-1", "c-4", "c-2"],
			);
			assert.deepEqual(correlator.pendingRequestIds(), []);
		});
		results.R5_T8 = "ALL_ATTRIBUTED";
	}

	// ── R5_T8b — a cancelled request id cannot be reissued ─────────────────────
	// Measured in independent review: after `cancel()`, the id was free again, so
	// a delayed signed answer to the ORIGINAL request would be attributed to the
	// new one. Correlation requires unique ids for the correlator's lifetime.
	{
		const correlator = new ResultCorrelator(KEY);
		correlator.expect("req-x", { sessionId: "s-1" });
		correlator.cancel("req-x");
		check("R5_T8b", () => {
			assert.throws(
				() => correlator.expect("req-x", { sessionId: "s-1" }),
				/already issued/,
				"a cancelled id must not be reissued",
			);
			// And the delayed frame for the cancelled id stays unsolicited.
			const verdict = correlator.accept(makeFrame("req-x"));
			assert.equal(verdict.ok, false);
			assert.equal(verdict.reason, "UNSOLICITED_RESULT");
		});
		results.R5_T8b = "ID_REUSE_REFUSED";
	}

	// ── R5_T9 — the emitted frame is signed with the provisioned key ───────────
	// The bootstrap provisioned a key FILE before the extension loaded, exactly
	// as a controller would. The frame the extension writes must verify with that
	// key, fail with any other key, and the key file must be gone after load.
	{
		const sessionId = "r5-t9";
		process.env[AUTHORITY_ENV] = AUTHORITY;
		const { host, release } = await hostWithGatedJob(sessionId);
		try {
			const state = snapshotFor(sessionId);
			drainFrames();
			await commit(host, `PASS runtime=${state.runtimeInstanceId} generation=${state.generation} request=r5-t9`);
			const [frame] = resultFrames();
			const accepted = verifyResultFrame(KEY, frame, {
				requestId: "r5-t9",
				sessionId,
				runtimeInstanceId: state.runtimeInstanceId,
				generation: state.generation,
			});
			const wrongKey = verifyResultFrame(OTHER_KEY, frame, { requestId: "r5-t9" });
			check("R5_T9", () => {
				assert.equal(existsSync(options.keyFile), false, "the key file must be unlinked at load");
				assert.equal(typeof frame.mac, "string", "a provisioned key must sign the frame");
				assert.equal(accepted.ok, true, `the real key must verify the frame: ${accepted.reason}`);
				assert.equal(wrongKey.ok, false);
				assert.equal(wrongKey.reason, "MAC_MISMATCH");
			});
		} finally {
			delete process.env[AUTHORITY_ENV];
			release();
		}
		results.R5_T9 = "SIGNED_AND_VERIFIED";
	}

	// ── R5_T11 — an unreadable-but-undeletable key fails closed ────────────────
	// Reproduced in independent review: with the key file's directory read-only,
	// unlink failed, the key survived on disk, and a child process read it and
	// produced a frame that verified. A key that cannot be destroyed must not be
	// used to sign.
	{
		const dir = mkdtempSync(join(tmpdir(), "omp-key-unlink-"));
		const keyPath = join(dir, "controller.key");
		writeFileSync(keyPath, "c".repeat(64), { mode: 0o600 });
		chmodSync(dir, 0o500);
		try {
			const probe = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					[
						`import * as fs from "node:fs";`,
						`const m = await import(${JSON.stringify(new URL("../no-poll-waits.js", import.meta.url).href)});`,
						`const pub = m.publishControllerResult({ sessionId: "s", runtimeInstanceId: "rt", generation: 1, committed: true }, "r");`,
						`process.stdout.write(JSON.stringify({ emitted: pub.emitted, signed: pub.signed, reason: pub.reason, keyStillThere: fs.existsSync(${JSON.stringify(keyPath)}), envHasPath: typeof process.env.OMP_CONTROLLER_RESULT_KEY_FILE === "string" }));`,
					].join("\n"),
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						OMP_CONTROLLER_RESULT_KEY_FILE: keyPath,
						OMP_CONTROLLER_RESULT_TRANSPORT: "stdout",
						OMP_TERMINAL_FENCE_AUTHORITY: AUTHORITY,
					},
				},
			);
			const observed = JSON.parse(probe.stdout.trim().split("\n").pop() ?? "{}");
			check("R5_T11", () => {
				assert.equal(observed.keyStillThere, true, "the fixture must actually block the unlink");
				assert.equal(observed.signed, false, "an undeletable key must not sign");
				assert.equal(observed.emitted, false, "no frame may be emitted without a usable key");
				assert.equal(observed.reason, "RESULT_KEY_ABSENT");
			});
			results.R5_T11 = "UNDELETABLE_KEY_REFUSED";
		} finally {
			chmodSync(dir, 0o700);
			rmSync(dir, { recursive: true, force: true });
		}
	}

	// ── R5_T10 — the key never enters the environment, only a path does ────────
	// The provisioning block hands the runtime a PATH; the secret itself is never
	// in `process.env`, so a child process spawned by the governed agent cannot
	// read it out of its inherited environment.
	check("R5_T10", () => {
		for (const [name, value] of Object.entries(process.env)) {
			if (typeof value !== "string") continue;
			assert.equal(
				value.includes(options.key),
				false,
				`environment variable ${name} must not contain the result key`,
			);
		}
		assert.equal(existsSync(options.keyFile), false, "the key file must be unlinked after load");
	});
	results.R5_T10 = "KEY_NOT_IN_ENV";

	// ── canonicalJson stability (the MAC depends on it) ────────────────────────
	check("canonicalJson", () => {
		assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
		assert.equal(canonicalJson(undefined), "null");
		assert.equal(canonicalJson(Number.NaN), "null");
	});

	process.stdout.write = realWrite;



	return { results, failures };
}


let outcome;
try {
	outcome = await runCases({ key: KEY, root: ROOT, stateDir: STATE_DIR, keyFile: KEY_FILE });
} finally {
	rmSync(ROOT, { recursive: true, force: true });
}

if (outcome.failures.length > 0) {
	console.log(JSON.stringify(outcome, null, 2));
	process.exit(1);
}
console.log(JSON.stringify(outcome, null, 2));
console.log(`CONTROLLER_CONTRACT_ACCEPTANCE=PASS cases=${Object.keys(outcome.results).length}`);
