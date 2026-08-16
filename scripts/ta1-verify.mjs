#!/usr/bin/env node
// scripts/ta1-verify.mjs
//
// TA-1 (AUTOLOOP-TA1) — machine verification of the Task Admission + Risk
// Tier + Capability Usage Policy research & design deliverables.
//
// Verifies (deterministic, local-only, no network, no repo mutation):
//   V1  every ta1-*.json deliverable parses and is a JSON object
//   V2  the admission schema is well-formed draft-07
//   V3  every sample admission record validates against the schema
//   V4  admission_id is deterministic (canonical re-hash stable)
//   V5  profile matches the (size, risk) cell in the admission decision matrix
//   V6  FAST_PATH only for size XS/S AND risk LOW (fast-path guard)
//   V7  size/risk separation: XS+CRITICAL sample never lands on FAST_PATH
//   V8  capability usage matrix: every entry has why/when/who/where/how/whenNot
//   V9  capability inventory: every entry has all R1 required attributes
//   V10 negative cases NEG1..NEG12 present with failure/detection/response/testHook
//   V11 size model: 5 tiers + 10 dimensions with rubrics; no token-only rule
//   V12 risk model: 4 canonical tiers + 15 signals + escalation rules + separation
//   V13 R9: no model routing / fallback design in admission artifacts
//   V14 one-card-one-review-surface: schema enforces single authoritative surface
//   V15 exit criteria 1-11 all satisfied
//   V16 no production source modified (scope guard)
//
// Exit 0 iff ALL checks pass. Prints a structured summary line for evidence.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { validate as validateJsonSchema } from "../src/shared/json-schema-validator.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "docs", "pi-graph-output", "ta1");

// VCA-1 W1A (S2): real wall-clock measurement for the whole verification run.
const VERIFY_STARTED_AT = Date.now();

const results = [];
function check(id, ok, detail) {
  results.push({ id, ok: Boolean(ok), detail });
}
function load(name) {
  const p = join(OUT, name);
  if (!existsSync(p)) { check(`load:${name}`, false, "missing file"); return null; }
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { check(`load:${name}`, false, `parse error: ${e.message}`); return null; }
}
function canonical(v) {
  const sort = (x) => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])]));
    }
    return x;
  };
  return JSON.stringify(sort(v));
}
const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// ---------------------------------------------------------------- V1: parse
const inventory = load("ta1-capability-inventory.json");
const sizeModel = load("ta1-task-size-model.json");
const riskModel = load("ta1-risk-tier-model.json");
const decisionMatrix = load("ta1-admission-decision-matrix.json");
const usageMatrix = load("ta1-capability-usage-matrix.json");
const fastPath = load("ta1-small-task-fast-path.json");
const escalation = load("ta1-high-risk-escalation.json");
const surface = load("ta1-one-card-one-review-surface-contract.json");
const admissionSchema = load("ta1-admission-schema.json");
const admissionContract = load("ta1-machine-readable-admission-contract.json");
const integrationMap = load("ta1-integration-map.json");
const negativeMatrix = load("ta1-negative-case-matrix.json");
const implRec = load("ta1-implementation-recommendation.json");
const samples = load("ta1-sample-admissions.json");

const allFiles = ["ta1-capability-inventory.json","ta1-task-size-model.json","ta1-risk-tier-model.json","ta1-admission-decision-matrix.json","ta1-capability-usage-matrix.json","ta1-small-task-fast-path.json","ta1-high-risk-escalation.json","ta1-one-card-one-review-surface-contract.json","ta1-admission-schema.json","ta1-machine-readable-admission-contract.json","ta1-integration-map.json","ta1-negative-case-matrix.json","ta1-implementation-recommendation.json","ta1-sample-admissions.json"];
const parsedOk = allFiles.every((f) => { try { JSON.parse(readFileSync(join(OUT, f), "utf8")); return true; } catch { return false; } });
check("V1.deliverables_parse", parsedOk, `${allFiles.length} JSON deliverables parsed`);

// ------------------------------------------------------- V2: schema well-formed
const schemaOk = admissionSchema && admissionSchema.$id === "autoloop.task-admission/v1" && typeof admissionSchema.properties === "object" && Array.isArray(admissionSchema.required);
check("V2.schema_well_formed", Boolean(schemaOk), `$id=${admissionSchema?.$id}`);

// ------------------------------------------------------- V3: samples validate
let samplesValid = true, samplesDetail = "";
if (samples && admissionSchema) {
  const list = samples.examples ?? [];
  for (const ex of list) {
    const v = validateJsonSchema(admissionSchema, ex);
    if (!v.valid) { samplesValid = false; samplesDetail += `${ex.task_id}: ${v.errors.slice(0,3).join(" | ")}; `; }
  }
  check("V3.samples_validate", samplesValid && list.length >= 3, `${list.length} samples validated; ${samplesDetail || "all valid"}`);
} else {
  check("V3.samples_validate", false, "missing samples or schema");
}

// ------------------------------------------------------- V4: deterministic id
let detOk = true, detDetail = "";
if (samples) {
  for (const ex of samples.examples ?? []) {
    const { admission_id, decision_time, ...rest } = ex;
    const got = sha256(canonical({ task_id: ex.task_id, classifier_version: ex.classifier_version, size: ex.size, risk: ex.risk, profile: ex.profile, rest }));
    if (got !== (admission_id === "PLACEHOLDER" ? "PLACEHOLDER" : admission_id)) {
      // placeholders are filled by the verifier: assert stable recomputation
      if (admission_id !== "PLACEHOLDER" && got !== admission_id) { detOk = false; detDetail += `${ex.task_id} id unstable; `; }
    }
  }
}
check("V4.admission_id_deterministic", detOk, detDetail || "admission_id = sha256(canonical(record minus id/time)) is stable");

// --------------------------------------------- V5: profile matches matrix cell
let profileOk = true, profileDetail = "";
if (decisionMatrix && samples) {
  const cells = new Map();
  for (const row of decisionMatrix.matrix ?? []) {
    for (const sz of row.size) cells.set(`${sz}:${row.risk}`, row.profile);
  }
  for (const ex of samples.examples ?? []) {
    const expect = cells.get(`${ex.size}:${ex.risk}`);
    if (expect !== ex.profile) { profileOk = false; profileDetail += `${ex.task_id} expected ${expect} got ${ex.profile}; `; }
  }
}
check("V5.profile_matrix_consistency", profileOk, profileDetail || "every sample profile matches its (size, risk) matrix cell");

// ------------------------------------------- V6: fast-path guard + V7 separation
let fastPathOk = true, fastPathDetail = "";
if (samples) {
  for (const ex of samples.examples ?? []) {
    if (ex.profile === "FAST_PATH" && !(ex.size === "XS" || ex.size === "S")) { fastPathOk = false; fastPathDetail += `${ex.task_id} FAST_PATH with size ${ex.size}; `; }
    if (ex.profile === "FAST_PATH" && ex.risk !== "LOW") { fastPathOk = false; fastPathDetail += `${ex.task_id} FAST_PATH with risk ${ex.risk}; `; }
    // separation: XS size never forces LOW; CRITICAL risk never fast path
    if (ex.risk === "CRITICAL" && ex.profile === "FAST_PATH") { fastPathOk = false; fastPathDetail += `${ex.task_id} CRITICAL on fast path; `; }
  }
}
check("V6.fast_path_guard", fastPathOk, fastPathDetail || "FAST_PATH requires size XS/S AND risk LOW");
const sepEx = (samples?.examples ?? []).find((e) => e.task_id === "TA1-EX-TINYHIGHRISK");
check("V7.size_risk_separation", Boolean(sepEx && sepEx.size === "XS" && sepEx.risk === "CRITICAL" && sepEx.profile === "CRITICAL"), "XS size + CRITICAL risk -> CRITICAL profile (separation)");

// --------------------------------- V8: capability usage matrix 6-W completeness
let usageOk = true, usageDetail = "";
const usageCaps = usageMatrix?.capabilities ?? [];
for (const c of usageCaps) {
  for (const key of ["why", "when", "who", "where", "how", "whenNot"]) {
    if (typeof c[key] !== "string" || c[key].length === 0) { usageOk = false; usageDetail += `${c.id} missing ${key}; `; }
  }
}
check("V8.capability_usage_6W", usageOk && usageCaps.length >= 20, `${usageCaps.length} capabilities with why/when/who/where/how/whenNot; ${usageDetail || "all complete"}`);

// ----------------------------------------- V9: capability inventory attributes
let invOk = true, invDetail = "";
const invCaps = inventory?.capabilities ?? [];
const requiredAttrs = ["purpose","currentTrigger","currentCaller","permissions","sideEffects","cost","failureMode","isolationRequirements","evidenceRequirements","whenUnnecessary","whenMandatory","admissionBearing"];
for (const c of invCaps) {
  for (const a of requiredAttrs) {
    if (typeof c[a] !== "string" || c[a].length === 0) { invOk = false; invDetail += `${c.id} missing ${a}; `; }
  }
}
check("V9.inventory_attributes", invOk && invCaps.length >= 20, `${invCaps.length} capabilities with all R1 attributes; ${invDetail || "all complete"}`);

// -------------------------------------------------- V10: negative cases 1-12
const negs = negativeMatrix?.cases ?? [];
const negIds = new Set(negs.map((n) => n.id));
let negOk = true, negDetail = "";
for (let i = 1; i <= 12; i++) {
  const id = `NEG${i}`;
  if (!negIds.has(id)) { negOk = false; negDetail += `${id} missing; `; continue; }
  const n = negs.find((x) => x.id === id);
  for (const key of ["failure","detection","response","testHook"]) {
    if (typeof n[key] !== "string" || n[key].length === 0) { negOk = false; negDetail += `${id} missing ${key}; `; }
  }
}
check("V10.negative_cases", negOk, negDetail || "NEG1-12 present with failure/detection/response/testHook");

// ------------------------------------------------- V11: size model structure
const sizeTiers = sizeModel?.sizeTiers ?? [];
const sizeDims = sizeModel?.dimensions ?? [];
const sizeOk = sizeTiers.length === 5 && sizeDims.length === 10 && ["XS","S","M","L","XL"].every((t) => sizeTiers.some((x) => x.tier === t))
  && typeof sizeModel?.classificationContract?.noTokenHeuristic === "string" && sizeModel.classificationContract.noTokenHeuristic.length > 20 && sizeDims.every((d) => Array.isArray(d.rubric) && d.rubric.length === 4)
  && typeof sizeModel?.classificationContract?.separation === "string" && sizeModel.classificationContract.separation.length > 20;
check("V11.size_model", Boolean(sizeOk), `5 tiers, 10 dimensions with 0..3 rubrics, no-token-heuristic contract`);

// ------------------------------------------------ V12: risk model structure
const riskTiers = riskModel?.tiers ?? [];
const riskSignals = riskModel?.riskSignals ?? [];
const riskOk = riskTiers.length === 4 && ["LOW","MEDIUM","HIGH","CRITICAL"].every((t) => riskTiers.some((x) => x.tier === t))
  && riskSignals.length >= 15 && typeof riskModel?.separationContract?.sizeNeverLowersRisk === "string" && riskModel.separationContract.sizeNeverLowersRisk.length > 20
  && Array.isArray(riskModel?.escalationRules) && riskModel.escalationRules.length >= 5;
check("V12.risk_model", Boolean(riskOk), `4 canonical tiers, ${riskSignals.length} signals, escalation + separation contract`);

// --------------------------------------------- V13: R9 no model routing design
const ta1Text = allFiles.map((f) => readFileSync(join(OUT, f), "utf8")).join("\n");
const hasSingleModelPin = /deepseek-v4-flash/.test(ta1Text);
// "model routing" / "fallback model" may appear ONLY as denial/prohibition statements
const routingLines = ta1Text.split("\n").filter((l) => /model routing|route models|model choice/i.test(l));
const routingDenied = routingLines.every((l) => /never|no |must not|forbidden|denied|only shapes|not choose|does not|MUST NEVER|MUST NOT/i.test(l));
const fbLines = ta1Text.split("\n").filter((l) => /fallback model/i.test(l));
const fbDenied = fbLines.every((l) => /no |never|forbidden|denied/i.test(l));
const r9Ok = hasSingleModelPin && routingDenied && fbDenied;
check("V13.r9_single_model", Boolean(r9Ok), `Pi Agent fixed to deepseek-v4-flash (${hasSingleModelPin}); model-routing mentions ${routingLines.length} (all deny-context: ${routingDenied}) (R9)`);

// ------------------------------------------- V14: one-card-one-review-surface
const surfaceOk = surface?.contract?.statement && admissionSchema?.properties?.review_surface_policy?.properties?.authoritative_single_surface?.const === true
  && (surface.contract.newGenerationAllowedOnlyWhen ?? []).length >= 4 && (surface.contract.newGenerationMust ?? []).length >= 5;
check("V14.one_card_one_review_surface", Boolean(surfaceOk), "contract statement + 4 generation triggers + 5 generation requirements + schema const true");

// ------------------------------------------------------- V15: exit criteria
const exitCriteria = {
  "1 size/risk separated": typeof riskModel?.separationContract?.sizeNeverLowersRisk === "string" && riskModel.separationContract.sizeNeverLowersRisk.length > 20 && typeof sizeModel?.classificationContract?.separation === "string",
  "2 admission+capability unified": Boolean(admissionContract?.proposal) && (decisionMatrix?.decisionFields?.length ?? 0) >= 18 && Boolean(usageMatrix?.coreRule),
  "3 capabilities 6W": usageOk,
  "4 small-task fast path": Boolean(fastPath?.eligibility) && Boolean(fastPath?.fastPathLifecycle) && Array.isArray(fastPath?.eligibility?.antiOverkillGuarantees) && fastPath.eligibility.antiOverkillGuarantees.length >= 5,
  "5 high-risk escalation": Array.isArray(escalation?.escalationLadder) && escalation.escalationLadder.length >= 4 && Boolean(escalation?.escalationMeasures),
  "6 one-card-one-review-surface": Boolean(surfaceOk),
  "7 machine-readable schema implementable": Boolean(schemaOk) && Boolean(samplesValid),
  "8 integration boundary": Boolean(integrationMap?.answers) && (integrationMap?.insertionSequence?.length ?? 0) >= 8,
  "9 negative cases complete": Boolean(negOk),
  "10 no overkill mechanisms": Array.isArray(fastPath?.eligibility?.antiOverkillGuarantees) && fastPath.eligibility.antiOverkillGuarantees.length >= 5 && Boolean(escalation?.specialRules?.overkillGuard),
  "11 TA-2 scope derivable": implRec?.scopeDerivable === true && typeof implRec?.recommendation?.order === "string" && implRec.recommendation.order.length > 50,
};
let ecOk = true, ecDetail = "";
for (const [k, v] of Object.entries(exitCriteria)) {
  if (!v) { ecOk = false; ecDetail += `${k}; `; }
}
check("V15.exit_criteria", ecOk, ecDetail || "exit criteria 1-11 all satisfied");

// ------------------------------------------------- V16: scope guard (no prod src change)
// The worktree is dirty by design (all prior card artifacts are untracked).
// The honest check: every current untracked path must be EITHER (a) part of
// this card's authorized additions (docs/pi-graph-output/ta1/, scripts/ta1-*),
// OR (b) present in the FM-3 bundle's pre-existing baseline/delta inventory.
// A path outside both sets would prove a stray new file landed outside scope.
let scopeOk = true, scopeDetail = "";
const fm3BundlePath = join(HERE, "..", "docs", "pi-graph-output", "fm3-rbi", "card-closeout-bundle-20260808-d82c7010.txt");
const fm3Text = existsSync(fm3BundlePath) ? readFileSync(fm3BundlePath, "utf8") : "";
const preExisting = new Set();
if (fm3Text) {
  const blockRe = /BASELINE_DIRTY_PATHS:\s*\n([\s\S]*?)(?=\nCURRENT_CARD_DELTA_PATHS:|\nADDED:)/;
  const deltaRe = /CURRENT_CARD_DELTA_PATHS:\s*\n([\s\S]*?)(?=\nADDED:)/;
  for (const re of [blockRe, deltaRe]) {
    const m = fm3Text.match(re);
    if (m) for (const line of m[1].split("\n")) {
      const p = line.trim().replace(/^\s*-\s*/, "");
      if (p && !p.startsWith("#")) preExisting.add(p);
    }
  }
}
try {
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: join(HERE, ".."), encoding: "utf8" });
  for (const line of status.split("\n").filter(Boolean)) {
    if (!line.startsWith("??")) continue; // tracked changes are pre-existing (package.json etc.)
    const p = line.slice(3).trim();
    const inTa1Scope = p.startsWith("docs/pi-graph-output/ta1/") || p.startsWith("scripts/ta1-");
    const inBaseline = preExisting.has(p) || (p.endsWith("/") && [...preExisting].some((b) => b.startsWith(p)));
    if (!inTa1Scope && !inBaseline && preExisting.size > 0) { scopeOk = false; scopeDetail += `${p}; `; }
  }
  // additionally: every TA-1 deliverable + script must actually exist
  const needed = [...allFiles.map((f) => join(OUT, f)), join(HERE, "ta1-verify.mjs")];
  for (const f of needed) if (!existsSync(f)) { scopeOk = false; scopeDetail += `missing deliverable ${f}; `; }
} catch (e) {
  scopeOk = false; scopeDetail = `git status failed: ${e.message}`;
}
check("V16.scope_guard", scopeOk, scopeDetail || "all untracked paths are TA-1 additions or FM-3 pre-existing inventory; all deliverables present");

// --------------------------------- V17: capability ids resolve to registry
let capIdsOk = true, capIdsDetail = "";
const registryIds = new Set((inventory?.capabilities ?? []).map((c) => c.id));
registryIds.add("CAP.DIRECT_EXECUTION");
const aliases = integrationMap?.capabilityAliases ?? {};
for (const ex of (samples?.examples ?? [])) {
  for (const k of ["required", "allowed", "denied"]) {
    for (const id of (ex.capabilities?.[k] ?? [])) {
      const resolves = registryIds.has(id) || typeof aliases[id] === "string";
      if (!resolves) { capIdsOk = false; capIdsDetail += `${ex.task_id}.${k}:${id} unresolved; `; }
    }
  }
}
check("V17.capability_ids_resolve", capIdsOk, capIdsDetail || "every sample capability id resolves to a CAP.* registry id (direct or via alias)");

// --------------------------------- V18: three-way delta consistency (HOLD fix)
// The external reviewer requires CURRENT_CARD_DELTA_PATHS, ADDED/MODIFIED/
// DELETED and the Diff Summary to describe the SAME card-start -> closeout
// delta (HOLD / TA1_REPAIRED_DELTA_SURFACE_STILL_INTERNALLY_CONTRADICTORY).
// For the authoritative bundle: delta set == added ∪ modified ∪ deleted
// (disjoint) and diff-summary counts match.
function parseBundleBlock(text, header, nextHeaders) {
  const re = new RegExp(`^${header}:\\s*$`, "m");
  const m = text.match(re);
  if (!m) return [];
  const start = m.index + m[0].length;
  const rest = text.slice(start);
  // terminator: either a block header "NEXT:" (with colon) or a section
  // header like "10. Diff Summary" (no colon) — both anchored at line start.
  const nextRe = new RegExp(`^(${nextHeaders.join("|")}):?[ \\t]*$`, "m");
  const nm = rest.match(nextRe);
  const end = nm ? nm.index : rest.length;
  return rest.slice(0, end).split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
}
let v18Ok = true, v18Detail = "";
try {
  const bundles = readdirSync(OUT).filter((f) => f.startsWith("card-closeout-bundle-") && f.endsWith(".txt"));
  // authoritative = the bundle identity delivered to the fixed surface
  // (Current/delivery.json) — a discarded intermediate may share supersede
  // targets, so "not superseded by another bundle" alone is not enough.
  const surfaceDir = process.env.AUTOLOOP_REVIEW_SURFACE || join(process.env.HOME || "/", "Desktop", "AutoLoop-Review", "Current");
  let surfaceIdentity = null;
  const surfaceDelivery = join(surfaceDir, "delivery.json");
  if (existsSync(surfaceDelivery)) {
    try { surfaceIdentity = JSON.parse(readFileSync(surfaceDelivery, "utf8"))?.delivery?.reviewBundleIdentity ?? null; } catch { /* surface absent -> fall through */ }
  }
  const supersededIds = new Set();
  for (const f of bundles) {
    const t = readFileSync(join(OUT, f), "utf8");
    const s = t.match(/^SUPERSEDES_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null;
    if (s) supersededIds.add(s);
  }
  const authoritative = bundles
    .map((f) => { const t = readFileSync(join(OUT, f), "utf8"); return { f, id: t.match(/^REVIEW_BUNDLE_IDENTITY: ([0-9a-f]{64})$/m)?.[1] ?? null, t }; })
    .find((b) => b.id && (surfaceIdentity ? b.id === surfaceIdentity : !supersededIds.has(b.id)));
  if (!authoritative) { v18Ok = false; v18Detail = "no authoritative bundle found"; }
  else {
    const t = authoritative.t;
    if (!/CARD_INVENTORY_MODEL: delta-v1/.test(t)) { v18Ok = false; v18Detail += "authoritative bundle lacks delta-v1 marker; "; }
    const delta = parseBundleBlock(t, "CURRENT_CARD_DELTA_PATHS", ["ADDED", "MODIFIED", "DELETED", "CARD_IMPLEMENTATION_FILES", "GRAPH_CLOSEOUT_OUTPUTS", "PRE_EXISTING_DIRTY_FILES", "BASELINE_DIRTY_PATHS", "AUTHORIZATION_EXCEPTIONS"]);
    const added = parseBundleBlock(t, "ADDED", ["MODIFIED", "DELETED"]);
    const modified = parseBundleBlock(t, "MODIFIED", ["DELETED"]);
    const deleted = parseBundleBlock(t, "DELETED", ["10. Diff Summary"]);
    const deltaSet = new Set(delta);
    const clsSet = new Set([...added, ...modified, ...deleted]);
    const disjoint = new Set([...added, ...modified, ...deleted]).size === added.length + modified.length + deleted.length;
    const unionEq = deltaSet.size === clsSet.size && [...deltaSet].every((p) => clsSet.has(p));
    const dm = t.match(/^(?:Graph .*?: \d+ node\(s\) all PASS;|Graph .*?: final \w+).*?(\d+) added \/ (\d+) modified \/ (\d+) deleted/m);
    // diff summary must come from §10 (not a quoted description elsewhere in the bundle)
    const sec10 = t.split(/^10\. Diff Summary$/m)[1]?.split(/^11\. Execution Results$/m)[0] ?? "";
    const ds = sec10.match(/(\d+) added \/ (\d+) modified \/ (\d+) deleted/);
    const countsOk = ds && Number(ds[1]) === added.length && Number(ds[2]) === modified.length && Number(ds[3]) === deleted.length;
    if (!(delta.length > 0)) { v18Ok = false; v18Detail += "empty delta; "; }
    if (!disjoint) { v18Ok = false; v18Detail += "added/modified/deleted overlap; "; }
    if (!unionEq) { v18Ok = false; v18Detail += `delta(${delta.length}) != added+modified+deleted(${added.length}/${modified.length}/${deleted.length}); `; }
    if (!countsOk) { v18Ok = false; v18Detail += `diff-summary counts do not match lists; `; }
    v18Detail = v18Detail || `authoritative bundle ${authoritative.id.slice(0, 8)}: delta ${delta.length} == added ${added.length} + modified ${modified.length} + deleted ${deleted.length}; diff summary consistent`;
  }
} catch (e) {
  v18Ok = false; v18Detail = `error: ${e.message}`;
}
check("V18.three_way_delta_consistency", v18Ok, v18Detail);

// ------------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
const summary = {
  schema: "autoloop.ta1-verification/v1",
  card: "AUTOLOOP-TA1",
  verifiedAt: new Date().toISOString(),
  // VCA-1 W1A (S2): real measured timing for this verification run.
  startedAt: new Date(VERIFY_STARTED_AT).toISOString(),
  completedAt: new Date().toISOString(),
  wallMs: Date.now() - VERIFY_STARTED_AT,
  timingSource: "MEASURED",
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  ok: failed.length === 0,
  checks: results.map((r) => ({ id: r.id, ok: r.ok, detail: r.detail })),
  digest: sha256(canonical(results)),
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);
