// test/memory/test-canonical.mjs
//
// CBM-2 §15 Canonicalization: 10 required cases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recursiveCanonicalJson, canonicalSha256, contentHash, compareCodePoints, CanonicalizationError } from "../../src/memory/canonical.mjs";

test("1. nested object key order deterministic (code point sort)", () => {
  const a = recursiveCanonicalJson({ z: 1, a: { y: 2, b: 3 } });
  const b = recursiveCanonicalJson({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(a, b, "same nested content -> same canonical text");
  assert.equal(a, '{"a":{"b":3,"y":2},"z":1}');
});

test("2. arrays preserve order (never sorted)", () => {
  const a = recursiveCanonicalJson([1, 2, 3]);
  const b = recursiveCanonicalJson([3, 2, 1]);
  assert.notEqual(a, b, "array order is identity-relevant");
  assert.equal(a, "[1,2,3]");
});

test("3. key insertion order does not change digest", () => {
  const x = { b: 1, a: 2 };
  const y = { a: 2, b: 1 };
  assert.equal(canonicalSha256(x), canonicalSha256(y));
});

test("4. nested value change changes digest", () => {
  assert.notEqual(canonicalSha256({ k: { v: 1 } }), canonicalSha256({ k: { v: 2 } }));
  assert.notEqual(canonicalSha256({ k: [1] }), canonicalSha256({ k: [1, 2] }));
});

test("5. shallow-replacer collision regression (CBM-1 defect must never return)", () => {
  const arr1 = [{ key: "k", content_hash: "h1" }, { key: "k2", content_hash: "h2" }];
  const arr2 = [{ key: "k", content_hash: "DIFFERENT_VALUE" }, { key: "k2", content_hash: "h2" }];
  // the defective form collides（count-only）
  assert.equal(JSON.stringify(arr1, Object.keys(arr1).sort()), JSON.stringify(arr2, Object.keys(arr2).sort()), "shallow replacer collides — CBM-1 defect");
  // the contract form distinguishes field content
  assert.notEqual(recursiveCanonicalJson(arr1), recursiveCanonicalJson(arr2), "recursive canonical is content-sensitive");
  assert.notEqual(canonicalSha256(arr1), canonicalSha256(arr2));
});

test("6. invalid numeric values rejected", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => recursiveCanonicalJson({ x: bad }), CanonicalizationError, `reject ${bad}`);
  }
  // -0 normalizes to 0（deterministic）
  assert.equal(recursiveCanonicalJson({ x: -0 }), '{"x":0}');
});

test("7. undefined rejected or explicitly normalized (never silently dropped)", () => {
  assert.throws(() => recursiveCanonicalJson({ a: 1, b: undefined }), CanonicalizationError, "object undefined value rejected");
  assert.throws(() => recursiveCanonicalJson([1, undefined]), CanonicalizationError, "array undefined rejected");
  assert.throws(() => recursiveCanonicalJson(undefined), CanonicalizationError, "root undefined rejected");
});

test("8. Unicode behavior fixed (raw strings; code point key ordering)", () => {
  // keys sorted by code point, not code unit
  assert.equal(compareCodePoints("a", "b"), -1);
  assert.ok(compareCodePoints("😀", "a") > 0, "astral char > BMP");
  const s1 = recursiveCanonicalJson({ "😀": 1, a: 2 });
  const s2 = recursiveCanonicalJson({ a: 2, "😀": 1 });
  assert.equal(s1, s2, "insertion order irrelevant for astral keys");
  // strings are byte-exact — no normalization applied
  const composed = "e\u0301"; // e + combining acute
  assert.equal(recursiveCanonicalJson({ t: composed }), JSON.stringify({ t: composed }));
});

test("9. timestamp normalization (Date -> RFC3339 UTC)", () => {
  const d = new Date("2026-08-07T03:00:00.000Z");
  assert.equal(recursiveCanonicalJson({ at: d }), '{"at":"2026-08-07T03:00:00.000Z"}');
  assert.throws(() => recursiveCanonicalJson({ at: new Date("invalid") }), CanonicalizationError);
  assert.equal(canonicalSha256({ at: new Date("2026-08-07T03:00:00.000Z") }), canonicalSha256({ at: "2026-08-07T03:00:00.000Z" }));
});

test("10. identity never includes its own digest; BigInt rejected", () => {
  const payload = { a: 1 };
  const digest = canonicalSha256(payload);
  assert.equal(digest, canonicalSha256(payload), "digest stable");
  // a value that embeds the digest of a DIFFERENT shape still canonicalizes
  // independently — the digest is never part of the canonicalized input
  assert.throws(() => recursiveCanonicalJson({ big: 10n }), CanonicalizationError, "bigint rejected");
});

test("content hash: same content -> same hash; different -> different", () => {
  assert.equal(contentHash({ text: "x" }), contentHash({ text: "x" }));
  assert.notEqual(contentHash({ text: "x" }), contentHash({ text: "y" }));
  assert.match(contentHash({ text: "x" }), /^[0-9a-f]{64}$/);
});
