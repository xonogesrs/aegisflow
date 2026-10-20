// test/omp-integration/test-omp-rollback.mjs
//
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — rollback must
// be EXACT and REVERSIBLE, not merely plausible.
//
// Measured before this existed: `uninstall` left an inconsistent tree. It
// restored the replaced `no-poll-waits.js` from backup and REMOVED
// `lib/poll-wait-policy.js`, because that file was byte-identical at install time
// and therefore had no backup. The restored extension imports the removed file,
// so the runtime could not load it. `uninstall` answers "remove this integration";
// a rollback must answer "put the target back exactly as it was".
//
// Run: node --test test/omp-integration/test-omp-rollback.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { KNOWN_FILES, sha256File } from "../../scripts/omp-integration/lib.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALLER = join(REPO_ROOT, "scripts", "install-omp-integration.mjs");
const ROLLBACK = join(REPO_ROOT, "scripts", "omp-rollback-integration.mjs");
const SOURCE_ROOT = join(REPO_ROOT, "integrations", "omp", "extensions");

function run(script, args) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

/**
 * A target holding the PREVIOUS release: the shipped bytes with the new module
 * and test file removed, so the install has something real to replace.
 */
function makePreCardTarget(root) {
	const target = join(root, "target");
	mkdirSync(target, { recursive: true });
	cpSync(SOURCE_ROOT, target, { recursive: true });
	for (const rel of ["lib/controller-result.mjs", "lib/runtime-identity.mjs", "test/controller-contract.acceptance.ts"]) {
		rmSync(join(target, rel), { force: true });
	}
	// Pretend the deployed extension is the previous revision, byte for byte.
	writeFileSync(join(target, "no-poll-waits.js"), "// previous release\n", "utf8");
	return target;
}

function snapshot(target) {
	const out = {};
	for (const rel of KNOWN_FILES) {
		const abs = join(target, rel);
		out[rel] = existsSync(abs) ? sha256File(abs) : null;
	}
	return out;
}

test("rollback restores the target byte-for-byte, including files with no backup", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-"));
	try {
		const target = makePreCardTarget(root);
		const before = snapshot(target);

		const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
		assert.equal(install.status, 0, install.stderr);
		const record = JSON.parse(install.stdout);
		assert.equal(record.target, target);
		const installed = snapshot(target);
		assert.notDeepEqual(installed, before, "the install must have changed the target");

		const rollback = run(ROLLBACK, [join(root, "record.json")]);
		// The record was not written to disk by the installer; write and retry so
		// the test exercises the real file-based contract.
		assert.notEqual(rollback.status, 0, "a missing record must be refused");
		writeFileSync(join(root, "record.json"), JSON.stringify(record), "utf8");

		const applied = run(ROLLBACK, [join(root, "record.json")]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.match(applied.stdout, /ROLLBACK_RESULT = APPLIED/);

		const restored = snapshot(target);
		assert.deepEqual(restored, before, "every deployed file must return to its pre-install bytes or absence");

		// The specific defect `uninstall` produced: a restored extension whose
		// import is gone. Assert the dependency is still present.
		assert.equal(existsSync(join(target, "lib/poll-wait-policy.js")), true);
		assert.equal(existsSync(join(target, "lib/controller-result.mjs")), false);
		assert.equal(existsSync(join(target, "lib/runtime-identity.mjs")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback removes the directories the install created and leaves others", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-dirs-"));
	try {
		const target = makePreCardTarget(root);
		// `lib/` survives (it holds a pre-existing file); a fresh dir would not.
		const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
		assert.equal(install.status, 0, install.stderr);
		writeFileSync(join(root, "record.json"), install.stdout, "utf8");

		const applied = run(ROLLBACK, [join(root, "record.json")]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(existsSync(join(target, "lib")), true, "a directory that still holds a file must remain");
		assert.ok(
			readdirSync(join(target, "lib")).includes("poll-wait-policy.js"),
			"the pre-existing library file must remain",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback refuses when the installed file was edited after the install", () => {
	// Measured in review: a rollback deleted a post-install edit and reported
	// APPLIED. The install record names the bytes it wrote, so a mismatch is a
	// refusal, not a discard.
	for (const rel of ["lib/runtime-identity.mjs", "no-poll-waits.js"]) {
		const root = mkdtempSync(join(tmpdir(), "omp-rollback-edited-"));
		try {
			const target = makePreCardTarget(root);
			const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
			assert.equal(install.status, 0, install.stderr);
			writeFileSync(join(root, "record.json"), install.stdout, "utf8");

			// An operator edit made after the install.
			writeFileSync(join(target, rel), "// operator edit after install\n", "utf8");
			const before = snapshot(target);

			const applied = run(ROLLBACK, [join(root, "record.json")]);
			assert.equal(applied.status, 1, `${rel}: a post-install edit must be refused`);
			assert.match(applied.stderr, /changed after the install/);
			assert.deepEqual(snapshot(target), before, `${rel}: a refusal must not change anything`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("rollback prunes only the directories the install recorded creating", () => {
	// Measured in review: pre-existing empty `lib/` and `test/` were removed,
	// because ownership was inferred from deleted files instead of recorded.
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-preexisting-"));
	try {
		const target = join(root, "target");
		mkdirSync(join(target, "lib"), { recursive: true });
		mkdirSync(join(target, "test"), { recursive: true });
		// Both directories are empty and pre-existing: the install creates the
		// FILES inside them, never the directories themselves.

		const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
		assert.equal(install.status, 0, install.stderr);
		const record = JSON.parse(install.stdout);
		assert.deepEqual(record.createdDirectories, [], "no directory may be recorded as created here");
		writeFileSync(join(root, "record.json"), JSON.stringify(record), "utf8");

		const applied = run(ROLLBACK, [join(root, "record.json")]);
		assert.equal(applied.status, 0, applied.stderr);
		assert.equal(existsSync(join(target, "lib")), true, "a pre-existing empty lib/ must survive");
		assert.equal(existsSync(join(target, "test")), true, "a pre-existing empty test/ must survive");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback refuses a record whose target no longer matches, and changes nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-refuse-"));
	try {
		const target = makePreCardTarget(root);
		const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
		assert.equal(install.status, 0, install.stderr);
		const record = JSON.parse(install.stdout);
		writeFileSync(join(root, "record.json"), JSON.stringify(record), "utf8");

		// Delete a file the install created: the record says "copy", the target
		// says absent. A rollback cannot verify what it is reversing.
		rmSync(join(target, "lib/runtime-identity.mjs"));
		const snapshotBefore = snapshot(target);

		const applied = run(ROLLBACK, [join(root, "record.json")]);
		assert.equal(applied.status, 1, "an inconsistent target must be refused");
		assert.match(applied.stderr, /REFUSED/);
		assert.deepEqual(snapshot(target), snapshotBefore, "a refusal must not change anything");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rollback refuses a record naming a file outside the deployment set", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-scope-"));
	try {
		const target = join(root, "target");
		mkdirSync(target, { recursive: true });
		const record = {
			command: "install",
			target,
			actions: [{ file: "../../etc/passwd", action: "copy", backup: null }],
		};
		writeFileSync(join(root, "record.json"), JSON.stringify(record), "utf8");
		const applied = run(ROLLBACK, [join(root, "record.json")]);
		assert.equal(applied.status, 1);
		assert.match(applied.stderr, /outside the deployment set/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a dry run reports the plan and changes nothing", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-rollback-dry-"));
	try {
		const target = makePreCardTarget(root);
		const install = run(INSTALLER, ["install", "--target", target, "--backup-root", join(root, "backups"), "--json"]);
		assert.equal(install.status, 0, install.stderr);
		writeFileSync(join(root, "record.json"), install.stdout, "utf8");
		const installed = snapshot(target);

		const planned = run(ROLLBACK, [join(root, "record.json"), "--dry-run"]);
		assert.equal(planned.status, 0, planned.stderr);
		assert.match(planned.stdout, /ROLLBACK_RESULT = PLANNED/);
		assert.deepEqual(snapshot(target), installed, "a dry run must not touch the target");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
