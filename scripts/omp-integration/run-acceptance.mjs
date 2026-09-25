#!/usr/bin/env node
// scripts/omp-integration/run-acceptance.mjs
//
// Runs the OMP integration's own acceptance harnesses against the bytes in this
// repository:
//
//   1. extensions/test/poll-wait-policy.test.mjs              (node)   classifier
//   2. extensions/test/waiter-fence.acceptance.ts             (bun)    waiter lifecycle
//   3. extensions/test/terminal-fence-authority.acceptance.ts (bun)    authority contract
//
// Harnesses 2 and 3 drive the REAL extension module against a REAL
// AsyncJobManager taken from `@oh-my-pi/pi-coding-agent`, so they need that
// package present. It is deliberately NOT a dependency of this repository: the
// host-only `npm test` suite must stay installable on a machine that never runs
// an agent. Point the runner at any copy of the package instead:
//
//   # option A — reuse the copy your OMP install already has
//   node scripts/omp-integration/run-acceptance.mjs
//
//   # option B — fetch a pinned copy into a scratch prefix (clean machine)
//   npm install --prefix /tmp/omp-deps @oh-my-pi/pi-coding-agent@17.4.0
//   OMP_PI_CODING_AGENT_ROOT=/tmp/omp-deps/node_modules/@oh-my-pi/pi-coding-agent \
//     node scripts/omp-integration/run-acceptance.mjs
//
// Resolution order for the package: $OMP_PI_CODING_AGENT_ROOT, this repo's
// node_modules, $HOME/node_modules, $HOME/.omp/plugins/node_modules, the global
// npm root. Nothing is installed for you and nothing is written outside a
// temporary staging directory.
//
// Exit: 0 all suites PASS, 1 a suite FAILED, 2 a prerequisite is missing.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_ROOT } from "./lib.mjs";

const PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
const PACKAGE_RELATIVE = join("@oh-my-pi", "pi-coding-agent");

const SUITES = [
	{
		name: "poll-wait-policy",
		file: "test/poll-wait-policy.test.mjs",
		runtime: "node",
		expect: /fail=0\b/,
		label: "POLICY_TEST",
	},
	{
		name: "waiter-fence",
		file: "test/waiter-fence.acceptance.ts",
		runtime: "bun",
		expect: /^ACCEPTANCE=PASS$/m,
		label: "WAITER_FENCE",
	},
	{
		name: "terminal-fence-authority",
		file: "test/terminal-fence-authority.acceptance.ts",
		runtime: "bun",
		expect: /^AUTHORITY_ACCEPTANCE=PASS$/m,
		label: "TERMINAL_FENCE_AUTHORITY",
	},
];

function which(candidates) {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
		if (probe.status === 0) return candidate;
	}
	return null;
}

function resolveBun() {
	if (process.env.BUN_BIN) return which([process.env.BUN_BIN]);
	return which(["bun", join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]);
}

function npmGlobalRoot() {
	const probe = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
	return probe.status === 0 ? probe.stdout.trim() : null;
}

/** A directory is the package only if its package.json says so. */
function isPackageRoot(dir) {
	if (!dir) return false;
	const manifest = join(dir, "package.json");
	if (!existsSync(manifest)) return false;
	try {
		return JSON.parse(readFileSync(manifest, "utf8")).name === PACKAGE_NAME;
	} catch {
		return false;
	}
}

function resolvePackageRoot() {
	const globalRoot = npmGlobalRoot();
	const candidates = [
		process.env.OMP_PI_CODING_AGENT_ROOT,
		join(SOURCE_ROOT, "..", "..", "..", "node_modules", PACKAGE_RELATIVE),
		join(homedir(), "node_modules", PACKAGE_RELATIVE),
		join(homedir(), ".omp", "plugins", "node_modules", PACKAGE_RELATIVE),
		join(homedir(), ".omp", "node_modules", PACKAGE_RELATIVE),
		globalRoot ? join(globalRoot, PACKAGE_RELATIVE) : null,
	];
	for (const candidate of candidates) {
		if (isPackageRoot(candidate)) return candidate;
	}
	return null;
}

/**
 * Copy the published extension tree into a scratch directory that also has the
 * OMP package on its resolution path, so the harnesses import exactly the bytes
 * shipping in this repository.
 */
function stageSource(packageRoot) {
	const stage = mkdtempSync(join(tmpdir(), "omp-integration-acceptance-"));
	mkdirSync(join(stage, "node_modules", "@oh-my-pi"), { recursive: true });
	symlinkSync(packageRoot, join(stage, "node_modules", PACKAGE_RELATIVE), "dir");
	cpSync(SOURCE_ROOT, join(stage, "extensions"), { recursive: true });
	return stage;
}

function runSuite(suite, stage, bun) {
	const runtime = suite.runtime === "bun" ? bun : process.execPath;
	const result = spawnSync(runtime, [join("extensions", suite.file)], {
		cwd: stage,
		encoding: "utf8",
		timeout: 300_000,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	const output = stdout + stderr;
	const pass = result.status === 0 && suite.expect.test(output);
	return {
		name: suite.name,
		label: suite.label,
		status: pass ? "PASS" : "FAIL",
		exit: result.status,
		output: output.trim(),
	};
}

function main(argv) {
	const keep = argv.includes("--keep");
	const json = argv.includes("--json");

	const bun = resolveBun();
	const packageRoot = resolvePackageRoot();

	const blockers = [];
	if (!bun) blockers.push("bun is not installed (needed for the two .ts acceptance harnesses)");
	if (!packageRoot) blockers.push(`${PACKAGE_NAME} was not found (see the header of this script)`);

	if (blockers.length > 0) {
		if (json) process.stdout.write(`${JSON.stringify({ ok: false, blockers }, null, 2)}\n`);
		else {
			process.stdout.write("OMP_INTEGRATION_ACCEPTANCE\n");
			for (const blocker of blockers) process.stdout.write(`  BLOCKED: ${blocker}\n`);
			process.stdout.write("OMP_INTEGRATION_ACCEPTANCE=PREREQUISITE_MISSING\n");
		}
		return 2;
	}

	const stage = stageSource(packageRoot);
	let results;
	try {
		results = SUITES.map(suite => runSuite(suite, stage, bun));
	} finally {
		if (!keep) rmSync(stage, { recursive: true, force: true });
	}

	const ok = results.every(r => r.status === "PASS");
	if (json) {
		process.stdout.write(
			`${JSON.stringify({ ok, bun, packageRoot, stage: keep ? stage : null, results }, null, 2)}\n`,
		);
	} else {
		process.stdout.write("OMP_INTEGRATION_ACCEPTANCE\n");
		process.stdout.write(`bun = ${bun}\n`);
		process.stdout.write(`${PACKAGE_NAME} = ${packageRoot}\n`);
		for (const result of results) {
			process.stdout.write(`\n--- ${result.name} (exit ${result.exit}) ---\n${result.output}\n`);
			process.stdout.write(`${result.label}=${result.status}\n`);
		}
		if (keep) process.stdout.write(`staged at ${stage}\n`);
		process.stdout.write(`OMP_INTEGRATION_ACCEPTANCE=${ok ? "PASS" : "FAIL"}\n`);
	}
	return ok ? 0 : 1;
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}
