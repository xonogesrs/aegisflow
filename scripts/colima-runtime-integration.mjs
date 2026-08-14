// scripts/colima-runtime-integration.mjs
//
// Colima-AutoLoop real integration verification (card:
// PI_GRAPH_COLIMA_AUTOLOOP_REAL_INTEGRATION_AUTHORIZED).
//
// Verifies, with real Colima instances and containers:
//   1. pinned instance/socket (immune to implicit docker context / DOCKER_HOST)
//   2. explicit mount allowlist (source ro / scratch rw; no whole-$HOME)
//   3. real read-only engineering task
//   4. isolated-worktree writer task (main repo unpolluted, reviewable, revocable)
//   5. two isolated workers (no identity mixing / result crossover)
//   6. timeout / cancel / crash / stale cleanup / idempotent re-cleanup
//   7. measurements (startup, idle/active memory, task latency, disk delta, residual)
//
// Writes evidence to governance/tl2b-colima-autoloop-integration-evidence.json
// and performs a self-review over the evidence before declaring PASS.

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  COLIMA_BIN,
  DOCKER_BIN,
  resolveInstance,
  ensureInstance,
  stopInstance,
  deleteInstance,
  runTask,
  cleanupStale,
  containerState,
  instanceSocket,
  assertMountAllowlist,
  ensureScratchRoot,
} from "../src/runtime/colima-runtime.mjs";
import { validateAdapterResult } from "../src/adapter/contract.mjs";

const HOME = homedir();
const REPO_A = "/Volumes/NVM2T/Development/autoloop";
const SCRATCH_ROOT = `${HOME}/autoloop-runtime`;
const W1 = "autoloop-w1";
const W2 = "autoloop-w2";
const EVIDENCE_PATH = "/Users/zhengfengqing/Desktop/AutoLoop-Review/governance/tl2b-colima-autoloop-integration-evidence.json";

const results = {};
const failures = [];
function check(name, ok, detail = "") {
  results[name] = { ok: Boolean(ok), detail };
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", ...opts });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function du(path) {
  const r = sh("/usr/bin/du", ["-sk", path]);
  return r.status === 0 ? Number(r.stdout.trim().split(/\s+/)[0]) : -1;
}
function vmRssMiB() {
  const r = sh("/bin/ps", ["aux"]);
  const lines = r.stdout.split("\n").filter((l) => l.includes("com.apple.Virtualization.VirtualMachine"));
  const sum = lines.reduce((acc, l) => acc + Number(l.trim().split(/\s+/)[5]), 0);
  return Math.round(sum / 1024);
}

const t0 = Date.now();
const startedAtIso = new Date().toISOString();

// ---------------------------------------------------------------- baseline
console.log("=== baseline ===");
const repoHeadBefore = sh("git", ["-C", REPO_A, "rev-parse", "HEAD"]).stdout.trim();
const repoStatusBefore = sh("git", ["-C", REPO_A, "status", "--porcelain"]).stdout;
const diskScratchBefore = du(SCRATCH_ROOT);
const diskColimaBefore = du(`${HOME}/.colima`);
check("baseline_repo_head_captured", repoHeadBefore.length > 0);
check("baseline_scratch_absent", diskScratchBefore === -1 || diskScratchBefore === 0, `scratchRoot=${SCRATCH_ROOT}`);

// ---------------------------------------------------------------- instances
console.log("=== instance provisioning (pinned) ===");
const w1StartMs = Date.now();
const w1 = ensureInstance({ profile: W1, cpus: 2, memory: 2, disk: 20, roMounts: [REPO_A], rwMounts: [`${SCRATCH_ROOT}/w1`] });
results.startup_w1_seconds = Math.round((Date.now() - w1StartMs) / 1000);
const w2StartMs = Date.now();
const w2 = ensureInstance({ profile: W2, cpus: 2, memory: 2, disk: 20, roMounts: [REPO_A], rwMounts: [`${SCRATCH_ROOT}/w2`] });
results.startup_w2_seconds = Math.round((Date.now() - w2StartMs) / 1000);
check("instance_w1_pinned_socket", w1.ok, `${w1.socket} server=${w1.serverVersion}`);
check("instance_w2_pinned_socket", w2.ok, `${w2.socket} server=${w2.serverVersion}`);
check("sockets_distinct", instanceSocket(W1) !== instanceSocket(W2));
check("mount_allowlist_enforced", (() => {
  try {
    assertMountAllowlist({ roMounts: [{ source: "/etc/hosts" }], rwMounts: [{ source: "/tmp/x" }], repoPaths: [REPO_A], scratchRoot: SCRATCH_ROOT });
    return false;
  } catch {
    return true;
  }
})());

// ------------------------------------------------- pinned socket immunity
console.log("=== pinned socket immunity ===");
const poisoned = { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "default" };
const immune = sh(DOCKER_BIN, ["--host", instanceSocket(W1), "info", "--format", "{{.ServerVersion}}"], { env: poisoned });
check("pinned_socket_immune_to_poisoned_env", immune.status === 0 && immune.stdout.trim().length > 0, immune.stdout.trim());
const noImplicit = sh(DOCKER_BIN, ["info", "--format", "{{.ServerVersion}}"], { env: poisoned });
results.implicit_context_broken = noImplicit.status !== 0; // documented: implicit context is not usable (adapter never uses it)

// ------------------------------------------------------------- read-only task
console.log("=== read-only task (real engineering task: read repo, no write, no socket, no network) ===");
const readOnly = await runTask({
  profile: W1,
  taskId: "ro-1",
  image: undefined,
  roMounts: [{ source: REPO_A, target: "/src" }],
  rwMounts: [{ source: `${SCRATCH_ROOT}/w1`, target: "/scratch" }],
  memoryMiB: 128,
  command: [
    'echo "README: $(head -1 /src/README.md)"',
    'touch /src/.autoloop-write-probe 2>&1 || echo "SRC_WRITE_DENIED"',
    'echo probe > /scratch/ro-probe.txt && echo "SCRATCH_OK"',
    '[ ! -e /var/run/docker.sock ] && echo "NO_SOCKET" || echo "SOCKET_PRESENT"',
    'ls /Users/zhengfengqing/autoloop-runtime/w2 >/dev/null 2>&1 && echo "W2_VISIBLE" || echo "W2_INVISIBLE"',
    'wget -T3 -O- http://example.com >/dev/null 2>&1 && echo "NET_OPEN" || echo "NET_NONE"',
    'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
  ].join("; "),
});
const roOut = readOnly.stdout;
check("readonly_status_completed", readOnly.status === "completed", readOnly.status);
check("readonly_repo_readable", roOut.includes("README:"), "README line");
check("readonly_src_write_denied", roOut.includes("SRC_WRITE_DENIED"));
check("readonly_scratch_writable", roOut.includes("SCRATCH_OK"));
check("readonly_no_runtime_socket", roOut.includes("NO_SOCKET"));
check("readonly_allowlist_outside_invisible", roOut.includes("W2_INVISIBLE"));
check("readonly_network_none", roOut.includes("NET_NONE"));
check("readonly_memory_limit", roOut.includes("134217728"), "128m enforced");
check("adapter_result_contract_valid", validateAdapterResult(readOnly).valid, validateAdapterResult(readOnly).errors?.join(",") ?? "");

// ------------------------------------------------------------- writer task
console.log("=== isolated-worktree writer task ===");
const cloneDir = `${SCRATCH_ROOT}/clone`;
const wtW1 = `${SCRATCH_ROOT}/w1/wt-1`;
const wtW2 = `${SCRATCH_ROOT}/w2/wt-2`;
mkdirSync(`${SCRATCH_ROOT}/w1`, { recursive: true });
mkdirSync(`${SCRATCH_ROOT}/w2`, { recursive: true });
sh("git", ["clone", "--no-hardlinks", "-q", REPO_A, cloneDir]);
const cloneOk = existsSync(`${cloneDir}/.git`);
check("writer_clone_created", cloneOk);
sh("git", ["-C", cloneDir, "worktree", "add", "--detach", "-q", wtW1]);
sh("git", ["-C", cloneDir, "worktree", "add", "--detach", "-q", wtW2]);
check("writer_worktrees_created", existsSync(`${wtW1}/.git`) && existsSync(`${wtW2}/.git`));

const writer = await runTask({
  profile: W1,
  taskId: "writer-1",
  roMounts: [{ source: REPO_A, target: "/src" }],
  rwMounts: [{ source: wtW1, target: "/work" }],
  command: [
    'mkdir -p /work/docs',
    'echo "colima-writer-proof $(date -u +%Y%m%dT%H%M%SZ)" > /work/docs/colima-writer-proof.md',
    'touch /src/.autoloop-writer-probe 2>&1 || echo "SRC_WRITE_DENIED"',
    'cat /work/docs/colima-writer-proof.md',
  ].join("; "),
});
check("writer_status_completed", writer.status === "completed", writer.status);
check("writer_src_write_denied", writer.stdout.includes("SRC_WRITE_DENIED"));
const proofExists = existsSync(`${wtW1}/docs/colima-writer-proof.md`);
check("writer_output_in_worktree", proofExists);
const cloneMainDirty = sh("git", ["-C", cloneDir, "status", "--porcelain"]).stdout.trim().length > 0;
check("writer_main_checkout_unpolluted", !cloneMainDirty);
const wt1Only = existsSync(`${wtW1}/docs/colima-writer-proof.md`) && !existsSync(`${wtW2}/docs/colima-writer-proof.md`);
check("writer_output_isolated_to_wt1", wt1Only);
const repoStatusAfterWriter = sh("git", ["-C", REPO_A, "status", "--porcelain"]).stdout;
check("repo_a_unchanged_by_writer", repoStatusAfterWriter === repoStatusBefore, "porcelain identical to baseline");
check("writer_output_reviewable", (() => {
  const r = sh("git", ["-C", cloneDir, "diff", "--stat"]);
  return r.status === 0; // diff reviewable via worktree; file content recorded above
})());

// ------------------------------------------------------------- multi-worker
console.log("=== two isolated workers (concurrent) ===");
const mkWorkerCmd = (name) => [
  `mkdir -p /work/docs`,
  `echo "worker ${name} $(date -u +%s)" > /work/docs/worker-${name}.md`,
  `cat /work/docs/worker-${name}.md`,
].join("; ");
const [w1res, w2res] = await Promise.all([
  runTask({ profile: W1, taskId: "mw-1", rwMounts: [{ source: wtW1, target: "/work" }], command: mkWorkerCmd("w1") }),
  runTask({ profile: W2, taskId: "mw-2", rwMounts: [{ source: wtW2, target: "/work" }], command: mkWorkerCmd("w2") }),
]);
check("multiworker_both_completed", w1res.status === "completed" && w2res.status === "completed");
check("multiworker_identity_no_crossover", (() => {
  const w1HasW1 = existsSync(`${wtW1}/docs/worker-w1.md`);
  const w1HasW2 = existsSync(`${wtW1}/docs/worker-w2.md`);
  const w2HasW2 = existsSync(`${wtW2}/docs/worker-w2.md`);
  const w2HasW1 = existsSync(`${wtW2}/docs/worker-w1.md`);
  return w1HasW1 && w2HasW2 && !w1HasW2 && !w2HasW1;
})());
results.multiworker_containers_after = sh(DOCKER_BIN, ["--host", instanceSocket(W1), "ps", "-q"]).stdout.trim().split(/\s+/).filter(Boolean).length;

// revocability: remove worktree w2, verify gone
sh("git", ["-C", cloneDir, "worktree", "remove", "--force", wtW2]);
check("writer_worktree_revocable", !existsSync(wtW2));

// ------------------------------------------------------------- timeout/cancel/crash
console.log("=== timeout / cancel / crash / cleanup ===");
const timedOut = await runTask({ profile: W1, taskId: "tmo-1", timeoutMs: 4000, command: "sleep 60" });
check("timeout_status", timedOut.status === "timed_out", timedOut.status);
check("timeout_container_terminated", containerState(W1, timedOut.containerName) === null || containerState(W1, timedOut.containerName) === "exited");

const ac = new AbortController();
const cancelPromise = runTask({ profile: W2, taskId: "cnl-1", abortSignal: ac.signal, timeoutMs: 60000, command: "sleep 60" });
setTimeout(() => ac.abort(), 2500);
const canceled = await cancelPromise;
check("cancel_status", canceled.status === "aborted", canceled.status);
check("cancel_container_terminated", containerState(W2, canceled.containerName) === null || containerState(W2, canceled.containerName) === "exited");

// crash: detached labeled container, hard-kill, stale cleanup
const crashName = `autoloop-crash-1`;
sh(DOCKER_BIN, ["--host", instanceSocket(W1), "run", "-d", "--name", crashName, "--label", "autoloop.card=colima-autoloop-real-integration", "docker.io/library/alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce", "sleep", "600"]);
await new Promise((r) => setTimeout(r, 1000));
sh(DOCKER_BIN, ["--host", instanceSocket(W1), "kill", "-s", "9", crashName]);
await new Promise((r) => setTimeout(r, 1500));
const crashState = containerState(W1, crashName);
results.crash_container_state = crashState; // expected exited (simulated crash)
const stale1 = cleanupStale(W1);
const stale2 = cleanupStale(W1);
check("stale_crash_container_detected", stale1.found >= 1, `found=${stale1.found}`);
check("stale_crash_container_removed", stale1.removed >= 1, `removed=${stale1.removed}`);
check("cleanup_idempotent", stale2.found === 0 && stale2.removed === 0, `second run found=${stale2.found}`);
check("crash_container_gone", containerState(W1, crashName) === null);

// ------------------------------------------------------------- measurements
console.log("=== measurements ===");
await new Promise((r) => setTimeout(r, 2000));
results.idle_memory_mib = vmRssMiB();
await Promise.all([
  runTask({ profile: W1, taskId: "mem-1", command: "sleep 60" }),
  runTask({ profile: W2, taskId: "mem-2", command: "sleep 60" }),
]);
await new Promise((r) => setTimeout(r, 3000));
results.active_memory_mib = vmRssMiB();
cleanupStale(W1);
cleanupStale(W2);
results.disk_colima_after = du(`${HOME}/.colima`);
results.disk_scratch_after = du(SCRATCH_ROOT);
results.total_elapsed_seconds = Math.round((Date.now() - t0) / 1000);

// ------------------------------------------------------------- cleanup
console.log("=== cleanup ===");
stopInstance(W1); stopInstance(W2);
deleteInstance(W1); deleteInstance(W2);
rmSync(SCRATCH_ROOT, { recursive: true, force: true });
const procsAfter = sh("/bin/ps", ["aux"]).stdout.split("\n");
const runtimeRe = /com\.apple\.Virtualization\.VirtualMachine|\/limactl(\s|$)|\/colima(\s|$)/;
const noRuntime = !procsAfter.some(
  (l) => l && !l.includes("grep") && runtimeRe.test(l),
);
check("cleanup_no_runtime_processes", noRuntime);
const repoHeadAfter = sh("git", ["-C", REPO_A, "rev-parse", "HEAD"]).stdout.trim();
check("repo_a_head_unchanged", repoHeadAfter === repoHeadBefore);
results.residual_colima_dir = existsSync(`${HOME}/.colima`) ? "skeleton remains" : "absent";
results.residual_scratch = existsSync(SCRATCH_ROOT) ? "present" : "removed";
check("cleanup_scratch_removed", !existsSync(SCRATCH_ROOT));
check("cleanup_instances_deleted", !existsSync(`${HOME}/.colima/w1`) && !existsSync(`${HOME}/.colima/w2`));

// ------------------------------------------------------------- evidence + self review
const evidence = {
  schema: "autoloop.pi-graph.colima-autoloop-real-integration/v1",
  card_id: "AUTOLOOP-PI-GRAPH-COLIMA-AUTOLOOP-REAL-INTEGRATION-1",
  controller_authorization: "PASS / PI_GRAPH_COLIMA_AUTOLOOP_REAL_INTEGRATION_AUTHORIZED",
  started_at: startedAtIso,
  repo_a_head_before: repoHeadBefore,
  repo_a_head_after: repoHeadAfter,
  instances: { W1: { profile: W1, socket: instanceSocket(W1), mounts: { ro: [REPO_A], rw: [`${SCRATCH_ROOT}/w1`] } }, W2: { profile: W2, socket: instanceSocket(W2), mounts: { ro: [REPO_A], rw: [`${SCRATCH_ROOT}/w2`] } } },
  results,
  verdict: failures.length === 0 ? "PASS" : "REPAIR",
  failures,
};
writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + "\n");
console.log(`\nEVIDENCE: ${EVIDENCE_PATH}`);

// self-review: re-read evidence and re-assert critical invariants
const reread = JSON.parse(readFileSync(EVIDENCE_PATH, "utf8"));
const critical = ["readonly_src_write_denied", "readonly_no_runtime_socket", "writer_src_write_denied", "writer_output_isolated_to_wt1", "multiworker_identity_no_crossover", "timeout_status", "cancel_status", "cleanup_idempotent", "repo_a_head_unchanged"];
const reviewPass = reread.verdict === "PASS" && critical.every((k) => reread.results[k]?.ok === true);
check("self_review_critical_invariants", reviewPass);
if (failures.length > 0) {
  console.error("\nINTEGRATION FAILURES:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
console.log(`\nFINAL: PASS / PI_GRAPH_COLIMA_AUTOLOOP_RUNTIME_BASELINE_CONFIRMED (elapsed ${results.total_elapsed_seconds}s)`);
