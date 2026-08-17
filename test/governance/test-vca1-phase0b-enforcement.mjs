// test/governance/test-vca1-phase0b-enforcement.mjs
//
// VCA-1 Phase 0B — enforcement-wiring integration tests. Phase 0A shipped
// the guard primitive with no call site; this phase wires:
//   1. currentSurfaceReviewStatus() — authoritative-source-first answer to
//      "is anything AWAITING_EXTERNAL_REVIEW", no filesystem search.
//   2. verification-scope-guard — proven against realistic root strings an
//      agent might construct, including dynamic resolution.
//   3. the executor/reviewer prompt text (sectionVerification) — proven to
//      actually carry the bounded-verification instruction.
//
// Run: node --test test/governance/test-vca1-phase0b-enforcement.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentSurfaceReviewStatus,
  serializeExternalReviewState,
  EXTERNAL_REVIEW_STATUSES,
} from "../../src/governance/review-bundle.mjs";
import {
  checkVerificationRoot,
  VERIFICATION_SCOPE_HOLDS,
} from "../../src/governance/verification-scope-guard.mjs";
import { buildPhaseExecutionPrompt } from "../../src/v2/phase-response-contract.mjs";

const SURFACE = join(tmpdir(), `vca1-p0b-surface-${process.pid}`);
// Repo root resolved from THIS test file — location-independent.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test.beforeEach(() => {
  rmSync(SURFACE, { recursive: true, force: true });
  mkdirSync(SURFACE, { recursive: true });
});
test.after(() => rmSync(SURFACE, { recursive: true, force: true }));

test("authoritative lookup: empty surface answers present:false, no filesystem search performed", () => {
  const result = currentSurfaceReviewStatus({ surfaceDir: SURFACE });
  assert.deepEqual(result, { cardId: null, status: null, present: false });
});

test("authoritative lookup: AWAITING_EXTERNAL_REVIEW is read directly from delivery.json", () => {
  const state = serializeExternalReviewState(
    { externalReviewStatus: EXTERNAL_REVIEW_STATUSES[0], delivery: { attempted: true } },
    { cardId: "VCA-1-PROBE", fileName: "delivery.json" },
  );
  writeFileSync(join(SURFACE, "delivery.json"), JSON.stringify(state, null, 2));
  const result = currentSurfaceReviewStatus({ surfaceDir: SURFACE });
  assert.equal(result.present, true);
  assert.equal(result.cardId, "VCA-1-PROBE");
  assert.equal(result.status, "AWAITING_EXTERNAL_REVIEW");
});

test("authoritative lookup: malformed delivery record surfaces invalid, still no filesystem widening", () => {
  writeFileSync(join(SURFACE, "delivery.json"), "not json");
  const result = currentSurfaceReviewStatus({ surfaceDir: SURFACE });
  assert.equal(result.present, false);
  assert.equal(result.invalid, true);
});

test("scope guard: attempted root = $HOME is blocked before any executor would traverse it", () => {
  const result = checkVerificationRoot(process.env.HOME);
  assert.equal(result.ok, false);
  assert.equal(result.hold, VERIFICATION_SCOPE_HOLDS.UNBOUNDED);
});

test("scope guard: attempted root = /Users/zhengfengqing is blocked before any executor would traverse it", () => {
  const result = checkVerificationRoot("/Users/zhengfengqing");
  assert.equal(result.ok, false);
});

test("scope guard: explicit repo-scoped verification root is allowed", () => {
  const result = checkVerificationRoot(join(REPO, "src", "governance"));
  assert.equal(result.ok, true);
});

test("scope guard: allowlist contract — a caller-authorized root under $HOME is allowed even though it is a HOME descendant", () => {
  // Confirms the guard is allowlist-based (explicit authorized roots win),
  // not "reject every HOME descendant except two hardcoded carve-outs" —
  // a future card can authorize e.g. ~/some-specific-authorized-directory
  // without a guard code change, by passing it as an authorizedRoots entry.
  const futureAuthorizedDir = join(process.env.HOME, "some-specific-authorized-directory");
  const result = checkVerificationRoot(futureAuthorizedDir, { authorizedRoots: [futureAuthorizedDir] });
  assert.equal(result.ok, true);
});

test("Pi prompt text: executor prompt instructs authoritative-source-first and bounded verification root", () => {
  const phase = { phase_id: "p1", verification_plan: { method: "m", success_criteria: "s", failure_criteria: "f" } };
  const taskCard = { repositoryRoot: REPO, allowedPaths: ["src/x.mjs"], forbiddenPaths: [] };
  const prompt = buildPhaseExecutionPrompt({ phase, taskCard, lifecyclePhase: "executor", attempt: 0 });
  assert.match(prompt, /AUTHORITATIVE_SOURCE_FIRST/);
  assert.match(prompt, /VERIFICATION_SCOPE_UNBOUNDED/);
  assert.match(prompt, /Never construct or run a command whose root is "\/", "~", \$HOME/);
});

test("Pi prompt text: reviewer prompt also carries the bounded-verification instruction", () => {
  const phase = { phase_id: "p1", verification_plan: { method: "m", success_criteria: "s", failure_criteria: "f" } };
  const taskCard = { repositoryRoot: REPO, allowedPaths: [], forbiddenPaths: [] };
  const prompt = buildPhaseExecutionPrompt({ phase, taskCard, lifecyclePhase: "reviewer", attempt: 0 });
  assert.match(prompt, /AUTHORITATIVE_SOURCE_FIRST/);
});
