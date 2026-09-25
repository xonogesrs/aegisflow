#!/usr/bin/env node
// scripts/autoloop-operator.mjs
//
// COMPATIBILITY ALIAS — the operator entrypoint was renamed to
// `scripts/aegisflow-operator.mjs` by
// AEGISFLOW_PROJECT_RENAME_AND_COMPATIBILITY_MIGRATION_1.
//
// Existing automation, runbooks and shell history that invoke the pre-rename
// file name keep working: this forwards the argument vector verbatim and exits
// with the real entrypoint's status. It performs no work of its own and writes
// nothing.
//
// Contract: the operator surface is READ ONLY / ADVISORY either way — zero
// writes, no production authority consumes its output, and it is safe against
// active, completed, partially retained, telemetry-disabled, and unknown runs.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET = join(HERE, "aegisflow-operator.mjs");

const r = spawnSync(process.execPath, [TARGET, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
