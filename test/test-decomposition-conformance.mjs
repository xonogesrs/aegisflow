// test/test-decomposition-conformance.mjs
//
// Card 3 — Static Decomposition Conformance Suite
// Validates E1–E12 fixtures against eval cases, production schema, and Card 1 validator.
// Includes mutation-based negative controls to prove matcher effectiveness.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validate as validateJsonSchema } from "../src/shared/json-schema-validator.mjs";
import { validateDecomposition } from "../src/validate-decomposition.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

const EVAL_CASES_PATH = join(REPO_ROOT, "test", "fixtures", "task-decomposition-eval-cases.json");
const EVAL_SCHEMA_PATH = join(REPO_ROOT, "src", "schema", "task-decomposition-eval-cases.schema.json");
const FIXTURES_DIR = join(HERE, "fixtures", "decomposition-outputs");
const EXPECTED_CASE_IDS = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12"];

// ── Test-only manifests for E9 and E10 (static structure only) ──
const E9_TEST_ONLY_MANIFEST = [
  { requirement_id: "R1", text: "建立 foundation" },
  { requirement_id: "R2", text: "實作功能" },
  { requirement_id: "R3", text: "執行驗證" },
  { requirement_id: "R4", text: "外部 review" }
];

const E10_TEST_ONLY_MANIFEST = [
  { requirement_id: "R1", text: "執行 audit" },
  { requirement_id: "R2", text: "實作功能" },
  { requirement_id: "R3", text: "外部 review" }
];

// ── Load eval dataset and schemas ──
const evalDataset = JSON.parse(readFileSync(EVAL_CASES_PATH, "utf8"));
const evalSchema = JSON.parse(readFileSync(EVAL_SCHEMA_PATH, "utf8"));
const casesMap = new Map();
for (const c of evalDataset.cases) {
  casesMap.set(c.case_id, c);
}

// ── Load all fixtures ──
const fixtureEntries = readdirSync(FIXTURES_DIR)
  .filter(f => f.endsWith(".json"))
  .sort();
const fixturesMap = new Map();
for (const f of fixtureEntries) {
  fixturesMap.set(f.replace(".json", ""), JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")));
}

// ── Helper: natural sort for E1..E12 ──
function naturalSort(arr) {
  return [...arr].sort((a, b) => {
    const na = parseInt(a.replace(/^E/, ""), 10);
    const nb = parseInt(b.replace(/^E/, ""), 10);
    return na - nb;
  });
}

// ── Helper: construct parentCard from case authority_boundary ──
function buildParentCard(caseDef) {
  const ab = caseDef.authority_boundary || {};
  return {
    card_id: `CARD_3_${caseDef.case_id}`,
    mode: "IMPLEMENT",
    limits: {
      mutation_allowed: ab.mutation_allowed === true,
      commit_allowed: ab.commit_allowed === true,
      push_allowed: ab.push_allowed === true
    },
    scope: {
      allowed_paths: ab.allowed_paths ?? [],
      forbidden_paths: []
    }
  };
}

// ── Helper: get requirement manifest for a case ──
function getManifest(caseDef) {
  if (caseDef.case_id === "E9") return E9_TEST_ONLY_MANIFEST;
  if (caseDef.case_id === "E10") return E10_TEST_ONLY_MANIFEST;
  return caseDef.parent_requirement_manifest ?? [];
}

// ── Helper: deep clone ──
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Cycle detection (DFS, for matcher) ──
function detectCycle(roleIds, edges) {
  const adj = new Map();
  for (const r of roleIds) adj.set(r, []);
  for (const e of edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const r of roleIds) color.set(r, WHITE);
  function dfs(node, path) {
    color.set(node, GRAY);
    path.push(node);
    for (const next of (adj.get(node) || [])) {
      const c = color.get(next);
      if (c === GRAY) {
        const s = path.indexOf(next);
        return [...path.slice(s), next];
      }
      if (c === WHITE) {
        const result = dfs(next, path);
        if (result) return result;
      }
    }
    path.pop();
    color.set(node, BLACK);
    return null;
  }
  for (const role of roleIds) {
    if (color.get(role) === WHITE) {
      const result = dfs(role, []);
      if (result) return result;
    }
  }
  return null;
}

// ── Helper: check if path is within parent scope ──
function pathWithinScope(childPath, parentPaths) {
  if (parentPaths.length === 0) return true; // no restriction
  const normalized = childPath.replace(/\/+$/, "");
  return parentPaths.some(p => {
    const np = p.replace(/\/+$/, "");
    return normalized === np || normalized.startsWith(np + "/");
  });
}

// ── Conformance Matcher ──
function checkConformance({ caseDefinition, fixture, parentCard, requirementManifest }) {
  const failures = [];
  const expected = caseDefinition.expected_decomposition || {};

  // 9.2 Verdict
  if (expected.expected_verdict && fixture.verdict !== expected.expected_verdict) {
    failures.push(`verdict: expected ${expected.expected_verdict}, got ${fixture.verdict}`);
  }

  // 9.3 Card count
  if (expected.min_cards !== undefined || expected.max_cards !== undefined) {
    const count = (fixture.child_cards || []).length;
    if (expected.min_cards !== undefined && count < expected.min_cards) {
      failures.push(`card count ${count} < min ${expected.min_cards}`);
    }
    if (expected.max_cards !== undefined && count > expected.max_cards) {
      failures.push(`card count ${count} > max ${expected.max_cards}`);
    }
  }

  // 9.4 Required card types
  if (expected.required_card_types) {
    const types = (fixture.child_cards || []).map(c => c.card_type);
    for (const req of expected.required_card_types) {
      if (!types.includes(req)) {
        failures.push(`missing required card type: ${req}`);
      }
    }
  }

  // 9.5 Required edges (default type = depends_on)
  if (expected.required_edges) {
    const roleIds = new Set((fixture.child_cards || []).map(c => c.role_id));
    const fixtureEdges = fixture.edges || [];
    const edgeSet = new Set(
      fixtureEdges.map(e => {
        const type = e.type || "depends_on";
        return `${e.from}→${e.to} [${type}]`;
      })
    );
    for (const re of expected.required_edges) {
      const type = re.type || "depends_on";
      const key = `${re.from}→${re.to} [${type}]`;
      if (!edgeSet.has(key)) {
        if (!roleIds.has(re.from)) {
          failures.push(`required edge from unknown role: ${re.from}`);
        } else if (!roleIds.has(re.to)) {
          failures.push(`required edge to unknown role: ${re.to}`);
        } else {
          failures.push(`missing required edge: ${key}`);
        }
      }
    }
  }

  // 9.6 Required coverage
  if (expected.required_coverage_items) {
    const covMap = fixture.coverage_map || [];
    for (const item of expected.required_coverage_items) {
      if (item.role_id === "__any__") {
        const covered = covMap.some(c => c.requirement_id === item.requirement_id);
        if (!covered) {
          failures.push(`coverage: ${item.requirement_id} not covered by any role (__any__ unmatched)`);
        }
      } else {
        const matched = covMap.some(c =>
          c.requirement_id === item.requirement_id && c.role_id === item.role_id
        );
        if (!matched) {
          failures.push(`coverage: ${item.requirement_id} not covered by role "${item.role_id}"`);
        }
      }
    }
  }

  // 9.7 Deferred items
  if (expected.required_deferred_items) {
    const deferred = fixture.deferred_items || [];
    for (const item of expected.required_deferred_items) {
      const matched = deferred.some(d =>
        d.requirement_id === item.requirement_id && d.reason_code === item.reason_code
      );
      if (!matched) {
        failures.push(`deferred: ${item.requirement_id}/${item.reason_code} not found`);
      }
    }
  }

  // 9.7b Unresolved items
  if (expected.required_unresolved_items) {
    const unresolved = fixture.unresolved_items || [];
    for (const item of expected.required_unresolved_items) {
      const matched = unresolved.some(u =>
        u.requirement_id === item.requirement_id && u.reason_code === item.reason_code
      );
      if (!matched) {
        failures.push(`unresolved: ${item.requirement_id}/${item.reason_code} not found`);
      }
    }
  }

  // 9.8 Execution policy
  if (expected.required_execution_policy) {
    const ep = fixture.execution_policy;
    if (!ep) {
      failures.push("execution_policy missing");
    } else {
      const rp = expected.required_execution_policy;
      if (ep.executor !== rp.executor) failures.push(`execution_policy.executor: expected ${rp.executor}, got ${ep.executor}`);
      if (ep.reviewer !== rp.reviewer) failures.push(`execution_policy.reviewer: expected ${rp.reviewer}, got ${ep.reviewer}`);
      if (ep.multi_model_orchestration !== rp.multi_model_orchestration) failures.push(`execution_policy.multi_model_orchestration: expected ${rp.multi_model_orchestration}, got ${ep.multi_model_orchestration}`);
    }
  }

  // 9.9 Forbidden properties (child_cards, edges)
  if (expected.forbidden) {
    for (const prop of expected.forbidden) {
      if (prop === "child_cards" && fixture.child_cards !== undefined) {
        failures.push("forbidden property child_cards present");
      }
      if (prop === "edges" && fixture.edges !== undefined) {
        failures.push("forbidden property edges present");
      }
    }
  }

  // 9.10 Production __any__ check — must never appear in production fixture
  if (fixture.verdict === "DECOMPOSED") {
    const childRoles = (fixture.child_cards || []).map(c => c.role_id);
    if (childRoles.includes("__any__")) {
      failures.push("production fixture contains reserved role_id __any__");
    }
    for (const cov of (fixture.coverage_map || [])) {
      if (cov.role_id === "__any__") {
        failures.push(`production fixture coverage_map contains reserved role_id __any__ for ${cov.requirement_id}`);
      }
    }
  }

  // ── General structural checks (always applied, not just per expectation) ──

  if (fixture.verdict === "DECOMPOSED") {
    // Commit/push must be false for ALL child cards
    for (const c of (fixture.child_cards || [])) {
      if (c.authority_required && c.authority_required.commit_allowed === true) {
        failures.push(`child ${c.role_id} has commit_allowed=true (always forbidden)`);
      }
      if (c.authority_required && c.authority_required.push_allowed === true) {
        failures.push(`child ${c.role_id} has push_allowed=true (always forbidden)`);
      }
    }

    // Unknown edge role
    const roleIds = new Set((fixture.child_cards || []).map(c => c.role_id));
    for (const e of (fixture.edges || [])) {
      if (!roleIds.has(e.from)) failures.push(`edge references unknown role: ${e.from}`);
      if (!roleIds.has(e.to)) failures.push(`edge references unknown role: ${e.to}`);
      if (e.from === e.to) failures.push(`self-dependency: ${e.from}→${e.to}`);
    }

    // Cycle detection
    const allRoles = Array.from(roleIds);
    const cycle = detectCycle(allRoles, fixture.edges || []);
    if (cycle) failures.push(`cycle detected: ${cycle.join(" → ")}`);

    // Path containment (from parent scope)
    if (parentCard && parentCard.scope) {
      const pPaths = parentCard.scope.allowed_paths || [];
      if (pPaths.length > 0) {
        for (const c of (fixture.child_cards || [])) {
          for (const path of (c.allowed_paths || [])) {
            if (!pathWithinScope(path, pPaths)) {
              failures.push(`child ${c.role_id} allowed_path "${path}" not in parent scope`);
            }
          }
        }
      }
    }
  }

  // Forbidden authority expansions
  if (expected.forbidden_authority_expansions) {
    for (const exp of expected.forbidden_authority_expansions) {
      if (exp === "commit_allowed: true") {
        for (const c of (fixture.child_cards || [])) {
          if (c.authority_required && c.authority_required.commit_allowed === true) {
            failures.push(`forbidden authority expansion: ${c.role_id} has commit_allowed=true`);
          }
        }
      }
      if (exp === "push_allowed: true") {
        for (const c of (fixture.child_cards || [])) {
          if (c.authority_required && c.authority_required.push_allowed === true) {
            failures.push(`forbidden authority expansion: ${c.role_id} has push_allowed=true`);
          }
        }
      }
      if (exp === "allowed_paths 超出範圍") {
        const parentPaths = (parentCard && parentCard.scope && parentCard.scope.allowed_paths) || [];
        for (const c of (fixture.child_cards || [])) {
          for (const path of (c.allowed_paths || [])) {
            if (parentPaths.length > 0 && !pathWithinScope(path, parentPaths)) {
              failures.push(`forbidden authority expansion: ${c.role_id} allowed_path "${path}" exceeds parent scope`);
            }
          }
        }
      }
    }
  }

  return failures;
}

// ── Negative control helper ──
function expectFail(desc, caseDef, fixture, parentCard, manifest, mutateFn) {
  const mutated = clone(fixture);
  mutateFn(mutated);
  // Run both matcher AND Card 1 validator on the mutated copy
  const mFailures = checkConformance({
    caseDefinition: caseDef,
    fixture: mutated,
    parentCard,
    requirementManifest: manifest
  });
  const vResult = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: mutated });
  const totalFailures = mFailures.length + (vResult.valid ? 0 : 1);
  return { desc, passed: totalFailures > 0, mFailures, vResult };
}

// ============================================================================
// TEST SUITE
// ============================================================================

// ── Section 0: Eval dataset validation ──
describe("eval dataset", () => {
  it("passes eval-cases schema validation", () => {
    const result = validateJsonSchema(evalSchema, evalDataset);
    assert.equal(result.valid, true, `Schema errors: ${result.errors.join("; ")}`);
  });

  it("contains exactly E1–E12 with unique case_ids", () => {
    const ids = evalDataset.cases.map(c => c.case_id);
    const sorted = naturalSort(ids);
    assert.deepStrictEqual(sorted, EXPECTED_CASE_IDS,
      `Expected E1-E12, got ${sorted.join(",")}`);
    assert.equal(new Set(ids).size, ids.length, "case_ids not unique");
  });

  it("has exactly 12 fixtures matching case IDs", () => {
    const names = fixtureEntries.map(f => f.replace(".json", ""));
    const sorted = naturalSort(names);
    assert.deepStrictEqual(sorted, EXPECTED_CASE_IDS,
      `Expected E1-E12 fixtures, got ${sorted.join(",")}`);
  });
});

// ── Section 1–12: Per-case conformance ──
for (const caseId of EXPECTED_CASE_IDS) {
  describe(`${caseId} static conformance`, () => {
    const caseDef = casesMap.get(caseId);
    const fixture = fixturesMap.get(caseId);
    const parentCard = buildParentCard(caseDef);
    const manifest = getManifest(caseDef);

    it("fixture is a plain decomposition object (no wrapper)", () => {
      assert.ok(fixture, "fixture must exist");
      assert.equal(typeof fixture.verdict, "string", "fixture must have a verdict");
      assert.ok(!fixture.input, "fixture must not have input wrapper");
      assert.ok(!fixture.expected, "fixture must not have expected wrapper");
      assert.ok(!fixture.decomposition, "fixture must not have decomposition wrapper");
    });

    it("passes Card 1 production validator", () => {
      const result = validateDecomposition({ parentCard, requirementManifest: manifest, decomposition: fixture });
      assert.equal(result.valid, true, `Validator errors: ${JSON.stringify(result.errors)}`);
    });

    it("passes expected_decomposition conformance matcher", () => {
      const failures = checkConformance({
        caseDefinition: caseDef,
        fixture,
        parentCard,
        requirementManifest: manifest
      });
      assert.equal(failures.length, 0, `Matcher failures:\n${failures.join("\n")}`);
    });

    // Per-case specific assertions
    if (caseId === "E1" || caseId === "E11") {
      it("is NOT_BENEFICIAL with no child_cards", () => {
        assert.equal(fixture.verdict, "DECOMPOSITION_NOT_BENEFICIAL");
        assert.ok(!fixture.child_cards);
        assert.ok(!fixture.edges);
      });
    }

    if (caseId === "E2") {
      it("all children have commit_allowed=false, push_allowed=false", () => {
        for (const c of fixture.child_cards) {
          assert.equal(c.authority_required.commit_allowed, false, `${c.role_id} commit_allowed`);
          assert.equal(c.authority_required.push_allowed, false, `${c.role_id} push_allowed`);
        }
      });
    }

    if (caseId === "E4") {
      it("has exactly 2 cards: migration_file and offline_test", () => {
        assert.equal(fixture.child_cards.length, 2);
        const roles = fixture.child_cards.map(c => c.role_id).sort();
        assert.deepStrictEqual(roles, ["migration_file", "offline_test"]);
      });
      it("no card claims live DB mutation access", () => {
        for (const c of fixture.child_cards) {
          const combined = JSON.stringify(c).toLowerCase();
          assert.ok(!combined.includes("production alter"), `${c.role_id} must not claim production ALTER`);
          assert.ok(!combined.includes("production db"), `${c.role_id} must not claim production DB`);
        }
      });
    }

    if (caseId === "E5") {
      it("has exactly 1 child card", () => {
        assert.equal(fixture.child_cards.length, 1);
      });
      it("fixture does not use __any__", () => {
        for (const c of fixture.child_cards) {
          assert.notEqual(c.role_id, "__any__");
        }
        for (const cov of (fixture.coverage_map || [])) {
          assert.notEqual(cov.role_id, "__any__");
        }
      });
    }

    if (caseId === "E6") {
      it("has between 3 and 7 cards", () => {
        const n = fixture.child_cards.length;
        assert.ok(n >= 3 && n <= 7, `Expected 3-7 cards, got ${n}`);
      });
      it("covers all R1–R6", () => {
        const covered = new Set((fixture.coverage_map || []).map(c => c.requirement_id));
        for (const r of ["R1", "R2", "R3", "R4", "R5", "R6"]) {
          assert.ok(covered.has(r), `${r} not covered`);
        }
      });
    }

    if (caseId === "E7") {
      it("has exactly 3 cards: audit, fix, test", () => {
        assert.equal(fixture.child_cards.length, 3);
        const roles = fixture.child_cards.map(c => c.role_id).sort();
        assert.deepStrictEqual(roles, ["audit", "fix", "test"]);
      });
      it("all child allowed_paths within parent scope", () => {
        for (const c of fixture.child_cards) {
          for (const path of (c.allowed_paths || [])) {
            const ok = path === "src/utils/helper.js" || path === "test/utils/" ||
                       path.startsWith("test/utils/") || path === "src/utils/" ||
                       path.startsWith("src/utils/");
            assert.ok(ok, `${c.role_id}: path "${path}" outside permitted scope`);
          }
        }
      });
    }

    if (caseId === "E8") {
      it("is BLOCKED with no child_cards or edges", () => {
        assert.equal(fixture.verdict, "DECOMPOSITION_BLOCKED");
        assert.ok(!fixture.child_cards);
        assert.ok(!fixture.edges);
      });
      it("has R1 / CYCLIC_DEPENDENCY", () => {
        const ur = fixture.unresolved_items.find(u => u.requirement_id === "R1");
        assert.ok(ur, "R1 unresolved item missing");
        assert.equal(ur.reason_code, "CYCLIC_DEPENDENCY");
      });
    }

    if (caseId === "E9") {
      it("static DAG: foundation → impl → test → review (4 cards)", () => {
        assert.equal(fixture.child_cards.length, 4);
        const roles = fixture.child_cards.map(c => c.role_id);
        assert.deepStrictEqual(roles, ["foundation", "impl", "test", "review"]);
      });
      it("static structure only — no execution semantics", () => {
        // Verify no runtime execution state keywords in fixture
        const str = JSON.stringify(fixture).toLowerCase();
        assert.ok(!str.includes('"status"'), "fixture must not contain execution status");
        assert.ok(!str.includes('"result"'), "fixture must not contain execution result");
      });
    }

    if (caseId === "E10") {
      it("static DAG: audit → impl → review (3 cards)", () => {
        assert.equal(fixture.child_cards.length, 3);
        const roles = fixture.child_cards.map(c => c.role_id);
        assert.deepStrictEqual(roles, ["audit", "impl", "review"]);
      });
      it("static structure only — no checkpoint/resume", () => {
        const str = JSON.stringify(fixture).toLowerCase();
        assert.ok(!str.includes('"status"'), "fixture must not contain execution status");
      });
    }

    if (caseId === "E12") {
      it("execution_policy locked to INHERIT_PARENT/EXTERNAL_GPT/false", () => {
        const ep = fixture.execution_policy;
        assert.equal(ep.executor, "INHERIT_PARENT");
        assert.equal(ep.reviewer, "EXTERNAL_GPT");
        assert.equal(ep.multi_model_orchestration, false);
      });
      it("no multi-model references in role assignments", () => {
        const str = JSON.stringify(fixture).toLowerCase();
        assert.ok(!str.includes('"claude"'), "must not reference Claude");
        assert.ok(!str.includes('"opencode"'), "must not reference OpenCode");
        assert.ok(!str.includes('"deepseek"'), "must not reference DeepSeek");
      });
    }
  });
}

// ── Section: Matcher Negative Controls ──
describe("matcher negative controls", () => {
  // Use E2 as the base for most mutations
  const e2Case = casesMap.get("E2");
  const e2Fixture = fixturesMap.get("E2");
  const e2Parent = buildParentCard(e2Case);
  const e2Manifest = getManifest(e2Case);

  // NC1: wrong verdict
  it("NC1: wrong verdict → fail", () => {
    const r = expectFail("wrong verdict", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.verdict = "DECOMPOSITION_NOT_BENEFICIAL"; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M:${r.mFailures.length} V:${r.vResult.valid}`);
  });

  // NC2: fewer than min_cards
  it("NC2: fewer than min_cards → fail", () => {
    const r = expectFail("min_cards", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.child_cards = f.child_cards.slice(0, 3); });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC3: more than max_cards (E2 max=5, add a 6th card)
  it("NC3: more than max_cards → fail", () => {
    const r = expectFail("max_cards", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      const extra = clone(f.child_cards[0]);
      extra.card_id = "E2_extra1";
      extra.role_id = "extra1";
      f.child_cards.push(extra);
      const extra2 = clone(f.child_cards[0]);
      extra2.card_id = "E2_extra2";
      extra2.role_id = "extra2";
      f.child_cards.push(extra2);
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC4: missing required card type
  it("NC4: missing required card type → fail", () => {
    const r = expectFail("missing card type", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      f.child_cards[0].card_type = "IMPLEMENTATION";
      f.child_cards[0].authority_required.mutation_allowed = true;
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC5: missing required edge
  it("NC5: missing required edge → fail", () => {
    const r = expectFail("missing edge", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.edges = f.edges.filter(e => !(e.from === "audit" && e.to === "impl")); });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC6: wrong named role in coverage
  it("NC6: wrong named role → fail", () => {
    const r = expectFail("wrong role", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      const cov = f.coverage_map.find(c => c.requirement_id === "R1");
      if (cov) cov.role_id = "wrong_role";
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC7: __any__ wildcard matches real role (should PASS — positive control)
  it("NC7: __any__ wildcard matches real role → pass", () => {
    const e5Case = casesMap.get("E5");
    const e5Fixture = fixturesMap.get("E5");
    const e5Parent = buildParentCard(e5Case);
    const e5Manifest = getManifest(e5Case);
    const failures = checkConformance({
      caseDefinition: e5Case,
      fixture: e5Fixture,
      parentCard: e5Parent,
      requirementManifest: e5Manifest
    });
    assert.equal(failures.length, 0, `__any__ should match real role: ${failures.join("; ")}`);
  });

  // NC8: production role_id="__any__" → fail
  it("NC8: production role_id=__any__ → fail", () => {
    const r = expectFail("__any__ in production", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.child_cards[0].role_id = "__any__"; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC9: missing required coverage item
  it("NC9: missing required coverage item → fail", () => {
    const r = expectFail("missing coverage", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.coverage_map = f.coverage_map.filter(c => c.requirement_id !== "R2"); });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC10: deferred reason_code wrong
  it("NC10: deferred reason_code wrong → fail", () => {
    const r = expectFail("wrong deferred code", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      const d = f.deferred_items.find(d => d.requirement_id === "R4");
      if (d) d.reason_code = "OTHER";
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC11: unresolved reason_code wrong
  it("NC11: unresolved reason_code wrong → fail", () => {
    const e4Case = casesMap.get("E4");
    const e4Fixture = fixturesMap.get("E4");
    const e4Parent = buildParentCard(e4Case);
    const e4Manifest = getManifest(e4Case);
    const r = expectFail("wrong unresolved code", e4Case, e4Fixture, e4Parent, e4Manifest, f => {
      const u = f.unresolved_items.find(u => u.requirement_id === "R3");
      if (u) u.reason_code = "OTHER";
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC12: execution_policy deviation (use E12 which has required_execution_policy)
  it("NC12: execution_policy deviation → fail", () => {
    const e12Case = casesMap.get("E12");
    const e12Fixture = fixturesMap.get("E12");
    const e12Parent = buildParentCard(e12Case);
    const e12Manifest = getManifest(e12Case);
    const r = expectFail("execution policy", e12Case, e12Fixture, e12Parent, e12Manifest,
      f => { f.execution_policy.executor = "CLAUDE"; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC13: child allowed_paths beyond parent scope
  it("NC13: child allowed_paths expand beyond parent → fail", () => {
    const r = expectFail("path expansion", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.child_cards[0].allowed_paths = ["etc/passwd"]; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M: ${r.mFailures.join("; ")}, V:${r.vResult.valid}`);
  });

  // NC14: child commit_allowed=true
  it("NC14: child commit_allowed=true → fail", () => {
    const r = expectFail("commit allowed", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.child_cards[0].authority_required.commit_allowed = true; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC15: child push_allowed=true
  it("NC15: child push_allowed=true → fail", () => {
    const r = expectFail("push allowed", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.child_cards[0].authority_required.push_allowed = true; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC16: cycle → fail
  it("NC16: cycle → fail", () => {
    const r = expectFail("cycle", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      f.edges.push({ from: "review", to: "audit", type: "depends_on" });
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M: ${r.mFailures.join("; ")}, V:${r.vResult.valid}`);
  });

  // NC17: unknown edge role → fail
  it("NC17: unknown edge role → fail", () => {
    const r = expectFail("unknown edge role", e2Case, e2Fixture, e2Parent, e2Manifest,
      f => { f.edges.push({ from: "audit", to: "nonexistent", type: "depends_on" }); });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M: ${r.mFailures.join("; ")}, V:${r.vResult.valid}`);
  });

  // NC18: NOT_BENEFICIAL with child_cards → fail
  it("NC18: NOT_BENEFICIAL with child_cards → fail", () => {
    const e1Case = casesMap.get("E1");
    const e1Fixture = fixturesMap.get("E1");
    const e1Parent = buildParentCard(e1Case);
    const e1Manifest = getManifest(e1Case);
    const r = expectFail("NOT_BENEFICIAL + child_cards", e1Case, e1Fixture, e1Parent, e1Manifest, f => {
      f.child_cards = [{
        card_id: "bad", role_id: "bad", goal: "bad", card_type: "IMPLEMENTATION",
        authority_required: { commit_allowed: false, push_allowed: false, mutation_allowed: false },
        verification: { required_commands: [], forbidden_commands: [] }, risk_level: "LOW"
      }];
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M: ${r.mFailures.join("; ")}, V:${r.vResult.valid}`);
  });

  // NC19: __any__ wildcard unmatched → fail
  it("NC19: __any__ wildcard unmatched → fail", () => {
    const e5Case = casesMap.get("E5");
    const e5Fixture = fixturesMap.get("E5");
    const e5Parent = buildParentCard(e5Case);
    const e5Manifest = getManifest(e5Case);
    const r = expectFail("__any__ unmatched", e5Case, e5Fixture, e5Parent, e5Manifest,
      f => { f.coverage_map = []; });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC20: coverage_map role_id=__any__ in production fixture → fail
  it("NC20: coverage_map __any__ in production → fail", () => {
    const r = expectFail("coverage __any__", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      f.coverage_map.push({ requirement_id: "R1", role_id: "__any__", verification: "x" });
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });

  // NC21: BLOCKED with edges → fail
  it("NC21: BLOCKED with edges → fail", () => {
    const e8Case = casesMap.get("E8");
    const e8Fixture = fixturesMap.get("E8");
    const e8Parent = buildParentCard(e8Case);
    const e8Manifest = getManifest(e8Case);
    const r = expectFail("BLOCKED + edges", e8Case, e8Fixture, e8Parent, e8Manifest, f => {
      f.edges = [{ from: "a", to: "b", type: "depends_on" }];
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed. M: ${r.mFailures.join("; ")}, V:${r.vResult.valid}`);
  });

  // NC22: edge type default — missing type still matches depends_on
  it("NC22: missing required edge with wrong from → fail", () => {
    const r = expectFail("edge mismatch", e2Case, e2Fixture, e2Parent, e2Manifest, f => {
      f.edges = f.edges.filter(e => !(e.from === "audit" && e.to === "impl"));
      f.edges.push({ from: "impl", to: "review", type: "depends_on" });
    });
    assert.ok(r.passed, `${r.desc}: expected FAIL but passed`);
  });
});

// ── Section: Boundary guarantees ──
describe("boundary guarantees", () => {
  it("only imports validator and JSON schema (no decomposer, no runner, no HTTP)", () => {
    const content = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const imports = Array.from(content.matchAll(/from\s+['"]([^'"]+)['"]/g)).map(m => m[1]);
    const srcImports = imports.filter(p => p.startsWith("../src/"));
    const allowed = new Set(["../src/validate-decomposition.mjs", "../src/shared/json-schema-validator.mjs"]);
    for (const imp of srcImports) {
      assert.ok(allowed.has(imp), `unexpected production import: ${imp}`);
    }
  });

  it("no filesystem write operations", () => {
    const content = readFileSync(fileURLToPath(import.meta.url), "utf8");
    const hasWriteOp = /\bwriteFile(Sync)?\s*\(/.test(content)
      || /\bmkdir(Sync)?\s*\(/.test(content)
      || /\brmSync\s*\(/.test(content)
      || /\bappendFile(Sync)?\s*\(/.test(content);
    assert.ok(!hasWriteOp, "test file must not contain filesystem write operations");
  });
});
