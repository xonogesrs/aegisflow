// test/admission/test-retrieval-authority.mjs
//
// R-10 (AUTH1) — retrieval authority.
//
// The single authoritative predicate is isRetrievalAuthorized(admission):
// retrieval is authorized IFF the admitted policy projection declares
// `memory_policy.retrieval_allowed === true`. Provider availability is never
// authority. These unit tests pin the fail-closed decision for the negative
// matrix (retrieval deny / missing / malformed), while
// test/memory/test-graph-context.mjs (G5) proves the seam is wired into
// runColimaGraph (authorized → provider invoked → INVALID → HOLD).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetrievalAuthorized } from "../../src/admission/policy-projection.mjs";

const admission = (retrievalAllowed) => ({ memory_policy: { retrieval_allowed: retrievalAllowed } });

test("R-10: retrieval_allowed === true → retrieval authorized", () => {
  assert.equal(isRetrievalAuthorized(admission(true)), true);
});

test("R-10: retrieval_allowed === false → retrieval denied (no retrieval)", () => {
  assert.equal(isRetrievalAuthorized(admission(false)), false);
});

test("R-10: missing memory_policy / missing admission → fail closed (no retrieval)", () => {
  assert.equal(isRetrievalAuthorized(admission(undefined)), false);
  assert.equal(isRetrievalAuthorized({}), false);
  assert.equal(isRetrievalAuthorized({ memory_policy: {} }), false);
  assert.equal(isRetrievalAuthorized(null), false);
  assert.equal(isRetrievalAuthorized(undefined), false);
});

test("R-10: malformed (non-boolean) retrieval_allowed → fail closed (no retrieval)", () => {
  assert.equal(isRetrievalAuthorized({ memory_policy: { retrieval_allowed: "true" } }), false);
  assert.equal(isRetrievalAuthorized({ memory_policy: { retrieval_allowed: 1 } }), false);
  assert.equal(isRetrievalAuthorized({ memory_policy: { retrieval_allowed: {} } }), false);
  assert.equal(isRetrievalAuthorized({ memory_policy: { retrieval_allowed: [] } }), false);
});
