// lib/controller-result.mjs
//
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — the result
// frame contract shared by the extension (producer) and a controller client
// (verifier).
//
// Why this file exists
// -------------------
// The terminal-fence command's result used to be observable only as a log line
// or a `notify` UI frame. Both are unusable as a controller contract: the log is
// not correlated to the invocation, and the notify frame is generated with a
// fresh Snowflake id inside `rpc-mode.ts` (so it cannot be matched to the
// request) and disappears entirely under `--no-ui`.
//
// This module defines ONE structured frame the extension writes to the RPC
// stdout channel, carrying the identity of the runtime that produced it, the
// controller's own request id, the commit result, and an HMAC binding the whole
// frame to a per-launch key the controller generated.
//
// Trust boundary (stated, not implied)
// ------------------------------------
// * The key is delivered as a FILE PATH in `OMP_CONTROLLER_RESULT_KEY_FILE`. The
//   extension reads it once at module load and unlinks it. The key therefore
//   never appears in the process environment, in argv, on stdout, or in the
//   session file, so a bash child process (the governed agent's only
//   process-spawning surface) cannot recover it after load.
// * A frame is accepted only when its MAC verifies AND its request id, session
//   id, runtime instance id and generation all match what the controller issued
//   and expected. "Same-looking JSON" is never sufficient.
// * Code that is ALREADY LOADED into the runtime at launch is inside the trusted
//   computing base by construction: it shares the module graph and could read the
//   key from memory. That boundary is a launch-time property, not something a
//   single-process transport can prove. The controller's guarantee is therefore
//   exactly: nothing OUTSIDE the launch-loaded extension set can produce an
//   accepted result frame. See docs/audit/…/TRANSPORT_TRUST_BOUNDARY.md.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Frame type written to the RPC stdout channel. Distinct from every RPC frame. */
export const RESULT_FRAME_TYPE = "controller_result";
/** Logical channel name, so a controller can ignore frames for other features. */
export const RESULT_CHANNEL = "terminal-fence";
/** Wire schema version of this frame. */
export const RESULT_SCHEMA_VERSION = 1;
/** Environment variable naming the key file the controller generated. */
export const RESULT_KEY_ENV = "OMP_CONTROLLER_RESULT_KEY_FILE";
/** The only accepted key encoding: 32 bytes, lowercase hex. */
export const RESULT_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Deterministic JSON: object keys sorted, arrays in order, no whitespace.
 *
 * The MAC must cover the exact bytes a verifier reconstructs, so both sides
 * serialize through this one function rather than relying on property order.
 */
export function canonicalJson(value) {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
	}
	return "null";
}

/** The exact object the MAC covers. Excludes the MAC itself. */
function frameMacInput(frame) {
	return canonicalJson({
		type: frame.type,
		channel: frame.channel,
		v: frame.v,
		requestId: frame.requestId,
		result: frame.result,
	});
}

/** Sign a result frame body. Returns the complete frame with `mac` attached. */
export function signResultFrame(key, body) {
	const frame = {
		type: RESULT_FRAME_TYPE,
		channel: RESULT_CHANNEL,
		v: RESULT_SCHEMA_VERSION,
		requestId: body.requestId ?? null,
		result: body.result ?? null,
	};
	const mac = createHmac("sha256", key).update(frameMacInput(frame)).digest("hex");
	return { ...frame, mac };
}

function constantTimeEqualHex(a, b) {
	if (typeof a !== "string" || typeof b !== "string") return false;
	if (a.length !== b.length || a.length === 0) return false;
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** Structural gate: everything below is a rejection reason, never a pass. */
function classifyResultFrame(frame) {
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) return "MALFORMED_FRAME";
	if (frame.type !== RESULT_FRAME_TYPE) return "NOT_A_RESULT_FRAME";
	if (frame.channel !== RESULT_CHANNEL) return "UNKNOWN_CHANNEL";
	if (frame.v !== RESULT_SCHEMA_VERSION) return "UNSUPPORTED_SCHEMA_VERSION";
	if (typeof frame.requestId !== "string" || frame.requestId.length === 0) return "REQUEST_ID_MISSING";
	if (typeof frame.mac !== "string" || !/^[0-9a-f]{64}$/.test(frame.mac)) return "MAC_MISSING";
	if (!frame.result || typeof frame.result !== "object" || Array.isArray(frame.result)) return "RESULT_MISSING";
	return null;
}

/**
 * Verify one frame against the controller's own expectations.
 *
 * `expect` carries the request the controller actually issued. Every field is
 * optional so a controller can verify progressively, but a field that IS
 * supplied and disagrees is a hard rejection — including generation, which is
 * what stops a replayed frame from a previous run being read as this one.
 *
 * @returns {{ ok: boolean, reason: string|null, result?: object }}
 */
export function verifyResultFrame(key, frame, expect = {}) {
	const structural = classifyResultFrame(frame);
	if (structural) return { ok: false, reason: structural };

	if (typeof key !== "string" || !RESULT_KEY_PATTERN.test(key)) {
		return { ok: false, reason: "VERIFIER_KEY_INVALID" };
	}

	const expectedMac = createHmac("sha256", key).update(frameMacInput(frame)).digest("hex");
	if (!constantTimeEqualHex(expectedMac, frame.mac)) return { ok: false, reason: "MAC_MISMATCH" };

	const result = frame.result;
	if (expect.requestId !== undefined && frame.requestId !== expect.requestId) {
		return { ok: false, reason: "REQUEST_ID_MISMATCH" };
	}
	if (expect.sessionId !== undefined && result.sessionId !== expect.sessionId) {
		return { ok: false, reason: "SESSION_ID_MISMATCH" };
	}
	if (expect.runtimeInstanceId !== undefined && result.runtimeInstanceId !== expect.runtimeInstanceId) {
		return { ok: false, reason: "RUNTIME_ID_MISMATCH" };
	}
	if (expect.generation !== undefined && result.generation !== expect.generation) {
		return { ok: false, reason: "GENERATION_MISMATCH" };
	}
	if (expect.status !== undefined && result.status !== expect.status) {
		return { ok: false, reason: "STATUS_MISMATCH" };
	}
	return { ok: true, reason: null, result };
}

/**
 * The controller-side acceptance set for one request id.
 *
 * Exactly one frame may be accepted per request id. Anything else — a second
 * frame, a frame for an id never issued, a frame whose id is unknown — is
 * refused, so an injected or duplicated frame cannot be mistaken for the answer
 * to a request that is still outstanding.
 */
export class ResultCorrelator {
	#key;
	#pending = new Map();
	#accepted = new Map();
	#rejected = [];
	// Every id this controller ever issued, including cancelled ones. A cancelled
	// id must never be reissued: the original answer may still arrive, and if the
	// id is live again that stale frame would be attributed to the new request.
	#issued = new Set();

	constructor(key) {
		if (typeof key !== "string" || !RESULT_KEY_PATTERN.test(key)) {
			throw new Error("ResultCorrelator requires a 32-byte hex key");
		}
		this.#key = key;
	}

	/** Register the request the controller just issued, with its own expectations. */
	expect(requestId, expectation = {}) {
		if (typeof requestId !== "string" || requestId.length === 0) {
			throw new Error("requestId must be a non-empty string");
		}
		if (this.#issued.has(requestId)) {
			// Reuse after `cancel()` is the dangerous case: a delayed signed answer
			// to the cancelled request would verify against the new expectation.
			// Correlation requires unique ids, so this is an error, not a warning.
			throw new Error(`requestId ${requestId} was already issued`);
		}
		this.#issued.add(requestId);
		this.#pending.set(requestId, { ...expectation });
		return this;
	}

	/** Forget an outstanding request (timeout, abort). A later frame is then unknown. */
	cancel(requestId) {
		return this.#pending.delete(requestId);
	}

	pendingRequestIds() {
		return [...this.#pending.keys()];
	}

	/**
	 * Feed one frame. Returns the verdict for THIS frame:
	 * `{ ok, reason, requestId }`. A frame is never accepted twice.
	 */
	accept(frame) {
		// Structure first: a frame that is not a result frame at all is a
		// malformed/injected frame, and saying so is more useful than routing it.
		const structural = classifyResultFrame(frame);
		if (structural) {
			const requestId = frame && typeof frame === "object" && "requestId" in frame ? frame.requestId : null;
			this.#rejected.push({ requestId: typeof requestId === "string" ? requestId : null, reason: structural });
			return { ok: false, reason: structural, requestId: typeof requestId === "string" ? requestId : null };
		}
		const { requestId } = frame;
		// A structurally valid result frame for an id this controller never issued,
		// or already answered, is an injection or a duplicate — never the answer to
		// an outstanding request.
		if (!this.#pending.has(requestId)) {
			const reason = this.#accepted.has(requestId) ? "DUPLICATE_RESULT" : "UNSOLICITED_RESULT";
			this.#rejected.push({ requestId, reason });
			return { ok: false, reason, requestId };
		}
		const verdict = verifyResultFrame(this.#key, frame, {
			...this.#pending.get(requestId),
			requestId,
		});
		if (!verdict.ok) {
			// A rejected frame does not consume the request: the real answer may
			// still arrive. Fail closed means "do not act", not "give up".
			this.#rejected.push({ requestId, reason: verdict.reason });
			return { ok: false, reason: verdict.reason, requestId };
		}
		this.#pending.delete(requestId);
		this.#accepted.set(requestId, verdict.result);
		return { ok: true, reason: null, requestId, result: verdict.result };
	}

	accepted(requestId) {
		return this.#accepted.get(requestId);
	}

	rejections() {
		return [...this.#rejected];
	}
}
