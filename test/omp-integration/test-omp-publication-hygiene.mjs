// test/omp-integration/test-omp-publication-hygiene.mjs
//
// Guards the publication delta of the OMP integration:
//
//   * no credential-shaped material, home-directory paths or personal
//     identifiers in `integrations/omp/**`, `scripts/install-omp-integration.mjs`
//     or `scripts/omp-integration/**`;
//   * the frozen deployment surface stays frozen (exactly the known files, and
//     a source layout the installer will accept).
//
// The scan gets a negative control: the same scanner is pointed at a fixture
// that contains all three classes, so a scan that cannot fail is not mistaken
// for a scan that passed.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KNOWN_FILES, REPO_ROOT, SOURCE_ROOT, validateSourceLayout, walkFiles } from "../../scripts/omp-integration/lib.mjs";
import { scanPublication } from "../../scripts/omp-integration/scan-publication.mjs";

const SCANNED_PATHS = [
	join(REPO_ROOT, "integrations", "omp"),
	join(REPO_ROOT, "scripts", "install-omp-integration.mjs"),
	join(REPO_ROOT, "scripts", "omp-integration"),
	join(REPO_ROOT, "test", "omp-integration"),
];

test("the publication delta carries no secrets, private paths or identifiers", () => {
	const report = scanPublication(SCANNED_PATHS);
	const detail = report.findings.map(f => `  ${f.category} ${f.file}:${f.line} [${f.label}]`).join("\n");
	assert.equal(report.counts.REAL_SECRETS, 0, `REAL_SECRETS must be 0\n${detail}`);
	assert.equal(report.counts.PRIVATE_PATHS, 0, `PRIVATE_PATHS must be 0\n${detail}`);
	assert.equal(report.counts.PERSONAL_IDENTIFIERS, 0, `PERSONAL_IDENTIFIERS must be 0\n${detail}`);
	assert.ok(report.files >= KNOWN_FILES.length, "the scan must actually have read the integration");
});

test("the scanner detects all three classes (negative control)", () => {
	const root = mkdtempSync(join(tmpdir(), "omp-scan-control-"));
	try {
		mkdirSync(join(root, "nested"), { recursive: true });
		// Every planted value is assembled from fragments, so this file is not
		// itself a hit for the patterns it is testing.
		const planted = [
			`token = "${["sk", "A".repeat(24)].join("-")}"`,
			`home = ${["", "Users", "someone", ".omp", "agent", "extensions"].join("/")}`,
			`session = ${["01234567", "89ab", "cdef", "0123", "456789abcdef"].join("-")}`,
			`contact = ${["someone", "example.com"].join("@")}`,
		].join("\n");
		writeFileSync(join(root, "nested", "planted.txt"), `${planted}\n`);

		const report = scanPublication([root]);
		assert.equal(report.counts.REAL_SECRETS, 1, JSON.stringify(report.findings));
		assert.equal(report.counts.PRIVATE_PATHS, 1, JSON.stringify(report.findings));
		assert.equal(report.counts.PERSONAL_IDENTIFIERS, 2, JSON.stringify(report.findings));
		assert.equal(report.ok, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the published deployment surface is frozen and installable", () => {
	const layout = validateSourceLayout(SOURCE_ROOT);
	assert.deepEqual(layout.problems, [], "the source tree must be exactly the reviewed set");
	assert.deepEqual(layout.ignored, [], "no unreviewed extra files may sit in the source tree");
	assert.deepEqual(walkFiles(SOURCE_ROOT), [...KNOWN_FILES].sort());
});
