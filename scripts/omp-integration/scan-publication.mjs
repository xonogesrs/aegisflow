#!/usr/bin/env node
// scripts/omp-integration/scan-publication.mjs
//
// Publication hygiene scan for the OMP integration delta.
//
// Reports three counts and fails when any is non-zero:
//
//   REAL_SECRETS         credential-shaped material (provider keys, GitHub/SSH
//                        tokens, PEM blocks, bearer tokens, `api_key = "…"`)
//   PRIVATE_PATHS        a path rooted in somebody's home directory
//                        (`/Users/<name>`, `/Volumes/<name>`, `/home/<name>`,
//                        `C:\Users\<name>`)
//   PERSONAL_IDENTIFIERS UUIDs and e-mail addresses
//
// Usage:
//   node scripts/omp-integration/scan-publication.mjs [path ...]
//   node scripts/omp-integration/scan-publication.mjs --json
//
// Default paths: integrations/omp, scripts/install-omp-integration.mjs and
// scripts/omp-integration. The integration ships no scanner bypass list — the
// patterns are written so that this file does not match itself, which the test
// suite asserts by scanning this directory with this scanner.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, walkFiles } from "./lib.mjs";

const DEFAULT_PATHS = [
	"integrations/omp",
	"scripts/install-omp-integration.mjs",
	"scripts/omp-integration",
	"test/omp-integration",
];

// Patterns are (label, RegExp). The PEM and bearer patterns are assembled from
// fragments so that this source file cannot match them.
const SECRET_PATTERNS = [
	["provider key (sk-…)", /\bsk-[A-Za-z0-9_-]{16,}/],
	["provider key (AIza…)", /\bAIza[0-9A-Za-z_-]{30,}/],
	["github token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
	["slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
	["aws access key id", /\bAKIA[0-9A-Z]{16}\b/],
	["private key block", new RegExp(`-----BEGIN [A-Z ]*PRIVATE${" KEY-----"}`)],
	["bearer token", new RegExp(`${"Bear"}er\\s+[A-Za-z0-9._-]{20,}`)],
	[
		"credential assignment",
		/(api[_-]?key|apikey|secret|token|password|passwd|credential)\s*[:=]\s*["'][A-Za-z0-9_\-./+]{16,}["']/i,
	],
	["merge-gateway key marker", /MERGE_GATEWAY_API_KEY\s*[:=]\s*\S/],
];

const PRIVATE_PATH_PATTERNS = [
	["macOS user home", /\/Users\/[A-Za-z0-9._-]+/g],
	["mounted volume", /\/Volumes\/[A-Za-z0-9._-]+/g],
	["linux user home", /\/home\/[A-Za-z0-9._-]+/g],
	["windows user home", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g],
];

const PERSONAL_IDENTIFIER_PATTERNS = [
	["uuid / session id", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi],
	["e-mail address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g],
];

function collectFiles(paths) {
	const files = [];
	for (const path of paths) {
		const abs = resolve(path);
		if (!existsSync(abs)) continue;
		if (statSync(abs).isDirectory()) {
			for (const rel of walkFiles(abs)) files.push(join(abs, rel));
			continue;
		}
		files.push(abs);
	}
	return files;
}

/**
 * One finding per (category, line): several patterns can describe the same
 * match (`sk-…` is also a credential assignment), and a doubled count would
 * misreport how much of the file is affected.
 */
function scanFile(path) {
	const text = readFileSync(path, "utf8");
	const lines = text.split("\n");
	/** category -> lineNumber -> { labels: Set, excerpt } */
	const perCategory = new Map();

	const record = (category, label, lineNumber, excerpt) => {
		if (!perCategory.has(category)) perCategory.set(category, new Map());
		const byLine = perCategory.get(category);
		if (!byLine.has(lineNumber)) byLine.set(lineNumber, { labels: new Set(), excerpt: excerpt.trim().slice(0, 160) });
		byLine.get(lineNumber).labels.add(label);
	};

	const test = (patterns, category) => {
		for (const [label, re] of patterns) {
			lines.forEach((line, index) => {
				re.lastIndex = 0;
				if (re.test(line)) record(category, label, index + 1, line);
			});
		}
	};

	test(SECRET_PATTERNS, "REAL_SECRETS");
	test(PRIVATE_PATH_PATTERNS, "PRIVATE_PATHS");
	test(PERSONAL_IDENTIFIER_PATTERNS, "PERSONAL_IDENTIFIERS");

	const findings = [];
	for (const [category, byLine] of perCategory) {
		for (const [line, { labels, excerpt }] of byLine) {
			findings.push({ category, line, labels: [...labels], excerpt });
		}
	}
	return findings.sort((a, b) => a.line - b.line);
}

export function scanPublication(paths = DEFAULT_PATHS.map(p => join(REPO_ROOT, p))) {
	const files = collectFiles(paths);
	const findings = [];
	for (const file of files) findings.push(...scanFile(file).map(f => ({ ...f, file })));
	const counts = { REAL_SECRETS: 0, PRIVATE_PATHS: 0, PERSONAL_IDENTIFIERS: 0 };
	for (const finding of findings) counts[finding.category] += 1;
	return { files: files.length, counts, findings, ok: findings.length === 0 };
}

function main(argv) {
	const json = argv.includes("--json");
	const paths = argv.filter(a => !a.startsWith("--"));
	const report = scanPublication(paths.length > 0 ? paths : undefined);

	if (json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report.ok ? 0 : 1;
	}

	process.stdout.write("OMP_INTEGRATION_PUBLICATION_SCAN\n");
	process.stdout.write(`SCANNED_FILES=${report.files}\n`);
	process.stdout.write(`REAL_SECRETS=${report.counts.REAL_SECRETS}\n`);
	process.stdout.write(`PRIVATE_PATHS=${report.counts.PRIVATE_PATHS}\n`);
	process.stdout.write(`PERSONAL_IDENTIFIERS=${report.counts.PERSONAL_IDENTIFIERS}\n`);
	for (const finding of report.findings) {
		process.stdout.write(
			`  ${finding.category} ${finding.file}:${finding.line} [${finding.labels.join(", ")}] ${finding.excerpt}\n`,
		);
	}
	process.stdout.write(`PUBLICATION_SCAN=${report.ok ? "CLEAN" : "FINDINGS"}\n`);
	return report.ok ? 0 : 1;
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}
