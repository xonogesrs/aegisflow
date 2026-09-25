// test/test-env-compatibility.mjs
//
// Brand-rename compatibility contract
// (AEGISFLOW_PROJECT_RENAME_AND_COMPATIBILITY_MIGRATION_1).
//
// The project was renamed from AutoLoop to AegisFlow. That rename MUST NOT
// break an existing deployment, so this suite pins the two halves of the
// compatibility promise:
//
//   1. LEGACY ONLY   — a deployment that exports only the pre-rename
//                      `AUTOLOOP_*` names resolves exactly what it used to.
//   2. NEW ONLY      — a deployment that exports the `AEGISFLOW_*` names
//                      resolves the same values.
//   3. BOTH SUPPLIED — the pre-rename name is IGNORED. The AegisFlow name
//                      always wins, deterministically, never merged and never
//                      decided by presence order.
//   4. PERSISTED IDENTITY IS FROZEN — the `autoloop.*` schema ids, the
//                      `~/.autoloop` default namespace and the evidence /
//                      telemetry namespace children are unchanged, because a
//                      branding rename must never require a state migration.
//
// Every assertion is behavioural: it drives the real resolvers with an explicit
// env object. Nothing here reads or writes the operator's real state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  AEGISFLOW_HOME_ENV,
  EVIDENCE_ROOT_ENV,
  LEARNING_ROOT_ENV,
  LEGACY_ENV_PREFIX,
  SCRATCH_ROOT_ENV,
  TELEMETRY_ROOT_ENV,
  autoloopHome,
  colimaMountGate,
  legacyEnvName,
  readConfigEnv,
  resolveEvidenceRoot,
  resolveLearningRoot,
  resolveReviewArchive,
  resolveReviewSurface,
  resolveScratchRoot,
  resolveTelemetryRoot,
  REVIEW_ARCHIVE_ENV,
  REVIEW_SURFACE_ENV,
} from "../src/shared/autoloop-paths.mjs";
import { TELEMETRY_STATE_ROOT_ENV, resolveTelemetryStateRoot } from "../src/telemetry/location.mjs";
import {
  COLIMA_PROFILE_LOCK_ROOT_ENV,
  colimaProfileLockDefaultRoot,
} from "../src/runtime/colima-profile-lock.mjs";
import { frozenRuntimeIdentity, PI_RUNTIME_PATH_ENV } from "../src/admission/policy-projection.mjs";

/** A dedicated volume outside $HOME, the shape a real deployment uses. */
const LEGACY_HOME = "/Volumes/Deployment/state";
const BRAND_HOME = "/Volumes/Deployment/aegisflow-state";

/** Build an env from explicit pairs, dropping nothing (blank values included). */
const mk = (o) => ({ ...o });

// ---------------------------------------------------------------------------
// T1–T4: the reader's precedence rule, in isolation.
// ---------------------------------------------------------------------------

test("T1 legacy name maps to the brand name (and the reverse)", () => {
  assert.equal(legacyEnvName("AEGISFLOW_HOME"), "AUTOLOOP_HOME");
  assert.equal(legacyEnvName("AEGISFLOW_PI_RUNTIME_PATH"), "AUTOLOOP_PI_RUNTIME_PATH");
  assert.equal(LEGACY_ENV_PREFIX, "AUTOLOOP_");
});

test("T2 readConfigEnv: legacy only, brand only, and both", () => {
  const legacyOnly = readConfigEnv(mk({ AUTOLOOP_HOME: LEGACY_HOME }), "AEGISFLOW_HOME");
  assert.deepEqual(legacyOnly, { name: "AUTOLOOP_HOME", value: LEGACY_HOME });

  const brandOnly = readConfigEnv(mk({ AEGISFLOW_HOME: BRAND_HOME }), "AEGISFLOW_HOME");
  assert.deepEqual(brandOnly, { name: "AEGISFLOW_HOME", value: BRAND_HOME });

  // BOTH SUPPLIED, DIFFERENT VALUES: the brand name wins.
  const both = readConfigEnv(mk({ AEGISFLOW_HOME: BRAND_HOME, AUTOLOOP_HOME: LEGACY_HOME }), "AEGISFLOW_HOME");
  assert.deepEqual(both, { name: "AEGISFLOW_HOME", value: BRAND_HOME });

  // …and the answer does not depend on key order in the object.
  const reversed = readConfigEnv(mk({ AUTOLOOP_HOME: LEGACY_HOME, AEGISFLOW_HOME: BRAND_HOME }), "AEGISFLOW_HOME");
  assert.deepEqual(reversed, both);
});

test("T3 readConfigEnv: neither set, and a blank value never shadows a real one", () => {
  assert.equal(readConfigEnv(mk({}), "AEGISFLOW_HOME"), null);
  // A blank brand value is UNSET, so the legacy value still applies.
  assert.deepEqual(
    readConfigEnv(mk({ AEGISFLOW_HOME: "   ", AUTOLOOP_HOME: LEGACY_HOME }), "AEGISFLOW_HOME"),
    { name: "AUTOLOOP_HOME", value: LEGACY_HOME },
  );
  // Both blank ⇒ unset (no empty-string root is ever produced).
  assert.equal(readConfigEnv(mk({ AEGISFLOW_HOME: "", AUTOLOOP_HOME: "  " }), "AEGISFLOW_HOME"), null);
});

test("T4 the brand constants name the brand variables, not the legacy ones", () => {
  for (const name of [AEGISFLOW_HOME_ENV, EVIDENCE_ROOT_ENV, TELEMETRY_ROOT_ENV, LEARNING_ROOT_ENV, SCRATCH_ROOT_ENV, REVIEW_SURFACE_ENV, REVIEW_ARCHIVE_ENV, TELEMETRY_STATE_ROOT_ENV, COLIMA_PROFILE_LOCK_ROOT_ENV, PI_RUNTIME_PATH_ENV]) {
    assert.match(name, /^AEGISFLOW_/, `${name} must carry the brand prefix`);
    assert.doesNotMatch(name, /^AUTOLOOP_/);
  }
});

// ---------------------------------------------------------------------------
// T5–T9: the real resolvers, driven through both spellings.
// ---------------------------------------------------------------------------

test("T5 AUTOLOOP_HOME alone resolves the same roots it always did", () => {
  const env = mk({ AUTOLOOP_HOME: LEGACY_HOME });
  assert.equal(autoloopHome({ env }), resolve(LEGACY_HOME));
  assert.equal(resolveEvidenceRoot({ env }), join(resolve(LEGACY_HOME), "evidence", "autoloop"));
  assert.equal(resolveTelemetryRoot({ env }), join(resolve(LEGACY_HOME), "evidence", "autoloop-telemetry"));
  assert.equal(resolveLearningRoot({ env }), join(resolve(LEGACY_HOME), "learning") + "/");
  assert.equal(resolveScratchRoot({ env }), join(resolve(LEGACY_HOME), "learning", "scratch"));
  assert.equal(resolveReviewSurface({ env }), join(resolve(LEGACY_HOME), "review", "Current"));
  assert.equal(resolveReviewArchive({ env }), join(resolve(LEGACY_HOME), "review", "Archive"));
});

test("T6 AEGISFLOW_HOME alone resolves the identical root set", () => {
  const legacy = resolve(resolveEvidenceRoot({ env: mk({ AUTOLOOP_HOME: LEGACY_HOME }) }).replace(/evidence.*$/, ""));
  const brand = resolve(resolveEvidenceRoot({ env: mk({ AEGISFLOW_HOME: LEGACY_HOME }) }).replace(/evidence.*$/, ""));
  assert.equal(brand, legacy, "the same directory is reached through either name");
  assert.equal(
    resolveScratchRoot({ env: mk({ AEGISFLOW_HOME: LEGACY_HOME }) }),
    resolveScratchRoot({ env: mk({ AUTOLOOP_HOME: LEGACY_HOME }) }),
  );
});

test("T7 both names, different values: AegisFlow wins for every resolver", () => {
  const env = mk({ AEGISFLOW_HOME: BRAND_HOME, AUTOLOOP_HOME: LEGACY_HOME });
  assert.equal(autoloopHome({ env }), resolve(BRAND_HOME));
  assert.equal(resolveEvidenceRoot({ env }), join(resolve(BRAND_HOME), "evidence", "autoloop"));
  assert.equal(resolveScratchRoot({ env }), join(resolve(BRAND_HOME), "learning", "scratch"));
  assert.equal(resolveReviewSurface({ env }), join(resolve(BRAND_HOME), "review", "Current"));
});

test("T8 a per-root override follows the same rule (evidence root)", () => {
  const legacyRoot = "/Volumes/Deployment/legacy-evidence";
  const brandRoot = "/Volumes/Deployment/brand-evidence";
  assert.equal(resolveEvidenceRoot({ env: mk({ AUTOLOOP_EVIDENCE_ROOT: legacyRoot }) }), resolve(legacyRoot));
  assert.equal(resolveEvidenceRoot({ env: mk({ AEGISFLOW_EVIDENCE_ROOT: brandRoot }) }), resolve(brandRoot));
  assert.equal(
    resolveEvidenceRoot({ env: mk({ AEGISFLOW_EVIDENCE_ROOT: brandRoot, AUTOLOOP_EVIDENCE_ROOT: legacyRoot }) }),
    resolve(brandRoot),
    "brand wins when both are supplied",
  );
});

test("T9 the telemetry state-root override follows the same rule", () => {
  const legacyRoot = "/Volumes/Deployment/legacy-telemetry/g1";
  const brandRoot = "/Volumes/Deployment/brand-telemetry/g1";
  assert.equal(resolveTelemetryStateRoot({ graphRunId: "g1", env: mk({ AUTOLOOP_TELEMETRY_STATE_ROOT: legacyRoot }) }), resolve(legacyRoot));
  assert.equal(resolveTelemetryStateRoot({ graphRunId: "g1", env: mk({ AEGISFLOW_TELEMETRY_STATE_ROOT: brandRoot }) }), resolve(brandRoot));
  assert.equal(
    resolveTelemetryStateRoot({ graphRunId: "g1", env: mk({ AEGISFLOW_TELEMETRY_STATE_ROOT: brandRoot, AUTOLOOP_TELEMETRY_STATE_ROOT: legacyRoot }) }),
    resolve(brandRoot),
    "brand wins when both are supplied",
  );
});

// ---------------------------------------------------------------------------
// T10–T12: the partial-gate and identity fences survive the alias.
// ---------------------------------------------------------------------------

test("T10 the Colima mount gate accepts either spelling and still refuses a partial gate", () => {
  const mount = "/Volumes/Deployment";
  const uuid = "11111111-2222-3333-4444-555555555555";
  assert.deepEqual(colimaMountGate({ env: mk({ AUTOLOOP_COLIMA_MOUNT: mount, AUTOLOOP_COLIMA_MOUNT_UUID: uuid }) }), { mount, uuid });
  assert.deepEqual(colimaMountGate({ env: mk({ AEGISFLOW_COLIMA_MOUNT: mount, AEGISFLOW_COLIMA_MOUNT_UUID: uuid }) }), { mount, uuid });
  // Mixed spellings are NOT composable: a legacy uuid with a brand mount is a
  // partial gate, and a partial gate fails closed rather than silently
  // disabling the check.
  assert.equal(colimaMountGate({ env: mk({ AEGISFLOW_COLIMA_MOUNT: mount }) }), null);
  assert.equal(colimaMountGate({ env: mk({ AUTOLOOP_COLIMA_MOUNT: mount }) }), null);
});

test("T11 the profile-lock root resolves through both spellings", () => {
  const legacyRoot = "/Volumes/Deployment/legacy-locks";
  const brandRoot = "/Volumes/Deployment/brand-locks";
  assert.equal(colimaProfileLockDefaultRoot({ env: mk({ AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT: legacyRoot }) }), resolve(legacyRoot));
  assert.equal(colimaProfileLockDefaultRoot({ env: mk({ AEGISFLOW_COLIMA_PROFILE_LOCK_ROOT: brandRoot }) }), resolve(brandRoot));
  assert.equal(
    colimaProfileLockDefaultRoot({ env: mk({ AEGISFLOW_COLIMA_PROFILE_LOCK_ROOT: brandRoot, AUTOLOOP_COLIMA_PROFILE_LOCK_ROOT: legacyRoot }) }),
    resolve(brandRoot),
  );
});

test("T12 the pinned runtime identity resolves through both spellings", () => {
  // A real, existing absolute artifact: this file is one.
  const self = resolve(new URL(import.meta.url).pathname);
  assert.equal(frozenRuntimeIdentity({ env: mk({ AUTOLOOP_PI_RUNTIME_PATH: self }) }).realpath, self);
  assert.equal(frozenRuntimeIdentity({ env: mk({ AEGISFLOW_PI_RUNTIME_PATH: self }) }).realpath, self);
  assert.equal(
    frozenRuntimeIdentity({ env: mk({ AEGISFLOW_PI_RUNTIME_PATH: self, AUTOLOOP_PI_RUNTIME_PATH: "/nope/pi" }) }).realpath,
    self,
    "the legacy path is ignored when the brand path is set",
  );
});

// ---------------------------------------------------------------------------
// T13–T15: persisted identity is frozen — no state migration is required.
// ---------------------------------------------------------------------------

test("T13 the state namespace default is still ~/.autoloop", () => {
  assert.equal(autoloopHome({ env: mk({}) }), join(homedir(), ".autoloop"));
  // …and a home-namespace state root outside it is still refused.
  assert.throws(
    () => resolveEvidenceRoot({ env: mk({ AEGISFLOW_EVIDENCE_ROOT: join(homedir(), "Documents", "evidence") }) }),
    /AUTOLOOP_ROOT_IN_HOME_NAMESPACE/,
  );
});

test("T14 the evidence and telemetry namespace children are unchanged", () => {
  const env = mk({ AUTOLOOP_HOME: LEGACY_HOME });
  // These directory names are written to disk and read back as storage
  // identities: renaming them WOULD require a state migration.
  assert.equal(resolveEvidenceRoot({ env }), join(resolve(LEGACY_HOME), "evidence", "autoloop"));
  assert.equal(resolveTelemetryRoot({ env }), join(resolve(LEGACY_HOME), "evidence", "autoloop-telemetry"));
});

test("T15 the persisted schema identifiers still carry the autoloop namespace", async () => {
  const { TELEMETRY_STORE_SCHEMA, TELEMETRY_EVENT_SCHEMA, TELEMETRY_AGGREGATE_SCHEMA } = await import("../src/telemetry/contract.mjs");
  const { ADMISSION_SCHEMA } = await import("../src/admission/admission-record.mjs");
  const { MEMORY_JOURNAL_EVENT_SCHEMA } = await import("../src/memory/contract.mjs");
  const { HARNESS_EVIDENCE_FORMAT } = await import("../src/v2/harness-evidence.mjs");
  const { EVOLUTION_POLICY_SCHEMA } = await import("../src/evolution/policy.mjs");
  const ids = [
    TELEMETRY_STORE_SCHEMA, TELEMETRY_EVENT_SCHEMA, TELEMETRY_AGGREGATE_SCHEMA,
    ADMISSION_SCHEMA, MEMORY_JOURNAL_EVENT_SCHEMA, HARNESS_EVIDENCE_FORMAT, EVOLUTION_POLICY_SCHEMA,
  ];
  for (const id of ids) {
    assert.match(id, /^autoloop\./, `${id} must keep its persisted identifier`);
    assert.doesNotMatch(id, /aegisflow/i);
  }
});

test("T16 the commit trailer keys and the retention ref namespace are unchanged", async () => {
  const { readFileSync } = await import("node:fs");
  // Trailer keys: commit history already contains them, so they are machine
  // identity that a branding rename must not touch.
  const gate = readFileSync(new URL("../src/governance/checkpoint-commit-gate.mjs", import.meta.url), "utf8");
  for (const key of ["AutoLoop-Card:", "AutoLoop-Run:", "AutoLoop-Milestone:"]) {
    assert.ok(gate.includes(key), `${key} must remain the emitted trailer key`);
  }
  // Retention refs are written into the git object store.
  const candidate = readFileSync(new URL("../src/c2d/reviewed-commit-candidate.mjs", import.meta.url), "utf8");
  assert.match(candidate, /refs\/autoloop\/candidates\//);
});

// ---------------------------------------------------------------------------
// T17: the same precedence through a REAL child process.
//
// The tests above inject env objects. This one spawns the actual operator CLI,
// so the `process.env` path a deployment really takes is covered too — and it
// proves the legacy-only deployment is not merely resolvable but runnable.
// ---------------------------------------------------------------------------

test("T17 a spawned CLI honors legacy-only, brand-only and brand-wins precedence", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");

  // Canonicalize the fixtures: a DEFAULT root is resolved through the deepest
  // existing prefix (macOS /var → /private/var), so the expectation must be
  // built from the real path or the comparison would fail on the symlink.
  const legacyRoot = realpathSync(mkdtempSync(join(tmpdir(), "aegisflow-compat-legacy-")));
  const brandRoot = realpathSync(mkdtempSync(join(tmpdir(), "aegisflow-compat-brand-")));
  const runId = "g-env-compat";
  const cli = join(new URL("..", import.meta.url).pathname, "scripts", "aegisflow-operator.mjs");

  const stateRootFor = (extraEnv) => {
    // Strip any inherited state-root/namespace override so the assertion is
    // about the variable under test, not the ambient shell.
    const base = { ...process.env };
    for (const k of Object.keys(base)) {
      if (/^(AEGISFLOW|AUTOLOOP)_(HOME|EVIDENCE_ROOT|TELEMETRY_ROOT|TELEMETRY_STATE_ROOT)$/.test(k)) delete base[k];
    }
    const r = spawnSync(process.execPath, [cli, "--run", runId, "--json"], {
      encoding: "utf8",
      env: { ...base, ...extraEnv },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout).availability.stateRoot;
  };

  try {
    assert.equal(
      stateRootFor({ AUTOLOOP_HOME: legacyRoot }),
      join(legacyRoot, "evidence", "autoloop-telemetry", runId),
      "legacy-only deployment resolves under the legacy home",
    );
    assert.equal(
      stateRootFor({ AEGISFLOW_HOME: brandRoot }),
      join(brandRoot, "evidence", "autoloop-telemetry", runId),
      "brand-only deployment resolves under the brand home",
    );
    assert.equal(
      stateRootFor({ AEGISFLOW_HOME: brandRoot, AUTOLOOP_HOME: legacyRoot }),
      join(brandRoot, "evidence", "autoloop-telemetry", runId),
      "with both set the brand home wins",
    );
  } finally {
    rmSync(legacyRoot, { recursive: true, force: true });
    rmSync(brandRoot, { recursive: true, force: true });
  }
});
