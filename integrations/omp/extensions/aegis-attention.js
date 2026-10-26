// aegis-attention.js — OMP extension: the AegisFlow "needs your attention" digest.
//
// WHAT IT IS
// ----------
// A thin, READ-ONLY bridge to `scripts/aegisflow-status.mjs`:
//
//   * on `session_start` it runs `--check` and, ONLY when something has crossed an
//     alert threshold, shows the banner through `ctx.ui.notify`. A quiet system
//     prints nothing; an OMP switched off with `/aegis-off` prints nothing.
//   * on a fresh start, when an interrupted long task is waiting, it also puts a resume
//     brief (metadata and pointers only, labelled as data) into the input box, so the new
//     session can pick the task up. Nothing is sent: the operator reads it and presses Enter.
//   * `/aegis-on` and `/aegis-off` switch the AUTOMATIC reminder on/off. The switch
//     silences only this banner: evolution, durable execution and every governance
//     gate are untouched.
//   * `/aegis-status` shows the full digest (informational and acknowledged items too).
//
// WHAT IT IS NOT
// --------------
// It registers no agent tool, so the agent cannot read, flip or acknowledge anything
// here; only the operator's prompt-command channel can. It never promotes, resumes
// or retries anything, and it never throws into the host: every failure degrades to
// "no banner" (session start) or to an explanatory notice (a command).
// The commands take no arguments, so there is nothing to interpolate.
//
// The checkout is located like cbm-query.js does: `AEGISFLOW_REPO_ROOT` /
// `AUTOLOOP_REPO_ROOT`, then this file's own location, then a walk up from the cwd.
// A deployed copy lives under ~/.omp and a shell variable is easy to forget, so there is
// one more source: a one-line pointer file `<AEGISFLOW_HOME or ~/.autoloop>/repo-root`
// holding the checkout's absolute path (same trust as the env var: it is a file in the
// operator's own home). No operator-specific path is baked in. Commands use fixed argv
// (no shell).

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_ENVS = Object.freeze(["AEGISFLOW_REPO_ROOT", "AUTOLOOP_REPO_ROOT"]);
const STATUS_SCRIPT = join("scripts", "aegisflow-status.mjs");
const RUN_TIMEOUT_MS = 4000;
const RUN_MAX_BUFFER = 64 * 1024;
const NODE_CANDIDATES = Object.freeze(["node", "/usr/local/bin/node", "/opt/homebrew/bin/node"]);

function hasStatusScript(dir) {
	try {
		return existsSync(join(dir, STATUS_SCRIPT));
	} catch {
		return false;
	}
}

/** `<AEGISFLOW_HOME | AUTOLOOP_HOME | ~/.autoloop>/repo-root`, read as one absolute path. Never throws. */
function readPointerFile() {
	try {
		let home = null;
		for (const name of ["AEGISFLOW_HOME", "AUTOLOOP_HOME"]) {
			const v = process.env[name]?.trim();
			if (v && isAbsolute(v)) { home = v; break; }
		}
		const file = join(home ?? join(homedir(), ".autoloop"), "repo-root");
		const st = lstatSync(file);
		if (!st.isFile() || st.size > 4096) return null;
		const value = readFileSync(file, "utf8").split("\n")[0].trim();
		return value && isAbsolute(value) ? value : null;
	} catch {
		return null;
	}
}

/** Locate the AegisFlow checkout. Never throws; an unlocatable checkout is reported, not guessed. */
export function resolveRepoRoot(cwd = process.cwd()) {
	for (const name of REPO_ROOT_ENVS) {
		const value = process.env[name];
		if (value && hasStatusScript(value)) return { ok: true, root: resolve(value) };
	}
	const pointed = readPointerFile();
	if (pointed && hasStatusScript(pointed)) return { ok: true, root: resolve(pointed) };
	const fromExtension = resolve(EXTENSION_DIR, "..", "..", "..");
	if (hasStatusScript(fromExtension)) return { ok: true, root: fromExtension };
	let dir = resolve(cwd);
	for (;;) {
		if (hasStatusScript(dir)) return { ok: true, root: dir };
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return {
		ok: false,
		reason: `no AegisFlow checkout with ${STATUS_SCRIPT} was found (set AEGISFLOW_REPO_ROOT or write the path to ~/.autoloop/repo-root)`,
	};
}

/**
 * Run the status script with a fixed flag list. Returns `{ ok, output }`; never throws.
 * `exec` is injectable for tests.
 */
export function runStatus(flags, { cwd = process.cwd(), exec = execFileSync } = {}) {
	const repo = resolveRepoRoot(cwd);
	if (!repo.ok) return { ok: false, output: repo.reason };
	let lastError = "node was not found";
	for (const nodeBin of NODE_CANDIDATES) {
		try {
			const out = exec(nodeBin, [join(repo.root, STATUS_SCRIPT), ...flags], {
				encoding: "utf8",
				timeout: RUN_TIMEOUT_MS,
				maxBuffer: RUN_MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, output: String(out ?? "").trim() };
		} catch (e) {
			if (e?.code === "ENOENT") {
				lastError = `${nodeBin}: not found`;
				continue;
			}
			return { ok: false, output: `aegisflow-status failed: ${String(e?.message ?? e).slice(0, 160)}` };
		}
	}
	return { ok: false, output: lastError };
}

function notify(ctx, text, level) {
	try {
		ctx?.ui?.notify?.(text, level);
	} catch {
		// UI is absent in print/RPC mode; the command has already taken effect.
	}
}

export default function (pi, deps = {}) {
	const run = deps.runStatus ?? runStatus;
	// Automatic reminder: silent unless an alert threshold was crossed AND the switch is on.
	pi.on("session_start", (event, ctx) => {
		try {
			const cwd = ctx?.cwd ?? process.cwd();
			const r = run(["--check"], { cwd });
			if (!(r.ok && r.output)) return;
			notify(ctx, r.output, "warning");
			// Only a fresh start: resuming or reloading a session must not overwrite the input box.
			if (event?.reason !== "startup") return;
			const b = run(["--brief"], { cwd });
			if (b.ok && b.output) {
				try {
					ctx?.ui?.setEditorText?.(b.output);
				} catch {
					// no UI in print/RPC mode
				}
			}
		} catch {
			// a reminder must never break a session
		}
	});

	for (const [name, flag, description] of [
		["aegis-on", "--on", "Turn the AegisFlow automatic reminder ON."],
		["aegis-off", "--off", "Turn the AegisFlow automatic reminder OFF (manual /aegis-status still works)."],
	]) {
		pi.registerCommand(name, {
			description,
			handler: async (_args, ctx) => {
				const r = runStatus([flag], { cwd: ctx?.cwd ?? process.cwd() });
				notify(ctx, r.output || "(no output)", r.ok ? "info" : "warning");
			},
		});
	}

	pi.registerCommand("aegis-status", {
		description: "Show everything AegisFlow thinks needs your attention (full digest).",
		handler: async (_args, ctx) => {
			const r = runStatus(["--detail"], { cwd: ctx?.cwd ?? process.cwd() });
			notify(ctx, r.output || "AegisFlow: nothing to report.", r.ok ? "info" : "warning");
		},
	});
}
