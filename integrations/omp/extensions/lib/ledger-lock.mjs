// lib/ledger-lock.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1 — C6.
//
// Problem this closes
// -------------------
// The identity ledger's duplicate-commit check was a *detection*: read, decide,
// append, with nothing preventing a peer process from appending between the read
// and the append. Residual risk §6.6 of the predecessor card said so in as many
// words — "Ledger appends are not atomic across processes… A lock file around
// allocation would be the real fix and is outside this card."
//
// This module IS that lock file, and nothing more:
//
//   * acquisition is one `open(O_CREAT|O_EXCL)`, which is atomic on every
//     filesystem this integration is deployed on;
//   * the record names the owner (pid + host + token) so a release can prove it
//     still owns what it is releasing;
//   * a holder that is provably dead on THIS host may be reclaimed, and only
//     after the record is re-read and byte-compared so a lock created by someone
//     else in the meantime is not stolen;
//   * every unprovable case — foreign host, corrupt record, unreadable file,
//     live owner past the deadline — fails closed with a distinct code.
//
// What it deliberately is NOT
// ---------------------------
// No daemon, no lease renewal, no fencing token service, no backoff schedule
// tuned to a network. The critical section it protects is a handful of
// synchronous file operations inside one directory, so the only liveness
// question that matters is "did this process die while holding it", and that
// question is answered from the local process table.

import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

/** Default bound on waiting for a busy lock. The critical section is microseconds. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
/**
 * A record younger than this is never treated as abandoned, even when its pid is
 * absent: a process that has created the file but not yet finished writing it
 * would otherwise be reclaimed mid-acquire.
 */
export const DEFAULT_MIN_STALE_AGE_MS = 50;
const RETRY_BACKOFF_MS = 10;

/** Suffix appended to a ledger path to name its lock. */
export const LOCK_SUFFIX = ".lock";

/**
 * Lock paths this process currently holds.
 *
 * The lock is exclusive per PROCESS, not per call site: `recordCommitAndClaimNext`
 * calls `commitRecordState`, and both must see one consistent transaction. A
 * nested acquire therefore runs its critical section directly — the outer
 * section is still executing and JavaScript cannot preempt synchronous code, so
 * the nested call is inside the very transaction it is asking for.
 */
const heldByThisProcess = new Set();

export const LEDGER_LOCK = Object.freeze({
	BUSY: "LEDGER_LOCK_BUSY",
	CORRUPT: "LEDGER_LOCK_CORRUPT",
	FOREIGN_HOST: "LEDGER_LOCK_FOREIGN_HOST",
	SYMLINK: "LEDGER_LOCK_SYMLINK",
	UNREADABLE: "LEDGER_LOCK_UNREADABLE",
	RECLAIM_FAILED: "LEDGER_LOCK_RECLAIM_FAILED",
	RELEASE_NOT_OWNER: "LEDGER_LOCK_RELEASE_NOT_OWNER",
});

export function lockPathFor(ledgerPath, lockDir = null) {
	// R4: the lock normally lives beside the ledger. Under a governed launch the
	// ledger directory is write-denied to everything except the inherited
	// descriptor, and a lock is created by PATH — so the controller provisions a
	// separate lock directory that IS writable. Same exclusivity, different
	// location, and the ledger bytes themselves stay unreachable.
	if (typeof lockDir === "string" && lockDir.length > 0) {
		const name = ledgerPath.split("/").pop() ?? "ledger";
		return `${lockDir}/${name}${LOCK_SUFFIX}`;
	}
	return `${ledgerPath}${LOCK_SUFFIX}`;
}

function thisHost() {
	try {
		return String(hostname());
	} catch {
		return "unknown-host";
	}
}

/**
 * Synchronous sleep without a timer.
 *
 * The callers of this module are synchronous on purpose: the ledger transaction
 * must not interleave with an `await` inside the extension's command handler,
 * where another task could re-enter the same state.
 */
function sleepSync(ms) {
	if (!(ms > 0)) return;
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		// A runtime without SharedArrayBuffer cannot block; spinning is bounded by
		// the caller's deadline, so this degrades to a busy retry rather than a hang.
	}
}

function alive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && error.code === "ESRCH") return false;
		// EPERM: the process exists but is not ours. Existence is what matters.
		return error && error.code === "EPERM" ? true : null;
	}
}

/** @returns {{ok: true, record: object, bytes: string} | {ok: false, code: string, detail?: string}} */
function readLockRecord(lockPath) {
	let stat;
	try {
		stat = lstatSync(lockPath);
	} catch {
		return { ok: false, code: "ABSENT" };
	}
	if (stat.isSymbolicLink()) return { ok: false, code: LEDGER_LOCK.SYMLINK };
	if (!stat.isFile()) return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "NOT_A_REGULAR_FILE" };
	let bytes;
	try {
		bytes = readFileSync(lockPath, "utf8");
	} catch (error) {
		// The lock was released between the lstat and the read. That is the normal
		// release path, not corruption: measured under 8-way contention, mapping it
		// to UNREADABLE made two of eight processes fail closed on a lock that had
		// simply become free.
		if (error && error.code === "ENOENT") return { ok: false, code: "ABSENT" };
		return { ok: false, code: LEDGER_LOCK.UNREADABLE, detail: String(error && error.message ? error.message : error) };
	}
	let record;
	try {
		record = JSON.parse(bytes);
	} catch {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "MALFORMED_JSON" };
	}
	if (!record || typeof record !== "object" || Array.isArray(record)) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "NOT_AN_OBJECT" };
	}
	if (!Number.isInteger(record.pid) || record.pid <= 0) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "BAD_PID" };
	}
	if (typeof record.token !== "string" || record.token.length === 0) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "MISSING_TOKEN" };
	}
	if (typeof record.host !== "string" || record.host.length === 0) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "MISSING_HOST" };
	}
	if (!Number.isFinite(record.acquiredAt)) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "BAD_ACQUIRED_AT" };
	}
	return { ok: true, record, bytes };
}

/**
 * Publish a fully-written lock record at `lockPath`, atomically.
 *
 * The obvious implementation — `open(O_EXCL)` then write — has a real window: the
 * path exists while the record is still empty, so a peer that reads it at that
 * instant sees a malformed record. Measured under 8-way contention: 1–4 of 8
 * processes reported `LEDGER_LOCK_CORRUPT: MALFORMED_JSON` and failed closed, for
 * a lock that was merely being written.
 *
 * `link(2)` closes the window: the record is written and fsynced at a private
 * temp path, then linked into place. The link is atomic and fails with EEXIST if
 * the lock exists, so a reader only ever observes a complete record.
 */
function tryCreate(lockPath, record) {
	const payload = `${JSON.stringify(record)}\n`;
	const temp = `${lockPath}.${record.pid}.${record.token}.tmp`;
	let fd;
	try {
		fd = openSync(temp, "wx", 0o600);
		writeSync(fd, payload);
		fsyncSync(fd);
	} catch (error) {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// nothing to recover
			}
		}
		try {
			unlinkSync(temp);
		} catch {
			// nothing to clean
		}
		throw error;
	}
	try {
		closeSync(fd);
	} catch {
		// The bytes are durable; a close failure does not change that.
	}
	try {
		linkSync(temp, lockPath);
	} catch (error) {
		if (error && error.code === "EEXIST") {
			unlinkSync(temp);
			return { acquired: false };
		}
		// A filesystem without hard links cannot use this path. Fall back to the
		// exclusive-create form, which is correct but has the write window above;
		// the caller's retry loop absorbs it.
		if (error && (error.code === "ENOTSUP" || error.code === "EPERM" || error.code === "EXDEV")) {
			unlinkSync(temp);
			return tryCreateExclusive(lockPath, payload);
		}
		unlinkSync(temp);
		throw error;
	}
	unlinkSync(temp);
	return { acquired: true };
}

/** Exclusive-create fallback for filesystems without hard links. */
function tryCreateExclusive(lockPath, payload) {
	let fd;
	try {
		fd = openSync(lockPath, "wx", 0o600);
	} catch (error) {
		if (error && error.code === "EEXIST") return { acquired: false };
		throw error;
	}
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		try {
			closeSync(fd);
		} catch {
			// A close failure does not undo the create; the record is already durable.
		}
	}
	return { acquired: true };
}

/**
 * Reclaim a lock whose owner is provably gone.
 *
 * The record is re-read immediately before the unlink and byte-compared with the
 * one that was judged stale. A lock created by another process in that window is
 * therefore NOT removed: the comparison fails and the caller retries the normal
 * acquire path, which will either succeed (the other owner released) or report
 * the lock busy. Reclaim is a convenience for crash recovery, never a path that
 * can hand two processes the same lock.
 */
function reclaim(lockPath, staleBytes) {
	let current;
	try {
		current = readFileSync(lockPath, "utf8");
	} catch {
		// Vanished: someone released it. The retry loop will acquire it normally.
		return { reclaimed: false, vanished: true };
	}
	if (current !== staleBytes) return { reclaimed: false, changed: true };
	try {
		unlinkSync(lockPath);
	} catch (error) {
		return { reclaimed: false, error: String(error && error.message ? error.message : error) };
	}
	return { reclaimed: true };
}

/**
 * Run `fn` while holding the exclusive ledger lock.
 *
 * @param {object} options
 * @param {string} options.ledgerPath  the ledger file the lock serializes
 * @param {() => any} fn               the critical section; must be synchronous
 * @param {number} [options.timeoutMs]
 * @param {number} [options.minStaleAgeMs]
 * @param {number} [options.now]
 * @param {string} [options.host]      override for tests
 * @param {number} [options.pid]       override for tests
 * @returns {{ ok: true, value: any } | { ok: false, code: string, detail?: string }}
 */
export function withLedgerLock({
	ledgerPath,
	fn,
	timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
	minStaleAgeMs = DEFAULT_MIN_STALE_AGE_MS,
	now = () => Date.now(),
	host = thisHost(),
	pid = process.pid,
	lockDir = null,
}) {
	if (typeof ledgerPath !== "string" || ledgerPath.length === 0) {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "NO_LEDGER_PATH" };
	}
	if (typeof fn !== "function") {
		return { ok: false, code: LEDGER_LOCK.CORRUPT, detail: "NO_CRITICAL_SECTION" };
	}
	const lockPath = lockPathFor(ledgerPath, lockDir);
	const token = randomBytes(8).toString("hex");
	const deadline = now() + Math.max(0, timeoutMs);

	// Nested acquire inside this process: the outer holder is still inside its
	// synchronous critical section, so running directly IS the serialized order.
	if (heldByThisProcess.has(lockPath)) {
		return { ok: true, value: fn(), reentrant: true };
	}

	for (;;) {
		const record = { v: 1, pid, host, token, acquiredAt: now() };
		const created = tryCreate(lockPath, record);
		if (created.acquired) {
			heldByThisProcess.add(lockPath);
			try {
				return { ok: true, value: fn() };
			} finally {
				heldByThisProcess.delete(lockPath);
				releaseLedgerLock(lockPath, token);
			}
		}

		const current = readLockRecord(lockPath);
		if (!current.ok) {
			if (current.code === "ABSENT") continue; // released between create and read
			// A CORRUPT RECORD IS NOT A HOLDER.
			//
			// Measured by independent review: a record that does not parse made every
			// later acquire fail closed with `LEDGER_LOCK_CORRUPT` — a denial primitive
			// for anyone who can write the lock directory. The lock directory is the one
			// writable place in a governed launch, so that was reachable.
			//
			// The exclusivity argument does not depend on trusting the record: a record
			// that is not a valid record proves nothing about who holds the lock, and
			// the create that follows is still one atomic `link(2)`. Reclaiming it is
			// therefore the same operation as reclaiming a provably-dead holder, and it
			// is safe for the same reason — the winner is decided by the atomic create,
			// not by the record.
			//
			// A SYMLINK is different and is NOT reclaimed: a symlink is an attempt to
			// redirect the lock, not a malformed one.
			if (current.code === LEDGER_LOCK.CORRUPT || current.code === LEDGER_LOCK.UNREADABLE) {
				if (now() >= deadline) return { ok: false, code: current.code, detail: current.detail };
				try {
					unlinkSync(lockPath);
				} catch {
					// Somebody else reclaimed or released it first; retry the create.
				}
				sleepSync(RETRY_BACKOFF_MS);
				continue;
			}
			return { ok: false, code: current.code, detail: current.detail };
		}
		if (current.record.host !== host) {
			// Liveness of a process on another host cannot be proven from here, and a
			// lock that cannot be proven dead must never be reclaimed.
			return { ok: false, code: LEDGER_LOCK.FOREIGN_HOST, detail: current.record.host };
		}
		const running = alive(current.record.pid);
		if (running === null) {
			return { ok: false, code: LEDGER_LOCK.BUSY, detail: "OWNER_LIVENESS_UNPROVEN" };
		}
		if (running === true) {
			if (now() >= deadline) return { ok: false, code: LEDGER_LOCK.BUSY, detail: `PID_${current.record.pid}` };
			sleepSync(RETRY_BACKOFF_MS);
			continue;
		}
		const age = now() - current.record.acquiredAt;
		if (!Number.isFinite(age) || age < minStaleAgeMs) {
			if (now() >= deadline) return { ok: false, code: LEDGER_LOCK.BUSY, detail: "STALE_AGE_UNPROVEN" };
			sleepSync(RETRY_BACKOFF_MS);
			continue;
		}
		const result = reclaim(lockPath, current.bytes);
		if (result.reclaimed) continue; // retry the create, now uncontended
		if (result.vanished || result.changed) continue;
		return { ok: false, code: LEDGER_LOCK.RECLAIM_FAILED, detail: result.error ?? "UNKNOWN" };
	}
}

/**
 * Release a lock only when the on-disk record is still ours.
 *
 * A process that lost its lock (reclaimed as dead while paused, then resumed)
 * must not delete the new owner's record. The token comparison is what makes
 * "release" safe to call from a `finally`.
 *
 * @returns {{ released: boolean, code?: string }}
 */
export function releaseLedgerLock(lockPath, token) {
	let bytes;
	try {
		bytes = readFileSync(lockPath, "utf8");
	} catch {
		return { released: false, code: "ABSENT" };
	}
	let record;
	try {
		record = JSON.parse(bytes);
	} catch {
		return { released: false, code: LEDGER_LOCK.CORRUPT };
	}
	if (!record || record.token !== token) return { released: false, code: LEDGER_LOCK.RELEASE_NOT_OWNER };
	try {
		unlinkSync(lockPath);
	} catch (error) {
		return { released: false, code: String(error && error.message ? error.message : error) };
	}
	return { released: true };
}

/** True when a lock record exists. Diagnostics only; never a gate. */
export function lockPresent(ledgerPath) {
	try {
		return existsSync(lockPathFor(ledgerPath));
	} catch {
		return false;
	}
}
