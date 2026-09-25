// test/omp-integration/test-omp-integration-installer.mjs
//
// Installer + drift-check acceptance for the optional OMP integration.
//
// Every case runs the real CLI (`scripts/install-omp-integration.mjs`) as a
// child process against a throwaway HOME-like directory, so nothing here reads
// or writes the developer's real `~/.omp`.
//
// Covered: clean install, extension discovery, the deployed policy self-test,
// idempotent update, DRIFT, MISSING, equivalent-after-redaction, refusal of an
// unexpected source layout, backup of a conflicting deployment, confinement
// (an unreadable `models.yml` next to the target must not be touched), and an
// uninstall that restores the backup without disturbing unrelated extensions.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWN_FILES, REPO_ROOT, SOURCE_ROOT, discoverExtensionModules, sha256File, walkFiles } from "../../scripts/omp-integration/lib.mjs";

const INSTALLER = join(REPO_ROOT, "scripts", "install-omp-integration.mjs");
const ID_TOKEN = "<session-id-redacted>";
/**
 * A synthetic identifier, assembled from fragments so that this source file is
 * not itself identifier-shaped: it proves the equivalence rule without
 * publishing a real identifier.
 */
const SYNTHETIC_ID = ["aabbccdd", "1122", "3344", "5566", "778899aabbcc"].join("-");

function runInstaller(args) {
	const result = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: "utf8" });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function runInstallerJson(args) {
	const result = runInstaller([...args, "--json"]);
	let json = null;
	if (result.stdout.trim()) {
		try {
			json = JSON.parse(result.stdout);
		} catch {
			json = null;
		}
	}
	return { ...result, json };
}

/** A throwaway `~`: `<tmp>/agent/extensions`, with `<tmp>/agent` as its config dir. */
function makeHome() {
	const root = mkdtempSync(join(tmpdir(), "omp-installer-test-"));
	const agentDir = join(root, "agent");
	const target = join(agentDir, "extensions");
	mkdirSync(target, { recursive: true });
	return { root, agentDir, target, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A mutable copy of the published source tree. */
function makeSource(mutate) {
	const parent = mkdtempSync(join(tmpdir(), "omp-source-test-"));
	const source = join(parent, "extensions");
	cpSync(SOURCE_ROOT, source, { recursive: true });
	if (mutate) mutate(source);
	return { source, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function install(home, extra = []) {
	return runInstallerJson(["install", "--target", home.target, ...extra]);
}

test("clean install deploys exactly the known files with the repository's bytes", () => {
	const home = makeHome();
	try {
		const result = install(home);
		assert.equal(result.status, 0, result.stderr);
		for (const rel of KNOWN_FILES) {
			const deployed = join(home.target, rel);
			assert.ok(existsSync(deployed), `not deployed: ${rel}`);
			assert.equal(sha256File(deployed), sha256File(join(SOURCE_ROOT, rel)), `bytes differ: ${rel}`);
		}
		assert.deepEqual(walkFiles(home.target), [...KNOWN_FILES].sort(), "the deployment must be exactly the known set");
	} finally {
		home.cleanup();
	}
});

test("the deployed tree resolves to exactly one extension module", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);
		const discovered = discoverExtensionModules(home.target);
		assert.deepEqual(discovered.modules, ["no-poll-waits.js"], "OMP must load exactly one extension module");
		assert.deepEqual(discovered.manifests, [], "no directory may present an extension manifest");
	} finally {
		home.cleanup();
	}
});

test("the deployed copy passes its own policy self-test", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);
		const probe = spawnSync(process.execPath, [join(home.target, "test", "poll-wait-policy.test.mjs")], {
			cwd: home.target,
			encoding: "utf8",
		});
		assert.equal(probe.status, 0, `deployed self-test failed:\n${probe.stdout}${probe.stderr}`);
		assert.match(probe.stdout, /fail=0\b/);
	} finally {
		home.cleanup();
	}
});

test("re-installing over an identical deployment changes nothing and creates no backup", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);
		const second = install(home);
		assert.equal(second.status, 0, second.stderr);
		assert.ok(
			second.json.actions.every(a => a.action === "unchanged"),
			`expected every file to be unchanged: ${JSON.stringify(second.json.actions)}`,
		);
		assert.equal(second.json.backupRoot, null);
		assert.ok(!existsSync(join(home.agentDir, "omp-integration-backups")), "no backup should have been written");
	} finally {
		home.cleanup();
	}
});

test("drift check reports MATCH, then DRIFT after a byte changes, then MISSING after a delete", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);

		const clean = runInstallerJson(["check", "--target", home.target]);
		assert.equal(clean.status, 0);
		assert.equal(clean.json.verdict, "MATCH");
		assert.equal(clean.json.counts.MATCH, KNOWN_FILES.length);

		const victim = join(home.target, "lib", "poll-wait-policy.js");
		writeFileSync(victim, `${readFileSync(victim, "utf8")}\n// tampered\n`);
		const drifted = runInstallerJson(["check", "--target", home.target]);
		assert.equal(drifted.status, 1, "drift must fail the check");
		assert.equal(drifted.json.verdict, "DRIFT");
		assert.equal(drifted.json.files.find(f => f.file === "lib/poll-wait-policy.js").state, "DRIFT");

		rmSync(join(home.target, "test", "waiter-fence.acceptance.ts"));
		const missing = runInstallerJson(["check", "--target", home.target]);
		assert.equal(missing.status, 1);
		assert.equal(missing.json.verdict, "MISSING");
		assert.equal(missing.json.files.find(f => f.file === "test/waiter-fence.acceptance.ts").state, "MISSING");
	} finally {
		home.cleanup();
	}
});

test("a deployment that differs only by a redacted identifier is EQUIVALENT, not DRIFT", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);
		const deployed = KNOWN_FILES[0];
		const published = readFileSync(join(SOURCE_ROOT, deployed), "utf8");
		assert.ok(published.includes(ID_TOKEN), "the published source must carry the redaction token");
		// Reconstruct the pre-publication bytes: token -> identifier of the same shape.
		writeFileSync(join(home.target, deployed), published.split(ID_TOKEN).join(SYNTHETIC_ID));

		const relaxed = runInstallerJson(["check", "--target", home.target]);
		assert.equal(relaxed.status, 0, "an identifier-only difference is source-equivalent");
		assert.equal(relaxed.json.verdict, "EQ");
		const entry = relaxed.json.files.find(f => f.file === deployed);
		assert.equal(entry.state, "EQUIVALENT");
		assert.equal(entry.redactedIdentifiers, 1);
		assert.notEqual(entry.publishedSha256, entry.deployedSha256, "the bytes really do differ");

		const strict = runInstallerJson(["check", "--target", home.target, "--strict-bytes"]);
		assert.equal(strict.status, 1, "--strict-bytes must reject an equivalent-but-not-identical file");
	} finally {
		home.cleanup();
	}
});

test("an identifier-only difference does not hide a real edit", () => {
	const home = makeHome();
	try {
		assert.equal(install(home).status, 0);
		const deployed = KNOWN_FILES[0];
		const published = readFileSync(join(SOURCE_ROOT, deployed), "utf8");
		writeFileSync(join(home.target, deployed), `${published.split(ID_TOKEN).join(SYNTHETIC_ID)}\n// extra\n`);
		const report = runInstallerJson(["check", "--target", home.target]);
		assert.equal(report.status, 1);
		assert.equal(report.json.files.find(f => f.file === deployed).state, "DRIFT");
	} finally {
		home.cleanup();
	}
});

test("an unexpected source layout is refused and nothing is copied", () => {
	const cases = [
		["an extra executable file", source => writeFileSync(join(source, "lib", "sneaky.js"), "export const x = 1;\n")],
		["a discovery alias", source => writeFileSync(join(source, "lib", "index.js"), "export default function () {}\n")],
		["a missing known file", source => rmSync(join(source, "lib", "poll-wait-policy.js"))],
	];
	for (const [label, mutate] of cases) {
		const home = makeHome();
		const source = makeSource(mutate);
		try {
			const result = runInstallerJson(["install", "--target", home.target, "--source", source.source]);
			assert.equal(result.status, 1, `${label} must be refused`);
			assert.match(result.stderr, /REFUSED/, `${label}: expected a refusal on stderr`);
			assert.deepEqual(walkFiles(home.target), [], `${label}: the target must be untouched`);
		} finally {
			home.cleanup();
			source.cleanup();
		}
	}
});

test("a conflicting deployment is preserved byte-for-byte before it is replaced", () => {
	const home = makeHome();
	try {
		const rel = "no-poll-waits.js";
		const existing = "// a deliberately different, pre-existing deployment\n";
		writeFileSync(join(home.target, rel), existing);

		const result = install(home);
		assert.equal(result.status, 0, result.stderr);
		const replaced = result.json.actions.find(a => a.file === rel);
		assert.equal(replaced.action, "replace");
		assert.equal(sha256File(join(home.target, rel)), sha256File(join(SOURCE_ROOT, rel)));
		assert.equal(readFileSync(replaced.backup, "utf8"), existing, "the previous deployment must be preserved verbatim");

		const uninstall = runInstallerJson(["uninstall", "--target", home.target]);
		assert.equal(uninstall.status, 0, uninstall.stderr);
		assert.equal(uninstall.json.backupUsed, result.json.backupRoot);
		assert.equal(readFileSync(join(home.target, rel), "utf8"), existing, "uninstall must restore the previous deployment");
		for (const other of KNOWN_FILES.filter(f => f !== rel)) {
			assert.ok(!existsSync(join(home.target, other)), `uninstall left ${other} behind with no backup to restore`);
		}
	} finally {
		home.cleanup();
	}
});

test("installation is confined: secrets and unrelated extensions are untouched", () => {
	const home = makeHome();
	try {
		const models = join(home.agentDir, "models.yml");
		const unrelated = join(home.target, "orca-agent-status.ts");
		writeFileSync(models, `providers:\n  canary: ${["sk", "not-a-real-key-canary-value"].join("-")}\n`);
		writeFileSync(unrelated, "export default function () {}\n");
		const modelsDigest = sha256File(models);
		const unrelatedDigest = sha256File(unrelated);

		// An unreadable config file would make a reading installer fail outright.
		chmodSync(models, 0o000);
		const result = install(home);
		chmodSync(models, 0o600);

		assert.equal(result.status, 0, `install must not depend on reading the config dir: ${result.stderr}`);
		assert.equal(sha256File(models), modelsDigest, "models.yml must not be modified");
		assert.equal(sha256File(unrelated), unrelatedDigest, "an unrelated extension must not be modified");
		assert.equal(
			walkFiles(home.target).includes("orca-agent-status.ts"),
			true,
			"the unrelated extension must still be there",
		);

		const backups = join(home.agentDir, "omp-integration-backups");
		if (existsSync(backups)) {
			for (const rel of walkFiles(backups)) {
				const stripped = rel.replace(/^[^/]+\//, "");
				assert.ok(KNOWN_FILES.includes(stripped), `backup tree holds a non-integration file: ${rel}`);
			}
		}
	} finally {
		home.cleanup();
	}
});

test("with no --target, the integration lands in the invoking HOME", () => {
	const home = makeHome();
	try {
		// A "clean HOME" install: the destination is derived from $HOME, not from
		// any state on the machine running the test. OMP_EXTENSIONS_DIR is cleared
		// so the default path is the one under test.
		const env = { ...process.env, HOME: home.root, OMP_EXTENSIONS_DIR: "" };
		const result = spawnSync(process.execPath, [INSTALLER, "install", "--json"], { encoding: "utf8", env });
		assert.equal(result.status, 0, result.stderr);
		const expected = join(home.root, ".omp", "agent", "extensions");
		const report = JSON.parse(result.stdout);
		assert.equal(report.target, expected);
		for (const rel of KNOWN_FILES) {
			assert.ok(existsSync(join(expected, rel)), `not deployed under HOME: ${rel}`);
		}
		const check = spawnSync(process.execPath, [INSTALLER, "check", "--json"], { encoding: "utf8", env });
		assert.equal(check.status, 0, check.stderr);
		assert.equal(JSON.parse(check.stdout).verdict, "MATCH");
	} finally {
		home.cleanup();
	}
});

test("a target that is not a directory is refused, not crashed into", () => {
	const home = makeHome();
	const file = join(home.root, "not-a-directory");
	writeFileSync(file, "I am a file\n");
	try {
		for (const command of ["install", "check", "uninstall"]) {
			const result = runInstaller([command, "--target", file]);
			assert.equal(result.status, 2, `${command}: expected a clean refusal, got ${result.status}`);
			assert.doesNotMatch(result.stderr, /^\s+at /m, `${command}: must not print a stack trace`);
			assert.match(result.stderr, /not a directory/, `${command}: the refusal must name the problem`);
		}
		assert.equal(readFileSync(file, "utf8"), "I am a file\n", "the file must be untouched");
	} finally {
		home.cleanup();
	}
});

test("--dry-run reports the plan without changing anything", () => {
	const home = makeHome();
	try {
		const result = install(home, ["--dry-run"]);
		assert.equal(result.json.dryRun, true);
		assert.deepEqual(walkFiles(home.target), [], "--dry-run must not copy anything");
	} finally {
		home.cleanup();
	}
});
