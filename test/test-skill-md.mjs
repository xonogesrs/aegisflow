import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const skill = readFileSync(join(ROOT, "SKILL.md"), "utf8");

test("SKILL.md has portable frontmatter", () => {
  const m = skill.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
  assert.ok(m, "frontmatter with name and description");
  assert.equal(m[1], "aegisflow");
  assert.ok(m[2].length > 40 && m[2].length < 1024);
});

test("every script SKILL.md tells an agent to run exists", () => {
  const scripts = [...skill.matchAll(/scripts\/[A-Za-z0-9._-]+\.mjs/g)].map((x) => x[0]);
  assert.ok(scripts.length >= 3);
  for (const s of new Set(scripts)) assert.ok(existsSync(join(ROOT, s)), `${s} is referenced but missing`);
});

test("every aegisflow-status flag it documents is accepted by the script", () => {
  const src = readFileSync(join(ROOT, "scripts/aegisflow-status.mjs"), "utf8");
  for (const flag of new Set([...skill.matchAll(/aegisflow-status\.mjs\s+(--[a-z]+)/g)].map((x) => x[1]))) {
    assert.ok(src.includes(`"${flag}"`), `${flag} documented but not parsed`);
  }
});

test("SKILL.md carries no machine-specific path or identifier", () => {
  assert.ok(!/\/Users\/|\/Volumes\/|\/private\/tmp|xonogears|zhengfeng/i.test(skill));
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(skill));
});

test("AGENTS.md points at SKILL.md", () => {
  assert.match(readFileSync(join(ROOT, "AGENTS.md"), "utf8"), /`SKILL\.md`/);
});
