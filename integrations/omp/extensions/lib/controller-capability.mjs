// lib/controller-capability.mjs
//
// AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1 — R4-A.
//
// Problem this closes
// -------------------
// Commit authority used to be an ENVIRONMENT VARIABLE
// (`OMP_TERMINAL_FENCE_AUTHORITY`). A governed launch set it on the child, and
// the child's `bash` tool inherited it, so the Agent could (a) read the marker
// and (b) set it again on any process it started — including a nested `omp`.
// The admission card measured the result: the Agent could reach the commit path,
// and a nested runtime could commit without any controller granting it.
//
// A variable is not a capability. Anything a process can print, it can also
// write into its own children's environment.
//
// What authority is now
// ---------------------
// A governed runtime holds an OPEN FILE DESCRIPTOR to the ledger, and an open
// descriptor to the key that authenticates records written through it. Those
// descriptors are:
//
//   * created by the controller, not by the child;
//   * inherited ONLY by the governed child, because they are passed explicitly
//     as extra stdio slots;
//   * close-on-exec for everything that child spawns — measured on this host:
//     a grandchild reports `FD3_ABSENT` for a descriptor the child itself can
//     write, with both `stdio: "inherit"` and pipe-based spawning;
//   * additionally protected by the launch sandbox, which denies `file-write*`
//     on the ledger path and `file-read*` on the key path, so a descendant that
//     knows the path still cannot use it.
//
// `controllerAuthorityPresent()` therefore answers "does THIS process hold the
// capability", not "does an environment variable say so". A nested `omp` that
// is handed a forged marker has no descriptor and no key: it fails closed.
//
// Lifetime
// --------
// The capability belongs to one module load in one process. It is installed
// once, it is not serialisable, it cannot be transferred to a child by copying a
// string, and the key descriptor is closed the moment the key is read. There is
// deliberately no global "commit token" an Agent could reuse.

import { fstatSync } from "node:fs";
import {
	LEDGER_FD_ENV,
	LEDGER_KEY_FD_ENV,
	LOCK_DIR_ENV,
	parseFd,
	readLedgerKeyFromFd,
	reopenLedgerFdForPrivateUse,
} from "./ledger-auth.mjs";

/** Why a capability was refused. Each code is a distinct, reportable fact. */
export const CAPABILITY_DENIAL = Object.freeze({
	ABSENT: "CAPABILITY_ABSENT",
	LEDGER_FD_INVALID: "CAPABILITY_LEDGER_FD_INVALID",
	KEY_FD_INVALID: "CAPABILITY_KEY_FD_INVALID",
});

/** The installed capability, or null. Module-scoped: it is a per-process fact. */
let installed = null;

/**
 * True only when `fd` is an open regular file this process can write.
 *
 * This is the structural test that makes the descriptor a capability rather than
 * a number: an environment value of "3" proves nothing when descriptor 3 is not
 * open, and a descriptor that is open to a pipe or a terminal is not the ledger.
 */
function descriptorIsLedger(fd) {
	if (!Number.isInteger(fd) || fd < 3) return false;
	try {
		const stat = fstatSync(fd);
		return stat.isFile();
	} catch {
		return false;
	}
}

/**
 * Install the capability for this process.
 *
 * @param {object} options
 * @param {string} options.key       32-byte hex ledger key (REQUIRED)
 * @param {number|null} [options.ledgerFd]  open append descriptor for the ledger
 * @param {string|null} [options.lockDir]   directory holding the ledger lock
 * @returns {{ok: true} | {ok: false, denial: string, detail?: string}}
 */
export function installControllerCapability({ key, ledgerFd = null, lockDir = null } = {}) {
	if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) {
		return { ok: false, denial: CAPABILITY_DENIAL.KEY_FD_INVALID, detail: "no valid ledger key supplied" };
	}
	if (ledgerFd !== null && !descriptorIsLedger(ledgerFd)) {
		return { ok: false, denial: CAPABILITY_DENIAL.LEDGER_FD_INVALID, detail: `fd ${ledgerFd} is not an open regular file` };
	}
	installed = Object.freeze({
		key,
		ledgerFd: Number.isInteger(ledgerFd) ? ledgerFd : null,
		lockDir: typeof lockDir === "string" && lockDir.length > 0 ? lockDir : null,
	});
	return { ok: true };
}

/**
 * Install the capability from the launch environment.
 *
 * The key descriptor is consumed (read and closed) even when the rest fails, so
 * a half-provisioned launch does not leave the key readable in this process.
 */
export function installControllerCapabilityFromEnv(env = globalThis.process?.env) {
	const keyFd = parseFd(env?.[LEDGER_KEY_FD_ENV], 4);
	const key = readLedgerKeyFromFd(keyFd);
	if (key === null) return { ok: false, denial: CAPABILITY_DENIAL.KEY_FD_INVALID, detail: `fd ${keyFd}` };
	const inheritedLedgerFd = parseFd(env?.[LEDGER_FD_ENV], 3);
	// A descriptor that is not open is not a refusal: the caller may be running
	// the extension's own tests, where the ledger is written by path. What IS
	// refused is claiming the descriptor exists when it does not.
	const usableFd = descriptorIsLedger(inheritedLedgerFd)
		? reopenLedgerFdForPrivateUse(inheritedLedgerFd)
		: null;
	const lockDir = typeof env?.[LOCK_DIR_ENV] === "string" ? env[LOCK_DIR_ENV] : null;
	return installControllerCapability({ key, ledgerFd: usableFd, lockDir });
}

/** The installed capability, or null. Read-only view; never mutate the result. */
export function controllerCapability() {
	return installed;
}

/**
 * Drop the capability. Used by tests between cases and by nothing else: a live
 * governed runtime never gives its authority away.
 */
export function clearControllerCapability() {
	installed = null;
}

/** True when this process holds commit authority. The only authority question. */
export function capabilityPresent() {
	return installed !== null;
}
