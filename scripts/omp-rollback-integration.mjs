#!/usr/bin/env node
// scripts/omp-rollback-integration.mjs
//
// Reverse ONE `install-omp-integration.mjs install` exactly, from the record that
// install itself emitted.
//
//   node scripts/install-omp-integration.mjs install --json > deploy.json
//   node scripts/omp-rollback-integration.mjs deploy.json [--dry-run]
//
// Why this exists instead of using `uninstall`
// -------------------------------------------
// `uninstall` answers a different question: "remove this integration from the
// target". Measured on a real pre-card deployment, that leaves an INCONSISTENT
// tree — it restored the replaced `no-poll-waits.js` from backup and then REMOVED
// `lib/poll-wait-policy.js`, because that file was byte-identical at install time
// and therefore had no backup. The restored extension imports the removed file,
// so the runtime would fail to load it. Uninstall is correct for its own
// semantics; it is not a rollback.
//
// A rollback must reverse exactly what the install did:
//
//   copy       the file did not exist -> delete it
//   replace    the file existed       -> restore the backup bytes
//   unchanged  the file was already correct -> leave it alone
//
// Every one of those facts is in the install record, so this program needs no
// inference and no heuristics. It refuses to act if the record and the target
// disagree (a file changed after the install, or a backup is missing), because a
// rollback that guesses is worse than one that stops.

import { existsSync, readFileSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { KNOWN_FILES, readBytes, removeFile, sha256Bytes, writeFileAtomic } from "./omp-integration/lib.mjs";

const USAGE = `usage: node scripts/omp-rollback-integration.mjs <install-record.json> [--dry-run] [--json]

  <install-record.json>  the JSON emitted by
                         \`node scripts/install-omp-integration.mjs install --json\`

options:
  --dry-run   report the plan, change nothing
  --json      machine-readable report on stdout
  -h, --help  this text

Exit codes:
  0  rollback applied (or dry-run plan produced)
  1  REFUSED — the record and the target disagree; nothing was changed
  2  usage error
`;

function parseArgs(argv) {
	const opts = { recordPath: undefined, dryRun: false, json: false, help: false };
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift();
		if (arg === "--dry-run") opts.dryRun = true;
		else if (arg === "--json") opts.json = true;
		else if (arg === "-h" || arg === "--help") opts.help = true;
		else if (opts.recordPath === undefined) opts.recordPath = arg;
		else throw new Error(`unexpected argument: ${arg}`);
	}
	return opts;
}

/**
 * Build the reversal plan from an install record.
 *
 * @returns {{ ok: boolean, problems: string[], steps: Array<{file: string, action: string, from?: string}> }}
 */
export function planRollback(record) {
	const problems = [];
	const steps = [];
	if (!record || typeof record !== "object" || !Array.isArray(record.actions)) {
		return { ok: false, problems: ["record has no actions array"], steps };
	}
	if (typeof record.target !== "string" || record.target.length === 0) {
		problems.push("record does not name the install target");
	}
	for (const action of record.actions) {
		if (!action || typeof action.file !== "string") {
			problems.push("record contains a malformed action");
			continue;
		}
		if (!KNOWN_FILES.includes(action.file)) {
			problems.push(`record names a file outside the deployment set: ${action.file}`);
			continue;
		}
		if (action.action === "copy") {
			steps.push({ file: action.file, action: "delete", deployedSha256: action.deployedSha256 });
		} else if (action.action === "replace") {
			if (typeof action.backup !== "string") {
				problems.push(`replace action for ${action.file} names no backup`);
				continue;
			}
			steps.push({
				file: action.file,
				action: "restore",
				from: action.backup,
				deployedSha256: action.deployedSha256,
			});
		} else if (action.action === "unchanged") {
			steps.push({ file: action.file, action: "leave" });
		} else {
			problems.push(`unknown action "${action.action}" for ${action.file}`);
		}
	}
	return { ok: problems.length === 0, problems, steps };
}

/**
 * Does the file still hold the bytes the install wrote?
 *
 * Measured in review: without this, a rollback happily deleted an edit made
 * after the install, and overwrote a replaced file with the older backup —
 * reporting `APPLIED` both times. A record that predates `deployedSha256` cannot
 * answer the question, so it is treated as "unknown", not "unchanged".
 *
 * @returns {boolean}
 */
function matchesDeployed(step, dest) {
	if (typeof step.deployedSha256 !== "string") return false;
	return sha256Bytes(readBytes(dest)) === step.deployedSha256;
}

function changedSinceInstall(file) {
	return `${file} changed after the install (its bytes no longer match the install record); refusing to discard the change`;
}

function fail(message, json) {
	if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
	else process.stderr.write(`omp-rollback-integration: REFUSED — ${message}\n`);
	return 1;
}

function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`${error.message}\n\n${USAGE}`);
		return 2;
	}
	if (opts.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (!opts.recordPath) {
		process.stderr.write(USAGE);
		return 2;
	}

	let record;
	try {
		record = JSON.parse(readFileSync(opts.recordPath, "utf8"));
	} catch (error) {
		return fail(`cannot read the install record: ${String(error)}`, opts.json);
	}

	const plan = planRollback(record);
	if (!plan.ok) return fail(plan.problems.join("; "), opts.json);

	const target = resolve(record.target);

	// Preconditions, checked before anything is touched.
	const problems = [];
	for (const step of plan.steps) {
		const dest = join(target, step.file);
		if (step.action === "delete") {
			if (!existsSync(dest)) problems.push(`expected ${step.file} to exist (install created it)`);
			else if (!matchesDeployed(step, dest)) problems.push(changedSinceInstall(step.file));
		} else if (step.action === "restore") {
			if (!existsSync(step.from)) problems.push(`backup missing: ${step.from}`);
			else if (!existsSync(dest)) problems.push(`expected ${step.file} to exist (install replaced it)`);
			else if (sha256Bytes(readBytes(dest)) === sha256Bytes(readBytes(step.from))) {
				// The install's write never took effect, or something already
				// restored it. Leaving it alone is the correct reversal.
				step.action = "leave";
			} else if (!matchesDeployed(step, dest)) problems.push(changedSinceInstall(step.file));
		}
	}
	if (problems.length > 0) return fail(problems.join("; "), opts.json);

	const applied = [];
	for (const step of plan.steps) {
		const dest = join(target, step.file);
		if (step.action === "delete") {
			if (!opts.dryRun) removeFile(dest);
			applied.push({ file: step.file, action: "delete" });
		} else if (step.action === "restore") {
			if (!opts.dryRun) writeFileAtomic(dest, readBytes(step.from));
			applied.push({ file: step.file, action: "restore", from: step.from });
		} else {
			applied.push({ file: step.file, action: "leave" });
		}
	}

	// Prune ONLY the directories the install recorded creating, deepest first.
	// Measured in review: inferring ownership from deleted files removed a
	// pre-existing empty `lib/`, so the tree was not restored exactly.
	const recorded = Array.isArray(record.createdDirectories) ? record.createdDirectories : [];
	const pruned = [];
	const prunable = recorded
		.filter(dir => typeof dir === "string" && dir.length > 0 && dir !== "." && !isAbsolute(dir) && !dir.split(/[\\/]/).includes(".."))
		.sort((a, b) => b.split("/").length - a.split("/").length);
	for (const dir of prunable) {
		const abs = join(target, dir);
		try {
			if (statSync(abs).isDirectory() && readdirSync(abs).length === 0) {
				if (!opts.dryRun) rmdirSync(abs);
				pruned.push(dir);
			}
		} catch {
			// absent or unreadable: nothing to prune
		}
	}

	const result = { ok: true, target, dryRun: opts.dryRun, steps: applied, prunedDirectories: pruned };
	if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	else {
		process.stdout.write("OMP_INTEGRATION_ROLLBACK\n");
		process.stdout.write(`target = ${target}${opts.dryRun ? " (dry-run)" : ""}\n`);
		for (const step of applied) {
			process.stdout.write(`  ${step.action.padEnd(8)} ${step.file}${step.from ? ` <- ${step.from}` : ""}\n`);
		}
		for (const dir of pruned) process.stdout.write(`  prune    ${dir}/\n`);
		process.stdout.write(`ROLLBACK_RESULT = ${opts.dryRun ? "PLANNED" : "APPLIED"}\n`);
	}
	return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}

export { main as runRollback };
