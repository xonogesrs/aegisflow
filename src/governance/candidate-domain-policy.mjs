// src/governance/candidate-domain-policy.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2-FREEZE-R2 — single authority-owned classifier of
// the candidate domain (E1-A). Answers one question per path:
//
//   is this path part of the implementation candidate domain?
//
// Default is INCLUDE. A path is EXCLUDED only when it POSITIVELY matches the
// canonical generated governance/evidence domain:
//
//   (1) canonical governance root     — docs/pi-graph-output (the security
//                                       boundary: nothing outside is ever
//                                       excludable);
//   (2) recognized producer/domain    — the root is exclusively owned by the
//                                       review lifecycle (artifact model);
//   (3) recognized artifact class     — "generated", i.e. any path under the
//                                       root that is NOT a human-authored
//                                       card spec;
//   (4) valid card/generation naming  — card segment + gNNNN, subsumed by the
//                                       root-owned, card-spec-excepted rule.
//
// The ONLY human-authored class inside the root is the card spec
// (`<CARD>-card-spec.md`) and it is positively preserved as INCLUDE. A
// disguised source under src/ (e.g. src/foo/review-findings.g0001.json) is
// never excludable because it fails dimension (1).

const GOVERNANCE_ROOT = "docs/pi-graph-output";

// Human-authored card spec (the WHAT). Positively preserved (§8): a bare
// `docs/pi-graph-output/**` exclusion that drops these is forbidden.
const CARD_SPEC_SUFFIX_RE = /-card-spec\.md$/i;

/** Normalize a repo-relative or absolute path to a forward-slash, no-prefix form. */
function normalizeRelPath(p) {
  let s = String(p ?? "").replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.slice(1);
  return s;
}

function underGovernanceRoot(rel) {
  return rel === GOVERNANCE_ROOT || rel.startsWith(GOVERNANCE_ROOT + "/");
}

/**
 * Classify a path into the candidate domain.
 *
 * @param {string} path — repo-relative path (forward slashes) as produced by
 *   git; absolute paths are normalized best-effort.
 * @returns {"INCLUDE" | "EXCLUDE"}
 */
export function candidateDomain(path) {
  const rel = normalizeRelPath(path);
  // (1) canonical governance root — the security boundary.
  if (!underGovernanceRoot(rel)) return "INCLUDE";
  // Human-authored card spec — positively preserved.
  if (CARD_SPEC_SUFFIX_RE.test(rel)) return "INCLUDE";
  // (2)-(4) recognized generated governance/evidence class.
  return "EXCLUDE";
}

/** Predicate form for buildChangeInventory. */
export function isCandidatePath(path) {
  return candidateDomain(path) !== "EXCLUDE";
}

export { GOVERNANCE_ROOT, CARD_SPEC_SUFFIX_RE };
