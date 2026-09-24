// test/run-suite.mjs
//
// Default `npm test` entrypoint.
//
// Runs the HOST-ONLY test suite: every suite that needs nothing beyond Node
// and this checkout. Suites that require external infrastructure (a Colima +
// Docker sandbox, a real `pi` installation, or live provider credentials) are
// deliberately excluded here and are run explicitly instead:
//
//   npm run test:colima     # Colima + Docker sandbox suites
//   npm run test:pi-rpc-smoke  # real `pi` + live provider
//   node --test test/tool-selection/*.mjs   # needs a real `pi` install
//
// This file exists because `npm test` was previously undefined and the
// per-card suites were scattered across ~40 npm scripts, so a new user had no
// single honest "does this checkout work" command.
//
// Usage:
//   node test/run-suite.mjs                 # host-only suite (default)
//   node test/run-suite.mjs --list          # print the file list and exit
//   node test/run-suite.mjs --concurrency 1 # override --test-concurrency
//   node test/run-suite.mjs --include-external  # also run the external suites
//                                           #   (requires COLIMA_HOME)

import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Suites that require something outside this checkout.
 *
 * Each entry states the requirement so the exclusion is auditable rather than
 * incidental, and each was verified EMPIRICALLY — run with `COLIMA_HOME`
 * unset / without a real `pi`, every one of these suites fails. That matters,
 * because several reach the sandbox transitively (a suite may import a graph
 * runner that imports the Colima runtime) and a static scan of its own imports
 * would miss it.
 *
 * `npm run test:colima` and `npm run test:pi` are the counterparts that run
 * them with the infrastructure present.
 */
export const EXTERNAL_SUITES = Object.freeze({
  // ── Sandbox (Colima + Docker) ────────────────────────────────────────────
  // These drive the real Colima runtime. They are NOT merely "needs Colima":
  // they also share the mutable Colima profile state, so they must run with
  // --test-concurrency=1. Several of them will fail with
  // `HOLD / COLIMA_PROFILE_BUSY` if run in parallel with each other — that is
  // the profile single-flight lock doing its job, not a flaky test.
  "test/test-c3-colima-pipeline.mjs": "Colima + Docker (real container pipeline)",
  "test/test-colima-runtime.mjs": "Colima + Docker (runtime adapter; starts an instance)",
  "test/test-colima-graph.mjs": "Colima + Docker (graph runner)",
  "test/test-subagent-graph.mjs": "Colima + Docker (subagent graph)",
  "test/test-subagent-writer-graph.mjs": "Colima + Docker (writer subagent graph)",
  "test/test-subagent-review-repair-graph.mjs": "Colima + Docker (review/repair graph)",
  "test/test-graph-closeout-integration.mjs": "Colima + Docker (end-to-end closeout)",
  "test/test-durable-subagent-resume.mjs": "Colima + Docker (crash/resume probe)",
  "test/memory/test-graph-colima-writeback.mjs": "Colima + Docker (graph writeback)",
  "test/v2/test-decomposition-manifest.mjs": "Colima + Docker (durable graph path)",
  "test/v2/test-durable-graph.mjs": "Colima + Docker (durable graph path)",
  "test/v2/test-e2-reboot-soak.mjs": "Colima + Docker (reboot/soak resume)",
  "test/v2/test-e2-reboot-soak-probes.mjs": "Colima + Docker (reboot/soak probes)",

  // ── Real agent runtime + live provider ───────────────────────────────────
  "test/pi-rpc-real-smoke.mjs": "real `pi` binary + live provider credential",
  "test/subagent/test-provider-backed-dispatch.mjs": "Colima + live provider credential",
  "test/test-pi-rpc-adapter.mjs": "real `pi` RPC surface",
  "test/test-pi-lifecycle-integration.mjs": "real `pi` RPC surface",
  "test/memory/test-writeback-authority.mjs": "Colima + Docker (real graph run for writeback authority)",
  // NOT external — but the deployment half of test-rb-ssg-vendor-integrity.mjs
  // is opt-in via AUTOLOOP_PI_EXTENSION_DIR and skips cleanly otherwise, so a
  // fresh clone gets a green suite. Listed here only for discoverability of
  // that switch:
  //   AUTOLOOP_PI_EXTENSION_DIR=<installed dir> node --test test/admission/test-rb-ssg-vendor-integrity.mjs
  "test/tool-selection/test-tool-selection-contract.mjs": "real `pi` runtime vocabulary capture",
  "test/tool-selection/test-tool-selection-production-wiring.mjs": "real `pi` runtime identity",
  "test/tool-selection/test-tool-selection-durable-resume.mjs": "real `pi` runtime identity",
});

/** Every .mjs test file under test/, recursively, excluding helpers/fixtures. */
export function discoverTestFiles(root = REPO_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "helpers") continue;
        walk(abs);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      if (entry.name === "run-suite.mjs") continue;
      if (!entry.name.startsWith("test-") && !entry.name.startsWith("test.")) continue;
      out.push(relative(root, abs));
    }
  };
  walk(join(root, "test"));
  return out.sort();
}

function main(argv) {
  const args = argv.slice(2);
  const list = args.includes("--list");
  const includeExternal = args.includes("--include-external");
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = concurrencyIndex === -1 ? "4" : args[concurrencyIndex + 1];

  const all = discoverTestFiles();
  const files = includeExternal ? all : all.filter((f) => EXTERNAL_SUITES[f] === undefined);
  const excluded = all.filter((f) => EXTERNAL_SUITES[f] !== undefined);

  if (list) {
    for (const f of files) console.log(f);
    if (excluded.length > 0) {
      console.log("\n# excluded (need external infrastructure):");
      for (const f of excluded) console.log(`#   ${f} — ${EXTERNAL_SUITES[f]}`);
    }
    return 0;
  }

  // The Colima suites need an explicit Colima runtime home. Refuse to start
  // them half-configured rather than letting each fail with a confusing
  // per-test HOLD.
  if (includeExternal && !process.env.COLIMA_HOME) {
    console.error(
      "COLIMA_HOME is not set. The external suites need an absolute Colima runtime home, e.g.\n" +
      '  COLIMA_HOME=/path/to/colima-runtime npm run test:colima\n' +
      "See docs/configuration.md (Sandbox runtime).",
    );
    return 2;
  }
  console.log(`autoloop host-only suite: ${files.length} files (${excluded.length} external suites excluded)`);
  const r = spawnSync(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...files], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (excluded.length > 0 && r.status === 0) {
    console.log(`\nNOTE: ${excluded.length} external suites were not run (see test/run-suite.mjs).`);
    console.log("Run them with: npm run test:colima   (Colima + Docker)");
  }
  return r.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv);
}
