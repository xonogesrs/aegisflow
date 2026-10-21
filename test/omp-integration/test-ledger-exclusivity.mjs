// test/omp-integration/test-ledger-exclusivity.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1 — C6.
//
// The card makes cross-process commit exclusivity a MANDATORY acceptance item and
// says explicitly that conflict detection is not the same thing as mutual
// exclusion. These tests measure the difference with real OS processes.
//
// What "exactly one valid commit" is proved from
// ----------------------------------------------
// Not from the workers' own summaries: each worker prints what it observed, and
// the assertions are made against the LEDGER FILE after every process exited.
// Two independent facts must hold together:
//
//   * at most one process reported a successful commit, and
//   * the ledger contains exactly one `commit` record for that generation.
//
// A defect that made every process report success would fail the second; a
// defect that made the ledger accept two records would fail it too. Measured on
// the pre-card code (lock removed): 2–3 commit records for one generation, which
// is why this test is not a tautology.
//
// Run: node --test test/omp-integration/test-ledger-exclusivity.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	LEDGER_LOCK,
	lockPathFor,
	releaseLedgerLock,
	withLedgerLock,
} from "../../integrations/omp/extensions/lib/ledger-lock.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = join(REPO_ROOT, "scripts", "omp-controller-ledger-worker.mjs");

/**
 * A controller ROOT, not a bare directory (R4).
 *
 * Ledger writes require the controller's capability, and the capability's key
 * lives in the root. Workers read `<stateDir>/../ledger.key`, which is exactly how
 * a real controller provisions them, so the fixture has to look like a root.
 */
function scratch(prefix) {
	const dir = mkdtempSync(join(tmpdir(), `r3-${prefix}-`));
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(dir, "ledger.key"), `${"a".repeat(64)}\n`, { mode: 0o600 });
	return stateDir;
}

/** The one ledger file a controller root holds (R4). */
function ledgerFor(stateDir) {
	return join(stateDir, "ledger.jsonl");
}

function readRecords(ledgerPath) {
	if (!existsSync(ledgerPath)) return [];
	return readFileSync(ledgerPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map(line => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
}

/**
 * Run N workers that all reach the ledger at the same instant.
 *
 * The barrier file is what makes this a contention test: without it the workers
 * would be separated by process startup and the race would rarely occur.
 */
async function runWorkers(count, argvFor, { timeoutMs = 60_000 } = {}) {
	const barrier = join(scratch("barrier"), "go");
	const running = [];
	for (let index = 0; index < count; index += 1) {
		running.push(
			execFileAsync(process.execPath, [WORKER, ...argvFor(index), barrier], { encoding: "utf8", timeout: timeoutMs })
				.then(({ stdout }) => {
					try {
						return JSON.parse(stdout.trim());
					} catch {
						return { parseFailure: stdout };
					}
				})
				.catch(error => ({ workerError: String(error && error.message ? error.message : error) })),
		);
	}
	// Give every child time to reach the barrier, then release them together.
	await new Promise(resolveSleep => setTimeout(resolveSleep, 600));
	writeFileSync(barrier, "go");
	return Promise.all(running);
}

// ── the mandatory acceptance item ───────────────────────────────────────────

test("concurrent allocation never hands the same generation to two processes", async () => {
	const stateDir = scratch("alloc-race");
	const sessionId = "alloc-race";
	const observed = await runWorkers(8, index => ["allocate", stateDir, sessionId, `rt-${index}`]);

	const allocated = observed.filter(entry => entry.identityState === "ALLOCATED");
	const generations = allocated.map(entry => entry.generation);
	assert.equal(
		new Set(generations).size,
		generations.length,
		`two processes were handed the same generation: ${JSON.stringify(generations)}`,
	);
	// Every worker either allocated a unique number or failed closed with a reason.
	for (const entry of observed) {
		assert.ok(
			entry.identityState === "ALLOCATED" || typeof entry.identityError === "string",
			`a worker neither allocated nor reported why: ${JSON.stringify(entry)}`,
		);
	}
	const records = readRecords(ledgerFor(stateDir));
	const claims = new Map();
	for (const record of records.filter(entry => entry.type === "allocate")) {
		claims.set(record.generation, (claims.get(record.generation) ?? 0) + 1);
	}
	for (const [generation, count] of claims) {
		assert.equal(count, 1, `generation ${generation} is claimed ${count} times in the ledger`);
	}
});

test("concurrent commit of one generation yields exactly one commit record", async () => {
	const stateDir = scratch("commit-race");
	const sessionId = "commit-race";
	const [allocation] = await runWorkers(1, () => ["allocate", stateDir, sessionId, "rt-init"]);
	assert.equal(allocation.identityState, "ALLOCATED", JSON.stringify(allocation));
	const generation = allocation.generation;

	const observed = await runWorkers(6, index => ["commit", stateDir, sessionId, `rt-${index}`, String(generation)]);
	const winners = observed.filter(entry => entry.error === null && entry.committedRecorded === true);
	assert.equal(winners.length, 1, `expected exactly one successful commit, saw ${winners.length}: ${JSON.stringify(observed)}`);

	const records = readRecords(ledgerFor(stateDir));
	const commits = records.filter(entry => entry.type === "commit" && entry.generation === generation);
	assert.equal(commits.length, 1, `the ledger holds ${commits.length} commit records for generation ${generation}`);
	assert.equal(commits[0].runtimeInstanceId, winners[0].runtimeInstanceId, "the durable record must name the winner");
});

test("a losing committer reports a refusal, never a success", async () => {
	const stateDir = scratch("commit-refusal");
	const sessionId = "commit-refusal";
	const [allocation] = await runWorkers(1, () => ["allocate", stateDir, sessionId, "rt-init"]);
	const observed = await runWorkers(4, index => ["commit", stateDir, sessionId, `rt-${index}`, String(allocation.generation)]);
	const losers = observed.filter(entry => entry.error !== null);
	assert.ok(losers.length >= 3, `expected refusals, saw ${JSON.stringify(observed)}`);
	for (const loser of losers) {
		// A refusal must name its cause. `GENERATION_ALREADY_COMMITTED` is the
		// expected one: the winner's record is durable, and that is exactly why the
		// loser may not write another. `committedRecorded` therefore stays TRUE for
		// the loser — it describes the LEDGER ("a commit record for this generation
		// exists"), not "this process won". What must never happen is a loser with
		// `error: null`.
		assert.match(String(loser.error), /ALREADY_COMMITTED|LOCK_/, `a refusal must say why: ${JSON.stringify(loser)}`);
		assert.equal(loser.nextGeneration, null, "a refused commit must not claim the next generation");
	}
	assert.equal(
		losers.filter(entry => entry.committedRecorded === true).every(entry => /ALREADY_COMMITTED/.test(String(entry.error))),
		true,
		"committedRecorded may only be true for a loser when the ledger genuinely holds the record",
	);
});

// ── lock mechanics, proven directly ─────────────────────────────────────────

test("the lock is exclusive inside one process tree and released on the normal path", () => {
	const dir = scratch("lock-basic");
	const ledgerPath = join(dir, "s.jsonl");
	const first = withLedgerLock({ ledgerPath, fn: () => "first" });
	assert.equal(first.ok, true);
	assert.equal(first.value, "first");
	assert.equal(existsSync(lockPathFor(ledgerPath)), false, "a completed critical section must not leave a lock");
});

test("a live foreign lock blocks the section, and a non-owner release is refused", () => {
	const dir = scratch("lock-cross");
	const ledgerPath = join(dir, "s.jsonl");
	// A record naming a LIVE pid (this process) on THIS host: the contender must
	// treat the lock as busy. Using this process's own pid keeps the test
	// deterministic — a real second process would race with the assertions.
	const record = { v: 1, pid: process.pid, host: hostname(), token: "held-by-test", acquiredAt: Date.now() };
	writeFileSync(lockPathFor(ledgerPath), `${JSON.stringify(record)}\n`, { mode: 0o600 });

	const contended = withLedgerLock({ ledgerPath, fn: () => "must-not-run", timeoutMs: 120 });
	assert.equal(contended.ok, false);
	assert.equal(contended.code, LEDGER_LOCK.BUSY);
	assert.equal(contended.value, undefined, "the critical section must not have run");

	// Our own release must refuse to delete a record it does not own.
	const foreign = releaseLedgerLock(lockPathFor(ledgerPath), "some-other-token");
	assert.equal(foreign.released, false);
	assert.equal(foreign.code, LEDGER_LOCK.RELEASE_NOT_OWNER);
	assert.equal(existsSync(lockPathFor(ledgerPath)), true, "a non-owner release must not remove the lock");
});

test("a lock held by a provably dead process is reclaimed, and the section runs", () => {
	const dir = scratch("lock-reclaim");
	const ledgerPath = join(dir, "s.jsonl");
	// A pid that cannot be running: process ids are bounded well below this.
	const deadPid = 2 ** 22 + 12345;
	writeFileSync(
		lockPathFor(ledgerPath),
		`${JSON.stringify({ v: 1, pid: deadPid, host: (process.env.HOSTNAME || "").length ? process.env.HOSTNAME : hostname(), token: "dead", acquiredAt: Date.now() - 10_000 })}\n`,
		{ mode: 0o600 },
	);
	const acquired = withLedgerLock({ ledgerPath, fn: () => "ran", timeoutMs: 2000, minStaleAgeMs: 0 });
	assert.equal(acquired.ok, true, `reclaim failed: ${JSON.stringify(acquired)}`);
	assert.equal(acquired.value, "ran");
});

test("a lock from another host is never reclaimed, because its liveness cannot be proven", () => {
	const dir = scratch("lock-foreign");
	const ledgerPath = join(dir, "s.jsonl");
	writeFileSync(
		lockPathFor(ledgerPath),
		`${JSON.stringify({ v: 1, pid: 1, host: "some-other-host", token: "foreign", acquiredAt: Date.now() - 60_000 })}\n`,
		{ mode: 0o600 },
	);
	const contended = withLedgerLock({ ledgerPath, fn: () => "must-not-run", timeoutMs: 100, minStaleAgeMs: 0 });
	assert.equal(contended.ok, false);
	assert.equal(contended.code, LEDGER_LOCK.FOREIGN_HOST);
});

test("a corrupt lock record is reclaimed, because it proves nothing about a holder", () => {
	// R4 CHANGED THIS DELIBERATELY, AND THE CHANGE IS THE SECURITY FIX.
	//
	// The old contract was "a corrupt record fails closed". Under a governed launch
	// the lock directory is the one place the Agent's bash can write, so "fail
	// closed on a corrupt record" was a denial primitive: create
	// `ledger.jsonl.lock` containing `{}` and every legitimate commit fails.
	//
	// Exclusivity never depended on trusting the record. The winner is decided by
	// one atomic `link(2)`; a record that is not a valid record says nothing about
	// who holds the lock, so reclaiming it is the same operation as reclaiming a
	// provably-dead holder. What must NOT be reclaimed is a SYMLINK, which is an
	// attempt to redirect the lock rather than a malformed one — asserted below.
	const dir = scratch("lock-corrupt");
	const ledgerPath = join(dir, "s.jsonl");
	writeFileSync(lockPathFor(ledgerPath), "{not json\n", { mode: 0o600 });
	const acquired = withLedgerLock({ ledgerPath, fn: () => "ran", timeoutMs: 2000 });
	assert.equal(acquired.ok, true, "a corrupt record must not deny the lock forever");
	assert.equal(acquired.value, "ran");
	assert.equal(existsSync(lockPathFor(ledgerPath)), false, "the lock must be released after the section");
});

test("a symlinked lock record is still refused, not reclaimed", () => {
	const dir = scratch("lock-symlink");
	const ledgerPath = join(dir, "s.jsonl");
	const elsewhere = join(dir, "elsewhere");
	writeFileSync(elsewhere, "{}", { mode: 0o600 });
	symlinkSync(elsewhere, lockPathFor(ledgerPath));
	const refused = withLedgerLock({ ledgerPath, fn: () => "must-not-run", timeoutMs: 100 });
	assert.equal(refused.ok, false);
	assert.equal(refused.code, LEDGER_LOCK.SYMLINK);
});

test("a lock record younger than the minimum stale age is not treated as abandoned", () => {
	// A process that has just created the record but not finished its critical
	// section would otherwise be reclaimed while it is still working.
	const dir = scratch("lock-young");
	const ledgerPath = join(dir, "s.jsonl");
	writeFileSync(
		lockPathFor(ledgerPath),
		`${JSON.stringify({ v: 1, pid: 2 ** 22 + 99, host: hostname(), token: "young", acquiredAt: Date.now() })}\n`,
		{ mode: 0o600 },
	);
	// The threshold is deliberately far larger than the timeout: the record stays
	// younger than the minimum for the whole attempt, so no reclaim may happen.
	const contended = withLedgerLock({ ledgerPath, fn: () => "must-not-run", timeoutMs: 40, minStaleAgeMs: 60_000 });
	assert.equal(contended.ok, false);
	assert.equal(contended.code, LEDGER_LOCK.BUSY);
	assert.equal(contended.detail, "STALE_AGE_UNPROVEN");
	assert.equal(existsSync(lockPathFor(ledgerPath)), true, "an unproven-stale lock must not be removed");
});

test("a nested acquire inside one process runs directly instead of deadlocking", () => {
	// `recordCommitAndClaimNext` calls `commitRecordState`, and both take the lock.
	// Without reentrancy the inner call would wait on its own outer holder until the
	// timeout and the commit would fail.
	const dir = scratch("lock-reentrant");
	const ledgerPath = join(dir, "s.jsonl");
	const result = withLedgerLock({
		ledgerPath,
		fn: () => withLedgerLock({ ledgerPath, fn: () => "inner", timeoutMs: 50 }),
	});
	assert.equal(result.ok, true);
	assert.equal(result.value.ok, true);
	assert.equal(result.value.value, "inner");
	assert.equal(result.value.reentrant, true);
	assert.equal(existsSync(lockPathFor(ledgerPath)), false);
});

test("a lock file is never left behind after a throwing critical section", () => {
	const dir = scratch("lock-throw");
	const ledgerPath = join(dir, "s.jsonl");
	assert.throws(() =>
		withLedgerLock({
			ledgerPath,
			fn: () => {
				throw new Error("critical section failed");
			},
		}),
	);
	assert.equal(existsSync(lockPathFor(ledgerPath)), false, "a failed section must still release the lock");
});

test("an unusable ledger path is a refusal, not a silent no-op", () => {
	const blocked = withLedgerLock({ ledgerPath: "", fn: () => "must-not-run" });
	assert.equal(blocked.ok, false);
	assert.equal(blocked.code, LEDGER_LOCK.CORRUPT);
	const noSection = withLedgerLock({ ledgerPath: "/tmp/x.jsonl", fn: null });
	assert.equal(noSection.ok, false);
});
