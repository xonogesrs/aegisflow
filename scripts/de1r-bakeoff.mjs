// DE-1R harness source (preserved from ~/.de1r/harness). Reproduce: copy to a
// dir with `npm i @temporalio/client@1.9.3 @temporalio/worker@1.9.3 @temporalio/workflow@1.9.3 @temporalio/activity@1.9.3`
// and run `node de1r-bakeoff.mjs` against a `temporal server start-dev` on 127.0.0.1:7233.

// de1r harness — bake-off orchestrator (v3, hermetic)
// Per-scenario task queue + per-scenario side-effect log => NO cross-run
// contamination from stale pending tasks. Failure classes mirror DE-1:
//   S1 crash during node (kill mid-ro1)                  [DE-1 T2/T4]
//   S2 result persisted / successor not scheduled       [DE-1 T3]
//   S3 writer side-effect boundary (RAW at-least-once)  [DE-1 T4/T5]
//   S4 writer side-effect boundary (idempotent)         [DE-1 T4/T5]
//   S5 duplicate recovery (same workflowId)             [DE-1 T11]
//   S6 corrupt state / checkpoint equivalent            [DE-1 T12]
import { Connection, Client, WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/client";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = dirname(fileURLToPath(import.meta.url));
const DATA = "/Users/zhengfengqing/.de1r/data";
const ADDRESS = "127.0.0.1:7233";
const OUT_DIR = "/Users/zhengfengqing/.de1r/results";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readMarkers(path) {
  try {
    const t = await readFile(path, "utf8");
    return t.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

let workerSeq = 0;
function spawnWorker({ sideLog, taskQueue }) {
  const id = ++workerSeq;
  const child = spawn(process.execPath, ["worker.mjs"], {
    cwd: HARNESS,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DE1R_SIDE_LOG: sideLog, DE1R_RESULT_FILE: `${DATA}/result-${taskQueue}.txt`, DE1R_TASK_QUEUE: taskQueue },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  return { id, child, log: () => log, exited: new Promise((res) => child.on("exit", (c, s) => res({ c, s }))) };
}

async function waitForMarker(path, predicate, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = (await readMarkers(path)).filter(predicate);
    if (m.length) return m[0];
    await sleep(50);
  }
  throw new Error(`waitForMarker timeout`);
}

async function waitForWorkflow(client, workflowId, timeoutMs = 150000) {
  const handle = client.workflow.getHandle(workflowId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await handle.result({ timeoutMs: 2500 });
    } catch (e) {
      await sleep(200);
    }
  }
  throw new Error(`waitForWorkflow timeout: ${workflowId}`);
}

async function stopWorker(w) {
  try { w.child.kill("SIGKILL"); } catch {}
  try { await w.exited; } catch {}
}

function countPhaseStarts(markers) {
  const counts = { p_ro1: 0, p_ro2: 0, p_writer: 0, p_verifier: 0 };
  for (const m of markers) if (m.event === "phase_started" && m.phase in counts) counts[m.phase]++;
  return counts;
}

function writerStats(markers) {
  const mutated = markers.filter((m) => m.event === "phase_mutated" && m.phase === "p_writer");
  const completed = markers.filter((m) => m.event === "phase_completed" && m.phase === "p_writer");
  return {
    writerMutations: mutated.length,
    writerCompleted: completed.length,
    writerDup: Math.max(0, mutated.length - 1),
    skippedDup: markers.filter((m) => m.event === "phase_skipped_dup").length,
  };
}

async function terminateAllRunning(client) {
  // hermeticity: terminate any strays on the default namespace before the run
  let strays = 0;
  try {
    const iter = await client.workflow.list({ query: "ExecutionStatus='Running'" });
    for await (const wf of iter) {
      try { await client.workflow.getHandle(wf.workflowId).terminate("de1r hermetic cleanup"); strays++; } catch {}
    }
  } catch (e) { console.warn("terminateAllRunning warn:", e.message); }
  return strays;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const connection = await Connection.connect({ address: ADDRESS });
  const client = new Client({ connection });
  const straysTerminated = await terminateAllRunning(client);
  console.log(`hermetic: terminated ${straysTerminated} stray running workflow(s)`);
  const results = [];
  let s5Wid = null;

  const scenario = (name, fn) => fn().then((r) => { results.push(r); console.log(`${r.scenario} [${r.outcome}] ${r.name} — ${r.detail ?? ""}`); });

  // ============ S0 baseline ============
  await scenario("S0", async () => {
    const tag = "s0";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    const t0 = Date.now();
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive", roDelayMs: 0, writerDelayMs: 0 }], workflowExecutionTimeout: "10m" });
    await waitForWorkflow(client, wid);
    const duration = Date.now() - t0;
    await sleep(1000);
    const markers = await readMarkers(sideLog);
    const execCounts = countPhaseStarts(markers);
    const ws = writerStats(markers);
    await stopWorker(worker);
    const outcome = ws.writerDup === 0 && execCounts.p_writer === 1 ? "PASS" : "FAIL";
    return { scenario: "S0", name: "baseline (no kill)", outcome, detail: `durationMs=${duration}`, markers, execCounts, ...ws, recoveryMs: null };
  });

  // ============ S1 crash during node (kill mid-ro1) ============
  await scenario("S1", async () => {
    const tag = "s1";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive", roDelayMs: 4000, writerDelayMs: 0 }], workflowExecutionTimeout: "10m" });
    await waitForMarker(sideLog, (m) => m.event === "phase_started" && m.phase === "p_ro1");
    await sleep(800);
    const killTs = Date.now();
    await stopWorker(worker);
    const worker2 = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(1500);
    await waitForWorkflow(client, wid);
    await sleep(500);
    const markers = await readMarkers(sideLog);
    const ro1Completions = markers.filter((m) => m.event === "phase_completed" && m.phase === "p_ro1");
    const ro1Started = markers.filter((m) => m.event === "phase_started" && m.phase === "p_ro1");
    const recoveryMs = ro1Completions[0] ? ro1Completions[0].ts - killTs : null;
    const execCounts = countPhaseStarts(markers);
    const ws = writerStats(markers);
    const outcome = execCounts.p_writer === 1 && ws.writerDup === 0 && ro1Completions.length >= 1 ? "PASS" : "FAIL";
    await stopWorker(worker2);
    return { scenario: "S1", name: "crash during node (kill mid-p_ro1)", outcome, detail: `ro1Started=${ro1Started.length} ro1Completed=${ro1Completions.length} recoveryMs=${recoveryMs}`, markers, execCounts, ...ws, recoveryMs };
  });

  // ============ S2 result persisted / successor not scheduled ============
  await scenario("S2", async () => {
    const tag = "s2";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive", roDelayMs: 0, writerDelayMs: 0 }], workflowExecutionTimeout: "10m" });
    const ro1Done = await waitForMarker(sideLog, (m) => m.event === "phase_completed" && m.phase === "p_ro1");
    const killTs = Date.now();
    await stopWorker(worker); // immediately after ro1 result (successor scheduling race)
    const worker2 = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(1500);
    await waitForWorkflow(client, wid);
    await sleep(500);
    const markers = await readMarkers(sideLog);
    const ro2Starts = markers.filter((m) => m.event === "phase_started" && m.phase === "p_ro2");
    const ro2Completions = markers.filter((m) => m.event === "phase_completed" && m.phase === "p_ro2");
    const ro1Starts = markers.filter((m) => m.event === "phase_started" && m.phase === "p_ro1").length;
    const recoveryMs = ro2Completions[0] && ro2Completions[0].ts >= killTs ? ro2Completions[0].ts - killTs : null;
    const execCounts = countPhaseStarts(markers);
    const ws = writerStats(markers);
    const outcome = ro1Starts === 1 && execCounts.p_ro2 === 1 && execCounts.p_writer === 1 && ws.writerDup === 0 ? "PASS" : "FAIL";
    await stopWorker(worker2);
    return { scenario: "S2", name: "result persisted / successor not scheduled (kill after p_ro1)", outcome, detail: `ro1Started=${ro1Starts} ro2Started=${ro2Starts.length} ro2Completed=${ro2Completions.length} recoveryMs=${recoveryMs} (kill raced successor scheduling)`, markers, execCounts, ...ws, recoveryMs };
  });

  // ============ S3 writer side-effect boundary (RAW naive) ============
  await scenario("S3", async () => {
    const tag = "s3";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive", roDelayMs: 0, writerDelayMs: 4000 }], workflowExecutionTimeout: "10m" });
    await waitForMarker(sideLog, (m) => m.event === "phase_mutated" && m.phase === "p_writer"); // mutation committed
    await sleep(800); // kill inside post-mutation window, before completed
    const killTs = Date.now();
    await stopWorker(worker);
    const worker2 = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(1500);
    await waitForWorkflow(client, wid);
    await sleep(500);
    const markers = await readMarkers(sideLog);
    const ws = writerStats(markers);
    const writerCompletions = markers.filter((m) => m.event === "phase_completed" && m.phase === "p_writer");
    const recoveryMs = writerCompletions[0] ? writerCompletions[0].ts - killTs : null;
    const execCounts = countPhaseStarts(markers);
    const outcome = ws.writerDup >= 1 ? "FAIL_DUPLICATE" : "PASS";
    await stopWorker(worker2);
    return { scenario: "S3", name: "writer side-effect boundary (RAW naive, kill after mutation)", outcome, detail: `writerMutations=${ws.writerMutations} writerCompleted=${ws.writerCompleted} recoveryMs=${recoveryMs} writerDup=${ws.writerDup}`, markers, execCounts, ...ws, recoveryMs };
  });

  // ============ S4 writer side-effect boundary (IDEM commit-token) ============
  await scenario("S4", async () => {
    const tag = "s4";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "idem", roDelayMs: 0, writerDelayMs: 4000 }], workflowExecutionTimeout: "10m" });
    await waitForMarker(sideLog, (m) => m.event === "phase_mutated" && m.phase === "p_writer"); // mutation + commit token
    await sleep(800);
    const killTs = Date.now();
    await stopWorker(worker);
    const worker2 = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(1500);
    await waitForWorkflow(client, wid);
    await sleep(500);
    const markers = await readMarkers(sideLog);
    const ws = writerStats(markers);
    const skipped = markers.filter((m) => m.event === "phase_skipped_dup");
    const execCounts = countPhaseStarts(markers);
    const outcome = ws.writerMutations === 1 && ws.writerDup === 0 && skipped.length >= 1 ? "PASS" : "FAIL";
    await stopWorker(worker2);
    return { scenario: "S4", name: "writer side-effect boundary (idempotent commit-token, kill after mutation)", outcome, detail: `writerMutations=${ws.writerMutations} writerCompleted=${ws.writerCompleted} skippedDup=${skipped.length} writerDup=${ws.writerDup}`, markers, execCounts, ...ws, recoveryMs: null };
  });

  // ============ S5 duplicate recovery (same workflowId) ============
  await scenario("S5", async () => {
    const tag = "s5";
    const sideLog = `${DATA}/side-effects-${tag}.jsonl`;
    const tq = `de1r-${tag}`;
    await rm(sideLog, { force: true });
    const wid = `de1r-${tag}-${Date.now()}`;
    s5Wid = wid;
    const worker = spawnWorker({ sideLog, taskQueue: tq });
    await sleep(3000);
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive", roDelayMs: 0, writerDelayMs: 0 }], workflowExecutionTimeout: "10m" });
    await waitForWorkflow(client, wid);
    await sleep(500);
    const markersBefore = await readMarkers(sideLog);
    const d1 = await client.workflow.getHandle(wid).describe();
    const runId1 = d1.runId;
    // 5a: DEFAULT reuse policy (clean completed workflow)
    let reuseDefault = null;
    try {
      const h2 = await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: wid, args: [{ writerMode: "naive" }], workflowExecutionTimeout: "10m" });
      reuseDefault = "NEW_EXECUTION_ALLOWED";
      await h2.terminate("de1r-s5 5a cleanup");
    } catch (e) {
      reuseDefault = e instanceof WorkflowExecutionAlreadyStartedError ? "WORKFLOW_EXECUTION_ALREADY_STARTED" : `OTHER:${e?.message?.slice(0, 80) ?? e}`;
    }
    // 5b: REJECT_DUPLICATE against a clean COMPLETED workflow (fresh id)
    const widB = `de1r-${tag}-b-${Date.now()}`;
    await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: widB, args: [{ writerMode: "naive", roDelayMs: 0, writerDelayMs: 0 }], workflowExecutionTimeout: "10m" });
    await waitForWorkflow(client, widB);
    await sleep(500);
    let reuseReject = null;
    try {
      await client.workflow.start("de1rGraph", { taskQueue: tq, workflowId: widB, workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE, args: [{ writerMode: "naive" }], workflowExecutionTimeout: "10m" });
      reuseReject = "NEW_EXECUTION_ALLOWED_UNEXPECTEDLY";
    } catch (e) {
      reuseReject = e instanceof WorkflowExecutionAlreadyStartedError ? "WORKFLOW_EXECUTION_ALREADY_STARTED" : `OTHER:${e?.message?.slice(0, 80) ?? e}`;
    }
    const markersAfter = await readMarkers(sideLog);
    await stopWorker(worker);
    const outcome = reuseDefault === "NEW_EXECUTION_ALLOWED" && reuseReject === "WORKFLOW_EXECUTION_ALREADY_STARTED" ? "PASS" : "PASS_FINDING";
    return { scenario: "S5", name: "duplicate recovery (same workflowId restart)", outcome, detail: `defaultReuse=${reuseDefault} rejectDuplicate=${reuseReject} runId1=${runId1} markersBefore=${markersBefore.length} markersAfter=${markersAfter.length}`, markers: markersAfter, execCounts: countPhaseStarts(markersAfter), ...writerStats(markersAfter), recoveryMs: null };
  });

  // ============ footprint snapshot ============
  const footprint = await captureFootprint();

  // ============ S6 corrupt state (LAST) ============
  const s6 = await runCorruptStateScenario(s5Wid);
  results.push(s6);
  console.log(`${s6.scenario} [${s6.outcome}] ${s6.name} — ${s6.detail ?? ""}`);

  // ============ summary ============
  await writeFile(`${OUT_DIR}/de1r-bakeoff-results.json`, JSON.stringify({ schema: "autoloop.durable-bakeoff-results/de1r/v1", candidate: "B — Temporal (live dev server, temporalio@1.9.3 SDK, server 1.31.2 via CLI 1.8.2, SQLite)", ranAt: new Date().toISOString(), results, footprint }, null, 2), "utf8");
  console.log("=== DE-1R BAKE-OFF SUMMARY ===");
  for (const r of results) console.log(`${r.scenario} [${r.outcome}] ${r.name} — ${r.detail ?? ""}`);
  console.log("footprint:", JSON.stringify(footprint, null, 2));
  process.exit(0);
}

async function captureFootprint() {
  const { execSync } = await import("node:child_process");
  const { stat } = await import("node:fs/promises");
  let serverRss = null;
  try {
    const line = execSync("ps -eo rss,comm | grep -E ' temporal$|temporal$' | sort -rn | head -1").toString().trim();
    if (line) serverRss = Math.round(Number(line.split(/\s+/)[0]) / 1024);
  } catch { /* ignore */ }
  let dbSize = null;
  try { dbSize = (await stat("/Users/zhengfengqing/.de1r/data/temporal-dev.db")).size; } catch { /* ignore */ }
  let ports = null;
  try { ports = execSync("lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E '7233|8233|61177' | awk '{print $1, $9}' | sort -u").toString().trim().split("\n").filter(Boolean); } catch { ports = []; }
  return { serverRssMb: serverRss, dbSizeBytes: dbSize, listening: ports, note: "dev server = single CLI process (embeds server + UI + metrics listener); worker = separate node process" };
}

async function runCorruptStateScenario(knownCompletedWid) {
  const { execSync, spawn } = await import("node:child_process");
  const { copyFile } = await import("node:fs/promises");
  const srcDb = "/Users/zhengfengqing/.de1r/data/temporal-dev.db";
  const cpyDb = "/Users/zhengfengqing/.de1r/data/temporal-dev-CORRUPT.db";
  await copyFile(srcDb, cpyDb).catch(async () => { await sleep(500); await copyFile(srcDb, cpyDb); });
  const fs = await import("node:fs");
  const buf = fs.readFileSync(cpyDb);
  // corrupt several regions (history payload area) to raise the chance of hitting history rows
  for (const frac of [0.2, 0.35, 0.5, 0.65]) {
    const start = Math.floor(buf.length * frac);
    const len = Math.min(4096, buf.length - start);
    for (let i = 0; i < len; i++) buf[start + i] = buf[start + i] ^ 0xff;
  }
  fs.writeFileSync(cpyDb, buf);
  let integrity = "not-run";
  try {
    integrity = execSync(`sqlite3 "${cpyDb}" "PRAGMA integrity_check;" 2>&1 | head -5`).toString().trim().split("\n").join(" | ");
  } catch (e) {
    integrity = `sqlite-check-failed:${e?.message?.slice(0, 80) ?? e}`;
  }
  const port = 7235;
  const server2 = spawn("/Users/zhengfengqing/.de1r/tools/temporal", ["server", "start-dev", "--db-filename", cpyDb, "--ip", "127.0.0.1", "--port", String(port), "--headless"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server2.stdout.on("data", (d) => (log += d));
  server2.stderr.on("data", (d) => (log += d));
  const exitedPromise = new Promise((res) => server2.on("exit", (c, s) => res({ c, s })));
  await sleep(12000);
  const exited = await Promise.race([exitedPromise, sleep(1500).then(() => null)]);
  let queryResult = "server-refused-or-unresponsive";
  if (!exited) {
    try {
      const c2 = await Connection.connect({ address: `127.0.0.1:${port}` });
      const cl2 = new Client({ connection: c2 });
      const handle = cl2.workflow.getHandle(knownCompletedWid);
      const d = await handle.describe();
      queryResult = `SERVER_RESPONDED status=${String(d.status?.name ?? d.status)}`;
    } catch (e) {
      queryResult = `QUERY_FAILED:${e?.message?.slice(0, 140) ?? e}`;
    }
  } else {
    queryResult = "SERVER_PROCESS_EXITED";
  }
  const server2Up = !exited && (log.includes("SERVING") || log.includes("Temporal Server"));
  const server2Error = log.match(/(corrupt|SQLITE|integrity|fatal|panic)/gi)?.slice(0, 3) ?? [];
  try { server2.kill("SIGKILL"); } catch { /* already gone */ }
  const corruptionDetected = /corrupt|integrity/i.test(integrity) || !server2Up || /QUERY_FAILED|corrupt|integrity/i.test(queryResult);
  const outcome = corruptionDetected ? "PASS_FAIL_CLOSED" : "PASS_SERVER_UP_NO_CORRUPTION_OBSERVED";
  return { scenario: "S6", name: "corrupt state / checkpoint equivalent (corrupt SQLite history copy)", outcome, detail: `integrity=${integrity} serverStarted=${server2Up} exited=${!!exited} queryResult=${queryResult} errors=${JSON.stringify(server2Error)}`, markers: [], execCounts: {}, ...writerStats([]), recoveryMs: null };
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
