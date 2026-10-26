// test/omp-integration/test-omp-aegis-attention.mjs
//
// Contract test for the `aegis-attention` OMP extension: the session-start
// reminder is silent unless the digest speaks, /aegis-on and /aegis-off take no arguments
// (no shell, no interpolation), and no failure ever
// reaches the host.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import openAttention, { resolveRepoRoot, runStatus } from "../../integrations/omp/extensions/aegis-attention.js";

function fakePi() {
	const handlers = {};
	const commands = {};
	const tools = [];
	return {
		handlers, commands, tools,
		on: (name, fn) => { handlers[name] = fn; },
		registerCommand: (name, def) => { commands[name] = def; },
		registerTool: (def) => { tools.push(def); },
	};
}
function fakeCtx() {
	const notes = [];
	return { notes, cwd: process.cwd(), ui: { notify: (text, level) => notes.push({ text, level }) } };
}

test("the checkout is located from the extension's own place in the repo", () => {
	assert.equal(resolveRepoRoot("/").ok, true);
});

test("registers three commands and NO agent tool", () => {
	const pi = fakePi();
	openAttention(pi);
	assert.deepEqual(Object.keys(pi.commands).sort(), ["aegis-off", "aegis-on", "aegis-status"]);
	assert.equal(pi.tools.length, 0, "the agent must not be able to read or flip the reminder");
	assert.equal(typeof pi.handlers.session_start, "function");
});

test("runStatus passes only fixed flags, as argv (no shell), and never throws", () => {
	const calls = [];
	const ok = runStatus(["--check"], { exec: (bin, args, opts) => { calls.push({ bin, args, opts }); return "BANNER\n"; } });
	assert.deepEqual(ok, { ok: true, output: "BANNER" });
	assert.equal(calls[0].args.at(-1), "--check");
	assert.equal(calls[0].opts.shell, undefined, "no shell");
	assert.ok(calls[0].opts.timeout > 0 && calls[0].opts.maxBuffer > 0, "bounded run");

	const enoent = runStatus(["--check"], { exec: () => { const e = new Error("x"); e.code = "ENOENT"; throw e; } });
	assert.equal(enoent.ok, false);
	const crash = runStatus(["--check"], { exec: () => { throw new Error("boom"); } });
	assert.equal(crash.ok, false);
});

test("/aegis-on and /aegis-off run only their fixed flag, whatever the host passes as arguments", async () => {
	const pi = fakePi();
	openAttention(pi);
	// The commands ignore their argument entirely: nothing hostile can reach argv. The real script
	// runs against a throwaway AEGISFLOW_HOME so the developer's own switch is never touched.
	const home = mkdtempSync(join(tmpdir(), "aegis-attn-cmd-"));
	const prev = process.env.AEGISFLOW_HOME;
	process.env.AEGISFLOW_HOME = home;
	try {
		const off = fakeCtx();
		await pi.commands["aegis-off"].handler("on; touch /tmp/should-not-exist", off);
		assert.match(off.notes[0].text, /已關閉/);
		const on = fakeCtx();
		await pi.commands["aegis-on"].handler("", on);
		assert.match(on.notes[0].text, /已開啟/);
		assert.equal(existsSync("/tmp/should-not-exist"), false);
	} finally {
		if (prev === undefined) delete process.env.AEGISFLOW_HOME; else process.env.AEGISFLOW_HOME = prev;
		rmSync(home, { recursive: true, force: true });
	}
});

test("session_start is silent when the digest is quiet or the host has no UI", () => {
	const pi = fakePi();
	openAttention(pi);
	const ctx = fakeCtx();
	// default AEGISFLOW_HOME on a dev machine may or may not alert; the contract is only that
	// the hook neither throws nor notifies with an empty banner.
	assert.doesNotThrow(() => pi.handlers.session_start({}, ctx));
	for (const n of ctx.notes) assert.ok(n.text.length > 0);
	assert.doesNotThrow(() => pi.handlers.session_start({}, {}));
	assert.doesNotThrow(() => pi.handlers.session_start({}, { ui: { notify() { throw new Error("no ui"); } } }));
});

test("the repo-root pointer file locates the checkout when env and cwd cannot", () => {
	const home = mkdtempSync(join(tmpdir(), "aegis-attn-ptr-"));
	const saved = { r: process.env.AEGISFLOW_REPO_ROOT, a: process.env.AUTOLOOP_REPO_ROOT, h: process.env.AEGISFLOW_HOME };
	try {
		const repo = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
		delete process.env.AEGISFLOW_REPO_ROOT;
		delete process.env.AUTOLOOP_REPO_ROOT;
		process.env.AEGISFLOW_HOME = home;
		writeFileSync(join(home, "repo-root"), `${repo}\n`);
		assert.deepEqual(resolveRepoRoot("/"), { ok: true, root: repo });
		// a relative or bogus pointer is ignored, never guessed
		writeFileSync(join(home, "repo-root"), "relative/path\n");
		assert.equal(resolveRepoRoot("/").ok, true, "falls through to the extension-relative source in-repo");
	} finally {
		for (const [k, v] of [["AEGISFLOW_REPO_ROOT", saved.r], ["AUTOLOOP_REPO_ROOT", saved.a], ["AEGISFLOW_HOME", saved.h]]) {
			if (v === undefined) delete process.env[k]; else process.env[k] = v;
		}
		rmSync(home, { recursive: true, force: true });
	}
});
