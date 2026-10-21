// integrations/omp/extensions/lib/controller-client.mjs
//
// AEGISFLOW_CONTROLLER_CLIENT_R3_ISOLATED_IMPLEMENTATION_AND_ACCEPTANCE_1.
//
// A Controller client over the EXISTING RPC channel. It opens a transport, binds
// to one live runtime, issues `/fence-identity` then `/fence-generation`, and
// accepts a result only through the predecessor's `ResultCorrelator`. There is no
// second protocol here: the frames are the ones `lib/controller-result.mjs`
// defines, the identity is the one `lib/runtime-identity.mjs` allocates, and the
// commit is the one the extension already performs.
//
// Design constraints, each tied to a named risk
// --------------------------------------------
// * TRUSTED LAUNCH (C1). The binary is resolved to an absolute real path, hashed
//   BEFORE spawn, and re-hashed after spawn; the child's own executable path is
//   read from the OS and compared. A binary that changes under us, a path that is
//   a symlink into a world-writable directory, or a child whose executable is not
//   the one we hashed is a refusal to launch, not a warning.
// * AUTHORITY (C2). The client does not read authority from its environment. It
//   RECEIVES it from the caller that owns the launch, and it sets the marker only
//   on the child it spawns. `AGENT_REQUEST != CONTROLLER_COMMIT` is preserved by
//   construction: the extension's commit path is reachable only through this
//   child's host-command channel.
// * BINDING (C3). Identity is read from the live runtime via the signed identity
//   frame, compared with the caller's expectations, and re-verified by the
//   extension at commit time (it re-checks ledger ownership immediately before
//   the fence). The client also refuses to commit if the identity drifted between
//   its own read and its own commit.
// * CORRELATION (C4). Every frame goes through `ResultCorrelator`; nothing is
//   parsed out of stdout by shape. An unsigned or unknown-request frame is a
//   rejection that is recorded, never a result.
// * STATE MACHINE (C5). The client's answer is one of the card's states, and the
//   distinctions are load-bearing: a timeout after the command was dispatched is
//   `UNKNOWN`, not FAILED; a lost response after a durable commit stays
//   `COMMITTED_UNCONFIRMED`, not FAILED; `commandAccepted` alone is never a
//   commit.

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// The verifier is the PREDECESSOR card's module, imported from where it ships:
// the controller reuses that contract rather than restating it. This is the
// "reuse ResultCorrelator, do not build a second RPC protocol" requirement made
// structural — there is exactly one implementation, and it is the deployed one.
import {
	ResultCorrelator,
	RESULT_KEY_PATTERN,
	RESULT_KEY_ENV,
	RESULT_CHANNEL,
} from "../../integrations/omp/extensions/lib/controller-result.mjs";
import {
	LEDGER_FD_ENV,
	LEDGER_KEY_FD_ENV,
	LEDGER_KEY_PATTERN,
	LOCK_DIR_ENV,
	verifyLedgerRecord,
} from "../../integrations/omp/extensions/lib/ledger-auth.mjs";

/** Environment variable naming the RPC binary a caller wants used. */
export const RPC_BIN_ENV = "AEGIS_RPC_BIN";
/**
 * The RETIRED capability marker (R4).
 *
 * Kept as an exported name because the launch still REFUSES to proceed when this
 * process or a supplied child environment carries it — an inherited marker means
 * somebody is trying to make authority transitive. It grants nothing.
 */
export const AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY";
/** Directory holding the durable identity ledger. */
export const STATE_DIR_ENV = "OMP_TERMINAL_FENCE_STATE_DIR";
/** Declares the child's stdout as a machine frame channel. */
export const TRANSPORT_ENV = "OMP_CONTROLLER_RESULT_TRANSPORT";
/** Optional: the extension module the child must load, instead of discovery. */
export const EXTENSION_ENV = "AEGIS_CONTROLLER_EXTENSION";
/** stdio slot carrying the append-only ledger descriptor. */
const LEDGER_FD = 3;
/** stdio slot carrying the ledger authentication key. */
const LEDGER_KEY_FD = 4;

/**
 * The commit state machine (C5).
 *
 * `COMMITTED_UNCONFIRMED` is deliberately distinct from both `COMMITTED` and
 * `FAILED`: the durable commit may exist while the answer never arrived, and
 * neither collapsing it to success (a lie about confirmation) nor to failure (a
 * lie about the world) is acceptable.
 */
export const COMMIT_STATE = Object.freeze({
	NOT_REQUESTED: "NOT_REQUESTED",
	REQUEST_SENT: "REQUEST_SENT",
	COMMAND_ACCEPTED: "COMMAND_ACCEPTED",
	HANDLER_EXECUTED: "HANDLER_EXECUTED",
	COMMIT_ATTEMPTED: "COMMIT_ATTEMPTED",
	COMMITTED: "COMMITTED",
	/** The runtime reported a durable commit; the client could not confirm it. */
	COMMITTED_UNCONFIRMED: "COMMITTED_UNCONFIRMED",
	DENIED: "DENIED",
	FAILED: "FAILED",
	/** The command was sent and the outcome is genuinely unknown. Never retried. */
	UNKNOWN: "UNKNOWN",
});

export const LAUNCH_DENIAL = Object.freeze({
	BIN_UNRESOLVED: "RPC_BIN_UNRESOLVED",
	BIN_NOT_ABSOLUTE: "RPC_BIN_NOT_ABSOLUTE",
	BIN_NOT_FILE: "RPC_BIN_NOT_FILE",
	BIN_NOT_EXECUTABLE: "RPC_BIN_NOT_EXECUTABLE",
	BIN_WORLD_WRITABLE: "RPC_BIN_WORLD_WRITABLE",
	BIN_PARENT_WORLD_WRITABLE: "RPC_BIN_PARENT_WORLD_WRITABLE",
	BIN_CHANGED_BEFORE_SPAWN: "RPC_BIN_CHANGED_BEFORE_SPAWN",
	BIN_CHANGED_AFTER_SPAWN: "RPC_BIN_CHANGED_AFTER_SPAWN",
	CHILD_EXECUTABLE_MISMATCH: "CHILD_EXECUTABLE_MISMATCH",
	EXTENSION_UNVERIFIED: "EXTENSION_UNVERIFIED",
	EXTENSION_HASH_MISMATCH: "EXTENSION_HASH_MISMATCH",
	EXTENSION_TREE_IMPURE: "EXTENSION_TREE_IMPURE",
	AUTHORITY_NOT_DELEGATED: "AUTHORITY_NOT_DELEGATED",
	AUTHORITY_INHERITED: "AUTHORITY_INHERITED",
	KEY_PROVISION_FAILED: "KEY_PROVISION_FAILED",
	STATE_DIR_UNUSABLE: "STATE_DIR_UNUSABLE",
	/** The launch could not be isolated, so it was not launched. */
	SANDBOX_UNAVAILABLE: "SANDBOX_UNAVAILABLE",
});

/**
 * Authority is a DELEGATION, never an ambient fact.
 *
 * The card forbids three shapes by name: an agent setting authority for itself, an
 * agent declaring itself controller through a prompt, and authority obtained from
 * an unverified environment variable. All three collapse into one rule this
 * module enforces mechanically — a launch requires an explicit grant object that
 * names the controller and its basis, and a launch REFUSES to proceed when the
 * process environment already carries the marker, because that would mean this
 * client inherited an authority it did not mint.
 *
 * The grant is a plain object, so it cannot be a cryptographic capability in a
 * same-process design: anything able to call this function could construct one.
 * That boundary is stated rather than implied — what the grant buys is that
 * authority is never *ambient* and never *derived from a string an agent can
 * print*. Real provisioning (GDR-1) is the subject of a separate card.
 */
export function createControllerGrant({ controllerId, basis, evidence = null, now = Date.now() }) {
	if (typeof controllerId !== "string" || controllerId.length === 0) {
		throw new Error("createControllerGrant requires a controllerId");
	}
	if (typeof basis !== "string" || basis.length === 0) {
		throw new Error("createControllerGrant requires a basis (why this process may grant authority)");
	}
	return Object.freeze({
		kind: "controller-grant/v1",
		controllerId,
		basis,
		evidence,
		grantedAt: now,
	});
}

/** True only for a structurally valid grant. Anything else is not a grant. */
export function isControllerGrant(value) {
	return Boolean(
		value &&
			typeof value === "object" &&
			value.kind === "controller-grant/v1" &&
			typeof value.controllerId === "string" &&
			value.controllerId.length > 0 &&
			typeof value.basis === "string" &&
			value.basis.length > 0,
	);
}

/**
 * Attest the extension module that will be the child's ONLY loaded extension.
 *
 * The card's TCB requirement is that the launch-time module set is known, not
 * merely that the main executable is. Two facts make that true here:
 *
 *   1. the child is launched with `--no-extensions`, so discovery contributes
 *      nothing and the explicit `-e` path is the entire extension surface;
 *   2. that path's bytes must match a caller-supplied SHA-256. Without a supplied
 *      hash this refuses, because "some file at some path" is exactly the
 *      substitution this is meant to stop.
 *
 * The module's own `lib/` siblings are read by it at import time, so their
 * presence is checked too — a verified entry point importing an unverified
 * helper would move the TCB without moving the hash.
 *
 * @returns {{ ok: true, path: string, sha256: string, tree: string[] }
 *          | { ok: false, denial: string, detail?: any }}
 */
export function attestExtension(extensionPath, expectedSha256, { requireSiblings = true, expectedTree = null } = {}) {
	if (typeof extensionPath !== "string" || extensionPath.length === 0) {
		return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED, detail: "no path" };
	}
	if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
		return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED, detail: "no expected sha256 supplied" };
	}
	let real;
	let stat;
	try {
		real = realpathSync(extensionPath);
		stat = statSync(real);
	} catch (error) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
			detail: String(error && error.message ? error.message : error),
		};
	}
	if (!stat.isFile()) return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED, detail: "not a regular file" };
	if ((stat.mode & 0o002) !== 0) {
		return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_TREE_IMPURE, detail: `world-writable: ${real}` };
	}
	const actual = sha256File(real);
	if (actual !== expectedSha256) {
		return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH, detail: { expected: expectedSha256, actual } };
	}
	// THE SIBLINGS ARE PART OF THE LOADED TCB, SO THEY ARE HASHED TOO.
	//
	// Independent review held C1 at HOLD for this: the entry module's hash was
	// verified, but its `lib/` siblings were only checked for presence and mode, so a
	// swapped sibling would change the loaded module set without changing the
	// verified digest. Presence is not integrity.
	//
	// The sibling set is therefore pinned by digest. Two modes:
	//
	//   EXPECTED TREE (preferred)  the caller supplies `{ "<relpath>": "<sha256>" }`
	//                              and every entry must match exactly, with no extra
	//                              or missing module files.
	//   RECORDED TREE              the caller supplies nothing, and the digests are
	//                              returned so the caller can pin them on the next
	//                              launch. This is honest about being a first-run
	//                              observation rather than a verification.
	const tree = [{ path: real, sha256: actual, role: "entry" }];
	const moduleSiblings = [];
	if (requireSiblings) {
		const libDir = join(dirname(real), "lib");
		if (existsSync(libDir)) {
			for (const name of readdirSync(libDir).sort()) {
				if (!/\.(mjs|js|cjs)$/.test(name)) continue;
				const sibling = join(libDir, name);
				let siblingStat;
				try {
					siblingStat = statSync(sibling);
				} catch (error) {
					return {
						ok: false,
						denial: LAUNCH_DENIAL.EXTENSION_TREE_IMPURE,
						detail: String(error && error.message ? error.message : error),
					};
				}
				if (!siblingStat.isFile() || (siblingStat.mode & 0o002) !== 0) {
					return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_TREE_IMPURE, detail: sibling };
				}
				moduleSiblings.push({ path: sibling, name });
			}
		}
	}
	const digests = {};
	for (const sibling of moduleSiblings) {
		const digest = sha256File(sibling.path);
		digests[`lib/${sibling.name}`] = digest;
		tree.push({ path: sibling.path, sha256: digest, role: "sibling" });
	}
	if (expectedTree !== null && expectedTree !== undefined) {
		if (typeof expectedTree !== "object" || Array.isArray(expectedTree)) {
			return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED, detail: "expectedTree must be an object" };
		}
		const expectedNames = Object.keys(expectedTree).sort();
		const actualNames = Object.keys(digests).sort();
		if (expectedNames.join(",") !== actualNames.join(",")) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_TREE_IMPURE,
				detail: { expected: expectedNames, actual: actualNames },
			};
		}
		for (const name of expectedNames) {
			if (expectedTree[name] !== digests[name]) {
				return {
					ok: false,
					denial: LAUNCH_DENIAL.EXTENSION_HASH_MISMATCH,
					detail: { file: name, expected: expectedTree[name], actual: digests[name] },
				};
			}
		}
	}
	return { ok: true, path: real, sha256: actual, tree, digests, treeVerified: expectedTree !== null && expectedTree !== undefined };
}

/** Seconds a spawned child may take to print `ready`. */
const READY_TIMEOUT_MS = 30_000;
/**
 * How long the sandbox wrapper may take to exec into the attested binary.
 *
 * `sandbox-exec` applies the profile and then execs in place, so the child's
 * executable is briefly the wrapper rather than the runtime. This bound is the
 * window in which that transition is expected; past it, the process is not the
 * one that was attested.
 */
const CHILD_EXEC_TIMEOUT_MS = 5_000;

function sha256File(path) {
	const hash = createHash("sha256");
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(1 << 20);
		for (;;) {
			const read = readSync(fd, buffer, 0, buffer.length, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
		}
	} finally {
		closeSync(fd);
	}
	return hash.digest("hex");
}

/**
 * Resolve and attest the RPC binary.
 *
 * The hash is taken from the file the process will actually execute, resolved
 * through `realpath`, and every directory on the way to it is required to be
 * non-world-writable. A binary in a directory any user can replace is a binary
 * whose hash means nothing.
 *
 * @returns {{ ok: true, path: string, sha256: string, version: string|null, stat: object }
 *          | { ok: false, denial: string, detail?: string, path?: string }}
 */
export function attestRpcBinary(candidate, { env = process.env } = {}) {
	const requested = candidate ?? env?.[RPC_BIN_ENV] ?? null;
	if (typeof requested !== "string" || requested.length === 0) {
		return { ok: false, denial: LAUNCH_DENIAL.BIN_UNRESOLVED, detail: `${RPC_BIN_ENV} is unset` };
	}
	if (!isAbsolute(requested)) {
		return { ok: false, denial: LAUNCH_DENIAL.BIN_NOT_ABSOLUTE, detail: requested };
	}
	let real;
	try {
		real = realpathSync(requested);
	} catch (error) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.BIN_UNRESOLVED,
			detail: String(error && error.message ? error.message : error),
			path: requested,
		};
	}
	let stat;
	try {
		stat = statSync(real);
	} catch (error) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.BIN_UNRESOLVED,
			detail: String(error && error.message ? error.message : error),
			path: real,
		};
	}
	if (!stat.isFile()) return { ok: false, denial: LAUNCH_DENIAL.BIN_NOT_FILE, path: real };
	if ((stat.mode & 0o111) === 0) return { ok: false, denial: LAUNCH_DENIAL.BIN_NOT_EXECUTABLE, path: real };
	// World-writable anywhere on the path is disqualifying: another user could
	// substitute the file between the hash and the exec.
	if ((stat.mode & 0o002) !== 0) return { ok: false, denial: LAUNCH_DENIAL.BIN_WORLD_WRITABLE, path: real };
	for (let dir = dirname(real); ; dir = dirname(dir)) {
		let dirStat;
		try {
			dirStat = statSync(dir);
		} catch (error) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.BIN_UNRESOLVED,
				detail: String(error && error.message ? error.message : error),
				path: real,
			};
		}
		if ((dirStat.mode & 0o002) !== 0) {
			return { ok: false, denial: LAUNCH_DENIAL.BIN_PARENT_WORLD_WRITABLE, path: real, detail: dir };
		}
		if (dirname(dir) === dir) break;
	}
	// The version is read from the ATTESTED file, not from whatever `omp` the PATH
	// would resolve: a version string from a different binary is not evidence.
	let version = null;
	try {
		const out = execFileSync(real, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
		version = out.length > 0 ? out.split("\n")[0] : null;
	} catch {
		version = null;
	}
	return { ok: true, path: real, sha256: sha256File(real), version, stat };
}

/**
 * Read the executable a live process is actually running.
 *
 * On darwin and linux both `ps -o comm=` and `lsof` answer this; `ps` is used
 * because it needs no extra dependency and reports the kernel's own view. A
 * failure to read is reported as `null` — the caller must treat "cannot prove"
 * as "do not proceed", never as "assume it matched".
 */
export function childExecutablePath(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" }).trim();
		if (!out) return null;
		return realpathSync(out);
	} catch {
		return null;
	}
}

/** The extension module a governed child must load, or null when it uses discovery. */
export function resolveExtensionPath({ env = process.env, fallback = null } = {}) {
	const configured = env?.[EXTENSION_ENV] ?? fallback;
	if (typeof configured !== "string" || configured.length === 0) return null;
	try {
		const real = realpathSync(configured);
		return statSync(real).isFile() ? real : null;
	} catch {
		return null;
	}
}

function nowMs() {
	return Date.now();
}

function sleep(ms) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

/**
 * How a launch enforces write isolation on the trusted code (R4-C).
 *
 * The requirement is not "detect tampering on the next start" — the admission
 * card measured that the Agent can edit the deployed extension and that the hash
 * check then converts the attack into a denial of service. The requirement is
 * that the write does not happen.
 *
 * The mechanism is the OS's own sandbox, applied to the WHOLE process tree of the
 * governed runtime: the child, its `bash` tool, and anything either of them
 * spawns. It denies `file-write*` on the extension tree, on the controller's
 * ledger key and on the ledger path, and denies `file-read*` on the key. Because
 * a nested `sandbox-exec` inside a sandbox is refused by the OS (measured:
 * `sandbox_apply: Operation not permitted`), a descendant cannot widen it.
 *
 * This is NOT a substitute for file permissions. It is the smallest real
 * boundary available without changing the account model, and the deployment plan
 * names the account separation as the durable answer. What it buys is that the
 * running system does not depend on a future check for its integrity.
 *
 * @returns {{ok: true, command: string, args: string[], profile: string}
 *          | {ok: false, reason: string}}
 */
export function buildLaunchSandbox({ denyWrite = [], denyRead = [], allowWrite = [] } = {}) {
	// Only darwin ships a usable `sandbox-exec`. On any other platform this
	// returns `ok: false` and the caller launches WITHOUT the sandbox — reported
	// honestly in the launch result, never silently claimed.
	if (process.platform !== "darwin") return { ok: false, reason: "SANDBOX_UNAVAILABLE_ON_PLATFORM" };
	const sandboxExec = "/usr/bin/sandbox-exec";
	try {
		if (!statSync(sandboxExec).isFile()) return { ok: false, reason: "SANDBOX_EXEC_MISSING" };
	} catch {
		return { ok: false, reason: "SANDBOX_EXEC_MISSING" };
	}
	// Seatbelt profiles are s-expressions; a path containing a quote or backslash
	// would change the meaning of the profile, so such a path is refused rather
	// than escaped and hoped for.
	//
	// RESOLVE EVERY PATH FIRST. Seatbelt matches the KERNEL's view, which is the
	// resolved path, and on macOS `/var` is a symlink to `/private/var`. A deny rule
	// written for `/var/folders/...` — which is what `os.tmpdir()` returns — matches
	// NOTHING, and the sandbox silently allows the write. Measured: the same profile
	// with `/var/...` allowed the write, and with `/private/var/...` denied it.
	const quote = value => {
		let text = String(value);
		try {
			text = realpathSync(text);
		} catch {
			// A path that does not exist yet cannot be resolved; its parent is what the
			// kernel will match, so resolve the deepest existing ancestor and re-join.
			const parts = text.split("/").filter(Boolean);
			let base = "/";
			let index = 0;
			for (; index < parts.length; index += 1) {
				const candidate = `${base}${base === "/" ? "" : "/"}${parts[index]}`;
				try {
					base = realpathSync(candidate);
				} catch {
					break;
				}
			}
			text = [base, ...parts.slice(index)].join("/").replace(/\/+/g, "/");
		}
		if (text.includes('"') || text.includes("\\")) throw new Error(`path is not sandbox-quotable: ${text}`);
		return text;
	};
	const lines = ["(version 1)", "(allow default)"];
	// ORDER IS LOAD-BEARING: Seatbelt is last-match-wins. The broad denies come
	// first, then the narrow allows that carve out what the runtime legitimately
	// needs. Measured on this host: the carve-out does not re-open a denied
	// sibling, and a descendant is denied exactly like its parent.
	for (const path of denyWrite) lines.push(`(deny file-write* (subpath "${quote(path)}"))`);
	for (const path of denyRead) lines.push(`(deny file-read* (subpath "${quote(path)}"))`);
	for (const path of allowWrite) lines.push(`(allow file-write* (subpath "${quote(path)}"))`);
	const profile = `${lines.join("\n")}\n`;
	return { ok: true, command: sandboxExec, args: ["-p", profile], profile };
}

/**
 * A controller-owned launch directory: the signing key, the identity ledger and
 * the child's HOME all live under one directory this controller created with
 * mode 0700.
 */
export function prepareControllerRoot({ root, home = null } = {}) {
	const dir = resolve(root);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const mode = statSync(dir).mode & 0o777;
	if ((mode & 0o077) !== 0) {
		throw new Error(`controller root is group/other accessible (mode ${mode.toString(8)}): ${dir}`);
	}
	const childHome = home ? resolve(home) : join(dir, "home");
	mkdirSync(childHome, { recursive: true, mode: 0o700 });
	const stateDir = join(dir, "state");
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	// R4: the lock lives OUTSIDE the ledger directory, because the launch sandbox
	// denies path writes to the ledger directory and a lock is created by path.
	const lockDir = join(dir, "locks");
	mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	// The ledger FILE itself is created here, empty, so the controller can open it
	// and hand the descriptor to the child. The child never opens this path.
	const ledgerPath = join(stateDir, "ledger.jsonl");
	if (!existsSync(ledgerPath)) {
		try {
			writeFileSync(ledgerPath, "", { mode: 0o600 });
		} catch {
			// A root whose ledger cannot be created is reported by the launch, which
			// is where the operator can act on it.
		}
	}
	// The ledger AUTHENTICATION key is minted ONCE per root, not per launch: it
	// authenticates records, and records must stay verifiable across restarts of
	// the governed runtime. (The RESULT key is still per launch and single-use —
	// different key, different lifetime, different purpose.)
	const ledgerKeyPath = join(dir, "ledger.key");
	if (!existsSync(ledgerKeyPath)) {
		try {
			writeFileSync(ledgerKeyPath, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
		} catch {
			// Same: the launch reports what it cannot provision.
		}
	}
	return { dir, childHome, stateDir, lockDir, ledgerPath, ledgerKeyPath };
}

/**
 * Drive one live runtime.
 *
 * @param {object} options
 * @param {string} options.rpcBin            absolute path (or `AEGIS_RPC_BIN`)
 * @param {string} options.controllerRoot    private directory from `prepareControllerRoot`
 * @param {string[]} [options.args]          extra argv for the child
 * @param {string} [options.extensionPath]   extension module to load explicitly
 * @param {string} [options.cwd]
 * @param {Record<string,string>} [options.env]  the child's base environment
 * @param {(event: object) => void} [options.onTransition]
 */
export async function launchGovernedRuntime({
	rpcBin,
	controllerRoot,
	grant = null,
	extensionPath = null,
	extensionSha256 = null,
	extensionTree = null,
	additionalExtensions = [],
	args = [],
	cwd = process.cwd(),
	env = {},
	onTransition = null,
	dispatchObserver = null,
}) {
	const transitions = [];
	const transition = (state, detail = null) => {
		transitions.push({ state, detail, at: nowMs() });
		if (typeof onTransition === "function") {
			try {
				onTransition({ state, detail });
			} catch {
				// An observer must not be able to break the controller.
			}
		}
	};

	// C2 FIRST: a launch without a delegated grant is not a launch. Checking this
	// before anything is spawned means a refused launch leaves no process behind.
	if (!isControllerGrant(grant)) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.AUTHORITY_NOT_DELEGATED,
			detail: "launchGovernedRuntime requires a grant from createControllerGrant()",
			transitions,
		};
	}
	// An inherited marker means this process is already inside some other
	// controller's authority. Launching a child from here would make that
	// authority transitive, which is exactly the shape the card forbids.
	//
	// BOTH environments are checked. Independent review measured that checking only
	// the optional `env` argument (which defaults to `{}`) let a process that really
	// DID carry the marker launch anyway: the gate read an empty object and passed.
	// The ambient environment is the one that matters, and a supplied child
	// environment is an additional place the marker could be smuggled in.
	{
		const ambient = typeof process !== "undefined" && process.env ? process.env[AUTHORITY_ENV] : undefined;
		if (typeof ambient === "string" && ambient.length > 0) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.AUTHORITY_INHERITED,
				detail: "this process's own environment already carries the capability marker",
				transitions,
			};
		}
		if (typeof env?.[AUTHORITY_ENV] === "string" && env[AUTHORITY_ENV].length > 0) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.AUTHORITY_INHERITED,
				detail: "the supplied child environment carries the capability marker",
				transitions,
			};
		}
	}

	const attestation = attestRpcBinary(rpcBin);
	if (!attestation.ok) {
		return { ok: false, denial: attestation.denial, detail: attestation.detail ?? null, transitions };
	}
	if (!controllerRoot || typeof controllerRoot !== "object") {
		return { ok: false, denial: LAUNCH_DENIAL.AUTHORITY_NOT_DELEGATED, detail: "no controller root", transitions };
	}


	// C1: the loaded module set is part of the TCB. An explicit extension must be
	// hash-attested, and its dependency tree must be PINNED — not merely observed.
	//
	// Independent review held this at FAIL: the helper could verify a tree, but the
	// governed launch never passed one, so every real launch proceeded with an
	// observed-but-unverified dependency set. A helper that is not wired into the
	// launch proves nothing about the launch.
	//
	// `extensionTree` is therefore required whenever an extension is loaded. There is
	// deliberately no "record it this time" escape at launch: a governed process
	// either knows the module set it is willing to run or it does not launch. The
	// first-run observation is available from `attestExtension` directly, for a
	// caller that is establishing the manifest.
	let extension = null;
	if (extensionPath !== null) {
		if (extensionTree === null || typeof extensionTree !== "object") {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
				detail: "a governed launch requires extensionTree (the pinned sibling digests)",
				transitions,
			};
		}
		extension = attestExtension(extensionPath, extensionSha256, { expectedTree: extensionTree });
		if (!extension.ok) {
			return { ok: false, denial: extension.denial, detail: extension.detail ?? null, transitions };
		}
		if (extension.treeVerified !== true) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
				detail: "the extension tree was not verified",
				transitions,
			};
		}
	}

	const { childHome, stateDir, dir, lockDir = join(dir, "locks"), ledgerPath = join(stateDir, "ledger.jsonl"), ledgerKeyPath = join(dir, "ledger.key") } = controllerRoot;
	if (!existsSync(stateDir) || !statSync(stateDir).isDirectory()) {
		return { ok: false, denial: LAUNCH_DENIAL.STATE_DIR_UNUSABLE, detail: stateDir, transitions };
	}

	// A FRESH key per launch, always.
	//
	// The extension reads the key once at module load and then UNLINKS it — that is
	// the whole point of handing over a path rather than the secret. Reusing one
	// key file across two launches therefore fails the second launch with
	// `KEY_PROVISION_FAILED`, which is exactly what a two-runtime test measured.
	// A key is single-use by design, so this client mints one for each child.
	const keyFile = join(dir, `result.${process.pid}.${randomBytes(6).toString("hex")}.key`);
	const key = randomBytes(32).toString("hex");
	try {
		writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
	} catch (error) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.KEY_PROVISION_FAILED,
			detail: String(error && error.message ? error.message : error),
			transitions,
		};
	}

	// R4-B: THE LEDGER KEY AND THE LEDGER DESCRIPTOR.
	//
	// The key is read from the controller root and handed over on a dedicated
	// descriptor; it never enters the environment, argv or the session file. The
	// ledger is opened here, once, and the child receives the descriptor — so the
	// launch sandbox can deny the ledger PATH to every process in the tree,
	// including the governed child's own `bash`.
	// A DESCRIPTOR IS ONLY HANDED OVER WHEN SOMETHING WILL REVOKE IT.
	//
	// Measured by independent review: the descriptors were passed unconditionally,
	// but `extensionPath` is optional. A launch with no extension — or with only an
	// additional extension such as `cbm-query.js` — never runs
	// `installControllerCapabilityFromEnv()`, so NOTHING closes or re-opens the
	// inherited descriptors close-on-exec. The Agent's bash would then hold a
	// writable ledger handle and a readable key.
	//
	// `no-poll-waits.js` is the module that revokes them. Without it there is no
	// commit path at all, so there is nothing to authorize and no descriptor to
	// leak: the launch proceeds with no capability, and `capabilityProvisioned`
	// reports that plainly rather than implying authority that was never given.
	const consumesCapability = extension !== null;
	let ledgerKey;
	let ledgerFd = null;
	let ledgerKeyFd = null;
	try {
		ledgerKey = readFileSync(ledgerKeyPath, "utf8").trim();
		if (!LEDGER_KEY_PATTERN.test(ledgerKey)) throw new Error("ledger key is malformed");
		if (consumesCapability) {
			ledgerFd = openSync(ledgerPath, "a", 0o600);
			ledgerKeyFd = openSync(ledgerKeyPath, "r");
		}
	} catch (error) {
		for (const fd of [ledgerFd, ledgerKeyFd]) {
			if (fd !== null) {
				try {
					closeSync(fd);
				} catch {
					// Nothing to release.
				}
			}
		}
		return {
			ok: false,
			denial: LAUNCH_DENIAL.KEY_PROVISION_FAILED,
			detail: `ledger capability: ${String(error && error.message ? error.message : error)}`,
			transitions,
		};
	}

	const childArgs = [
		"--mode", "rpc",
		...args,
	];
	// CALLER ARGV MAY NOT WIDEN THE TCB.
	//
	// Measured by independent review: `args` was passed through unvalidated, so a
	// caller could supply its own `-e /path/extra.mjs` (or `--hook`) and load an
	// UNATTESTED module beside the attested one. The extension hash would still
	// match, and the module set would no longer be the one that was verified —
	// which is precisely the "只檢查主執行檔，卻忽略可在同一信任邊界執行的
	// Extension、預載模組" failure the card names.
	//
	// The rules are therefore mechanical, not advisory:
	//   * no module-loading flag may appear in caller args (`-e`, `--extension`,
	//     `--hook`, and their `=` forms);
	//   * `--no-extensions` may not be supplied by the caller either, because the
	//     client adds it unconditionally and a duplicate is harmless but a caller
	//     that believes it disabled discovery should be told it did not need to.
	// Everything else (session args, `--no-skills`, `--no-rules`, `--no-ui`, …) is
	// the caller's business.
	const FORBIDDEN_ARG = /^(-e|--extension|--hook)(=|$)/;
	for (const arg of args) {
		if (typeof arg === "string" && FORBIDDEN_ARG.test(arg)) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
				detail: `caller argv may not load modules; use additionalExtensions with attested hashes: ${arg}`,
				transitions,
			};
		}
	}
	// EXTRA MODULES ARE ALLOWED ONLY WHEN EACH IS ATTESTED.
	//
	// A caller sometimes genuinely needs a second module — a probe, a diagnostics
	// extension. The escape hatch is attestation, not omission, and the rule is the
	// SAME as for the primary extension.
	//
	// Independent review caught the first version: `entry.tree` was optional, so an
	// additional module could import a `lib/` sibling and skip the pinning now
	// required of the primary. A weaker rule for the second module is not a weaker
	// rule for the attack — it is the same TCB. Every additional module therefore
	// requires `tree`, and a module with no siblings supplies `{}` explicitly, so
	// "I checked" is always a deliberate statement rather than a default.
	const additional = [];
	for (const entry of additionalExtensions) {
		if (!entry || typeof entry.path !== "string") {
			return { ok: false, denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED, detail: "additionalExtensions entry has no path", transitions };
		}
		if (entry.tree === null || typeof entry.tree !== "object" || Array.isArray(entry.tree)) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
				detail: "an additional extension requires a pinned tree (use {} when it has no siblings)",
				transitions,
			};
		}
		const attested = attestExtension(entry.path, entry.sha256, { expectedTree: entry.tree });
		if (!attested.ok) {
			return { ok: false, denial: attested.denial, detail: attested.detail ?? null, transitions };
		}
		if (attested.treeVerified !== true) {
			return {
				ok: false,
				denial: LAUNCH_DENIAL.EXTENSION_UNVERIFIED,
				detail: "the additional extension tree was not verified",
				transitions,
			};
		}
		additional.push(attested);
	}
	// Discovery off, unconditionally: the extension surface of a governed child is
	// the attested file and nothing else, so an unrelated module dropped into a
	// discovery directory cannot join the TCB after attestation.
	if (!childArgs.includes("--no-extensions")) childArgs.push("--no-extensions");
	if (extension) childArgs.push("-e", extension.path);
	for (const extra of additional) childArgs.push("-e", extra.path);

	// R4-A: THE MARKER IS NOT SET AT ALL.
	//
	// It used to be. The child's `bash` tool inherited it, so the Agent could read
	// it, print it, and set it again on a nested `omp` — measured in the admission
	// card. Authority is now an inherited DESCRIPTOR plus a key, neither of which
	// survives into a grandchild (`stdio` slots are cleared by `exec`, and the
	// extension re-opens its ledger fd with `O_CLOEXEC`).
	const childEnv = {
		PATH: env.PATH ?? process.env.PATH,
		HOME: childHome,
		TMPDIR: env.TMPDIR ?? process.env.TMPDIR,
		LANG: env.LANG ?? "en_US.UTF-8",
		TERM: "dumb",
		// The provisions that make this child governed. They are set HERE, from this
		// controller's own decisions — never inherited from our caller's environment,
		// which is what keeps a governed launch from being a way to smuggle an
		// unrelated marker into a child.
		[RESULT_KEY_ENV]: keyFile,
		[STATE_DIR_ENV]: stateDir,
		[TRANSPORT_ENV]: "stdout",
		// R4: the capability, when a loaded module will consume it. Descriptor numbers
		// are not secret — what they refer to is, and only this child is given them.
		...(consumesCapability
			? {
					[LEDGER_FD_ENV]: String(LEDGER_FD),
					[LEDGER_KEY_FD_ENV]: String(LEDGER_KEY_FD),
					[LOCK_DIR_ENV]: lockDir,
				}
			: {}),
	};
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) continue;
		if (
			k === AUTHORITY_ENV ||
			k === RESULT_KEY_ENV ||
			k === STATE_DIR_ENV ||
			k === TRANSPORT_ENV ||
			k === LEDGER_FD_ENV ||
			k === LEDGER_KEY_FD_ENV ||
			k === LOCK_DIR_ENV
		) {
			continue;
		}
		childEnv[k] = v;
	}

	// Re-hash immediately before spawn: the file that will be executed is the one
	// that was attested, or nothing is launched.
	const preSpawnHash = sha256File(attestation.path);
	if (preSpawnHash !== attestation.sha256) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.BIN_CHANGED_BEFORE_SPAWN,
			detail: { attested: attestation.sha256, actual: preSpawnHash },
			transitions,
		};
	}

	// R4-C: THE TRUSTED CODE IS WRITE-PROTECTED FOR THE WHOLE PROCESS TREE.
	//
	// The launch is wrapped in an OS sandbox that denies `file-write*` on the
	// deployed extension tree, on the controller's own ledger key, and on the
	// ledger path — for the child AND every process it spawns. That is what turns
	// "the next launch would notice the tampering" into "the tampering cannot
	// happen". The hash attestation above stays as a second line of defence.
	//
	// Measured on this host: a descendant of a sandboxed process is denied a write
	// to a denied subpath (`Operation not permitted`), the same descendant is NOT
	// able to widen the profile by nesting another `sandbox-exec`
	// (`sandbox_apply: Operation not permitted`), and a write to an allowed subpath
	// still succeeds.
	let sandbox;
	try {
		sandbox = buildLaunchSandbox({
			denyWrite: [
				// The trusted code that was ATTESTED — for the whole tree.
				...(extension ? [extension.path, join(dirname(extension.path), "lib")] : []),
				...additional.flatMap(entry => [entry.path, join(dirname(entry.path), "lib")]),
				// AND THE DEPLOYED DISCOVERY TREE.
				//
				// Measured while building this: the attestation names the file the
				// controller LOADED, which is usually the repository copy — while the
				// governed child also discovers whatever sits in its own
				// `~/.omp/agent/extensions`. Denying only the attested path left the
				// discovered tree writable, and the Agent edited it successfully.
				//
				// The extension surface of a governed child is `--no-extensions` plus the
				// attested `-e` paths, so the discovery directory contributes no module
				// to the TCB; but a write there is still a write to a trusted location, and
				// it is denied.
				join(childHome, ".omp", "agent", "extensions"),
				join(childHome, ".omp", "agent", "extensions", "lib"),
				// The durable state. The runtime writes it through the descriptor the
				// controller opened; the PATH is denied to everything, which is what
				// stops the Agent from appending a record of its own.
				stateDir,
				ledgerPath,
				// THE LEDGER KEY IS WRITE-PROTECTED TOO, NOT JUST READ-PROTECTED.
				//
				// Measured by independent review and confirmed here: denying only
				// `file-read*` left the key OVERWRITABLE. An Agent that cannot read the
				// key can still replace it with a key it knows, and every later launch
				// would then trust records signed with the attacker's key — or be denied
				// outright by a malformed one. Confidentiality is not integrity.
				ledgerKeyPath,
				// THE ATTESTED EXECUTABLE AND ITS REPLACEMENT NAMESPACE.
				//
				// The OS refuses to write an executing image, but it does NOT refuse to
				// plant a file beside it and rename over it. The hash attestation is a
				// launch-time check, so it cannot see a replacement made later in the
				// run. Denying the directory as well as the file closes the rename.
				attestation.path,
				dirname(attestation.path),
			],
			denyRead: [ledgerKeyPath],
			// The lock is created by path, so its directory must stay writable.
			allowWrite: [lockDir],
		});
	} catch (error) {
		// FAIL CLOSED. A sandbox that cannot be constructed is not a sandbox.
		//
		// Measured by independent review: a controller root whose path contains a
		// quote or backslash made `buildLaunchSandbox` throw, the catch turned that
		// into `ok:false`, and the launch then proceeded WITHOUT the sandbox while
		// still handing over both authority descriptors. Reporting
		// `sandbox.active:false` afterwards is not a boundary — on the supported
		// deployment platform, no sandbox means no governed launch.
		return {
			ok: false,
			denial: LAUNCH_DENIAL.SANDBOX_UNAVAILABLE,
			detail: String(error && error.message ? error.message : error),
			transitions,
		};
	}
	// Same rule for the honest "this platform has no sandbox" answer: a governed
	// launch that cannot be isolated is refused rather than downgraded silently.
	if (!sandbox.ok) {
		return {
			ok: false,
			denial: LAUNCH_DENIAL.SANDBOX_UNAVAILABLE,
			detail: sandbox.reason ?? "no sandbox mechanism",
			transitions,
		};
	}
	const spawnCommand = sandbox.command;
	const spawnArgs = [...sandbox.args, attestation.path, ...childArgs];

	const child = spawn(spawnCommand, spawnArgs, {
		cwd,
		env: childEnv,
		stdio: consumesCapability ? ["pipe", "pipe", "pipe", ledgerFd, ledgerKeyFd] : ["pipe", "pipe", "pipe"],
	});

	// THE PARENT'S COPIES ARE CLOSED IMMEDIATELY.
	//
	// `spawn` dups these into the child's slots; the originals are this process's
	// and serve no further purpose. Leaving them open would (a) leak two descriptors
	// per launch, and (b) — worse — leave the controller holding a writable handle
	// to a ledger it is not supposed to be writing, and an OPEN handle to the key
	// for the whole lifetime of the runtime. The child has its own copies; these
	// must go.
	for (const fd of [ledgerFd, ledgerKeyFd]) {
		if (fd === null) continue;
		try {
			closeSync(fd);
		} catch {
			// Already closed by a failed spawn path; nothing to release.
		}
	}

	const correlator = new ResultCorrelator(key);
	const frames = [];
	const rejections = [];
	let stdoutBuffer = "";
	let stderr = "";
	let ready = false;
	let exited = null;

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", chunk => {
		stdoutBuffer += chunk;
		let index;
		while ((index = stdoutBuffer.indexOf("\n")) !== -1) {
			const line = stdoutBuffer.slice(0, index);
			stdoutBuffer = stdoutBuffer.slice(index + 1);
			if (!line.trim()) continue;
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue; // A non-JSON line is not a frame and carries no authority.
			}
			frames.push({ at: nowMs(), frame });
			if (frame && frame.type === "ready") ready = true;
			if (frame && frame.type === "controller_result") {
				const verdict = correlator.accept(frame);
				if (!verdict.ok) rejections.push({ reason: verdict.reason, requestId: verdict.requestId });
			}
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	child.on("exit", (code, signal) => {
		exited = { code, signal, at: nowMs() };
	});

	// Post-spawn identity: the child's own executable must be the attested file.
	//
	// With the launch sandbox in play the process starts as `sandbox-exec` and
	// EXECs into the attested binary in place, keeping its pid. A single immediate
	// read therefore races that exec. The check is a bounded poll that accepts
	// exactly two observations — the attested path, or the sandbox wrapper while it
	// is still about to exec — and treats any THIRD value as a substitution. It
	// never accepts "I could not tell": running out of time is `UNREADABLE`.
	const childPid = child.pid ?? null;
	let executablePath = null;
	let executableMismatch = null;
	if (childPid !== null) {
		const deadline = nowMs() + CHILD_EXEC_TIMEOUT_MS;
		const expectedWrapper = sandbox.ok ? realpathSync(sandbox.command) : null;
		for (;;) {
			const observed = childExecutablePath(childPid);
			if (observed === null) {
				executablePath = null;
			} else if (observed === attestation.path) {
				executablePath = observed;
				break;
			} else if (expectedWrapper !== null && observed === expectedWrapper) {
				// Mid-exec. Not yet evidence either way.
				executablePath = observed;
			} else {
				executableMismatch = observed;
				break;
			}
			if (nowMs() >= deadline) {
				if (executablePath === null) executableMismatch = "UNREADABLE";
				break;
			}
			await sleep(10);
		}
		if (executableMismatch === null && executablePath !== attestation.path) {
			// Still the wrapper after the deadline: the exec never happened.
			executableMismatch = executablePath ?? "UNREADABLE";
		}
	}
	if (executableMismatch !== null) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		return {
			ok: false,
			denial: LAUNCH_DENIAL.CHILD_EXECUTABLE_MISMATCH,
			detail: executableMismatch,
			transitions,
			pid: childPid,
		};
	}
	const postSpawnHash = sha256File(attestation.path);
	if (postSpawnHash !== attestation.sha256) {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
		return {
			ok: false,
			denial: LAUNCH_DENIAL.BIN_CHANGED_AFTER_SPAWN,
			detail: { attested: attestation.sha256, actual: postSpawnHash },
			transitions,
			pid: childPid,
		};
	}

	transition(COMMIT_STATE.NOT_REQUESTED, { launched: true });

	const deadline = nowMs() + READY_TIMEOUT_MS;
	while (!ready && exited === null && nowMs() < deadline) await sleep(25);

	// Every outbound frame passes through here, which makes it the ONE place that can
	// answer "was this command actually written to the runtime". `dispatchObserver` is
	// called AFTER the write, so an observer that records state is recording a fact
	// rather than an intention — the distinction the controller-crash case needs to
	// prove its kill landed mid-flight.
	const send = payload => {
		child.stdin.write(`${JSON.stringify(payload)}\n`);
		if (typeof dispatchObserver === "function") {
			try {
				dispatchObserver(payload);
			} catch {
				// An observer must not be able to break the controller.
			}
		}
	};

	/**
	 * Send one command and wait for the correlated, verified result frame.
	 *
	 * The timeout returns `{ ok: false, reason: "TIMEOUT" }` and does NOT cancel
	 * the request: the answer may still arrive, and a caller that treats a timeout
	 * as failure may retry into a double commit. `cancelRequest` exists for the
	 * cases where the caller has decided to give up.
	 */
	async function request(requestId, expectation, command, timeoutMs = 30_000) {
		correlator.expect(requestId, expectation);
		transition(COMMIT_STATE.REQUEST_SENT, { requestId, command });
		send({ id: requestId, type: "prompt", message: command });
		const requestDeadline = nowMs() + timeoutMs;
		while (nowMs() < requestDeadline) {
			const accepted = correlator.accepted(requestId);
			if (accepted) return { ok: true, result: accepted };
			if (exited !== null) break;
			await sleep(20);
		}
		return {
			ok: false,
			reason: exited !== null ? "PROCESS_EXITED" : "TIMEOUT",
			exited,
			pending: correlator.pendingRequestIds(),
		};
	}

	async function stop() {
		if (exited !== null) return { pid: childPid, stderr, exited };
		try {
			child.kill("SIGTERM");
		} catch {
			// Already gone.
		}
		const stopDeadline = nowMs() + 5000;
		while (exited === null && nowMs() < stopDeadline) await sleep(25);
		if (exited === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Already gone.
			}
			const killDeadline = nowMs() + 5000;
			while (exited === null && nowMs() < killDeadline) await sleep(25);
		}
		return { pid: childPid, stderr, exited };
	}

	return {
		ok: true,
		pid: childPid,
		key,
		correlator,
		frames,
		rejections,
		transitions,
		attestation: { path: attestation.path, sha256: attestation.sha256 },
		/** Every module this launch loaded, with the digest that authorised it. */
		moduleSet: [
			...(extension ? [{ path: extension.path, sha256: extension.sha256, role: "extension" }] : []),
			...additional.map(entry => ({ path: entry.path, sha256: entry.sha256, role: "additional" })),
		],
		executablePath,
		childHome,
		stateDir,
		lockDir,
		ledgerPath,
		ledgerKeyPath,
		/** The key that authenticates this root's ledger records. */
		ledgerKey,
		controllerRoot: dir,
		keyFile,
		/** R4-C: whether the launch is write-isolated, and by what. */
		sandbox: { active: true, mechanism: "seatbelt", profile: sandbox.profile },
		/** R4-A: whether this launch was given commit authority at all. */
		capabilityProvisioned: consumesCapability,
		/** Set by `bindIdentity`: the identity this client proved by launching. */
		boundIdentity: null,
		ready,
		send,
		request,
		stop,
		stderrOf: () => stderr,
		exited: () => exited,
	};
}

/**
 * Bind to a live runtime: read its identity over the signed channel and compare
 * it with what the caller expects.
 *
 * @returns {{ ok: true, identity: object, result: object }
 *          | { ok: false, reason: string, denial: string|null, detail?: any }}
 */
export async function bindIdentity(runtime, expectation = {}, { requestId = null, timeoutMs = 20_000 } = {}) {
	const id = requestId ?? `identity-${randomBytes(6).toString("hex")}`;
	const answered = await runtime.request(id, {}, `/fence-identity request=${id}`, timeoutMs);
	if (!answered.ok) {
		return { ok: false, reason: answered.reason, denial: null, detail: answered };
	}
	const result = answered.result;
	if (result.denial) {
		return { ok: false, reason: "DENIED", denial: result.denial, detail: result };
	}
	if (result.op !== "identity") {
		return { ok: false, reason: "NOT_AN_IDENTITY_FRAME", denial: null, detail: result };
	}
	const identity = {
		sessionId: result.sessionId,
		runtimeInstanceId: result.runtimeInstanceId,
		generation: result.generation,
		identityState: result.identityState,
		generationDurable: result.generationDurable === true,
		// R4: the allocation token is part of the identity a commit is bound to.
		// Independent review caught that `bindIdentity` dropped it, so no normal
		// caller could ever pin the allocation and the "full identity" claim was
		// only true for hand-built expectations.
		allocationToken: typeof result.allocationToken === "string" ? result.allocationToken : null,
	};
	const mismatch = compareIdentity(identity, expectation);
	if (mismatch) return { ok: false, reason: "BINDING_MISMATCH", denial: mismatch, detail: identity };
	// Remember what this client established. Later requests correlate against THIS,
	// not against a caller-supplied target: the client's own launch is the authority
	// on which runtime its frames come from.
	runtime.boundIdentity = identity;
	return { ok: true, identity, result };
}

/** Compare a supplied expectation against an observed identity. Omitted fields are not checked. */
export function compareIdentity(identity, expectation = {}) {
	if (expectation.sessionId !== undefined && identity.sessionId !== expectation.sessionId) {
		return "TARGET_SESSION_MISMATCH";
	}
	if (expectation.runtimeInstanceId !== undefined && identity.runtimeInstanceId !== expectation.runtimeInstanceId) {
		return "TARGET_RUNTIME_MISMATCH";
	}
	if (expectation.generation !== undefined && identity.generation !== expectation.generation) {
		return "TARGET_GENERATION_MISMATCH";
	}
	if (expectation.identityState !== undefined && identity.identityState !== expectation.identityState) {
		return "IDENTITY_STATE_MISMATCH";
	}
	return null;
}

/**
 * Commit one fence, end to end, with the state machine the card requires.
 *
 * The returned `state` is derived from the VERIFIED frame, never from "the
 * command was sent" and never from a bare `success` on the RPC response.
 */
export async function commitFence(
	runtime,
	{ status, reason = "controller terminal", expectation = {}, requestId = null, timeoutMs = 30_000 },
) {
	const id = requestId ?? `commit-${randomBytes(6).toString("hex")}`;

	// C3: THE BOUND IDENTITY IS THE DEFAULT TARGET, AND ALL VALIDATION HAPPENS
	// BEFORE ANYTHING IS DISPATCHED.
	//
	// Two defects measured by independent review, both fixed here:
	//
	//  1. `commitFence(runtime, { status: "PASS" })` — no expectation at all — used
	//     to send an UNPINNED command, so the runtime fenced whatever generation was
	//     live. A controller that had bound to generation N and then seen the runtime
	//     advance to N+1 would commit N+1 while believing it was committing N. The
	//     bound identity is now the default target: omitting `expectation` no longer
	//     means "whatever is current", it means "the identity I bound to".
	//
	//  2. The contradictory-expectation check ran AFTER `runtime.request`, so a
	//     caller whose `status` and `expectation.status` disagreed had already
	//     dispatched (and could have durably committed) before being told its input
	//     was invalid. All target validation now precedes dispatch; a refused
	//     request writes nothing.
	const bound = runtime.boundIdentity ?? null;
	// The bound identity supplies ALL THREE fields, including the generation. Leaving
	// the generation out was the defect review measured: an empty expectation would
	// then be incomplete rather than pinned, and a caller with no expectation has no
	// target at all.
	const target = {
		...(bound ? { sessionId: bound.sessionId, runtimeInstanceId: bound.runtimeInstanceId, generation: bound.generation } : {}),
		...expectation,
	};
	if (expectation.status !== undefined && expectation.status !== status) {
		return {
			ok: false,
			state: COMMIT_STATE.NOT_REQUESTED,
			reason: "CONTRADICTORY_STATUS_EXPECTATION",
			requestId: id,
			requestedStatus: status,
			expectedStatus: expectation.status,
			dispatched: false,
		};
	}
	// A commit with no target at all cannot be verified by the runtime, and an
	// unverified commit is not what this client exists to produce.
	if (target.sessionId === undefined || target.runtimeInstanceId === undefined || target.generation === undefined) {
		return {
			ok: false,
			state: COMMIT_STATE.NOT_REQUESTED,
			reason: "TARGET_INCOMPLETE",
			requestId: id,
			missing: [
				target.sessionId === undefined ? "sessionId" : null,
				target.runtimeInstanceId === undefined ? "runtimeInstanceId" : null,
				target.generation === undefined ? "generation" : null,
			].filter(Boolean),
			dispatched: false,
		};
	}
	// The target must still be the identity this client bound to. A caller that
	// names a DIFFERENT session or runtime is not describing this launch, and the
	// client will not dispatch a command at a runtime it did not bind.
	if (bound) {
		const drift = compareIdentity(bound, { sessionId: target.sessionId, runtimeInstanceId: target.runtimeInstanceId });
		if (drift) {
			return {
				ok: false,
				state: COMMIT_STATE.NOT_REQUESTED,
				reason: "TARGET_DRIFT",
				denial: drift,
				requestId: id,
				bound,
				target,
				dispatched: false,
			};
		}
	}

	const pins = [`session=${target.sessionId}`, `runtime=${target.runtimeInstanceId}`, `generation=${target.generation}`, `request=${id}`];
	const command = `/fence-generation ${status} ${pins.join(" ")} ${reason}`;

	// What the correlator pins and what the command pins are NOT the same set.
	//
	// The correlator answers "is this frame the answer to MY request, from the
	// runtime I LAUNCHED" — so it pins the request id and the identity this client
	// established by launching and binding (`runtime.boundIdentity`). It must NOT
	// pin the CALLER's desired target: a mismatched target is a legitimate ANSWER
	// (the runtime telling us our target was wrong), and pinning the desired value
	// turns that answer into a forged-frame rejection.
	//
	// Measured while building this client: pinning the caller's expectation made a
	// wrong-runtime commit and a wrong-session commit both time out to UNKNOWN
	// instead of returning `TARGET_RUNTIME_MISMATCH` / `TARGET_SESSION_MISMATCH`,
	// while the wrong-generation case happened to pass because the runtime's denial
	// frame carries its own generation.
	//
	// Replay stays closed without a generation pin: request ids are unique per
	// correlator and never reissued, so a replayed frame carries an id that is
	// already accepted or never issued, and is refused on that ground.
	const answered = await runtime.request(
		id,
		bound ? { sessionId: bound.sessionId, runtimeInstanceId: bound.runtimeInstanceId } : {},
		command,
		timeoutMs,
	);
	if (!answered.ok) {
		// The command WAS dispatched (the prompt frame was written). An unknown
		// outcome is the only honest answer, and it is not a licence to retry.
		const durable = probeLedgerForCommit(runtime, target);
		return {
			ok: false,
			state: durable === "COMMITTED" ? COMMIT_STATE.COMMITTED_UNCONFIRMED : COMMIT_STATE.UNKNOWN,
			reason: answered.reason,
			requestId: id,
			durableRecord: durable,
			detail: answered,
		};
	}
	const result = answered.result;
	// C4: A SUCCESSFUL RESULT MUST NAME THE TARGET, WHETHER OR NOT WE BOUND FIRST.
	//
	// Measured by independent review: with a complete explicit target and NO prior
	// bind, the correlator expectation was `{}`, so a correctly signed frame naming a
	// DIFFERENT session and runtime — same generation, same status, committed:true —
	// was accepted and returned as COMMITTED. The signature proved the frame came from
	// some runtime; nothing proved it came from the one we asked.
	//
	// The check is applied to SUCCESSFUL results only. A denial legitimately reports
	// the runtime's own identity, and refusing to surface it would hide exactly the
	// information a controller needs when its target was wrong — that is why the
	// correlation pins were never tightened to the desired target in the first place.
	if (result.committed === true) {
		if (result.sessionId !== target.sessionId) {
			return {
				ok: false,
				state: COMMIT_STATE.FAILED,
				reason: "COMMITTED_SESSION_MISMATCH",
				requestId: id,
				targetSessionId: target.sessionId,
				observedSessionId: result.sessionId ?? null,
				result,
			};
		}
		if (result.runtimeInstanceId !== target.runtimeInstanceId) {
			return {
				ok: false,
				state: COMMIT_STATE.FAILED,
				reason: "COMMITTED_RUNTIME_MISMATCH",
				requestId: id,
				targetRuntimeInstanceId: target.runtimeInstanceId,
				observedRuntimeInstanceId: result.runtimeInstanceId ?? null,
				result,
			};
		}
	}
	// The generation the client asked for and the generation the runtime committed
	// must be the same number. A verified frame that claims a commit of a DIFFERENT
	// generation is not a success for this request — it is either a target the
	// runtime substituted or a corrupted report, and reporting it as COMMITTED
	// would attribute someone else's fence to this controller.
	if (result.committed === true && result.generation !== target.generation) {
		return {
			ok: false,
			state: COMMIT_STATE.FAILED,
			reason: "COMMITTED_GENERATION_MISMATCH",
			requestId: id,
			result,
		};
	}
	const state = classifyCommitResult(result);
	// C3 lists `expectedStatus` among the fields that must be verified before a
	// commit is accepted, and C4 lists "Result 狀態" among the fields the
	// correlation must check. Both were missing.
	//
	// Measured by independent review with a real `ResultCorrelator` and a correctly
	// signed frame: a runtime answering `status: "FAIL"` to a request for `PASS`
	// verified, correlated, and was returned as `ok:true COMMITTED`. A signature
	// proves WHO said it, not WHAT was asked for — the status is part of the
	// request/result correspondence, so it must be compared.
	//
	// WHAT IS COMPARED, AND WHY IT IS NOT OPTIONAL.
	//
	// The status this client asked for is the `status` argument — it is what the
	// command carried. Review caught the first version of this check gating on
	// `expectation.status`, which a normal caller never supplies (`expectation` is
	// the bound identity, which has no status field), so the check never ran. The
	// requested status is therefore always known here, and is compared always.
	//
	// The CONTRADICTORY_STATUS_EXPECTATION case is NOT here: review measured that
	// this position runs after dispatch, so a contradictory caller could have
	// committed before being told its input was invalid. That check now happens
	// before `runtime.request`, where a refusal writes nothing.
	const requestedStatus = status;
	if (state === COMMIT_STATE.COMMITTED && result.status !== requestedStatus) {
		return {
			ok: false,
			state: COMMIT_STATE.FAILED,
			reason: "COMMITTED_STATUS_MISMATCH",
			requestId: id,
			expectedStatus: requestedStatus,
			observedStatus: result.status ?? null,
			result,
		};
	}
	// A COMMITTED state has a second axis the frame reports separately:
	// `ledgerRecorded`. The predecessor's residual risk §6.8 is exactly this case —
	// the fence landed locally but the durable record did not. Collapsing it to
	// COMMITTED would tell a controller its commit survives a crash when it may
	// not; collapsing it to FAILED would deny a fence that really happened. It is
	// therefore COMMITTED_UNCONFIRMED: real, and not durable.
	if (state === COMMIT_STATE.COMMITTED && result.ledgerRecorded === false) {
		return {
			ok: false,
			state: COMMIT_STATE.COMMITTED_UNCONFIRMED,
			reason: result.ledgerError ? `COMMITTED_NOT_DURABLE: ${result.ledgerError}` : "COMMITTED_NOT_DURABLE",
			requestId: id,
			durable: false,
			result,
		};
	}
	return { ok: state === COMMIT_STATE.COMMITTED, state, requestId: id, durable: state === COMMIT_STATE.COMMITTED, result };
}

/**
 * Map a VERIFIED commit result onto the state machine.
 *
 * Every branch is a distinct observed fact, and the ordering matters: a result
 * that reports both a durable commit and a failed advance is COMMITTED, because
 * the fence did land.
 */
export function classifyCommitResult(result) {
	if (!result || typeof result !== "object") return COMMIT_STATE.FAILED;
	if (result.denial) {
		// A denial is a refusal, but a refusal that arrives after the fence landed
		// is still a landed fence. `committed` is the runtime's own record.
		return result.committed === true ? COMMIT_STATE.COMMITTED : COMMIT_STATE.DENIED;
	}
	if (result.committed === true) return COMMIT_STATE.COMMITTED;
	if (result.commitExecuted === true) return COMMIT_STATE.COMMIT_ATTEMPTED;
	if (result.handlerExecuted === true) return COMMIT_STATE.HANDLER_EXECUTED;
	if (result.commandAccepted === true) return COMMIT_STATE.COMMAND_ACCEPTED;
	return COMMIT_STATE.FAILED;
}

/**
 * Ask the LEDGER — not the runtime — whether a generation is durably committed.
 *
 * This is the only way to tell "the commit landed and the answer was lost" from
 * "the commit never happened" when the frame does not arrive. The ledger is the
 * durable statement; the frame is a report about it.
 *
 * @returns {"COMMITTED"|"NOT_COMMITTED"|"UNKNOWN"}
 */
export function probeLedgerForCommit(runtime, expectation = {}) {
	const stateDir = runtime?.stateDir;
	const sessionId = expectation.sessionId;
	const generation = expectation.generation;
	if (typeof stateDir !== "string" || typeof sessionId !== "string" || !Number.isSafeInteger(generation)) {
		return "UNKNOWN";
	}
	// R4: ONE ledger file per controller root, named explicitly. The old
	// `<stateDir>/<sessionId>.jsonl` name cannot be pre-opened by the controller,
	// and the controller is now the only party allowed to write the ledger path.
	const path =
		typeof runtime?.ledgerPath === "string" && runtime.ledgerPath.length > 0
			? runtime.ledgerPath
			: join(stateDir, "ledger.jsonl");
	if (!existsSync(path)) return "NOT_COMMITTED";
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return "UNKNOWN";
	}
	// THE MAC IS THE GATE (R4).
	//
	// This probe is the controller's only way to answer "did the commit land while
	// the answer was lost", so it must not be answerable by text. Every record is
	// verified against the controller's own ledger key before it counts:
	//
	//   * a hand-written line has no valid MAC, so it is not evidence — it can
	//     neither produce COMMITTED nor deny a legitimate commit;
	//   * a record signed by a DIFFERENT controller root does not verify here;
	//   * a record whose fields were edited after signing does not verify;
	//   * a torn final append is ignored, because a partial line is not a
	//     statement about anything.
	//
	// Records that fail are counted, never promoted. An unreadable file is
	// UNKNOWN, never NOT_COMMITTED: claiming knowledge a file does not provide is
	// how a "did it commit" question becomes a lie.
	// A FRESH CONTROLLER MUST BE ABLE TO READ ITS OWN ROOT'S LEDGER.
	//
	// The key is not carried in memory only: after a controller crash, the process
	// that reconciles is a NEW process that holds no launch state. It still owns
	// the root, and the key lives there with mode 0600 — so it is read from disk
	// when it was not supplied. This is the controller reading its own secret, not
	// a caller supplying one, which is why the path is derived from `stateDir`
	// rather than accepted as an argument.
	let key = runtime?.ledgerKey ?? null;
	if (typeof key !== "string" || !LEDGER_KEY_PATTERN.test(key)) {
		const rootDir = typeof runtime?.controllerRoot === "string" ? runtime.controllerRoot : dirname(stateDir);
		const keyPath = typeof runtime?.ledgerKeyPath === "string" ? runtime.ledgerKeyPath : join(rootDir, "ledger.key");
		try {
			const fromDisk = readFileSync(keyPath, "utf8").trim();
			if (LEDGER_KEY_PATTERN.test(fromDisk)) key = fromDisk;
		} catch {
			// Absent or unreadable: the probe cannot authenticate anything, and
			// UNKNOWN is the honest answer.
		}
	}
	if (typeof key !== "string" || !LEDGER_KEY_PATTERN.test(key)) return "UNKNOWN";
	const wantedRuntime = expectation.runtimeInstanceId;
	const wantedToken = expectation.allocationToken;
	const lines = text.split("\n");
	let sawCommit = false;
	let sawAllocation = false;
	let sawForeignCommit = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			// A partially written FINAL line is a torn append: the tail is not a
			// statement about anything, so it is skipped. A malformed line anywhere
			// else is not a controller record either — and because unauthenticated
			// text is not evidence, it is skipped rather than treated as corruption.
			// Treating it as corruption would hand the Agent a denial primitive.
			continue;
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) continue;
		if (record.type !== "commit" && record.type !== "allocate") continue;
		if (!Number.isSafeInteger(record.generation) || record.generation < 1) continue;
		if (typeof record.runtimeInstanceId !== "string" || record.runtimeInstanceId.length === 0) continue;
		// UNAUTHENTICATED RECORDS ARE NOT EVIDENCE.
		if (!verifyLedgerRecord(key, record)) continue;
		if (record.sessionId !== sessionId) continue;
		if (record.type === "allocate") sawAllocation = true;
		if (record.type !== "commit" || record.generation !== generation) continue;
		// An authenticated commit for this (session, generation) exists. Whether it
		// is OUR commit is a separate question, answered by the identity pins.
		if (typeof wantedRuntime === "string" && record.runtimeInstanceId !== wantedRuntime) {
			sawForeignCommit = true;
			continue;
		}
		if (typeof wantedToken === "string" && (record.allocationToken ?? null) !== wantedToken) {
			sawForeignCommit = true;
			continue;
		}
		sawCommit = true;
	}
	if (sawCommit) return "COMMITTED";
	// An authenticated commit for this generation by ANOTHER runtime is the
	// double-commit case: this generation is closed, but not by us. Reporting
	// COMMITTED would attribute someone else's fence to this controller.
	if (sawForeignCommit) return "UNKNOWN";
	// No commit record. That is a real answer only when the file is otherwise a
	// coherent ledger for this session; an empty or allocation-free file proves
	// nothing about a commit either way.
	return sawAllocation ? "NOT_COMMITTED" : "UNKNOWN";
}

/** Remove the controller's private material. Best effort; never throws. */
export function disposeControllerRoot(controllerRoot) {
	if (!controllerRoot) return;
	for (const path of [controllerRoot.lockDir, controllerRoot.stateDir, controllerRoot.childHome, controllerRoot.dir]) {
		if (typeof path !== "string") continue;
		try {
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Leaving a 0700 directory behind is not a failure of this call.
		}
	}
}

export { RESULT_KEY_PATTERN, RESULT_CHANNEL };
