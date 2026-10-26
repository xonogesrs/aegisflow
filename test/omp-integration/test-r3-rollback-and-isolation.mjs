// test/omp-integration/test-r3-rollback-and-isolation.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1 —
// Phase B (isolation) and Phase E (rollback), measured.
//
// Two questions, both answered by observation rather than by assertion:
//
//   1. ISOLATION. Does this card's work touch the running installation? The
//      answer must be NO, and it is proved by hashing the deployed extension and
//      the OMP config before and after the R3 suite runs a real runtime.
//   2. ROLLBACK. Can a deployment carrying the R3 lock module be reversed
//      byte-for-byte, leaving a working pre-R3 tree and no test authority behind?
//
// Run: node --test test/omp-integration/test-r3-rollback-and-isolation.mjs

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { KNOWN_FILES, sha256File } from "../../scripts/omp-integration/lib.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install-omp-integration.mjs");
const ROLLBACK = join(REPO_ROOT, "scripts", "omp-rollback-integration.mjs");
const R3_SUITE = join(REPO_ROOT, "scripts", "omp-rpc-controller-r3-suite.mjs");
const SOURCE_ROOT = join(REPO_ROOT, "integrations", "omp", "extensions");
/** The commit this card branched from: the pre-R3 deployment's own bytes. */
const PRE_R3_COMMIT = "51ce4f82b8900aaec6de38fd7df1d75263873f2e";

/** The running installation this card must not modify. */
const PRODUCTION_EXTENSION = join(homedir(), ".omp", "agent", "extensions", "no-poll-waits.js");
const PRODUCTION_CONFIG = join(homedir(), ".omp", "agent", "config.yml");

function hashIfPresent(path) {
	return existsSync(path) ? sha256File(path) : null;
}

/** Authority variables that must not be present anywhere in this process tree. */
/**
 * Every variable that names or carries controller authority (R4).
 *
 * The list grew because authority moved: the descriptor numbers and the lock
 * directory are part of the capability's provisioning now, and a test that
 * leaked any of them into the operator's shell would be provisioning authority
 * for whatever ran next.
 */
const AUTHORITY_VARS = [
	"OMP_TERMINAL_FENCE_AUTHORITY",
	"OMP_CONTROLLER_RESULT_KEY_FILE",
	"OMP_TERMINAL_FENCE_STATE_DIR",
	"OMP_CONTROLLER_LEDGER_KEY_FD",
	"OMP_TERMINAL_FENCE_LEDGER_FD",
	"OMP_TERMINAL_FENCE_LOCK_DIR",
];

test("the running installation is untouched by this card's test runs", async () => {
	const before = {
		extension: hashIfPresent(PRODUCTION_EXTENSION),
		config: hashIfPresent(PRODUCTION_CONFIG),
	};
	// Run the real transport suite: it spawns real runtimes with real authority.
	// If anything in this card reached for the deployed extension or the operator's
	// config, this is the call that would do it.
	const { stdout } = await execFileAsync(process.execPath, [R3_SUITE, "--case", "commit"], {
		encoding: "utf8",
		timeout: 180_000,
		env: { ...process.env, AEGIS_R3_SCRATCH: join(mkdtempSync(join(tmpdir(), "r3-iso-")), "scratch") },
	});
	assert.match(stdout, /CONTROLLER_R3_TRANSPORT_SUITE=PASS/, stdout);

	const after = {
		extension: hashIfPresent(PRODUCTION_EXTENSION),
		config: hashIfPresent(PRODUCTION_CONFIG),
	};
	assert.equal(after.extension, before.extension, "the deployed extension changed while the R3 suite ran");
	assert.equal(after.config, before.config, "the operator's config changed while the R3 suite ran");
});

test("no authority variable leaks into this test process", () => {
	for (const name of AUTHORITY_VARS) {
		assert.equal(
			process.env[name],
			undefined,
			`${name} is set in the test process: a test must never inherit controller authority`,
		);
	}
});

test("the controller client's scratch output leaves no test authority behind", async () => {
	const scratchRoot = join(mkdtempSync(join(tmpdir(), "r3-clean-")), "scratch");
	await execFileAsync(process.execPath, [R3_SUITE, "--case", "commit"], {
		encoding: "utf8",
		timeout: 180_000,
		env: { ...process.env, AEGIS_R3_SCRATCH: scratchRoot },
	});
	// Every controller root this card created is disposed. A leftover 0700 root
	// would still hold a usable signing key and ledger.
	const casesRoot = join(scratchRoot, "cases");
	if (!existsSync(casesRoot)) return;
	const leftovers = [];
	for (const name of readdirSync(casesRoot)) {
		const controllerDir = join(casesRoot, name, "controller");
		if (!existsSync(controllerDir)) continue;
		for (const entry of readdirSync(controllerDir)) {
			if (/\.key$/.test(entry)) leftovers.push(join(controllerDir, entry));
		}
	}
	assert.deepEqual(leftovers, [], `signing keys survived disposal: ${JSON.stringify(leftovers)}`);
});

test("a deployment carrying the R3 lock module rolls back byte-for-byte to the base-commit bytes", async () => {
	const root = mkdtempSync(join(tmpdir(), "r3-rollback-"));
	const target = join(root, "extensions");
	mkdirSync(target, { recursive: true });

	// A pre-R3 tree: the predecessor's files, with the R3-only module absent.
	for (const rel of KNOWN_FILES) {
		if (rel === "lib/ledger-lock.mjs") continue;
		const destination = join(target, rel);
		mkdirSync(dirname(destination), { recursive: true });
		const bytes = readFileSync(join(SOURCE_ROOT, rel));
		// A pre-R3 extension that predates the lock: this is what a rollback must
		// restore, so it must DIFFER from the shipped bytes or the test proves
		// nothing about restoration.
		const content = rel === "no-poll-waits.js" ? `${bytes.toString("utf8")}\n// pre-R3 marker\n` : bytes;
		writeFileSync(destination, content);
	}
	const before = new Map(KNOWN_FILES.filter(rel => rel !== "lib/ledger-lock.mjs").map(rel => [rel, sha256File(join(target, rel))]));

	const installed = await execFileAsync(process.execPath, [INSTALLER, "install", "--target", target, "--json"], {
		encoding: "utf8",
		timeout: 120_000,
	});
	const record = JSON.parse(installed.stdout);
	assert.equal(existsSync(join(target, "lib", "ledger-lock.mjs")), true, "the install must deploy the R3 lock module");

	const rolled = await execFileAsync(process.execPath, [ROLLBACK, join(root, "deploy.json")], { encoding: "utf8" }).catch(async () => {
		// The rollback takes the install's own --json record; write it where the
		// script expects it.
		writeFileSync(join(root, "deploy.json"), `${JSON.stringify(record, null, 2)}\n`);
		return execFileAsync(process.execPath, [ROLLBACK, join(root, "deploy.json")], { encoding: "utf8" });
	});
	// The rollback reports `APPLIED` when it reversed the install. Asserting on that
	// exact token (rather than a loose /PASS/) is what makes this a check: a refusal
	// would print `REFUSED` with a reason, and the byte comparisons below would
	// then fail with a less useful message.
	assert.match(rolled.stdout, /ROLLBACK_RESULT = APPLIED/, rolled.stdout);
	assert.match(rolled.stdout, /delete\s+lib\/ledger-lock\.mjs/, "the R3-only module must be named in the reversal plan");

	for (const [rel, digest] of before) {
		assert.equal(sha256File(join(target, rel)), digest, `${rel} was not restored byte-for-byte`);
	}
	assert.equal(existsSync(join(target, "lib", "ledger-lock.mjs")), false, "the R3-only module must be removed by the rollback");
});

/**
 * The real-runtime probe the comparison test runs in a child process.
 *
 * Kept as a string so the test file has no side effects when imported, and so the
 * probe's own environment (private HOME, inert provider) cannot leak into the
 * test runner.
 */
const PROMPT_PROBE_SOURCE = `
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT = process.argv[2];
const dir = mkdtempSync(join(tmpdir(), "r3-prompt-"));
const home = join(dir, "home");
mkdirSync(join(home, ".omp", "agent"), { recursive: true });
writeFileSync(join(home, ".omp", "agent", "models.yml"), [
 "providers:","  p:","    baseUrl: http://127.0.0.1:1/v1","    api: openai-responses","    apiKey: x",
 "    models:","    - id: p/m","      name: M","      contextWindow: 4000","      maxTokens: 64",""].join("\\n"));
writeFileSync(join(home, ".omp", "agent", "config.yml"), ["modelRoles:","  default: p/m",""].join("\\n"));

const child = spawn(process.env.AEGIS_RPC_BIN || "omp",
  ["--mode","rpc","--no-session","-e",EXT,"--no-extensions","--no-skills","--no-rules","--no-lsp"],
  { cwd: dir, env: { PATH: process.env.PATH, HOME: home, TERM: "dumb", LANG: "en_US.UTF-8" }, stdio: ["pipe","pipe","pipe"] });
let buf = "", err = "";
child.stdout.setEncoding("utf8"); child.stdout.on("data", d => buf += d);
child.stderr.setEncoding("utf8"); child.stderr.on("data", d => err += d);
const parse = () => buf.split("\\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const wait = (pred, ms) => new Promise(r => { const t = Date.now(); const iv = setInterval(() => { if (pred() || Date.now() - t > ms) { clearInterval(iv); r(pred()); } }, 50); });

await wait(() => buf.includes('"ready"'), 25000);
const ready = buf.includes('"ready"');
child.stdin.write(JSON.stringify({ id: "p1", type: "prompt", message: "say hello" }) + "\\n");
await wait(() => parse().some(f => f.id === "p1" && f.type === "response"), 30000);
child.stdin.write(JSON.stringify({ id: "p2", type: "prompt", message: "/fence-identity" }) + "\\n");
await wait(() => parse().some(f => f.id === "p2" && f.type === "response"), 20000);
await new Promise(r => setTimeout(r, 500));
const frames = parse();
const r1 = frames.find(f => f.id === "p1" && f.type === "response");
const r2 = frames.find(f => f.id === "p2" && f.type === "response");
const cmds = frames.filter(f => f.type === "available_commands_update").flatMap(f => (f.data?.commands ?? f.commands ?? []).map(c => c.name ?? c));
const alive = child.exitCode === null;
child.kill("SIGTERM");
process.stdout.write(JSON.stringify({
  ready,
  normalPromptAnswered: Boolean(r1),
  normalPromptSuccess: r1?.success ?? null,
  slashCommandAnswered: Boolean(r2),
  hasFenceCommand: cmds.includes("fence-generation"),
  stillAlive: alive,
  stderr: err.slice(0, 200),
}));
`;

/**
 * Materialise the PRE-R3 deployment: the bytes at the base commit.
 *
 * Independent review caught the original fixture: it copied the CURRENT files and
 * merely omitted `lib/ledger-lock.mjs`, producing a tree that no install ever
 * creates — current `runtime-identity.mjs` imports the lock, so removing the lock
 * left an unloadable module and the test failed for a reason that has nothing to
 * do with rollback. A pre-R3 tree must be the pre-R3 BYTES.
 */
function writePreR3Tree(target) {
	for (const rel of KNOWN_FILES) {
		if (rel === "lib/ledger-lock.mjs") continue;
		const destination = join(target, rel);
		mkdirSync(dirname(destination), { recursive: true });
		let bytes;
		try {
			bytes = execFileSync("git", ["-C", REPO_ROOT, "show", `${PRE_R3_COMMIT}:integrations/omp/extensions/${rel}`]);
		} catch {
			// A file that did not exist at the base commit is genuinely new in R3.
			continue;
		}
		writeFileSync(destination, bytes);
	}
}

test("a rolled-back deployment restores a loadable extension module", async () => {
	// The card's Phase E requires the rollback to leave a WORKING installation, not
	// merely a byte-identical one. Independent review flagged that the hash-only
	// check above cannot tell a restored tree from a restored tree that no longer
	// imports. This runs the restored extension in a real runtime.
	const root = mkdtempSync(join(tmpdir(), "r3-rollback-live-"));
	const target = join(root, "extensions");
	mkdirSync(target, { recursive: true });
	writePreR3Tree(target);
	// Remove the R3-only module AND make the extension the pre-R3 shape by pointing
	// its import at nothing: this is what a naive rollback produces, and the test
	// must show that the tree it restores is the one that runs.
	const installed = await execFileAsync(process.execPath, [INSTALLER, "install", "--target", target, "--json"], {
		encoding: "utf8",
		timeout: 120_000,
	});
	writeFileSync(join(root, "record.json"), installed.stdout, "utf8");
	const applied = await execFileAsync(process.execPath, [ROLLBACK, join(root, "record.json")], { encoding: "utf8" });
	assert.match(applied.stdout, /ROLLBACK_RESULT = APPLIED/, applied.stdout);

	// SCOPE, stated precisely: this proves the restored tree is syntactically valid
	// and that its module graph resolves. Independent review correctly objected to
	// the original name, which claimed the extension "serves commands" — it does not;
	// it never launches a runtime or invokes the registration function. The runtime
	// behaviour is measured by the prompt test below, against a directly materialised
	// base tree rather than a rolled-back one. Neither test alone is the whole claim,
	// and neither is named as if it were.
	await execFileAsync(process.execPath, ["--check", join(target, "no-poll-waits.js")], { encoding: "utf8" });
	const probe = await execFileAsync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(join(target, "no-poll-waits.js"))});` +
				`const names = Object.keys(m);` +
				`if (!names.includes("default")) { console.error("NO_DEFAULT_EXPORT", names); process.exit(3); }` +
				`process.stdout.write("LOADED:" + names.length);`,
		],
		{ encoding: "utf8", timeout: 60_000, cwd: root },
	);
	assert.match(probe.stdout, /^LOADED:\d+$/, probe.stdout);
});

test("the pre-R3 extension answers an ordinary prompt and a slash command on a real runtime", async () => {
	// Phase E rows OMP_NORMAL_PROMPT and OMP_SLASH_COMMAND are about the runtime still
	// accepting ordinary work, which a byte comparison cannot show.
	//
	// SCOPE, stated precisely (review objected to the original claim):
	//   * the tree under test is the base-commit bytes materialised DIRECTLY, not a
	//     tree produced by install-then-rollback. It measures "the pre-R3 extension
	//     still works on the real binary", which is the rollback TARGET's property;
	//   * the provider is an inert stub on a closed port, so "answered" means the
	//     runtime returned a `response` frame for the prompt — it does NOT prove a
	//     model produced a correct answer, and it does NOT exercise tool calling;
	//   * `slashCommandAnswered` likewise proves the command was accepted and
	//     dispatched, not that its side effect was correct.
	// The installer/rollback byte-for-byte test above proves the restored bytes equal
	// the base bytes; together the two establish "rollback restores a tree that runs",
	// and neither claims more than its own measurement.
	const rolledBack = join(mkdtempSync(join(tmpdir(), "r3-prompt-base-")), "ext");
	writePreR3Tree(rolledBack);
	const current = SOURCE_ROOT;

	const probe = join(mkdtempSync(join(tmpdir(), "r3-prompt-probe-")), "probe.mjs");
	writeFileSync(probe, PROMPT_PROBE_SOURCE);

	const runProbe = async extension => {
		const { stdout } = await execFileAsync(process.execPath, [probe, extension], {
			encoding: "utf8",
			timeout: 120_000,
			env: { ...process.env, AEGIS_RPC_BIN: process.env.AEGIS_RPC_BIN || execFileSync("which", ["omp"], { encoding: "utf8" }).trim() },
		});
		return JSON.parse(stdout);
	};

	const base = await runProbe(join(rolledBack, "no-poll-waits.js"));
	const r3 = await runProbe(join(current, "no-poll-waits.js"));

	// The rolled-back tree must WORK, on its own terms.
	assert.equal(base.ready, true, `the rolled-back runtime never became ready: ${JSON.stringify(base)}`);
	assert.equal(base.normalPromptAnswered, true, "an ordinary prompt was not answered after rollback");
	// Presence alone is too weak: a `response` frame with `success:false` would also
	// satisfy it. The runtime must actually accept the ordinary prompt.
	assert.equal(base.normalPromptSuccess, true, "the ordinary prompt was answered with success:false");
	assert.equal(base.slashCommandAnswered, true, "a slash command was not answered after rollback");
	assert.equal(base.stillAlive, true, "the runtime died after rollback");
	// And R3 must behave the same way: no regression in the ordinary paths.
	assert.deepEqual(
		{
			ready: r3.ready,
			normalPromptAnswered: r3.normalPromptAnswered,
			normalPromptSuccess: r3.normalPromptSuccess,
			slashCommandAnswered: r3.slashCommandAnswered,
			hasFenceCommand: r3.hasFenceCommand,
			stillAlive: r3.stillAlive,
		},
		{
			ready: base.ready,
			normalPromptAnswered: base.normalPromptAnswered,
			normalPromptSuccess: base.normalPromptSuccess,
			slashCommandAnswered: base.slashCommandAnswered,
			hasFenceCommand: base.hasFenceCommand,
			stillAlive: base.stillAlive,
		},
		"R3 changed ordinary prompt/command behavior",
	);
});

test("a rollback preserves evidence and the identity ledger", async () => {
	// Phase E item 5: existing evidence and the ledger must survive. A rollback that
	// deleted the state directory would erase the durable statement of what
	// committed, which is worse than leaving the new code installed.
	const root = mkdtempSync(join(tmpdir(), "r3-rollback-evidence-"));
	const target = join(root, "extensions");
	mkdirSync(target, { recursive: true });
	writePreR3Tree(target);
	const installed = await execFileAsync(process.execPath, [INSTALLER, "install", "--target", target, "--json"], {
		encoding: "utf8",
		timeout: 120_000,
	});
	writeFileSync(join(root, "record.json"), installed.stdout, "utf8");

	// Evidence + ledger OUTSIDE the deployment target, as a real deployment has them.
	const evidenceDir = join(root, "evidence");
	const stateDir = join(root, "state");
	mkdirSync(evidenceDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	const ledger = join(stateDir, "session.jsonl");
	writeFileSync(ledger, `${JSON.stringify({ type: "commit", sessionId: "s", runtimeInstanceId: "r", generation: 1 })}\n`);
	const evidenceFile = join(evidenceDir, "facts.json");
	writeFileSync(evidenceFile, `${JSON.stringify({ facts: 49 })}\n`);
	const ledgerDigest = sha256File(ledger);
	const evidenceDigest = sha256File(evidenceFile);

	const applied = await execFileAsync(process.execPath, [ROLLBACK, join(root, "record.json")], { encoding: "utf8" });
	assert.match(applied.stdout, /ROLLBACK_RESULT = APPLIED/, applied.stdout);

	assert.equal(sha256File(ledger), ledgerDigest, "the rollback destroyed the identity ledger");
	assert.equal(sha256File(evidenceFile), evidenceDigest, "the rollback destroyed existing evidence");
});

