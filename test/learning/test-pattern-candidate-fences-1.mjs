import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { EVENT_TYPES, EVENT_TYPES_V2, AUTHORITY_EVENT_TYPE } from "../../src/learning/transfer-metrics/schema.mjs";

const REPO = fileURLToPath(new URL("../..", import.meta.url));


test("F1 EVENT_TYPES stays closed at 14 types", () => {
  assert.equal(EVENT_TYPES.length, 14);
  assert.equal(EVENT_TYPES[0], "INCIDENT_OBSERVED");
});

test("F2 no source adapter or incident emitter", () => {
  const incidentsDir = join(REPO, "src/learning/incidents");
  if (existsSync(incidentsDir)) {
    assert.deepEqual(readdirSync(incidentsDir).sort(), ["current-verification.mjs", "lifecycle-terminal-adapter.mjs", "projection.mjs"]);
  }
  assert.equal(existsSync(join(REPO, "src/learning/incident-observation")), false);
  assert.equal(existsSync(join(REPO, "src/learning/patterns/candidate-store.mjs")), false);
});

test("F3 no production caller of the candidate module outside the allowed seam", () => {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".mjs")) continue;
      const rel = relative(REPO, p);
      if (rel.startsWith("src/learning/patterns/") || rel.startsWith("src/learning/transfer-metrics/") || rel.startsWith("src/learning/incidents/") || rel.startsWith("test/")) continue;
      if (!rel.startsWith("src/") && !rel.startsWith("scripts/")) continue;
      const text = readFileSync(p, "utf8");
      for (const n of ["patterns/candidate", "buildCandidatePayload", "buildCandidateProjection"]) {
        if (text.includes(n)) hits.push({ rel, needle: n });
      }
    }
  };
  walk(join(REPO, "src"));
  assert.equal(hits.length, 0, JSON.stringify(hits));
});

test("F4 EVENT_TYPES_V2 unchanged and authority event still sealed", () => {
  assert.equal(EVENT_TYPES_V2.length, 15);
  assert.equal(AUTHORITY_EVENT_TYPE, "LEARNING_AUTHORITY_STATE_CHANGED");
});
