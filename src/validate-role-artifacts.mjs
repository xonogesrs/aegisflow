import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANONICAL_RISK } from "./risk-normalization.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(HERE, "schema");

const MODEL_INVOCATION_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "model-invocation.schema.json"), "utf8"));
const ROLE_CONTRACT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "role-contract.schema.json"), "utf8"));
const IMPLEMENTATION_EVIDENCE_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "implementation-evidence.schema.json"), "utf8"));
const AUTHORITY_RECORD_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "authority-record.schema.json"), "utf8"));
const EXECUTION_CONTEXT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "execution-context.schema.json"), "utf8"));
const TASK_UNDERSTANDING_PAYLOAD_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "task-understanding-payload.schema.json"), "utf8"));
const TASK_UNDERSTANDING_ARTIFACT_SCHEMA = JSON.parse(readFileSync(join(SCHEMA_DIR, "task-understanding-artifact.schema.json"), "utf8"));

const MI_ROLES = new Set(MODEL_INVOCATION_SCHEMA.properties.role.enum);
const MI_RESULT_STATUSES = new Set(MODEL_INVOCATION_SCHEMA.properties.result_status.enum);
const MI_REQUIRED = new Set(MODEL_INVOCATION_SCHEMA.required);
const MI_ALLOWED = new Set(Object.keys(MODEL_INVOCATION_SCHEMA.properties));

const RC_REQUIRED = new Set(ROLE_CONTRACT_SCHEMA.required);
const RC_ALLOWED = new Set(Object.keys(ROLE_CONTRACT_SCHEMA.properties));

const IE_REQUIRED = new Set(IMPLEMENTATION_EVIDENCE_SCHEMA.required);
const IE_ALLOWED = new Set(Object.keys(IMPLEMENTATION_EVIDENCE_SCHEMA.properties));

const AR_REQUIRED = new Set(AUTHORITY_RECORD_SCHEMA.required);
const AR_ALLOWED = new Set(Object.keys(AUTHORITY_RECORD_SCHEMA.properties));
const AR_MODE_ENUM = new Set(AUTHORITY_RECORD_SCHEMA.properties.mode.enum);
const AR_RISK_ENUM = new Set(CANONICAL_RISK);

// AURACORE-AUTOLOOP-C5B-FAIL-CLOSED-EVIDENCE-AND-CONTRACT-ALIGNMENT-1:
// required_commands item constraints derived directly from the schema
// (mirrors the AR_REQUIRED/AR_ALLOWED pattern above) so the runtime
// validator cannot silently drift from authority-record.schema.json again.
const AR_RC_ITEM_SCHEMA = AUTHORITY_RECORD_SCHEMA.properties.required_commands.items;
const AR_RC_REQUIRED = new Set(AR_RC_ITEM_SCHEMA.required);
const AR_RC_ALLOWED = new Set(Object.keys(AR_RC_ITEM_SCHEMA.properties));
const AR_RC_SCOPE_ENUM = new Set(AR_RC_ITEM_SCHEMA.properties.scope.enum);
const AR_RC_SOURCE_FORMAT_ENUM = new Set(AR_RC_ITEM_SCHEMA.properties.source_format.enum);

// AURACORE-AUTOLOOP-C5B-ATOMIC-EVIDENCE-SCHEMA-PARITY-AND-CANONICAL-TEST-RUNNER-1:
// derived directly from authority-record.schema.json's definitions — never a
// second hand-maintained copy of the pattern text. Fails loudly at module
// load (not a silent/permissive fallback) if the schema's definitions
// structure ever changes shape unexpectedly, per card §14.
function requiredSchemaPattern(def, label) {
  if (!def || typeof def.pattern !== "string" || def.pattern.length === 0) {
    throw new Error(`authority-record.schema.json definitions.${label}.pattern missing or malformed — refusing to initialize runtime validation permissively`);
  }
  return new RegExp(def.pattern);
}
export const AR_CANONICAL_DEPENDENCY_PATH_RE = requiredSchemaPattern(AUTHORITY_RECORD_SCHEMA.definitions?.canonicalDependencyPath, "canonicalDependencyPath");
export const AR_STRUCTURED_COMMAND_ID_RE = requiredSchemaPattern(AUTHORITY_RECORD_SCHEMA.definitions?.structuredCommandId, "structuredCommandId");

const EC_REQUIRED = new Set(EXECUTION_CONTEXT_SCHEMA.required);
const EC_ALLOWED = new Set(Object.keys(EXECUTION_CONTEXT_SCHEMA.properties));
const EC_RV_REQUIRED = new Set(EXECUTION_CONTEXT_SCHEMA.properties.repository_verification.required);
const EC_RV_ALLOWED = new Set(Object.keys(EXECUTION_CONTEXT_SCHEMA.properties.repository_verification.properties));

const TUP_REQUIRED = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.required);
const TUP_ALLOWED = new Set(Object.keys(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties));
const TUP_PT_ITEM_REQUIRED = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.production_truth.items.required);
const TUP_PT_ITEM_ALLOWED = new Set(Object.keys(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.production_truth.items.properties));
const TUP_PT_EVIDENCE_SOURCE_ENUM = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.production_truth.items.properties.evidence_source.enum);
const TUP_PT_CONFIDENCE_ENUM = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.production_truth.items.properties.confidence.enum);
const TUP_CONFIDENCE_ENUM = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.confidence.enum);
const TUP_SCOPE_ASSESSMENT_ENUM = new Set(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.scope_assessment.enum);
const TUP_PROPOSED_SCOPE_ALLOWED = new Set(Object.keys(TASK_UNDERSTANDING_PAYLOAD_SCHEMA.properties.proposed_scope.properties));

const TUA_REQUIRED = new Set(TASK_UNDERSTANDING_ARTIFACT_SCHEMA.required);
const TUA_ALLOWED = new Set(Object.keys(TASK_UNDERSTANDING_ARTIFACT_SCHEMA.properties));

const ISO_TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_HASH_RE = /^[0-9a-f]{40}$/;
const BOUNDED_STR_RE = /^[\x20-\x7E]+$/;
const BOUNDED_STR_OPT_RE = /^[\x20-\x7E]*$/;
const PATH_RE = /^(?!\.\.\/)(?!\.\.$)(?!\.$)(?!\s*$)[^\x00-\x1f]+$/;

const WILDCARD_PATHS = new Set(["**", "/", ""]);

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function checkType(value, expected, label, errors) {
  if (expected === "string") {
    if (typeof value !== "string") errors.push(`${label}_invalid_type`);
    return typeof value === "string";
  }
  if (expected === "boolean") {
    if (typeof value !== "boolean") errors.push(`${label}_invalid_type`);
    return typeof value === "boolean";
  }
  if (expected === "integer") {
    if (!Number.isInteger(value)) errors.push(`${label}_invalid_type`);
    return Number.isInteger(value);
  }
  if (expected === "object") {
    if (!isObject(value)) errors.push(`${label}_invalid_type`);
    return isObject(value);
  }
  if (expected === "array") {
    if (!Array.isArray(value)) errors.push(`${label}_invalid_type`);
    return Array.isArray(value);
  }
  return false;
}

function checkMinLength(v, min, label, errors) {
  if (v.length < min) errors.push(`${label}_too_short`);
}

function checkMaxLength(v, max, label, errors) {
  if (v.length > max) errors.push(`${label}_too_long`);
}

function checkPattern(v, re, label, errors) {
  if (!re.test(v)) errors.push(`${label}_invalid_pattern`);
}

function checkEnum(v, allowed, label, errors) {
  if (!allowed.has(v)) errors.push(`${label}_invalid_enum`);
}

function checkAdditionalProperties(obj, allowed, prefix, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) errors.push(`${prefix}_unknown_field_${k}`);
  }
}

function checkRequired(obj, required, prefix, errors) {
  for (const f of required) {
    if (!Object.hasOwn(obj, f)) errors.push(`${prefix}_missing_${f}`);
  }
}

function checkRepositoryBaseline(baseline, prefix, errors) {
  if (!isObject(baseline)) { errors.push(`${prefix}_invalid`); return; }
  const req = ["repository", "branch", "head", "origin_ref", "origin_head", "ahead", "behind", "expected_worktree_state", "permitted_dirty_paths", "captured_at"];
  checkRequired(baseline, req, prefix, errors);
  if (baseline.head !== undefined && typeof baseline.head === "string" && !GIT_HASH_RE.test(baseline.head)) errors.push(`${prefix}.head_invalid_pattern`);
  if (baseline.origin_head !== undefined && typeof baseline.origin_head === "string" && !GIT_HASH_RE.test(baseline.origin_head)) errors.push(`${prefix}.origin_head_invalid_pattern`);
  if (baseline.expected_worktree_state !== undefined) checkEnum(baseline.expected_worktree_state, new Set(["clean", "dirty"]), `${prefix}.expected_worktree_state`, errors);
  if (baseline.ahead !== undefined) checkType(baseline.ahead, "integer", `${prefix}.ahead`, errors);
  if (baseline.behind !== undefined) checkType(baseline.behind, "integer", `${prefix}.behind`, errors);
  if (baseline.captured_at !== undefined && typeof baseline.captured_at === "string" && !ISO_TIMESTAMP_RE.test(baseline.captured_at)) errors.push(`${prefix}.captured_at_invalid_pattern`);
  if (baseline.permitted_dirty_paths !== undefined) {
    if (!Array.isArray(baseline.permitted_dirty_paths)) errors.push(`${prefix}.permitted_dirty_paths_invalid_type`);
    else {
      for (let i = 0; i < baseline.permitted_dirty_paths.length; i++) {
        if (typeof baseline.permitted_dirty_paths[i] !== "string") errors.push(`${prefix}.permitted_dirty_paths[${i}]_invalid_type`);
      }
    }
  }
}

function checkTimestamp(value, label, errors) {
  if (typeof value !== "string") errors.push(`${label}_invalid_type`);
  else if (!ISO_TIMESTAMP_RE.test(value)) errors.push(`${label}_invalid_pattern`);
}

function checkBoundedStr(value, label, errors, maxLen = 256, optional = false) {
  if (typeof value !== "string") { errors.push(`${label}_invalid_type`); return; }
  if (optional && value.length === 0) return;
  const re = optional ? BOUNDED_STR_OPT_RE : BOUNDED_STR_RE;
  if (!re.test(value)) errors.push(`${label}_invalid_pattern`);
  if (value.length < 1 && !optional) errors.push(`${label}_too_short`);
  if (value.length > maxLen) errors.push(`${label}_too_long`);
}

function checkStableIds(arr, idField, label, errors) {
  if (!Array.isArray(arr)) return;
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (item && typeof item === "object" && item[idField] !== undefined) {
      const id = String(item[idField]);
      if (seen.has(id)) errors.push(`${label}_duplicate_${idField}_${id}`);
      seen.add(id);
    }
  }
}

function checkPathArray(paths, label, errors) {
  if (!Array.isArray(paths)) { errors.push(`${label}_invalid_type`); return; }
  const seen = new Set();
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (typeof p !== "string") { errors.push(`${label}_item_not_string`); continue; }
    if (p.length === 0) { errors.push(`${label}_empty`); continue; }
    if (p.startsWith("/")) { errors.push(`${label}_absolute_${p}`); continue; }
    if (p.includes("../") || p === "..") { errors.push(`${label}_traversal_${p}`); continue; }
    const norm = p.replace(/\/+$/, "");
    if (norm !== p && p.length > 0 && p.endsWith("/")) {
    }
    if (seen.has(norm)) errors.push(`${label}_duplicate_${norm}`);
    seen.add(norm);
    if (WILDCARD_PATHS.has(p)) errors.push(`${label}_wildcard_${p}`);
  }
}

function checkSHA256(value, label, errors) {
  if (typeof value !== "string") errors.push(`${label}_invalid_type`);
  else if (!SHA256_RE.test(value)) errors.push(`${label}_invalid_pattern`);
}

// AURACORE-AUTOLOOP-C5B-FAIL-CLOSED-EVIDENCE-AND-CONTRACT-ALIGNMENT-1: the
// one runtime path-validation authority for required-command dependency
// paths, shared by card-input validation (run-card.mjs
// validateRequiredCommandsContract, via import) and authority-record runtime
// validation (validateRequiredCommandItem below). Exactly one lexical form
// per repository-relative path is accepted — ambiguous forms are REJECTED,
// never silently repaired/canonicalized (that would let two differently
// written paths acquire the same semantic meaning). Distinct from
// checkPathArray above, which governs allowed_paths/forbidden_paths (scope
// authority) and is intentionally left unchanged.
export function isCanonicalDependencyPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p !== p.trim()) return false;
  if (p.includes("\0")) return false;
  if (p.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false; // Windows drive-prefix form
  if (p.startsWith("/")) return false;
  if (p.endsWith("/")) return false;
  if (p.includes("//")) return false;
  if (p.includes("*") || p.includes("?") || p.includes("[") || p.includes("]")) return false;
  for (const seg of p.split("/")) {
    if (seg.length === 0 || seg === "." || seg === "..") return false;
  }
  return true;
}

function checkMaxItems(arr, max, label, errors) {
  if (Array.isArray(arr) && arr.length > max) errors.push(`${label}_exceeds_max_${max}`);
}

const RISK_ENUM = new Set(["LOW", "MEDIUM", "HIGH"]);
const SEVERITY_ENUM = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

function validateSchemaObject(obj, schema, prefix, errors) {
  if (!isObject(obj)) { errors.push(`${prefix}_not_object`); return; }
  if (schema.required) checkRequired(obj, schema.required, prefix, errors);
  if (schema.additionalProperties === false && schema.properties) {
    checkAdditionalProperties(obj, new Set(Object.keys(schema.properties)), prefix, errors);
  }
  if (schema.properties) {
    for (const [field, fs] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(obj, field)) continue;
      const val = obj[field];
      const label = `${prefix}.${field}`;
      const t = fs.type;
      if (t === "string") {
        if (typeof val !== "string") { errors.push(`${label}_invalid_type`); continue; }
        if (fs.minLength !== undefined && val.length < fs.minLength) errors.push(`${label}_too_short`);
        if (fs.maxLength !== undefined && val.length > fs.maxLength) errors.push(`${label}_too_long`);
        if (fs.pattern) { const re = new RegExp(fs.pattern); if (!re.test(val)) errors.push(`${label}_invalid_pattern`); }
        if (fs.enum && !fs.enum.includes(val)) errors.push(`${label}_invalid_enum`);
      } else if (t === "boolean") {
        if (typeof val !== "boolean") errors.push(`${label}_invalid_type`);
      } else if (t === "integer") {
        if (!Number.isInteger(val)) errors.push(`${label}_invalid_type`);
        else if (fs.minimum !== undefined && val < fs.minimum) errors.push(`${label}_below_minimum`);
      } else if (t === "array" && !Array.isArray(val)) {
        errors.push(`${label}_invalid_type`);
      }
      if (t === "array" && Array.isArray(val) && fs.items && fs.items.type === "string") {
        for (let i = 0; i < val.length; i++) {
          if (typeof val[i] !== "string") errors.push(`${label}[${i}]_invalid_type`);
        }
      }
    }
  }
}

function validateObjectArray(arr, itemSchema, prefix, errors) {
  if (!Array.isArray(arr)) { errors.push(`${prefix}_invalid_type`); return; }
  for (let i = 0; i < arr.length; i++) {
    validateSchemaObject(arr[i], itemSchema, `${prefix}[${i}]`, errors);
  }
}

export function validateModelInvocation(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["model_invocation_not_object"] };
  checkAdditionalProperties(value, MI_ALLOWED, "model_invocation", errors);
  checkRequired(value, MI_REQUIRED, "model_invocation", errors);
  if (value.schema_version !== undefined && value.schema_version !== "autoloop.model-invocation/v1") errors.push("model_invocation.schema_version_invalid");
  for (const idField of ["invocation_id", "attempt_id"]) {
    if (value[idField] !== undefined) checkBoundedStr(value[idField], `model_invocation.${idField}`, errors, 128);
  }
  if (value.role !== undefined) checkEnum(value.role, MI_ROLES, "model_invocation.role", errors);
  for (const sf of ["provider", "configured_model", "requested_model", "effective_model", "provider_request_id"]) {
    if (value[sf] !== undefined) checkBoundedStr(value[sf], `model_invocation.${sf}`, errors, 256);
  }
  if (value.started_at !== undefined) checkTimestamp(value.started_at, "model_invocation.started_at", errors);
  if (value.completed_at !== undefined) checkTimestamp(value.completed_at, "model_invocation.completed_at", errors);
  if (value.result_status !== undefined) checkEnum(value.result_status, MI_RESULT_STATUSES, "model_invocation.result_status", errors);
  return { valid: errors.length === 0, errors };
}

const RC_PT_ITEM = {
  required: ["fact_id","claim","evidence_type","reference","confidence","freshness"],
  additionalProperties: false,
  properties: {
    fact_id: {type:"string", minLength:1, maxLength:128, pattern:"^[\\x20-\\x7E]+$"},
    claim: {type:"string", minLength:1},
    evidence_type: {type:"string", minLength:1},
    reference: {type:"string"},
    symbol: {type:"string"},
    line: {type:"integer", minimum:0},
    confidence: {type:"string", enum:["LOW","MEDIUM","HIGH"]},
    freshness: {type:"string", pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"}
  }
};
const RC_AM_ITEM = {
  required: ["authority_id","owner_role","source_of_truth","creation_point","validation_point","mutation_point","terminal_state","forbidden_alternate_owners"],
  additionalProperties: false,
  properties: {
    authority_id: {type:"string", minLength:1, maxLength:128, pattern:"^[\\x20-\\x7E]+$"},
    owner_role: {type:"string", minLength:1},
    source_of_truth: {type:"string", minLength:1},
    creation_point: {type:"string", minLength:1},
    validation_point: {type:"string", minLength:1},
    mutation_point: {type:"string", minLength:1},
    terminal_state: {type:"string", minLength:1},
    forbidden_alternate_owners: {type:"array", items:{type:"string"}}
  }
};
const RC_INV_ITEM = {
  required: ["invariant_id","statement","applicable_stage","evidence_requirement","violation_severity"],
  additionalProperties: false,
  properties: {
    invariant_id: {type:"string", minLength:1, maxLength:128, pattern:"^[\\x20-\\x7E]+$"},
    statement: {type:"string", minLength:1},
    applicable_stage: {type:"string", minLength:1},
    evidence_requirement: {type:"string", minLength:1},
    violation_severity: {type:"string", enum:["LOW","MEDIUM","HIGH","CRITICAL"]}
  }
};
const RC_OQ_ITEM = {
  required: ["question_id","owner_role","blocking","required_evidence","resolution_stage"],
  additionalProperties: false,
  properties: {
    question_id: {type:"string", minLength:1, maxLength:128, pattern:"^[\\x20-\\x7E]+$"},
    owner_role: {type:"string", minLength:1},
    blocking: {type:"boolean"},
    required_evidence: {type:"string", minLength:1},
    resolution_stage: {type:"string", minLength:1}
  }
};
const RC_ACCEPTANCE = {
  required: ["compile_commands","targeted_tests","full_suite_commands","static_checks","integrity_checks","negative_evidence","mutation_evidence","repetition_requirements","environment_exclusions","pass_conditions"],
  additionalProperties: false,
  properties: {
    compile_commands: {type:"array", items:{type:"string"}},
    targeted_tests: {type:"array", items:{type:"string"}},
    full_suite_commands: {type:"array", items:{type:"string"}},
    static_checks: {type:"array", items:{type:"string"}},
    integrity_checks: {type:"array", items:{type:"string"}},
    negative_evidence: {type:"array", items:{type:"string"}},
    mutation_evidence: {type:"array", items:{type:"string"}},
    repetition_requirements: {type:"array", items:{type:"string"}},
    environment_exclusions: {type:"array", items:{type:"string"}},
    pass_conditions: {type:"string"}
  }
};
const RC_HUMAN_APPROVAL = {
  required: ["scope_expansion","security_exception","commit","push","seal","destructive_migration","remote_history_mutation"],
  additionalProperties: false,
  properties: {
    scope_expansion: {type:"boolean"},
    security_exception: {type:"boolean"},
    commit: {type:"boolean"},
    push: {type:"boolean"},
    seal: {type:"boolean"},
    destructive_migration: {type:"boolean"},
    remote_history_mutation: {type:"boolean"}
  }
};
const RC_AUTH_SCOPE = {
  required: ["authorized_paths","permitted_new_paths","forbidden_paths","dependency_changes_allowed","migration_allowed","configuration_changes_allowed","source_mutation_allowed","test_mutation_allowed"],
  additionalProperties: false,
  properties: {
    authorized_paths: {type:"array"},
    permitted_new_paths: {type:"array", items:{type:"string"}},
    forbidden_paths: {type:"array", items:{type:"string"}},
    dependency_changes_allowed: {type:"boolean"},
    migration_allowed: {type:"boolean"},
    configuration_changes_allowed: {type:"boolean"},
    source_mutation_allowed: {type:"boolean"},
    test_mutation_allowed: {type:"boolean"}
  }
};

export function validateRoleContract(value, options = {}) {
  const errors = [];
  const executionReady = options.executionReady !== false;

  if (!isObject(value)) return { valid: false, errors: ["role_contract_not_object"] };
  checkAdditionalProperties(value, RC_ALLOWED, "role_contract", errors);
  checkRequired(value, RC_REQUIRED, "role_contract", errors);

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.role-contract/v1") errors.push("role_contract.schema_version_invalid");
  if (value.workflow_kind !== undefined && value.workflow_kind !== "role_contract") errors.push("role_contract.workflow_kind_invalid");

  for (const sf of ["contract_id", "design_revision_id", "parent_design_revision_id", "source_card_id"]) {
    if (value[sf] !== undefined) checkBoundedStr(value[sf], `role_contract.${sf}`, errors, 128);
  }
  if (value.created_at !== undefined) checkTimestamp(value.created_at, "role_contract.created_at", errors);

  if (value.designer_invocation !== undefined) {
    const result = validateModelInvocation(value.designer_invocation);
    for (const e of result.errors) errors.push(`role_contract.designer_invocation.${e}`);
  }

  if (value.repository_baseline !== undefined) checkRepositoryBaseline(value.repository_baseline, "role_contract.repository_baseline", errors);
  if (value.risk !== undefined) checkEnum(value.risk, RISK_ENUM, "role_contract.risk", errors);

  if (value.production_truth !== undefined) {
    checkMaxItems(value.production_truth, 100, "role_contract.production_truth", errors);
    checkStableIds(value.production_truth, "fact_id", "role_contract.production_truth", errors);
    validateObjectArray(value.production_truth, RC_PT_ITEM, "role_contract.production_truth", errors);
  }

  if (value.authority_map !== undefined) {
    checkMaxItems(value.authority_map, 100, "role_contract.authority_map", errors);
    checkStableIds(value.authority_map, "authority_id", "role_contract.authority_map", errors);
    validateObjectArray(value.authority_map, RC_AM_ITEM, "role_contract.authority_map", errors);
  }

  if (value.invariants !== undefined) {
    checkMaxItems(value.invariants, 100, "role_contract.invariants", errors);
    checkStableIds(value.invariants, "invariant_id", "role_contract.invariants", errors);
    validateObjectArray(value.invariants, RC_INV_ITEM, "role_contract.invariants", errors);
  }

  if (value.authorized_scope !== undefined) {
    validateSchemaObject(value.authorized_scope, RC_AUTH_SCOPE, "role_contract.authorized_scope", errors);
    const scope = value.authorized_scope;
    if (isObject(scope) && scope.authorized_paths !== undefined) {
      checkPathArray(scope.authorized_paths, "role_contract.authorized_scope.authorized_paths", errors);
    }
  }

  if (value.acceptance !== undefined) {
    validateSchemaObject(value.acceptance, RC_ACCEPTANCE, "role_contract.acceptance", errors);
  }
  if (value.human_approval !== undefined) {
    validateSchemaObject(value.human_approval, RC_HUMAN_APPROVAL, "role_contract.human_approval", errors);
  }

  if (value.open_questions !== undefined) {
    checkMaxItems(value.open_questions, 100, "role_contract.open_questions", errors);
    checkStableIds(value.open_questions, "question_id", "role_contract.open_questions", errors);
    validateObjectArray(value.open_questions, RC_OQ_ITEM, "role_contract.open_questions", errors);
    if (executionReady) {
      for (let i = 0; i < value.open_questions.length; i++) {
        const q = value.open_questions[i];
        if (isObject(q) && q.blocking === true) {
          errors.push(`role_contract.open_questions_blocking_unresolved_${q.question_id || i}`);
        }
      }
    }
  }

  for (const tf of ["problem", "chosen_design", "failure_boundaries", "non_goals", "hold_conditions", "rejected_alternatives", "integrity"]) {
    if (value[tf] !== undefined && typeof value[tf] !== "string") errors.push(`role_contract.${tf}_invalid_type`);
  }

  return { valid: errors.length === 0, errors };
}

const IE_CMD_ITEM = {
  required: ["command","status","exit_code"],
  additionalProperties: false,
  properties: {
    command: {type:"string", minLength:1},
    status: {type:"string", enum:["ok","failed","timed_out","skipped"]},
    exit_code: {type:"integer"}
  }
};
const IE_TR_ITEM = {
  required: ["test_identifier","outcome","command"],
  additionalProperties: false,
  properties: {
    test_identifier: {type:"string", minLength:1},
    outcome: {type:"string", enum:["passed","failed","ignored","skipped","environment_excluded"]},
    command: {type:"string", minLength:1},
    exit_code: {type:"integer"},
    duration_ms: {type:"integer", minimum:0}
  }
};
const IE_NE_ITEM = {
  required: ["claim","evidence_type"],
  additionalProperties: false,
  properties: {
    claim: {type:"string", minLength:1},
    evidence_type: {type:"string", minLength:1}
  }
};
const IE_ME_ITEM = {
  required: ["path","change_type"],
  additionalProperties: false,
  properties: {
    path: {type:"string", minLength:1},
    change_type: {type:"string", minLength:1}
  }
};
const IE_SE_ITEM = {
  required: ["claim","reason"],
  additionalProperties: false,
  properties: {
    claim: {type:"string", minLength:1},
    reason: {type:"string", minLength:1}
  }
};
const IE_KF_ITEM = {
  required: ["description","severity"],
  additionalProperties: false,
  properties: {
    description: {type:"string", minLength:1},
    severity: {type:"string", enum:["LOW","MEDIUM","HIGH","CRITICAL"]}
  }
};
const IE_SD_ITEM = {
  required: ["path","reason","authorized"],
  additionalProperties: false,
  properties: {
    path: {type:"string", minLength:1},
    reason: {type:"string", minLength:1},
    authorized: {type:"boolean"}
  }
};
const IE_ENV_LIMITS = {
  required: [],
  additionalProperties: false,
  properties: {
    max_path_length: {type:"integer", minimum:0},
    max_command_results: {type:"integer", minimum:0},
    max_test_results: {type:"integer", minimum:0},
    notes: {type:"string"}
  }
};
const IE_TIMESTAMPS = {
  required: ["started_at","completed_at"],
  additionalProperties: false,
  properties: {
    started_at: {type:"string", pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"},
    completed_at: {type:"string", pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"}
  }
};

// AURACORE-AUTOLOOP-C4R-SINGLE-SCHEMA-AUTHORITY-1:
// Additive exports so src/v2/phase-response-contract.mjs projects the
// executor final-response contract from the SAME constants the runtime
// validator (validateImplementationEvidence) enforces. The prompt never
// carries a hand-maintained second field list — any drift would be a
// duplicate-schema-authority defect. These exports change no validation
// behavior (read-only snapshots of existing constants).
export const IE_REQUIRED_FIELDS = Object.freeze([...IE_REQUIRED]);
export const IE_ALLOWED_FIELDS = Object.freeze([...IE_ALLOWED]);
export const IE_ITEM_SHAPE_COMMANDS = Object.freeze(IE_CMD_ITEM);
export const IE_ITEM_SHAPE_COMPILE_RESULTS = Object.freeze(IE_CMD_ITEM);
export const IE_ITEM_SHAPE_TEST_RESULTS = Object.freeze(IE_TR_ITEM);
export const IE_ITEM_SHAPE_NEGATIVE_EVIDENCE = Object.freeze(IE_NE_ITEM);
export const IE_ITEM_SHAPE_MUTATION_EVIDENCE = Object.freeze(IE_ME_ITEM);
export const IE_ITEM_SHAPE_SKIPPED_EVIDENCE = Object.freeze(IE_SE_ITEM);
export const IE_ITEM_SHAPE_KNOWN_FAILURES = Object.freeze(IE_KF_ITEM);
export const IE_ITEM_SHAPE_SCOPE_DEVIATIONS = Object.freeze(IE_SD_ITEM);
export const IE_ENV_LIMITS_SHAPE = Object.freeze(IE_ENV_LIMITS);
export const IE_TIMESTAMPS_SHAPE = Object.freeze(IE_TIMESTAMPS);

export function validateImplementationEvidence(value) {
  const errors = [];

  if (!isObject(value)) return { valid: false, errors: ["implementation_evidence_not_object"] };
  checkAdditionalProperties(value, IE_ALLOWED, "implementation_evidence", errors);
  checkRequired(value, IE_REQUIRED, "implementation_evidence", errors);

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.implementation-evidence/v1") errors.push("implementation_evidence.schema_version_invalid");

  for (const sf of ["contract_id", "design_revision_id", "implementation_attempt_id"]) {
    if (value[sf] !== undefined) checkBoundedStr(value[sf], `implementation_evidence.${sf}`, errors, 128);
  }
  if (value.parent_attempt_id !== undefined) checkBoundedStr(value.parent_attempt_id, "implementation_evidence.parent_attempt_id", errors, 128, true);

  if (value.design_contract_hash !== undefined) checkSHA256(value.design_contract_hash, "implementation_evidence.design_contract_hash", errors);
  if (value.patch_sha256 !== undefined) checkSHA256(value.patch_sha256, "implementation_evidence.patch_sha256", errors);

  if (value.executor_invocation !== undefined) {
    const result = validateModelInvocation(value.executor_invocation);
    for (const e of result.errors) errors.push(`implementation_evidence.executor_invocation.${e}`);
  }

  if (value.repository_baseline !== undefined) checkRepositoryBaseline(value.repository_baseline, "implementation_evidence.repository_baseline", errors);

  if (value.authorized_paths !== undefined) checkPathArray(value.authorized_paths, "implementation_evidence.authorized_paths", errors);
  if (value.actual_changed_paths !== undefined) checkPathArray(value.actual_changed_paths, "implementation_evidence.actual_changed_paths", errors);

  if (value.commands !== undefined) {
    checkMaxItems(value.commands, 200, "implementation_evidence.commands", errors);
    validateObjectArray(value.commands, IE_CMD_ITEM, "implementation_evidence.commands", errors);
  }
  if (value.compile_results !== undefined) {
    checkMaxItems(value.compile_results, 50, "implementation_evidence.compile_results", errors);
    validateObjectArray(value.compile_results, IE_CMD_ITEM, "implementation_evidence.compile_results", errors);
  }

  if (value.test_results !== undefined) {
    checkMaxItems(value.test_results, 200, "implementation_evidence.test_results", errors);
    validateObjectArray(value.test_results, IE_TR_ITEM, "implementation_evidence.test_results", errors);
  }

  if (value.negative_evidence !== undefined) {
    checkMaxItems(value.negative_evidence, 100, "implementation_evidence.negative_evidence", errors);
    validateObjectArray(value.negative_evidence, IE_NE_ITEM, "implementation_evidence.negative_evidence", errors);
  }
  if (value.mutation_evidence !== undefined) {
    checkMaxItems(value.mutation_evidence, 100, "implementation_evidence.mutation_evidence", errors);
    validateObjectArray(value.mutation_evidence, IE_ME_ITEM, "implementation_evidence.mutation_evidence", errors);
  }
  if (value.skipped_evidence !== undefined) {
    checkMaxItems(value.skipped_evidence, 100, "implementation_evidence.skipped_evidence", errors);
    validateObjectArray(value.skipped_evidence, IE_SE_ITEM, "implementation_evidence.skipped_evidence", errors);
  }

  if (value.known_failures !== undefined) {
    checkMaxItems(value.known_failures, 100, "implementation_evidence.known_failures", errors);
    validateObjectArray(value.known_failures, IE_KF_ITEM, "implementation_evidence.known_failures", errors);
  }
  if (value.scope_deviations !== undefined) {
    checkMaxItems(value.scope_deviations, 50, "implementation_evidence.scope_deviations", errors);
    validateObjectArray(value.scope_deviations, IE_SD_ITEM, "implementation_evidence.scope_deviations", errors);
  }

  if (value.timestamps !== undefined) {
    validateSchemaObject(value.timestamps, IE_TIMESTAMPS, "implementation_evidence.timestamps", errors);
  }
  if (value.environment_limits !== undefined) {
    validateSchemaObject(value.environment_limits, IE_ENV_LIMITS, "implementation_evidence.environment_limits", errors);
  }

  for (const sf of ["initial_integrity", "final_integrity", "executor_verdict", "integrity"]) {
    if (value[sf] !== undefined && typeof value[sf] !== "string") errors.push(`implementation_evidence.${sf}_invalid_type`);
  }

  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// Card AURACORE-AUTOLOOP-C4A-TASK-UNDERSTANDING-IMPLEMENTATION-1
// authority_record / execution_context / task-understanding payload+artifact
// ===========================================================================

const GIT_HEAD_RE = /^[0-9a-f]{40}$/;

// AURACORE-AUTOLOOP-C5B-FAIL-CLOSED-EVIDENCE-AND-CONTRACT-ALIGNMENT-1 (P2-C):
// validateAuthorityRecord() previously checked only for the *presence* of
// required_commands (via checkRequired above) and never validated its
// items — a persisted record with an invalid required-command entry
// (missing paths, global+nonempty paths, unknown scope, always_run,
// depends_on, ambiguous path, ...) would pass. This enforces the same
// material constraints as the schema and as run-card.mjs's
// validateRequiredCommandsContract (card-input runtime), using the single
// shared isCanonicalDependencyPath authority for path form — persisted
// evidence must be at least as strict as input acceptance, never looser.
function validateRequiredCommandItem(item, label, errors) {
  if (!isObject(item)) { errors.push(`${label}_not_object`); return; }
  checkAdditionalProperties(item, AR_RC_ALLOWED, label, errors);
  checkRequired(item, AR_RC_REQUIRED, label, errors);
  if (item.id !== undefined && item.id !== null && typeof item.id !== "string") {
    errors.push(`${label}.id_invalid_type`);
  }
  if (item.command !== undefined) {
    if (typeof item.command !== "string" || item.command.length === 0) errors.push(`${label}.command_invalid`);
  }
  let scopeValid = false;
  if (item.scope !== undefined) {
    if (!AR_RC_SCOPE_ENUM.has(item.scope)) errors.push(`${label}.scope_invalid_enum`);
    else scopeValid = true;
  }
  let sourceFormatValid = false;
  if (item.source_format !== undefined) {
    if (!AR_RC_SOURCE_FORMAT_ENUM.has(item.source_format)) {
      errors.push(`${label}.source_format_invalid_enum`);
    } else {
      sourceFormatValid = true;
    }
  }
  // AURACORE-AUTOLOOP-C5B-ATOMIC-EVIDENCE-SCHEMA-PARITY-AND-CANONICAL-TEST-RUNNER-1
  // §12: id/source_format relation, mirrored from authority-record.schema.json's
  // required_commands.items.allOf source_format conditionals. Confirmed against
  // the actual producer (run-card.mjs requiredCommandsForDigest/
  // normalizeRequiredCommand): legacy_string entries always have id:null,
  // scope:"global", paths:[]; structured_v1 entries always have a non-null id
  // matching the structured-id grammar (which cannot contain ':', so it can
  // never collide with the internal-only synthesized "legacy:<index>"
  // execution id — that id is never persisted into the authority record).
  if (sourceFormatValid && item.source_format === "legacy_string") {
    if (item.id !== null) errors.push(`${label}.id_must_be_null_for_legacy_string`);
    if (typeof item.command !== "string" || item.command.trim().length === 0) errors.push(`${label}.legacy_string_command_must_contain_non_whitespace`);
    if (item.scope !== undefined && item.scope !== "global") errors.push(`${label}.legacy_string_must_be_scope_global`);
    if (Array.isArray(item.paths) && item.paths.length !== 0) errors.push(`${label}.legacy_string_must_have_empty_paths`);
  } else if (sourceFormatValid && item.source_format === "structured_v1") {
    if (typeof item.id !== "string" || !AR_STRUCTURED_COMMAND_ID_RE.test(item.id)) {
      errors.push(`${label}.id_invalid_for_structured_v1`);
    }
  }
  if (item.paths !== undefined) {
    if (!Array.isArray(item.paths)) {
      errors.push(`${label}.paths_invalid_type`);
    } else {
      const seen = new Set();
      for (let i = 0; i < item.paths.length; i++) {
        const p = item.paths[i];
        if (!isCanonicalDependencyPath(p)) {
          errors.push(`${label}.paths[${i}]_not_canonical`);
          continue;
        }
        if (seen.has(p)) errors.push(`${label}.paths[${i}]_duplicate`);
        seen.add(p);
      }
      if (scopeValid && item.scope === "paths" && item.paths.length === 0) {
        errors.push(`${label}.paths_scope_requires_nonempty_paths`);
      }
      if (scopeValid && item.scope === "global" && item.paths.length !== 0) {
        errors.push(`${label}.paths_forbidden_for_scope_global`);
      }
    }
  }
}

function validateRequiredCommandsArray(arr, label, errors) {
  if (!Array.isArray(arr)) { errors.push(`${label}_invalid_type`); return; }
  const seenStructuredIds = new Set();
  const seenStructuredCommandText = new Set();
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    validateRequiredCommandItem(item, `${label}[${i}]`, errors);
    if (!isObject(item) || item.source_format !== "structured_v1") continue;
    if (typeof item.id === "string") {
      if (seenStructuredIds.has(item.id)) errors.push(`${label}[${i}].id_duplicate_${item.id}`);
      seenStructuredIds.add(item.id);
    }
    if (typeof item.command === "string") {
      if (seenStructuredCommandText.has(item.command)) errors.push(`${label}[${i}].command_duplicate`);
      seenStructuredCommandText.add(item.command);
    }
  }
}

export function validateAuthorityRecord(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["authority_record_not_object"] };
  checkAdditionalProperties(value, AR_ALLOWED, "authority_record", errors);
  checkRequired(value, AR_REQUIRED, "authority_record", errors);
  if (value.required_commands !== undefined) {
    validateRequiredCommandsArray(value.required_commands, "authority_record.required_commands", errors);
  }

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.authority-record/v1") errors.push("authority_record.schema_version_invalid");
  if (value.card_id !== undefined) checkBoundedStr(value.card_id, "authority_record.card_id", errors, 128);
  if (value.card_body !== undefined) {
    if (typeof value.card_body !== "string") errors.push("authority_record.card_body_invalid_type");
    else if (value.card_body.length < 1) errors.push("authority_record.card_body_too_short");
    else if (value.card_body.length > 20000) errors.push("authority_record.card_body_too_long");
  }
  if (value.risk !== undefined) checkEnum(value.risk, AR_RISK_ENUM, "authority_record.risk", errors);
  if (value.mode !== undefined) checkEnum(value.mode, AR_MODE_ENUM, "authority_record.mode", errors);
  if (value.allowed_paths !== undefined) { checkMaxItems(value.allowed_paths, 200, "authority_record.allowed_paths", errors); checkPathArray(value.allowed_paths, "authority_record.allowed_paths", errors); }
  if (value.forbidden_paths !== undefined) { checkMaxItems(value.forbidden_paths, 200, "authority_record.forbidden_paths", errors); checkPathArray(value.forbidden_paths, "authority_record.forbidden_paths", errors); }
  if (value.scope_violation_policy !== undefined) checkEnum(value.scope_violation_policy, new Set(["HOLD", "REJECT"]), "authority_record.scope_violation_policy", errors);
  for (const bf of ["mutation_allowed", "commit_allowed", "push_allowed", "seal_allowed"]) {
    if (value[bf] !== undefined) checkType(value[bf], "boolean", `authority_record.${bf}`, errors);
  }
  if (value.max_repair_rounds !== undefined) {
    if (!Number.isInteger(value.max_repair_rounds) || value.max_repair_rounds < 0 || value.max_repair_rounds > 2) errors.push("authority_record.max_repair_rounds_invalid");
  }
  if (value.ingress_identity !== undefined) checkBoundedStr(value.ingress_identity, "authority_record.ingress_identity", errors, 256);
  if (value.approval_metadata !== undefined && value.approval_metadata !== null) {
    const am = value.approval_metadata;
    if (!isObject(am)) {
      errors.push("authority_record.approval_metadata_invalid_type");
    } else {
      checkAdditionalProperties(am, new Set(["approver", "reason", "approved_at"]), "authority_record.approval_metadata", errors);
      checkRequired(am, ["approver", "reason", "approved_at"], "authority_record.approval_metadata", errors);
      if (am.approver !== undefined) checkBoundedStr(am.approver, "authority_record.approval_metadata.approver", errors, 256);
      if (am.reason !== undefined) checkBoundedStr(am.reason, "authority_record.approval_metadata.reason", errors, 1000);
      if (am.approved_at !== undefined) checkTimestamp(am.approved_at, "authority_record.approval_metadata.approved_at", errors);
    }
  }
  if (value.repository_identity !== undefined) checkBoundedStr(value.repository_identity, "authority_record.repository_identity", errors, 1024);
  if (value.branch !== undefined && typeof value.branch !== "string") errors.push("authority_record.branch_invalid_type");
  if (value.start_head !== undefined) {
    if (typeof value.start_head !== "string" || !GIT_HEAD_RE.test(value.start_head)) errors.push("authority_record.start_head_invalid_pattern");
  }
  if (value.captured_at !== undefined) checkTimestamp(value.captured_at, "authority_record.captured_at", errors);
  if (value.authority_digest !== undefined) checkSHA256(value.authority_digest, "authority_record.authority_digest", errors);

  return { valid: errors.length === 0, errors };
}

export function validateExecutionContext(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["execution_context_not_object"] };
  checkAdditionalProperties(value, EC_ALLOWED, "execution_context", errors);
  checkRequired(value, EC_REQUIRED, "execution_context", errors);

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.execution-context/v1") errors.push("execution_context.schema_version_invalid");
  if (value.run_id !== undefined) {
    if (typeof value.run_id !== "string" || !/^exec_[0-9a-f]{32}$/.test(value.run_id)) errors.push("execution_context.run_id_invalid_pattern");
  }
  if (value.authority_digest !== undefined) checkSHA256(value.authority_digest, "execution_context.authority_digest", errors);
  for (const sf of ["resolved_designer", "resolved_executor", "resolved_reviewer", "resolved_fallback_reviewer"]) {
    if (value[sf] !== undefined) checkBoundedStr(value[sf], `execution_context.${sf}`, errors, 256);
  }
  if (value.resolved_challenge_model !== undefined && value.resolved_challenge_model !== null) {
    checkBoundedStr(value.resolved_challenge_model, "execution_context.resolved_challenge_model", errors, 256);
  }
  if (value.subprocess_timeout_ms !== undefined) {
    if (!Number.isInteger(value.subprocess_timeout_ms) || value.subprocess_timeout_ms < 1000) errors.push("execution_context.subprocess_timeout_ms_invalid");
  }
  if (value.worktree_path !== undefined) checkBoundedStr(value.worktree_path, "execution_context.worktree_path", errors, 4096);
  for (const sf of ["policy_version", "designer_prompt_version", "reviewer_prompt_version"]) {
    if (value[sf] !== undefined) checkBoundedStr(value[sf], `execution_context.${sf}`, errors, 64);
  }
  if (value.repository_verification !== undefined) {
    const rv = value.repository_verification;
    if (!isObject(rv)) {
      errors.push("execution_context.repository_verification_invalid_type");
    } else {
      checkAdditionalProperties(rv, EC_RV_ALLOWED, "execution_context.repository_verification", errors);
      checkRequired(rv, EC_RV_REQUIRED, "execution_context.repository_verification", errors);
      if (rv.origin_head !== undefined && typeof rv.origin_head !== "string") errors.push("execution_context.repository_verification.origin_head_invalid_type");
      if (rv.ahead !== undefined) checkType(rv.ahead, "integer", "execution_context.repository_verification.ahead", errors);
      if (rv.behind !== undefined) checkType(rv.behind, "integer", "execution_context.repository_verification.behind", errors);
      if (rv.worktree_state !== undefined) checkEnum(rv.worktree_state, new Set(["clean", "dirty"]), "execution_context.repository_verification.worktree_state", errors);
      if (rv.verified_at !== undefined) checkTimestamp(rv.verified_at, "execution_context.repository_verification.verified_at", errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

function checkProductionTruthItem(item, label, errors) {
  if (!isObject(item)) { errors.push(`${label}_not_object`); return; }
  checkAdditionalProperties(item, TUP_PT_ITEM_ALLOWED, label, errors);
  checkRequired(item, TUP_PT_ITEM_REQUIRED, label, errors);
  if (item.fact_id !== undefined) checkBoundedStr(item.fact_id, `${label}.fact_id`, errors, 64);
  if (item.statement !== undefined) checkBoundedStr(item.statement, `${label}.statement`, errors, 300);
  if (item.evidence_source !== undefined) checkEnum(item.evidence_source, TUP_PT_EVIDENCE_SOURCE_ENUM, `${label}.evidence_source`, errors);
  if (item.reference !== undefined) checkBoundedStr(item.reference, `${label}.reference`, errors, 300);
  if (item.line_or_symbol !== undefined && item.line_or_symbol !== null) checkBoundedStr(item.line_or_symbol, `${label}.line_or_symbol`, errors, 200, true);
  if (item.confidence !== undefined) checkEnum(item.confidence, TUP_PT_CONFIDENCE_ENUM, `${label}.confidence`, errors);
}

function checkBoundedStrArray(arr, maxItems, maxLen, label, errors) {
  if (!Array.isArray(arr)) { errors.push(`${label}_invalid_type`); return; }
  checkMaxItems(arr, maxItems, label, errors);
  for (let i = 0; i < arr.length; i++) {
    checkBoundedStr(arr[i], `${label}[${i}]`, errors, maxLen);
  }
}

export function validateTaskUnderstandingPayload(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["task_understanding_payload_not_object"] };
  checkAdditionalProperties(value, TUP_ALLOWED, "task_understanding_payload", errors);
  checkRequired(value, TUP_REQUIRED, "task_understanding_payload", errors);

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.task-understanding-payload/v1") errors.push("task_understanding_payload.schema_version_invalid");
  if (value.source_card_id !== undefined) checkBoundedStr(value.source_card_id, "task_understanding_payload.source_card_id", errors, 128);
  if (value.objective !== undefined) checkBoundedStr(value.objective, "task_understanding_payload.objective", errors, 500);

  if (value.observable_outcomes !== undefined) {
    if (!Array.isArray(value.observable_outcomes) || value.observable_outcomes.length < 1) errors.push("task_understanding_payload.observable_outcomes_too_short");
    checkBoundedStrArray(value.observable_outcomes || [], 10, 300, "task_understanding_payload.observable_outcomes", errors);
  }

  if (value.production_truth !== undefined) {
    if (!Array.isArray(value.production_truth)) {
      errors.push("task_understanding_payload.production_truth_invalid_type");
    } else {
      checkMaxItems(value.production_truth, 15, "task_understanding_payload.production_truth", errors);
      checkStableIds(value.production_truth, "fact_id", "task_understanding_payload.production_truth", errors);
      for (let i = 0; i < value.production_truth.length; i++) {
        checkProductionTruthItem(value.production_truth[i], `task_understanding_payload.production_truth[${i}]`, errors);
      }
    }
  }

  if (value.invariants !== undefined) checkBoundedStrArray(value.invariants, 10, 300, "task_understanding_payload.invariants", errors);
  if (value.non_goals !== undefined) checkBoundedStrArray(value.non_goals, 10, 300, "task_understanding_payload.non_goals", errors);

  if (value.completion_criteria !== undefined) {
    if (!Array.isArray(value.completion_criteria) || value.completion_criteria.length < 1) errors.push("task_understanding_payload.completion_criteria_too_short");
    checkBoundedStrArray(value.completion_criteria || [], 10, 300, "task_understanding_payload.completion_criteria", errors);
  }

  if (value.confidence !== undefined) checkEnum(value.confidence, TUP_CONFIDENCE_ENUM, "task_understanding_payload.confidence", errors);
  if (value.scope_assessment !== undefined) checkEnum(value.scope_assessment, TUP_SCOPE_ASSESSMENT_ENUM, "task_understanding_payload.scope_assessment", errors);

  if (value.scope_assessment !== undefined) {
    const details = value.scope_insufficiency_details;
    if (value.scope_assessment === "SUFFICIENT") {
      if (details !== undefined && details !== null) errors.push("task_understanding_payload.scope_insufficiency_details_must_be_null_when_sufficient");
    } else {
      if (details === undefined || details === null || (typeof details === "string" && details.length === 0)) {
        errors.push("task_understanding_payload.scope_insufficiency_details_required_when_not_sufficient");
      } else if (typeof details === "string" && details.length > 1000) {
        errors.push("task_understanding_payload.scope_insufficiency_details_too_long");
      }
    }
  }

  if (value.proposed_scope !== undefined && value.proposed_scope !== null) {
    const ps = value.proposed_scope;
    if (!isObject(ps)) {
      errors.push("task_understanding_payload.proposed_scope_invalid_type");
    } else {
      checkAdditionalProperties(ps, TUP_PROPOSED_SCOPE_ALLOWED, "task_understanding_payload.proposed_scope", errors);
      if (ps.allowed_paths !== undefined) { checkMaxItems(ps.allowed_paths, 200, "task_understanding_payload.proposed_scope.allowed_paths", errors); checkPathArray(ps.allowed_paths, "task_understanding_payload.proposed_scope.allowed_paths", errors); }
      if (ps.forbidden_paths !== undefined) { checkMaxItems(ps.forbidden_paths, 200, "task_understanding_payload.proposed_scope.forbidden_paths", errors); checkPathArray(ps.forbidden_paths, "task_understanding_payload.proposed_scope.forbidden_paths", errors); }
    }
  }

  if (value.authority_ambiguities !== undefined) checkBoundedStrArray(value.authority_ambiguities, 10, 300, "task_understanding_payload.authority_ambiguities", errors);
  if (value.blocking_questions !== undefined) checkBoundedStrArray(value.blocking_questions, 10, 300, "task_understanding_payload.blocking_questions", errors);

  return { valid: errors.length === 0, errors };
}

export function validateTaskUnderstandingArtifact(value) {
  const errors = [];
  if (!isObject(value)) return { valid: false, errors: ["task_understanding_artifact_not_object"] };
  checkAdditionalProperties(value, TUA_ALLOWED, "task_understanding_artifact", errors);
  checkRequired(value, TUA_REQUIRED, "task_understanding_artifact", errors);

  if (value.schema_version !== undefined && value.schema_version !== "autoloop.task-understanding-artifact/v1") errors.push("task_understanding_artifact.schema_version_invalid");
  if (value.source_card_id !== undefined) checkBoundedStr(value.source_card_id, "task_understanding_artifact.source_card_id", errors, 128);
  if (value.authority_digest !== undefined) checkSHA256(value.authority_digest, "task_understanding_artifact.authority_digest", errors);
  if (value.payload !== undefined) {
    const r = validateTaskUnderstandingPayload(value.payload);
    for (const e of r.errors) errors.push(`task_understanding_artifact.payload.${e}`);
  }
  if (value.contract_digest !== undefined) checkSHA256(value.contract_digest, "task_understanding_artifact.contract_digest", errors);
  if (value.designer_provenance_digest !== undefined) checkSHA256(value.designer_provenance_digest, "task_understanding_artifact.designer_provenance_digest", errors);
  if (value.created_at !== undefined) checkTimestamp(value.created_at, "task_understanding_artifact.created_at", errors);

  return { valid: errors.length === 0, errors };
}

// ===========================================================================
// AURACORE-AUTOLOOP-C5B-ATOMIC-EVIDENCE-SCHEMA-PARITY-AND-CANONICAL-TEST-RUNNER-1
// §19: the one reader/verifier for persisted final-barrier evidence (sidecar
// `final_barrier`). Called by run-card.mjs's persistFinalBarrierEvidence on
// a value FRESHLY RE-READ from disk after the atomic write — never on the
// in-memory object that was just written (§19 "must not rely only on the
// in-memory object"). Fails closed on every malformed/missing/stale shape;
// a previous `passed:true` is never treated as current acceptance unless
// every identity field matches the caller's current run/candidate/authority
// values exactly (strict equality, including null===null for the
// no-real-repository dry-run bypass — see `requireIdentity`).
// ===========================================================================
export function verifyFinalBarrierEvidence(sidecarValue, expected, { requireIdentity = false, expectedPassed = true } = {}) {
  if (!isObject(sidecarValue)) return { ok: false, reason: "final_barrier_sidecar_not_object" };
  const fb = sidecarValue.final_barrier;
  if (!isObject(fb)) return { ok: false, reason: "final_barrier_missing" };
  // Default (expectedPassed:true) is the pre-dispatch acceptance gate the
  // design calls for ("Use this verifier before any success-capable handoff
  // or dispatch" — §19): a persisted final_barrier that isn't a genuine
  // passed:true never authorizes success, and a stale passed:true whose
  // identity doesn't match still fails via the identity checks below. A
  // caller that is instead verifying durable-write integrity for a evidence
  // record it INTENTIONALLY wrote with passed:false (a genuine final-barrier
  // command failure, not a persistence problem) passes expectedPassed:false
  // explicitly — this never widens what authorizes a success dispatch,
  // since no success-dispatch caller ever passes anything but the default.
  if (fb.passed !== expectedPassed) return { ok: false, reason: "final_barrier_not_passed" };
  if (!Array.isArray(fb.results)) return { ok: false, reason: "final_barrier_results_malformed" };

  const IDENTITY_FIELDS = ["run_id", "authority_digest", "candidate_digest", "card_id"];
  for (const f of IDENTITY_FIELDS) {
    if (!Object.hasOwn(fb, f)) return { ok: false, reason: `final_barrier_${f}_missing` };
  }
  if (requireIdentity) {
    for (const f of IDENTITY_FIELDS) {
      const v = fb[f];
      if (v === null || v === undefined || (typeof v === "string" && v.length === 0)) {
        return { ok: false, reason: `final_barrier_${f}_required_but_absent` };
      }
    }
  }

  const expRunId = expected && Object.hasOwn(expected, "runId") ? expected.runId : null;
  const expAuthorityDigest = expected && Object.hasOwn(expected, "authorityDigest") ? expected.authorityDigest : null;
  const expCandidateDigest = expected && Object.hasOwn(expected, "candidateDigest") ? expected.candidateDigest : null;
  const expCardId = expected && Object.hasOwn(expected, "cardId") ? expected.cardId : null;
  // Strict equality — a stale sidecar from a prior run (different run_id/
  // candidate_digest/authority_digest) or a concurrently-overwritten sidecar
  // fails here even though fb.passed === true, closing exactly the "stale
  // passed:true authorizes a new run" gap (§22).
  if (fb.run_id !== expRunId) return { ok: false, reason: "final_barrier_run_id_mismatch" };
  if (fb.authority_digest !== expAuthorityDigest) return { ok: false, reason: "final_barrier_authority_digest_mismatch" };
  if (fb.candidate_digest !== expCandidateDigest) return { ok: false, reason: "final_barrier_candidate_digest_mismatch" };
  if (fb.card_id !== expCardId) return { ok: false, reason: "final_barrier_card_id_mismatch" };

  return { ok: true, reason: null };
}
