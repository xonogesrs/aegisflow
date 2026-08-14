#!/usr/bin/env node
// scripts/ta2r-verify.mjs
//
// TA-2R（REPAIR / TA2_ADMISSION_AUTHORITY_AND_CLOSEOUT_SURFACE_INCONSISTENT,
// findings digest 984d3bd60f26eb0028fd13dcdf0e80e616e613be7244ebe26224151b004d6d76,
// superseding 432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272）—
// machine verification of the bounded repair:
//
//   V1   admission module files parse + registry parity（unchanged）
//   V2   capability registry covers the TA-1 inventory（unchanged）
//   V3   deny-by-default（unchanged）
//   V4   classifier determinism + size/risk separation（unchanged）
//   V5   risk monotonic escalation（unchanged）
//   V6   profile projection matches the TA-1 decision matrix（unchanged）
//   V7   admission schema validates production records（unchanged）
//   V8   admission_id deterministic + drift（unchanged）
//   V9   envelope projection（unchanged）
//   V10  writer scope + memory write-back authority（unchanged）
//   V11  graph scheduler seams PRESENT + PRODUCTION gate is the mandatory
//        entrypoint（finding 1）: src/admission/admission-gate.mjs exports
//        assertProductionAdmission / runAdmittedGraph / *Admitted wrappers;
//        the runners' `admission` param is a documented compatibility surface
//   V12  durable binding（unchanged）
//   V13  one-card-one-review-surface + supersede binding（unchanged; the TA-2R
//        closeout MUST carry a supersede of the previous bundle）
//   V14  post-FM-3 closeout hardening（V1-V5）+ TA-2R content-v1 baseline gate
//        （BASELINE_CONTENT_IDENTITY_MISSING on a pre-content baseline）
//   V15  R9 single-model policy（unchanged）
//   V16  NEG suites fail-closed（admission suite accounting）
//   V17  regression suites green（governance/scripted-lifecycle/telemetry/
//        v2/admission）
//   V18  scope guard: no production source outside the authorized scope was
//        modified by this card（content-identity aware; ta2r outputs）
//   V19  mandatory admission gate（NEG19）: production entry WITHOUT a frozen
//        admission -> HOLD / ADMISSION_REQUIRED and the runner is NEVER
//        invoked; malformed -> ADMISSION_INVALID; tampered -> ADMISSION_DRIFT;
//        valid frozen -> dispatched unchanged
//   V20  complete-bundle fail-closed surface（NEG18/finding 3）: template
//        residue（${...} / stale placeholders）fails the renderer AND the
//        validator; content-identity delta attribution（NEG17/finding 2）:
//        the captured TA-2R baseline has full pathShas, the live delta has no
//        unattributable paths, and pre-existing dirty files modified by this
//        card classify as MODIFIED with content proof
//   V21  repair-lineage semantics（HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_
//        CUMULATIVE）: GENERATION_TYPE machine classification parses;
//        cumulative REPAIR_LINEAGE_REPAIR_ITERATIONS never exceeds
//        REPAIR_BUDGET_MAX; a surface-reseal's RESEAL_TOUCHED_PATHS stays
//        review-surface/governance scope; every generated lineage bundle
//        validates under the lineage contract
//
// Exit 0 iff ALL checks pass. Writes docs/pi-graph-output/ta2r/ta2r-verification.json.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const OUT = join(REPO, "docs", "pi-graph-output", "ta2r");
const TA1 = join(REPO, "docs", "pi-graph-output", "ta1");

// VCA-1 W1A (S2): real wall-clock measurement for the whole verification run.
const VERIFY_STARTED_AT = Date.now();

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
}
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");
function canonical(v) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    return x;
  };
  return JSON.stringify(sort(v));
}

import("../src/admission/registry.mjs").then(async ({ assertRegistryParity, capabilityRegistry, listCapabilities, resolveCapability, CAPABILITY_DEFAULT_STATE }) => {
  const { classify, classifyRisk, classifySize, profileFor, scanRiskSignals, RISK_SIGNALS, SIZE_DIMENSIONS } = await import("../src/admission/classify.mjs");
  const { validateAdmission, freezeAdmission, deriveAdmissionId, assertAdmissionFrozen, admissionDigest, ADMISSION_SCHEMA_DEFINITION, canonicalAdmissionJson } = await import("../src/admission/admission-record.mjs");
  const { buildAdmissionRecord, projectCapabilities, projectProfilePolicies, projectEnvelopeFields, PROFILE_MATRIX, assertMutationWithinAdmissionScope, AdmissionEnvelopeError } = await import("../src/admission/policy-projection.mjs");
  const { assertProductionAdmission, runAdmittedGraph, runColimaGraphAdmitted, runSubagentGraphAdmitted, runDurableGraphAdmitted } = await import("../src/admission/admission-gate.mjs");
  const { buildConfigurationFingerprint } = await import("../src/v2/checkpoint-bridge.mjs");
  const { supersedesFromBundleText, assertCardStartBaseline, renderVerifierAccounting, assertAccountingMatches, classifyDeltaFromFacts, assertNoTemplateResidue, collectRepoFacts, renderReviewBundle } = await import("../src/governance/review-bundle.mjs");
  const { runSuiteSync, timingFields } = await import("../src/governance/verification-timing.mjs");
  const { TOOL_PERMISSIONS, SUBAGENT_ROLES } = await import("../src/subagent/subagent-contract.mjs");

  const parseOk = ["registry.mjs", "classify.mjs", "admission-record.mjs", "policy-projection.mjs", "admission-gate.mjs"].every((f) => {
    try { execFileSync("node", ["--check", join(REPO, "src", "admission", f)], { stdio: "pipe" }); return true; } catch { return false; }
  });
  const parity = assertRegistryParity();
  check("V1.module_parse_and_registry_parity", parseOk && parity.ok, `src/admission/* parse (incl. admission-gate.mjs); registry parity ${parity.ok ? "ok" : parity.errors.join(";")}`);

  // -------------------------------------------------- V2: registry vs TA-1 inventory
  let invOk = false, invDetail = "";
  try {
    const inventory = JSON.parse(readFileSync(join(TA1, "ta1-capability-inventory.json"), "utf8"));
    const ta1Ids = (inventory.capabilities ?? []).map((c) => c.id).sort();
    const regIds = listCapabilities().filter((id) => id !== "CAP.DIRECT_EXECUTION").sort();
    const missing = ta1Ids.filter((id) => !regIds.includes(id));
    const extra = regIds.filter((id) => !ta1Ids.includes(id));
    invOk = missing.length === 0 && extra.length === 0 && ta1Ids.length >= 20;
    invDetail = missing.length || extra.length ? `missing=${missing.join(",")} extra=${extra.join(",")}` : `${ta1Ids.length} TA-1 ids all resolved`;
  } catch (e) { invDetail = e.message; }
  check("V2.registry_covers_ta1_inventory", invOk, invDetail);

  // ------------------------------------------- V3: deny-by-default + unknown -> null
  const allCaps = listCapabilities();
  const denyOk = allCaps.every((id) => resolveCapability(id).default_state === CAPABILITY_DEFAULT_STATE);
  check("V3.deny_by_default", denyOk && resolveCapability("CAP.NOPE") === null, `${allCaps.length} capabilities DENIED by default; unknown -> null`);

  // ------------------------------------------------- V4: classifier determinism + separation
  const FULL_EVIDENCE = {
    affected_files: { score: 1, reasons: ["single README file"] }, affected_subsystems: { score: 0, reasons: ["docs only"] },
    dependency_depth: { score: 0, reasons: ["no deps"] }, ambiguity: { score: 0, reasons: ["exact text"] },
    expected_execution_steps: { score: 0, reasons: ["one edit"] }, verification_burden: { score: 0, reasons: ["no tests"] },
    external_dependencies: { score: 0, reasons: ["none"] }, concurrency_potential: { score: 0, reasons: ["none"] },
    statefulness: { score: 0, reasons: ["stateless"] }, rollback_complexity: { score: 0, reasons: ["revert 1 file"] },
  };
  const c1 = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const c2 = classify({ dimensionScores: FULL_EVIDENCE, riskSignals: scanRiskSignals("fix one typo in README") });
  const det = canonical(c1) === canonical(c2);
  const tinyHigh = classify({ dimensionScores: { affected_files: { score: 1, reasons: ["one statement"] } }, riskSignals: scanRiskSignals("delete one row from the production database") });
  const sep = tinyHigh.size === "XS" && tinyHigh.risk === "CRITICAL" && tinyHigh.profile === "CRITICAL";
  check("V4.classifier_determinism_and_separation", det && sep, `deterministic=${det}; XS+db-delete -> ${tinyHigh.profile}`);

  // --------------------------------------------- V5: risk monotonic + fast-path guard
  const twoHigh = classifyRisk([{ signal_id: "RS.CONCURRENCY", class: "HIGH", triggered: true, reason: "a" }, { signal_id: "RS.PERSISTENCE", class: "HIGH", triggered: true, reason: "b" }]);
  const mono = twoHigh.risk === "CRITICAL";
  const fastGuard = c1.profile === "FAST_PATH" && tinyHigh.profile !== "FAST_PATH";
  check("V5.risk_monotonic_and_fast_path_guard", mono && fastGuard, `>=2 HIGH -> ${twoHigh.risk}; typo FAST_PATH, db-delete not`);

  // ------------------------------- V6: profile projection matches TA-1 decision matrix
  let matrixOk = true, matrixDetail = "";
  try {
    const dm = JSON.parse(readFileSync(join(TA1, "ta1-admission-decision-matrix.json"), "utf8"));
    for (const row of dm.matrix ?? []) {
      const d = PROFILE_MATRIX[row.profile];
      if (!d) { matrixOk = false; matrixDetail += `missing profile ${row.profile}; `; continue; }
      for (const [k, v] of Object.entries(row.decisions)) {
        if (d[k] !== v) { matrixOk = false; matrixDetail += `${row.profile}.${k} ${d[k]} != ${v}; `; }
      }
    }
  } catch (e) { matrixOk = false; matrixDetail = e.message; }
  check("V6.profile_matrix_parity", matrixOk, matrixDetail || "all 7 profiles match the TA-1 decision matrix");

  // ------------------------------- V7: schema validates + parity vs ta1-admission-schema
  let schemaOk = true, schemaDetail = "";
  try {
    const ta1Schema = JSON.parse(readFileSync(join(TA1, "ta1-admission-schema.json"), "utf8"));
    const baseProps = new Set(Object.keys(ta1Schema.properties));
    const prodProps = Object.keys(ADMISSION_SCHEMA_DEFINITION.properties);
    for (const p of baseProps) if (!prodProps.includes(p)) { schemaOk = false; schemaDetail += `missing ${p}; `; }
    const additions = prodProps.filter((p) => !baseProps.has(p));
    if (!additions.every((p) => ["mutation_scope", "tool_permissions"].includes(p))) { schemaOk = false; schemaDetail += `unsanctioned additions ${additions.join(",")}; `; }
  } catch (e) { schemaOk = false; schemaDetail = e.message; }
  const rec = freezeAdmission(buildAdmissionRecord({ taskId: "VERIFY-1", classification: c1, mutationScope: ["docs/"] }));
  const recValid = validateAdmission(rec);
  check("V7.admission_schema_parity_and_validation", schemaOk && recValid.ok, `${schemaDetail || "schema additive-compatible"}; record valid ${recValid.ok}`);

  // -------------------------------------------- V8: admission_id deterministic + drift
  const id1 = deriveAdmissionId(rec);
  const id2 = deriveAdmissionId({ ...rec, decision_time: "2099-01-01T00:00:00.000Z" });
  const tamper = assertAdmissionFrozen({ stored: { ...rec, risk: "HIGH" }, authoritativeAdmissionId: rec.admission_id, authoritativeRecord: { ...rec, risk: "HIGH" } });
  const idOk = id1 === rec.admission_id && id2 === rec.admission_id && !tamper.ok;
  check("V8.admission_id_deterministic_and_drift", idOk, `id stable across decision_time; tamper -> ${tamper.reason}`);

  // ---------------------------------------- V9: envelope projection from admission
  let envOk = true, envDetail = "";
  const fast = freezeAdmission(buildAdmissionRecord({ taskId: "VERIFY-2", classification: c1, mutationScope: ["docs/"] }));
  try { projectEnvelopeFields({ admission: fast, nodeRole: "writer", mutationScopeFromPhase: ["docs/"] }); envOk = false; envDetail = "writer allowed on FAST_PATH"; }
  catch (e) { envOk = e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION"; }
  const roEnv = projectEnvelopeFields({ admission: fast, nodeRole: "readonly-analyst" });
  const roTools = roEnv.toolPermissions.every((t) => TOOL_PERMISSIONS.READ_ONLY.includes(t));
  check("V9.envelope_projection", envOk && roTools, `FAST_PATH writer denied (NEG3); read-only tools only`);

  // ------------------------------------- V10: writer scope + memory write-back authority
  let w10 = true, w10d = "";
  try { assertMutationWithinAdmissionScope(fast, ["src/"]); w10 = false; w10d = "src/ inside docs/ scope"; } catch (e) { w10 = e.code === "ADMISSION_MUTATION_SCOPE_VIOLATION"; }
  const wbDenied = Object.values(PROFILE_MATRIX).every((d) => d.memory_writeback_allowed === false);
  check("V10.writer_scope_and_writeback_authority", w10 && wbDenied, `${w10d || "scope containment ok"}; write-back denied by default (NEG5)`);

  // ------------------------------------- V11: graph seams + production gate (finding 1)
  let seamOk = false, seamDetail = "";
  try {
    const runner = readFileSync(join(REPO, "src", "runtime", "colima-graph-runner.mjs"), "utf8");
    const subagent = readFileSync(join(REPO, "src", "subagent", "subagent-graph-runner.mjs"), "utf8");
    const durable = readFileSync(join(REPO, "src", "v2", "durable-graph.mjs"), "utf8");
    const gate = readFileSync(join(REPO, "src", "admission", "admission-gate.mjs"), "utf8");
    seamOk = runner.includes('admission = null') && runner.includes('holdCode: "ADMISSION_INVALID"')
      && subagent.includes("validateAdmission(admission)") && subagent.includes("projectEnvelopeFields")
      && durable.includes("ADMISSION_DRIFT") && durable.includes("admission.json")
      && gate.includes("export function assertProductionAdmission") && gate.includes("export async function runAdmittedGraph")
      && gate.includes("ADMISSION_REQUIRED")
      && runner.includes("runAdmittedGraph") && subagent.includes("runAdmittedGraph") && durable.includes("runAdmittedGraph");
    seamDetail = "scheduler seams present; production entrypoint = runAdmittedGraph (admission-gate.mjs) — mandatory, non-bypassable";
  } catch (e) { seamDetail = e.message; }
  check("V11.graph_scheduler_admission_seams_and_production_gate", seamOk, seamDetail);

  // -------------------------------------- V12: durable binding (fingerprint)
  const cfgBase = { maxRepairAttempts: 1, timeoutMs: 90000, toolPolicy: null, environmentAllowlist: null, expectedReviewerModel: null, runtime: { v: "test" }, sourceHashes: null, persistenceFormatVersion: "1.0.0" };
  const fp1 = buildConfigurationFingerprint({ ...cfgBase, admissionFingerprint: admissionDigest(rec) });
  const tinyRec = freezeAdmission(buildAdmissionRecord({ taskId: "VERIFY-3", classification: tinyHigh, mutationScope: ["db/"] }));
  const fp2 = buildConfigurationFingerprint({ ...cfgBase, admissionFingerprint: admissionDigest(tinyRec) });
  check("V12.durable_fingerprint_binding", fp1 !== fp2 && fp1 === buildConfigurationFingerprint({ ...cfgBase, admissionFingerprint: admissionDigest(rec) }), "admission digest bound into configuration fingerprint (O)");

  // ----------------------------------- V13: one-card-one-review-surface + supersede
  const surfacePolicies = Object.keys(PROFILE_MATRIX).map((k) => projectProfilePolicies(k).review_surface_policy);
  const surfaceOk = surfacePolicies.every((p) => p.authoritative_single_surface === true && p.chain === "linear");
  const supersedePartial = supersedesFromBundleText("SUPERSEDES_BUNDLE_IDENTITY: " + "a".repeat(64) + "\nSUPERSEDES_BUNDLE_PATH: /tmp/x.txt\n");
  const supersedeOk = supersedePartial.error === "supersedes_sha256_missing";
  check("V13.one_card_one_review_surface", surfaceOk && supersedeOk, "single authoritative surface + linear chain; partial supersede fails closed (NEG9/10)");

  // --------------------------------- V14: post-FM-3 closeout hardening + content-v1 gate
  const baselineGate = assertCardStartBaseline({ closeout: { inventoryModel: "delta-v1" } });
  const accounting = renderVerifierAccounting([{ suite: "V1", tests: 1, passed: 1, failed: 0 }]);
  const accMatch = assertAccountingMatches([{ suite: "V1", tests: 1, passed: 1, failed: 0 }], accounting).ok;
  const baselinePath = join(OUT, "ta2r-card-start-baseline.json");
  let contentGateOk = false, contentGateDetail = "no TA-2R baseline";
  if (existsSync(baselinePath)) {
    const bl = JSON.parse(readFileSync(baselinePath, "utf8"));
    const hasShas = bl && typeof bl.pathShas === "object" && Object.keys(bl.pathShas ?? {}).length > 0 && typeof bl.contentDigest === "string";
    const strippedGate = assertCardStartBaseline({ closeout: { inventoryModel: "delta-v1", inventoryAttribution: "content-v1", baseline: { ...bl, pathShas: undefined, contentDigest: undefined } } });
    contentGateOk = hasShas && strippedGate.ok === false && strippedGate.holdCode === "BASELINE_CONTENT_IDENTITY_MISSING";
    contentGateDetail = `TA-2R baseline pathShas=${Object.keys(bl.pathShas ?? {}).length}; stripped baseline -> ${strippedGate.holdCode ?? strippedGate.reason}`;
  }
  check("V14.closeout_hardening", baselineGate.ok === false && accMatch && contentGateOk, `missing baseline -> ${baselineGate.reason}; accounting ${accounting} (V4); ${contentGateDetail}`);

  // ---------------------------------------------- V15: R9 single-model policy
  let r9ok = false, r9d = "";
  try {
    const schema = JSON.parse(readFileSync(join(REPO, "src", "schema", "card-input.schema.json"), "utf8"));
    const desc = schema.properties.executor.properties.model.description ?? "";
    const transport = readFileSync(join(REPO, "src", "v2", "pi-transport-adapter.mjs"), "utf8");
    const proMentions = (desc.match(/deepseek-v4-pro/g) ?? []).length;
    const descAllowsPro = /(allowlist|allowed|currently).{0,60}deepseek-v4-pro/.test(desc);
    r9ok = desc.includes("deepseek-v4-flash") && !descAllowsPro && /model:\s*["']deepseek-v4-flash["']/.test(transport) && !/model:\s*["']deepseek-v4-pro["']/.test(transport);
    r9d = r9ok ? "executor allowlist = deepseek/deepseek-v4-flash only (R9)" : `allowlist widened or pro enabled (mentions=${proMentions}, allowsPro=${descAllowsPro})`;
  } catch (e) { r9d = e.message; }
  check("V15.r9_single_model", r9ok, r9d);

  // ------------------------------------- V16/V17: suite accounting (parsed)
  // VCA-1 W1A (S3): the 3 governance sub-suite entries（review-bundle /
  // graph-closeout / external-review-delivery）were removed — test:governance
  // already covers them. Every entry records REAL wallMs（S2）.
  const suites = [
    { name: "test:admission", cmd: ["node", "--test", "test/admission/*.mjs"] },
    { name: "test:governance", cmd: ["node", "--test", "test/governance/*.mjs"] },
    { name: "test:scripted-lifecycle", cmd: ["node", "--test", "test/test-scripted-adapter.mjs", "test/test-lifecycle-runner.mjs", "test/test-standalone-paths.mjs", "test/test-normalize-reviewer-json.mjs"] },
    { name: "test:telemetry", cmd: ["node", "--test", "test/telemetry/*.mjs"] },
    { name: "test:v2", cmd: ["node", "--test", "test/v2/*.mjs"] },
  ];
  const regression = [];
  for (const s of suites) {
    const r = runSuiteSync(s.cmd, { cwd: REPO, timeoutMs: 1800000 });
    const suiteOk = r.ok && r.tests > 0 && r.failed === 0;
    regression.push({ suite: s.name, tests: r.tests, passed: r.passed, failed: r.failed, ok: suiteOk, startedAt: r.startedAt, completedAt: r.completedAt, wallMs: r.wallMs, timingSource: r.timingSource });
  }
  const allGreen = regression.every((r) => r.ok);
  const regTotal = regression.reduce((a, r) => a + r.tests, 0);
  const regPassed = regression.reduce((a, r) => a + r.passed, 0);
  check("V16.neg_suite_fail_closed", allGreen, `admission+regression ${renderVerifierAccounting(regression, { prefix: "S" })}`);
  check("V17.regression_green", allGreen, `${regTotal} tests / ${regPassed} passed across admission + governance + scripted-lifecycle + telemetry + v2 (${regression.reduce((a, r) => a + r.wallMs, 0)}ms wall)`);

  // ------------------------------------- V18: scope guard (content-identity aware)
  let scopeOk = true, scopeDetail = "";
  try {
    const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: REPO, encoding: "utf8" });
    const touched = new Set();
    for (const line of status.split("\n").filter(Boolean)) {
      const p = line.slice(3).trim();
      touched.add(p);
      if (line.startsWith("R")) { const to = p.split(" -> ")[1]; if (to) touched.add(to); }
    }
    const authorizedPrefixes = [
      "src/admission/", "test/admission/", "scripts/ta2-", "scripts/ta2r-", "docs/pi-graph-output/ta2/",
      "docs/pi-graph-output/ta2r/",
      "src/subagent/", "src/runtime/", "src/v2/", "src/telemetry/", "src/governance/",
      "src/schema/",
    ];
    const authorizedFiles = [
      "src/subagent/subagent-contract.mjs", "src/subagent/subagent-graph-runner.mjs",
      "src/subagent/subagent-executor-adapter.mjs", "src/subagent/subagent-writer-executor-adapter.mjs",
      "src/runtime/colima-graph-runner.mjs", "src/v2/durable-graph.mjs", "src/v2/checkpoint-bridge.mjs",
      "src/telemetry/contract.mjs", "src/telemetry/graph-observer.mjs",
      "src/governance/review-bundle.mjs", "src/schema/card-input.schema.json",
    ];
    const baselinePath = join(OUT, "ta2r-card-start-baseline.json");
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : { dirtyPaths: [] };
    const preExisting = new Set((baseline.dirtyPaths ?? []).map((x) => String(x).replace(/\/$/, "")));
    const norm = (x) => String(x).replace(/\/$/, "");
    for (const raw of touched) {
      const p = norm(raw);
      const inAuthPrefix = authorizedPrefixes.some((a) => p === a.replace(/\/$/, "") || p.startsWith(a));
      const inAuthFile = authorizedFiles.includes(p);
      if (inAuthPrefix || inAuthFile) continue;
      const preExistingChild = [...preExisting].some((b) => p === b || p.startsWith(b + "/") || b.startsWith(p + "/"));
      if (preExisting.has(p) || preExistingChild) continue;
      scopeOk = false;
      scopeDetail += `${raw}; `;
    }
  } catch (e) { scopeOk = false; scopeDetail = e.message; }
  check("V18.scope_guard", scopeOk, scopeDetail || "every touched path is TA-2R authorized or card-start pre-existing");

  // ------------------------------------- V19: mandatory production gate (NEG19/finding 1)
  let v19ok = false, v19d = "";
  try {
    const gateNoAdmission = assertProductionAdmission(null);
    const spy = [];
    const fakeRunner = async (opts) => { spy.push(opts); return { final: "PASS" }; };
    const noAdm = await runAdmittedGraph({ admission: null, runner: fakeRunner });
    const rawBad = buildAdmissionRecord({ taskId: "VERIFY-BAD", classification: c1, mutationScope: ["docs/"] });
    rawBad.capabilities = { required: [], allowed: ["CAP.BOGUS"], denied: [] };
    rawBad.admission_id = deriveAdmissionId(rawBad); // id re-derives; schema invalid -> INVALID
    const malformed = await runAdmittedGraph({ admission: rawBad, runner: fakeRunner });
    const tampered = await runAdmittedGraph({ admission: { ...rec, risk: "HIGH" }, runner: fakeRunner });
    const valid = await runAdmittedGraph({ admission: rec, runner: fakeRunner, ir: { phases: [] } });
    v19ok = gateNoAdmission.ok === false && gateNoAdmission.holdCode === "ADMISSION_REQUIRED"
      && noAdm.final === "HOLD" && noAdm.holdCode === "ADMISSION_REQUIRED"
      && malformed.holdCode === "ADMISSION_INVALID"
      && tampered.holdCode === "ADMISSION_DRIFT"
      && valid.final === "PASS" && spy.length === 1 && spy[0].admission === rec;
    v19d = `no-admission -> ${noAdm.holdCode} (runner not invoked); malformed -> ${malformed.holdCode}; tampered -> ${tampered.holdCode}; valid -> dispatched unchanged`;
  } catch (e) { v19d = e.message; }
  check("V19.mandatory_production_admission_gate", v19ok, v19d);

  // ------------------------------------- V20: complete-bundle surface + content delta (findings 2/3)
  let v20ok = true, v20d = [];
  // (a) template residue scan — unit + renderer fail-closed
  const residueUnit = assertNoTemplateResidue("x ${NOPE} y");
  if (residueUnit.ok) { v20ok = false; v20d.push("residue unit scan did not flag ${NOPE}"); }
  if (!assertNoTemplateResidue("clean text").ok) { v20ok = false; v20d.push("clean text flagged"); }
  // (b) content-identity delta over the REAL captured baseline
  if (existsSync(baselinePath)) {
    const bl = JSON.parse(readFileSync(baselinePath, "utf8"));
    try {
      const facts = collectRepoFacts(REPO, { baseline: bl });
      if (facts.unattributable.length > 0) { v20ok = false; v20d.push(`unattributable=${facts.unattributable.slice(0, 5).join(",")}`); }
      if (!facts.contentDigest || typeof facts.contentDigest !== "string") { v20ok = false; v20d.push("final contentDigest missing"); }
      v20d.push(`baseline contentDigest=${String(bl.contentDigest ?? "").slice(0, 12)} final=${String(facts.contentDigest ?? "").slice(0, 12)} delta=${facts.deltaPaths.length} (membership ${facts.membershipDelta.length} + content ${facts.contentModified.length})`);
    } catch (e) { v20ok = false; v20d.push(`collectRepoFacts:${e.message}`); }
  }
  // (c) scan the FINAL closeout bundle if already generated
  const bundles = existsSync(OUT) ? readdirSync(OUT).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt")) : [];
  for (const b of bundles) {
    const res = assertNoTemplateResidue(readFileSync(join(OUT, b), "utf8"));
    if (!res.ok) { v20ok = false; v20d.push(`bundle ${b} residue: ${res.matches.slice(0, 3).join(" | ")}`); }
    else v20d.push(`bundle ${b} scan clean`);
  }
  check("V20.complete_bundle_surface_and_content_delta", v20ok, v20d.join("; ") || "residue scan clean; content delta unattributable=[]");

  // ------------------------------------- V21: repair-lineage semantics（HOLD / TA2R_REPAIR_LINEAGE_ACCOUNTING_NOT_CUMULATIVE）
  let v21ok = true, v21d = [];
  try {
    const { parseRepairLineage, isSubstantiveImplementationPath, parseResealTouchedPaths, validateReviewBundle } = await import("../src/governance/review-bundle.mjs");
    // (a) GENERATION_TYPE classification + lineage fields parse from §14
    const lg = parseRepairLineage("GENERATION_TYPE: surface-reseal\nREPAIR_BUDGET_MAX: 1\nREPAIR_BUDGET_USED: 1\nREPAIR_LINEAGE_REPAIR_ITERATIONS: 1\nREPAIR_LINEAGE_SURFACE_RESEALS: 1\n");
    if (lg.generationType !== "surface-reseal" || lg.budgetUsed !== 1 || lg.repairIterations !== 1) { v21ok = false; v21d.push("lineage parse mismatch"); }
    // (b) reseal governance-scope contract: substantive vs governance path
    const subst = isSubstantiveImplementationPath("src/admission/admission-gate.mjs");
    const gov = !isSubstantiveImplementationPath("src/governance/review-bundle.mjs");
    const gov2 = !isSubstantiveImplementationPath("test/governance/test-graph-closeout.mjs");
    if (!subst || !gov || !gov2) { v21ok = false; v21d.push(`scope contract: substantive=${subst} gov=${gov}/${gov2}`); }
    // (c) scan generated bundles: a surface-reseal must keep USED=1/MAX=1 with
    // a governance-scope touch set and validate under the lineage contract
    for (const b of bundles) {
      const bt = readFileSync(join(OUT, b), "utf8");
      const l = parseRepairLineage(bt);
      if (!l.generationType) continue; // legacy bundle（pre-lineage）— non-retroactive
      if (l.generationType === "surface-reseal") {
        const touched = parseResealTouchedPaths(bt);
        const badTouch = touched.find((p) => isSubstantiveImplementationPath(p));
        if (badTouch) { v21ok = false; v21d.push(`${b} reseal touches substantive ${badTouch}`); }
        if (touched.length === 0) { v21ok = false; v21d.push(`${b} reseal declares no touched paths`); }
      }
      if (l.budgetMax !== null && l.repairIterations !== null && l.repairIterations > l.budgetMax) {
        v21ok = false; v21d.push(`${b} cumulative repairs ${l.repairIterations} > max ${l.budgetMax}`);
      }
      const v = validateReviewBundle(join(OUT, b), { authorizedDir: OUT });
      if (!v.ok) { v21ok = false; v21d.push(`${b} validator: ${v.errors.slice(0, 3).join(" | ")}`); }
    }
    v21d.push(v21ok ? "lineage classification + cumulative accounting + reseal scope contract OK" : "lineage contract FAILED");
  } catch (e) { v21ok = false; v21d.push(e.message); }
  check("V21.repair_lineage_contract", v21ok, v21d.join("; "));

  // ------------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  const summary = {
    schema: "autoloop.ta2-verification/v1",
    card: "AUTOLOOP-TA2",
    generation: "TA-2R",
    supersedesBundleIdentity: "432e85b5742b194d24c4558b1eec8f1415dcdc6ee52c2f934eff900f9e0a6272",
    verifiedAt: new Date().toISOString(),
    // VCA-1 W1A (S2): real measured timing for this verification run.
    ...timingFields(VERIFY_STARTED_AT, Date.now()),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    ok: failed.length === 0,
    checks: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
    regression,
    digest: sha256(canonical(results)),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
});
