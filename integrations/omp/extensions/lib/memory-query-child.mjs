/**
 * memory-query-child.mjs — the runner that answers one EKM query OUTSIDE the
 * trust boundary.
 *
 * CARD = AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `cbm-query.js` is loaded into the OMP process, and under a governed launch that
 * process holds the controller capability (an inherited ledger descriptor). It
 * used to import `<session-cwd>/src/memory/index.mjs` there, so an Agent that
 * wrote that file got code execution in the trust boundary — measured, not
 * theorised.
 *
 * The memory module is data-side, read-only code. It does not need the
 * capability, so it does not get a process that has one.
 *
 * CONTRACT WITH THE PARENT (`queryCodebaseMemoryOutOfProcess`)
 * ------------------------------------------------------------
 *   argv[2]  = JSON `{ cwd, stateRoot, terms, path, symbol, recordTypes,
 *                      trustFloor, validityPolicy, maxRecords, repoRoot }`
 *   stdout   = exactly one JSON line: `{ ok: true, result }` or `{ ok: false, reason }`
 *
 * Nothing else is written to stdout — the parent reads the last line, and a store
 * that logged there would corrupt the protocol. `process.exit(0)` is used even on
 * refusal: the refusal is the ANSWER, and a non-zero exit would be
 * indistinguishable from a crash to a caller that only looks at the code.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	LEDGER_FD_ENV,
	LEDGER_KEY_FD_ENV,
	LOCK_DIR_ENV,
} from "./ledger-auth.mjs";
import { RESULT_KEY_ENV } from "./controller-result.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Variables that carry or point at controller authority. None may be present.
 *
 * Taken from the modules that DEFINE them rather than retyped, so a rename cannot
 * leave this guard checking a name nothing uses any more.
 */
const AUTHORITY_ENV = Object.freeze([
	LEDGER_FD_ENV,
	LEDGER_KEY_FD_ENV,
	LOCK_DIR_ENV,
	RESULT_KEY_ENV,
	"OMP_TERMINAL_FENCE_STATE_DIR",
	"OMP_TERMINAL_FENCE_AUTHORITY",
	"OMP_CONTROLLER_RESULT_TRANSPORT",
]);

function refuse(reason) {
	process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`);
	process.exit(0);
}

// Fail closed and loudly. Reaching here means the isolation boundary was
// bypassed, and a process that holds authority must never be the one that loads
// agent-reachable code.
for (const name of AUTHORITY_ENV) {
	if (typeof process.env[name] === "string" && process.env[name].length > 0) {
		refuse(`memory query runner refused: authority variable ${name} is present in its environment`);
	}
}

let job;
try {
	job = JSON.parse(process.argv[2] ?? "{}");
} catch {
	refuse("memory query runner received a job that is not JSON");
}
if (!job || typeof job !== "object") refuse("memory query runner received no job");

const cwd = typeof job.cwd === "string" && job.cwd.length > 0 ? job.cwd : process.cwd();

// The extension's read path, as a plain library. It imports no checkout at module
// scope; the only `import()` is inside `loadMemoryModules()`, which runs HERE.
const core = await import(join(HERE, "memory-query-core.mjs"));

const repoRoot = typeof job.repoRoot === "string" && job.repoRoot.length > 0 ? job.repoRoot : null;
// `allowSessionCwd: true` is safe HERE and only here: this process holds no
// capability, so a checkout the Agent steered it toward still cannot reach the
// ledger. The governed process never passes this flag.
const modules = await core.loadMemoryModules({ repoRoot, cwd, allowSessionCwd: true });

const result = await core.queryWithModules({
	modules,
	cwd,
	stateRoot: typeof job.stateRoot === "string" && job.stateRoot.length > 0 ? job.stateRoot : null,
	terms: job.terms ?? null,
	path: job.path ?? null,
	symbol: job.symbol ?? null,
	recordTypes: Array.isArray(job.recordTypes) ? job.recordTypes : null,
	trustFloor: typeof job.trustFloor === "string" ? job.trustFloor : "VERIFIED",
	validityPolicy: typeof job.validityPolicy === "string" ? job.validityPolicy : "CURRENT",
	maxRecords: Number.isInteger(job.maxRecords) ? job.maxRecords : 20,
});

process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
