// test/memory/test-lifecycle-contract.mjs
//
// RUNG-6 Step 1 test (TEST-MATRIX family 18 neighbor-regression shape +
// TEST-AND-MUTATION-PLAN Step-1 invariant): the contract.mjs additive block
// exists exactly as frozen; every pre-existing export is byte-identical to
// the sealed RUNG-5 values (deep-equal snapshot); the kind set is CLOSED.
//
// Oracle form: status + exact value + set identity (ORACLE-CONTRACT dual
// layer — a bare truthy check is inadmissible).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as contract from "../../src/memory/contract.mjs";

// ——— Step-1 invariant: the additive block exists, exactly as frozen ———

test("L-C1. LIFECYCLE_EVENT_KINDS is the frozen closed 5-kind set", () => {
  assert.deepEqual([...contract.LIFECYCLE_EVENT_KINDS], [
    "PROMOTE", "DEMOTE", "ARCHIVE", "REMOVE", "OP_CANCEL",
  ]);
  assert.equal(Object.isFrozen(contract.LIFECYCLE_EVENT_KINDS), true);
});

test("L-C2. the two admission-authorized fine-code constants carry the exact frozen values", () => {
  assert.equal(contract.LIFECYCLE_TRANSITION_ILLEGAL, "LIFECYCLE_TRANSITION_ILLEGAL");
  assert.equal(contract.LIFECYCLE_TERMINAL_IMMUTABLE, "LIFECYCLE_TERMINAL_IMMUTABLE");
});

test("L-C3. SPEC_AMENDMENT_REQUIRED declared as the frozen HOLD-class label (no semantics attached)", () => {
  assert.equal(contract.SPEC_AMENDMENT_REQUIRED, "SPEC_AMENDMENT_REQUIRED");
  // A4.4 law: declaration only — the module must expose no consumption path,
  // no gate, no transition (a declarative module has no functions at all).
  const fns = Object.entries(contract).filter(([, v]) => typeof v === "function");
  assert.deepEqual(fns, [], "contract.mjs must stay declarative (no logic/IO)");
});

test("L-C4. kind-set closedness: no 6th kind, no REACTIVATE/RESTORE/REOPEN alias exists", () => {
  const names = Object.keys(contract);
  assert.equal(contract.LIFECYCLE_EVENT_KINDS.length, 5);
  for (const banned of ["REACTIVATE", "RESTORE", "REOPEN"]) {
    assert.equal(
      contract.LIFECYCLE_EVENT_KINDS.includes(banned), false,
      `banned kind ${banned} must not exist`,
    );
    assert.equal(
      names.some((n) => n.toUpperCase().includes(banned)), false,
      `no export may alias ${banned}`,
    );
  }
});

// ——— Neighbor-regression invariant: pre-existing exports byte-identical ———
// Deep-equal snapshot of every pre-existing export (Step-1 rollback boundary:
// delete the added block ⇒ these values are the whole module again).

const PREEXISTING_SNAPSHOT = {
  MEMORY_RECORD_SCHEMA: "autoloop.memory-record/v1",
  MEMORY_JOURNAL_EVENT_SCHEMA: "autoloop.memory-journal-event/v1",
  MEMORY_SCHEMA_VERSION: 1,
  RECORD_TYPES: ["CODE", "EXECUTION", "DECISION", "PATTERN"],
  PATTERN_APPLICABILITY_DECISIONS: ["APPLIES", "DOES_NOT_APPLY", "REQUIRES_QUALIFICATION"],
  PATTERN_BOUNDARY_OPERATORS: ["PATH_PREFIX", "SYMBOL_EQUALS", "TREE_MATCHES", "TOOL_EQUALS", "ERROR_CLASS_IN", "LANGUAGE_EQUALS"],
  PATTERN_MECHANISM_SIGNATURE_FIELDS: ["errorClass", "tool", "language", "invariant"],
  TRUST_STATES: ["RAW", "UNVERIFIED", "VERIFIED", "REVIEWED", "CONFIRMED"],
  TRUST_RANK: { RAW: 0, UNVERIFIED: 1, VERIFIED: 2, REVIEWED: 3, CONFIRMED: 4 },
  VALIDITY_STATUSES: ["CURRENT", "STALE", "INVALIDATED", "TOMBSTONED", "CONFLICTED"],
  LIFECYCLE_EVENT_TYPES: ["CREATED", "VALIDATED", "PROMOTED", "DOWNGRADED", "MARKED_STALE", "INVALIDATED", "TOMBSTONED", "SUPERSEDED", "RESTORED", "MIGRATED"],
  SCOPES: ["repository", "worktree", "commit", "tree", "path", "symbol", "content", "graphRun", "task", "global"],
  SOURCES: ["REPOSITORY", "EXECUTION", "VERIFIER", "INDEPENDENT_REVIEW", "CONTROLLER", "IMPORT", "DERIVED"],
  RELATIONSHIP_TYPES: ["DERIVED_FROM", "VERIFIES", "REVIEWS", "SUPERSEDES", "INVALIDATES", "CONFLICTS_WITH", "APPLIES_TO", "PRODUCED_BY"],
  KNOWLEDGE_KINDS: ["FILE", "SYMBOL", "API", "INVARIANT", "TEST", "CONFIGURATION", "DEPENDENCY", "ARCHITECTURE"],
  RESULT_KINDS: ["TASK_RESULT", "TEST_RESULT", "VERIFIER_RESULT", "REVIEW_RESULT", "REPAIR_RESULT", "CHECKPOINT_RESULT"],
  DECISION_TYPES: ["ARCHITECTURE", "SELECTION", "STANDARD", "LIMITATION", "ROLLBACK_CONDITION"],
  DECISION_STATUSES: ["proposed", "accepted", "rejected", "superseded", "revoked"],
  AUTHORITIES: ["SYSTEM_DERIVED", "VERIFIER", "INDEPENDENT_REVIEWER", "CONTROLLER"],
  CONTENT_KINDS: ["TEXT", "STRUCTURED"],
  NOT_APPLICABLE: "NOT_APPLICABLE",
  NOT_APPLICABLE_LEGAL: {
    CODE: ["identity.worktreeIdentity", "identity.symbol", "subject.language", "evidence.manifestDigest", "validity.validityTree"],
    EXECUTION: ["identity.nodeId", "identity.phaseExecutionId", "identity.agentExecutionId", "identity.attempt", "subject.completedAt", "evidence.manifestDigest", "validity.validityTree"],
    DECISION: ["subject.supersedes", "evidence.manifestDigest", "validity.validityTree"],
    PATTERN: ["identity.worktreeIdentity", "identity.symbol", "subject.language", "subject.completedAt", "content.data.counterexamples", "evidence.manifestDigest", "validity.validityTree"],
  },
  ENVELOPE_FIELDS: ["schema", "recordId", "recordType", "identity", "subject", "content", "source", "scope", "trust", "validity", "lifecycle", "timestamps", "evidence", "security", "metadata"],
  RESEARCH_MARKERS: ["SOURCE", "DERIVED", "INFERENCE", "RECOMMENDATION", "IMPLEMENTED_CONTRACT", "TEST_VERIFIED"],
};

test("L-C5. every pre-existing export is byte-identical to the sealed values (deep-equal snapshot)", () => {
  for (const [name, value] of Object.entries(PREEXISTING_SNAPSHOT)) {
    assert.deepEqual(contract[name], value, `pre-existing export changed: ${name}`);
    if (Array.isArray(value) || typeof value === "object") {
      assert.equal(Object.isFrozen(contract[name]), true, `${name} must stay frozen`);
    }
  }
});

test("L-C6. export count = pre-existing 25 + additive 4 (no fifth invention, no loss)", () => {
  const names = Object.keys(contract);
  assert.equal(names.length, Object.keys(PREEXISTING_SNAPSHOT).length + 4);
  const added = ["LIFECYCLE_EVENT_KINDS", "LIFECYCLE_TRANSITION_ILLEGAL", "LIFECYCLE_TERMINAL_IMMUTABLE", "SPEC_AMENDMENT_REQUIRED"];
  for (const a of added) assert.equal(names.includes(a), true, `missing additive export ${a}`);
});
