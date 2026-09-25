// Deterministic acceptance harness for
// AEGISFLOW_OMP_WAITER_LIFECYCLE_AND_NOTIFICATION_REPAIR_1.
//
// Drives the REAL repaired extension module against a REAL AsyncJobManager
// (the same class OMP uses), with a fake `pi` host that records hook effects.
// No LLM, no timing luck: every completion is released explicitly.
//
// Run under bun from the directory containing node_modules/@oh-my-pi:
//   bun /private/tmp/waiter-verify/acceptance.ts

import assert from "node:assert/strict";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import openPollWaits, { waiterStateSnapshot } from "../no-poll-waits.js";

const SESSION_ID = "session-under-test";
const OWNER = "Main";

const manager = new AsyncJobManager({
	onJobComplete: () => {
		throw new Error("unowned delivery reached the default sink");
	},
});

/** Deliveries the SUT actually delivered to the owning agent after the fence. */
const deliveries = [];
let deliveryCount = 0;
manager.registerDeliverySink(OWNER, (jobId, _text, _job) => {
	deliveryCount += 1;
	deliveries.push({ jobId, at: Date.now() });
});

// ── fake host ────────────────────────────────────────────────────────────────
const handlers = new Map();
const tools = new Map();
const commands = new Map();
const logs = [];
let resolvedManager: AsyncJobManager | undefined = manager;

// The fake session's job manager must follow `resolvedManager` so each scenario
// (main fence, automatic leg) fences the manager it actually started jobs on.
const fakeSession = {
	sessionManager: { getSessionId: () => SESSION_ID },
	get asyncJobManager(): AsyncJobManager | undefined {
		return resolvedManager;
	},
};

const pi = {
	logger: { warn: (...args) => logs.push(args) },
	zod: undefined, // replaced below
	pi: {
		AgentRegistry: {
			global: () => ({
				list: () => [{ id: OWNER, session: resolvedManager === undefined ? null : fakeSession }],
			}),
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

const ctx = fakeSession; // extension ctx IS the session host: ctx.sessionManager.getSessionId()
const emit = async (event, payload) => {
	const results = [];
	for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, ctx));
	return results;
};

// ── SECTION 6a: original pattern — one real bg job + repeated sleep/check attempts ──
const realWork = { command: "npm test 2>&1 | tail -30", timeout: 3000 };
const probe = async (command, input = {}) => {
	const results = await emit("tool_call", { type: "tool_call", toolName: "bash", toolCallId: `c-${command}`, input: { command, ...input } });
	return results.find(r => r && r.block) ?? null;
};

// The incident's waiter shapes, repeated exactly as the agent issued them.
const incidentWaiters = [
	'sleep 600; date; for p in $(pgrep -f "run-suite.mjs"); do echo $p; done; echo "(empty=done)"',
	'sleep 600; date; for p in $(pgrep -f "run-suite.mjs"); do echo $p; done; echo "(empty=done)"',
	'sleep 600; date; ps -eo pid= | head -2; echo AUTOCHECK_DONE',
	'sleep 600; pgrep -f runner; echo done',
	'sleep 300; ps aux | grep -E "runner" | grep -v grep | wc -l; ls -t /tmp | head -1',
	'sleep 400; ps -eo pid,etime,command | grep suite | grep -v grep',
	'sleep 30; date; ps; echo x',
];

let pollWaitJobs = 0;
let unnecessaryWaiters = 0;
const refused = [];

// Real work must always be admissible.
assert.equal(await probe(realWork.command, { timeout: realWork.timeout }), null, "real work must not be blocked");

// A "waiter" is only a waiter if it becomes a background JOB. Poll-only commands
// that would auto-background (>= threshold) or that requested async:true would;
// a short bounded foreground poll creates no job and no notification.
for (const command of incidentWaiters) {
	const blocked = await probe(command); // async UNSET — the bypass seam
	const longEnough = /sleep\s+(?:\d{3,}|\d+m|\d+h)/.test(command);
	if (blocked) {
		refused.push(command);
		continue;
	}
	// Admitted. If it would have become a job, that is an unnecessary waiter.
	if (longEnough) {
		pollWaitJobs += 1;
		unnecessaryWaiters += 1;
	}
}
// Any poll-only command admitted with async:true is by definition an unnecessary waiter.
for (const command of ['sleep 120', 'sleep 90; pgrep -f x']) {
	const blocked = await probe(command, { async: true });
	if (!blocked) {
		pollWaitJobs += 1;
		unnecessaryWaiters += 1;
	} else refused.push(command);
}

// ── The single legitimate job in this scenario ──────────────────────────────
const realJobId = manager.register(
	"bash",
	realWork.command,
	async () => {
		await Bun.sleep(20);
		return "REAL_WORK_DONE";
	},
	{ ownerId: OWNER },
);
// Bind it the way the harness announces it.
await emit("tool_result", {
	toolName: "bash",
	content: [{ type: "text", text: `Backgrounded as job ${realJobId}; result will be delivered automatically.` }],
	isError: false,
});

// ── SECTION 6b: >=5 delayed completions, task terminals before they mature ──
const DELAYED = 6;
const delayed = Promise.withResolvers<void>();
const delayedGate = delayed.promise;
const delayedIds = [];
for (let i = 0; i < DELAYED; i++) {
	const id = manager.register(
		"bash",
		`delayed unit ${i}`,
		async () => {
			await delayedGate;
			return `DELAYED_${i}_DONE`;
		},
		{ ownerId: OWNER },
	);
	delayedIds.push(id);
	await emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: `Backgrounded as job ${id}; result will be delivered automatically.` }],
		isError: false,
	});
}

// Let the one legitimate job settle and deliver normally (pre-terminal).
// The delayed jobs are still gated, so wait on the real job explicitly.
await manager.getJob(realJobId).promise;
await manager.drainDeliveries({ timeoutMs: 4000 });
const preTerminalDeliveries = deliveryCount;
assert.ok(deliveryCount >= 1, "the legitimate background job must deliver before terminal");

// TERMINAL: the CONTROLLER commits the fence while the delayed jobs are still
// running. The governed agent has no commit primitive (AEGISFLOW_OMP_TERMINAL_
// FENCE_AUTHORITY_REPAIR_1), so this goes through the host command channel with
// the controller capability marker — and the Agent's own report tool must not be
// able to do what this does.
const commitTool = tools.get("fence_background_waiters");
assert.equal(commitTool, undefined, "the terminal-commit tool must not be registered for the governed agent");
const commitCommand = commands.get("fence-generation");
assert.ok(commitCommand, "the controller commit command must be registered");
const reportTool = tools.get("request_terminal_fence");
assert.ok(reportTool, "the agent must still be able to REPORT a terminal disposition");
const reportReceipt = await reportTool.execute(
	"report-1",
	{ status: "PASS", reason: "card accepted" },
	undefined,
	undefined,
	ctx,
);
assert.equal(reportReceipt.details.committed, false, "an agent report must never commit a fence");

const savedAuthority = process.env.OMP_TERMINAL_FENCE_AUTHORITY;
process.env.OMP_TERMINAL_FENCE_AUTHORITY = "harness-controller";
try {
	await commitCommand.handler("PASS card accepted", ctx);
} finally {
	if (savedAuthority === undefined) delete process.env.OMP_TERMINAL_FENCE_AUTHORITY;
	else process.env.OMP_TERMINAL_FENCE_AUTHORITY = savedAuthority;
}
const fenceLog = logs.find(entry => Array.isArray(entry) && entry[0] === "no-poll-waits: generation fenced");
assert.ok(fenceLog, "the controller commit must fence the generation");
assert.equal(fenceLog[1].status, "PASS");
assert.equal(fenceLog[1].authority, "controller-command");

const deliveriesAtFence = deliveryCount;

// Now the delayed completions mature — AFTER the task went terminal.
delayed.resolve();
await Promise.all(delayedIds.map(id => manager.getJob(id).promise));
await manager.drainDeliveries({ timeoutMs: 4000 });
await Bun.sleep(200); // give any unsuppressed delivery loop a chance to run

const postTerminalAgentInvocations = deliveryCount - deliveriesAtFence;
const completedAfterTerminal = delayedIds.filter(id => {
	const job = manager.getJob(id);
	return job && (job.status === "completed" || job.status === "failed");
}).length;

// Registry truth: late completions still recorded (inspectable via proc://).
assert.equal(completedAfterTerminal, DELAYED, "late completions must remain visible in the registry");

// ── SECTION 7: real tool fan-out — 4 concurrent legitimate jobs ──
const fanoutManager = new AsyncJobManager({});
let fanoutDeliveries = 0;
fanoutManager.registerDeliverySink(OWNER, () => {
	fanoutDeliveries += 1;
});
const fanoutIds = [];
for (let i = 0; i < 4; i++) {
	fanoutIds.push(
		fanoutManager.register(
			"bash",
			`fanout ${i}`,
			async () => {
				await Bun.sleep(10 + i * 5);
				return `FANOUT_${i}`;
			},
			{ ownerId: OWNER },
		),
	);
}
// All four run concurrently (cap is 15) and none is blocked by the policy.
assert.equal(fanoutManager.getRunningJobs({ ownerId: OWNER }).length, 4, "4 legitimate tool jobs must run concurrently");
for (const command of ["npm run build", "npm test", "cargo build --release", "go test ./..."]) {
	assert.equal(await probe(command, { timeout: 3000 }), null, `legitimate work blocked: ${command}`);
}
await fanoutManager.waitForOwnerJobs(OWNER);
await fanoutManager.drainDeliveries({ timeoutMs: 4000 });
assert.equal(fanoutDeliveries, 4, "each legitimate job must deliver exactly once");
assert.equal(fanoutManager.getDeliveryState().queued, 0, "no residual deliveries");

// ── SECTION 8: regression — generation isolation ──
// A NEW task in the same session (new generation) must be unaffected by the fence.
const newJobId = manager.register("bash", "next task work", async () => "NEXT_TASK_DONE", { ownerId: OWNER });
await emit("tool_result", {
	toolName: "bash",
	content: [{ type: "text", text: `Backgrounded as job ${newJobId}; result will be delivered automatically.` }],
	isError: false,
});
await manager.waitForOwnerJobs(OWNER);
await manager.drainDeliveries({ timeoutMs: 4000 });
const newTaskDelivered = deliveries.some(d => d.jobId === newJobId);


// ── NEGATIVE CONTROL: identical scenario WITHOUT the fence ──────────────────
// Proves the fence is what suppresses the post-terminal wakes, not teardown
// timing or an unrelated manager behavior.
const controlManager = new AsyncJobManager({});
let controlDeliveries = 0;
controlManager.registerDeliverySink(OWNER, () => {
	controlDeliveries += 1;
});
const controlGate = Promise.withResolvers<void>();
const controlIds = [];
for (let i = 0; i < DELAYED; i++) {
	controlIds.push(
		controlManager.register("bash", `control ${i}`, async () => {
			await controlGate.promise;
			return `CONTROL_${i}_DONE`;
		}, { ownerId: OWNER }),
	);
}
const controlBaseline = controlDeliveries;
controlGate.resolve();
await Promise.all(controlIds.map(id => controlManager.getJob(id).promise));
await controlManager.drainDeliveries({ timeoutMs: 4000 });
const controlPostTerminal = controlDeliveries - controlBaseline;


// ── TERMINAL FENCE, automatic leg: agent_end without continuation ───────────
// A session that settles for real (no scheduled continuation) while jobs are
// pending must fence them too, without any orchestrator declaration.
const autoManager = new AsyncJobManager({});
let autoDeliveries = 0;
autoManager.registerDeliverySink(OWNER, () => {
	autoDeliveries += 1;
});
const autoGate = Promise.withResolvers<void>();
// Auto ids are manager-scoped, so a second manager also starts at `bg_1`.
// Use an explicit unique id to keep the extension's job->generation binding
// unambiguous across the harness's independent managers.
const autoId = autoManager.register("bash", "auto-leg work", async () => {
	await autoGate.promise;
	return "AUTO_LEG_DONE";
}, { ownerId: OWNER, id: "auto-leg-bg_1" });
// Rebind the fake host to this manager for the emit below.
const savedManager = resolvedManager;
resolvedManager = autoManager;
await emit("tool_result", {
	toolName: "bash",
	content: [{ type: "text", text: `Backgrounded as job ${autoId}; result will be delivered automatically.` }],
	isError: false,
});
await emit("agent_end", { type: "agent_end", messages: [] }); // willContinue undefined => terminal
const autoBaseline = autoDeliveries;
autoGate.resolve();
await autoManager.getJob(autoId).promise;
await autoManager.drainDeliveries({ timeoutMs: 3000 });
const autoPostTerminal = autoDeliveries - autoBaseline;
resolvedManager = savedManager;

// ── report ──────────────────────────────────────────────────────────────────
const state = waiterStateSnapshot();
const report = {
	POLL_WAIT_JOBS: pollWaitJobs,
	UNNECESSARY_WAITERS: unnecessaryWaiters,
	REFUSED_WAITERS: refused.length,
	AUTO_BACKGROUNDED_POLL_WAITERS: pollWaitJobs,
	PRE_TERMINAL_DELIVERIES: preTerminalDeliveries,
	DELAYED_JOBS: DELAYED,
	POST_TERMINAL_COMPLETIONS: completedAfterTerminal,
	POST_TERMINAL_AGENT_INVOCATIONS: postTerminalAgentInvocations,
	FANOUT_JOBS: 4,
	FANOUT_DELIVERIES: fanoutDeliveries,
	NEW_GENERATION_DELIVERED: newTaskDelivered,
	GENERATION_AFTER_FENCE: state[0]?.generation,
	AUTO_AGENT_END_FENCE_POST_TERMINAL: autoPostTerminal,
	CONTROL_POST_TERMINAL_INVOCATIONS_WITHOUT_FENCE: controlPostTerminal,
	NEXT_GENERATION_ACTIVE: newTaskDelivered,
	AGENT_FENCE_TOOL_EXPOSURE: commitTool === undefined ? "NONE" : "PRESENT",
	AGENT_REPORT_TOOL_COMMITTED: reportReceipt.details.committed,
	CONTROLLER_TERMINAL_FENCE_AUTHORITY: fenceLog?.[1]?.authority ?? null,
	BLOCKED: state[0]?.blocked,
	ALLOWED: state[0]?.allowed,
};
console.log(JSON.stringify(report, null, 2));

const failures = [];
if (pollWaitJobs > 1) failures.push(`POLL_WAIT_JOBS=${pollWaitJobs} > 1`);
if (unnecessaryWaiters !== 0) failures.push(`UNNECESSARY_WAITERS=${unnecessaryWaiters} != 0`);
if (postTerminalAgentInvocations !== 0) failures.push(`POST_TERMINAL_AGENT_INVOCATIONS=${postTerminalAgentInvocations} != 0`);
if (completedAfterTerminal < 5) failures.push(`POST_TERMINAL_COMPLETIONS=${completedAfterTerminal} < 5`);
if (fanoutDeliveries !== 4) failures.push(`fanout deliveries=${fanoutDeliveries} != 4`);
if (!newTaskDelivered) failures.push("new generation was collateral-damaged by the fence");
if (controlPostTerminal < 5) failures.push(`negative control did not reproduce (${controlPostTerminal} < 5) — fence not proven causal`);
if (autoPostTerminal !== 0) failures.push(`automatic agent_end fence failed: ${autoPostTerminal} delivered`);
if (commitTool !== undefined) failures.push("terminal-commit tool is exposed to the governed agent");
if (reportReceipt.details.committed !== false) failures.push("agent report tool committed a fence");
if (fenceLog?.[1]?.authority !== "controller-command") failures.push("controller commit did not carry controller authority");
console.log(failures.length === 0 ? "ACCEPTANCE=PASS" : `ACCEPTANCE=FAIL ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
