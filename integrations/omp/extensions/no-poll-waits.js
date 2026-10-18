// no-poll-waits.mjs — OMP extension: waiter lifecycle + terminal notification fence.
//
// CARD = AEGISFLOW_OMP_WAITER_LIFECYCLE_AND_NOTIFICATION_REPAIR_1
//        AEGISFLOW_OMP_TERMINAL_FENCE_AUTHORITY_REPAIR_1
//        AEGISFLOW_OMP_TERMINAL_FENCE_ORDERING_REPAIR_1
//
// Confirmed root cause (AEGISFLOW_BACKGROUND_WAITER_FANOUT_ROOT_CAUSE_1, evidence
// from session <session-id-redacted>):
//
//   Agent repeats discrete foreground `sleep N; date; pgrep …; echo "(empty=done)"`
//   → each does no work, so each outlives the 60s `bash.autoBackground.thresholdMs`
//   → OMP converts each FOREGROUND call into a real background JOB *after* the
//     `tool_call` hook has already run (the previous guard only looked at
//     `input.async === true`, so it never saw them)
//   → N waiters → N completions → N late `async-result` wakes
//   → deliveries outlive the task's terminal state → stale Agent reinvocation.
//
// Three repairs live here, all on OMP's supported extension seam:
//
//   1. WAIT STRATEGY / NO-POLL-WAITS — a poll-only bash command (sleep + status
//      checks / sleep + for-loop / sleep + date+ps wrappers) is REFUSED, whether
//      or not `async` was requested, and told to use the harness's automatic
//      completion delivery, the native `wait` tool, or `proc://`/`agent://`.
//      Real work that merely contains a legitimate sleep stays allowed.
//   2. AUTO-BACKGROUND GATE — the refusal happens in `tool_call`, i.e. BEFORE
//      OMP can promote the call to a background job, so the post-hook
//      auto-background can never become a policy bypass. Admitted commands that
//      do poll-like work get their timeout clamped under the threshold.
//   3. TERMINAL FENCE — every background job is bound to (session, run
//      generation). When the generation terminalizes (PASS/HOLD/FAIL/CANCELLED,
//      committed by trusted CONTROLLER authority or observed at a genuinely
//      terminal `agent_end`), its pending deliveries are suppressed: late
//      completions may still update the job registry and be readable via
//      `proc://`, but they can never re-enter the transcript or invoke the
//      Agent. A new task in the same session runs in a new generation and is
//      unaffected.
//
// The fence reuses OMP's own staleness contract: the session's `async-result`
// yield-queue dispatcher already treats `manager.isDeliverySuppressed(jobId)` as
// stale (agent-session.ts), and `#enqueueDelivery` refuses suppressed ids, so one
// `acknowledgeDeliveries([...])` closes both the queued-delivery path and the
// already-enqueued follow-up path at once.
//
// 4. TERMINAL-FENCE AUTHORITY (AEGISFLOW_OMP_TERMINAL_FENCE_AUTHORITY_REPAIR_1) —
//    the governed Agent may REPORT completion but MUST NOT be able to declare its
//    own generation terminal at the delivery layer, and MUST NOT be able to
//    suppress a delivery the still-active task is entitled to. The previous
//    revision exposed `fence_background_waiters` directly in the Agent tool
//    vocabulary, so a governed model could (and, in a measured run, did) land the
//    operative fence *pre-terminal*. Enforcement is mechanical, not advisory:
//
//      * AGENT SURFACE — no tool that can commit a fence is registered. The Agent
//        gets `request_terminal_fence` instead: it records a REQUEST carrying the
//        disposition (REPORT/REQUEST authority), and in every case — PASS, HOLD,
//        FAIL, CANCELLED — returns `committed: false` without touching a single
//        delivery. A tool input string can never acquire terminal authority.
//      * LEGACY NAME — the `tool_call` hook refuses `fence_background_waiters`
//        outright (fail closed), so neither a stale model turn nor a third-party
//        extension re-registering that name can reach the commit primitive.
//      * CONTROLLER SURFACE — the same `fenceGeneration()` primitive, reachable
//        only through the host prompt-command channel (`/fence-generation
//        <STATUS> [reason]`), which the governed model cannot dispatch into its
//        own session, and only while the process carries the controller's
//        explicit capability `OMP_TERMINAL_FENCE_AUTHORITY` (set by the
//        orchestrator that launched the governed process). Absent capability =>
//        COMMIT DENIED, generation stays active.
//
//    The automatic `agent_end` leg is host-observed terminality (the session
//    settled with no continuation and no outstanding unsuppressed async wake),
//    never an Agent declaration, and it stands itself down or fires whether or
//    not the model asked for anything.
//
// 5. TERMINAL-FENCE ORDERING (AEGISFLOW_OMP_TERMINAL_FENCE_ORDERING_REPAIR_1) —
//    the terminal result and the final user-visible report were delivered by two
//    independent paths, so the fence could land *after* the report it was meant
//    to silence. Measured (session 01a0d90c-…): report visible 16:41:53.189Z, a
//    late `bg_107` completion delivered 16:48:10.838Z, the agent re-invoked into
//    a stale no-op turn, and only then a fence at 16:48:16.873Z invalidating 59
//    pending deliveries. The commit was correct; its POSITION was not.
//
//    Every terminal transition now completes in one ordered, synchronous
//    sequence — TERMINAL_COMMITTED → GENERATION_FENCED →
//    DELIVERIES_INVALIDATED → TERMINAL_GENERATION_STATE →
//    FINAL_DELIVERY_ALLOWED — with no `await` between the steps, so no delivery
//    callback, stop-hook pass or host command can observe a half-applied
//    transition or a release that precedes its fence. Two enforcement points:
//
//      * RELEASE BARRIER — `releaseFinalResponse()` is the only sanctioned
//        release path for a governed process, and it REFUSES
//        (`FINAL_DELIVERY_BARRIER_CLOSED`) unless the generation is both
//        TERMINAL_COMMITTED and GENERATION_FENCED. A report cannot be handed to
//        the user ahead of the fence that silences its deliveries.
//      * SETTLE BARRIER — the final response generation and the controller's
//        commit are different events, so `session_stop` couples them: while a
//        generation is terminal-BOUND (a disposition is on record) and still
//        owns pending deliveries whose fence is uncommitted, the settle is held
//        once and the run cannot release its final result. A controller that
//        never commits gets the run back after the bounded hold, and that is
//        recorded as an ordering violation — never claimed as a suppression.
//
//    Arming the barrier fences nothing: an active task's legitimate completions
//    keep being delivered right up to the controller's commit.

import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	WAIT_STRATEGY_GUIDE,
	classifyBashWait,
	decideBashWait,
} from "./lib/poll-wait-policy.js";

/** Terminal dispositions a logical task generation can reach. */
export const TERMINAL_STATUSES = Object.freeze(["PASS", "HOLD", "FAIL", "CANCELLED"]);

/**
 * The order a terminal transition MUST follow.
 *
 * Steps 1–4 complete before the final user-visible release is permitted (step
 * 5). The failure this pins down: a generation's final report was released, and
 * the fence that silences its pending deliveries was committed afterwards — so a
 * completion could still land between the two, wake the agent and publish a
 * stale report (measured: session 01a0d90c-…, report visible 16:41:53.189Z, a
 * late `bg_107` delivery at 16:48:10.838Z, then the fence at 16:48:16.873Z
 * invalidating 59 jobs).
 */
export const TERMINAL_FENCE_ORDER = Object.freeze([
	"TERMINAL_COMMITTED",
	"GENERATION_FENCED",
	"DELIVERIES_INVALIDATED",
	"TERMINAL_GENERATION_STATE",
	"FINAL_DELIVERY_ALLOWED",
]);

/**
 * How many times the settle may be held while a declared-but-uncommitted
 * terminal generation still owns pending deliveries. One hold is enough for a
 * controller that is already committing; a controller that never commits gets
 * its run back with `BARRIER_RELEASE_ON_CAP` recorded, and the extension makes
 * no terminal-suppression claim for that generation.
 */
export const BARRIER_BLOCK_LIMIT = 1;

/**
 * Who is allowed to commit a terminal fence.
 *
 * `agent-request` is the most a governed model can do: it records the
 * disposition and commits nothing.
 */
export const TERMINAL_AUTHORITIES = Object.freeze({
	AGENT_REQUEST: "agent-request",
	CONTROLLER_COMMAND: "controller-command",
	HOST_AGENT_END: "host-agent-end",
});

/** The commit primitive's only Agent-reachable name is NOT a tool: it is a tool
 *  name we refuse, so a stale model turn or a third-party extension re-registering
 *  it cannot reach `fenceGeneration()`. */
const LEGACY_FENCE_TOOL = "fence_background_waiters";
/** Agent-reachable REPORT/REQUEST tool. Cannot commit a fence. */
const REQUEST_TOOL = "request_terminal_fence";
/** Host-only controller command that commits the fence. */
const COMMIT_COMMAND = "fence-generation";
/** Host-only controller command that releases the final report through the barrier. */
const RELEASE_COMMAND = "release-final";
/**
 * Controller capability marker. The orchestrator that launches a governed
 * process sets this deliberately; without it no commit is possible, so an OMP
 * process nobody is governing cannot be closed out by a fence at all.
 */
export const AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY";

const BACKGROUND_NOTICE_RE = /Backgrounded (?:early to handle an incoming message; the command keeps running\.\s*)?as job ([\w.-]+)/;

/** Per-session waiter bookkeeping. In-memory: a fence is a runtime decision. */
const sessions = new Map();

function stateFor(sessionId) {
	let state = sessions.get(sessionId);
	if (!state) {
		state = {
			sessionId,
			generation: 1,
			/** jobId -> { generation, label, startTime } */
			jobs: new Map(),
			/** generations whose pending deliveries are fenced */
			fenced: new Set(),
			blocked: 0,
			allowed: 0,
			fenceCalls: 0,
			fencedJobIds: [],
			/** Agent-declared completion reports. Recorded, never authoritative. */
			terminalRequests: [],
			/** Commit attempts denied for lack of controller authority. */
			commitDenials: [],
			/** Commit attempts refused because the name is not Agent-reachable. */
			agentFenceAttempts: [],
			/** generation -> established terminal state (ordered steps 1–4 done) */
			terminalGenerations: new Map(),
			/** One record per committed terminal transition, with per-step stamps. */
			orderingLog: [],
			/** Declared-but-uncommitted terminal dispositions, per generation. */
			pendingTerminals: [],
			/** Final-delivery barrier counters. */
			barrier: {
			opened: 0,
			refusedReleases: 0,
			settleBlocks: 0,
			released: 0,
			releaseOnCap: 0,
			heldGenerations: [],
			lastReleasedGeneration: null,
		},
		};
		sessions.set(sessionId, state);
	}
	return state;
}

/** Tolerate hand-built states (diagnostics, direct primitive calls). */
function ensureOrdering(state) {
	if (!(state.terminalGenerations instanceof Map)) state.terminalGenerations = new Map();
	if (!Array.isArray(state.orderingLog)) state.orderingLog = [];
	if (!Array.isArray(state.pendingTerminals)) state.pendingTerminals = [];
	if (!Array.isArray(state.barrier.heldGenerations)) state.barrier.heldGenerations = [];
	if (!state.barrier || typeof state.barrier !== "object") {
		state.barrier = {
			opened: 0,
			refusedReleases: 0,
			settleBlocks: 0,
			released: 0,
			releaseOnCap: 0,
			heldGenerations: [],
			lastReleasedGeneration: null,
		};
	}
	return state;
}

/** Resolve this session's AsyncJobManager through the process-global agent registry. */
function resolveJobManager(pi, sessionId) {
	try {
		const registry = pi.pi?.AgentRegistry?.global?.();
		if (!registry) return undefined;
		for (const ref of registry.list()) {
			const session = ref.session;
			if (!session) continue;
			let refSessionId;
			try {
				refSessionId = session.sessionManager?.getSessionId?.();
			} catch {
				continue;
			}
			if (refSessionId === sessionId && session.asyncJobManager) return session.asyncJobManager;
		}
	} catch (error) {
		pi.logger?.warn?.("no-poll-waits: job manager lookup failed", { error: String(error) });
	}
	return undefined;
}

function recordJobStart(state, jobId, label) {
	if (!jobId) return;
	const existing = state.jobs.get(jobId);
	if (existing) return;
	state.jobs.set(jobId, { generation: state.generation, label: label ?? "", startTime: Date.now() });
}

/**
 * Fence a generation: suppress every bound job's pending delivery.
 *
 * This is the ONLY place a generation is closed. It is reachable from exactly
 * two seams, neither of which the governed Agent can drive:
 *   - `commitTerminalFence()` (controller command, gated by {@link AUTHORITY_ENV});
 *   - the host-observed terminal `agent_end` leg.
 *
 * @returns {{ generation: number, jobIds: string[], suppressed: number, reason: string }}
 */
function fenceGeneration(pi, state, manager, status, reason, authority = "unknown") {
	const generation = state.generation;
	const jobIds = [];
	for (const [jobId, binding] of state.jobs) {
		if (binding.generation === generation) jobIds.push(jobId);
	}
	state.fenced.add(generation);
	const fenceAt = Date.now();
	let suppressed = 0;
	if (manager && jobIds.length > 0) {
		try {
			suppressed = manager.acknowledgeDeliveries(jobIds);
		} catch (error) {
			pi.logger?.warn?.("no-poll-waits: delivery fence failed", { error: String(error), jobIds });
		}
	}
	const invalidatedAt = Date.now();
	// Advance: subsequent work in this session runs in a fresh generation, so a
	// late completion from the fenced run can never be attributed to it.
	state.generation += 1;
	state.fenceCalls += 1;
	state.fencedJobIds = jobIds;
	pi.logger?.warn?.("no-poll-waits: generation fenced", {
		sessionId: state.sessionId,
		generation,
		status: status ?? null,
		reason: reason ?? null,
		authority,
		jobIds,
		suppressed,
	});
	return { generation, jobIds, suppressed, reason: reason ?? "terminal", authority, fenced: true, fenceAt, invalidatedAt };
}

/** True when the launching controller granted this process terminal-fence authority. */
export function controllerAuthorityPresent(env = globalThis.process?.env) {
	const value = env?.[AUTHORITY_ENV];
	return typeof value === "string" && value.length > 0;
}

/**
 * Agent-facing REPORT/REQUEST. Records the disposition the governed model claims
 * for its own generation; commits nothing, suppresses nothing.
 *
 * It does declare the generation terminal-BOUND, which arms the final-delivery
 * barrier: from here the run may not release its final report while it still
 * owns pending deliveries whose fence has not been committed. Arming the barrier
 * fences nothing — every active-task completion keeps being delivered.
 */
export function requestTerminal(pi, state, status, reason) {
	ensureOrdering(state);
	const generation = state.generation;
	let pending = 0;
	for (const binding of state.jobs.values()) {
		if (binding.generation === generation) pending += 1;
	}
	const request = {
		generation,
		status: typeof status === "string" ? status : null,
		reason: typeof reason === "string" ? reason : null,
		pending,
		at: Date.now(),
	};
	state.terminalRequests.push(request);
	state.pendingTerminals = state.pendingTerminals.filter(pending => pending.generation !== generation);
	state.pendingTerminals.push({
		generation,
		status: request.status,
		reason: request.reason,
		at: request.at,
		boundJobs: pending,
		authority: TERMINAL_AUTHORITIES.AGENT_REQUEST,
	});
	pi.logger?.warn?.("no-poll-waits: terminal request recorded (not committed)", {
		sessionId: state.sessionId,
		generation,
		status: request.status,
		reason: request.reason,
		authority: TERMINAL_AUTHORITIES.AGENT_REQUEST,
		pendingDeliveriesLeftActive: pending,
		barrierArmed: pending > 0,
	});
	return request;
}

/**
 * The controller/orchestrator commit. Fail closed: without the controller's
 * capability marker and a valid disposition nothing is fenced and the generation
 * stays active, so pending deliveries continue to be delivered normally.
 */
export function commitTerminalFence(pi, state, manager, status, reason, env = globalThis.process?.env) {
	if (!controllerAuthorityPresent(env)) {
		const denial = {
			committed: false,
			denial: "CONTROLLER_AUTHORITY_ABSENT",
			generation: state.generation,
			reason: `terminal fence requires controller authority (${AUTHORITY_ENV})`,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			generation: state.generation,
			status: status ?? null,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}
	if (!TERMINAL_STATUSES.includes(status)) {
		const denial = {
			committed: false,
			denial: "INVALID_TERMINAL_STATUS",
			generation: state.generation,
			reason: `status must be one of ${TERMINAL_STATUSES.join("/")}`,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			generation: state.generation,
			status: status ?? null,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}
	return commitOrderedTerminal(pi, state, manager, status, reason, TERMINAL_AUTHORITIES.CONTROLLER_COMMAND);
}

/**
 * The ordered terminal transition: TERMINAL_COMMITTED → GENERATION_FENCED →
 * DELIVERIES_INVALIDATED → TERMINAL_GENERATION_STATE → FINAL_DELIVERY_ALLOWED.
 *
 * Every step runs in ONE synchronous body. There is no `await` between the
 * commit, the fence, the invalidation, the terminal-generation state and the
 * gate, so no delivery callback, stop-hook pass or host command can interleave
 * and observe a half-applied transition — and, above all, no release can be
 * observed between the commit and the fence. That atomicity is the barrier.
 */
function commitOrderedTerminal(pi, state, manager, status, reason, authority) {
	ensureOrdering(state);
	const generation = state.generation;
	// 1. TERMINAL_COMMITTED — the disposition becomes authoritative here.
	const terminalCommittedAt = Date.now();
	// 2-3. GENERATION_FENCED + DELIVERIES_INVALIDATED (single primitive).
	const fence = fenceGeneration(pi, state, manager, status, reason, authority);
	// 4. TERMINAL_GENERATION_STATE — the generation is now terminal, permanently.
	const terminalStateAt = Date.now();
	const record = {
		generation,
		status,
		reason: reason ?? null,
		authority,
		steps: TERMINAL_FENCE_ORDER.slice(0, 4),
		terminalCommitted: true,
		terminalCommittedAt,
		fenced: true,
		fenceAt: fence.fenceAt,
		invalidatedAt: fence.invalidatedAt,
		invalidatedJobIds: fence.jobIds,
		suppressedQueuedDeliveries: fence.suppressed,
		terminalStateAt,
		gateOpenedAt: null,
		finalDeliveryAllowed: false,
		finalReleaseAt: null,
	};
	state.terminalGenerations.set(generation, record);
	// 5. FINAL_DELIVERY_ALLOWED — only now may the final report be released.
	record.gateOpenedAt = Date.now();
	record.finalDeliveryAllowed = true;
	record.steps = TERMINAL_FENCE_ORDER.slice();
	state.barrier.opened += 1;
	state.pendingTerminals = state.pendingTerminals.filter(pending => pending.generation !== generation);
	state.orderingLog.push(record);
	pi.logger?.warn?.("no-poll-waits: terminal transition committed in order", {
		sessionId: state.sessionId,
		generation,
		status,
		authority,
		order: record.steps,
		terminalCommittedAt,
		fenceAt: record.fenceAt,
		invalidatedAt: record.invalidatedAt,
		terminalStateAt: record.terminalStateAt,
		gateOpenedAt: record.gateOpenedAt,
		invalidatedJobs: record.invalidatedJobIds.length,
		suppressedQueuedDeliveries: record.suppressedQueuedDeliveries,
		finalDeliveryAllowed: true,
	});
	return {
		committed: true,
		generation,
		jobIds: fence.jobIds,
		suppressed: fence.suppressed,
		reason: record.reason,
		authority,
		ordered: record,
		finalDeliveryAllowed: true,
		FENCE_BEFORE_FINAL: record.fenceAt <= record.gateOpenedAt,
	};
}

/**
 * FINAL_DELIVERY_ALLOWED — true only for a generation whose ordered transition
 * completed both TERMINAL_COMMITTED and GENERATION_FENCED.
 */
export function finalDeliveryAllowedFor(state, generation = state.generation) {
	const record = ensureOrdering(state).terminalGenerations.get(generation);
	return Boolean(record?.terminalCommitted && record?.fenced && record?.finalDeliveryAllowed);
}

/**
 * The barrier-gated final release. A governed controller releases its final
 * user-visible report through this function and nowhere else: while the ordering
 * precondition is unmet the release is REFUSED, so the report can never be
 * delivered ahead of the fence that silences the generation's pending
 * deliveries.
 */
export function releaseFinalResponse(pi, state, generation, deliver) {
	ensureOrdering(state);
	const record = state.terminalGenerations.get(generation);
	const missing = [];
	if (!record?.terminalCommitted) missing.push("TERMINAL_COMMITTED");
	if (!record?.fenced) missing.push("GENERATION_FENCED");
	if (!record?.finalDeliveryAllowed) missing.push("FINAL_DELIVERY_ALLOWED");
	if (missing.length > 0) {
		state.barrier.refusedReleases += 1;
		const refusal = {
			released: false,
			denial: "FINAL_DELIVERY_BARRIER_CLOSED",
			generation,
			missing,
			reason: `final report release requires ${missing.join(" then ")} first`,
		};
		pi?.logger?.warn?.("no-poll-waits: final report release refused", {
			sessionId: state.sessionId,
			generation,
			activeGeneration: state.generation,
			...refusal,
		});
		return refusal;
	}
	if (record.finalReleaseAt !== null && record.finalReleaseAt !== undefined) {
		state.barrier.refusedReleases += 1;
		const refusal = {
			released: false,
			denial: "FINAL_DELIVERY_ALREADY_RELEASED",
			generation,
			missing: [],
			finalReleaseAt: record.finalReleaseAt,
			reason: `run generation ${generation} already released its final report`,
		};
		pi?.logger?.warn?.("no-poll-waits: final report release refused", {
			sessionId: state.sessionId,
			generation,
			activeGeneration: state.generation,
			...refusal,
		});
		return refusal;
	}
	record.finalReleaseAt = Date.now();
	record.steps = TERMINAL_FENCE_ORDER.slice();
	state.barrier.released += 1;
	state.barrier.lastReleasedGeneration = generation;
	const value = typeof deliver === "function" ? deliver(record) : undefined;
	pi?.logger?.warn?.("no-poll-waits: final report released", {
		sessionId: state.sessionId,
		generation,
		status: record.status,
		fenceAt: record.fenceAt,
		finalReleaseAt: record.finalReleaseAt,
		fenceBeforeFinal: record.fenceAt <= record.finalReleaseAt,
	});
	return {
		released: true,
		generation,
		fenceAt: record.fenceAt,
		finalReleaseAt: record.finalReleaseAt,
		FENCE_BEFORE_FINAL: record.fenceAt <= record.finalReleaseAt,
		value,
	};
}

/**
 * Does this generation still own a delivery that could re-wake the run?
 *
 * The job-binding map is a record of every job the generation ever announced and
 * is never pruned, so it is reported for diagnostics only: a generation whose
 * jobs have all been delivered has nothing left to silence and must not be held.
 * The manager's own state is authoritative — running unsuppressed jobs and queued
 * deliveries are exactly what a wake would come from.
 */
function pendingDeliveriesFor(pi, state, sessionId) {
	const generation = state.generation;
	let bound = 0;
	for (const binding of state.jobs.values()) {
		if (binding.generation === generation) bound += 1;
	}
	const manager = resolveJobManager(pi, sessionId);
	if (!manager) return { bound, live: 0, queued: 0, pending: false };
	let live = 0;
	let queued = 0;
	try {
		live = manager.getRunningJobs().filter(job => !manager.isDeliverySuppressed(job.id)).length;
		queued = manager.getDeliveryState().queued;
	} catch {
		return { bound, live: 0, queued: 0, pending: false };
	}
	return { bound, live, queued, pending: live > 0 || queued > 0 };
}

export default function (pi) {
	pi.on("session_start", (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
		stateFor(sessionId);
	});

	// (1)+(2) Wait-strategy enforcement and the auto-background gate. This runs at
	// arg-prep time, before concurrency scheduling and before any auto-background
	// conversion, so refusing here prevents the job from ever being created.
	pi.on("tool_call", (event, ctx) => {
		// (4) AUTHORITY FENCE, first line. A terminal-commit primitive must never be
		// reachable from the governed Agent's tool vocabulary — not from a stale
		// model turn replaying the old call, and not from a third-party extension
		// that re-registers the name. Refuse it by name, before anything else.
		if (event.toolName === LEGACY_FENCE_TOOL) {
			const state = stateFor(ctx?.sessionManager?.getSessionId?.() ?? "unknown");
			state.agentFenceAttempts.push({ toolName: event.toolName, at: Date.now() });
			pi.logger?.warn?.("no-poll-waits: agent terminal-fence attempt denied", {
				sessionId: state.sessionId,
				toolName: event.toolName,
				generation: state.generation,
				authority: TERMINAL_AUTHORITIES.AGENT_REQUEST,
			});
			return {
				block: true,
				reason:
					`DENIED: "${LEGACY_FENCE_TOOL}" is not Agent-reachable. A governed task may report its ` +
					`completion with the ${REQUEST_TOOL} tool (or its FINAL message), but declaring the run ` +
					`generation terminal — and thereby invalidating pending background deliveries — is ` +
					`controller/orchestrator authority only. Jobs started by the active task keep delivering; ` +
					`do not retry this call, and do not attempt to fence by any other means.`,
			};
		}
		if (event.toolName !== "bash") return undefined;
		const input = event.input ?? {};
		const command = typeof input.command === "string" ? input.command : "";
		if (!command) return undefined;

		const thresholdMs = DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS;
		const verdict = decideBashWait(command, {
			async: input.async === true,
			timeoutMs: typeof input.timeout === "number" ? input.timeout * 1000 : undefined,
			thresholdMs,
		});
		const state = stateFor(ctx?.sessionManager?.getSessionId?.() ?? "unknown");

		if (verdict.action === "block") {
			state.blocked += 1;
			return {
				block: true,
				reason:
					`BLOCKED: poll-only wait command (${verdict.reason}). ` +
					`A command whose only purpose is to sleep and re-check state becomes a background ` +
					`waiter — each one delivers its own completion, and those deliveries can wake the run ` +
					`after the task has already gone terminal. ${WAIT_STRATEGY_GUIDE}`,
			};
		}
		state.allowed += 1;
		// Admitted poll-like work (a real command that also sleeps) keeps its
		// timeout clamped under the auto-background threshold so it can never drift
		// into a background job mid-flight.
		if (verdict.sleepMs > 0 && verdict.timeoutMs !== undefined) {
			const requestedSec = typeof input.timeout === "number" ? input.timeout : undefined;
			const clampedSec = Math.max(1, Math.floor(verdict.timeoutMs / 1000));
			if (requestedSec === undefined || requestedSec > clampedSec) {
				return { input: { ...input, timeout: clampedSec } };
			}
		}
		return undefined;
	});

	// Bind each background job to the generation that created it. The job id is
	// only knowable from the tool result notice, which is where OMP announces it.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
		const state = stateFor(sessionId);
		const content = event.content;
		const text = Array.isArray(content)
			? content
					.filter(part => part?.type === "text" && typeof part.text === "string")
					.map(part => part.text)
					.join("\n")
			: typeof content === "string"
				? content
				: "";
		const match = BACKGROUND_NOTICE_RE.exec(text);
		if (match) recordJobStart(state, match[1], "");
		return undefined;
	});

	// (3) Terminal fence, automatic leg: a genuinely terminal settle (no scheduled
	// continuation) ends this run generation. OMP already defers the terminal
	// settle while an unsuppressed async wake is outstanding, so anything fenced
	// here is a delivery that could only ever arrive after the run ended.
	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue) return undefined;
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
		const state = stateFor(sessionId);
		const manager = resolveJobManager(pi, sessionId);
		const pending = [...state.jobs.values()].filter(binding => binding.generation === state.generation).length;
		if (pending === 0) return undefined;
		fenceGeneration(
			pi,
			state,
			manager,
			"TERMINAL",
			"agent_end settled without continuation",
			TERMINAL_AUTHORITIES.HOST_AGENT_END,
		);
		return undefined;
	});

	// (5) FINAL-DELIVERY BARRIER. The final response generation and the
	// controller's terminal commit are different events: OMP settles the run,
	// the controller commits the fence from the host channel. This hook is the
	// explicit coupling between them.
	//
	// When the active generation is terminal-BOUND (a disposition is on record)
	// and still owns pending deliveries whose fence has not been committed, the
	// settle is REFUSED — the run may not release its final result ahead of the
	// fence that silences it. It is released the instant the ordered transition
	// completes, or on the bounded cap, which is recorded as an ordering
	// violation rather than claimed as a suppression.
	pi.on("session_stop", (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
		const state = stateFor(sessionId);
		ensureOrdering(state);
		const generation = state.generation;
		if (finalDeliveryAllowedFor(state, generation)) return undefined;
		const declared = state.pendingTerminals.find(pending => pending.generation === generation);
		if (!declared) return undefined;
		const pending = pendingDeliveriesFor(pi, state, sessionId);
		if (!pending.pending) return undefined;
		const holds = state.barrier.heldGenerations.filter(held => held === generation).length;
		if (holds >= BARRIER_BLOCK_LIMIT) {
			state.barrier.releaseOnCap += 1;
			pi.logger?.warn?.("no-poll-waits: final-delivery barrier released on cap", {
				sessionId,
				generation,
				status: declared.status,
				holds,
				pendingDeliveries: pending,
				orderingViolation: "TERMINAL_COMMIT_NOT_OBSERVED",
			});
			return undefined;
		}
		state.barrier.heldGenerations.push(generation);
		state.barrier.settleBlocks += 1;
		pi.logger?.warn?.("no-poll-waits: final-delivery barrier held the settle", {
			sessionId,
			generation,
			status: declared.status,
			authority: declared.authority,
			pendingDeliveries: pending,
			requiredOrder: TERMINAL_FENCE_ORDER,
		});
		return {
			decision: "block",
			reason:
				`FINAL DELIVERY NOT ALLOWED YET: run generation ${generation} is terminal-bound ` +
				`(${declared.status ?? "UNSPECIFIED"} reported) and still owns ${pending.live} live ` +
				`delivery(ies) / ${pending.queued} queued. The terminal transition must complete ` +
				`${TERMINAL_FENCE_ORDER.join(" → ")} BEFORE this final result is released; releasing first lets a ` +
				`late completion land between the report and the fence and re-wake the run. Commit the disposition ` +
				`on the controller channel (/fence-generation <PASS|HOLD|FAIL|CANCELLED> <reason>) and then release ` +
				`the report (/release-final).`,
		};
	});

	// (4) AGENT SURFACE — REPORT/REQUEST only. This tool exists so a governed model
	// can express "the work is done, here is my disposition", which it is entitled
	// to do. It cannot fence: no status value, no payload text, and no number of
	// calls reaches `fenceGeneration()`. Pending deliveries of the still-active
	// generation keep being delivered exactly as if the tool had not been called.
	pi.registerTool({
		name: REQUEST_TOOL,
		label: "Request Terminal Fence",
		description:
			"REPORT the governed task's terminal disposition (PASS, HOLD, FAIL or CANCELLED) for the current " +
			"run generation. This records your recommendation; it does NOT commit a terminal fence, does NOT " +
			"invalidate any pending background delivery, and does NOT stop the agent from being woken — only " +
			"the trusted controller/orchestrator can commit a terminal fence, on the host channel. Call it when " +
			"the task is finished so the controller has your disposition on record, then report to the user as " +
			"usual. Background jobs started by the active task keep delivering.",
		parameters: pi.zod.object({
			status: pi.zod.enum(["PASS", "HOLD", "FAIL", "CANCELLED"]),
			reason: pi.zod.string().optional(),
		}),
		loadMode: "essential",
		approval: "read",
		// Signature is (toolCallId, params, signal, onUpdate, ctx) — ctx is the
		// FIFTH argument, not the fourth.
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			const request = requestTerminal(pi, state, params?.status, params?.reason);
			return {
				content: [
					{
						type: "text",
						text:
							`Terminal REQUEST recorded for run generation ${request.generation} as ` +
							`${request.status ?? "UNSPECIFIED"} (committed: false). ` +
							`Pending deliveries left active: ${request.pending}. ` +
							`Only the controller/orchestrator can commit the terminal fence; until it does, ` +
							`background completions from this generation are delivered normally. Continue with ` +
							`your report to the user.`,
					},
				],
				details: { op: "request_terminal_fence", committed: false, ...request },
			};
		},
	});

	// (4) CONTROLLER SURFACE — the commit primitive, on the host prompt-command
	// channel. A governed model cannot dispatch a command into its own session
	// (commands are resolved from submitted prompt text before any agent turn), so
	// this is authority the Agent cannot forge by producing text or tool payloads.
	// The capability marker makes it fail closed for an unmanaged process.
	pi.registerCommand(COMMIT_COMMAND, {
		description:
			`Commit the run generation's terminal fence (controller/orchestrator authority only). ` +
			`Usage: /${COMMIT_COMMAND} <PASS|HOLD|FAIL|CANCELLED> [reason]`,
		handler: async (args, ctx) => {
			const raw = typeof args === "string" ? args.trim() : "";
			const [status = "", ...rest] = raw.split(/\s+/);
			const reason = rest.join(" ") || "controller terminal";
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			const manager = resolveJobManager(pi, sessionId);
			const result = commitTerminalFence(
				pi,
				state,
				manager,
				status.toUpperCase(),
				reason,
			);
			const line = result.committed
				? `Terminal fence COMMITTED for run generation ${result.generation} as ${status.toUpperCase()}. ` +
					`Pending deliveries invalidated: ${result.jobIds.length} ` +
					`(queued deliveries dropped: ${result.suppressed}). Late completions remain recorded and ` +
					`readable via proc:// but will not invoke the agent. ` +
					`Order enforced: ${TERMINAL_FENCE_ORDER.join(" → ")}. ` +
					`Final report release is now permitted (/${RELEASE_COMMAND}).`
				: `Terminal fence DENIED (${result.denial}): ${result.reason}. ` +
					`Run generation ${result.generation} remains ACTIVE; pending deliveries continue to be delivered.`;
			try {
				ctx?.ui?.notify?.(line, result.committed ? "info" : "warning");
			} catch {
				// UI is absent in print/RPC mode; the command has already taken effect.
			}
			pi.logger?.warn?.("no-poll-waits: terminal fence command", {
				sessionId,
				authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
				status: status.toUpperCase(),
				committed: result.committed,
				denial: result.denial ?? null,
			});
		},
	});

	// (5) CONTROLLER SURFACE — the barrier-gated final release. This is the only
	// sanctioned way for a governed process to hand its final report to the user:
	// it refuses while FINAL_DELIVERY_ALLOWED is false, so a report cannot be
	// delivered ahead of the fence that silences the generation's deliveries.
	pi.registerCommand(RELEASE_COMMAND, {
		description:
			`Release the run generation's final report (controller/orchestrator authority only; ` +
			`requires the ordered terminal commit). Usage: /${RELEASE_COMMAND} [generation]`,
		handler: async (args, ctx) => {
			const raw = typeof args === "string" ? args.trim() : "";
			const parsed = Number.parseInt(raw, 10);
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			const generation = Number.isFinite(parsed) ? parsed : state.generation - 1;
			const result = releaseFinalResponse(pi, state, generation);
			const line = result.released
				? `Final report RELEASED for run generation ${result.generation} at ${result.finalReleaseAt}. ` +
					`Fence committed at ${result.fenceAt} (FENCE_BEFORE_FINAL=${result.FENCE_BEFORE_FINAL}); ` +
					`late completions of this generation cannot invoke the agent.`
				: `Final report release REFUSED (${result.denial}): ${result.reason}. ` +
					`Run generation ${result.generation} may not be released to the user yet.`;
			try {
				ctx?.ui?.notify?.(line, result.released ? "info" : "warning");
			} catch {
				// UI is absent in print/RPC mode; the command has already taken effect.
			}
			pi.logger?.warn?.("no-poll-waits: final release command", {
				sessionId,
				authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
				generation,
				released: result.released,
				denial: result.denial ?? null,
			});
		},
	});
}

/** Test/diagnostic surface: current per-session waiter state. */
export function waiterStateSnapshot() {
	const out = [];
	for (const state of sessions.values()) {
		ensureOrdering(state);
		out.push({
			sessionId: state.sessionId,
			generation: state.generation,
			jobs: [...state.jobs.entries()].map(([id, binding]) => ({ id, ...binding })),
			fencedGenerations: [...state.fenced],
			blocked: state.blocked,
			allowed: state.allowed,
			fenceCalls: state.fenceCalls,
			terminalRequests: [...state.terminalRequests],
			commitDenials: [...state.commitDenials],
			agentFenceAttempts: [...state.agentFenceAttempts],
			pendingTerminals: [...state.pendingTerminals],
			terminalGenerations: [...state.terminalGenerations.entries()].map(([generation, record]) => ({ generation, ...record })),
			orderingLog: [...state.orderingLog],
			barrier: { ...state.barrier },
		});
	}
	return out;
}

export { classifyBashWait, decideBashWait };
