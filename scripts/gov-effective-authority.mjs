#!/usr/bin/env node
// scripts/gov-effective-authority.mjs
//
// Compute effective authority = parent ∩ child ∩ runtime policy (§5).
// Pure computation; prints canonical effective authority JSON.

import { readFileSync } from "node:fs";
import { parseArgs } from "./shared/gov-args.mjs";
import { effectiveAuthority } from "../src/governance/lifecycle-authorization.mjs";

function load(path) {
  if (!path) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  // Pass the whole record when present so top-level bindings (repository /
  // worktree / branch / base / authorized_paths / bundle_path) participate.
  return raw;
}

const { flags } = parseArgs(process.argv.slice(2));
const parent = load(flags.parent);
const child = load(flags.child);
const runtime = load(flags.runtime);

try {
  const effective = effectiveAuthority(parent, child, runtime);
  console.log(JSON.stringify({ effective }, null, 1));
} catch (e) {
  console.error(e.code ?? e.message);
  if (e.details) console.error(e.details);
  process.exit(1);
}
