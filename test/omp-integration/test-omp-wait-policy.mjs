// test/omp-integration/test-omp-wait-policy.mjs
//
// Repo-side contract test for the wait policy that ships in
// `integrations/omp/extensions/lib/poll-wait-policy.js`.
//
// The published module carries its own self-test
// (`integrations/omp/extensions/test/poll-wait-policy.test.mjs`) which the
// installer test executes against a deployed copy. This file owns the
// repository-level contract: the classification seam, the threshold clamp, and
// the guarantee that ordinary work is never touched.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS,
	WAIT_STRATEGY_GUIDE,
	classifyBashWait,
	decideBashWait,
} from "../../integrations/omp/extensions/lib/poll-wait-policy.js";

const THRESHOLD = DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS;

test("classification is semantic, not driven by the async flag", () => {
	const waiter = 'sleep 600; date; for p in $(pgrep -f "run-suite.mjs"); do echo $p; done; echo "(empty=done)"';
	const verdict = classifyBashWait(waiter);
	assert.equal(verdict.pollOnly, true, "the incident's waiter shape must classify as poll-only");
	assert.equal(verdict.hasSleep, true);
	assert.equal(verdict.hasLoop, true);
	assert.ok(verdict.sleepMs >= THRESHOLD, `reported sleep ${verdict.sleepMs} should reach the threshold`);
	assert.match(verdict.reason, /poll-only wait/);
});

test("a poll-only command is refused whether or not async was requested", () => {
	const command = "sleep 600; pgrep -f runner; echo done";
	assert.equal(decideBashWait(command, { async: true }).action, "block");
	assert.equal(decideBashWait(command, { async: false }).action, "block");
	assert.equal(decideBashWait(command, {}).action, "block");
});

test("the auto-background bypass is closed: async-unset polling past the threshold is refused", () => {
	// This is the seam the original guard missed — the hook runs before OMP
	// converts the call into a background job, so refusing here is the only way
	// to stop the waiter from existing at all.
	const verdict = decideBashWait("sleep 600; date; ps -eo pid= | head -2; echo AUTOCHECK_DONE", { async: false });
	assert.equal(verdict.action, "block");
	assert.match(verdict.reason, /would auto-background/);
});

test("a bounded foreground poll is admitted with its timeout clamped under the threshold", () => {
	const verdict = decideBashWait("sleep 5; pgrep x", { async: false, timeoutMs: 300_000 });
	assert.equal(verdict.action, "allow");
	assert.equal(verdict.timeoutMs, THRESHOLD, "an admitted poll must not be able to drift into a background job");
});

test("real work keeps its own timeout and is never clamped", () => {
	const verdict = decideBashWait("npm test", { timeoutMs: 300_000 });
	assert.equal(verdict.action, "allow");
	assert.equal(verdict.timeoutMs, undefined, "a non-poll command's timeout is the caller's decision");
	assert.equal(verdict.pollOnly, false);
});

test("a legitimate sleep inside real work is not a waiter", () => {
	for (const command of ["for i in 1 2 3; do sleep 30; npm test; done", "sleep 600; ./run-suite.mjs --all"]) {
		const verdict = decideBashWait(command, { async: false, timeoutMs: 300_000 });
		assert.equal(verdict.action, "allow", `legitimate work was refused: ${command}`);
		assert.equal(verdict.pollOnly, false, `legitimate work misclassified: ${command}`);
	}
});

test("an observation-only chain is poll-like, and is admitted only because it is short", () => {
	// `git status` observes state, so `sleep 5 && git status` IS a poll — the
	// policy admits it because it settles in the foreground under the threshold,
	// and clamps the timeout so it cannot drift into a background job.
	const verdict = decideBashWait("sleep 5 && git status", { async: false, timeoutMs: 300_000 });
	assert.equal(verdict.pollOnly, true);
	assert.equal(verdict.action, "allow");
	assert.equal(verdict.timeoutMs, THRESHOLD);
});

test("the guidance text names the supported waiting pattern", () => {
	assert.match(WAIT_STRATEGY_GUIDE, /launch it ONCE with async:true/);
	assert.match(WAIT_STRATEGY_GUIDE, /never chain sleep/);
});

test("a caller-supplied threshold is honoured", () => {
	const verdict = decideBashWait("sleep 30; date", { async: false, thresholdMs: 10_000 });
	assert.equal(verdict.action, "block");
	assert.equal(decideBashWait("sleep 3; date", { async: false, thresholdMs: 10_000 }).action, "allow");
});
