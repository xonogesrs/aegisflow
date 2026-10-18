// Deterministic acceptance harness for
// AEGISFLOW_OMP_TERMINAL_FENCE_ORDERING_REPAIR_1.
//
// Drives the REAL repaired extension against a REAL AsyncJobManager (the class
// OMP uses) with a fake `pi` host. No LLM, no timing luck: every completion is
// released explicitly and every wake dispatch is driven explicitly, so the race
// is reproduced exactly, not hoped for.
//
// The defect under test — measured in session 01a0d90c-…:
//
//   report visible 16:41:53.189Z
//   → bg_107 completion delivered 16:48:10.838Z
//   → agent re-invoked into a stale no-op turn
//   → fence at 16:48:16.873Z invalidating 59 pending deliveries
//
// Required order, every run:
//
//   TERMINAL_COMMITTED → GENERATION_FENCED → DELIVERIES_INVALIDATED
//   → TERMINAL_GENERATION_STATE → FINAL_DELIVERY_ALLOWED
//
// and never FINAL_REPORT → later FENCE.
//
// Run:  bun test/terminal-fence-ordering.acceptance.ts [--iterations N] [--json out.json]

import assert from "node:assert/strict";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import openPollWaits, {
	AUTHORITY_ENV,
	BARRIER_BLOCK_LIMIT,
	TERMINAL_FENCE_ORDER,
	waiterStateSnapshot,
} from "../no-poll-waits.js";

const OWNER = "Main";
const COMMIT_COMMAND = "fence-generation";
const RELEASE_COMMAND = "release-final";
const REQUEST_TOOL = "request_terminal_fence";

/** Pending delayed completions per iteration, bound to the terminal generation. */
const DELAYED = 24;
/** In-process race repetitions. The sweep runs this file in >= 20 fresh processes. */
const ITERATIONS = Number(process.env.RACE_ITERATIONS ?? argValue("--iterations") ?? 24);
/** Negative-control repetitions: the pre-repair ordering must reproduce the incident. */
const CONTROLS = Number(process.env.RACE_CONTROLS ?? 3);

function argValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

// ── fake host ────────────────────────────────────────────────────────────────

/**
 * One governed session whose delivery seam mirrors OMP's real one: the manager's
 * delivery sink hands the completion to a yield queue (the `#enqueueDelivery`
 * handoff in agent-session.ts), and the queue dispatcher — the thing that
 * actually invokes the agent — refuses suppressed ids. The fence therefore has to
 * stop BOTH the queued delivery and the already-handed-off wake, exactly as in
 * production.
 */
function makeHost(sessionId, manager, counters) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const logs = [];
	const yieldQueue = [];

	const session = {
		sessionManager: { getSessionId: () => sessionId },
		asyncJobManager: manager,
		ui: { notify: (...args) => logs.push(["notify", ...args]) },
	};

	const pi = {
		logger: { warn: (...args) => logs.push(args) },
		zod: {
			object: shape => ({ shape }),
			enum: values => ({ enum: values }),
			string: () => ({ type: "string", optional: () => ({ type: "string", optional: true }) }),
		},
		pi: {
			AgentRegistry: { global: () => ({ list: () => [{ id: OWNER, session }] }) },
		},
		on: (event, fn) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(fn);
		},
		registerTool: def => tools.set(def.name, def),
		registerCommand: (name, options) => commands.set(name, { name, ...options }),
	};

	openPollWaits(pi);

	manager.registerDeliverySink(OWNER, (jobId, _text, _job) => {
		yieldQueue.push(jobId);
		return Promise.resolve();
	});

	return {
		session,
		tools,
		commands,
		logs,
		notifyLines: () => logs.filter(entry => Array.isArray(entry) && entry[0] === "notify").map(entry => entry[1]),
		/**
		 * The yield-queue dispatcher: the only place an agent invocation happens,
		 * and where OMP's own staleness contract is enforced.
		 */
		dispatchWakes() {
			const invoked = [];
			while (yieldQueue.length > 0) {
				const jobId = yieldQueue.shift();
				if (manager.isDeliverySuppressed(jobId)) {
					counters.suppressedWakes += 1;
					counters.suppressedJobIds.push(jobId);
					continue;
				}
				counters.agentInvocations += 1;
				counters.visibleOutput += 1;
				counters.seq += 1;
				counters.invocations.push({ jobId, at: Date.now(), seq: counters.seq });
				invoked.push(jobId);
			}
			return invoked;
		},
		pendingWakes: () => [...yieldQueue],
		emit: async (event, payload) => {
			const results = [];
			for (const fn of handlers.get(event) ?? []) results.push(await fn(payload, session));
			return results;
		},
	};
}

const announce = (host, jobId) =>
	host.emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: `Backgrounded as job ${jobId}; result will be delivered automatically.` }],
		isError: false,
	});

const newCounters = () => ({
	agentInvocations: 0,
	visibleOutput: 0,
	suppressedWakes: 0,
	suppressedJobIds: [],
	invocations: [],
	/**
	 * Ordering facts use a logical clock, not wall-clock milliseconds: a whole
	 * iteration runs inside one millisecond, so `Date.now()` cannot order the
	 * release against the wakes it must precede. The live runs use the
	 * extension's own millisecond stamps, which are seconds apart.
	 */
	seq: 0,
});

const snapshotFor = sessionId => waiterStateSnapshot().find(entry => entry.sessionId === sessionId);
const recordFor = (sessionId, generation) =>
	snapshotFor(sessionId)?.terminalGenerations.find(entry => entry.generation === generation);

/** One deterministic race iteration. Returns that run's measured facts. */
async function raceIteration(index, order) {
	const counters = newCounters();
	const sessionId = `race-${order}-${index}`;
	const manager = new AsyncJobManager({
		onJobComplete: () => {
			throw new Error("unowned delivery reached the default sink");
		},
		// The card requires >= 20 simultaneously pending completions; the incident
		// generation owned 59. Production caps running jobs at 15, so the harness
		// raises the cap to keep the whole batch pending at once.
		maxRunningJobs: DELAYED + 8,
	});
	const host = makeHost(sessionId, manager, counters);
	const savedAuthority = process.env[AUTHORITY_ENV];
	process.env[AUTHORITY_ENV] = "ordering-harness-controller";

	try {
		// ── (a) PRE-FINAL control: an ordinary active-task completion ──────────
		// Must be delivered normally: eliminating the race may not swallow
		// legitimate progress.
		const progressGate = Promise.withResolvers();
		const progressId = manager.register("bash", "progress work", async () => {
			await progressGate.promise;
			return "PROGRESS_DONE";
		}, { ownerId: OWNER });
		await announce(host, progressId);
		progressGate.resolve();
		await manager.getJob(progressId).promise;
		host.dispatchWakes();
		const preFinalInvocations = counters.agentInvocations;
		assert.equal(preFinalInvocations, 1, "an active task's legitimate completion must be delivered pre-terminal");

		// ── (b) the generation's pending delayed completions ──────────────────
		const gates = [];
		const delayedIds = [];
		for (let i = 0; i < DELAYED; i++) {
			const gate = Promise.withResolvers();
			gates.push(gate);
			const id = manager.register("bash", `delayed unit ${i}`, async () => {
				await gate.promise;
				return `DELAYED_${i}_DONE`;
			}, { ownerId: OWNER });
			delayedIds.push(id);
			await announce(host, id);
		}

		// ── (c) the governed agent REPORTS its terminal disposition ───────────
		const receipt = await host.tools
			.get(REQUEST_TOOL)
			.execute("call-report", { status: "PASS", reason: "card complete" }, undefined, undefined, host.session);
		assert.equal(receipt.details.committed, false, "the agent report must never commit");

		const generation = snapshotFor(sessionId).generation;

		// ── (d) the SETTLE barrier couples the report turn to the commit ──────
		const held = await host.emit("session_stop", { type: "session_stop", messages: [] });
		const blocked = held.find(result => result && result.decision === "block");
		assert.ok(blocked, "a terminal-bound generation with pending deliveries must not settle before its fence");
		assert.match(blocked.reason, /FINAL DELIVERY NOT ALLOWED YET/);
		assert.match(blocked.reason, /TERMINAL_COMMITTED → GENERATION_FENCED/);

		// ── (e) the RELEASE barrier refuses an out-of-order release ───────────
		// Probed through the sanctioned controller surface, not a test-only hook.
		await host.commands.get(RELEASE_COMMAND).handler(String(generation), host.session);
		const refusedLine = host.notifyLines().find(line => /REFUSED/.test(line));
		assert.ok(refusedLine, "the final report must not be releasable before the fence");
		assert.match(refusedLine, /FINAL_DELIVERY_BARRIER_CLOSED/);
		assert.match(refusedLine, /TERMINAL_COMMITTED then GENERATION_FENCED then FINAL_DELIVERY_ALLOWED/);

		// ── (f) the transition-window completion ─────────────────────────────
		// One completion matures exactly at the transition: it is `completed` and
		// its wake is already on the yield queue when the fence commits. This is
		// the shape that escaped in the incident.
		gates[0].resolve();
		await manager.getJob(delayedIds[0]).promise;
		assert.equal(manager.getJob(delayedIds[0]).status, "completed");
		assert.ok(
			host.pendingWakes().includes(delayedIds[0]),
			"the transition-window completion's wake must be queued at commit time",
		);
		// Causal bookkeeping: exactly which jobs finished before the transition.
		const completedBeforeFence = delayedIds.filter(id => manager.getJob(id).status === "completed").length;

		let fenceAt;
		let finalReleaseAt;
		let releaseSeq;
		if (order === "legacy") {
			// The pre-repair ordering: the report is released first, and the fence
			// is committed afterwards. This is the incident, reproduced.
			releaseSeq = counters.seq;
			finalReleaseAt = Date.now();
			fenceAt = Number.POSITIVE_INFINITY;
		} else {
			// ── (g) THE ORDERED TERMINAL TRANSITION ──────────────────────────
			await host.commands.get(COMMIT_COMMAND).handler("PASS card complete", host.session);
			const record = recordFor(sessionId, generation);
			assert.ok(record, "the ordered transition must establish terminal state for the generation");
			assert.deepEqual(record.steps, TERMINAL_FENCE_ORDER, "every step must be present, in order");
			assert.equal(record.terminalCommitted, true);
			assert.equal(record.fenced, true);
			assert.equal(record.finalDeliveryAllowed, true);
			assert.ok(record.terminalCommittedAt <= record.fenceAt, "the fence must not precede the commit");
			assert.ok(record.fenceAt <= record.invalidatedAt, "invalidation must follow the fence");
			assert.ok(record.invalidatedAt <= record.terminalStateAt, "terminal state must follow invalidation");
			assert.ok(record.terminalStateAt <= record.gateOpenedAt, "the gate must open last");
			assert.equal(
				record.invalidatedJobIds.length,
				DELAYED + 1,
				"every job bound to the generation must be invalidated (delayed + progress)",
			);

			// ── (h) release through the barrier ─────────────────────────────
			await host.commands.get(RELEASE_COMMAND).handler(String(generation), host.session);
			const released = recordFor(sessionId, generation);
			assert.ok(released.finalReleaseAt, "the release must be stamped once the barrier is open");
			assert.ok(released.fenceAt <= released.finalReleaseAt, "FENCE_BEFORE_FINAL must hold");
			fenceAt = released.fenceAt;
			finalReleaseAt = released.finalReleaseAt;
			// A generation releases its final report exactly once.
			const firstReleaseAt = released.finalReleaseAt;
			await host.commands.get(RELEASE_COMMAND).handler(String(generation), host.session);
			assert.equal(
				recordFor(sessionId, generation).finalReleaseAt,
				firstReleaseAt,
				"a second release must not move the release instant",
			);
			assert.ok(
				host.notifyLines().some(line => /FINAL_DELIVERY_ALREADY_RELEASED/.test(line)),
				"a duplicate release must be refused",
			);
			releaseSeq = counters.seq;
		}

		// Wakes handed off before the release point are dispatched here: any the
		// fence covers must be suppressed, and none may invoke the agent.
		host.dispatchWakes();

		// ── (i) the remaining late completions ───────────────────────────────
		for (let i = 1; i < DELAYED; i++) gates[i].resolve();
		await Promise.all(delayedIds.map(id => manager.getJob(id).promise));
		await manager.drainDeliveries({ timeoutMs: 4000 });
		host.dispatchWakes();
		await Bun.sleep(50);
		host.dispatchWakes();

		const lateCompletions = delayedIds.filter(id => {
			const job = manager.getJob(id);
			return job && (job.status === "completed" || job.status === "failed");
		}).length;
		// Late = physically finished AFTER the transition. Measured causally from
		// the completions observed before the commit, not from millisecond stamps
		// (the whole iteration runs inside one millisecond).
		const lateAfterFence = lateCompletions - completedBeforeFence;
		const postFinal = counters.invocations.filter(entry => entry.seq > releaseSeq);
		const snapshot = snapshotFor(sessionId);

		return {
			sessionId,
			order,
			generation,
			fenceAt,
			finalReleaseAt,
			fenceBeforeFinal: fenceAt <= finalReleaseAt,
			preFinalInvocations,
			lateCompletions,
			lateAfterFence,
			suppressedWakes: counters.suppressedWakes,
			transitionWakeSuppressed: counters.suppressedJobIds.includes(delayedIds[0]),
			queuedDroppedAtFence: recordFor(sessionId, generation)?.suppressedQueuedDeliveries ?? null,
			residualDeliveryQueue: manager.getDeliveryState().queued,
			postFinalInvocations: postFinal.length,
			postFinalVisible: postFinal.length,
			postFinalJobIds: postFinal.map(entry => entry.jobId),
			settleBarrierBlocks: snapshot.barrier.settleBlocks,
			releaseRefusals: snapshot.barrier.refusedReleases,
			barrierClosedRefusals: host.notifyLines().filter(line => /FINAL_DELIVERY_BARRIER_CLOSED/.test(line)).length,
			duplicateReleaseRefusals: host.notifyLines().filter(line => /FINAL_DELIVERY_ALREADY_RELEASED/.test(line)).length,
			releases: snapshot.barrier.released,
		};
	} finally {
		if (savedAuthority === undefined) delete process.env[AUTHORITY_ENV];
		else process.env[AUTHORITY_ENV] = savedAuthority;
	}
}

// ── report ──────────────────────────────────────────────────────────────────
const runs = [];
const failures = [];
for (let i = 0; i < ITERATIONS; i++) {
	const run = await raceIteration(i, "ordered");
	runs.push(run);
	if (!run.fenceBeforeFinal) failures.push(`run ${i}: FENCE_BEFORE_FINAL=NO`);
	if (run.postFinalInvocations !== 0) failures.push(`run ${i}: POST_FINAL_AGENT_INVOCATIONS=${run.postFinalInvocations}`);
	if (run.postFinalVisible !== 0) failures.push(`run ${i}: POST_FINAL_VISIBLE_OUTPUT=${run.postFinalVisible}`);
	if (run.lateAfterFence <= 0) failures.push(`run ${i}: LATE_COMPLETIONS=${run.lateAfterFence} (vacuous run)`);
	if (run.lateCompletions !== DELAYED) failures.push(`run ${i}: recorded completions=${run.lateCompletions} != ${DELAYED}`);
	if (run.preFinalInvocations !== 1) failures.push(`run ${i}: PRE_FINAL_DELIVERY=${run.preFinalInvocations} != 1`);
	if (run.settleBarrierBlocks !== 1) failures.push(`run ${i}: settle barrier holds=${run.settleBarrierBlocks} != 1`);
	if (run.barrierClosedRefusals !== 1) {
		failures.push(`run ${i}: pre-commit release refusals=${run.barrierClosedRefusals} != 1`);
	}
	if (run.duplicateReleaseRefusals !== 1) {
		failures.push(`run ${i}: duplicate-release refusals=${run.duplicateReleaseRefusals} != 1`);
	}
	if (run.releases !== 1) failures.push(`run ${i}: the final report was not released exactly once`);
	if (!run.transitionWakeSuppressed) {
		failures.push(`run ${i}: the transition-window completion's already-handed-off wake was not suppressed`);
	}
	if (run.residualDeliveryQueue !== 0) failures.push(`run ${i}: residual queued deliveries=${run.residualDeliveryQueue}`);
}

// ── negative control: the pre-repair ordering must reproduce the incident ────
// Without this, POST_FINAL_* = 0 could be an artefact of the harness rather than
// of the fence.
const controls = [];
for (let i = 0; i < CONTROLS; i++) controls.push(await raceIteration(i, "legacy"));
const controlEscapes = controls.reduce((total, run) => total + run.postFinalInvocations, 0);
if (controlEscapes === 0) {
	failures.push("negative control did not reproduce the race — POST_FINAL_* = 0 is not evidence");
}
if (!controls.every(run => run.postFinalInvocations > 0)) {
	failures.push(`negative control produced no post-final wake in some runs: ${JSON.stringify(controls.map(run => run.postFinalInvocations))}`);
}
if (controls.some(run => run.preFinalInvocations !== 1)) {
	failures.push("negative control altered the pre-final delivery path");
}

const summary = {
	CARD: "AEGISFLOW_OMP_TERMINAL_FENCE_ORDERING_REPAIR_1",
	ORDER: TERMINAL_FENCE_ORDER,
	BARRIER_BLOCK_LIMIT,
	PID: process.pid,
	PENDING_COMPLETIONS: DELAYED,
	RACE_ITERATIONS: runs.length,
	NEGATIVE_CONTROL_RUNS: controls.length,
	FENCE_BEFORE_FINAL: runs.every(run => run.fenceBeforeFinal) ? "YES" : "NO",
	POST_FINAL_AGENT_INVOCATIONS: runs.reduce((total, run) => total + run.postFinalInvocations, 0),
	POST_FINAL_VISIBLE_OUTPUT: runs.reduce((total, run) => total + run.postFinalVisible, 0),
	LATE_COMPLETIONS_MIN: Math.min(...runs.map(run => run.lateAfterFence)),
	LATE_COMPLETIONS_TOTAL: runs.reduce((total, run) => total + run.lateAfterFence, 0),
	RECORDED_COMPLETIONS_TOTAL: runs.reduce((total, run) => total + run.lateCompletions, 0),
	SUPPRESSED_WAKES_TOTAL: runs.reduce((total, run) => total + run.suppressedWakes, 0),
	TRANSITION_WAKE_SUPPRESSED: runs.every(run => run.transitionWakeSuppressed) ? "YES" : "NO",
	RESIDUAL_DELIVERY_QUEUE: runs.reduce((total, run) => total + run.residualDeliveryQueue, 0),
	PRE_FINAL_DELIVERY: runs.every(run => run.preFinalInvocations === 1) ? "PASS" : "FAIL",
	SETTLE_BARRIER_HELD: runs.every(run => run.settleBarrierBlocks === 1) ? "YES" : "NO",
	RELEASE_BARRIER_REFUSED: runs.every(run => run.barrierClosedRefusals === 1) ? "YES" : "NO",
	DUPLICATE_RELEASE_REFUSED: runs.every(run => run.duplicateReleaseRefusals === 1) ? "YES" : "NO",
	NEGATIVE_CONTROL_POST_FINAL_INVOCATIONS: controlEscapes,
	NEGATIVE_CONTROL_REPRODUCED: controlEscapes > 0 ? "YES" : "NO",
	SAMPLE_RUN: runs[0],
	SAMPLE_CONTROL: controls[0],
	FAILURES: failures,
};
console.log(JSON.stringify(summary, null, 2));

const jsonPath = argValue("--json");
if (jsonPath) await Bun.write(jsonPath, JSON.stringify(summary, null, 2));

console.log(
	failures.length === 0
		? `ORDERING_ACCEPTANCE=PASS iterations=${runs.length} late=${summary.LATE_COMPLETIONS_TOTAL} suppressed=${summary.SUPPRESSED_WAKES_TOTAL}`
		: `ORDERING_ACCEPTANCE=FAIL ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
