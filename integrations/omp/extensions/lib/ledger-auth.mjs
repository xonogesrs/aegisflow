// lib/ledger-auth.mjs
//
// AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1 — R4-B.
//
// Problem this closes
// -------------------
// The R3 ledger was plain text in a directory the governed Agent's own `bash`
// could write. A commit record was believed because it *looked* right:
// `{"type":"commit","generation":1,…}`. The admission card measured the
// consequence — a forged record was reported as COMMITTED, and the extension's
// own duplicate gate then refused the legitimate controller
// (`GENERATION_ALREADY_COMMITTED`). RPC result frames were HMAC-protected; the
// ledger was not. Those are two different trust boundaries and this module
// gives the second one the same treatment as the first.
//
// The model
// ---------
// A ledger record is evidence ONLY when it carries a MAC that verifies under
// the controller's per-root ledger key. Everything else — a hand-written line, a
// record from a different root, a truncated append, a replayed record whose
// fields were edited — is *not evidence*. It is counted and ignored, never
// promoted to COMMITTED and never allowed to deny a legitimate commit.
//
// Key custody (the part that makes the MAC mean something)
// -------------------------------------------------------
// The key is 32 random bytes stored at `<controllerRoot>/ledger.key` with mode
// 0600 and created once per root, so records stay verifiable across restarts of
// the governed runtime. The governed child never opens that path:
//
//   * the controller reads the key and hands it to the child over a dedicated
//     file descriptor (`OMP_CONTROLLER_LEDGER_KEY_FD`, default 4);
//   * the extension reads it once at load and closes the descriptor;
//   * the descriptor is close-on-exec, so the Agent's `bash` descendants do not
//     inherit it (measured: a grandchild sees `FD3_ABSENT`);
//   * the launch sandbox additionally denies `file-read*` on the key path, so
//     even a descendant that guesses the path cannot read it.
//
// This is a real boundary rather than a naming convention: what the Agent
// lacks is a *capability* (an open descriptor and the bytes behind it), not a
// variable it could set for itself.
//
// What this deliberately is NOT
// -----------------------------
// No key rotation, no certificate chain, no external KMS. The controller is the
// only party that mints commits, so a single per-root symmetric key is the
// smallest thing that answers "did the controller produce this record". Rotation
// is a deployment concern and is named as residual risk rather than half-built.

import { createHmac, timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { canonicalJson } from "./controller-result.mjs";

/** Environment variable naming the descriptor that carries the ledger key. */
export const LEDGER_KEY_FD_ENV = "OMP_CONTROLLER_LEDGER_KEY_FD";
/** Environment variable naming the descriptor that carries the ledger file. */
export const LEDGER_FD_ENV = "OMP_TERMINAL_FENCE_LEDGER_FD";
/** Environment variable naming the directory the ledger lock lives in. */
export const LOCK_DIR_ENV = "OMP_TERMINAL_FENCE_LOCK_DIR";
/** The only accepted key encoding: 32 bytes, lowercase hex. */
export const LEDGER_KEY_PATTERN = /^[0-9a-f]{64}$/;
/** Why the last `reopenLedgerFdForPrivateUse` returned null. Diagnostics only. */
let lastReopenFailure = null;

/** The cause of the last failed descriptor re-open, or null. Never authority. */
export function lastReopenError() {
	return lastReopenFailure;
}
/** Field carrying the MAC on a ledger record. */
export const LEDGER_MAC_FIELD = "mac";
/** Schema tag so a record from a future format is not silently accepted. */
export const LEDGER_RECORD_SCHEMA = 1;

/**
 * The exact bytes the MAC covers.
 *
 * `canonicalJson` sorts keys, so the MAC is independent of property order and
 * of the serializer that wrote the line. The `mac` field itself is excluded, and
 * so is any field added after signing — a verifier reconstructs this object from
 * the parsed record, never from the raw line, so an attacker cannot smuggle
 * extra keys past the MAC.
 */
export function ledgerMacInput(record) {
	return canonicalJson({
		v: record.v ?? LEDGER_RECORD_SCHEMA,
		type: record.type,
		sessionId: record.sessionId,
		runtimeInstanceId: record.runtimeInstanceId,
		generation: record.generation,
		allocationToken: record.allocationToken ?? null,
		status: record.status ?? null,
		requestId: record.requestId ?? null,
		at: record.at ?? null,
	});
}

/** Sign one ledger record. Returns a NEW object; the input is not mutated. */
export function signLedgerRecord(key, record) {
	const body = { ...record, v: record.v ?? LEDGER_RECORD_SCHEMA };
	const mac = createHmac("sha256", key).update(ledgerMacInput(body)).digest("hex");
	return { ...body, [LEDGER_MAC_FIELD]: mac };
}

/**
 * Verify one record's MAC in constant time.
 *
 * A record with no MAC, a malformed MAC, or a MAC that does not match is simply
 * not evidence. This never throws: a verifier that throws on hostile input is a
 * verifier that can be turned into a denial.
 */
export function verifyLedgerRecord(key, record) {
	if (typeof key !== "string" || !LEDGER_KEY_PATTERN.test(key)) return false;
	if (!record || typeof record !== "object" || Array.isArray(record)) return false;
	const mac = record[LEDGER_MAC_FIELD];
	if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
	let expected;
	try {
		expected = createHmac("sha256", key).update(ledgerMacInput(record)).digest();
	} catch {
		return false;
	}
	const actual = Buffer.from(mac, "hex");
	if (actual.length !== expected.length) return false;
	return timingSafeEqual(actual, expected);
}

/**
 * Read the ledger key from an inherited descriptor and close it.
 *
 * The descriptor is consumed whatever happens: a key that stays readable by the
 * process is a key a later extension could read, and a descriptor left open is
 * one more thing a descendant might be handed by accident.
 *
 * @returns {string|null} the key, or null when absent/malformed/unreadable.
 */
export function readLedgerKeyFromFd(fd) {
	if (!Number.isInteger(fd) || fd < 3) return null;
	// STAT BEFORE READING.
	//
	// A descriptor NUMBER is not a capability. An environment value of "4" says
	// nothing about what descriptor 4 refers to in this process, and a blocking
	// read on a pipe or socket would hang the runtime at module load. Measured: an
	// ungoverned child whose fd 4 happened to be open hung indefinitely before this
	// check existed.
	//
	// A key is exactly 65 bytes of regular file (64 hex digits + newline), so the
	// gate is: it must be a regular file, and it must be small. Anything else is
	// not a key, and is not read.
	let stat;
	try {
		stat = fstatSync(fd);
	} catch {
		return null;
	}
	if (!stat.isFile() || stat.size === 0 || stat.size > 256) {
		// DO NOT CLOSE IT.
		//
		// This descriptor is only OURS when the controller actually handed it over.
		// In an ungoverned process the number may name something the host runtime
		// owns, and closing it corrupts that runtime — measured: an ordinary
		// `omp --mode rpc` child exited 1 with no output at all, because the
		// extension had closed a descriptor it never received. A descriptor that
		// does not look like a key is left exactly as it was found.
		return null;
	}
	let raw;
	try {
		raw = readFileSync(fd, "utf8");
	} catch {
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// A descriptor that was never open is already in the desired state.
		}
	}
	const key = String(raw).trim();
	return LEDGER_KEY_PATTERN.test(key) ? key : null;
}

/**
 * Turn an inherited ledger descriptor into a private one (R4).
 *
 * A descriptor the controller passes as a stdio slot is `dup2`'d into place,
 * which CLEARS close-on-exec — so it survives into every process the governed
 * runtime spawns. Measured on this host: a Node grandchild reported
 * `FD3_INHERITED` for a descriptor the child itself was given.
 *
 * The Agent's `bash` tool is exactly such a grandchild. Handing it a writable
 * ledger descriptor would recreate the defect this card exists to close.
 *
 * So the inherited descriptor is re-opened through `/dev/fd/N` — libuv opens it
 * with `O_CLOEXEC` — and the inherited one is closed. Measured: the re-opened
 * descriptor is `OWN_ABSENT` in a grandchild while writes through it still land.
 *
 * @returns {number|null} a close-on-exec append descriptor, or null.
 */
export function reopenLedgerFdForPrivateUse(fd) {
	if (!Number.isInteger(fd) || fd < 3) return null;
	let own = null;
	try {
		own = openSync(`/dev/fd/${fd}`, "a", 0o600);
	} catch (error) {
		// Report the CAUSE. A bare `return null` here hid a missing import for two
		// debugging rounds: the function threw `ReferenceError: openSync is not
		// defined`, the catch swallowed it, and the symptom was an unrelated
		// `APPEND_FAILED: EPERM` several layers away.
		lastReopenFailure = String(error && error.code ? error.code : error && error.message ? error.message : error);
		return null;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Already gone; nothing to revoke.
		}
	}
	return own;
}

/** Parse the descriptor number from an environment value. */
export function parseFd(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 3 ? parsed : fallback;
}
