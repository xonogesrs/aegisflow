// no-poll-waits.mjs — OMP extension: waiter lifecycle + terminal notification fence.
//
// CARD = AEGISFLOW_OMP_WAITER_LIFECYCLE_AND_NOTIFICATION_REPAIR_1
//        AEGISFLOW_OMP_TERMINAL_FENCE_AUTHORITY_REPAIR_1
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

import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	WAIT_STRATEGY_GUIDE,
	classifyBashWait,
	decideBashWait,
} from "./lib/poll-wait-policy.js";

/** Terminal dispositions a logical task generation can reach. */
export const TERMINAL_STATUSES = Object.freeze(["PASS", "HOLD", "FAIL", "CANCELLED"]);

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
		};
		sessions.set(sessionId, state);
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
	let suppressed = 0;
	if (manager && jobIds.length > 0) {
		try {
			suppressed = manager.acknowledgeDeliveries(jobIds);
		} catch (error) {
			pi.logger?.warn?.("no-poll-waits: delivery fence failed", { error: String(error), jobIds });
		}
	}
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
	return { generation, jobIds, suppressed, reason: reason ?? "terminal", authority };
}

/** True when the launching controller granted this process terminal-fence authority. */
export function controllerAuthorityPresent(env = globalThis.process?.env) {
	const value = env?.[AUTHORITY_ENV];
	return typeof value === "string" && value.length > 0;
}

/**
 * Agent-facing REPORT/REQUEST. Records the disposition the governed model claims
 * for its own generation; commits nothing, suppresses nothing.
 */
export function requestTerminal(pi, state, status, reason) {
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
	pi.logger?.warn?.("no-poll-waits: terminal request recorded (not committed)", {
		sessionId: state.sessionId,
		generation,
		status: request.status,
		reason: request.reason,
		authority: TERMINAL_AUTHORITIES.AGENT_REQUEST,
		pendingDeliveriesLeftActive: pending,
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
	const result = fenceGeneration(pi, state, manager, status, reason, TERMINAL_AUTHORITIES.CONTROLLER_COMMAND);
	return { committed: true, ...result };
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
					`readable via proc:// but will not invoke the agent.`
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
}

/** Test/diagnostic surface: current per-session waiter state. */
export function waiterStateSnapshot() {
	const out = [];
	for (const state of sessions.values()) {
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
		});
	}
	return out;
}

export { classifyBashWait, decideBashWait };
