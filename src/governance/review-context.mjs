// src/governance/review-context.mjs
//
// Shared "current review context" recomputation (AUTOLOOP-GOVERNANCE-REVIEW-
// UNIT-FINALIZATION-1 §8/§9/§11). Every gate that consumes an external
// review result artifact must RECOMPUTE these identities from actual state —
// never trust CLI-passed values:
//
//   changedTreeIdentity  from the change inventory
//   patchSha256          from the change inventory content
//   bundleSha256         from the actual bundle file (digest footer stripped)
//   currentHead/baseHead from git
//   repository/branch    from authority + git
//
// The bundle generator and the gates share this module so the identity
// contract is one code path.

import { readFileSync } from "node:fs";
import { sha256Text } from "../evidence/run-evidence-store.mjs";
import { buildChangeInventory } from "./change-inventory.mjs";

const BUNDLE_DIGEST_MARKER = "BUNDLE_SHA256";

/** Digest of a bundle file text, stripping the trailing digest footer. */
export function bundleDigestFromFile(text) {
  const lines = String(text).split("\n");
  // scan from the end; the footer is the LAST line that STARTS with the marker
  // (earlier lines containing the marker text inside the patch are ignored)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith(BUNDLE_DIGEST_MARKER)) {
      // preserve the trailing newline that the generator's bundle string owns
      return sha256Text(lines.slice(0, i).join("\n") + (i > 0 ? "\n" : ""));
    }
  }
  return sha256Text(String(text));
}

/**
 * Recompute the current review context.
 *
 * @param {object} env
 * @param {object} env.authority — effective authority (record with bindings)
 * @param {object} env.inventory — prebuilt change inventory (optional)
 * @param {string} [env.bundlePath] — canonical bundle file path (for bundleSha256)
 * @param {string} env.cardId / env.runId / env.reviewRound / env.agentIdentity
 * @returns current context object
 */
export function computeReviewContext({ authority, inventory, bundlePath, cardId, runId, reviewRound, agentIdentity }) {
  const changedTreeIdentity = inventory.changedTreeIdentity;
  const patchSha256 = inventory.patchSha256;
  let bundleSha256 = "";
  if (bundlePath) {
    try {
      bundleSha256 = bundleDigestFromFile(readFileSync(bundlePath, "utf8"));
    } catch {
      bundleSha256 = ""; // bundle file unavailable — identity cannot be verified
    }
  }
  const currentHead = inventory.head;
  const baseHead = inventory.baseHead;
  const repository = authority?.repository ?? "";
  const branch = authority?.branch ?? inventory.branch;
  const baseBranch = inventory.baseBranch;
  return {
    changedTreeIdentity,
    patchSha256,
    bundleSha256,
    currentHead,
    baseHead,
    repository,
    branch,
    baseBranch,
    cardId,
    runId,
    reviewRound,
    agentIdentity,
  };
}
