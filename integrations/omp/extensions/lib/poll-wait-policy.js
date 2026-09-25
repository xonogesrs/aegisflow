// poll-wait-policy.mjs — pure, testable classification of a bash command as a
// "poll waiter" (a command whose only purpose is to sleep and re-observe state)
// versus real work that merely happens to contain a legitimate sleep.
//
// Why this module exists (AEGISFLOW_OMP_WAITER_LIFECYCLE_AND_NOTIFICATION_REPAIR_1):
//
//   Agent issues: sleep 600; date; pgrep -f …; echo "(empty=done)"
//   → the command does no work, so it runs > the 60s auto-background threshold
//   → OMP converts the foreground call into a real background JOB
//   → each such job's completion is delivered as an async-result notification
//   → N discrete sleeps = N waiters = N late wakes, surviving task terminal.
//
// The pre-existing `no-poll-waits` guard only looked at `input.async === true`.
// Every one of the incident's waiters had `async` UNSET and was auto-backgrounded
// AFTER the `tool_call` hook ran, so the guard never saw them. Classification
// here is therefore based on COMMAND SEMANTICS, never on the `async` flag alone,
// and the caller can apply the same verdict to three surfaces:
//
//   1. explicit `async:true` polling            → refuse outright
//   2. `async` unset that WOULD auto-background → refuse (or clamp below the
//      auto-background threshold so it settles in the foreground and creates
//      no job). Refusing here is what closes the post-hook bypass: the hook
//      cannot see the conversion, so it must prevent the conversion from being
//      reachable at all.
//   3. sleep + for/while polling loops and sleep + date/status/echo wrappers
//      → same verdict, because the verdict comes from the parsed segments.
//
// Real work containing a legitimate sleep (`for i in …; do sleep 30; npm test;
// done`, `sleep 5 && git status`) stays allowed: at least one segment is real
// work, so the command is not poll-only and a single bounded wait is the
// designed pattern.

/** Default OMP `bash.autoBackground.thresholdMs`; the value the gate must beat. */
export const DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS = 60_000;

/**
 * Commands that only OBSERVE state (no side effect). `date` is here because the
 * incident's waiters emitted `date; pgrep …; echo "(empty=done)"` and its
 * absence was a reproduced bypass seam (AEGISFLOW_BACKGROUND_WAITER_FANOUT_ROOT_CAUSE_1
 * seam 3: `sleep 30; date; ps; echo` escaped the old filter).
 */
export const POLL_CHECK_CMDS = new Set([
	"pgrep",
	"pkill",
	"ps",
	"ls",
	"test",
	"[",
	"echo",
	"printf",
	"true",
	"false",
	"stat",
	"wc",
	"cat",
	"tail",
	"head",
	"find",
	"git",
	"date",
	"pidwait",
	"uptime",
	"jobs",
	"wait",
	"command",
	"type",
	"sleep",
]);

/** Pure output reshaper; observes nothing and produces no side effect of its own. */
export const POLL_PIPE_FILTER_CMDS = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"awk",
	"sort",
	"uniq",
	"cut",
	"tr",
	"xargs",
	"column",
	"fold",
	"fmt",
	"nl",
	"tac",
	"rev",
	"true",
	"false",
]);

/** Loop starters whose body sleeps are a bounded wait. */
const LOOP_STARTER_RE = /^\s*(for|while|until)\b/;

function firstWord(segment) {
	const raw = segment.trim().split(/\s+/)[0] ?? "";
	// `/bin/sleep 30` and `command sleep 30` must classify as `sleep`.
	const bare = raw.replace(/^.*\//, "");
	return bare === "command" ? (segment.trim().split(/\s+/)[1] ?? bare) : bare;
}

/** Parse a `sleep` argument (`600`, `1.5`, `90s`, `2m`, `1h`, `500ms`) to ms. */
export function parseSleepMs(segment) {
	const words = segment.trim().split(/\s+/);
	const arg = words[1];
	if (arg === undefined) return 0;
	const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(arg);
	if (!match) return null; // dynamic argument (e.g. `sleep $N`) — unknown
	const value = Number(match[1]);
	const unit = match[2] ?? "s";
	const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
	return value * factor;
}

function isBareSleep(segment) {
	if (firstWord(segment) !== "sleep") return false;
	const words = segment.trim().split(/\s+/);
	if (words.length === 1) return true; // bare `sleep` (no duration)
	if (words.length > 2) return false;
	const parsed = parseSleepMs(segment);
	return parsed !== null;
}

function isPureCheck(segment) {
	const cmd = firstWord(segment);
	if (!POLL_CHECK_CMDS.has(cmd) && !POLL_PIPE_FILTER_CMDS.has(cmd)) return false;
	if (cmd === "sleep") return isBareSleep(segment);
	// A check that redirects output to a real file is a side effect, not a pure
	// observation. Discarding to /dev/null stays benign.
	if (/>{1,2}\s*(?!\/dev\/null\b)\S+/.test(segment)) return false;
	if (/(^|\s)tee(\s|$)/.test(segment)) return false;
	return true;
}

/** Split on top-level shell control operators, matching how OMP segments commands. */
export function splitSegments(command) {
	return command
		.split(/(?:&&|\|\||[;|&\n])/)
		.map(s => s.trim())
		.filter(Boolean);
}

/** Extract `for/while/until … do … done` bodies, replacing each with a placeholder. */
function extractLoops(command) {
	const loops = [];
	let out = command;
	for (;;) {
		// A loop may start at the beginning of the command or after any control
		// operator — the incident's waiter was `sleep 600; date; for p in $(pgrep …);
		// do …; done; echo …`, so a line-anchored search is not enough.
		const match = /(?:^|[;&|]\s*|\n\s*)(for|while|until)\b/.exec(out);
		if (!match) break;
		const start = match.index + match[0].length - match[1].length;
		const doIdx = findDo(out, start);
		if (doIdx === -1) break;
		const doneIdx = findDone(out, doIdx + 2);
		if (doneIdx === -1) break;
		const header = out.slice(start, doIdx);
		const body = out.slice(doIdx + 2, doneIdx);
		const iterations = parseLoopIterations(header);
		loops.push({ body, iterations });
		out = `${out.slice(0, start)} __POLL_LOOP_${loops.length - 1}__ ${out.slice(doneIdx + 4)}`;
	}
	return { stripped: out, loops };
}

/** Index of the loop body's opening `do` keyword at nesting depth 0, or -1. */
function findDo(text, from) {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{") depth++;
		else if (ch === ")" || ch === "}") depth--;
		else if (depth === 0 && text.startsWith("do", i)) {
			const before = text[i - 1];
			const after = text[i + 2];
			if ((before === undefined || /\s|[;&|]/.test(before)) && (after === undefined || /[\s;&|]/.test(after))) return i;
		} else if (depth === 0 && /[;&]/.test(ch) && /\bfor\b/.test(text.slice(from, i)) === false) {
			// keep scanning
		}
	}
	return -1;
}

/** Index of the matching `done` keyword for a loop opened before `from`. */
function findDone(text, from) {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "{") depth++;
		else if (ch === ")" || ch === "}") depth--;
		else if (depth === 0 && text.startsWith("done", i) && !/[\w]/.test(text[i - 1] ?? " ") && /[\s;&|]/.test(text[i + 4] ?? " ")) {
			return i;
		}
	}
	return -1;
}

/** Static iteration count for `for i in 1 2 3` / `{1..5}`; null when dynamic. */
function parseLoopIterations(header) {
	const brace = /\{(\d+)\.\.(\d+)\}/.exec(header);
	if (brace) return Math.abs(Number(brace[2]) - Number(brace[1])) + 1;
	const list = /^\s*for\s+\w+\s+in\s+([^;]+)/.exec(header);
	if (list) {
		const items = list[1].trim().split(/\s+/).filter(Boolean);
		if (items.length > 0 && !items.some(t => /[$`*?[]/.test(t))) return items.length;
		return null;
	}
	return null;
}

/** True when every segment of a loop body merely observes state (or sleeps). */
function isPureObservation(command) {
	const segments = splitSegments(command);
	if (segments.length === 0) return false;
	return segments.every(seg => isBareSleep(seg) || isPureCheck(seg));
}

/**
 * Classify one command.
 *
 * @returns {{
 *   pollOnly: boolean,
 *   sleepMs: number,
 *   unknownSleep: boolean,
 *   hasLoop: boolean,
 *   reason: string,
 * }}
 */
export function classifyBashWait(command) {
	const text = typeof command === "string" ? command : "";
	const { stripped, loops } = extractLoops(text);
	const segments = splitSegments(stripped);

	let sleepMs = 0;
	let unknownSleep = false;
	let hasSleep = false;
	let hasLoop = loops.length > 0;
	let allPollLike = true;
	const realWork = [];

	for (const segment of segments) {
		const loopMatch = /^__POLL_LOOP_(\d+)__$/.exec(segment);
		if (loopMatch) {
			const loop = loops[Number(loopMatch[1])];
			const inner = classifyBashWait(loop.body);
			// A loop whose body only dumps status (`for p in $(pgrep …); do echo $p; done`)
			// is an observation, not work — the incident's waiter used exactly this shape
			// with its `sleep` outside the loop.
			const statusOnlyBody = isPureObservation(loop.body);
			hasLoop = true;
			if (inner.hasSleep || inner.pollOnly || statusOnlyBody) hasSleep = true;
			if (inner.sleepMs > 0) {
				if (loop.iterations === null) unknownSleep = true;
				else sleepMs += inner.sleepMs * loop.iterations;
			}
			if (inner.unknownSleep) unknownSleep = true;
			if (!inner.pollOnly && !statusOnlyBody) {
				allPollLike = false;
				realWork.push(`loop body: ${inner.reason}`);
			}
			continue;
		}
		if (isBareSleep(segment)) {
			hasSleep = true;
			const parsed = parseSleepMs(segment);
			if (parsed === null) unknownSleep = true;
			else sleepMs += parsed;
			continue;
		}
		if (isPureCheck(segment)) {
			// A pure status check is not itself a wait, but it is poll-like.
			continue;
		}
		allPollLike = false;
		realWork.push(segment);
	}

	// A loop body that is itself poll-like counts as a sleep even when its sleep
	// is nested; recompute hasSleep from the recursive verdict above.
	if (hasLoop && !hasSleep) {
		for (const loop of loops) {
			if (classifyBashWait(loop.body).pollOnly) hasSleep = true;
		}
	}

	const pollOnly = segments.length > 0 && allPollLike && hasSleep;
	return {
		pollOnly,
		sleepMs,
		unknownSleep,
		hasLoop,
		hasSleep,
		reason: pollOnly
			? `poll-only wait (sleep ${sleepMs}ms${unknownSleep ? ", dynamic duration" : ""}${hasLoop ? ", loop" : ""})`
			: realWork.length > 0
				? `real work present: ${realWork[0].slice(0, 80)}`
				: "no sleep",
	};
}

/**
 * Apply the wait policy.
 *
 * The harm being repaired is a command that becomes a background WAITER: a job
 * whose completion is delivered later and can outlive the task's terminal state.
 * A poll job never needs to exist (the harness delivers async results on its
 * own), so:
 *
 *   - `async:true` poll-only            → REFUSE. A poll job is never needed.
 *   - `async` unset, would outlive the  → REFUSE. This is exactly the post-hook
 *     auto-background threshold           auto-background bypass: the hook runs
 *                                           BEFORE the conversion, so the only
 *                                           way to stop the waiter is to stop
 *                                           the command that would become one.
 *   - `async` unset, bounded foreground → ADMIT, with a timeout clamped below
 *                                         the threshold so it cannot drift into
 *                                         a job mid-flight. One short bounded
 *                                         wait creates zero jobs and zero
 *                                         notifications; the prohibited pattern
 *                                         is the *chain* of them.
 *
 * Real work that merely contains a legitimate sleep is never poll-only and is
 * always admitted with its timeout untouched.
 *
 * @param {string} command
 * @param {{ async?: boolean, timeoutMs?: number, thresholdMs?: number }} [options]
 * @returns {{ action: "allow" | "block", pollOnly: boolean, sleepMs: number,
 *             timeoutMs?: number, reason: string }}
 */
export function decideBashWait(command, options = {}) {
	const thresholdMs =
		Number.isFinite(options.thresholdMs) && options.thresholdMs > 0
			? options.thresholdMs
			: DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS;
	const verdict = classifyBashWait(command);
	if (!verdict.pollOnly) {
		return { action: "allow", ...verdict };
	}
	if (options.async === true) {
		return { action: "block", ...verdict, reason: `${verdict.reason}; explicit async background poll` };
	}
	if (verdict.unknownSleep || verdict.sleepMs >= thresholdMs) {
		return {
			action: "block",
			...verdict,
			reason: `${verdict.reason}; would auto-background past ${thresholdMs}ms`,
		};
	}
	const requested = options.timeoutMs;
	const capped = requested === undefined ? thresholdMs : Math.min(requested, thresholdMs);
	return { action: "allow", ...verdict, timeoutMs: capped };
}

/** Guidance appended to a block reason; mirrors the native wait tool's contract. */
export const WAIT_STRATEGY_GUIDE =
	"Correct pattern: (1) if the work is not yet launched, launch it ONCE with async:true and stop " +
	"polling — the completion is delivered to you automatically; (2) to wait on already-running work, " +
	"call the `wait` tool once (single coordinated wait) or read `proc://` / `agent://` for status; " +
	"(3) never chain sleep → check → sleep — each repeat becomes another background waiter whose " +
	"late completion re-wakes the run after the task has already gone terminal.";
