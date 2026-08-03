// src/v2/ir-schema.mjs
//
// IR Schema v2 — Task Decomposition v2 資料形狀（與 V1 分離）。
// 對應 Semantic Contract v2 rc1 / Scorecard v2 H1（strict syntax and schema）。
// 純結構檢查：不改寫輸入、不加 defaults、不做語意推論。

export const PURPOSES = Object.freeze([
  "analysis", "implementation", "verification", "review", "operation",
]);

export const EFFECT_VALUES = Object.freeze(["forbidden", "allowed", "required"]);
export const EVIDENCE_OUTPUT_VALUES = Object.freeze(["none", "ephemeral", "persistent"]);
export const COMPLETENESS_VALUES = Object.freeze(["partial", "complete"]);
export const DISPOSITION_VALUES = Object.freeze([
  "actionable", "deferred", "unresolved", "blocked", "out_of_scope", "not_beneficial",
]);
export const VERDICT_VALUES = Object.freeze([
  "DECOMPOSED", "DECOMPOSITION_NOT_BENEFICIAL", "DECOMPOSITION_BLOCKED",
]);

export const REASON_CODES = Object.freeze({
  deferred: ["COMMIT_NOT_AUTHORIZED", "CROSS_REPO_AUTHORITY_REQUIRED",
    "MULTI_MODEL_ORCHESTRATION_FORBIDDEN", "OTHER"],
  unresolved: ["CYCLIC_DEPENDENCY", "AMBIGUOUS_SCOPE", "MISSING_AUTHORITY", "OTHER"],
  blocked: ["EXTERNAL_DEPENDENCY_PENDING", "OTHER"],
  out_of_scope: ["PRODUCTION_RUNTIME_OUT_OF_SCOPE", "OTHER"],
  not_beneficial: ["ALREADY_SATISFIED", "NO_EFFECTIVE_IMPROVEMENT"],
});

// Disposition required-field rules（Contract §10.2 決策表）
export const DISPOSITION_FIELDS = Object.freeze({
  deferred:      { required: ["reason"], terminal: false, childPhases: false },
  unresolved:    { required: ["question"], terminal: false, childPhases: false },
  blocked:       { required: ["reason", "dependency"], terminal: false, childPhases: false },
  out_of_scope:  { required: ["reason", "evidence"], terminal: true, childPhases: false },
  not_beneficial:{ required: ["evidence"], terminal: true, childPhases: false },
});

// ── shared schema metadata（Card 5E：export 供 prompt projection 共用；不改 validation 語意）──
export const REQUIRED_EFFECTS = ["artifact_mutation", "runtime_side_effect", "external_system_mutation", "evidence_output"];
export const REQUIRED_BOUNDARIES = ["artifact", "runtime", "external_system", "evidence"];

export const TOP_KEYS = new Set(["verdict", "parent_goal", "execution_policy", "phases", "dispositions", "decomposition_evidence", "reason"]);
export const PHASE_KEYS = new Set(["phase_id", "title", "summary", "responsibility", "purpose", "effects", "covers", "depends_on", "verification_plan"]);
export const EFFECT_KEYS = new Set([...REQUIRED_EFFECTS, "boundaries"]);
export const COVER_KEYS = new Set(["requirement_id", "completeness", "claim"]);
export const DISPOSITION_KEYS = new Set(["requirement_id", "disposition", "reason_code", "reason", "question", "target", "dependency", "evidence"]);
export const PLAN_KEYS = new Set(["subject_phase_ids", "method", "success_criteria", "failure_criteria", "evidence"]);
export const POLICY_KEYS = new Set(["executor", "reviewer", "multi_model_orchestration"]);

export const PHASE_REQUIRED = Object.freeze(["phase_id", "title", "summary", "responsibility", "purpose", "effects", "covers", "depends_on"]);
export const PLAN_REQUIRED = Object.freeze(["subject_phase_ids", "method", "success_criteria", "failure_criteria", "evidence"]);
export const DISPOSITION_REQUIRED = Object.freeze(["requirement_id", "disposition", "reason_code"]);

const PHASE_SCHEMA = {
  required: ["phase_id", "title", "summary", "responsibility", "purpose", "effects",
    "covers", "depends_on"],
  additionalProperties: true, // verification_plan 由語意層檢查（purpose 相關）
  fields: {
    phase_id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    responsibility: { type: "string", minLength: 1 },
    purpose: { type: "enum", values: PURPOSES },
    effects: { type: "object" },
    covers: { type: "array" },
    depends_on: { type: "array" },
  },
};

// ---- minimal JSON-shape helpers（V2 自含，不依賴 V1） ----

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function checkString(v, path, errors) {
  if (typeOf(v) !== "string") { errors.push(`${path}: expected string, got ${typeOf(v)}`); return false; }
  if (v.length === 0) { errors.push(`${path}: must be non-empty`); return false; }
  return true;
}

function checkEnum(v, values, path, errors) {
  if (!values.includes(v)) { errors.push(`${path}: invalid value "${String(v)}", allowed: ${values.join("|")}`); return false; }
  return true;
}

/**
 * Validate the IR v2 shape strictly.
 * @param {unknown} ir
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateIRShape(ir) {
  const errors = [];
  if (typeOf(ir) !== "object" || ir === null || Array.isArray(ir)) {
    return { valid: false, errors: ["IR must be a plain object"] };
  }

  if (!("verdict" in ir)) errors.push("missing required: verdict");
  else checkEnum(ir.verdict, VERDICT_VALUES, "verdict", errors);

  for (const key of Object.keys(ir)) {
    if (!TOP_KEYS.has(key)) errors.push(`unknown top-level field: ${key}`);
  }

  if (ir.verdict === "DECOMPOSED") {
    if (!("parent_goal" in ir)) errors.push("DECOMPOSED missing required: parent_goal");
    else checkString(ir.parent_goal, "parent_goal", errors);

    if (!Array.isArray(ir.phases) || ir.phases.length === 0) {
      errors.push("DECOMPOSED missing required: phases (non-empty array)");
    } else {
      if (ir.phases.length > 7) errors.push(`phases: count ${ir.phases.length} > max 7 (H2/M9)`);
      for (let i = 0; i < ir.phases.length; i++) validatePhase(ir.phases[i], `phases[${i}]`, errors);
    }

    if (!Array.isArray(ir.dispositions)) errors.push("DECOMPOSED missing required: dispositions (array)");
    else for (let i = 0; i < ir.dispositions.length; i++) validateDisposition(ir.dispositions[i], `dispositions[${i}]`, errors);
  }

  if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL" || ir.verdict === "DECOMPOSITION_BLOCKED") {
    if (ir.phases !== undefined && Array.isArray(ir.phases) && ir.phases.length > 0) {
      errors.push(`${ir.verdict}: phases must be empty/absent`);
    }
    if (Array.isArray(ir.dispositions)) {
      for (let i = 0; i < ir.dispositions.length; i++) validateDisposition(ir.dispositions[i], `dispositions[${i}]`, errors);
    }
    if (ir.verdict === "DECOMPOSITION_NOT_BENEFICIAL") {
      if (!("reason" in ir)) errors.push("NOT_BENEFICIAL missing required: reason");
    }
    if (ir.verdict === "DECOMPOSITION_BLOCKED") {
      if (!Array.isArray(ir.dispositions) || ir.dispositions.length === 0) {
        errors.push("BLOCKED missing required: dispositions (non-empty)");
      }
    }
  }

  if (!Array.isArray(ir.decomposition_evidence) || ir.decomposition_evidence.length === 0) {
    errors.push("missing required: decomposition_evidence (non-empty array)");
  } else {
    for (let i = 0; i < ir.decomposition_evidence.length; i++) {
      if (typeOf(ir.decomposition_evidence[i]) !== "string") errors.push(`decomposition_evidence[${i}]: expected string`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validatePhase(p, path, errors) {
  if (typeOf(p) !== "object" || p === null || Array.isArray(p)) {
    errors.push(`${path}: expected object`);
    return;
  }
  for (const f of PHASE_SCHEMA.required) {
    if (!(f in p)) errors.push(`${path}: missing required: ${f}`);
  }
  for (const key of Object.keys(p)) {
    if (!PHASE_KEYS.has(key)) errors.push(`${path}: unknown phase field: ${key}`);
  }
  if ("phase_id" in p && typeOf(p.phase_id) !== "string") errors.push(`${path}.phase_id: expected string`);
  if ("purpose" in p) checkEnum(p.purpose, PURPOSES, `${path}.purpose`, errors);

  if (p.effects !== undefined) {
    if (typeOf(p.effects) !== "object" || p.effects === null) {
      errors.push(`${path}.effects: expected object`);
    } else {
      for (const f of REQUIRED_EFFECTS) {
        if (!(f in p.effects)) errors.push(`${path}.effects: missing required: ${f}`);
      }
      for (const key of Object.keys(p.effects)) {
        if (!EFFECT_KEYS.has(key)) errors.push(`${path}.effects: unknown field: ${key}`);
      }
      if ("artifact_mutation" in p.effects) checkEnum(p.effects.artifact_mutation, EFFECT_VALUES, `${path}.effects.artifact_mutation`, errors);
      if ("runtime_side_effect" in p.effects) checkEnum(p.effects.runtime_side_effect, EFFECT_VALUES, `${path}.effects.runtime_side_effect`, errors);
      if ("external_system_mutation" in p.effects) checkEnum(p.effects.external_system_mutation, EFFECT_VALUES, `${path}.effects.external_system_mutation`, errors);
      if ("evidence_output" in p.effects) checkEnum(p.effects.evidence_output, EVIDENCE_OUTPUT_VALUES, `${path}.effects.evidence_output`, errors);
      const b = p.effects.boundaries;
      if (b === undefined) {
        errors.push(`${path}.effects: missing required: boundaries`);
      } else if (typeOf(b) !== "object" || b === null) {
        errors.push(`${path}.effects.boundaries: expected object`);
      } else {
        for (const key of REQUIRED_BOUNDARIES) {
          if (!(key in b)) errors.push(`${path}.effects.boundaries: missing required: ${key}`);
          else if (!Array.isArray(b[key])) errors.push(`${path}.effects.boundaries.${key}: expected array`);
          else for (let j = 0; j < b[key].length; j++) {
            if (typeOf(b[key][j]) !== "string") errors.push(`${path}.effects.boundaries.${key}[${j}]: expected string`);
          }
        }
      }
    }
  }

  if (p.covers !== undefined) {
    if (!Array.isArray(p.covers)) {
      errors.push(`${path}.covers: expected array`);
    } else {
      for (let i = 0; i < p.covers.length; i++) {
        const c = p.covers[i];
        const cp = `${path}.covers[${i}]`;
        if (typeOf(c) !== "object" || c === null) { errors.push(`${cp}: expected object`); continue; }
        if (!("requirement_id" in c) || typeOf(c.requirement_id) !== "string" || c.requirement_id.length === 0) {
          errors.push(`${cp}: missing/invalid requirement_id`);
        }
        for (const key of Object.keys(c)) {
          if (!COVER_KEYS.has(key)) errors.push(`${cp}: unknown field: ${key}`);
        }
        if (!("completeness" in c)) errors.push(`${cp}: missing required: completeness`);
        else checkEnum(c.completeness, COMPLETENESS_VALUES, `${cp}.completeness`, errors);
        if (!("claim" in c) || typeOf(c.claim) !== "string" || c.claim.length === 0) {
          errors.push(`${cp}: missing/invalid claim`);
        }
      }
    }
  }

  if (p.depends_on !== undefined) {
    if (!Array.isArray(p.depends_on)) errors.push(`${path}.depends_on: expected array`);
    else for (let i = 0; i < p.depends_on.length; i++) {
      if (typeOf(p.depends_on[i]) !== "string") errors.push(`${path}.depends_on[${i}]: expected string`);
    }
  }

  if (p.verification_plan !== undefined) {
    const vp = p.verification_plan;
    const vpp = `${path}.verification_plan`;
    if (typeOf(vp) !== "object" || vp === null) { errors.push(`${vpp}: expected object`); return; }
    for (const f of ["subject_phase_ids", "method", "success_criteria", "failure_criteria", "evidence"]) {
      if (!(f in vp)) errors.push(`${vpp}: missing required: ${f}`);
    }
    for (const key of Object.keys(vp)) {
      if (!PLAN_KEYS.has(key)) errors.push(`${vpp}: unknown field: ${key}`);
    }
    if (Array.isArray(vp.subject_phase_ids)) {
      for (let i = 0; i < vp.subject_phase_ids.length; i++) {
        if (typeOf(vp.subject_phase_ids[i]) !== "string") errors.push(`${vpp}.subject_phase_ids[${i}]: expected string`);
      }
    }
  }
}

function validateDisposition(d, path, errors) {
  if (typeOf(d) !== "object" || d === null) { errors.push(`${path}: expected object`); return; }
  for (const key of Object.keys(d)) {
    if (!DISPOSITION_KEYS.has(key)) errors.push(`${path}: unknown field: ${key}`);
  }
  if (!("requirement_id" in d) || typeOf(d.requirement_id) !== "string" || d.requirement_id.length === 0) {
    errors.push(`${path}: missing/invalid requirement_id`);
  }
  if (!("disposition" in d)) { errors.push(`${path}: missing required: disposition`); return; }
  if (!checkEnum(d.disposition, DISPOSITION_VALUES, `${path}.disposition`, errors)) return;
  if (d.disposition === "actionable") {
    errors.push(`${path}: actionable is not an explicit disposition entry (use phase covers complete)`);
    return;
  }
  const rule = DISPOSITION_FIELDS[d.disposition];
  for (const f of rule.required) {
    if (!(f in d)) errors.push(`${path}: ${d.disposition} missing required: ${f}`);
  }
  if ("reason_code" in d) {
    if (typeOf(d.reason_code) !== "string") errors.push(`${path}.reason_code: expected string`);
    else if (!REASON_CODES[d.disposition].includes(d.reason_code)) {
      errors.push(`${path}.reason_code: "${d.reason_code}" not allowed for ${d.disposition}`);
    }
  } else {
    errors.push(`${path}: missing required: reason_code`);
  }
}
