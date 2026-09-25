// Deterministic acceptance harness for
// AEGISFLOW_OMP_TERMINAL_FENCE_AUTHORITY_REPAIR_1.
//
// Drives the REAL repaired extension against a REAL AsyncJobManager (the same
// class OMP uses) with a fake `pi` host that records hook effects. No LLM, no
// timing luck: every completion is released explicitly.
//
// Authority contract under test:
//   * the governed Agent's tool surface must NOT contain a terminal-commit
//     primitive, and must NOT be able to acquire one by payload text or by
//     replaying the removed tool name;
//   * the Agent's REPORT tool (`request_terminal_fence`) must never fence, for
//     any of PASS/HOLD/FAIL/CANCELLED;
//   * the trusted controller must still be able to commit the SAME fence
//     primitive — `fenceGeneration()` — through the host command channel, gated
//     by the controller capability marker;
//   * an active task's legitimate completions must keep being delivered.

import assert from "node:assert/strict";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import openPollWaits, {
	AUTHORITY_ENV,
	TERMINAL_STATUSES,
	commitTerminalFence,
	controllerAuthorityPresent,
	waiterStateSnapshot,
} from "../no-poll-waits.js";

const OWNER = "Main";
const COMMIT_COMMAND = "fence-generation";
const REQUEST_TOOL = "request_terminal_fence";
const LEGACY_TOOL = "fence_background_waiters";

// ── fake host ────────────────────────────────────────────────────────────────

/** One governed session: its own id, its own job manager, its own hook capture. */
function makeHost(sessionId, manager) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const logs = [];
	let resolvedManager = manager;

	const session = {
		sessionManager: { getSessionId: () => sessionId },
		get asyncJobManager() {
			return resolvedManager;
		},
		ui: { notify: (...args) => logs.push(["notify", ...args]) },
	};

	const pi = {
		logger: { warn: (...args) => logs.push(args) },
		zod: undefined, // replaced below
		pi: {
			AgentRegistry: {
				global: () => ({ list: () => [{ id: OWNER, session: resolvedManager === undefined ? null : session }] }),
			},
		},
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		registerTool: def => tools.set(def.name, def),
		registerCommand: (name, options) => commands.set(name, { name, ...options }),
	};

	// Minimal zod-compatible shim: the extension only enumerates an enum + optional string.
	pi.zod = {
		object: shape => ({ shape }),
		enum: values => ({ enum: values }),
		string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
	};

	openPollWaits(pi);

	return {
		pi,
		session,
		tools,
		commands,
		logs,
		get manager() {
			return resolvedManager;
		},
		set manager(next) {
			resolvedManager = next;
		},
		emit: async (event, payload) => {
			const results = [];
			for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, session));
			return results;
		},
	};
}

/** A host whose session owns one gated background job, announced as a bash job. */
async function hostWithGatedJob(sessionId, manager) {
	const host = makeHost(sessionId, manager);
	const gate = Promise.withResolvers<void>();
	const jobId = manager.register("bash", "active task work", async () => {
		await gate.promise;
		return "ACTIVE_JOB_DONE";
	}, { ownerId: OWNER });
	await host.emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: `Backgrounded as job ${jobId}; result will be delivered automatically.` }],
		isError: false,
	});
	return { host, jobId, release: () => gate.resolve() };
}

function newManager() {
	const delivered = [];
	const manager = new AsyncJobManager({
		onJobComplete: () => {
			throw new Error("unowned delivery reached the default sink");
		},
	});
	manager.registerDeliverySink(OWNER, (jobId, _text, _job) => {
		delivered.push(jobId);
	});
	return { manager, delivered };
}

const fenceLogs = logs =>
	logs.filter(entry => Array.isArray(entry) && entry[0] === "no-poll-waits: generation fenced");
const requestLogs = logs =>
	logs.filter(entry => Array.isArray(entry) && entry[0] === "no-poll-waits: terminal request recorded (not committed)");
const denialLogs = logs =>
	logs.filter(entry => Array.isArray(entry) && entry[0] === "no-poll-waits: terminal fence commit denied");
const attemptLogs = logs =>
	logs.filter(entry => Array.isArray(entry) && entry[0] === "no-poll-waits: agent terminal-fence attempt denied");

const results = {};

// ── CASE 6a: the commit primitive is absent from the Agent tool vocabulary ───
{
	const { manager } = newManager();
	const host = makeHost("case6-vocabulary", manager);
	const toolNames = [...host.tools.keys()];
	assert.equal(
		toolNames.includes(LEGACY_TOOL),
		false,
		`terminal-commit tool "${LEGACY_TOOL}" must not be registered for the governed agent`,
	);
	assert.ok(toolNames.includes(REQUEST_TOOL), `${REQUEST_TOOL} (non-committing report tool) must be registered`);
	const requestTool = host.tools.get(REQUEST_TOOL);
	const description = String(requestTool?.description ?? "");
	assert.match(description, /does NOT commit/i, "the report tool must say it cannot commit");
	results.AGENT_FENCE_TOOL_EXPOSURE = toolNames.includes(LEGACY_TOOL) ? "PRESENT" : "NONE";
	results.AGENT_REPORT_TOOL = toolNames.includes(REQUEST_TOOL) ? "REQUEST_ONLY" : "MISSING";
	results.COMMIT_COMMAND_REGISTERED = host.commands.has(COMMIT_COMMAND);
	assert.ok(host.commands.has(COMMIT_COMMAND), "the controller commit command must be registered");
}

// ── CASE 1 — ACTIVE SELF-FENCE ───────────────────────────────────────────────
// An active governed task whose agent reaches for the terminal fence directly.
{
	const { manager, delivered } = newManager();
	const { host, jobId, release } = await hostWithGatedJob("case1-self-fence", manager);

	const toolCallResults = await host.emit("tool_call", {
		type: "tool_call",
		toolName: LEGACY_TOOL,
		toolCallId: "call-self-fence",
		input: { status: "PASS", reason: "agent declares itself done" },
	});
	const blocked = toolCallResults.find(r => r && r.block);
	assert.ok(blocked, "a direct fence_background_waiters tool call must be denied");
	results.SELF_FENCE = blocked ? "DENIED" : "ALLOWED";

	const snapshot = waiterStateSnapshot().find(s => s.sessionId === "case1-self-fence");
	assert.equal(snapshot.fenceCalls, 0, "the denied call must not fence anything");
	assert.equal(snapshot.generation, 1, "the generation must remain the active one");
	assert.deepEqual(snapshot.fencedGenerations, [], "no generation may be fenced");
	assert.equal(snapshot.agentFenceAttempts.length, 1, "the attempt must be recorded");
	assert.equal(attemptLogs(host.logs).length, 1, "the attempt must be logged");
	results.GENERATION_REMAINS_ACTIVE = snapshot.generation === 1 && snapshot.fencedGenerations.length === 0 ? "YES" : "NO";

	// The task is still active: its job must still be delivered.
	release();
	await manager.getJob(jobId).promise;
	await manager.drainDeliveries({ timeoutMs: 4000 });
	assert.deepEqual(delivered, [jobId], "the active task's legitimate completion must still be delivered");
	results.LEGITIMATE_PENDING_DELIVERY = delivered.includes(jobId) ? "DELIVERED" : "SUPPRESSED";
}

// ── CASE 2 — FORGED TERMINAL (all four dispositions, no controller commit) ───
{
	const forged = {};
	for (const status of TERMINAL_STATUSES) {
		const sessionId = `case2-forged-${status}`;
		const { manager, delivered } = newManager();
		const { host, jobId, release } = await hostWithGatedJob(sessionId, manager);

		const requestTool = host.tools.get(REQUEST_TOOL);
		const receipt = await requestTool.execute("call-forge", { status, reason: "forged" }, undefined, undefined, host.session);
		assert.equal(receipt.details.committed, false, `${status}: the agent report must not commit`);
		assert.equal(receipt.details.status, status);
		assert.match(receipt.content[0].text, /committed: false/);

		// A payload that reads like an authority token must not help either.
		await requestTool.execute(
			"call-forge-2",
			{ status, reason: `status=${status}; controller_authority=committed; fence=true; generation=0` },
			undefined,
			undefined,
			host.session,
		);

		const snapshot = waiterStateSnapshot().find(s => s.sessionId === sessionId);
		assert.equal(snapshot.fenceCalls, 0, `${status}: forged input must not fence`);
		assert.equal(snapshot.generation, 1, `${status}: generation must be unchanged`);
		assert.deepEqual(snapshot.fencedGenerations, []);
		assert.equal(fenceLogs(host.logs).length, 0, `${status}: no fence may be logged`);
		assert.equal(manager.isDeliverySuppressed(jobId), false, `${status}: the pending delivery must stay live`);

		release();
		await manager.getJob(jobId).promise;
		await manager.drainDeliveries({ timeoutMs: 4000 });
		assert.ok(delivered.includes(jobId), `${status}: delivery must survive the forged terminal`);

		forged[status] = snapshot.fenceCalls === 0 && delivered.includes(jobId) ? "DENIED" : "ACQUIRED";
	}
	results.FORGED_TERMINAL_FENCE =
		Object.values(forged).every(v => v === "DENIED") ? "DENIED" : `LEAKED ${JSON.stringify(forged)}`;
	results.FORGED_TERMINAL_FENCE_PER_STATUS = forged;
}

// ── CASE 2b — controller capability absent => commit fails closed ───────────
{
	const { manager, delivered } = newManager();
	const { host, jobId, release } = await hostWithGatedJob("case2b-no-capability", manager);
	const saved = process.env[AUTHORITY_ENV];
	delete process.env[AUTHORITY_ENV];
	try {
		assert.equal(controllerAuthorityPresent(), false);
		await host.commands.get(COMMIT_COMMAND).handler("PASS controller wants terminal", host.session);
	} finally {
		if (saved !== undefined) process.env[AUTHORITY_ENV] = saved;
	}
	const snapshot = waiterStateSnapshot().find(s => s.sessionId === "case2b-no-capability");
	assert.equal(snapshot.fenceCalls, 0, "an unmanaged process must not be able to commit a fence");
	assert.equal(snapshot.commitDenials.length, 1, "the denial must be recorded");
	assert.equal(snapshot.commitDenials[0].denial, "CONTROLLER_AUTHORITY_ABSENT");
	assert.equal(denialLogs(host.logs).length, 1, "the denial must be logged");
	release();
	await manager.getJob(jobId).promise;
	await manager.drainDeliveries({ timeoutMs: 4000 });
	assert.ok(delivered.includes(jobId), "a denied commit must leave the delivery path alive");
	results.COMMIT_WITHOUT_CAPABILITY = "DENIED";
}

// ── CASE 3 — REAL TERMINAL, all four dispositions, controller authority ─────
{
	const committed = {};
	const silenced = {};
	for (const status of TERMINAL_STATUSES) {
		const sessionId = `case3-terminal-${status}`;
		const { manager, delivered } = newManager();
		const { host, jobId, release } = await hostWithGatedJob(sessionId, manager);
		// A second job so the fence has more than one delivery to invalidate.
		const gate2 = Promise.withResolvers<void>();
		const job2 = manager.register("bash", "second job", async () => {
			await gate2.promise;
			return "SECOND_DONE";
		}, { ownerId: OWNER });
		await host.emit("tool_result", {
			toolName: "bash",
			content: [{ type: "text", text: `Backgrounded as job ${job2}; result will be delivered automatically.` }],
			isError: false,
		});

		// The governed agent first REPORTS completion (allowed)…
		await host.tools
			.get(REQUEST_TOOL)
			.execute("call-report", { status, reason: "task finished" }, undefined, undefined, host.session);

		const saved = process.env[AUTHORITY_ENV];
		process.env[AUTHORITY_ENV] = `harness-${status}`;
		try {
			// …then the TRUSTED CONTROLLER commits, on the host command channel.
			await host.commands.get(COMMIT_COMMAND).handler(`${status} card completed`, host.session);
		} finally {
			if (saved === undefined) delete process.env[AUTHORITY_ENV];
			else process.env[AUTHORITY_ENV] = saved;
		}

		const fence = fenceLogs(host.logs);
		assert.equal(fence.length, 1, `${status}: exactly one fence must be committed`);
		const entry = fence[0][1];
		assert.equal(entry.status, status);
		assert.equal(entry.authority, "controller-command");
		assert.equal(entry.generation, 1);
		assert.deepEqual(entry.jobIds.sort(), [jobId, job2].sort());

		const snapshot = waiterStateSnapshot().find(s => s.sessionId === sessionId);
		assert.equal(snapshot.fenceCalls, 1);
		assert.deepEqual(snapshot.fencedGenerations, [1]);
		assert.equal(snapshot.generation, 2, "the committed fence must advance the generation");
		assert.equal(snapshot.terminalRequests.length, 1, "the agent's report must be on record");
		assert.equal(snapshot.terminalRequests[0].committed, undefined);

		// Late completions: recorded internally, never delivered.
		const before = delivered.length;
		release();
		gate2.resolve();
		await Promise.all([manager.getJob(jobId).promise, manager.getJob(job2).promise]);
		await manager.drainDeliveries({ timeoutMs: 4000 });
		await Bun.sleep(200);
		const after = delivered.length;
		const jobs = [manager.getJob(jobId), manager.getJob(job2)];
		assert.ok(jobs.every(j => j.status === "completed"), `${status}: late completions must still be recorded`);
		assert.equal(after - before, 0, `${status}: no post-terminal delivery may occur`);

		committed[status] = `gen ${entry.generation} / invalidated ${entry.jobIds.length} / delivered ${after - before}`;
		silenced[status] = { delivered: after - before, recorded: jobs.filter(j => j.status === "completed").length };
	}
	results.CONTROLLER_TERMINAL_FENCE = committed;
	results.POST_TERMINAL_AGENT_INVOCATIONS = Object.values(silenced).reduce((n, v) => n + v.delivered, 0);
	results.POST_TERMINAL_VISIBLE_OUTPUT = results.POST_TERMINAL_AGENT_INVOCATIONS;
	assert.equal(results.POST_TERMINAL_AGENT_INVOCATIONS, 0, "no disposition may produce a post-terminal delivery");
}

// ── CASE 4 — PROGRESS: legitimate completion of an active task ──────────────
{
	const { manager, delivered } = newManager();
	const { host, jobId, release } = await hostWithGatedJob("case4-progress", manager);
	// The agent reports progress (not terminal) and the job completes while active.
	await host.tools
		.get(REQUEST_TOOL)
		.execute("call-progress", { status: "HOLD", reason: "still working, reporting interim" }, undefined, undefined, host.session);
	release();
	await manager.getJob(jobId).promise;
	await manager.drainDeliveries({ timeoutMs: 4000 });
	assert.ok(delivered.includes(jobId), "an active task's legitimate completion must be delivered");
	const snapshot = waiterStateSnapshot().find(s => s.sessionId === "case4-progress");
	assert.equal(snapshot.fenceCalls, 0, "a progress report must not fence");
	results.ACTIVE_DELIVERY_PRESERVED = "YES";
}

// ── CASE 5 — GENERATION: N fenced, N+1 unaffected ───────────────────────────
{
	const { manager, delivered } = newManager();
	const { host, jobId, release } = await hostWithGatedJob("case5-generation", manager);
	const saved = process.env[AUTHORITY_ENV];
	process.env[AUTHORITY_ENV] = "harness-gen";
	try {
		await host.commands.get(COMMIT_COMMAND).handler("PASS generation 1 terminal", host.session);
	} finally {
		if (saved === undefined) delete process.env[AUTHORITY_ENV];
		else process.env[AUTHORITY_ENV] = saved;
	}
	release();
	await manager.getJob(jobId).promise;
	await manager.drainDeliveries({ timeoutMs: 2000 });
	assert.ok(!delivered.includes(jobId), "the fenced generation's late completion must stay suppressed");

	// New work in the same session: a new generation, unaffected by the fence.
	const nextGate = Promise.withResolvers<void>();
	const nextId = manager.register("bash", "next task work", async () => {
		await nextGate.promise;
		return "NEXT_TASK_DONE";
	}, { ownerId: OWNER });
	await host.emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: `Backgrounded as job ${nextId}; result will be delivered automatically.` }],
		isError: false,
	});
	nextGate.resolve();
	await manager.getJob(nextId).promise;
	await manager.drainDeliveries({ timeoutMs: 4000 });
	assert.ok(delivered.includes(nextId), "the new generation's completion must be delivered");
	assert.ok(!delivered.includes(jobId), "the fenced generation must stay silent");
	results.OLD_GENERATION_SUPPRESSED = delivered.includes(jobId) ? "NO" : "YES";
	results.NEW_GENERATION_ACTIVE = delivered.includes(nextId) ? "YES" : "NO";
}

// ── CASE 6b — direct commit attempt through the exported primitive ──────────
// The primitive itself must refuse without the controller capability, however it
// is reached (a mapped tool, a nested dispatch, a future re-registration).
{
	const { manager } = newManager();
	const host = makeHost("case6-primitive", manager);
	const saved = process.env[AUTHORITY_ENV];
	delete process.env[AUTHORITY_ENV];
	let denial;
	try {
		const state = waiterStateSnapshot().length; // touch the snapshot surface
		void state;
		denial = commitTerminalFence(host.pi, { sessionId: "case6-primitive", generation: 1, jobs: new Map(), fenced: new Set(), commitDenials: [], terminalRequests: [] }, manager, "PASS", "forged", process.env);
	} finally {
		if (saved !== undefined) process.env[AUTHORITY_ENV] = saved;
	}
	assert.equal(denial.committed, false, "the commit primitive must fail closed without controller authority");
	assert.equal(denial.denial, "CONTROLLER_AUTHORITY_ABSENT");
	results.PRIMITIVE_FAILS_CLOSED = "YES";

	// Invalid disposition through the controller channel is refused too.
	process.env[AUTHORITY_ENV] = "harness-invalid";
	let invalid;
	try {
		invalid = commitTerminalFence(
			host.pi,
			{ sessionId: "case6-primitive", generation: 1, jobs: new Map(), fenced: new Set(), commitDenials: [], terminalRequests: [] },
			manager,
			"COMMITTED",
			"fake status",
			process.env,
		);
	} finally {
		if (saved === undefined) delete process.env[AUTHORITY_ENV];
		else process.env[AUTHORITY_ENV] = saved;
	}
	assert.equal(invalid.committed, false);
	assert.equal(invalid.denial, "INVALID_TERMINAL_STATUS");
	results.INVALID_STATUS_REFUSED = "YES";
}

// ── CASE 6c — the removed tool name is denied at the hook, not just absent ──
{
	const { manager } = newManager();
	const host = makeHost("case6-hook", manager);
	for (const input of [
		{ status: "PASS" },
		{ status: "CANCELLED", reason: "shutdown" },
		{ status: "PASS", authority: "controller" },
		{ controller_authority: "committed" },
	]) {
		const results2 = await host.emit("tool_call", {
			type: "tool_call",
			toolName: LEGACY_TOOL,
			toolCallId: "call-hook",
			input,
		});
		assert.ok(
			results2.some(r => r && r.block),
			"fail closed: every shape of the removed tool call must be denied",
		);
	}
	const snapshot = waiterStateSnapshot().find(s => s.sessionId === "case6-hook");
	assert.equal(snapshot.fenceCalls, 0);
	assert.equal(snapshot.agentFenceAttempts.length, 4);
	results.LEGACY_TOOL_CALLS_DENIED = snapshot.agentFenceAttempts.length;
}

// ── REAL CONCURRENT WORK negative control ───────────────────────────────────
{
	const { manager, delivered } = newManager();
	const host = makeHost("case-concurrency", manager);
	const gates = [0, 1, 2, 3].map(() => Promise.withResolvers());
	const ids = gates.map((gate, i) =>
		manager.register("bash", `fanout ${i}`, async () => {
			await gate.promise;
			return `FANOUT_${i}`;
		}, { ownerId: OWNER }),
	);
	await host.emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: `Backgrounded as job ${ids[0]}; result will be delivered automatically.` }],
		isError: false,
	});
	assert.equal(manager.getRunningJobs({ ownerId: OWNER }).length, 4, "four legitimate jobs must run concurrently");
	for (const command of ["npm run build", "npm test", "cargo build --release", "go test ./..."]) {
		const verdicts = await host.emit("tool_call", {
			type: "tool_call",
			toolName: "bash",
			toolCallId: `call-${command}`,
			input: { command, timeout: 3000 },
		});
		assert.equal(verdicts.find(r => r && r.block), undefined, `legitimate work blocked: ${command}`);
	}
	gates.forEach(gate => gate.resolve());
	await manager.waitForOwnerJobs(OWNER);
	await manager.drainDeliveries({ timeoutMs: 4000 });
	assert.equal(delivered.length, 4, "each legitimate job must deliver exactly once");
	assert.equal(manager.getDeliveryState().queued, 0, "no residual deliveries");
	results.REAL_CONCURRENT_WORK = delivered.length === 4 ? "UNAFFECTED" : `DEGRADED (${delivered.length}/4)`;
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(JSON.stringify(results, null, 2));

const failures = [];
const expect = (key, value) => {
	if (results[key] !== value) failures.push(`${key}=${JSON.stringify(results[key])} != ${JSON.stringify(value)}`);
};
expect("SELF_FENCE", "DENIED");
expect("GENERATION_REMAINS_ACTIVE", "YES");
expect("LEGITIMATE_PENDING_DELIVERY", "DELIVERED");
expect("FORGED_TERMINAL_FENCE", "DENIED");
expect("COMMIT_WITHOUT_CAPABILITY", "DENIED");
expect("POST_TERMINAL_AGENT_INVOCATIONS", 0);
expect("ACTIVE_DELIVERY_PRESERVED", "YES");
expect("OLD_GENERATION_SUPPRESSED", "YES");
expect("NEW_GENERATION_ACTIVE", "YES");
expect("AGENT_FENCE_TOOL_EXPOSURE", "NONE");
expect("AGENT_REPORT_TOOL", "REQUEST_ONLY");
expect("COMMIT_COMMAND_REGISTERED", true);
expect("PRIMITIVE_FAILS_CLOSED", "YES");
expect("INVALID_STATUS_REFUSED", "YES");
expect("REAL_CONCURRENT_WORK", "UNAFFECTED");
if (Object.values(results.CONTROLLER_TERMINAL_FENCE).some(v => !/invalidated 2 /.test(v))) {
	failures.push(`CONTROLLER_TERMINAL_FENCE did not invalidate both jobs: ${JSON.stringify(results.CONTROLLER_TERMINAL_FENCE)}`);
}
console.log(failures.length === 0 ? "AUTHORITY_ACCEPTANCE=PASS" : `AUTHORITY_ACCEPTANCE=FAIL ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
