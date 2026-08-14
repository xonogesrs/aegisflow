// test/admission/test-capability-registry.mjs
//
// TA-2 — capability registry tests（Z Unit; NEG4）: deny-by-default, parity
// with the envelope TOOL_PERMISSIONS / SUBAGENT_ROLES vocabulary, alias
// resolution, and the full TA-1 capability set.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilityRegistry,
  listCapabilities,
  resolveCapability,
  resolveCapabilityId,
  isKnownCapability,
  assertRegistryParity,
  CAPABILITY_ALIASES,
  CAPABILITY_DEFAULT_STATE,
} from "../../src/admission/registry.mjs";
import { TOOL_PERMISSIONS, SUBAGENT_ROLES } from "../../src/subagent/subagent-contract.mjs";

test("registry covers the full TA-1 capability set (>= 23 CAP.* ids)", () => {
  const caps = listCapabilities();
  assert.ok(caps.length >= 23, `got ${caps.length}`);
  for (const id of ["CAP.GRAPH_SCHEDULER", "CAP.READONLY_SUBAGENT", "CAP.WRITER_SUBAGENT", "CAP.INDEPENDENT_REVIEW", "CAP.BOUNDED_REPAIR", "CAP.COLIMA_ISOLATION", "CAP.WORKTREE_ISOLATION", "CAP.SINGLE_WRITER_LEASE", "CAP.DURABLE_EXECUTION", "CAP.CHECKPOINT_RESUME", "CAP.MEMORY_RETRIEVAL", "CAP.MEMORY_WRITEBACK", "CAP.TELEMETRY", "CAP.REVIEW_BUNDLE", "CAP.EXTERNAL_REVIEW_DELIVERY", "CAP.CLOSEOUT_STATE", "CAP.EVIDENCE_GENERATION", "CAP.SECRET_SECURITY", "CAP.LIFECYCLE_GOVERNANCE", "CAP.RISK_NORMALIZATION", "CAP.TASK_DECOMPOSITION", "CAP.PI_TRANSPORT", "CAP.C2D_ATOMIC_STATE"]) {
    assert.ok(caps.includes(id), `missing ${id}`);
  }
});

test("every capability entry carries the required attributes + default DENIED", () => {
  const required = ["capability_id", "purpose", "required_permissions", "mutation_capability", "network_capability", "isolation_requirement", "durability_relevance", "evidence_requirement", "allowed_actor", "allowed_execution_boundary", "risk_implications", "default_state"];
  for (const id of listCapabilities()) {
    const c = resolveCapability(id);
    for (const k of required) {
      assert.ok(c[k] !== undefined && c[k] !== null && c[k] !== "", `${id} missing ${k}`);
    }
    assert.equal(c.default_state, CAPABILITY_DEFAULT_STATE, `${id} must be DENIED by default`);
    assert.equal(typeof c.mutation_capability, "boolean");
    assert.equal(typeof c.network_capability, "boolean");
  }
});

test("deny-by-default: unknown capability id resolves to null (NEG4)", () => {
  assert.equal(resolveCapability("CAP.DOES_NOT_EXIST"), null);
  assert.equal(resolveCapabilityId("totally.bogus"), null);
  assert.equal(isKnownCapability("totally.bogus"), false);
});

test("parity: registry vocabulary agrees with envelope TOOL_PERMISSIONS + SUBAGENT_ROLES", () => {
  const p = assertRegistryParity();
  assert.equal(p.ok, true, p.errors.join("; "));
  // the permission vocabulary IS the envelope tool permission keys
  const permKeys = Object.keys(TOOL_PERMISSIONS);
  for (const id of listCapabilities()) {
    const c = resolveCapability(id);
    for (const perm of c.required_permissions) {
      assert.ok(permKeys.includes(perm), `${id} references unknown permission ${perm}`);
    }
  }
  const actorKeys = new Set([...SUBAGENT_ROLES, "controller", "admission", "graph_node", "decomposer", "verifier", "closeout_gate", "durable_layer", "checkpoint_bridge", "writeback_gate", "telemetry_observer", "research", "subagent"]);
  for (const id of listCapabilities()) {
    for (const a of resolveCapability(id).allowed_actor) {
      assert.ok(actorKeys.has(a), `${id} references unknown actor ${a}`);
    }
  }
});

test("policy-level aliases resolve to CAP.* ids (NEG4 machine verification basis)", () => {
  assert.equal(resolveCapabilityId("subagent"), "CAP.READONLY_SUBAGENT");
  assert.equal(resolveCapabilityId("writer"), "CAP.WRITER_SUBAGENT");
  assert.equal(resolveCapabilityId("colima"), "CAP.COLIMA_ISOLATION");
  assert.equal(resolveCapabilityId("durable_execution"), "CAP.DURABLE_EXECUTION");
  assert.equal(resolveCapabilityId("checkpoint_resume"), "CAP.CHECKPOINT_RESUME");
  assert.equal(resolveCapabilityId("independent_review"), "CAP.INDEPENDENT_REVIEW");
  assert.equal(resolveCapabilityId("review_bundle"), "CAP.REVIEW_BUNDLE");
  assert.equal(resolveCapabilityId("external_review"), "CAP.EXTERNAL_REVIEW_DELIVERY");
  assert.equal(resolveCapabilityId("memory_retrieval"), "CAP.MEMORY_RETRIEVAL");
  assert.equal(resolveCapabilityId("memory_writeback"), "CAP.MEMORY_WRITEBACK");
  assert.equal(resolveCapabilityId("decomposition"), "CAP.TASK_DECOMPOSITION");
  assert.equal(resolveCapabilityId("commit_push_merge"), "CAP.LIFECYCLE_GOVERNANCE");
  assert.ok(Object.keys(CAPABILITY_ALIASES).length >= 15);
});

test("mutation/network capability flags are set correctly for the critical caps", () => {
  assert.equal(resolveCapability("CAP.WRITER_SUBAGENT").mutation_capability, true);
  assert.equal(resolveCapability("CAP.MEMORY_WRITEBACK").mutation_capability, true);
  assert.equal(resolveCapability("CAP.READONLY_SUBAGENT").mutation_capability, false);
  assert.equal(resolveCapability("CAP.LIFECYCLE_GOVERNANCE").network_capability, true);
  assert.equal(resolveCapability("CAP.PI_TRANSPORT").network_capability, true);
});
