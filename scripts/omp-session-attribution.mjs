#!/usr/bin/env node
// scripts/omp-session-attribution.mjs
//
// AEGISFLOW_OMP_ATTRIBUTION_CONTRACT_DESIGN_1 — manual CLI for the v1 OMP
// session extractor. DRY-RUN BY DEFAULT: nothing is persisted unless --write.
//
//   node scripts/omp-session-attribution.mjs \
//       --store <evolution store dir> --sessions-root <omp sessions dir> \
//       --allow-cwd <dir> [--allow-cwd <dir> ...] \
//       [--deny-root <dir> ...] [--quiescence-minutes 30] [--synthetic] \
//       [--slug <session dir name> ...] [--key-file <path outside the store>] [--write] [--json]
//
// There is deliberately NO default for --store, --sessions-root or --allow-cwd:
// the operator names exactly what is read and where it is written. An empty
// allowlist refuses to run. Writes land only under <store>/omp-observations/;
// this tool never touches strategy memory, policy, triggers or OMP itself.
//
// cwd identity is a per-store keyed HMAC. --key-file names a user-only (0600)
// file OUTSIDE the store (required with --write; created once for an empty
// store). A missing, unreadable, insecure or mismatching key FAILS CLOSED.
//
// Exit codes: 0 ok · 2 usage · 3 lock busy (never stolen) · 4 key/identity failure.

import { runIngest, DEFAULT_QUIESCENCE_MS } from "../src/evolution/omp-attribution/ingest.mjs";

const DEFAULT_DENY_ROOTS = ["/private/tmp", "/private/var/folders"];

function parse(argv) {
  const o = { allow: [], deny: [], slugs: [], write: false, dryRun: false, json: false, synthetic: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Session directory names may start with "--"; accept --slug=<name>.
    if (a.startsWith("--slug=")) { o.slugs.push(a.slice("--slug=".length)); continue; }
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case "--store": o.store = val(); break;
      case "--sessions-root": o.sessionsRoot = val(); break;
      case "--allow-cwd": o.allow.push(val()); break;
      case "--deny-root": o.deny.push(val()); break;
      case "--quiescence-minutes": o.quiescenceMinutes = Number(val()); break;
      case "--write": o.write = true; break;
      case "--dry-run": o.dryRun = true; break;
      case "--synthetic": o.synthetic = true; break;
      case "--key-file": o.keyFile = val(); break;
      case "--slug": o.slugs.push(val()); break;
      case "--json": o.json = true; break;
      default: throw new Error(`unknown argument: ${a}`);
    }
  }
  return o;
}

function fail(msg, code = 2) {
  console.error(`omp-session-attribution: ${msg}`);
  console.error("usage: --store <dir> --sessions-root <dir> --allow-cwd <dir> [--allow-cwd <dir> ...] "
    + "[--deny-root <dir> ...] [--quiescence-minutes N] [--synthetic] [--slug <dir name> ...] [--key-file <path>] [--write|--dry-run] [--json]");
  process.exit(code);
}

let opts;
try { opts = parse(process.argv.slice(2)); } catch (e) { fail(e.message); }
if (opts.write && opts.dryRun) fail("--write and --dry-run are mutually exclusive");
if (!opts.store) fail("--store is required (no default)");
if (!opts.sessionsRoot) fail("--sessions-root is required (no default)");
if (opts.allow.length === 0) fail("at least one --allow-cwd is required (empty allowlist refuses to run)");
if (opts.quiescenceMinutes !== undefined && !(opts.quiescenceMinutes >= 1)) fail("--quiescence-minutes must be >= 1");

let report;
try {
  report = runIngest({
    storeRoot: opts.store,
    sessionsRoot: opts.sessionsRoot,
    allowRoots: opts.allow,
    denyRoots: [...DEFAULT_DENY_ROOTS, ...opts.deny], // additive: the tmp/scratch exclusion can never be dropped
    write: opts.write,
    quiescenceMs: opts.quiescenceMinutes ? opts.quiescenceMinutes * 60_000 : DEFAULT_QUIESCENCE_MS,
    synthetic: opts.synthetic,
    keyFile: opts.keyFile ?? null,
    onlySlugs: opts.slugs.length > 0 ? opts.slugs : null,
  });
} catch (e) {
  if (e?.code === "OMP_ATTRIBUTION_USAGE") fail(e.message);
  if (typeof e?.code === "string" && e.code.startsWith("OMP_ATTRIBUTION_KEY_")) {
    console.error(`omp-session-attribution: ${e.code}: ${e.message}`);
    process.exit(4);
  }
  console.error(`omp-session-attribution: failed (${e?.code ?? "error"}); no OMP work was affected`);
  process.exit(1);
}

if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`mode: ${report.mode}${report.suspended ? ` · SUSPENDED (${report.suspended})` : ""}`);
  console.log(`lock: ${report.lock}`);
  for (const [k, v] of Object.entries(report.counts).sort()) console.log(`${k}: ${v}`);
}
process.exit(report.lock === "busy" ? 3 : 0);
