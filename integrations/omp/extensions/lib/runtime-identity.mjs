// lib/runtime-identity.mjs
//
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — R1.
//
// Problem this closes
// -------------------
// The extension used to key run generations by session id alone, in a
// module-local Map. A resumed process re-created that state at generation 1
// under the SAME session id, so `(sessionId, generation)` named two different
// runtime events and a controller could not pin the generation it meant to
// commit. Measured in AEGISFLOW_CONTROLLER_RPC_PROMPT_FRAME_FEASIBILITY_1:
// two processes, one session id `01a159e2-…`, both reporting "generation 1".
//
// The repair is a composite identity plus a durable allocation ledger:
//
//   sessionId           which session file this is
//   runtimeInstanceId   which OS process is executing it (never reused)
//   generation          which run within that session (monotonic, never reused)
//
// Design constraints that shaped it
// ---------------------------------
// * MINIMAL. This is not a session-recovery framework. The ledger records only
//   (session, runtime, generation) allocations and commits; it restores no
//   agent state, replays no messages, and is never consulted by any other part
//   of the extension.
// * DURABLE ONLY WHEN GOVERNED. The ledger is read and written only when the
//   controller capability marker is present. An ungoverned OMP process keeps
//   exactly the previous in-memory behavior and performs no file IO — so a
//   production session that nobody governs cannot start writing new state.
//   The tradeoff is stated rather than hidden: an ungoverned process can still
//   restart at generation 1, but it cannot commit a fence at all, so the
//   collision has no consequence.
// * FAIL CLOSED. A corrupt, truncated, unreadable or concurrently-colliding
//   ledger yields NO usable generation. Commits are then refused with
//   `IDENTITY_LEDGER_CORRUPT` / `GENERATION_ALLOCATION_COLLISION`; the code
//   never falls back to "generation 1" because that is the exact defect being
//   repaired.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

/** Directory holding the per-session allocation ledgers. */
const STATE_DIR_ENV = "OMP_TERMINAL_FENCE_STATE_DIR";

/**
 * There is deliberately NO default ledger directory.
 *
 * A default would make an authority-bearing process write files somewhere the
 * operator never chose — and a tmpdir default would silently reset the numbering
 * across reboots, which is precisely the defect R1 repairs. The controller
 * provisions the directory together with the capability marker; a governed
 * process without one refuses to commit (`IDENTITY_STATE_DIR_UNCONFIGURED`)
 * rather than fall back to a memory counter.
 */

/** Ledger record kinds. Anything else in the file is corruption, not a future feature. */
const RECORD_ALLOCATE = "allocate";
const RECORD_COMMIT = "commit";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function hostFingerprint() {
	try {
		return createHash("sha256").update(String(hostname())).digest("hex").slice(0, 8);
	} catch {
		return "00000000";
	}
}

/**
 * A process identity that cannot collide with another process.
 *
 * `pid` alone is reused by the OS; `Date.now()` alone can collide across
 * machines. The tuple plus a random suffix cannot, and the start time is kept
 * readable so an operator can order two runtimes of the same session by
 * inspection. It is derived, never accepted from the environment: a value the
 * launcher could set is a value the governed agent's children could read and
 * replay, and this id is checked as a commit target.
 */
export function createRuntimeInstanceId(now = Date.now(), pid = process.pid, uptimeSec = process.uptime()) {
	const startedAt = Math.round(now - uptimeSec * 1000);
	return `${hostFingerprint()}-${pid}-${startedAt}-${randomBytes(6).toString("hex")}`;
}

/**
 * Resolve the configured ledger directory.
 *
 * The three outcomes are DIFFERENT and must not be collapsed:
 *   { state: "ABSENT" }      no directory configured -> ephemeral mode is honest
 *   { state: "OK", dir }     configured and usable
 *   { state: "UNUSABLE" }    configured but cannot be created/used
 *
 * Collapsing "configured but unusable" into "absent" would silently downgrade a
 * controller's durability requirement to ephemeral — measured in independent
 * review with the configured path occupied by an ordinary file.
 */
function resolveStateDir(env = process.env) {
	const dir = env?.[STATE_DIR_ENV];
	if (typeof dir !== "string" || dir.length === 0) return { state: "ABSENT", dir: null };
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (!statSync(dir).isDirectory()) return { state: "UNUSABLE", dir };
		return { state: "OK", dir };
	} catch {
		return { state: "UNUSABLE", dir };
	}
}

function ledgerPath(dir, sessionId) {
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	return join(dir, `${sessionId}.jsonl`);
}

/** Generations must be positive safe integers; beyond that `+1` is not representable. */
function isValidGeneration(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read and validate a ledger.
 *
 * Validation is per-record and covers the fields the allocation logic then
 * trusts: type, generation range, and the record's own session/runtime identity.
 * A record that cannot be attributed to this session is corruption — accepting it
 * would let a hand-written `{"type":"allocate","generation":7}` dictate the
 * numbering, which independent review measured.
 */
function readLedger(path, sessionId) {
	if (!existsSync(path)) return { records: [], corrupt: null };
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { records: [], corrupt: `UNREADABLE: ${String(error)}` };
	}
	const records = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === "") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			return { records, corrupt: `MALFORMED_LINE_${index + 1}` };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { records, corrupt: `NOT_AN_OBJECT_${index + 1}` };
		}
		if (parsed.type !== RECORD_ALLOCATE && parsed.type !== RECORD_COMMIT) {
			return { records, corrupt: `UNKNOWN_RECORD_TYPE_${index + 1}` };
		}
		if (!isValidGeneration(parsed.generation)) {
			return { records, corrupt: `BAD_GENERATION_${index + 1}` };
		}
		if (sessionId !== undefined && parsed.sessionId !== sessionId) {
			return { records, corrupt: `FOREIGN_SESSION_${index + 1}` };
		}
		if (typeof parsed.runtimeInstanceId !== "string" || parsed.runtimeInstanceId.length === 0) {
			return { records, corrupt: `MISSING_RUNTIME_${index + 1}` };
		}
		records.push(parsed);
	}
	return { records, corrupt: null };
}

function appendRecord(path, record) {
	const line = `${JSON.stringify(record)}\n`;
	let fd;
	try {
		fd = openSync(path, "a", 0o600);
		writeSync(fd, line);
		fsyncSync(fd);
	} catch (error) {
		return `APPEND_FAILED: ${String(error)}`;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// closing a failed append changes nothing about the failure
			}
		}
	}
	return null;
}

/**
 * Allocate this process's generation for one session.
 *
 * Two modes, both giving a composite identity that no other process can claim:
 *
 *   EPHEMERAL  no state directory was provisioned. The generation is this
 *              runtime's own counter starting at 1, and identity uniqueness comes
 *              from `runtimeInstanceId`. A restart therefore gets a DIFFERENT
 *              identity even at the same number — the collision the old
 *              session-only key produced is gone — but numbering does not
 *              continue across restarts and a predecessor's commits are not
 *              visible. Reported honestly as `generationDurable: false`.
 *   ALLOCATED  a state directory was provisioned. The generation is read from
 *              the durable ledger and claimed there, so it continues across
 *              restarts, survives reboots, and a duplicate commit is refused.
 *
 * The card's own preference is the minimal design, and EPHEMERAL is that: the
 * runtime id alone already separates processes. ALLOCATED is the stronger mode a
 * controller opts into by provisioning a directory.
 *
 * @returns {{
 *   generation: number|null,
 *   identityState: "EPHEMERAL"|"ALLOCATED"|"NO_STATE_DIR"|"CORRUPT"|"COLLISION"|"UNWRITABLE",
 *   identityError: string|null,
 *   runtimeInstanceId: string,
 *   ledgerPath: string|null,
 *   previousGeneration: number|null,
 *   generationDurable: boolean,
 * }}
 */
export function allocateGeneration({ sessionId, runtimeInstanceId, env = process.env, now = Date.now() }) {
	const base = {
		generation: 1,
		identityState: "EPHEMERAL",
		identityError: null,
		runtimeInstanceId,
		ledgerPath: null,
		previousGeneration: null,
		generationDurable: false,
		/** Unique token naming THIS allocation record in the ledger. */
		allocationToken: null,
	};
	const resolved = resolveStateDir(env);
	if (resolved.state === "ABSENT") return base;
	if (resolved.state === "UNUSABLE") {
		// A configured-but-unusable directory is a controller provisioning failure,
		// not permission to fall back to ephemeral numbering.
		return {
			...base,
			generation: null,
			identityState: "UNWRITABLE",
			identityError: "STATE_DIR_UNUSABLE",
			ledgerPath: null,
		};
	}
	const path = ledgerPath(resolved.dir, sessionId);
	if (!path) {
		return { ...base, generation: null, identityState: "UNWRITABLE", identityError: "SESSION_ID_NOT_LEDGER_SAFE" };
	}

	const read = readLedger(path, sessionId);
	if (read.corrupt) {
		return { ...base, generation: null, identityState: "CORRUPT", identityError: read.corrupt, ledgerPath: path };
	}

	const previousGeneration = read.records.reduce(
		(max, record) => (record.generation > max ? record.generation : max),
		0,
	);
	if (!Number.isSafeInteger(previousGeneration + 1)) {
		return {
			...base,
			generation: null,
			identityState: "EXHAUSTED",
			identityError: `GENERATION_RANGE_EXHAUSTED_AT_${previousGeneration}`,
			ledgerPath: path,
			previousGeneration,
		};
	}
	const generation = previousGeneration + 1;
	// The token is written INTO the record, so ownership can be re-verified later
	// by finding exactly this record again rather than trusting in-memory state.
	const allocationToken = randomBytes(8).toString("hex");
	const appendError = appendRecord(path, {
		type: RECORD_ALLOCATE,
		sessionId,
		runtimeInstanceId,
		generation,
		allocationToken,
		at: now,
	});
	if (appendError) {
		return {
			...base,
			generation: null,
			identityState: "UNWRITABLE",
			identityError: appendError,
			ledgerPath: path,
			previousGeneration,
		};
	}

	// Re-read under the same rules: exactly one allocate record may claim this
	// generation AND carry this token. Anything else — a peer that raced us, a
	// hand-edited ledger, a truncated append — is not ours to use.
	const verify = readLedger(path, sessionId);
	if (verify.corrupt) {
		return { ...base, generation: null, identityState: "CORRUPT", identityError: verify.corrupt, ledgerPath: path };
	}
	const claimants = verify.records.filter(
		record => record.type === RECORD_ALLOCATE && record.generation === generation,
	);
	if (claimants.length !== 1 || claimants[0].allocationToken !== allocationToken) {
		return {
			...base,
			generation: null,
			identityState: "COLLISION",
			identityError: `GENERATION_${generation}_CLAIMED_${claimants.length}_TIMES`,
			ledgerPath: path,
			previousGeneration,
		};
	}

	return {
		generation,
		identityState: "ALLOCATED",
		identityError: null,
		runtimeInstanceId,
		ledgerPath: path,
		previousGeneration: previousGeneration === 0 ? null : previousGeneration,
		generationDurable: true,
		allocationToken,
	};
}

/**
 * Re-verify, from the ledger, that this runtime still owns `generation`.
 *
 * Allocation-time verification is a snapshot: a peer can append a conflicting
 * allocation afterwards. Independent review measured exactly that — the earlier
 * process stayed `ALLOCATED` and committed a generation a peer had also claimed.
 * So ownership is re-checked immediately before the fence mutates state, and the
 * check is by token, not by number.
 *
 * @returns {{ owned: boolean, reason: string|null }}
 */
export function verifyOwnership({ ledgerPath, sessionId, generation, allocationToken }) {
	if (!ledgerPath) return { owned: true, reason: null };
	if (typeof allocationToken !== "string" || allocationToken.length === 0) {
		return { owned: false, reason: "ALLOCATION_TOKEN_MISSING" };
	}
	const read = readLedger(ledgerPath, sessionId);
	if (read.corrupt) return { owned: false, reason: `LEDGER_CORRUPT: ${read.corrupt}` };
	const claimants = read.records.filter(
		record => record.type === RECORD_ALLOCATE && record.generation === generation,
	);
	if (claimants.length !== 1) return { owned: false, reason: `GENERATION_CLAIMED_${claimants.length}_TIMES` };
	if (claimants[0].allocationToken !== allocationToken) return { owned: false, reason: "ALLOCATION_TOKEN_MISMATCH" };
	const committed = read.records.some(record => record.type === RECORD_COMMIT && record.generation === generation);
	if (committed) return { owned: false, reason: "GENERATION_ALREADY_COMMITTED" };
	return { owned: true, reason: null };
}

/**
 * Adopt an already-running generation whose state was created before the
 * controller capability was present.
 *
 * Two cases, both non-destructive:
 *   EPHEMERAL  no ledger. The run keeps its number and simply becomes governed;
 *              uniqueness still comes from `runtimeInstanceId`.
 *   ALLOCATED  a ledger exists. Adoption is safe ONLY when the ledger's next
 *              generation equals the live one — anything else would renumber a
 *              live run and silently unbind the jobs already recorded against
 *              its generation, and a fence over an empty job set silences
 *              nothing. A mismatch is refused, not repaired.
 *
 * @returns {{ adopted: boolean, state: string, error: string|null, ledgerPath: string|null }}
 */
export function adoptGeneration({ sessionId, runtimeInstanceId, generation, env = process.env, now = Date.now() }) {
	const allocation = allocateGeneration({ sessionId, runtimeInstanceId, env, now });
	if (allocation.identityState === "EPHEMERAL") {
		return { adopted: true, state: "EPHEMERAL", error: null, ledgerPath: null };
	}
	if (allocation.identityState !== "ALLOCATED") {
		return {
			adopted: false,
			state: allocation.identityState,
			error: allocation.identityError,
			ledgerPath: allocation.ledgerPath,
		};
	}
	if (allocation.generation !== generation) {
		return {
			adopted: false,
			state: "ADOPTION_CONFLICT",
			error: `LEDGER_NEXT_GENERATION_${allocation.generation}_LIVE_GENERATION_${generation}`,
			ledgerPath: allocation.ledgerPath,
		};
	}
	return {
		adopted: true,
		state: "ALLOCATED",
		error: null,
		ledgerPath: allocation.ledgerPath,
		allocationToken: allocation.allocationToken,
	};
}

/**
 * Record a committed generation AND claim the next one in the same ledger.
 *
 * The claim matters: without it a resumed process would compute `max+1` from the
 * commit records and hand out the very number the live process is already
 * running. With it, the live process's next generation is durably owned before
 * any successor can allocate, so a restart always moves forward.
 *
 * @returns {{ error: string|null, nextGeneration: number|null }}
 */
export function recordCommitAndClaimNext({
	ledgerPath,
	sessionId,
	runtimeInstanceId,
	generation,
	status,
	requestId,
	now = Date.now(),
}) {
	if (!ledgerPath) return { error: null, committedRecorded: false, nextGeneration: null, allocationToken: null };
	if (!isValidGeneration(generation) || !Number.isSafeInteger(generation + 1)) {
		return {
			error: `GENERATION_RANGE_EXHAUSTED_AT_${generation}`,
			committedRecorded: false,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	// Never write a second commit record for one generation. Measured in
	// independent review: after a failed advance the automatic fence leg appended
	// a duplicate `commit:2` beside a peer's, so the ledger recorded two commits
	// for one generation. The ledger is the durable statement of what committed;
	// a duplicate there is worse than a refused write.
	const preexisting = commitRecordState(ledgerPath, generation, sessionId);
	if (preexisting !== "NOT_COMMITTED") {
		// COMMITTED: the record is durable (written by someone, possibly a peer).
		// UNREADABLE: the history cannot be read, so nothing may be claimed about
		// what it contains — fail closed on the write AND on the report.
		return {
			error:
				preexisting === "COMMITTED"
					? `GENERATION_${generation}_ALREADY_COMMITTED`
					: `LEDGER_UNREADABLE_AT_${generation}`,
			committedRecorded: preexisting === "COMMITTED",
			nextGeneration: null,
			allocationToken: null,
		};
	}
	const commitError = appendRecord(ledgerPath, {
		type: RECORD_COMMIT,
		sessionId,
		runtimeInstanceId,
		generation,
		status,
		requestId: requestId ?? null,
		at: now,
	});
	if (commitError) return { error: commitError, committedRecorded: false, nextGeneration: null, allocationToken: null };
	// From here the COMMIT RECORD IS DURABLE. The claim that follows can still
	// fail, and the two facts are different: the ledger knows this generation
	// committed, but this runtime cannot name the next one. Measured in
	// independent review with an injected EIO on the claim append: the caller
	// reported `ledgerRecorded:false` while `commit:g1` was on disk, so the
	// documented meaning of that field was wrong. `committedRecorded` carries the
	// distinction; `error` keeps reporting the failure.
	const nextGeneration = generation + 1;
	const allocationToken = randomBytes(8).toString("hex");
	const claimError = appendRecord(ledgerPath, {
		type: RECORD_ALLOCATE,
		sessionId,
		runtimeInstanceId,
		generation: nextGeneration,
		allocationToken,
		at: now,
	});
	if (claimError) return { error: claimError, committedRecorded: true, nextGeneration: null, allocationToken: null };
	const verify = readLedger(ledgerPath, sessionId);
	if (verify.corrupt) {
		return { error: `VERIFY_${verify.corrupt}`, committedRecorded: true, nextGeneration: null, allocationToken: null };
	}
	const claimants = verify.records.filter(
		record => record.type === RECORD_ALLOCATE && record.generation === nextGeneration,
	);
	if (claimants.length !== 1 || claimants[0].allocationToken !== allocationToken) {
		return {
			error: `NEXT_GENERATION_${nextGeneration}_CLAIMED_${claimants.length}_TIMES`,
			committedRecorded: true,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	return { error: null, committedRecorded: true, nextGeneration, allocationToken };
}

/**
 * True when the ledger says this generation was already committed — the
 * durable half of the duplicate-commit check, so a restart cannot re-commit a
 * generation its predecessor already closed.
 */
export function generationAlreadyCommitted(ledgerPath, generation, sessionId) {
	// Fail closed: unreadable history is NOT "uncommitted". A gate that cannot
	// read the record must refuse, even though a REPORT must not claim the commit
	// is there. That difference is why `commitRecordState()` exists.
	return commitRecordState(ledgerPath, generation, sessionId) !== "NOT_COMMITTED";
}

/**
 * Tri-state answer to "does the ledger record this generation as committed?".
 *
 * `generationAlreadyCommitted()` collapses "COMMITTED" and "UNREADABLE" to
 * `true` so callers fail closed — correct for a gate, wrong for a report.
 * Measured in independent review: with the ledger path replaced by a directory,
 * the commit append failed, this precheck returned `true` because history was
 * unreadable, and the frame claimed `ledgerRecorded: true` for a commit that was
 * never written. A report must distinguish the two.
 *
 * @returns {"COMMITTED"|"NOT_COMMITTED"|"UNREADABLE"}
 */
export function commitRecordState(ledgerPath, generation, sessionId) {
	if (!ledgerPath || !isValidGeneration(generation)) return "NOT_COMMITTED";
	const read = readLedger(ledgerPath, sessionId);
	if (read.corrupt) return "UNREADABLE";
	return read.records.some(record => record.type === RECORD_COMMIT && record.generation === generation)
		? "COMMITTED"
		: "NOT_COMMITTED";
}
