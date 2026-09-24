// src/governance/verification-scope-guard.mjs
//
// VCA-1 Phase 0 bootstrap guard — VCA1-F1 (UNBOUNDED_VERIFICATION_SCOPE).
//
// Root cause: no code path in this repo hardcodes a whole-home grep/find.
// The 896s `grep -rl AWAITING_EXTERNAL_REVIEW ~` was agent-generated ad-hoc
// verification（category C）: nothing stopped an agent from improvising a
// broad filesystem scan instead of calling the authoritative reader
// (readCloseoutState / externalReviewSurfaceDir). This module is the single
// place that decides whether a verification root is authorized so both
// AutoLoop's own scripts and agent-generated shell commands have one gate
// to call before traversing.
//
// This is a bootstrap-scope guard (VCA-1 Phase 0), not the full VCA-1
// verification-budget system (durations/file-count/byte caps are VCA-1
// R1/W1 follow-on, not implemented here).

import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReviewArchive, resolveReviewSurface } from "../shared/autoloop-paths.mjs";

export const VERIFICATION_SCOPE_HOLDS = Object.freeze({
  UNBOUNDED: "VERIFICATION_SCOPE_UNBOUNDED",
});

/**
 * Roots verification is NEVER allowed to recursively traverse, and are
 * rejected even as an ancestor of a requested root (a request for "/" or
 * "~" is rejected outright; a request whose resolved path IS one of these
 * roots is also rejected — only a proper descendant of an authorized root
 * passes).
 */
function forbiddenRoots() {
  const home = resolve(homedir());
  return Object.freeze([resolve("/"), home]);
}

/**
 * Authorized bounded roots for production verification. Defaults to this
 * repo and the two known external-review surface dirs (mirrors
 * externalReviewSurfaceDir/externalReviewArchiveDir in review-bundle.mjs —
 * both resolve through src/shared/autoloop-paths.mjs, the single source of
 * truth for surface locations, so the guard and the deliverer can never
 * disagree about where the surface is).
 *
 * Additional roots may be passed explicitly by callers that know their own
 * authorized scope (e.g. a card's own outDir); nothing here infers roots
 * from traversal.
 */
export function defaultAuthorizedRoots({ env = process.env } = {}) {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const reviewSurface = resolveReviewSurface({ env });
  const reviewArchive = resolveReviewArchive({ env });
  return Object.freeze([resolve(repoRoot), resolve(reviewSurface), resolve(reviewArchive)]);
}

function isDescendantOrSame(candidate, root) {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Check whether `requestedRoot` is an authorized verification root.
 *
 * Returns { ok: true, resolved } or { ok: false, hold, reason }. Never
 * throws, never widens the search itself — callers that get ok:false MUST
 * stop and surface HOLD / VERIFICATION_SCOPE_UNBOUNDED, not retry with a
 * broader or different root on their own initiative.
 */
export function checkVerificationRoot(requestedRoot, { authorizedRoots = defaultAuthorizedRoots() } = {}) {
  if (typeof requestedRoot !== "string" || requestedRoot.trim() === "") {
    return { ok: false, hold: VERIFICATION_SCOPE_HOLDS.UNBOUNDED, reason: "empty root" };
  }

  const resolved = resolve(requestedRoot.replace(/^~(?=$|\/)/, homedir()));

  // Authorized roots are explicit, narrow exceptions carved out of broader
  // forbidden roots (e.g. an authorized review surface may live under
  // $HOME but is a known single-purpose surface, not a home-wide scan).
  // A request lands within scope only if it resolves inside one of these.
  const authorized = authorizedRoots.map((r) => resolve(r));
  const withinAuthorized = authorized.some((root) => isDescendantOrSame(resolved, root));
  if (withinAuthorized) {
    return { ok: true, resolved };
  }

  for (const forbidden of forbiddenRoots()) {
    if (isDescendantOrSame(resolved, forbidden)) {
      return {
        ok: false,
        hold: VERIFICATION_SCOPE_HOLDS.UNBOUNDED,
        reason: `resolved root ${resolved} is, or is under, forbidden root ${forbidden}, and not within any authorized root`,
      };
    }
  }

  return {
    ok: false,
    hold: VERIFICATION_SCOPE_HOLDS.UNBOUNDED,
    reason: `resolved root ${resolved} is not within any authorized root: ${authorized.join(", ")}`,
  };
}

/**
 * assertVerificationRoot — throws when checkVerificationRoot fails. For
 * call sites that want fail-closed control flow rather than branching on
 * the result object.
 */
export function assertVerificationRoot(requestedRoot, opts) {
  const result = checkVerificationRoot(requestedRoot, opts);
  if (!result.ok) {
    const err = new Error(`${result.hold}: ${result.reason}`);
    err.hold = result.hold;
    throw err;
  }
  return result.resolved;
}
