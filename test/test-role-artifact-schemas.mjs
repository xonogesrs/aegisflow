import { test, describe } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");
const SCHEMA_DIR = join(HERE, "..", "src", "schema");

const { validateModelInvocation, validateRoleContract, validateImplementationEvidence } = await import(join(HERE, "..", "src", "validate-role-artifacts.mjs"));

function validMI(overrides = {}) {
  return {
    schema_version: "autoloop.model-invocation/v1",
    invocation_id: "inv-test-001",
    attempt_id: "attempt-001",
    role: "executor",
    provider: "deepseek",
    configured_model: "deepseek/deepseek-v4-flash",
    requested_model: "deepseek/deepseek-v4-flash",
    effective_model: "deepseek/deepseek-v4-flash",
    provider_request_id: "req-test-001",
    started_at: "2026-07-17T10:00:00Z",
    completed_at: "2026-07-17T10:30:00Z",
    result_status: "SUCCEEDED",
    ...overrides
  };
}

function validRC(overrides = {}) {
  return {
    schema_version: "autoloop.role-contract/v1",
    workflow_kind: "role_contract",
    contract_id: "rc-test-001",
    design_revision_id: "rev-test-001",
    parent_design_revision_id: "rev-parent-000",
    source_card_id: "card-test-001",
    created_at: "2026-07-17T10:00:00Z",
    designer_invocation: validMI({ role: "designer", invocation_id: "inv-designer-001" }),
    repository_baseline: {
      repository: "example-repo",
      branch: "main",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      origin_ref: "origin/main",
      origin_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ahead: 0,
      behind: 0,
      expected_worktree_state: "clean",
      permitted_dirty_paths: [],
      captured_at: "2026-07-17T09:00:00Z"
    },
    risk: "LOW",
    problem: "Test problem.",
    production_truth: [],
    chosen_design: "Test design.",
    authority_map: [],
    invariants: [],
    failure_boundaries: "None.",
    authorized_scope: {
      authorized_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
      permitted_new_paths: [],
      forbidden_paths: [],
      dependency_changes_allowed: false,
      migration_allowed: false,
      configuration_changes_allowed: false,
      source_mutation_allowed: false,
      test_mutation_allowed: false
    },
    non_goals: "None.",
    acceptance: {
      compile_commands: [],
      targeted_tests: [],
      full_suite_commands: [],
      static_checks: [],
      integrity_checks: [],
      negative_evidence: [],
      mutation_evidence: [],
      repetition_requirements: [],
      environment_exclusions: [],
      pass_conditions: "N/A"
    },
    hold_conditions: "N/A",
    rejected_alternatives: "None.",
    open_questions: [],
    human_approval: {
      scope_expansion: false,
      security_exception: false,
      commit: false,
      push: false,
      seal: false,
      destructive_migration: false,
      remote_history_mutation: false
    },
    integrity: "Test integrity.",
    ...overrides
  };
}

function validIE(overrides = {}) {
  return {
    schema_version: "autoloop.implementation-evidence/v1",
    contract_id: "rc-test-001",
    design_revision_id: "rev-test-001",
    design_contract_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    implementation_attempt_id: "impl-test-001",
    parent_attempt_id: "",
    executor_invocation: validMI({ role: "executor", invocation_id: "inv-executor-001" }),
    repository_baseline: {
      repository: "example-repo",
      branch: "main",
      head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      origin_ref: "origin/main",
      origin_head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ahead: 0,
      behind: 0,
      expected_worktree_state: "clean",
      permitted_dirty_paths: [],
      captured_at: "2026-07-17T09:00:00Z"
    },
    initial_integrity: "Pre integrity.",
    final_integrity: "Post integrity.",
    authorized_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
    actual_changed_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
    patch_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    commands: [],
    compile_results: [],
    test_results: [],
    negative_evidence: [],
    mutation_evidence: [],
    skipped_evidence: [],
    known_failures: [],
    environment_limits: {},
    scope_deviations: [],
    executor_verdict: "PASS",
    timestamps: {
      started_at: "2026-07-17T11:00:00Z",
      completed_at: "2026-07-17T11:30:00Z"
    },
    integrity: "Evidence integrity.",
    ...overrides
  };
}

describe("POSITIVE TESTS", () => {
  test("1: valid model invocation accepted", () => {
    const r = validateModelInvocation(validMI());
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("2: effective_model NOT_REPORTED_BY_PROVIDER accepted", () => {
    const r = validateModelInvocation(validMI({ effective_model: "NOT_REPORTED_BY_PROVIDER" }));
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("3: valid provider-neutral Role Contract accepted", () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, "role-contract-valid.json"), "utf8"));
    const r = validateRoleContract(data);
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("4: valid Implementation Evidence Bundle accepted", () => {
    const data = JSON.parse(readFileSync(join(FIXTURES, "implementation-evidence-valid.json"), "utf8"));
    const r = validateImplementationEvidence(data);
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("5: arbitrary made-up provider+model strings validate (neutrality)", () => {
    const r = validateModelInvocation(validMI({
      provider: "acme-labs",
      configured_model: "acme-labs/nimbus-7",
      requested_model: "acme-labs/nimbus-7-beta",
      effective_model: "acme-labs/nimbus-7",
      provider_request_id: "acme-req-999"
    }));
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("6: legacy card-input.schema.json remains unchanged", () => {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "card-input.schema.json"), "utf8"));
    assert.strictEqual(schema.$schema, "http://json-schema.org/draft-07/schema#");
    const required = schema.required;
    assert.ok(Array.isArray(required));
    assert.ok(required.includes("card_id"));
    assert.ok(required.includes("mode"));
    assert.ok(required.includes("executor"));
    assert.ok(required.includes("scope"));
    assert.ok(required.includes("limits"));
    assert.ok(required.includes("card_body"));
    assert.strictEqual(required.length, 9);
  });
});

describe("NEGATIVE TESTS", () => {
  test("1: unknown top-level field rejected", () => {
    const r = validateModelInvocation(validMI({ unknown_field: "should be rejected" }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("unknown_field")), `expected unknown_field error, got: ${JSON.stringify(r.errors)}`);
  });

  test("2: missing authority-bearing field rejected", () => {
    const { role, ...rest } = validMI();
    const r = validateModelInvocation(rest);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("role")), `expected role error, got: ${JSON.stringify(r.errors)}`);
  });

  test("3: provider-specific semantic field rejected as unknown", () => {
    const r = validateModelInvocation(validMI({ deepseek_executor: "forbidden" }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("deepseek_executor")), `expected deepseek_executor error, got: ${JSON.stringify(r.errors)}`);
  });

  test("4: invalid SHA-256 rejected", () => {
    const r = validateImplementationEvidence(validIE({ design_contract_hash: "not-a-hex-string" }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("design_contract_hash")), `expected hash error, got: ${JSON.stringify(r.errors)}`);
  });

  test("5: absolute path rejected", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["/etc/passwd", "valid/path/file.txt"],
        permitted_new_paths: [],
        forbidden_paths: [],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("absolute")), `expected absolute path error, got: ${JSON.stringify(r.errors)}`);
  });

  test("6: ../ traversal rejected", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["valid/path/file.txt", "../outside/file.txt"],
        permitted_new_paths: [],
        forbidden_paths: [],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("traversal")), `expected traversal error, got: ${JSON.stringify(r.errors)}`);
  });

  test("7: duplicate normalized path rejected", () => {
    const r = validateImplementationEvidence(validIE({
      actual_changed_paths: [
        "scripts/ai/autoloop/validate-role-artifacts.mjs",
        "scripts/ai/autoloop/validate-role-artifacts.mjs"
      ]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("duplicate")), `expected duplicate path error, got: ${JSON.stringify(r.errors)}`);
  });

  test("8: bare repository-wide wildcard rejected", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["**"],
        permitted_new_paths: [],
        forbidden_paths: [],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("wildcard")), `expected wildcard error, got: ${JSON.stringify(r.errors)}`);
  });

  test("9: duplicate stable IDs rejected", () => {
    const r = validateRoleContract(validRC({
      production_truth: [
        {
          fact_id: "dup-001",
          claim: "First entry",
          evidence_type: "code",
          reference: "ref1",
          confidence: "HIGH",
          freshness: "2026-07-17T09:00:00Z"
        },
        {
          fact_id: "dup-001",
          claim: "Duplicate fact_id",
          evidence_type: "code",
          reference: "ref2",
          confidence: "LOW",
          freshness: "2026-07-17T09:00:00Z"
        }
      ]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("duplicate") && e.includes("fact_id")), `expected duplicate fact_id error, got: ${JSON.stringify(r.errors)}`);
  });

  test("10: execution-ready contract with unresolved blocking:true question rejected", () => {
    const r = validateRoleContract(validRC({
      open_questions: [
        {
          question_id: "oq-blocking-001",
          owner_role: "designer",
          blocking: true,
          required_evidence: "Needs resolution.",
          resolution_stage: "design"
        }
      ]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("blocking")), `expected blocking question error, got: ${JSON.stringify(r.errors)}`);
  });

  test("10b: execution-ready contract with only non-blocking questions passes", () => {
    const r = validateRoleContract(validRC({
      open_questions: [
        {
          question_id: "oq-nonblocking-001",
          owner_role: "designer",
          blocking: false,
          required_evidence: "N/A",
          resolution_stage: "design"
        }
      ]
    }));
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("11: missing final_integrity rejected", () => {
    const { final_integrity, ...rest } = validIE();
    const r = validateImplementationEvidence(rest);
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("final_integrity")), `expected final_integrity error, got: ${JSON.stringify(r.errors)}`);
  });

  test("12: invalid executor invocation rejected", () => {
    const r = validateImplementationEvidence(validIE({
      executor_invocation: { bad: "object", missing: true }
    }));
    assert.strictEqual(r.valid, false);
  });

  test("13: oversized array rejected", () => {
    const manyItems = [];
    for (let i = 0; i < 201; i++) {
      manyItems.push({ command: `cmd-${i}`, status: "ok", exit_code: 0 });
    }
    const r = validateImplementationEvidence(validIE({ commands: manyItems }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("exceeds_max")), `expected maxItems error, got: ${JSON.stringify(r.errors)}`);
  });

  test("14: legacy card fixture remains valid under existing (untouched) schema", () => {
    const legacyCard = JSON.parse(readFileSync(join(FIXTURES, "minimal-readonly-card.json"), "utf8"));
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "card-input.schema.json"), "utf8"));
    const required = new Set(schema.required);
    for (const field of required) {
      assert.ok(Object.hasOwn(legacyCard, field), `legacy card missing required field: ${field}`);
    }
    for (const field of Object.keys(legacyCard)) {
      if (!Object.hasOwn(schema.properties, field)) {
        assert.strictEqual(schema.additionalProperties, true, `legacy card has field ${field} but schema has additionalProperties:false`);
      }
    }
  });
});

describe("POSITIVE TESTS — NESTED ARRAYS", () => {
  test("P+1: role contract with valid populated nested arrays passes", () => {
    const r = validateRoleContract(validRC({
      production_truth: [{
        fact_id: "pt-001", claim: "Claim", evidence_type: "code",
        reference: "ref1", confidence: "HIGH",
        freshness: "2026-07-17T09:00:00Z"
      }],
      authority_map: [{
        authority_id: "am-001", owner_role: "designer",
        source_of_truth: "contract", creation_point: "design",
        validation_point: "design", mutation_point: "implement",
        terminal_state: "approved", forbidden_alternate_owners: ["reviewer"]
      }],
      invariants: [{
        invariant_id: "inv-001", statement: "Invariant",
        applicable_stage: "implement", evidence_requirement: "test",
        violation_severity: "HIGH"
      }],
      open_questions: [{
        question_id: "oq-001", owner_role: "designer",
        blocking: false, required_evidence: "N/A",
        resolution_stage: "design"
      }]
    }));
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });

  test("P+2: implementation evidence with valid populated nested arrays passes", () => {
    const r = validateImplementationEvidence(validIE({
      commands: [{ command: "npm test", status: "ok", exit_code: 0 }],
      compile_results: [{ command: "cargo check", status: "ok", exit_code: 0 }],
      test_results: [{ test_identifier: "t1", outcome: "passed", command: "npm test" }],
      negative_evidence: [{ claim: "No errors", evidence_type: "log" }],
      mutation_evidence: [{ path: "src/main.rs", change_type: "modified" }],
      skipped_evidence: [{ claim: "Not needed", reason: "Out of scope" }],
      known_failures: [{ description: "Known issue", severity: "LOW" }],
      scope_deviations: [{ path: "src/lib.rs", reason: "Required by test", authorized: true }]
    }));
    assert.strictEqual(r.valid, true, `expected valid, got errors: ${JSON.stringify(r.errors)}`);
  });
});

describe("NEGATIVE TESTS — NESTED VALIDATION", () => {
  test("N1: authority_map item missing owner_role", () => {
    const r = validateRoleContract(validRC({
      authority_map: [{
        authority_id: "am-001",
        source_of_truth: "contract", creation_point: "design",
        validation_point: "design", mutation_point: "implement",
        terminal_state: "approved", forbidden_alternate_owners: ["reviewer"]
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("owner_role")), `expected owner_role error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N2: production_truth item missing fact_id", () => {
    const r = validateRoleContract(validRC({
      production_truth: [{
        claim: "Test claim", evidence_type: "code",
        reference: "ref1", confidence: "HIGH",
        freshness: "2026-07-17T09:00:00Z"
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("fact_id")), `expected fact_id error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N3: invariants item missing evidence_requirement", () => {
    const r = validateRoleContract(validRC({
      invariants: [{
        invariant_id: "inv-001", statement: "Test invariant",
        applicable_stage: "implement", violation_severity: "HIGH"
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("evidence_requirement")), `expected evidence_requirement error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N4: open_questions item missing owner_role", () => {
    const r = validateRoleContract(validRC({
      open_questions: [{
        question_id: "oq-001", blocking: true,
        required_evidence: "Needs resolution", resolution_stage: "design"
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("owner_role")), `expected owner_role error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N5: open_questions item missing resolution_stage", () => {
    const r = validateRoleContract(validRC({
      open_questions: [{
        question_id: "oq-002", owner_role: "designer",
        blocking: false, required_evidence: "N/A"
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("resolution_stage")), `expected resolution_stage error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N6: incomplete acceptance object", () => {
    const r = validateRoleContract(validRC({
      acceptance: { compile_commands: ["cmd1"] }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("acceptance") && e.includes("missing")), `expected acceptance missing error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N7: commands item missing status", () => {
    const r = validateImplementationEvidence(validIE({
      commands: [{ command: "npm test", exit_code: 0 }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("status")), `expected status error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N8: commands item missing exit_code", () => {
    const r = validateImplementationEvidence(validIE({
      commands: [{ command: "npm test", status: "ok" }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("exit_code")), `expected exit_code error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N9: compile_results item missing command", () => {
    const r = validateImplementationEvidence(validIE({
      compile_results: [{ status: "ok", exit_code: 0 }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("command")), `expected command error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N10: test_results item missing outcome", () => {
    const r = validateImplementationEvidence(validIE({
      test_results: [{ test_identifier: "test-001", command: "npm test" }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("outcome")), `expected outcome error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N11: nested authority_map item is null", () => {
    const r = validateRoleContract(validRC({
      authority_map: [null]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("not_object")), `expected not_object error, got: ${JSON.stringify(r.errors)}`);
  });

  test("N12: nested production_truth item has unknown field", () => {
    const r = validateRoleContract(validRC({
      production_truth: [{
        fact_id: "pt-001", claim: "Claim", evidence_type: "code",
        reference: "ref1", confidence: "HIGH",
        freshness: "2026-07-17T09:00:00Z",
        malicious_field: "should be rejected"
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("unknown_field")), `expected unknown_field error, got: ${JSON.stringify(r.errors)}`);
  });
});

describe("POSITIVE TESTS — STRING ARRAYS", () => {
  test("SA1: empty string arrays remain valid", () => {
    const r = validateRoleContract(validRC());
    assert.strictEqual(r.valid, true, `expected valid, got: ${JSON.stringify(r.errors)}`);
  });

  test("SA2: populated all-string acceptance arrays remain valid", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: ["cmd1", "cmd2"],
        targeted_tests: ["test1", "test2"],
        full_suite_commands: ["suite"],
        static_checks: ["check"],
        integrity_checks: ["integrity"],
        negative_evidence: ["ne"],
        mutation_evidence: ["me"],
        repetition_requirements: ["rep"],
        environment_exclusions: ["excl"],
        pass_conditions: "all pass"
      }
    }));
    assert.strictEqual(r.valid, true, `expected valid, got: ${JSON.stringify(r.errors)}`);
  });

  test("SA3: populated string-array fields (authority_map, scope, baseline) pass", () => {
    const r = validateRoleContract(validRC({
      authority_map: [{
        authority_id: "am-1", owner_role: "designer",
        source_of_truth: "contract", creation_point: "design",
        validation_point: "design", mutation_point: "implement",
        terminal_state: "approved",
        forbidden_alternate_owners: ["reviewer", "executor"]
      }],
      repository_baseline: {
        repository: "example-repo", branch: "main",
        head: "a".repeat(40), origin_ref: "origin/main",
        origin_head: "b".repeat(40), ahead: 0, behind: 0,
        expected_worktree_state: "clean",
        permitted_dirty_paths: ["tmp/log.txt"],
        captured_at: "2026-07-17T09:00:00Z"
      }
    }));
    assert.strictEqual(r.valid, true, `expected valid, got: ${JSON.stringify(r.errors)}`);
  });

  test("SA4: authoritative_paths path checks remain active", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
        permitted_new_paths: ["new/file.txt"],
        forbidden_paths: ["secret/"],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, true, `expected valid, got: ${JSON.stringify(r.errors)}`);
  });

  test("SA5: arbitrary provider strings in model invocation remain valid", () => {
    const r = validateModelInvocation(validMI({
      provider: "custom-vendor",
      configured_model: "custom-vendor/model-x",
      requested_model: "custom-vendor/model-x-beta",
      effective_model: "custom-vendor/model-x",
      provider_request_id: "req-xyz"
    }));
    assert.strictEqual(r.valid, true, `expected valid, got: ${JSON.stringify(r.errors)}`);
  });
});

describe("NEGATIVE TESTS — STRING ARRAY ITEM TYPES", () => {
  test("SAn1: acceptance.compile_commands has integer element", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: [123], targeted_tests: [],
        full_suite_commands: [], static_checks: [],
        integrity_checks: [], negative_evidence: [],
        mutation_evidence: [], repetition_requirements: [],
        environment_exclusions: [], pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("compile_commands") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn2: acceptance.targeted_tests has null element", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: [], targeted_tests: [null],
        full_suite_commands: [], static_checks: [],
        integrity_checks: [], negative_evidence: [],
        mutation_evidence: [], repetition_requirements: [],
        environment_exclusions: [], pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("targeted_tests") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn3: acceptance.full_suite_commands has object element", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: [], targeted_tests: [],
        full_suite_commands: [{}], static_checks: [],
        integrity_checks: [], negative_evidence: [],
        mutation_evidence: [], repetition_requirements: [],
        environment_exclusions: [], pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("full_suite_commands") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn4: acceptance.environment_exclusions has boolean element", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: [], targeted_tests: [],
        full_suite_commands: [], static_checks: [],
        integrity_checks: [], negative_evidence: [],
        mutation_evidence: [], repetition_requirements: [],
        environment_exclusions: [false], pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("environment_exclusions") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn5: authority_map[0].forbidden_alternate_owners has numeric element", () => {
    const r = validateRoleContract(validRC({
      authority_map: [{
        authority_id: "am-1", owner_role: "designer",
        source_of_truth: "c", creation_point: "design",
        validation_point: "design", mutation_point: "implement",
        terminal_state: "approved", forbidden_alternate_owners: [42]
      }]
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("forbidden_alternate_owners") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn6: authorized_scope.permitted_new_paths has numeric element", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
        permitted_new_paths: [42],
        forbidden_paths: [],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("permitted_new_paths") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn7: authorized_scope.forbidden_paths has null element", () => {
    const r = validateRoleContract(validRC({
      authorized_scope: {
        authorized_paths: ["scripts/ai/autoloop/validate-role-artifacts.mjs"],
        permitted_new_paths: [],
        forbidden_paths: [null],
        dependency_changes_allowed: false,
        migration_allowed: false,
        configuration_changes_allowed: false,
        source_mutation_allowed: false,
        test_mutation_allowed: false
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("forbidden_paths") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn8: repository_baseline.permitted_dirty_paths has numeric element", () => {
    const r = validateRoleContract(validRC({
      repository_baseline: {
        repository: "example-repo", branch: "main",
        head: "a".repeat(40), origin_ref: "origin/main",
        origin_head: "b".repeat(40), ahead: 0, behind: 0,
        expected_worktree_state: "clean",
        permitted_dirty_paths: [7],
        captured_at: "2026-07-17T09:00:00Z"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("permitted_dirty_paths") && e.includes("[0]")), `expected index 0 error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn9: mixed valid string and numeric element rejected", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: ["valid-cmd", 8],
        targeted_tests: [], full_suite_commands: [],
        static_checks: [], integrity_checks: [],
        negative_evidence: [], mutation_evidence: [],
        repetition_requirements: [], environment_exclusions: [],
        pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("compile_commands") && e.includes("[1]")), `expected compile_commands[1] error, got: ${JSON.stringify(r.errors)}`);
  });

  test("SAn10: acceptance array element that is itself an array", () => {
    const r = validateRoleContract(validRC({
      acceptance: {
        compile_commands: [["nested"]],
        targeted_tests: [], full_suite_commands: [],
        static_checks: [], integrity_checks: [],
        negative_evidence: [], mutation_evidence: [],
        repetition_requirements: [], environment_exclusions: [],
        pass_conditions: "ok"
      }
    }));
    assert.strictEqual(r.valid, false);
    assert.ok(r.errors.some(e => e.includes("compile_commands") && e.includes("[0]")), `expected compile_commands[0] error, got: ${JSON.stringify(r.errors)}`);
  });
});
