#!/usr/bin/env node
// scripts/install-omp-integration.mjs
//
// Installation, update, drift check and uninstall for the optional OMP
// integration in `integrations/omp/`.
//
//   node scripts/install-omp-integration.mjs install    # default
//   node scripts/install-omp-integration.mjs check
//   node scripts/install-omp-integration.mjs uninstall
//
// Flags (all subcommands):
//   --target <dir>        extension directory (default: $OMP_EXTENSIONS_DIR or ~/.omp/agent/extensions)
//   --source <dir>        source extension tree (default: integrations/omp/extensions)
//   --backup-root <dir>   where a conflicting deployment is preserved
//   --dry-run             print the plan, change nothing
//   --strict-bytes        `check`: require byte-identical, not merely equivalent
//   --json                machine-readable report on stdout
//
// What this program will never do, by construction:
//
//   * copy a file that is not in KNOWN_FILES;
//   * touch any path under the target except those files (and, on uninstall,
//     their backups) — `models.yml`, provider keys and unrelated extensions are
//     not read, written, hashed or globbed;
//   * read or transmit anything outside the source tree and the target files;
//   * leave a half-written file behind (every write is temp + rename);
//   * destroy a differing deployment (it is backed up first, byte for byte).
//
// Exit codes:
//   0  success; `check` found nothing drifted or missing
//   1  `check` found DRIFT or MISSING; `install` refused the source layout
//      (a deployment answer, printed with a per-problem reason)
//   2  usage error, or `check` was pointed at a tree that is not the integration
// Nothing here runs in the background.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
	KNOWN_FILES,
	SOURCE_ROOT,
	classifyDeployment,
	discoverExtensionModules,
	readBytes,
	resolveBackupRoot,
	resolveTarget,
	sha256File,
	timestampSlug,
	validateSourceLayout,
	writeFileAtomic,
	removeFile,
} from "./omp-integration/lib.mjs";

const USAGE = `usage: node scripts/install-omp-integration.mjs [install|check|uninstall] [options]

  install     copy the integration into the extension directory (default), preserving
              any differing file that is already there
  check       compare the repository source against the deployed bytes and report
              MATCH / EQUIVALENT / DRIFT / MISSING per file
  uninstall   restore the newest backup of each deployed file, or remove it when
              there is no backup

options:
  --target <dir>        default: $OMP_EXTENSIONS_DIR, else ~/.omp/agent/extensions
  --source <dir>        default: integrations/omp/extensions
  --backup-root <dir>   default: <parent of target>/omp-integration-backups
  --dry-run             print the plan and change nothing
  --strict-bytes        check: treat EQUIVALENT (redacted identifier) as not matching
  --json                emit a JSON report instead of text
  -h, --help            this text
`;

function parseArgs(argv) {
	const opts = {
		command: "install",
		target: undefined,
		source: undefined,
		backupRoot: undefined,
		dryRun: false,
		strictBytes: false,
		json: false,
		help: false,
	};
	const commands = new Set(["install", "check", "uninstall"]);
	const rest = [...argv];
	while (rest.length > 0) {
		const arg = rest.shift();
		if (commands.has(arg)) {
			opts.command = arg;
			continue;
		}
		switch (arg) {
			case "--target":
				opts.target = rest.shift();
				break;
			case "--source":
				opts.source = rest.shift();
				break;
			case "--backup-root":
				opts.backupRoot = rest.shift();
				break;
			case "--dry-run":
				opts.dryRun = true;
				break;
			case "--strict-bytes":
				opts.strictBytes = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			default:
				throw new Error(`unknown argument: ${arg}`);
		}
	}
	return opts;
}

function fail(message, code = 2) {
	process.stderr.write(`install-omp-integration: ${message}\n`);
	return code;
}

/** True when `path` exists and is not a directory (a file, symlink or other). */
function targetIsNotDirectory(path) {
	if (!existsSync(path)) return false;
	try {
		return !statSync(path).isDirectory();
	} catch {
		return true;
	}
}

// ── check ───────────────────────────────────────────────────────────────────

/**
 * Compare every known file. Returns the report and whether it is acceptable,
 * where `EQUIVALENT` counts as acceptable unless `strictBytes` is set.
 */
export function checkIntegration({ source, target, strictBytes = false }) {
	const files = [];
	for (const rel of KNOWN_FILES) {
		const src = join(source, rel);
		const dest = join(target, rel);
		if (!existsSync(dest)) {
			files.push({ file: rel, state: "MISSING", publishedSha256: sha256File(src), deployedSha256: null });
			continue;
		}
		const published = readBytes(src);
		const deployed = readBytes(dest);
		const { state, redacted } = classifyDeployment(published, deployed);
		files.push({
			file: rel,
			state,
			redactedIdentifiers: redacted,
			publishedSha256: sha256File(src),
			deployedSha256: sha256File(dest),
		});
	}

	const counts = { MATCH: 0, EQUIVALENT: 0, DRIFT: 0, MISSING: 0 };
	for (const entry of files) counts[entry.state] += 1;

	const acceptable = f => f.state === "MATCH" || (!strictBytes && f.state === "EQUIVALENT");
	const ok = files.every(acceptable);
	const verdict = ok ? (counts.EQUIVALENT > 0 ? "EQ" : "MATCH") : counts.MISSING > 0 ? "MISSING" : "DRIFT";
	return { files, counts, ok, verdict, strictBytes, source, target };
}

function renderCheck(report) {
	const lines = [];
	lines.push("OMP_INTEGRATION_DRIFT_CHECK");
	lines.push(`source = ${report.source}`);
	lines.push(`target = ${report.target}`);
	const width = Math.max(...KNOWN_FILES.map(f => f.length));
	for (const entry of report.files) {
		const note = entry.state === "EQUIVALENT" ? `  (${entry.redactedIdentifiers} redacted identifier)` : "";
		lines.push(`  ${entry.file.padEnd(width)}  ${entry.state.padEnd(10)}${note}`);
	}
	lines.push(
		`MATCH=${report.counts.MATCH} EQUIVALENT=${report.counts.EQUIVALENT} ` +
			`DRIFT=${report.counts.DRIFT} MISSING=${report.counts.MISSING}`,
	);
	lines.push(`DRIFT_CHECK=${report.ok ? "MATCH" : report.verdict}`);
	return lines.join("\n");
}

// ── install ─────────────────────────────────────────────────────────────────

function installIntegration({ source, target, backupRoot, dryRun }) {
	const layout = validateSourceLayout(source);
	if (!layout.ok) {
		return { ok: false, problems: layout.problems };
	}

	const stamp = timestampSlug();
	const actions = [];
	for (const rel of KNOWN_FILES) {
		const src = join(source, rel);
		const dest = join(target, rel);
		if (!existsSync(dest)) {
			actions.push({ file: rel, action: "copy", backup: null });
			if (!dryRun) writeFileAtomic(dest, readBytes(src));
			continue;
		}
		const same = sha256File(src) === sha256File(dest);
		if (same) {
			actions.push({ file: rel, action: "unchanged", backup: null });
			continue;
		}
		const backup = join(backupRoot, stamp, rel);
		actions.push({ file: rel, action: "replace", backup });
		if (!dryRun) {
			writeFileAtomic(backup, readBytes(dest));
			writeFileAtomic(dest, readBytes(src));
		}
	}

	const discovered = discoverExtensionModules(target);
	return {
		ok: true,
		actions,
		dryRun,
		backupRoot: actions.some(a => a.backup) ? join(backupRoot, stamp) : null,
		loadedModules: discovered.modules,
		loadedManifests: discovered.manifests,
		ignoredSourceFiles: layout.ignored,
	};
}

// ── uninstall ───────────────────────────────────────────────────────────────

/** Newest backup directory (by sortable timestamp name) that holds any known file, or null. */
function newestBackupDir(backupRoot) {
	let names;
	try {
		names = readdirSync(backupRoot).filter(name => {
			try {
				return statSync(join(backupRoot, name)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch {
		return null;
	}
	// Timestamp slugs sort lexicographically in chronological order.
	names.sort();
	for (let i = names.length - 1; i >= 0; i -= 1) {
		const dir = join(backupRoot, names[i]);
		if (KNOWN_FILES.some(rel => existsSync(join(dir, rel)))) return dir;
	}
	return null;
}

function uninstallIntegration({ target, backupRoot, dryRun }) {
	const stamp = newestBackupDir(backupRoot);
	const actions = [];
	for (const rel of KNOWN_FILES) {
		const dest = join(target, rel);
		const backup = stamp ? join(stamp, rel) : null;
		if (backup && existsSync(backup)) {
			actions.push({ file: rel, action: "restore", from: backup });
			if (!dryRun) writeFileAtomic(dest, readBytes(backup));
			continue;
		}
		if (!existsSync(dest)) {
			actions.push({ file: rel, action: "absent" });
			continue;
		}
		actions.push({ file: rel, action: "remove" });
		if (!dryRun) removeFile(dest);
	}
	return { ok: true, actions, backupUsed: stamp, dryRun };
}

// ── main ────────────────────────────────────────────────────────────────────

function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (error) {
		return fail(`${error.message}\n\n${USAGE}`);
	}
	if (opts.help) {
		process.stdout.write(USAGE);
		return 0;
	}

	const source = opts.source ? opts.source : SOURCE_ROOT;
	const target = resolveTarget(opts.target);
	const backupRoot = resolveBackupRoot(target, opts.backupRoot);

	if (opts.command === "install") {
		if (targetIsNotDirectory(target)) {
			return fail(`REFUSED — target exists but is not a directory: ${target}\n  nothing was copied.`);
		}
		const layout = validateSourceLayout(source);
		if (!layout.ok) {
			process.stderr.write(`install-omp-integration: REFUSED — unexpected source layout\n`);
			for (const problem of layout.problems) process.stderr.write(`  ${problem}\n`);
			process.stderr.write(`  nothing was copied; target untouched: ${target}\n`);
			return 1;
		}
		const result = installIntegration({ source, target, backupRoot, dryRun: opts.dryRun });
		const check = checkIntegration({ source, target, strictBytes: opts.strictBytes });
		if (opts.json) {
			process.stdout.write(`${JSON.stringify({ command: "install", target, backupRoot, ...result, check }, null, 2)}\n`);
		} else {
			process.stdout.write(`OMP_INTEGRATION_INSTALL${opts.dryRun ? " (dry run)" : ""}\n`);
			process.stdout.write(`source = ${source}\ntarget = ${target}\n`);
			for (const action of result.actions) {
				process.stdout.write(
					`  ${action.action.padEnd(9)} ${action.file}${action.backup ? `  -> backup ${action.backup}` : ""}\n`,
				);
			}
			if (result.backupRoot) process.stdout.write(`backup = ${result.backupRoot}\n`);
			process.stdout.write(`discovered extension modules = ${JSON.stringify(result.loadedModules)}\n`);
			process.stdout.write(`${renderCheck(check)}\n`);
			process.stdout.write(
				result.actions.every(a => a.action === "unchanged")
					? "INSTALL_RESULT = UP_TO_DATE\n"
					: "INSTALL_RESULT = INSTALLED\n",
			);
		}
		return check.ok ? 0 : 1;
	}

	if (opts.command === "check") {
		if (targetIsNotDirectory(target)) {
			return fail(`target exists but is not a directory: ${target}`);
		}
		const layout = validateSourceLayout(source);
		if (!layout.ok) {
			process.stderr.write(`install-omp-integration: cannot check against this source tree\n`);
			for (const problem of layout.problems) process.stderr.write(`  ${problem}\n`);
			return 2;
		}
		const report = checkIntegration({ source, target, strictBytes: opts.strictBytes });
		if (opts.json) process.stdout.write(`${JSON.stringify({ command: "check", ...report }, null, 2)}\n`);
		else process.stdout.write(`${renderCheck(report)}\n`);
		return report.ok ? 0 : 1;
	}

	if (opts.command === "uninstall") {
		if (targetIsNotDirectory(target)) {
			return fail(`target exists but is not a directory: ${target}\n  nothing to uninstall.`);
		}
		const result = uninstallIntegration({ target, backupRoot, dryRun: opts.dryRun });
		if (opts.json) process.stdout.write(`${JSON.stringify({ command: "uninstall", target, ...result }, null, 2)}\n`);
		else {
			process.stdout.write(`OMP_INTEGRATION_UNINSTALL${opts.dryRun ? " (dry run)" : ""}\ntarget = ${target}\n`);
			for (const action of result.actions) {
				process.stdout.write(`  ${action.action.padEnd(8)} ${action.file}${action.from ? `  <- ${action.from}` : ""}\n`);
			}
			process.stdout.write(`UNINSTALL_RESULT = ${result.backupUsed ? "RESTORED" : "REMOVED"}\n`);
		}
		return 0;
	}

	return fail(`unknown command: ${opts.command}\n\n${USAGE}`);
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}

export { main as runInstaller };
