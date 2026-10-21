// no-poll-waits.mjs — OMP extension: waiter lifecycle + terminal notification fence.
//
// CARD = AEGISFLOW_OMP_WAITER_LIFECYCLE_AND_NOTIFICATION_REPAIR_1
//        AEGISFLOW_OMP_TERMINAL_FENCE_AUTHORITY_REPAIR_1
//        AEGISFLOW_OMP_TERMINAL_FENCE_ORDERING_REPAIR_1
//        AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1
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

import { readFileSync, unlinkSync } from "node:fs";
import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	WAIT_STRATEGY_GUIDE,
	classifyBashWait,
	decideBashWait,
} from "./lib/poll-wait-policy.js";
import {
	RESULT_KEY_ENV,
	RESULT_KEY_PATTERN,
	signResultFrame,
} from "./lib/controller-result.mjs";
import {
	adoptGeneration,
	allocateGeneration,
	createRuntimeInstanceId,
	generationAlreadyCommitted,
	recordCommitAndClaimNext,
	verifyOwnership,
} from "./lib/runtime-identity.mjs";

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
 * Host-only READ-ONLY identity command (R3).
 *
 * A controller must know `(sessionId, runtimeInstanceId, generation)` BEFORE it
 * commits, because the commit is only meaningful if it names the runtime the
 * controller means. The predecessor contract had no way to ask: the only frame
 * that carried identity was the commit result itself, so a client had to commit
 * blindly and learn the identity from the answer. That is one commit too many.
 *
 * This command mutates NOTHING — it does not fence, does not advance, does not
 * touch the ledger — and answers on the same signed channel with the same
 * identity fields, so a controller can bind first and commit second.
 */
const IDENTITY_COMMAND = "fence-identity";
/**
 * Controller capability marker. The orchestrator that launches a governed
 * process sets this deliberately; without it no commit is possible, so an OMP
 * process nobody is governing cannot be closed out by a fence at all.
 */
export const AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY";

/**
 * This process's runtime instance id (R1).
 *
 * Derived once at module load from (host fingerprint, pid, process start time,
 * random suffix). It is never read from the environment: a launcher-supplied id
 * would be visible to every child process the governed agent can spawn, and
 * this value is one of the identities a commit is checked against.
 */
export const RUNTIME_INSTANCE_ID = createRuntimeInstanceId();

/**
 * The controller's result-signing key (R5), or null when the controller did not
 * provision one.
 *
 * The launcher passes a FILE PATH; the key is read once here and the file is
 * unlinked, so the secret is never in the environment, argv, a log line, the
 * session file, or any child process's reach after load. Without a key the
 * extension still reports its result with `mac: null`, and a controller MUST
 * refuse it — an unsigned frame proves nothing about which runtime produced it.
 */
const resultKey = loadResultKey();

function loadResultKey(env = globalThis.process?.env) {
	const keyPath = env?.[RESULT_KEY_ENV];
	if (typeof keyPath !== "string" || keyPath.length === 0) return null;
	try {
		// Read+unlink in the same synchronous step so no interleaved code (an
		// extension loaded after this one) can observe the path as still present.
		const key = readFileSync(keyPath, "utf8").trim();
		// Drop the path from the environment regardless of what follows: a child
		// process the governed agent spawns inherits `process.env`, and knowing the
		// path is most of the way to reading the key.
		try {
			delete env[RESULT_KEY_ENV];
		} catch {
			// A frozen env is not a reason to keep signing.
		}
		try {
			unlinkSync(keyPath);
		} catch {
			// The key is in memory but still on disk, and any process that can read
			// that file can forge a frame this runtime would sign. Measured in
			// independent review: with the key's directory read-only, the file
			// survived and a child process read it and produced a frame that
			// verified. Fail closed: no key means no MAC, and a controller must
			// refuse an unsigned frame rather than trust it.
			return null;
		}
		return RESULT_KEY_PATTERN.test(key) ? key : null;
	} catch {
		return null;
	}
}

const BACKGROUND_NOTICE_RE = /Backgrounded (?:early to handle an incoming message; the command keeps running\.\s*)?as job ([\w.-]+)/;

/** Per-session waiter bookkeeping. In-memory: a fence is a runtime decision. */
const sessions = new Map();

/**
 * Build this runtime's state for one session, allocating its generation (R1).
 *
 * The generation is no longer keyed by session alone: every state carries this
 * process's `runtimeInstanceId`, so `(sessionId, runtimeInstanceId, generation)`
 * names exactly one runtime event even when two processes present the same
 * session id.
 *
 * When the controller also provisions a state directory the generation is
 * allocated from a durable ledger and continues across restarts (`ALLOCATED`);
 * without one it is this process's own counter (`EPHEMERAL`), which removes the
 * identity collision but not the numbering continuity. With no capability at all
 * nothing is allocated and no file is touched, exactly as before.
 */
function createState(sessionId, env = globalThis.process?.env, now = Date.now()) {
	const governed = controllerAuthorityPresent(env);
	const allocation = governed
		? allocateGeneration({ sessionId, runtimeInstanceId: RUNTIME_INSTANCE_ID, env, now })
		: {
				generation: 1,
				identityState: "EPHEMERAL",
				identityError: null,
				runtimeInstanceId: RUNTIME_INSTANCE_ID,
				ledgerPath: null,
				previousGeneration: null,
				generationDurable: false,
				allocationToken: null,
			};
	return {
		sessionId,
		/** R1: composite identity, not a session-only counter. */
		runtimeInstanceId: RUNTIME_INSTANCE_ID,
		identityState: allocation.identityState,
		identityError: allocation.identityError,
		ledgerPath: allocation.ledgerPath,
		previousGeneration: allocation.previousGeneration,
		/** True only when the ledger names this generation durably. */
		generationDurable: allocation.generationDurable === true,
		/** Names this runtime's allocation record in the ledger; re-verified before every fence. */
		allocationToken: allocation.allocationToken ?? null,
		/** null when the allocation failed closed: no generation may be committed. */
		generation: allocation.generation,
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
}

function stateFor(sessionId) {
	let state = sessions.get(sessionId);
	if (!state) {
		state = createState(sessionId);
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
	// Delivery invalidation is a SEPARATE outcome from the terminal transition.
	// `suppressed` is the count of QUEUED deliveries dropped, which is normally 0
	// even on complete success (a running job is marked suppressed, not queued),
	// so it cannot signal a failure. These two fields can.
	let deliveryFenceSucceeded = true;
	let deliveryFenceError = null;
	if (manager && jobIds.length > 0) {
		try {
			suppressed = manager.acknowledgeDeliveries(jobIds);
		} catch (error) {
			deliveryFenceSucceeded = false;
			deliveryFenceError = String(error && error.message ? error.message : error);
			pi.logger?.warn?.("no-poll-waits: delivery fence failed", {
				error: deliveryFenceError,
				jobIds,
				sessionId: state.sessionId,
				generation,
			});
		}
	} else if (!manager && jobIds.length > 0) {
		// No manager means the bound jobs could not be invalidated at all. That is
		// a failure to invalidate, not a vacuous success.
		deliveryFenceSucceeded = false;
		deliveryFenceError = "JOB_MANAGER_UNAVAILABLE";
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
		deliveryFenceSucceeded,
		deliveryFenceError,
	});
	return {
		generation,
		jobIds,
		suppressed,
		deliveryFenceSucceeded,
		deliveryFenceError,
		reason: reason ?? "terminal",
		authority,
		fenced: true,
		fenceAt,
		invalidatedAt,
	};
}

/**
 * Advance the durable identity after a fence, whichever leg committed it.
 *
 * Both the controller command and the automatic `agent_end` leg call
 * `fenceGeneration()`, which increments `state.generation`. If only the
 * controller leg claimed the new number in the ledger, the automatic leg would
 * leave the live generation unnamed while `identityState` still read ALLOCATED.
 *
 * @returns {{ error: string|null }}
 */
function advanceDurableGeneration(pi, state, committedGeneration, { status = "TERMINAL", requestId = null } = {}) {
	if (!state.ledgerPath) return { error: null, committedRecorded: false };
	const ledger = recordCommitAndClaimNext({
		ledgerPath: state.ledgerPath,
		sessionId: state.sessionId,
		runtimeInstanceId: state.runtimeInstanceId,
		generation: committedGeneration,
		status,
		requestId,
	});
	if (ledger.error) {
		// The live generation is no longer uniquely named. Say so, and stop
		// accepting commits on it.
		state.identityState = "UNWRITABLE";
		state.identityError = ledger.error;
		state.generationDurable = false;
		state.allocationToken = null;
		pi.logger?.warn?.("no-poll-waits: durable generation advance failed", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: committedGeneration,
			error: ledger.error,
		});
		return { error: ledger.error, committedRecorded: ledger.committedRecorded === true };
	}
	if (ledger.allocationToken) {
		state.allocationToken = ledger.allocationToken;
		state.generationDurable = true;
	}
	// THE LEDGER DECIDES THE LIVE NUMBER.
	//
	// `fenceGeneration()` advanced `state.generation` to `committedGeneration + 1`
	// before this ran. When a peer process on the same session already owns that
	// number, the ledger gives this runtime the next free one instead — and the
	// live state must follow it, or this runtime would keep running as a generation
	// it does not own and every later commit would be refused
	// (`GENERATION_OWNERSHIP_LOST`). Rebinding is safe here: the fence that just
	// committed invalidated the old generation's jobs, so the new generation owns
	// nothing yet.
	if (Number.isSafeInteger(ledger.nextGeneration) && state.generation !== ledger.nextGeneration) {
		pi.logger?.warn?.("no-poll-waits: live generation renumbered from the ledger", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			committedGeneration,
			previousLiveGeneration: state.generation,
			liveGeneration: ledger.nextGeneration,
		});
		state.generation = ledger.nextGeneration;
	}
	return { error: null, committedRecorded: ledger.committedRecorded === true };
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
 * Parse controller command arguments.
 *
 * Backward compatible with `/<cmd> <STATUS> [reason]`: a bare first token is the
 * disposition and everything after it is free-text reason. On top of that, the
 * controller may pin the identity it means to commit with `key=value` tokens
 * (`session=`, `runtime=`, `generation=`, `request=`), which are consumed as
 * targets instead of leaking into the reason. A target token is recognized
 * anywhere in the argument string so a controller can put them first.
 */
/**
 * Split controller arguments into identity targets and free text.
 *
 * Identity tokens are recognized by their PREFIX, so a malformed token cannot
 * silently degrade into reason text. Two failure modes measured in independent
 * review, both of which fenced successfully:
 *
 *   `generation=1junk`  -> parseInt read 1, so the caller pinned nothing but
 *                          looked like it had pinned generation 1
 *   `generation=`       -> the `(.+)` matcher did not match at all, so the token
 *                          fell through as reason text and the caller silently
 *                          became UNPINNED
 *
 * Both are now explicit errors. An empty or unparseable identity token is never
 * "no target supplied" — the caller asked for a pin and did not get one.
 */
function splitTargets(raw) {
	const text = typeof raw === "string" ? raw.trim() : "";
	const tokens = text.length === 0 ? [] : text.split(/\s+/);
	const targets = { sessionId: undefined, runtimeInstanceId: undefined, generation: undefined, requestId: undefined };
	const invalid = [];
	const rest = [];
	for (const token of tokens) {
		const match = /^(session|runtime|generation|request)=(.*)$/.exec(token);
		if (!match) {
			rest.push(token);
			continue;
		}
		const [, key, value] = match;
		if (value.length === 0) {
			invalid.push(`${key}=`);
			continue;
		}
		if (key === "generation") {
			// Whole-token validation: `1junk` is not 1.
			if (!/^[0-9]+$/.test(value)) {
				invalid.push(`generation=${value}`);
				continue;
			}
			const parsed = Number.parseInt(value, 10);
			if (!Number.isSafeInteger(parsed) || parsed < 1) {
				invalid.push(`generation=${value}`);
				continue;
			}
			targets.generation = parsed;
			continue;
		}
		if (key === "session") targets.sessionId = value;
		else if (key === "runtime") targets.runtimeInstanceId = value;
		else targets.requestId = value;
	}
	return { rest, targets, invalid };
}

export function parseCommitArgs(raw) {
	const { rest, targets, invalid } = splitTargets(raw);
	const [status = "", ...reasonTokens] = rest;
	return {
		status: status.toUpperCase(),
		reason: reasonTokens.join(" ") || "controller terminal",
		targets,
		invalidTargets: invalid,
	};
}

/**
 * Structured commit result (R2). Every field is a fact this extension observed;
 * nothing is inferred from "the command ran".
 *
 * `commandAccepted` / `commandDispatched` / `handlerExecuted` are set by the
 * command handler around the call, so a controller can tell "the transport
 * delivered my prompt" apart from "the extension committed the fence".
 */
function resultBase(state, extra = {}) {
	return {
		op: "commit",
		sessionId: state.sessionId,
		runtimeInstanceId: state.runtimeInstanceId,
		generation: state.generation,
		identityState: state.identityState,
		identityError: state.identityError ?? null,
		commandAccepted: true,
		commandDispatched: true,
		handlerExecuted: true,
		commitExecuted: false,
		committed: false,
		denial: null,
		reason: null,
		status: null,
		authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
		targetVerified: false,
		...extra,
	};
}

/** Map an identity state to the denial code a controller sees on the wire. */
function identityDenialCode(identityState) {
	switch (identityState) {
		case "CORRUPT":
			return "IDENTITY_LEDGER_CORRUPT";
		case "COLLISION":
			return "GENERATION_ALLOCATION_COLLISION";
		case "ADOPTION_CONFLICT":
			return "GENERATION_ADOPTION_CONFLICT";
		case "NO_STATE_DIR":
			return "IDENTITY_STATE_DIR_UNCONFIGURED";
		case "UNWRITABLE":
			return "IDENTITY_LEDGER_UNWRITABLE";
		case "EPHEMERAL":
			return "IDENTITY_NOT_DURABLE";
		case "EXHAUSTED":
			return "GENERATION_RANGE_EXHAUSTED";
		default:
			return "IDENTITY_UNAVAILABLE";
	}
}

/** Sign and write one result frame to the RPC stdout channel (R5). */
export function publishControllerResult(result, requestId = null) {
	const body = { requestId, result };
	if (resultKey === null) {
		return { emitted: false, signed: false, frame: { ...body, mac: null }, reason: "RESULT_KEY_ABSENT" };
	}
	if (!resultTransportEnabled()) {
		return { emitted: false, signed: true, frame: signResultFrame(resultKey, body), reason: "NOT_RPC_TRANSPORT" };
	}
	const frame = signResultFrame(resultKey, body);
	const line = `${JSON.stringify(frame)}\n`;
	// One physical line, one write, under PIPE_BUF: the runtime's own frame
	// writer emits whole lines per write too, so a small line cannot be spliced
	// into the middle of another frame's bytes.
	if (Buffer.byteLength(line, "utf8") > 4096) {
		return { emitted: false, signed: true, frame, reason: "RESULT_FRAME_TOO_LARGE" };
	}
	try {
		process.stdout.write(line);
		return { emitted: true, signed: true, frame, reason: null };
	} catch {
		return { emitted: false, signed: true, frame, reason: "STDOUT_WRITE_FAILED" };
	}
}

/**
 * Is stdout a machine frame channel right now?
 *
 * Writing a JSON line to a terminal would corrupt an interactive session, so
 * the frame is only emitted when the host is driving a machine channel: either
 * `runRpcMode` marked the process (`PI_NOTIFICATIONS=off` — it sets that before
 * any command can run), or stdout is not a TTY (a piped RPC host), or the
 * controller explicitly declared the transport. A key alone is not enough: a
 * controller that provisions a key and then runs the runtime interactively
 * still must not have JSON injected into its terminal.
 */
function resultTransportEnabled(env = globalThis.process?.env) {
	if (env?.OMP_CONTROLLER_RESULT_TRANSPORT === "stdout") return true;
	if (env?.PI_NOTIFICATIONS === "off") return true;
	return globalThis.process?.stdout?.isTTY !== true;
}

/**
 * The controller/orchestrator commit. Fail closed: without the controller's
 * capability marker, a valid disposition, an allocated identity and a matching
 * target, nothing is fenced and the generation stays active, so pending
 * deliveries continue to be delivered normally.
 *
 * @param {object} [target] identity the controller claims it is committing:
 *   `{ sessionId?, runtimeInstanceId?, generation?, requestId? }`. A supplied
 *   field that disagrees with this runtime is a denial, never a warning.
 */
export function commitTerminalFence(pi, state, manager, status, reason, env = globalThis.process?.env, target = {}) {
	if (!controllerAuthorityPresent(env)) {
		const denial = {
			...resultBase(state, { status: status ?? null }),
			denial: "CONTROLLER_AUTHORITY_ABSENT",
			reason: `terminal fence requires controller authority (${AUTHORITY_ENV})`,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			status: status ?? null,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}
	if (!TERMINAL_STATUSES.includes(status)) {
		const denial = {
			...resultBase(state, { status: status ?? null }),
			denial: "INVALID_TERMINAL_STATUS",
			reason: `status must be one of ${TERMINAL_STATUSES.join("/")}`,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			status: status ?? null,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}

	// R1: only a state whose generation this runtime actually owns may commit.
	// A state created while no capability was present holds a memory counter, not
	// a ledger identity; if the capability is present now, the run is adopted —
	// into the ledger when that is safe, as EPHEMERAL when there is no ledger.
	// Everything else (corrupt ledger, collision, unwritable, adoption conflict)
	// fails closed.
	if (state.identityState === "EPHEMERAL" && controllerAuthorityPresent(env)) {
		const adoption = adoptGeneration({
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			env,
		});
		if (adoption.adopted) {
			state.identityState = adoption.state;
			state.ledgerPath = adoption.ledgerPath;
			state.identityError = null;
			state.generationDurable = adoption.state === "ALLOCATED";
			state.allocationToken = adoption.allocationToken ?? null;
		} else {
			state.identityState = adoption.state;
			state.identityError = adoption.error;
			state.ledgerPath = adoption.ledgerPath;
		}
	}
	if (state.identityState !== "ALLOCATED" && state.identityState !== "EPHEMERAL") {
		const denial = {
			...resultBase(state, { status: status ?? null }),
			denial: identityDenialCode(state.identityState),
			reason: `run generation identity is ${state.identityState}${state.identityError ? `: ${state.identityError}` : ""}`,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			status: status ?? null,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}
	// R1: the target identity is verified BEFORE any fence state changes.
	const targetDenial = verifyCommitTarget(state, target);
	if (targetDenial) {
		const denial = {
			...resultBase(state, { status }),
			denial: targetDenial.denial,
			reason: targetDenial.reason,
			targetVerified: false,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			status,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}

	// R1/R2: a generation this ledger already closed may not be committed again,
	// even by a restarted process that re-derived the same number.
	if (generationAlreadyCommitted(state.ledgerPath, state.generation, state.sessionId)) {
		const denial = {
			...resultBase(state, { status }),
			denial: "GENERATION_ALREADY_COMMITTED",
			reason: `run generation ${state.generation} is already committed in the durable ledger`,
			targetVerified: true,
		};
		state.commitDenials.push({ ...denial, at: Date.now() });
		pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
			sessionId: state.sessionId,
			runtimeInstanceId: state.runtimeInstanceId,
			generation: state.generation,
			status,
			authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
			...denial,
		});
		return denial;
	}

	// R1: ownership is re-verified against the LEDGER, not against in-memory state.
	// Allocation-time verification is a snapshot, and a peer can append a
	// conflicting allocation afterwards; independent review reproduced exactly
	// that, with the earlier process committing a generation a peer also owned.
	if (state.identityState === "ALLOCATED") {
		const ownership = verifyOwnership({
			ledgerPath: state.ledgerPath,
			sessionId: state.sessionId,
			generation: state.generation,
			allocationToken: state.allocationToken,
		});
		if (!ownership.owned) {
			state.identityState = ownership.reason === "GENERATION_ALREADY_COMMITTED" ? "ALLOCATED" : "COLLISION";
			state.identityError = ownership.reason;
			const denial = {
				...resultBase(state, { status }),
				denial:
					ownership.reason === "GENERATION_ALREADY_COMMITTED"
						? "GENERATION_ALREADY_COMMITTED"
						: "GENERATION_OWNERSHIP_LOST",
				reason: `this runtime no longer owns generation ${state.generation}: ${ownership.reason}`,
				targetVerified: false,
			};
			state.commitDenials.push({ ...denial, at: Date.now() });
			pi.logger?.warn?.("no-poll-waits: terminal fence commit denied", {
				sessionId: state.sessionId,
				runtimeInstanceId: state.runtimeInstanceId,
				generation: state.generation,
				status,
				authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
				...denial,
			});
			return denial;
		}
	}

	const committed = commitOrderedTerminal(pi, state, manager, status, reason, TERMINAL_AUTHORITIES.CONTROLLER_COMMAND);
	// One advancement path for both fence legs: record the commit, claim the next
	// generation, and re-point the ownership token.
	const advanced = advanceDurableGeneration(pi, state, committed.generation, { status, requestId: target?.requestId });
	const ledgerError = advanced.error;
	const targetPinned = Boolean(
		target &&
			(typeof target.runtimeInstanceId === "string" ||
				typeof target.sessionId === "string" ||
				typeof target.generation === "number"),
	);
	const result = {
		...resultBase(state, {
			status,
			commitExecuted: true,
			committed: true,
			// `targetVerified` reports that an IDENTITY was pinned and matched —
			// a request id alone is correlation, not identity.
			targetVerified: targetPinned,
		}),
		generation: committed.generation,
		jobIds: committed.jobIds,
		suppressed: committed.suppressed,
		// Delivery invalidation is reported separately from the terminal
		// transition: `committed` says the disposition became authoritative and the
		// generation was fenced; these two say whether the bound jobs' pending
		// deliveries were actually invalidated. A controller that needs suppression
		// must check `deliveryFenceSucceeded`, not `committed`.
		deliveryFenceSucceeded: committed.deliveryFenceSucceeded,
		deliveryFenceError: committed.deliveryFenceError,
		fenceAt: committed.ordered.fenceAt,
		invalidatedAt: committed.ordered.invalidatedAt,
		terminalStateAt: committed.ordered.terminalStateAt,
		gateOpenedAt: committed.ordered.gateOpenedAt,
		finalDeliveryAllowed: committed.finalDeliveryAllowed,
		FENCE_BEFORE_FINAL: committed.FENCE_BEFORE_FINAL,
		// "Recorded" must mean the COMMIT is durably recorded — not "the whole
		// advance succeeded". Those differ: the commit record is written first, and
		// the next-generation claim can fail afterwards. Measured in independent
		// review with an injected EIO on the claim append: the ledger held
		// `commit:g1` while the frame said `ledgerRecorded:false`. In EPHEMERAL mode
		// there is no ledger at all, which is also not "recorded".
		ledgerRecorded: state.ledgerPath !== null && advanced.committedRecorded === true,
		ledgerError: state.ledgerPath === null ? "NO_LEDGER_EPHEMERAL" : ledgerError,
	};
	return result;
}

/**
 * Compare the controller's claimed identity against this runtime's.
 *
 * An omitted field is not checked (compatibility with a caller that only sends
 * a disposition), but a supplied field that disagrees is a denial. The result
 * reports `targetVerified` so a controller can tell which case it got.
 */
function verifyCommitTarget(state, target) {
	if (!target || typeof target !== "object") return null;
	if (target.sessionId !== undefined && target.sessionId !== state.sessionId) {
		return {
			denial: "TARGET_SESSION_MISMATCH",
			reason: `target session ${target.sessionId} is not this runtime's session ${state.sessionId}`,
		};
	}
	if (target.runtimeInstanceId !== undefined && target.runtimeInstanceId !== state.runtimeInstanceId) {
		return {
			denial: "TARGET_RUNTIME_MISMATCH",
			reason: `target runtime ${target.runtimeInstanceId} is not this runtime ${state.runtimeInstanceId}`,
		};
	}
	if (target.generation !== undefined && target.generation !== state.generation) {
		return {
			denial: "TARGET_GENERATION_MISMATCH",
			reason: `target generation ${target.generation} is not the active generation ${state.generation}`,
		};
	}
	return null;
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
		deliveryFenceSucceeded: fence.deliveryFenceSucceeded,
		deliveryFenceError: fence.deliveryFenceError,
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
		deliveryFenceSucceeded: record.deliveryFenceSucceeded,
		deliveryFenceError: record.deliveryFenceError,
		finalDeliveryAllowed: true,
	});
	return {
		committed: true,
		generation,
		jobIds: fence.jobIds,
		suppressed: fence.suppressed,
		deliveryFenceSucceeded: fence.deliveryFenceSucceeded,
		deliveryFenceError: fence.deliveryFenceError,
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
		// The automatic leg has no controller target, but it must still respect
		// ownership: a runtime whose durable identity is UNWRITABLE/COLLISION (or
		// whose live generation a peer also claims) must not fence a generation it
		// cannot prove is its own. Fail closed, leave the deliveries alone, and say
		// why — a silent skip would look like "nothing to fence".
		if (state.identityState === "ALLOCATED") {
			const ownership = verifyOwnership({
				ledgerPath: state.ledgerPath,
				sessionId: state.sessionId,
				generation: state.generation,
				allocationToken: state.allocationToken,
			});
			if (!ownership.owned) {
				state.identityState = ownership.reason === "GENERATION_ALREADY_COMMITTED" ? "ALLOCATED" : "COLLISION";
				state.identityError = ownership.reason;
				pi.logger?.warn?.("no-poll-waits: automatic fence skipped, generation not owned", {
					sessionId: state.sessionId,
					runtimeInstanceId: state.runtimeInstanceId,
					generation: state.generation,
					reason: ownership.reason,
				});
				return undefined;
			}
		} else if (state.identityState !== "EPHEMERAL") {
			// CORRUPT / COLLISION / UNWRITABLE / EXHAUSTED: the identity is not
			// usable, so the automatic leg cannot attribute a fence either.
			pi.logger?.warn?.("no-poll-waits: automatic fence skipped, identity unusable", {
				sessionId: state.sessionId,
				runtimeInstanceId: state.runtimeInstanceId,
				generation: state.generation,
				identityState: state.identityState,
				identityError: state.identityError ?? null,
			});
			return undefined;
		}
		const fenced = fenceGeneration(
			pi,
			state,
			manager,
			"TERMINAL",
			"agent_end settled without continuation",
			TERMINAL_AUTHORITIES.HOST_AGENT_END,
		);
		// The automatic leg advances the generation exactly like the controller
		// leg, so it must also advance the DURABLE identity. Without this, the live
		// generation after an automatic fence is unnamed in the ledger while
		// `identityState` still says ALLOCATED — and a controller could then commit
		// a generation a peer owns. Measured in independent review.
		advanceDurableGeneration(pi, state, fenced.generation, { status: "TERMINAL" });
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
	//
	// R3 adds the read-only identity leg FIRST, so a controller can bind to a
	// target before committing instead of committing to discover it. It is a
	// separate command rather than a mode of this one because the two differ in
	// the only way that matters: this one mutates a generation, that one cannot.
	pi.registerCommand(IDENTITY_COMMAND, {
		description:
			`Report this runtime's fence identity without committing anything (controller/orchestrator ` +
			`authority only). Usage: /${IDENTITY_COMMAND} [request=<id>]`,
		handler: async (args, ctx) => {
			const { targets, invalid } = splitTargets(args);
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			// The identity report is authority-bearing in one direction only: it
			// discloses which generation a controller may then commit. Without the
			// marker it is refused, so an ungoverned process cannot be interrogated
			// for a target by a party that could not commit anyway.
			const result =
				invalid.length > 0
					? {
							...resultBase(state, { op: "identity" }),
							denial: "MALFORMED_IDENTITY_TARGET",
							reason: `malformed identity target(s): ${invalid.join(", ")}`,
						}
					: !controllerAuthorityPresent()
						? {
								...resultBase(state, { op: "identity" }),
								denial: "CONTROLLER_AUTHORITY_ABSENT",
								reason: `identity disclosure requires controller authority (${AUTHORITY_ENV})`,
							}
						: {
								...resultBase(state, { op: "identity" }),
								// Nothing was attempted: the base already sets these false, and
								// restating them here would make the frame look like a commit.
								identityState: state.identityState,
								identityError: state.identityError ?? null,
								generationDurable: state.generationDurable === true,
								ledgerPath: state.ledgerPath,
								fenceCalls: state.fenceCalls,
								authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
							};
			const published = publishControllerResult(result, targets.requestId ?? null);
			pi.logger?.warn?.("no-poll-waits: fence identity report", {
				sessionId,
				runtimeInstanceId: state.runtimeInstanceId,
				generation: state.generation,
				requestId: targets.requestId ?? null,
				denial: result.denial ?? null,
				resultFrameEmitted: published.emitted,
				resultFrameSigned: published.signed,
				resultFrameReason: published.reason,
			});
		},
	});

	pi.registerCommand(COMMIT_COMMAND, {
		description:
			`Commit the run generation's terminal fence (controller/orchestrator authority only). ` +
			`Usage: /${COMMIT_COMMAND} <PASS|HOLD|FAIL|CANCELLED> [session=<id>] [runtime=<id>] ` +
			`[generation=<n>] [request=<id>] [reason]`,
		handler: async (args, ctx) => {
			const { status, reason, targets, invalidTargets } = parseCommitArgs(args);
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			const manager = resolveJobManager(pi, sessionId);
			let result;
			// Snapshot BEFORE the attempt: `state.fenced` holds every generation this
			// runtime ever fenced, so "a fence exists" cannot answer "did THIS call
			// fence". Independent review showed the difference: after any earlier
			// successful commit, a later denial whose logging threw would report
			// `committed:true` for that earlier generation.
			const fenceCallsBefore = state.fenceCalls;
			// If the primitive DENIED and then something threw while logging the
			// denial, the denial is the true outcome — not a handler exception.
			// Measured in independent review: an authority denial whose log threw
			// reported `commitExecuted:true` with `fenceCalls: 0`, contradicting the
			// denial object the primitive had already built.
			const denialsBefore = state.commitDenials.length;
			if (invalidTargets.length > 0) {
				// A malformed identity token is refused rather than ignored: a caller
				// that tried to pin and got an unpinned commit has lost the guarantee
				// it asked for, and must not be told the commit succeeded. The commit
				// was never attempted, so `commitExecuted` stays false.
				result = {
					...resultBase(state, { status }),
					denial: "MALFORMED_IDENTITY_TARGET",
					reason: `malformed identity target(s): ${invalidTargets.join(", ")}`,
				};
			} else try {
				result = commitTerminalFence(pi, state, manager, status, reason, undefined, targets);
			} catch (error) {
				// A thrown handler is an observable failure, not a success and not a
				// silent denial. `committed` must report what ACTUALLY happened, not
				// what the caller hoped: measured in independent review, a throw after
				// the fence had already applied produced `committed:false` for a
				// generation that was in fact committed, which is the same lie in the
				// other direction. `state.fenced` is the runtime's own record of what
				// it fenced, so the frame is derived from it.
				const landed = state.fenceCalls > fenceCallsBefore;
				const denied =
					state.commitDenials.length > denialsBefore
						? state.commitDenials[state.commitDenials.length - 1]
						: null;
				if (denied && !landed) {
					// The primitive produced a real denial; only logging it failed. Report
					// the denial, with the throw recorded beside it.
					result = {
						...resultBase(state, { status }),
						...denied,
						handlerException: String(error && error.message ? error.message : error),
						jobIds: [],
						suppressed: 0,
					};
				} else {
					result = {
						...resultBase(state, { status }),
						// The fence advances the generation, so the generation that landed is
						// the one before the current value — but only when this call fenced.
						generation: landed ? state.generation - 1 : state.generation,
						// Reaching here means the primitive was ENTERED and produced no
						// denial (a denial with no fence is handled above), so a commit
						// really was attempted — it just did not complete. Reporting
						// `commitExecuted:false` here would conflate "attempted and
						// failed" with "never attempted", which is the distinction this
						// field exists to make. Measured in independent review: a manager
						// throwing inside `acknowledgeDeliveries`, with the failure log
						// also throwing before `fenceCalls` incremented, reported
						// `commitExecuted:false` after an observed attempt.
						commitExecuted: true,
						committed: landed,
						denial: landed ? null : "HANDLER_EXCEPTION",
						reason: landed
							? `the fence was committed, then the handler threw: ${String(error && error.message ? error.message : error)}`
							: String(error && error.message ? error.message : error),
						handlerException: String(error && error.message ? error.message : error),
						// The frame must be complete enough to read even when the handler
						// failed: a missing field here would make the controller treat a
						// real outcome as a malformed frame.
						jobIds: [],
						suppressed: 0,
					};
				}
				// A logger that throws must not cost the controller its result. The
				// frame is the contract; logging is a convenience.
				try {
					pi.logger?.warn?.("no-poll-waits: terminal fence handler threw", {
						sessionId,
						runtimeInstanceId: state.runtimeInstanceId,
						generation: state.generation,
						status,
						error: String(error),
					});
				} catch {
					// deliberately ignored: the result frame below is the record
				}
			}
			const published = publishControllerResult(result, targets.requestId ?? null);
			const line = result.committed
				? `Terminal fence COMMITTED for run generation ${result.generation} as ${result.status}. ` +
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
			// The frame is already published; a throwing logger must not turn a
			// completed commit into a rejected command. Logging is a convenience,
			// the frame is the contract.
			try {
				pi.logger?.warn?.("no-poll-waits: terminal fence command", {
					sessionId,
					runtimeInstanceId: state.runtimeInstanceId,
					authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
					status,
					requestId: targets.requestId ?? null,
					committed: result.committed,
					denial: result.denial ?? null,
					resultFrameEmitted: published.emitted,
					resultFrameSigned: published.signed,
					resultFrameReason: published.reason,
				});
			} catch {
				// deliberately ignored: the result frame above is the record
			}
		},
	});

	// (5) CONTROLLER SURFACE — the barrier-gated final release. This is the only
	// sanctioned way for a governed process to hand its final report to the user:
	// it refuses while FINAL_DELIVERY_ALLOWED is false, so a report cannot be
	// delivered ahead of the fence that silences the generation's deliveries.
	pi.registerCommand(RELEASE_COMMAND, {
		description:
			`Release the run generation's final report (controller/orchestrator authority only; ` +
			`requires the ordered terminal commit). Usage: /${RELEASE_COMMAND} [generation] [request=<id>]`,
		handler: async (args, ctx) => {
			const { rest, targets: releaseTargets, invalid: invalidReleaseTargets } = splitTargets(args);
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const state = stateFor(sessionId);
			// Same rule as the commit target: an explicit generation is validated
			// whole. `parseInt("1junk")` is 1, which would release a generation the
			// caller did not name. No argument at all still means "the fenced one".
			const rawGeneration = rest[0];
			const generationValid =
				rawGeneration === undefined || (/^[0-9]+$/.test(rawGeneration) && Number.isSafeInteger(Number(rawGeneration)));
			const generation =
				rawGeneration === undefined
					? state.generation - 1
					: generationValid
						? Number(rawGeneration)
						: Number.NaN;
			// Pinned identity is CHECKED, not merely parsed. Measured in independent
			// review: `/release-final session=foreign runtime=foreign generation=999`
			// released the live generation anyway, because only `request` was read
			// from the target. A release mutates `finalReleaseAt`, so accepting a
			// mismatched pin and rejecting the frame afterwards would be too late.
			const pinMismatch =
				(releaseTargets.sessionId !== undefined && releaseTargets.sessionId !== state.sessionId)
					? "TARGET_SESSION_MISMATCH"
					: (releaseTargets.runtimeInstanceId !== undefined &&
								releaseTargets.runtimeInstanceId !== state.runtimeInstanceId)
						? "TARGET_RUNTIME_MISMATCH"
						: generationValid && releaseTargets.generation !== undefined && releaseTargets.generation !== generation
							? "TARGET_GENERATION_MISMATCH"
							: null;
			const result =
				invalidReleaseTargets.length > 0
					? {
							released: false,
							denial: "MALFORMED_IDENTITY_TARGET",
							reason: `malformed identity target(s): ${invalidReleaseTargets.join(", ")}`,
							generation,
						}
					: !generationValid
						? {
								released: false,
								denial: "MALFORMED_GENERATION",
								reason: `release generation must be a whole number, got ${JSON.stringify(rawGeneration)}`,
								generation,
							}
						: pinMismatch !== null
							? {
									released: false,
									denial: pinMismatch,
									reason: `release target does not match this runtime: ${pinMismatch}`,
									generation,
								}
							: releaseFinalResponse(pi, state, generation);
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
			// The release is a controller decision too, so it answers on the same
			// signed channel with the same identity fields. `released` is its commit
			// flag; `committed` stays false because a release commits no fence.
			const published = publishControllerResult(
				{
					...resultBase(state, {
						status: result.released ? "RELEASED" : null,
						commitExecuted: false,
						committed: false,
					}),
					op: "release",
					generation: result.generation,
					released: result.released,
					denial: result.denial ?? null,
					reason: result.reason ?? null,
					finalReleaseAt: result.finalReleaseAt ?? null,
					fenceAt: result.fenceAt ?? null,
					FENCE_BEFORE_FINAL: result.FENCE_BEFORE_FINAL ?? null,
				},
				releaseTargets.requestId ?? null,
			);
			pi.logger?.warn?.("no-poll-waits: final release command", {
				sessionId,
				runtimeInstanceId: state.runtimeInstanceId,
				authority: TERMINAL_AUTHORITIES.CONTROLLER_COMMAND,
				generation,
				requestId: releaseTargets.requestId ?? null,
				released: result.released,
				denial: result.denial ?? null,
				resultFrameEmitted: published.emitted,
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
			/** R1 composite identity. */
			runtimeInstanceId: state.runtimeInstanceId,
			identityState: state.identityState,
			identityError: state.identityError ?? null,
			previousGeneration: state.previousGeneration,
			ledgerPath: state.ledgerPath,
			/** True only when a durable ledger names this generation. */
			generationDurable: state.generationDurable === true,
			allocationToken: state.allocationToken ?? null,
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
