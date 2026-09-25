// scripts/omp-integration/lib.mjs
//
// Shared logic for the OMP integration tooling:
//
//   scripts/install-omp-integration.mjs          install / update / drift check / uninstall
//   scripts/omp-integration/scan-publication.mjs publication hygiene scan
//   scripts/omp-integration/run-acceptance.mjs   bun acceptance runner
//
// Everything here is deliberately dependency-free plain Node: the installer is
// the thing a user runs on a fresh machine before any `npm install`, so it must
// not need one. There is no daemon, no watcher and no background state — every
// entry point is a one-shot process over files.

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INTEGRATION_ROOT = join(REPO_ROOT, "integrations", "omp");
export const SOURCE_ROOT = join(INTEGRATION_ROOT, "extensions");

/**
 * The complete set of files this integration deploys. The installer copies
 * exactly these and nothing else; the drift check compares exactly these; an
 * uninstall removes exactly these. Adding a file here is the only way to widen
 * the deployment surface, which is what makes "copy only known files" an
 * auditable property instead of a comment.
 */
export const KNOWN_FILES = Object.freeze([
	"no-poll-waits.js",
	"lib/poll-wait-policy.js",
	"test/poll-wait-policy.test.mjs",
	"test/waiter-fence.acceptance.ts",
	"test/terminal-fence-authority.acceptance.ts",
]);

/** Suffixes that make a file executable code (and therefore deployment-relevant). */
export const CODE_SUFFIXES = Object.freeze([".js", ".mjs", ".cjs", ".ts"]);

/**
 * Names OMP's extension discovery treats as load candidates. A file with one of
 * these names anywhere under the deployed tree would make the host load MORE
 * than the single reviewed extension, so the installer refuses such a layout
 * rather than reason about it. See `discoverExtensionModules` for the rule.
 */
export const DISCOVERY_ALIAS_NAMES = Object.freeze(["index.js", "index.ts", "package.json"]);

/** Filesystem litter that is neither source nor a layout error. */
const IGNORED_NAMES = Object.freeze([".DS_Store"]);

/** Environment variable OMP itself honours for the extension directory. */
export const TARGET_ENV = "OMP_EXTENSIONS_DIR";

/** Token the published source uses where a private identifier was redacted. */
export const ID_REDACTION_TOKEN = "<session-id-redacted>";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ── hashing / bytes ─────────────────────────────────────────────────────────

export function sha256Bytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
	return sha256Bytes(readFileSync(path));
}

export function readBytes(path) {
	return readFileSync(path);
}

/** True for a real file, false for a symlink (even a symlink that resolves). */
export function isRegularFile(path) {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function isIgnoredName(name) {
	return IGNORED_NAMES.includes(name);
}

/** Every file under `dir`, as paths relative to `dir`, sorted. Symlinks are not followed. */
export function walkFiles(dir, base = dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (isIgnoredName(entry.name)) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			walkFiles(abs, base, out);
			continue;
		}
		out.push(relative(base, abs));
	}
	return out.sort();
}

// ── source layout ───────────────────────────────────────────────────────────

/**
 * Validate the source tree before anything is copied.
 *
 * Fails closed on: a missing known file, a symlinked known file, an unexpected
 * executable file anywhere in the tree, and any name OMP's discovery would load
 * in addition to `no-poll-waits.js`.
 *
 * @returns {{ ok: boolean, problems: string[], ignored: string[] }}
 */
export function validateSourceLayout(sourceRoot = SOURCE_ROOT) {
	const problems = [];
	const ignored = [];

	if (!existsSync(sourceRoot)) {
		return { ok: false, problems: [`source tree does not exist: ${sourceRoot}`], ignored };
	}
	if (!lstatSync(sourceRoot).isDirectory()) {
		return { ok: false, problems: [`source tree is not a directory: ${sourceRoot}`], ignored };
	}

	for (const rel of KNOWN_FILES) {
		const abs = join(sourceRoot, rel);
		if (!existsSync(abs)) {
			problems.push(`missing known file: ${rel}`);
			continue;
		}
		if (!isRegularFile(abs)) {
			problems.push(`known file is not a regular file (symlink?): ${rel}`);
		}
	}

	const known = new Set(KNOWN_FILES);
	for (const rel of walkFiles(sourceRoot)) {
		const name = basename(rel);
		if (lstatSync(join(sourceRoot, rel)).isSymbolicLink()) {
			problems.push(`source tree contains a symlink: ${rel}`);
			continue;
		}
		if (KNOWN_FILES.includes(rel)) continue;
		if (DISCOVERY_ALIAS_NAMES.includes(name)) {
			problems.push(`discovery alias would be loaded by the host and is not part of the reviewed set: ${rel}`);
			continue;
		}
		if (CODE_SUFFIXES.includes(rel.slice(rel.lastIndexOf(".")))) {
			problems.push(`unexpected executable file in the source tree: ${rel}`);
			continue;
		}
		if (!known.has(rel)) ignored.push(rel);
	}

	return { ok: problems.length === 0, problems, ignored };
}

/**
 * OMP's extension discovery, mirrored from
 * `@oh-my-pi/pi-coding-agent/src/discovery/helpers.ts#discoverExtensionModulePaths`:
 * top-level `.ts`/`.js` files, plus a subdirectory's `index.ts`/`index.js`, plus a
 * subdirectory's `package.json` manifest. Reproduced here so the installer test
 * can assert what the host will load without depending on the host being
 * installed.
 */
export function discoverExtensionModules(dir) {
	const modules = [];
	const manifests = [];
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return { modules, manifests };
	}
	const has = (sub, name) => {
		const entry = entries.find(e => e.name === sub);
		if (!entry) return false;
		try {
			return existsSync(join(dir, sub, name));
		} catch {
			return false;
		}
	};
	for (const entry of entries) {
		if (isIgnoredName(entry.name)) continue;
		if (entry.isDirectory() || entry.isSymbolicLink()) {
			if (has(entry.name, "package.json")) manifests.push(`${entry.name}/package.json`);
			if (has(entry.name, "index.ts")) modules.push(`${entry.name}/index.ts`);
			else if (has(entry.name, "index.js")) modules.push(`${entry.name}/index.js`);
			continue;
		}
		if (!entry.isFile()) continue;
		if (/\.(ts|js)$/.test(entry.name)) modules.push(entry.name);
	}
	return { modules: modules.sort(), manifests: manifests.sort() };
}

// ── target resolution ───────────────────────────────────────────────────────

export function resolveTarget(explicit) {
	if (explicit) return resolve(explicit);
	const fromEnv = process.env[TARGET_ENV];
	if (fromEnv && fromEnv.trim()) return resolve(fromEnv);
	return join(homedir(), ".omp", "agent", "extensions");
}

/**
 * Where a pre-existing, differing deployment is preserved before it is
 * overwritten. Kept OUTSIDE the extension directory on purpose: anything inside
 * it is a discovery surface, and a backup is not something the host should see.
 */
export function resolveBackupRoot(target, explicit) {
	if (explicit) return resolve(explicit);
	return join(dirname(target), "omp-integration-backups");
}

// ── deployment classification ───────────────────────────────────────────────

/**
 * Collapse every private-identifier spelling to one token. Not a hash — a
 * canonical form, so a reader can see exactly what was elided.
 */
export function canonicalizeIdentifiers(text) {
	return text.replace(UUID_RE, ID_REDACTION_TOKEN);
}

function countUuidShaped(text) {
	const matches = text.match(UUID_RE);
	return matches ? matches.length : 0;
}

/**
 * Compare one published source file against one deployed file.
 *
 *   MATCH       byte-identical
 *   EQUIVALENT  differs only by private identifiers, which the published source
 *               redacts to {@link ID_REDACTION_TOKEN}. The published side must
 *               contain no identifier of that shape and the deployed side must
 *               contain at least one, so this state cannot hide a real edit.
 *   DRIFT       any other difference
 */
export function classifyDeployment(publishedBytes, deployedBytes) {
	const published = publishedBytes.toString("utf8");
	const deployed = deployedBytes.toString("utf8");
	if (published === deployed) return { state: "MATCH", redacted: 0 };
	const publishedIds = countUuidShaped(published);
	const deployedIds = countUuidShaped(deployed);
	if (publishedIds === 0 && deployedIds > 0 && canonicalizeIdentifiers(published) === canonicalizeIdentifiers(deployed)) {
		return { state: "EQUIVALENT", redacted: deployedIds };
	}
	return { state: "DRIFT", redacted: 0 };
}

// ── filesystem writes ───────────────────────────────────────────────────────

/** Write `bytes` to `dest` via a sibling temp file + rename, so a reader never sees a half file. */
export function writeFileAtomic(dest, bytes) {
	mkdirSync(dirname(dest), { recursive: true });
	const tmp = `${dest}.tmp-${process.pid}`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, dest);
}

export function removeFile(path) {
	try {
		unlinkSync(path);
		return true;
	} catch {
		return false;
	}
}

export function removeDir(path) {
	rmSync(path, { recursive: true, force: true });
}

/** `2026-09-25T22-53-01-123Z`, filesystem-safe and sortable. */
export function timestampSlug(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}
