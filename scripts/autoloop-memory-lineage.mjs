#!/usr/bin/env node
// scripts/autoloop-memory-lineage.mjs
//
// Declare, inspect and revoke a DEPRECATED repository identity for a CBM store.
//
// A store is bound to `repositoryIdentity = sha256(canonical({remote,
// canonicalPath}))`. Moving a checkout or renaming the remote produces a new
// identity, and every record bound to the old one becomes unreachable — that is
// correct isolation, but it is also how a populated store starts answering
// `selectedRecords: 0`.
//
// This CLI records the ONE thing that can safely bridge that gap: a declared
// lineage edge, bound to evidence, stored BESIDE the store. It never rewrites a
// record (recordId is derived from scope), never merges two records' scopes and
// never infers an equivalence from a name.
//
// Usage:
//   node scripts/autoloop-memory-lineage.mjs list   [--state-root <dir>] [--json]
//   node scripts/autoloop-memory-lineage.mjs show   --repo <path> [--state-root <dir>] [--json]
//   node scripts/autoloop-memory-lineage.mjs declare --repo <path> --alias <hex64> \
//        --evidence <path-or-text> [--state-root <dir>] [--dry-run] [--json]
//   node scripts/autoloop-memory-lineage.mjs revoke --alias <hex64> [--state-root <dir>] [--json]
//
// `declare` requires the alias to be OBSERVED in the store (a record must carry
// it) and requires evidence text; a declaration that cannot be backed by both is
// refused. `revoke` removes every edge pointing at the alias.
//
// Exit codes: 0 ok, 2 refused/fail-closed, 3 usage.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  LocalMemoryStore,
  resolveMemoryStateRoot,
  resolveRepositoryIdentity,
} from "../src/memory/local-store.mjs";
import {
  REPOSITORY_ALIAS_SCHEMA,
  aliasFileFor,
  readAliasRegistry,
  validateAliasRegistry,
} from "../src/memory/repository-aliases.mjs";
import { MEMORY_QUERY_SCHEMA, validateMemoryQueryV1, defaultQuery } from "../src/memory/query-schema.mjs";

const OPTIONS = {
  repo: { type: "string" },
  alias: { type: "string" },
  evidence: { type: "string" },
  "state-root": { type: "string" },
  "dry-run": { type: "boolean", default: false },
  json: { type: "boolean", default: false },
};

const USAGE = `usage:
  node scripts/autoloop-memory-lineage.mjs list   [--state-root <dir>] [--json]
  node scripts/autoloop-memory-lineage.mjs show   --repo <path> [--state-root <dir>] [--json]
  node scripts/autoloop-memory-lineage.mjs declare --repo <path> --alias <hex64> --evidence <path-or-text> \\
        [--state-root <dir>] [--dry-run] [--json]
  node scripts/autoloop-memory-lineage.mjs revoke --alias <hex64> [--state-root <dir>] [--json]`;

const HEX64 = /^[0-9a-f]{64}$/;
const QUIET = { info() {}, warn() {}, error() {} };

function emit(out, json) {
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }
  switch (out.command) {
    case "list":
      if (out.aliases.length === 0) {
        process.stdout.write(`no lineage declared for ${out.aliasFile}\n`);
      } else {
        for (const a of out.aliases) {
          process.stdout.write(`${a.canonical} > ${a.alias}  (${a.recordedAt})\n    evidence: ${a.evidence}\n`);
        }
      }
      break;
    case "show":
      process.stdout.write(`repositoryIdentity ${out.canonical}\n`);
      process.stdout.write(`aliasFile          ${out.aliasFile}\n`);
      process.stdout.write(`lineage            ${out.lineage.length} identity(ies)\n`);
      for (const id of out.lineage) process.stdout.write(`  ${id}${id === out.canonical ? "  (canonical)" : "  (declared alias)"}\n`);
      if (out.reason) process.stdout.write(`registry problem   ${out.reason}\n`);
      break;
    default:
      process.stdout.write(`${out.state}: ${out.message}\n`);
  }
}

/** Every repository identity present in the store, with its record count. */
function storedIdentities(store) {
  const db = store.db;
  if (!db) return [];
  return db.prepare(
    "SELECT scope_repository AS id, COUNT(*) AS n FROM memory_records WHERE scope_repository IS NOT NULL GROUP BY scope_repository ORDER BY scope_repository",
  ).all().map((r) => ({ id: r.id, records: Number(r.n) }));
}

function readEvidence(value) {
  if (existsSync(value)) {
    return { text: readFileSync(value, "utf8").trim().slice(0, 4000), from: value };
  }
  return { text: String(value).trim(), from: null };
}

function writeRegistryAtomic(file, registry) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n");
  renameSync(tmp, file);
}

function main() {
  const command = process.argv[2];
  if (!["list", "show", "declare", "revoke"].includes(command)) {
    console.error(USAGE);
    return 3;
  }
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(3), options: OPTIONS, allowPositionals: false, strict: true }));
  } catch (e) {
    console.error(`usage error: ${e.message}`);
    console.error(USAGE);
    return 3;
  }

  const stateRoot = resolveMemoryStateRoot(values["state-root"] ?? null);
  const aliasFile = aliasFileFor(stateRoot);
  const read = readAliasRegistry(aliasFile);

  if (command === "list") {
    emit({ command, aliasFile, aliases: read.registry.aliases, reason: read.reason }, values.json);
    return read.ok ? 0 : 2;
  }

  if (command === "show") {
    if (!values.repo) {
      console.error("usage error: --repo is required for show");
      return 3;
    }
    const repository = resolveRepositoryIdentity(values.repo);
    const aliasIds = read.registry.aliases.filter((a) => a.canonical === repository.repositoryIdentity).map((a) => a.alias);
    emit({
      command,
      canonical: repository.repositoryIdentity,
      aliasFile,
      lineage: [repository.repositoryIdentity, ...aliasIds],
      aliases: aliasIds,
      reason: read.reason,
    }, values.json);
    return read.ok ? 0 : 2;
  }

  if (!HEX64.test(values.alias ?? "")) {
    console.error("usage error: --alias must be a 64-char lowercase hex identity");
    return 3;
  }

  if (command === "revoke") {
    const before = read.registry.aliases.length;
    const registry = { schema: REPOSITORY_ALIAS_SCHEMA, aliases: read.registry.aliases.filter((a) => a.alias !== values.alias) };
    const removed = before - registry.aliases.length;
    if (removed === 0) {
      emit({ command, state: "NO_SUCH_ALIAS", message: `${values.alias} is not declared in ${aliasFile}`, removed }, values.json);
      return 2;
    }
    writeRegistryAtomic(aliasFile, registry);
    emit({ command, state: "REVOKED", message: `removed ${removed} lineage edge(s) for ${values.alias}`, removed, aliasFile }, values.json);
    return 0;
  }

  // declare
  if (!values.repo) {
    console.error("usage error: --repo is required for declare");
    return 3;
  }
  if (!values.evidence) {
    console.error("usage error: --evidence is required (a file path or an evidence statement)");
    return 3;
  }
  const repository = resolveRepositoryIdentity(values.repo);
  const canonical = repository.repositoryIdentity;
  if (values.alias === canonical) {
    emit({ command, state: "REFUSED", message: "alias equals the canonical identity" }, values.json);
    return 2;
  }

  const store = new LocalMemoryStore({ stateRoot, log: QUIET });
  if (!store.exists()) {
    emit({ command, state: "REFUSED", message: `no store at ${stateRoot}` }, values.json);
    return 2;
  }
  let identities;
  try {
    store.open();
    identities = storedIdentities(store);
  } catch (e) {
    emit({ command, state: "REFUSED", message: `store cannot be opened: ${String(e?.message ?? e).slice(0, 240)}` }, values.json);
    return 2;
  } finally {
    try { store.close(); } catch { /* best effort */ }
  }

  const observed = identities.find((i) => i.id === values.alias);
  if (!observed) {
    emit({
      command,
      state: "REFUSED",
      message: `alias ${values.alias} is not present in the store (nothing to bridge)`,
      present: identities,
    }, values.json);
    return 2;
  }
  const evidence = readEvidence(values.evidence);
  if (evidence.text.length === 0) {
    emit({ command, state: "REFUSED", message: "evidence is empty" }, values.json);
    return 2;
  }

  const entry = {
    canonical,
    alias: values.alias,
    evidence: evidence.text,
    recordedAt: new Date().toISOString(),
  };
  const existing = read.registry.aliases.find((a) => a.canonical === canonical && a.alias === values.alias);
  const registry = {
    schema: REPOSITORY_ALIAS_SCHEMA,
    aliases: existing
      ? read.registry.aliases.map((a) => (a.canonical === canonical && a.alias === values.alias ? entry : a))
      : [...read.registry.aliases, entry],
  };
  const v = validateAliasRegistry(registry);
  if (!v.valid) {
    emit({ command, state: "REFUSED", message: `registry would be invalid: ${v.errors.join(";")}` }, values.json);
    return 2;
  }
  if (values["dry-run"]) {
    emit({ command, state: "DRY_RUN", message: `would record ${canonical} > ${values.alias}`, entry, aliasFile }, values.json);
    return 0;
  }
  writeRegistryAtomic(aliasFile, registry);
  emit({
    command,
    state: existsSync(aliasFile) ? "DECLARED" : "DECLARED",
    message: `recorded ${canonical} > ${values.alias} (${observed.records} stored record(s) become reachable)`,
    entry,
    aliasFile,
  }, values.json);
  return 0;
}

process.exit(main());
