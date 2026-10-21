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
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { withLedgerLock } from "./ledger-lock.mjs";
import { controllerCapability } from "./controller-capability.mjs";
import { signLedgerRecord, verifyLedgerRecord } from "./ledger-auth.mjs";

/**
 * Directory holding the ledger. R4 renamed the *capability* without renaming the
 * variable: the value is still read from the environment, but a value is no
 * longer sufficient — a ledger operation requires an installed controller
 * capability (see `lib/controller-capability.mjs`). The variable now only says
 * WHERE, never WHETHER.
 */
const STATE_DIR_ENV = "OMP_TERMINAL_FENCE_STATE_DIR";

/**
 * ONE ledger file per controller root (R4).
 *
 * It used to be `<stateDir>/<sessionId>.jsonl`. The file name cannot be
 * pre-opened by the controller, because the controller does not know the session
 * id before the child starts — and the launch sandbox denies path writes to the
 * ledger directory, so the extension can only write through the descriptor the
 * controller handed it. A fixed name is what makes that descriptor possible.
 * Session identity is a FIELD in every record, so nothing is lost: readers
 * filter by `sessionId` exactly as before.
 */
const LEDGER_FILE_NAME = "ledger.jsonl";

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

function ledgerPath(dir) {
	return join(dir, LEDGER_FILE_NAME);
}

/**
 * The directory the cross-process lock is created in, when the controller
 * provisioned one separate from the ledger.
 *
 * Under a governed launch the ledger directory is write-denied by the sandbox and
 * the ledger is reached through an inherited descriptor. A lock, however, is
 * created by PATH — so it lives in a directory the runtime can write. The ledger
 * bytes stay unreachable; only the lock is writable.
 */
function capabilityLockDir() {
	const capability = controllerCapability();
	return capability && capability.lockDir ? capability.lockDir : null;
}

/** Generations must be positive safe integers; beyond that `+1` is not representable. */
function isValidGeneration(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Read and validate a ledger, and AUTHENTICATE every record (R4).
 *
 * The distinction this function exists to draw:
 *
 *   records          records whose MAC verifies under the controller's key AND
 *                    whose fields are structurally valid. These are EVIDENCE.
 *   unauthenticated  lines that parse but do not authenticate — a hand-written
 *                    record, a record signed by a different root, an edited
 *                    record, a torn append. These are NOT evidence. They are
 *                    counted and ignored.
 *   corrupt          the file cannot be read at all. Callers must fail closed
 *                    (never report a commit, never claim "not committed").
 *
 * Why unauthenticated records are IGNORED rather than treated as corruption:
 * treating them as corruption would hand the Agent a denial primitive — append
 * one junk line and every legitimate commit fails closed forever. The admission
 * card measured exactly that shape. A record the controller did not sign simply
 * has no bearing on what the ledger asserts.
 *
 * Foreign-session records are legitimate (one ledger file serves a controller
 * root), so they are filtered out rather than called corruption.
 */
function readLedger(path, sessionId) {
	if (!existsSync(path)) return { records: [], unauthenticated: 0, corrupt: null };
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { records: [], unauthenticated: 0, corrupt: `UNREADABLE: ${String(error)}` };
	}
	const capability = controllerCapability();
	const key = capability ? capability.key : null;
	const records = [];
	let unauthenticated = 0;
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === "") continue;
		let parsed;
		try {
			parsed = JSON.parse(line);
		} catch {
			// A torn append, or a line somebody typed by hand. Either way it is not
			// a statement the controller made.
			unauthenticated += 1;
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			unauthenticated += 1;
			continue;
		}
		if (parsed.type !== RECORD_ALLOCATE && parsed.type !== RECORD_COMMIT) {
			unauthenticated += 1;
			continue;
		}
		if (!isValidGeneration(parsed.generation)) {
			unauthenticated += 1;
			continue;
		}
		if (typeof parsed.runtimeInstanceId !== "string" || parsed.runtimeInstanceId.length === 0) {
			unauthenticated += 1;
			continue;
		}
		// THE MAC IS THE GATE. Everything below this line is about *whose* record
		// it is, not about whether it is real.
		if (!verifyLedgerRecord(key, parsed)) {
			unauthenticated += 1;
			continue;
		}
		// A record this session's ledger is asked about must name that session. A
		// signed record for a DIFFERENT session is not corruption — one ledger file
		// serves the whole controller root — it is simply not this session's record.
		if (sessionId !== undefined && parsed.sessionId !== sessionId) continue;
		records.push(parsed);
	}
	return { records, unauthenticated, corrupt: null };
}

/**
 * Test-only fault injection for the ledger append.
 *
 * `R2_T3f`'s comment described an injected claim-write failure, but its body only
 * performed a normal commit — independent review caught the overstatement. A
 * comment is not a test, so the seam it needed exists now: a test can make the
 * NEXT append of a given record type fail, which is how "the commit record is
 * durable but the next-generation claim was not" is actually exercised.
 *
 * This is not a production switch: the hook is unset unless a test sets it, it
 * holds one one-shot value, and it clears itself when it fires.
 */
let appendFault = null;

/** Make the next append of `type` fail. Returns nothing; one-shot. */
export function injectAppendFault(type) {
	appendFault = type;
}

/** Clear any injected fault. */
export function clearAppendFault() {
	appendFault = null;
}

/**
 * Test-only: simulate a peer committing the SAME generation in the window between
 * this runtime's precheck and its own append.
 *
 * That window is what the lock exists to close, so in correct operation it cannot
 * be opened — which would leave the post-append uniqueness check untestable and
 * therefore unproven. This hook opens it deliberately, once, so the guard can be
 * shown to fire. It writes nothing itself; the caller supplies the record.
 */
let postAppendPeer = null;

export function injectPostAppendPeerCommit(record) {
	postAppendPeer = record;
}

export function clearPostAppendPeerCommit() {
	postAppendPeer = null;
}

/**
 * Append one record, AUTHENTICATED (R4).
 *
 * Two things changed here and both are load-bearing:
 *
 *  1. The record is signed with the controller's ledger key before it is
 *     written. An unsigned record is not evidence, so a writer that cannot sign
 *     must not write at all — a half-authenticated ledger would be worse than
 *     none.
 *  2. The write goes through the descriptor the controller opened, when there is
 *     one. That is what lets the launch sandbox deny `file-write*` on the ledger
 *     path: the extension keeps working through the fd it was handed, while the
 *     Agent's `bash` descendants — which do not inherit the descriptor — have
 *     neither the fd nor the path.
 */
/**
 * True when the ledger's current last byte is not a newline, so an append must
 * start a fresh line rather than concatenate onto a rejected tail.
 *
 * A missing file, an empty file, or an unreadable one all return `false`: in the
 * first two there is no tail, and in the third the append will fail on its own
 * terms rather than because of a boundary decision.
 */
function needsLeadingNewline(path) {
	try {
		const size = statSync(path).size;
		if (size === 0) return false;
		const fd = openSync(path, "r");
		try {
			const last = Buffer.allocUnsafe(1);
			readSync(fd, last, 0, 1, size - 1);
			return last[0] !== 0x0a;
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

function appendRecord(path, record) {
	if (appendFault !== null && record.type === appendFault) {
		appendFault = null;
		return `APPEND_FAILED: INJECTED_${record.type.toUpperCase()}_FAILURE`;
	}
	const capability = controllerCapability();
	if (!capability) return "APPEND_REFUSED: NO_CONTROLLER_CAPABILITY";
	const signed = signLedgerRecord(capability.key, record);
	// A REJECTED TAIL MUST NOT SWALLOW THE NEXT AUTHENTIC RECORD.
	//
	// Measured by independent review: ignoring an unterminated junk tail made the
	// NEXT append concatenate onto it — `garbage{"type":"commit",…}\n` — and BOTH
	// readers discard the whole line, so an authentic commit vanished. That turned
	// "unsigned text is ignored" into a denial primitive again, one level down.
	//
	// The fix is a line boundary, not a repair: if the file does not end with a
	// newline, this append starts with one. The junk stays junk (it is still not
	// evidence) and the new record is a line of its own.
	const line = `${needsLeadingNewline(path) ? "\n" : ""}${JSON.stringify(signed)}\n`;

	// The inherited descriptor is tried FIRST. If it is present but the write
	// fails, that is a refusal, not a reason to fall back to the path: falling back
	// would silently reintroduce the write the sandbox was denying.
	if (capability.ledgerFd !== null) {
		try {
			writeSync(capability.ledgerFd, line);
			// The commit record must be DURABLE, not merely written: the whole point
			// of the ledger is that it survives the process. An fd write without
			// fsync would make `ledgerRecorded: true` a claim about a page cache.
			fsyncSync(capability.ledgerFd);
			return null;
		} catch (error) {
			return `APPEND_FAILED: LEDGER_FD ${String(error)}`;
		}
	}
	// THE PATH WRITE IS A CONTROLLER-EMBEDDED PATH, NOT A FALLBACK.
	//
	// Measured by independent review: when the descriptor re-open failed, the
	// capability carried `ledgerFd:null` and this branch opened the ledger BY PATH.
	// Under a governed launch the sandbox denies that path, so the write failed —
	// but "the sandbox will catch it" is the wrong reason for a fallback to exist.
	//
	// It is kept because the extension is also used IN-PROCESS by tests and by a
	// controller that embeds it, where no descriptor is involved and no sandbox is
	// denying anything. It is unreachable in a governed launch: there the descriptor
	// is always present, and if it were not, `APPEND_REFUSED` above has already
	// returned.
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

	// The read-decide-append-verify sequence below is ONE transaction. Without the
	// lock two processes could both read `max = N` and both append `N+1`; the
	// post-append re-read would then report COLLISION to both of them, which is a
	// denial rather than a double commit — but it also means neither can proceed.
	// The lock makes the second process observe the first's allocation and take
	// the NEXT number instead, so concurrency costs nothing and exclusion is real.
	const locked = withLedgerLock({
		ledgerPath: path,
		lockDir: capabilityLockDir(),
		fn: () => allocateGenerationLocked({ sessionId, runtimeInstanceId, path, now }),
	});
	if (!locked.ok) {
		// Fail closed: an unacquirable lock is not permission to allocate anyway.
		return {
			...base,
			generation: null,
			identityState: "UNWRITABLE",
			identityError: `LOCK_${locked.code}${locked.detail ? `: ${locked.detail}` : ""}`,
			ledgerPath: path,
		};
	}
	return { ...base, ...locked.value };
}

/** The allocation transaction itself. Callers MUST hold the ledger lock. */
function allocateGenerationLocked({ sessionId, runtimeInstanceId, path, now }) {
	const read = readLedger(path, sessionId);
	if (read.corrupt) {
		return { generation: null, identityState: "CORRUPT", identityError: read.corrupt, ledgerPath: path };
	}

	const previousGeneration = read.records.reduce(
		(max, record) => (record.generation > max ? record.generation : max),
		0,
	);
	if (!Number.isSafeInteger(previousGeneration + 1)) {
		return {
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
			generation: null,
			identityState: "UNWRITABLE",
			identityError: appendError,
			ledgerPath: path,
			previousGeneration,
		};
	}

	// Re-read under the same rules: exactly one allocate record may claim this
	// generation AND carry this token. Anything else — a hand-edited ledger, a
	// truncated append — is not ours to use. Under the lock a peer cannot have
	// raced us, so a second claimant is evidence of corruption, not of timing.
	const verify = readLedger(path, sessionId);
	if (verify.corrupt) {
		return { generation: null, identityState: "CORRUPT", identityError: verify.corrupt, ledgerPath: path };
	}
	const claimants = verify.records.filter(
		record => record.type === RECORD_ALLOCATE && record.generation === generation,
	);
	if (claimants.length !== 1 || claimants[0].allocationToken !== allocationToken) {
		return {
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
	allocationToken = null,
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
	// The duplicate check, the commit append, the next-generation claim and its
	// verification are ONE transaction. Residual risk §6.6 of the predecessor card
	// named the gap exactly: "a peer can append between this runtime's write and
	// its re-read… detection, not mutual exclusion". Under the lock the check and
	// the write cannot be separated by a peer, so a second process reaching this
	// point observes the first process's commit record and is refused, rather than
	// both of them writing.
	const locked = withLedgerLock({
		ledgerPath,
		lockDir: capabilityLockDir(),
		fn: () =>
			recordCommitAndClaimNextLocked({
				ledgerPath,
				sessionId,
				runtimeInstanceId,
				generation,
				status,
				requestId,
				allocationToken,
				now,
			}),
	});
	if (!locked.ok) {
		return {
			error: `LOCK_${locked.code}${locked.detail ? `: ${locked.detail}` : ""}`,
			committedRecorded: false,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	return locked.value;
}

/** The commit transaction itself. Callers MUST hold the ledger lock. */
function recordCommitAndClaimNextLocked({ ledgerPath, sessionId, runtimeInstanceId, generation, status, requestId, allocationToken = null, now }) {
	// Never write a second commit record for one generation. Measured in
	// independent review: after a failed advance the automatic fence leg appended
	// a duplicate `commit:2` beside a peer's, so the ledger recorded two commits
	// for one generation. The ledger is the durable statement of what committed;
	// a duplicate there is worse than a refused write.
	//
	// R4: this is the GATE question (is the generation closed at all?), so it is
	// asked without an identity filter. A peer's authenticated commit must stop
	// this runtime from writing a second one.
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
	const commitPayload = {
		type: RECORD_COMMIT,
		sessionId,
		runtimeInstanceId,
		generation,
		// R4: the allocation token binds the commit to the allocation that owned
		// the generation. Without it, "this runtime committed generation N" cannot
		// be distinguished from "this runtime committed some generation N it never
		// owned".
		allocationToken,
		status,
		requestId: requestId ?? null,
		at: now,
	};
	const commitError = appendRecord(ledgerPath, commitPayload);
	if (commitError) return { error: commitError, committedRecorded: false, nextGeneration: null, allocationToken: null };

	// UNIQUENESS IS VERIFIED, NOT ASSUMED.
	//
	// The lock is supposed to make the precheck and this append one transaction. If
	// it ever fails to — a reclaim race, a filesystem that ignores the link, a
	// hand-edited ledger — two processes could both pass the precheck and both
	// append a commit for one generation. The card's requirement is not "the lock is
	// correct", it is "no double valid commit", so the outcome is checked rather
	// than trusted: after appending, this runtime re-reads the ledger and counts the
	// commit records for its generation. Exactly one, and it must be this process's
	// own record (matched on runtime instance and request id).
	//
	// When the count is not one, this runtime reports the commit as NOT recorded and
	// says why. It does not attempt to repair the ledger: two records for one
	// generation is a corrupted durable statement, and the correct response to
	// corruption is to refuse to add meaning to it.
	if (postAppendPeer !== null) {
		const peer = postAppendPeer;
		postAppendPeer = null;
		appendRecord(ledgerPath, { ...peer, type: RECORD_COMMIT, sessionId });
	}
	const afterAppend = readLedger(ledgerPath, sessionId);
	if (afterAppend.corrupt) {
		return {
			error: `VERIFY_${afterAppend.corrupt}`,
			committedRecorded: true,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	const commitRecords = afterAppend.records.filter(
		record => record.type === RECORD_COMMIT && record.generation === generation,
	);
	const mine = commitRecords.filter(
		record => record.runtimeInstanceId === runtimeInstanceId && (record.requestId ?? null) === (requestId ?? null),
	);
	if (commitRecords.length !== 1 || mine.length !== 1) {
		return {
			error: `COMMIT_RECORD_NOT_UNIQUE_${commitRecords.length}_FOR_GENERATION_${generation}`,
			committedRecorded: false,
			nextGeneration: null,
			allocationToken: null,
		};
	}

	// From here the COMMIT RECORD IS DURABLE. The claim that follows can still
	// fail, and the two facts are different: the ledger knows this generation
	// committed, but this runtime cannot name the next one. Measured in
	// independent review with an injected EIO on the claim append: the caller
	// reported `ledgerRecorded:false` while `commit:g1` was on disk, so the
	// documented meaning of that field was wrong. `committedRecorded` carries the
	// distinction; `error` keeps reporting the failure.
	//
	// THE NEXT NUMBER IS NOT NECESSARILY `generation + 1`.
	//
	// A peer process on the same session may already own the number immediately
	// after this one. Claiming `generation + 1` blindly then puts TWO allocate
	// records on that number, and `verifyOwnership` refuses it for BOTH parties —
	// the peer is locked out of the generation it was already running, and cannot
	// commit at all. Measured in the R3 two-runtime transport case: process A
	// committed generation 1, claimed 2, and process B's live generation 2 became
	// unownable (`GENERATION_OWNERSHIP_LOST`).
	//
	// The claim therefore takes the next number this runtime may legitimately own:
	// the ledger's highest generation plus one, skipping past any number a peer has
	// already allocated. That is the same rule `allocateGeneration` uses, applied
	// inside the same transaction, so the two cannot disagree.
	const observed = readLedger(ledgerPath, sessionId);
	if (observed.corrupt) {
		return { error: `VERIFY_${observed.corrupt}`, committedRecorded: true, nextGeneration: null, allocationToken: null };
	}
	const highest = observed.records.reduce((max, record) => (record.generation > max ? record.generation : max), 0);
	const nextGeneration = Math.max(highest, generation) + 1;
	if (!Number.isSafeInteger(nextGeneration)) {
		return {
			error: `GENERATION_RANGE_EXHAUSTED_AT_${highest}`,
			committedRecorded: true,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	// A NEW token for the NEXT generation. The `allocationToken` parameter names
	// the token of the generation being committed; reusing it here would let the
	// next generation be claimed with an already-spent token.
	const nextAllocationToken = randomBytes(8).toString("hex");
	const claimError = appendRecord(ledgerPath, {
		type: RECORD_ALLOCATE,
		sessionId,
		runtimeInstanceId,
		generation: nextGeneration,
		allocationToken: nextAllocationToken,
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
	if (claimants.length !== 1 || claimants[0].allocationToken !== nextAllocationToken) {
		return {
			error: `NEXT_GENERATION_${nextGeneration}_CLAIMED_${claimants.length}_TIMES`,
			committedRecorded: true,
			nextGeneration: null,
			allocationToken: null,
		};
	}
	return { error: null, committedRecorded: true, nextGeneration, allocationToken: nextAllocationToken };
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
 * TWO DIFFERENT QUESTIONS, DELIBERATELY SEPARATED (R4)
 * ---------------------------------------------------
 * The card requires the full runtime/allocation identity to be checked, not just
 * `type + generation + sessionId`. But "is this generation closed?" and "is it
 * closed BY ME?" are not the same question, and collapsing them would introduce
 * a double-commit:
 *
 *   generationAlreadyCommitted(...)        ANY authenticated commit for
 *                                          (session, generation) closes the
 *                                          generation. This is the GATE: a peer's
 *                                          commit must stop this runtime from
 *                                          writing a second one.
 *   commitRecordState(..., identity)       the commit is attributable to THIS
 *                                          runtime and THIS allocation. This is
 *                                          the ATTRIBUTION check, used when a
 *                                          caller reports on its own commit.
 *
 * A record whose MAC does not verify is never counted by either: it is not a
 * statement the controller made, so it can neither close a generation nor
 * attribute one.
 *
 * @param {object|null} [identity] `{ runtimeInstanceId?, allocationToken? }`.
 *   When supplied, every supplied field must match for COMMITTED to be returned.
 *   When omitted, the answer is the gate-level one: does ANY authenticated commit
 *   exist for this (session, generation)?
 * @returns {"COMMITTED"|"NOT_COMMITTED"|"UNREADABLE"}
 */
export function commitRecordState(ledgerPath, generation, sessionId, identity = null) {
	if (!ledgerPath || !isValidGeneration(generation)) return "NOT_COMMITTED";
	const read = readLedger(ledgerPath, sessionId);
	if (read.corrupt) return "UNREADABLE";
	const commits = read.records.filter(
		record => record.type === RECORD_COMMIT && record.generation === generation,
	);
	if (identity === null || identity === undefined) return commits.length > 0 ? "COMMITTED" : "NOT_COMMITTED";
	if (typeof identity !== "object" || Array.isArray(identity)) return "NOT_COMMITTED";
	const wantRuntime = identity.runtimeInstanceId;
	const wantToken = identity.allocationToken;
	// A supplied field that disagrees is a rejection. An omitted field is not
	// checked, which is how a caller that only knows its runtime can still ask.
	const attributed = commits.filter(record => {
		if (typeof wantRuntime === "string" && record.runtimeInstanceId !== wantRuntime) return false;
		if (typeof wantToken === "string" && (record.allocationToken ?? null) !== wantToken) return false;
		return true;
	});
	return attributed.length > 0 ? "COMMITTED" : "NOT_COMMITTED";
}
