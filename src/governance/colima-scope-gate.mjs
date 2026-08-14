// src/governance/colima-scope-gate.mjs
//
// VCA-1 W1A (S6) — `test:colima-all` scope gate.
//
// The audit（VCA-1 R1/R2 §2.3/§4 S6）found that per-card full
// `test:colima-all` re-runs（>420s, container-backed, unbounded in evidence）
// were executed for cards whose own change was memory / telemetry / docs /
// closeout-machinery — the same test content executed 2-3× per card. This
// module is the SINGLE place that decides whether a card is allowed to claim
// a full colima-all run:
//
//   - a card may run/claim colima-all iff it OWNS a colima-all suite member
//     （one of the 9 integration files）or its implementation touches the
//     runtime seams those suites exercise（src/runtime/, src/subagent/,
//     src/v2/durable*, src/v2/checkpoint-bridge, src/admission/, or a
//     runtime-driving probe script）;
//   - any other card is HOLD / COLIMA_ALL_NOT_AUTHORIZED and must substitute
//     the ta-line V17 regression set（~143s）instead.
//
// The closeout boundary（runMandatoryGraphCloseout in review-bundle.mjs）
// enforces this fail-closed: a closeout whose structured regression claims a
// colima-all run for a non-runtime card cannot PASS. `runColimaAllTimed`
// additionally records REAL wallMs / startedAt / completedAt for the run
//（S2 — the audit flagged colima-all as the largest single path with NO
// recorded total）.

import { runSuiteSync } from "./verification-timing.mjs";

export const COLIMA_ALL_HOLDS = Object.freeze({
  NOT_AUTHORIZED: "COLIMA_ALL_NOT_AUTHORIZED",
});

/** The 9 files that make up `test:colima-all`（package.json canonical list）. */
export const COLIMA_ALL_SUITE_FILES = Object.freeze([
  "test/test-colima-runtime.mjs",
  "test/test-c3-colima-pipeline.mjs",
  "test/test-colima-graph.mjs",
  "test/test-subagent-graph.mjs",
  "test/test-subagent-writer-graph.mjs",
  "test/test-subagent-review-repair-graph.mjs",
  "test/test-graph-closeout-integration.mjs",
  "test/test-durable-subagent-resume.mjs",
  "test/memory/test-graph-colima-writeback.mjs",
]);

/** Source seams whose behavior is exercised by the colima-all suite. */
export const COLIMA_RUNTIME_SEAM_PREFIXES = Object.freeze([
  "src/runtime/",
  "src/subagent/",
  "src/v2/durable",
  "src/v2/checkpoint-bridge",
  "src/admission/",
]);

/** Test files/prefixes that are part of the runtime graph surface. */
export const COLIMA_RUNTIME_TEST_PREFIXES = Object.freeze([
  "test/test-colima",
  "test/test-c3",
  "test/test-subagent",
  "test/test-durable",
  "test/test-graph-closeout",
  "test/v2/test-durable",
  "test/v2/test-subagent",
  "test/v2/test-checkpoint",
  "test/memory/test-graph-colima-writeback.mjs",
]);

/** One-shot probe/driver scripts that drive the Colima runtime. */
export const COLIMA_RUNTIME_DRIVER_PATTERNS = Object.freeze([
  /^scripts\/(de1|de1r|de2|de2r|colima|c3-)[^/]*\.mjs$/,
  /^scripts\/.*(colima|bakeoff|crash|resume|reproduction).*\.mjs$/,
]);

/** The substitute verification set for non-runtime cards（audit S6）. */
export const COLIMA_ALL_SUBSTITUTE =
  "ta-line V17 regression set (budget + admission + governance + scripted-lifecycle + telemetry + v2, ~143s measured)";

function normalizePath(p) {
  if (typeof p !== "string") return "";
  // strip trailing slashes + the full-width paren annotations some closeouts
  // append to file entries（e.g. "src/v2/review-evidence.mjs（…absorbed）"）.
  let s = p.trim();
  s = s.replace(/（.*$/u, "");
  s = s.replace(/\(.*$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}

function candidateSet(entries) {
  const out = new Set();
  for (const e of entries ?? []) {
    const n = normalizePath(e);
    if (n) out.add(n);
  }
  return out;
}

/**
 * Classify whether a card's own files touch the runtime/Colima surface.
 *
 * @param {object} opts — { authorizedScope, implementationFiles }
 *   implementationFiles（card's own delta）is preferred; authorizedScope is
 *   the fallback（legacy closeouts）.
 * @returns {{ touchesRuntime: boolean, matches: Array<{signal, path}> }}
 */
export function classifyColimaScope({ authorizedScope = [], implementationFiles = [] } = {}) {
  const candidates = candidateSet([...(implementationFiles ?? []), ...(authorizedScope ?? [])]);
  const matches = [];
  for (const c of candidates) {
    if (COLIMA_ALL_SUITE_FILES.includes(c)) {
      matches.push({ signal: "owns colima-all suite member", path: c });
      continue;
    }
    if (COLIMA_RUNTIME_SEAM_PREFIXES.some((p) => c === p.replace(/\/$/, "") || c.startsWith(p))) {
      matches.push({ signal: "runtime seam source", path: c });
      continue;
    }
    if (COLIMA_RUNTIME_TEST_PREFIXES.some((p) => c.startsWith(p))) {
      matches.push({ signal: "runtime graph test surface", path: c });
      continue;
    }
    if (COLIMA_RUNTIME_DRIVER_PATTERNS.some((re) => re.test(c))) {
      matches.push({ signal: "colima runtime driver script", path: c });
    }
  }
  return { touchesRuntime: matches.length > 0, matches };
}

/**
 * Decision gate: is this card authorized to run/claim test:colima-all?
 * Returns { ok:true, ...classification } or { ok:false, holdCode:
 * COLIMA_ALL_NOT_AUTHORIZED, substitute, ...classification }.
 */
export function assertColimaAllAuthorized({ cardId = "CARD", authorizedScope = [], implementationFiles = [] } = {}) {
  const cls = classifyColimaScope({ authorizedScope, implementationFiles });
  if (cls.touchesRuntime) {
    return { ok: true, ...cls };
  }
  return {
    ok: false,
    holdCode: COLIMA_ALL_HOLDS.NOT_AUTHORIZED,
    reason: `COLIMA_ALL_NOT_AUTHORIZED:${cardId} touches no runtime/Colima path; substitute ${COLIMA_ALL_SUBSTITUTE}`,
    substitute: COLIMA_ALL_SUBSTITUTE,
    ...cls,
  };
}

/**
 * Does this closeout's STRUCTURED regression claim a colima-all run?
 * Only structured suite entries count（"colima-all NOT re-run" notes are
 * explicitly not claims）— narrative prose is never scanned.
 */
export function colimaAllClaimed(closeout) {
  const reg = (closeout?.regression ?? []).filter(Boolean);
  return reg.some(
    (r) => typeof r.suite === "string"
      && r.suite.includes("colima-all")
      && !/NOT re-run|NOT_RUN|not re-run/i.test(r.suite),
  );
}

/**
 * Closeout-boundary gate（wired into runMandatoryGraphCloseout）: a closeout
 * claiming a colima-all run for a card whose own files do not touch the
 * runtime surface fails closed.
 */
export function assertColimaAllClaims({ closeout = {} } = {}) {
  if (!colimaAllClaimed(closeout)) {
    return { ok: true, claimed: false, touchesRuntime: false, matches: [] };
  }
  const implementationFiles = Array.isArray(closeout?.cardFiles?.cardImplementation)
    ? closeout.cardFiles.cardImplementation
    : [];
  const decision = assertColimaAllAuthorized({
    cardId: closeout?.cardId ?? "CARD",
    authorizedScope: closeout?.authorizedScope ?? [],
    implementationFiles,
  });
  return { ...decision, claimed: true };
}

/**
 * Run the real `test:colima-all` npm suite with REAL timing instrumentation.
 * Only call after assertColimaAllAuthorized returned ok:true. Returns
 * { ok, tests, passed, failed, startedAt, completedAt, wallMs, timingSource }.
 */
export function runColimaAllTimed({ cwd, timeoutMs = 2400000 } = {}) {
  const r = runSuiteSync(["npm", "run", "test:colima-all"], { cwd, timeoutMs });
  return { suite: "test:colima-all", ...r };
}
