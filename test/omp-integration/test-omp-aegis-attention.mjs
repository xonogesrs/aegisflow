// test/omp-integration/test-omp-aegis-attention.mjs
//
// Contract test for the `aegis-attention` OMP extension: the session-start
// reminder is silent unless the digest speaks, the /aegis-alert argument is mapped
// through a closed table (no shell, no interpolation), and no failure ever
// reaches the host.

import assert from "node:assert/strict";
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

test("registers two commands and NO agent tool", () => {
	const pi = fakePi();
	openAttention(pi);
	assert.deepEqual(Object.keys(pi.commands).sort(), ["aegis-alert", "aegis-status"]);
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

test("/aegis-alert maps its argument through a closed table; junk is refused without running anything", async () => {
	const pi = fakePi();
	openAttention(pi);
	const ctx = fakeCtx();
	// A hostile argument must produce a usage notice and spawn nothing: the real script is
	// never reached, so no switch file can have been written.
	await pi.commands["aegis-alert"].handler("on; touch /tmp/should-not-exist", ctx);
	assert.equal(ctx.notes.length, 1);
	assert.match(ctx.notes[0].text, /Usage: \/aegis-alert/);
	assert.equal(ctx.notes[0].level, "warning");
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
