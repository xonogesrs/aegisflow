#!/usr/bin/env node
// Admission rehearsal — AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1.
//
// AUDIT EVIDENCE, NOT PRODUCTION CODE. Nothing here is imported by the extension,
// the installer or any runtime path; the installer's deployment surface is the
// fixed KNOWN_FILES list and does not include this directory.
//
//   node rehearsal.mjs --omp <abs omp> --extension <abs no-poll-waits.js>
//                      --client <abs controller-client.mjs> [--pilot-root <dir>]
//
// It runs entirely inside a throwaway scratch directory, with a PRIVATE HOME and
// an IN-PROCESS fake provider bound to 127.0.0.1. No credential is read, no
// network egress happens, and no production session, ledger, extension or
// authority marker is touched. The one thing it cannot fake is the uid boundary:
// the governed child and its `bash` tool run as the invoking user, which is the
// deployment's real topology and the subject of the C1 finding.
//
// Exit: 0 every fact held, 1 a fact failed, 2 the harness could not run.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync, copyFileSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ── argv ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
	const index = argv.indexOf(name);
	return index === -1 ? fallback : argv[index + 1];
};
const OMP = opt("--omp");
const EXTENSION = opt("--extension");
const CLIENT = opt("--client");
const PILOT_ROOT = opt("--pilot-root", null);
if (!OMP || !EXTENSION || !CLIENT) {
	console.error("usage: rehearsal.mjs --omp <abs> --extension <abs> --client <abs> [--pilot-root <dir>]");
	process.exit(2);
}

const client = await import(pathToFileURL(CLIENT).href);
const { prepareControllerRoot, launchGovernedRuntime, createControllerGrant, attestExtension, bindIdentity, commitFence, probeLedgerForCommit, COMMIT_STATE } = client;
const { ResultCorrelator } = await import(new URL("./lib/controller-result.mjs", pathToFileURL(EXTENSION)).href);

const ROOT = opt("--scratch", join(tmpdir(), `admission-rehearsal-${process.pid}`));
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const EXTENSION_SHA = createHash("sha256").update(readFileSync(EXTENSION)).digest("hex");
const EXTENSION_TREE = attestExtension(EXTENSION, EXTENSION_SHA).digests;
const GRANT = createControllerGrant({ controllerId: "admission-rehearsal", basis: "admission rehearsal" });

const facts = [];
function fact(name, ok, detail) {
	facts.push({ name, ok: Boolean(ok), detail: detail ?? null });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 220)}`}`);
}
function scratch(name) {
	const dir = join(ROOT, "cases", name);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ── in-process fake provider (127.0.0.1, ephemeral port) ────────────────────
const TOKEN_TEXT = "REHEARSAL_PROMPT_OK";
const TOKEN_TOOL = "REHEARSAL_TOOL_OK";
const TOKEN_ASYNC = "ASYNC_DONE";
let mode = "text";
let command = `echo ${TOKEN_TOOL}`;
const requests = [];
const provider = createServer((req, res) => {
	let body = "";
	req.on("data", chunk => { body += chunk; });
	req.on("end", () => {
		if (!/\/responses$/.test(req.url)) { res.writeHead(404); res.end("not found"); return; }
		requests.push(body);
		const isFollowUp = body.includes("function_call_output") || body.includes('"role":"tool"');
		const wantsTool = (mode === "tool" || mode === "async") && !isFollowUp;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		send({ type: "response.created", response: { id: "resp_rehearsal", status: "in_progress" } });
		if (wantsTool) {
			const args = mode === "async"
				? { command: `node -e "setTimeout(()=>console.log('${TOKEN_ASYNC}'),1500)"`, i: "Rehearsal async", async: true }
				: { command, i: "Rehearsal tool call" };
			const item = { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: JSON.stringify(args) };
			send({ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } });
			send({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: JSON.stringify(args) });
			send({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: JSON.stringify(args) });
			send({ type: "response.output_item.done", output_index: 0, item });
		} else {
			send({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [] } });
			send({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: TOKEN_TEXT });
			send({ type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: TOKEN_TEXT });
			send({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: TOKEN_TEXT }] } });
		}
		send({ type: "response.completed", response: { id: "resp_rehearsal", status: "completed", output: [] } });
		res.end();
	});
});
await new Promise(done => provider.listen(0, "127.0.0.1", done));
const PORT = provider.address().port;

// ── helpers ────────────────────────────────────────────────────────────────
/**
 * A private HOME that mirrors the deployment: model config AND the extension
 * tree in the discovery directory.
 *
 * THE FIRST VERSION OF THIS HARNESS OMITTED THE EXTENSION, which made every
 * regression fact vacuous — it measured a runtime with no extension installed and
 * reported "the extension does not break the prompt path". Independent review
 * caught it. `installExtension` is now part of `prepareHome`, so every CLI fact
 * exercises the real load path.
 */
function installExtension(home) {
	const target = join(home, ".omp", "agent", "extensions");
	mkdirSync(target, { recursive: true });
	execFileSync("cp", ["-R", `${dirname(EXTENSION)}/.`, target]);
	return target;
}
function prepareHome(home) {
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	installExtension(home);
	writeFileSync(join(home, ".omp", "agent", "models.yml"), [
		"providers:", "  rehearsal:", `    baseUrl: http://127.0.0.1:${PORT}/v1`,
		"    api: openai-responses", "    apiKey: rehearsal-not-a-credential", "    models:",
		"    - id: rehearsal/fake", "      name: Rehearsal Fake", "      contextWindow: 100000",
		"      maxTokens: 4096", "      input:", "      - text", "",
	].join("\n"));
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "modelRoles:\n  default: rehearsal/fake\nsymbolPreset: ascii\n");
}
function sessionFixture(dir) {
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const sessionId = "rehearsal-session-fixture";
	const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
	writeFileSync(sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: dir })}\n` +
		`${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "fixture", timestamp: Date.now() } })}\n`);
	return { sessionDir, sessionFile, sessionId, args: ["--session-dir", sessionDir, "--resume", sessionFile, "--no-skills", "--no-rules"] };
}
function ledgerRecords(stateDir, sessionId) {
	const path = join(stateDir, `${sessionId}.jsonl`);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
function textOf(frames) {
	return frames.filter(f => f.frame.type === "message_end" && f.frame.message?.role === "assistant")
		.map(f => (f.frame.message.content || []).filter(c => c.type === "text").map(c => c.text).join("")).join("\n");
}
async function governed(name, { args = ["--no-session", "--no-skills", "--no-rules"], root = null } = {}, body) {
	const dir = scratch(name);
	const controllerRoot = root ?? prepareControllerRoot({ root: join(dir, "controller") });
	if (!root) prepareHome(controllerRoot.childHome);
	const runtime = await launchGovernedRuntime({
		rpcBin: OMP, controllerRoot, grant: GRANT,
		extensionPath: EXTENSION, extensionSha256: EXTENSION_SHA, extensionTree: EXTENSION_TREE,
		args, cwd: dir,
	});
	if (!runtime.ok) throw new Error(`${name}: launch refused ${runtime.denial}`);
	try { return await body({ runtime, controllerRoot, dir }); }
	finally { await runtime.stop(); }
}
/**
 * Run the real binary the way production does: private HOME, discovery on.
 *
 * ASYNC on purpose. The fake provider lives in THIS process, so a synchronous
 * execFileSync would block the event loop and the child would wait forever for a
 * model response it can never receive — measured as a 60 s "Deadline exceeded".
 */
function runCli(home, dir, cliArgs, env = {}, timeoutMs = 180_000) {
	return new Promise(done => {
		const child = spawn(OMP, cliArgs, {
			cwd: dir, stdio: ["ignore", "pipe", "pipe"],
			env: { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", TERM: "dumb", ...env },
		});
		let stdout = ""; let stderr = "";
		child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { stdout += chunk; });
		child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { stderr += chunk; });
		const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
		child.on("exit", code => { clearTimeout(timer); done({ code, stdout, stderr }); });
	});
}
async function rpcSession(home, dir, cliArgs, env = {}) {
	const child = spawn(OMP, ["--mode", "rpc", ...cliArgs], {
		cwd: dir, stdio: ["pipe", "pipe", "pipe"],
		env: { PATH: process.env.PATH, HOME: home, LANG: "en_US.UTF-8", TERM: "dumb", ...env },
	});
	const frames = [];
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			try { frames.push(JSON.parse(line)); } catch { /* not a frame */ }
		}
	});
	const deadline = Date.now() + 25_000;
	while (!frames.some(f => f.type === "ready") && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
	const send = (id, message) => child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
	const awaitFrame = async (predicate, ms = 25_000) => {
		const until = Date.now() + ms;
		while (Date.now() < until) { const hit = frames.find(predicate); if (hit) return hit; await new Promise(r => setTimeout(r, 25)); }
		return undefined;
	};
	const close = async () => { child.kill("SIGTERM"); await new Promise(r => child.once("exit", r)); };
	return { frames, send, awaitFrame, close };
}

// ═══ Phase E checklist ═════════════════════════════════════════════════════

// 0. The extension is actually loaded in the regression HOME. Without this, every
//    fact below would pass on a runtime that never loaded it.
{
	mode = "text";
	const dir = scratch("extension-loaded");
	const home = join(dir, "home"); prepareHome(home);
	const rpc = await rpcSession(home, dir, ["--no-session", "--no-skills", "--no-rules"]);
	const commands = rpc.frames.find(f => f.type === "available_commands_update");
	const names = (commands?.commands ?? []).map(entry => entry.name);
	fact("EXTENSION_LOADED", ["fence-identity", "fence-generation", "release-final"].every(name => names.includes(name)), {
		found: ["fence-identity", "fence-generation", "release-final"].filter(name => names.includes(name)),
	});
	await rpc.close();
}

// 1. NORMAL_PROMPT
{
	mode = "text";
	const dir = scratch("normal-prompt");
	const home = join(dir, "home"); prepareHome(home);
	const out = await runCli(home, dir, ["--mode", "text", "-p", "say the token", "--no-skills", "--no-rules", "--no-title", "--no-pty", "--auto-approve", "--max-time", "60s", "--cwd", dir]);
	const loadFailure = /Failed to load extension/i.test(out.stderr);
	fact("NORMAL_PROMPT", out.stdout.includes(TOKEN_TEXT) && !loadFailure, { answered: out.stdout.trim().slice(-40), loadFailure });
}

// 2. TOOL_CALLING
{
	mode = "tool";
	const dir = scratch("tool-calling");
	const home = join(dir, "home"); prepareHome(home);
	const session = sessionFixture(dir);
	const rpc = await rpcSession(home, dir, ["--session-dir", session.sessionDir, "--resume", session.sessionFile, "--no-skills", "--no-rules", "--auto-approve"]);
	rpc.send("t1", "run the tool");
	const end = await rpc.awaitFrame(f => f.type === "tool_execution_end" && f.toolName === "bash");
	fact("TOOL_CALLING", end?.isError === false && (end?.result?.content?.[0]?.text ?? "").includes(TOKEN_TOOL), end?.result?.content?.[0]?.text?.trim() ?? "no tool result");
	await rpc.close();
}

// 3. SLASH_COMMAND
{
	mode = "text";
	const dir = scratch("slash-command");
	const home = join(dir, "home"); prepareHome(home);
	const rpc = await rpcSession(home, dir, ["--no-session", "--no-skills", "--no-rules"]);
	rpc.send("s1", "/help");
	const result = await rpc.awaitFrame(f => f.type === "prompt_result" && f.id === "s1");
	fact("SLASH_COMMAND", result?.status === "completed", result?.status ?? "no prompt_result");
	// A host command the EXTENSION registered must also work through the same path.
	rpc.send("s2", "/fence-identity request=s2");
	const identityCommand = await rpc.awaitFrame(f => f.type === "prompt_result" && f.id === "s2");
	fact("SLASH_COMMAND:extension-command", identityCommand?.status === "completed", identityCommand?.status ?? "no prompt_result");
	await rpc.close();
}

// 4. SESSION_RESUME
//
// DEFECT FIXED (independent review): the first version resumed a SEEDED fixture
// file rather than the session the first turn actually produced, so it proved
// "a hand-written session file can be resumed" and not "a real session resumes".
// It now runs turn 1 with a fresh session directory, takes the file the runtime
// wrote, and resumes THAT file — asserting the history is still there.
{
	mode = "text";
	const dir = scratch("session-resume");
	const home = join(dir, "home"); prepareHome(home);
	const sessionDir = join(dir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const base = ["--no-skills", "--no-rules", "--no-title", "--no-pty", "--auto-approve", "--max-time", "60s", "--session-dir", sessionDir, "--cwd", dir];
	const first = await runCli(home, dir, ["--mode", "text", "-p", "first turn token", ...base]);
	const produced = readdirSync(sessionDir).filter(name => name.endsWith(".jsonl"));
	fact("SESSION_RESUME:file-written", produced.length === 1, produced);
	if (produced.length !== 1) {
		fact("SESSION_RESUME", false, "no single session file to resume");
	} else {
		const sessionFile = join(sessionDir, produced[0]);
		const before = readFileSync(sessionFile, "utf8");
		const second = await runCli(home, dir, ["--mode", "text", "-p", "second turn token", "--resume", sessionFile, ...base]);
		const after = readFileSync(sessionFile, "utf8");
		fact("SESSION_RESUME", first.stdout.includes(TOKEN_TEXT) && second.stdout.includes(TOKEN_TEXT) && after.length > before.length, {
			firstAnswered: first.stdout.includes(TOKEN_TEXT),
			resumedAnswered: second.stdout.includes(TOKEN_TEXT),
			historyGrew: after.length > before.length,
			// The resumed turn's own message must be IN the same file, which is what
			// "resumed the same session" means; a fresh session would write elsewhere.
			secondTurnInSameFile: after.includes("second turn token"),
		});
	}
}

// 5. ASYNC_JOB_DELIVERY  (and 6. AGENT_END, observed on the same run)
{
	mode = "async";
	const dir = scratch("async-delivery");
	const home = join(dir, "home"); prepareHome(home);
	const rpc = await rpcSession(home, dir, ["--no-session", "--no-skills", "--no-rules", "--auto-approve"]);
	rpc.send("a1", "start a background job");
	const backgrounded = await rpc.awaitFrame(f => f.type === "tool_execution_end" && JSON.stringify(f).includes("Backgrounded as job"));
	const delivered = await rpc.awaitFrame(f => f.type === "agent_end" && JSON.stringify(f).includes(TOKEN_ASYNC), 30_000);
	fact("ASYNC_JOB_DELIVERY", Boolean(backgrounded) && Boolean(delivered), { backgrounded: Boolean(backgrounded), delivered: Boolean(delivered) });
	const end = rpc.frames.filter(f => f.type === "agent_end");
	fact("AGENT_END", end.length === 1, { agentEndFrames: end.length });
	await rpc.close();
}

// 7. AUTOLOOP_DISPATCH (isolated pilot root; never the live pilot state)
{
	if (!PILOT_ROOT || !existsSync(join(PILOT_ROOT, "bin", "al-omp"))) {
		fact("AUTOLOOP_DISPATCH", false, "UNKNOWN: pilot root not supplied");
	} else {
		const pilotCopy = scratch("autoloop");
		execFileSync("cp", ["-R", join(PILOT_ROOT, "bin"), join(PILOT_ROOT, "lib"), pilotCopy]);
		mkdirSync(join(pilotCopy, "evidence"), { recursive: true });
		const env = { ...process.env, ALOMP_PILOT_ROOT: pilotCopy };
		const status = execFileSync(process.execPath, [join(pilotCopy, "bin", "al-omp"), "status"], { env, encoding: "utf8" });
		const selftest = execFileSync(process.execPath, [join(pilotCopy, "bin", "al-omp"), "selftest"], { env, encoding: "utf8", timeout: 180_000 });
		let parsed = null; try { parsed = JSON.parse(selftest.slice(selftest.indexOf("{"))); } catch { parsed = null; }
		fact("AUTOLOOP_DISPATCH", /native/i.test(status) && parsed?.timeoutOk === true && parsed?.orphanProcess === 0, {
			status: status.trim().split("\n").pop(), timeoutOk: parsed?.timeoutOk ?? null, orphan: parsed?.orphanProcess ?? null,
		});
	}
}

// 8. CBM_ROUTING — the EKM tool must be offered; the legacy alias must not be.
{
	mode = "text";
	const dir = scratch("cbm-routing");
	const home = join(dir, "home"); prepareHome(home);
	// prepareHome already installed the tree; this asserts it rather than redoing it.
	if (!existsSync(join(home, ".omp", "agent", "extensions", basename(EXTENSION)))) throw new Error("extension not installed in the rehearsal HOME");
	requests.length = 0;
	await runCli(home, dir, ["--mode", "text", "-p", "hi", "--no-skills", "--no-rules", "--no-title", "--no-pty", "--max-time", "45s", "--cwd", dir]);
	const payload = requests.join("\n");
	fact("CBM_ROUTING", payload.includes('"name":"ekm_query"') && !payload.includes('"name":"cbm_query"'), {
		ekm: payload.includes('"name":"ekm_query"'), legacyAliasOffered: payload.includes('"name":"cbm_query"'),
	});
}

// 9. CONTROLLER_AUTHORITY_DENIAL — signed denial, no ledger write.
{
	mode = "text";
	const dir = scratch("authority-denial");
	const home = join(dir, "home"); prepareHome(home);
	const stateDir = join(dir, "state"); mkdirSync(stateDir, { recursive: true });
	const key = randomBytes(32).toString("hex");
	const keyFile = join(dir, "k.key"); writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
	const rpc = await rpcSession(home, dir, ["--no-session", "--no-extensions", "-e", EXTENSION, "--no-skills", "--no-rules"], {
		OMP_CONTROLLER_RESULT_KEY_FILE: keyFile, OMP_TERMINAL_FENCE_STATE_DIR: stateDir, OMP_CONTROLLER_RESULT_TRANSPORT: "stdout",
	});
	rpc.send("d1", "/fence-generation PASS request=d1");
	const frame = await rpc.awaitFrame(f => f.type === "controller_result" && f.requestId === "d1");
	await rpc.close();
	const correlator = new ResultCorrelator(key); correlator.expect("d1", {});
	const verdict = frame ? correlator.accept(frame) : { ok: false, reason: "NO_FRAME" };
	fact("CONTROLLER_AUTHORITY_DENIAL", verdict.ok === true && verdict.result?.denial === "CONTROLLER_AUTHORITY_ABSENT" && verdict.result?.committed === false, {
		verified: verdict.ok, denial: verdict.result?.denial ?? verdict.reason,
	});
	fact("CONTROLLER_AUTHORITY_DENIAL:no-ledger-write", readdirSync(stateDir).length === 0, readdirSync(stateDir));
}

// 10. CONTROLLER_VALID_COMMIT + 11. RESULT_CORRELATION + 12. LEDGER_EXCLUSIVITY
{
	mode = "text";
	await governed("valid-commit", {}, async ({ runtime, controllerRoot }) => {
		const bound = await bindIdentity(runtime);
		fact("CONTROLLER_VALID_COMMIT:bound", bound.ok === true && bound.identity.identityState === "ALLOCATED", bound.identity?.identityState ?? bound.reason);
		if (!bound.ok) return;
		const committed = await commitFence(runtime, { status: "PASS", expectation: bound.identity });
		fact("CONTROLLER_VALID_COMMIT", committed.state === COMMIT_STATE.COMMITTED && committed.result?.committed === true, { state: committed.state, ledgerRecorded: committed.result?.ledgerRecorded });
		const records = ledgerRecords(controllerRoot.stateDir, bound.identity.sessionId);
		const commitRecords = records.filter(r => r.type === "commit" && r.generation === bound.identity.generation);
		// The detail must be the number ASSERTED, not the total ledger size: printing
		// 3 for a `=== 1` assertion reads like the check passed on three records.
		fact("CONTROLLER_VALID_COMMIT:durable", commitRecords.length === 1, { commitRecords: commitRecords.length, totalRecords: records.length });
		const after = await bindIdentity(runtime);
		fact("CONTROLLER_VALID_COMMIT:generation-advanced", after.ok && after.identity.generation === bound.identity.generation + 1, after.identity?.generation ?? after.reason);

		// RESULT_CORRELATION
		const frame = runtime.frames.find(f => f.frame.type === "controller_result");
		const foreign = new ResultCorrelator(randomBytes(32).toString("hex"));
		foreign.expect(frame.frame.requestId, {});
		const foreignVerdict = foreign.accept(frame.frame);
		const own = new ResultCorrelator(runtime.key);
		own.expect(frame.frame.requestId, {});
		const firstAccept = own.accept(frame.frame);
		const replay = own.accept(frame.frame);
		fact("RESULT_CORRELATION", foreignVerdict.ok === false && firstAccept.ok === true && replay.ok === false, {
			foreignKey: foreignVerdict.reason, first: firstAccept.ok, replay: replay.reason,
		});
	});
}
{
	// LEDGER_EXCLUSIVITY — real OS processes against the deployed lock module.
	const dir = scratch("ledger-exclusivity");
	const stateDir = join(dir, "state"); mkdirSync(stateDir, { recursive: true });
	const sessionId = "rehearsal-exclusivity";
	const worker = join(resolve(dirname(CLIENT), "..", ".."), "scripts", "omp-controller-ledger-worker.mjs");
	if (!existsSync(worker)) {
		fact("LEDGER_EXCLUSIVITY", false, "UNKNOWN: worker script not found");
	} else {
		const run = (count, argsFor) => Promise.all(Array.from({ length: count }, (_, index) => new Promise(done => {
			const child = spawn(process.execPath, [worker, ...argsFor(index)], { stdio: ["ignore", "pipe", "pipe"] });
			let out = ""; child.stdout.on("data", chunk => { out += chunk; });
			child.on("exit", () => { try { done(JSON.parse(out.trim().split("\n").pop())); } catch { done({ parseError: out }); } });
		})));
		// EACH ROUND IS AN INDEPENDENTLY CONTESTED GENERATION.
		//
		// Independent review: the earlier version reused ONE generation for all three
		// rounds and summed winners, so rounds 2 and 3 were duplicate-commit refusals
		// against an already-closed generation, not races. That measures the duplicate
		// guard, not exclusivity. Each round now allocates its own generation, then six
		// processes race to commit THAT generation, and the round is asserted on its
		// own.
		const rounds = [];
		for (let round = 0; round < 3; round += 1) {
			const allocation = (await run(1, () => ["allocate", stateDir, sessionId, `rt-init-${round}`]))[0];
			const generation = allocation.generation;
			const observed = await run(6, index => ["commit", stateDir, sessionId, `rt-${round}-${index}`, String(generation)]);
			const winners = observed.filter(entry => entry.error === null && entry.committedRecorded === true).length;
			const records = ledgerRecords(stateDir, sessionId).filter(r => r.type === "commit" && r.generation === generation).length;
			rounds.push({ generation, winners, records });
		}
		fact("LEDGER_EXCLUSIVITY", rounds.every(round => round.winners === 1 && round.records === 1), rounds);
	}
}

// ═══ Phase C probes ════════════════════════════════════════════════════════

// C1 — the agent's own tool surface against the controller's durable artifacts.
{
	const dir = scratch("c1-boundary");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const runtime = await launchGovernedRuntime({
		rpcBin: OMP, controllerRoot, grant: GRANT,
		extensionPath: EXTENSION, extensionSha256: EXTENSION_SHA, extensionTree: EXTENSION_TREE,
		args: ["--no-session", "--no-skills", "--no-rules"], cwd: dir,
	});
	if (!runtime.ok) throw new Error(`c1: ${runtime.denial}`);
	const bound = await bindIdentity(runtime);
	const ledgerPath = join(controllerRoot.stateDir, `${bound.identity.sessionId}.jsonl`);
	fact("C1:ledger-not-committed-before", probeLedgerForCommit(runtime, bound.identity) === "NOT_COMMITTED", probeLedgerForCommit(runtime, bound.identity));

	// The governed child's own `bash` runs as the same uid as this controller.
	// Rather than model the attack, ask the runtime to perform it: write a
	// correctly-shaped commit record for the parent's generation.
	const forged = JSON.stringify({ type: "commit", sessionId: bound.identity.sessionId, runtimeInstanceId: bound.identity.runtimeInstanceId, generation: bound.identity.generation, status: "FAIL", requestId: "forged-by-agent", at: Date.now() });
	command = `printf '%s\\n' '${forged}' >> '${ledgerPath}'; echo appended`;
	mode = "tool";
	runtime.send({ id: "c1", type: "prompt", message: "run the tool" });
	const deadline = Date.now() + 20_000;
	while (!runtime.frames.some(f => f.frame.type === "tool_execution_end") && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
	const toolEnd = runtime.frames.find(f => f.frame.type === "tool_execution_end");
	fact("C1:agent-bash-wrote-ledger", (toolEnd?.frame?.result?.content?.[0]?.text ?? "").includes("appended"), toolEnd?.frame?.result?.content?.[0]?.text?.trim() ?? "no output");
	fact("C1:forged-record-not-believed", probeLedgerForCommit(runtime, bound.identity) !== "COMMITTED", probeLedgerForCommit(runtime, bound.identity));
	const legitimate = await commitFence(runtime, { status: "PASS", expectation: bound.identity });
	fact("C1:legit-commit-still-succeeds", legitimate.state === COMMIT_STATE.COMMITTED, { state: legitimate.state, denial: legitimate.result?.denial ?? null });
	await runtime.stop();
}
// C1 (load path) — the card asks whether a path the agent can modify can change
// what the NEXT launch loads. Measured on a scratch copy of the deployed tree.
{
	const dir = scratch("c1-load-path");
	const deployed = join(dir, "extensions");
	mkdirSync(deployed, { recursive: true });
	execFileSync("cp", ["-R", `${dirname(EXTENSION)}/.`, deployed]);
	const deployedEntry = join(deployed, basename(EXTENSION));
	const original = createHash("sha256").update(readFileSync(deployedEntry)).digest("hex");

	// 1. Is the deployed module writable by a same-uid process (the agent's bash)?
	let tampered = false;
	try { appendFileSync(deployedEntry, "\n// agent-was-here\n"); tampered = createHash("sha256").update(readFileSync(deployedEntry)).digest("hex") !== original; } catch { tampered = false; }
	fact("C1:agent-cannot-modify-loaded-module", !tampered, tampered ? "module bytes changed by a same-uid write" : "write refused");
	// Restore so the following facts measure the intended bytes.
	if (tampered) writeFileSync(deployedEntry, readFileSync(EXTENSION));

	// 2. Does a module dropped into the discovery directory load on the next start?
	const home = join(dir, "home");
	prepareHome(home);
	// Replace the freshly-copied tree with the one this block tampered with, so the
	// facts below measure the intended bytes rather than the pristine source.
	rmSync(join(home, ".omp", "agent", "extensions"), { recursive: true, force: true });
	execFileSync("cp", ["-R", deployed, join(home, ".omp", "agent", "extensions")]);
	const markerPath = join(dir, "DROPPED.txt");
	writeFileSync(join(home, ".omp", "agent", "extensions", "zz-dropped.js"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(markerPath)}, "loaded\\n"); }\n`);
	await runCli(home, dir, ["--mode", "text", "-p", "hi", "--no-skills", "--no-rules", "--no-title", "--no-pty", "--max-time", "45s", "--cwd", dir]);
	const droppedOnOrdinaryStart = existsSync(markerPath);
	fact("C1:ordinary-start-loads-dropped-module", droppedOnOrdinaryStart, droppedOnOrdinaryStart ? "dropped module executed" : "not loaded");

	// The same tree, but launched the GOVERNED way: --no-extensions is forced, so
	// discovery contributes nothing. This is the distinction that matters — an
	// ordinary `omp` start is a different trust domain from a governed launch.
	rmSync(markerPath, { force: true });
	const governedRoot = prepareControllerRoot({ root: join(dir, "governed") });
	prepareHome(governedRoot.childHome);
	const governedRuntime = await launchGovernedRuntime({
		rpcBin: OMP, controllerRoot: governedRoot, grant: GRANT,
		extensionPath: join(home, ".omp", "agent", "extensions", basename(EXTENSION)),
		extensionSha256: createHash("sha256").update(readFileSync(join(home, ".omp", "agent", "extensions", basename(EXTENSION)))).digest("hex"),
		extensionTree: attestExtension(join(home, ".omp", "agent", "extensions", basename(EXTENSION)), createHash("sha256").update(readFileSync(join(home, ".omp", "agent", "extensions", basename(EXTENSION)))).digest("hex")).digests,
		args: ["--no-session", "--no-skills", "--no-rules"], cwd: dir,
	});
	fact("C1:governed-launch-ignores-dropped-module", governedRuntime.ok === true && !existsSync(markerPath), governedRuntime.ok ? (existsSync(markerPath) ? "dropped module executed" : "not loaded") : governedRuntime.denial);
	if (governedRuntime.ok) await governedRuntime.stop();

	// 3. Does the ATTESTED launch refuse a tampered tree?
	if (tampered) writeFileSync(deployedEntry, `${readFileSync(deployedEntry, "utf8")}\n// tamper\n`);
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") });
	prepareHome(controllerRoot.childHome);
	const tamperedLaunch = await launchGovernedRuntime({
		rpcBin: OMP, controllerRoot, grant: GRANT,
		extensionPath: deployedEntry, extensionSha256: original, extensionTree: EXTENSION_TREE,
		args: ["--no-session"], cwd: dir,
	});
	fact("C1:attested-launch-refuses-tampered-tree", tamperedLaunch.ok === false, tamperedLaunch.denial ?? "launched");
	if (tamperedLaunch.ok) await tamperedLaunch.stop();
}

// C2 — the ledger is per-session, so two controllers with two state dirs can both
// commit generation 1 of one session. One state dir per session is a DEPLOYMENT
// requirement, not something the code enforces.
{
	mode = "text";
	const dir = scratch("c2-topology");
	const session = sessionFixture(dir);
	const a = prepareControllerRoot({ root: join(dir, "A") }); prepareHome(a.childHome);
	const b = prepareControllerRoot({ root: join(dir, "B") }); prepareHome(b.childHome);
	const launch = root => launchGovernedRuntime({ rpcBin: OMP, controllerRoot: root, grant: GRANT, extensionPath: EXTENSION, extensionSha256: EXTENSION_SHA, extensionTree: EXTENSION_TREE, args: session.args, cwd: dir });
	const ra = await launch(a); const rb = await launch(b);
	const ba = await bindIdentity(ra); const bb = await bindIdentity(rb);
	const ca = await commitFence(ra, { status: "PASS", expectation: ba.identity });
	const cb = await commitFence(rb, { status: "PASS", expectation: bb.identity });
	fact("C2:separate-state-dirs-cannot-double-commit", !(ca.state === COMMIT_STATE.COMMITTED && cb.state === COMMIT_STATE.COMMITTED), { a: ca.state, b: cb.state, generations: [ba.identity.generation, bb.identity.generation] });
	await ra.stop(); await rb.stop();
}

// C3 — request ids and keys are per launch.
{
	mode = "text";
	const dir = scratch("c3-correlation");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") }); prepareHome(controllerRoot.childHome);
	const launch = () => launchGovernedRuntime({ rpcBin: OMP, controllerRoot, grant: GRANT, extensionPath: EXTENSION, extensionSha256: EXTENSION_SHA, extensionTree: EXTENSION_TREE, args: ["--no-session", "--no-skills", "--no-rules"], cwd: dir });
	const r1 = await launch(); const r2 = await launch();
	await bindIdentity(r1); await bindIdentity(r2);
	const frame = r1.frames.find(f => f.frame.type === "controller_result");
	const foreign = new ResultCorrelator(r2.key); foreign.expect(frame.frame.requestId, {});
	const crossVerdict = foreign.accept(frame.frame);
	fact("C3:cross-instance-frame-refused", crossVerdict.ok === false, crossVerdict.reason);
	fact("C3:distinct-keys", r1.key !== r2.key && /^[0-9a-f]{64}$/.test(r1.key) && /^[0-9a-f]{64}$/.test(r2.key), {
		distinct: r1.key !== r2.key, shape: /^[0-9a-f]{64}$/.test(r1.key),
	});
	await r1.stop(); await r2.stop();
}

// C4 — what survives a crash. Kill the controller mid-commit; a fresh controller
// must reconcile from the ledger and must not report success the ledger lacks.
{
	mode = "text";
	const dir = scratch("c4-crash");
	const controllerRoot = prepareControllerRoot({ root: join(dir, "controller") }); prepareHome(controllerRoot.childHome);
	const script = join(dir, "controller-child.mjs");
	writeFileSync(script, [
		`import { launchGovernedRuntime, bindIdentity, commitFence } from ${JSON.stringify(CLIENT)};`,
		`import { writeFileSync } from "node:fs";`,
		`const [rpcBin, rootJson, grantJson, outPath, ext, sha, treeJson] = process.argv.slice(2);`,
		`let identity = null;`,
		`const runtime = await launchGovernedRuntime({ rpcBin, controllerRoot: JSON.parse(rootJson), grant: JSON.parse(grantJson),`,
		`  extensionPath: ext, extensionSha256: sha, extensionTree: JSON.parse(treeJson),`,
		`  args: ["--no-session","--no-skills","--no-rules"], cwd: ${JSON.stringify(dir)},`,
		`  dispatchObserver: payload => { if (typeof payload?.message === "string" && payload.message.startsWith("/fence-generation")) {`,
		`    writeFileSync(outPath, JSON.stringify({ phase: "dispatched", identity })); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000); } } });`,
		`if (!runtime.ok) { writeFileSync(outPath, JSON.stringify({ phase: "launch", denial: runtime.denial })); process.exit(2); }`,
		`const bound = await bindIdentity(runtime);`,
		`if (!bound.ok) { writeFileSync(outPath, JSON.stringify({ phase: "bind", reason: bound.reason })); process.exit(3); }`,
		`identity = bound.identity;`,
		`writeFileSync(outPath, JSON.stringify({ phase: "bound", identity }));`,
		`const settled = await commitFence(runtime, { status: "PASS", expectation: bound.identity, timeoutMs: 60000 });`,
		`writeFileSync(outPath, JSON.stringify({ phase: "committed", state: settled.state })); await runtime.stop(); process.exit(0);`,
	].join("\n"));
	const outPath = join(dir, "progress.json");
	const child = spawn(process.execPath, [script, OMP, JSON.stringify(controllerRoot), JSON.stringify(GRANT), outPath, EXTENSION, EXTENSION_SHA, JSON.stringify(EXTENSION_TREE)], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
	let progress = null;
	const deadline = Date.now() + 40_000;
	while (Date.now() < deadline) {
		if (existsSync(outPath)) { try { progress = JSON.parse(readFileSync(outPath, "utf8")); } catch { progress = null; } }
		if (progress?.phase === "dispatched") break;
		await new Promise(r => setTimeout(r, 25));
	}
	fact("C4:dispatched-before-kill", progress?.phase === "dispatched", progress?.phase ?? "never dispatched");
	child.kill("SIGKILL");
	await new Promise(r => child.once("exit", r));
	await new Promise(r => setTimeout(r, 2500));
	const identity = progress?.identity ?? null;
	if (!identity) { fact("C4:reconcile", false, "UNKNOWN: no identity captured"); }
	else {
		const records = ledgerRecords(controllerRoot.stateDir, identity.sessionId);
		const commits = records.filter(r => r.type === "commit" && r.generation === identity.generation);
		const durable = commits.length === 1 ? "COMMITTED" : commits.length === 0 ? "NOT_COMMITTED" : "AMBIGUOUS";
		// The dispatch observer fired, so the command reached the runtime. Either it
		// committed (exactly one record) or it did not (zero) — both are honest, but
		// TWO is corruption and must fail. `<= 1` was vacuous in the sense that a run
		// that never committed anything would also pass; the assertion now names
		// which of the two outcomes was observed and rejects the third.
		fact("C4:ledger-is-the-only-witness", durable === "COMMITTED" || durable === "NOT_COMMITTED", {
			durable, commitRecords: commits.length, records: records.map(r => `${r.type}:${r.generation}`),
		});
		// A fresh controller must not re-commit a closed generation, and must not
		// claim a commit the ledger does not hold.
		const fresh = await launchGovernedRuntime({ rpcBin: OMP, controllerRoot, grant: GRANT, extensionPath: EXTENSION, extensionSha256: EXTENSION_SHA, extensionTree: EXTENSION_TREE, args: ["--no-session", "--no-skills", "--no-rules"], cwd: dir });
		if (fresh.ok) {
			const probe = probeLedgerForCommit(fresh, identity);
			// EQUALITY, not "or UNKNOWN". Independent review: `probe === durable ||
			// probe === "UNKNOWN"` passes for a probe that always answers UNKNOWN, which
			// is precisely the broken-probe case the fact exists to catch. This fixture's
			// ledger is known-readable, so the probe must return the ledger's answer.
			fact("C4:probe-matches-ledger", probe === durable, { probe, durable });
			await fresh.stop();
		} else {
			fact("C4:probe-matches-ledger", false, fresh.denial);
		}
	}
}

// ═══ Phase F — rollback, on an isolated tree seeded with the production bytes ═
{
	const dir = scratch("rollback");
	// CONFIG ONLY: this case deliberately seeds the pre-R3 bytes itself, so it must
	// not have prepareHome install the R3 tree first.
	const home = join(dir, "home");
	mkdirSync(join(home, ".omp", "agent"), { recursive: true });
	writeFileSync(join(home, ".omp", "agent", "models.yml"), [
		"providers:", "  rehearsal:", `    baseUrl: http://127.0.0.1:${PORT}/v1`,
		"    api: openai-responses", "    apiKey: rehearsal-not-a-credential", "    models:",
		"    - id: rehearsal/fake", "      name: Rehearsal Fake", "      contextWindow: 100000",
		"      maxTokens: 4096", "      input:", "      - text", "",
	].join("\n"));
	writeFileSync(join(home, ".omp", "agent", "config.yml"), "modelRoles:\n  default: rehearsal/fake\nsymbolPreset: ascii\n");
	const target = join(home, ".omp", "agent", "extensions");
	const backups = join(dir, "backups");
	mkdirSync(target, { recursive: true });
	// Seed the PRODUCTION-SHAPED tree, not a two-file subset.
	//
	// Independent review: the earlier version seeded only `no-poll-waits.js` and
	// `lib/poll-wait-policy.js`, so `cbm-query.js` and the four existing test files
	// were `copy` actions — and rollback therefore DELETED them. The byte-identical
	// result was real but it proved restoration of a two-file tree, not of the
	// deployment. This seeds every pre-existing file the baseline records, from the
	// same revisions the deployment has, and then asserts the action classes.
	const repoRoot = resolve(dirname(CLIENT), "..", "..");
	const show = (rev, path) => execFileSync("git", ["-C", repoRoot, "show", `${rev}:${path}`], { maxBuffer: 1 << 26 });
	// no-poll-waits.js is at the PRE-R3 revision (fb8ce6a); cbm-query.js is already
	// at the later EKM revision that this deployment runs (1ebb121); the test files
	// and poll-wait-policy.js are unchanged across the delta.
	writeFileSync(join(target, "no-poll-waits.js"), show("fb8ce6a", "integrations/omp/extensions/no-poll-waits.js"));
	writeFileSync(join(target, "cbm-query.js"), show("1ebb121", "integrations/omp/extensions/cbm-query.js"));
	mkdirSync(join(target, "lib"), { recursive: true });
	for (const name of ["poll-wait-policy.js"]) {
		writeFileSync(join(target, "lib", name), show("fb8ce6a", `integrations/omp/extensions/lib/${name}`));
	}
	mkdirSync(join(target, "test"), { recursive: true });
	for (const name of ["poll-wait-policy.test.mjs", "waiter-fence.acceptance.ts", "terminal-fence-authority.acceptance.ts", "terminal-fence-ordering.acceptance.ts"]) {
		writeFileSync(join(target, "test", name), show("fb8ce6a", `integrations/omp/extensions/test/${name}`));
	}
	const before = execFileSync("sh", ["-c", `cd '${target}' && find . -type f | sort | xargs shasum -a 256`], { encoding: "utf8" });

	const installRecord = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts", "install-omp-integration.mjs"), "install", "--target", target, "--backup-root", backups, "--json"], { encoding: "utf8" }));
	fact("ROLLBACK:install-applied", installRecord.ok === true && installRecord.actions.some(a => a.action === "replace"), installRecord.actions?.map(a => a.action).join(","));
	// The classes that make "pre-existing files are preserved" a measured claim:
	// cbm-query.js and the four existing tests must be UNCHANGED (not copy), so the
	// rollback has no reason to touch them.
	{
		const byFile = Object.fromEntries((installRecord.actions ?? []).map(action => [action.file, action.action]));
		const preserved = ["cbm-query.js", "lib/poll-wait-policy.js", "test/poll-wait-policy.test.mjs", "test/waiter-fence.acceptance.ts", "test/terminal-fence-authority.acceptance.ts", "test/terminal-fence-ordering.acceptance.ts"];
		fact("ROLLBACK:preexisting-files-unchanged", preserved.every(file => byFile[file] === "unchanged"), {
			preserved: preserved.map(file => `${file}:${byFile[file] ?? "absent"}`),
		});
		fact("ROLLBACK:r3-files-copied", ["lib/controller-result.mjs", "lib/runtime-identity.mjs", "lib/ledger-lock.mjs", "test/controller-contract.acceptance.ts"].every(file => byFile[file] === "copy"), {
			copied: Object.entries(byFile).filter(([, action]) => action === "copy").map(([file]) => file),
		});
	}
	const recordPath = join(dir, "install-record.json");
	writeFileSync(recordPath, JSON.stringify(installRecord, null, 2));
	const rollback = JSON.parse(execFileSync(process.execPath, [join(repoRoot, "scripts", "omp-rollback-integration.mjs"), recordPath, "--json"], { encoding: "utf8" }));
	const after = execFileSync("sh", ["-c", `cd '${target}' && find . -type f | sort | xargs shasum -a 256`], { encoding: "utf8" });
	fact("ROLLBACK:byte-identical-restore", rollback.ok === true && before === after, { ok: rollback.ok, identical: before === after });
	fact("ROLLBACK:preexisting-files-survived", ["cbm-query.js", "lib/poll-wait-policy.js", "test/waiter-fence.acceptance.ts"].every(file => existsSync(join(target, file))), {
		present: ["cbm-query.js", "lib/poll-wait-policy.js", "test/waiter-fence.acceptance.ts"].filter(file => existsSync(join(target, file))),
	});
	fact("ROLLBACK:r3-files-removed", ["lib/controller-result.mjs", "lib/runtime-identity.mjs", "lib/ledger-lock.mjs", "test/controller-contract.acceptance.ts"].every(file => !existsSync(join(target, file))), {
		remaining: ["lib/controller-result.mjs", "lib/runtime-identity.mjs", "lib/ledger-lock.mjs", "test/controller-contract.acceptance.ts"].filter(file => existsSync(join(target, file))),
	});
	// The restored tree must still load and answer.
	mode = "text";
	const out = await runCli(home, dir, ["--mode", "text", "-p", "say the token", "--no-skills", "--no-rules", "--no-title", "--no-pty", "--auto-approve", "--max-time", "60s", "--cwd", dir]);
	fact("ROLLBACK:restored-runtime-answers", out.stdout.includes(TOKEN_TEXT), out.stdout.trim().slice(-40));
}

// ═══ result ════════════════════════════════════════════════════════════════
provider.close();
writeFileSync(join(ROOT, "facts.json"), JSON.stringify(facts, null, 2));
const failed = facts.filter(entry => !entry.ok);
console.log(`\nREHEARSAL=${failed.length === 0 ? "PASS" : "FAIL"} facts=${facts.length} failed=${failed.length}`);
console.log(`scratch=${ROOT}`);
process.exit(failed.length === 0 ? 0 : 1);
