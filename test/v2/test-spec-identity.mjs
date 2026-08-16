// test/v2/test-spec-identity.mjs
//
// AUTOLOOP-REVART-IMPL1-RC2 — canonical spec-text identity tests.
// Zero provider, zero Pi, zero credential, zero network.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalSpecBytes,
  specDigestOf,
  SpecIdentityError,
} from "../../src/governance/spec-identity.mjs";

const buf = (s) => Buffer.from(s, "utf8");

test("UTF-8 normal content hashes deterministically", () => {
  const a = specDigestOf(buf("line1\nline2\n"));
  const b = specDigestOf(buf("line1\nline2\n"));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("leading BOM is stripped (BOM and non-BOM produce same digest)", () => {
  const plain = specDigestOf(buf("spec body\n"));
  const withBom = specDigestOf(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf("spec body\n")]));
  assert.equal(plain, withBom);
});

test("CRLF is normalized to LF (CRLF and LF produce same digest)", () => {
  const lf = specDigestOf(buf("a\nb\nc"));
  const crlf = specDigestOf(buf("a\r\nb\r\nc"));
  assert.equal(lf, crlf);
});

test("standalone CR is NOT silently normalized", () => {
  // lone \r stays as \r; \n stays as \n — distinct normalized bytes
  const loneCr = specDigestOf(buf("a\rb"));
  const lf = specDigestOf(buf("a\nb"));
  assert.notEqual(loneCr, lf);
  // canonical bytes preserve the lone CR byte
  assert.equal(canonicalSpecBytes(buf("a\rb")).toString("utf8"), "a\rb");
});

test("content mutation produces a different digest", () => {
  const a = specDigestOf(buf("spec v1"));
  const b = specDigestOf(buf("spec v2"));
  assert.notEqual(a, b);
});

test("path is excluded by construction (digest is a pure function of bytes)", () => {
  // The function accepts bytes only — no path argument exists. Same bytes,
  // regardless of any caller-side path notion, must hash identically.
  const a = specDigestOf(buf("same"));
  const b = specDigestOf(buf("same"));
  assert.equal(a, b);
});

test("malformed UTF-8 fails closed", () => {
  const bad = Buffer.from([0xff, 0xfe, 0xfd, 0x41]);
  assert.throws(() => specDigestOf(bad), (e) => e instanceof SpecIdentityError && e.code === "SPEC_UTF8_INVALID");
  assert.throws(() => canonicalSpecBytes(bad), SpecIdentityError);
});

test("empty spec hashes deterministically (not rejected)", () => {
  assert.equal(specDigestOf(buf("")), specDigestOf(buf("")));
});
