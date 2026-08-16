// DE-1R harness source (preserved from ~/.de1r/harness). Reproduce: copy to a
// dir with `npm i @temporalio/client@1.9.3 @temporalio/worker@1.9.3 @temporalio/workflow@1.9.3 @temporalio/activity@1.9.3`
// and run `node de1r-bakeoff.mjs` against a `temporal server start-dev` on 127.0.0.1:7233.

// de1r harness — activities (IO + side-effects allowed; NOT deterministic)
// Mirrors DE-1's 4-phase DAG: ro1 -> ro2 -> writer -> verifier
// Side-effect log: append-only JSONL marker file. Writer also writes a result artifact.
import { Context } from "@temporalio/activity";

const LOAD_TOKEN = Math.random().toString(36).slice(2,10);
const PID = process.pid;
let SIDE_LOG = "/Users/zhengfengqing/.de1r/data/side-effects.jsonl";
let RESULT_FILE = "/Users/zhengfengqing/.de1r/data/result.txt";

export function configurePaths({ sideLog, resultFile }) {
  if (sideLog) SIDE_LOG = sideLog;
  if (resultFile) RESULT_FILE = resultFile;
}

async function appendMarker(marker) {
  const line = JSON.stringify({ ...marker, ts: Date.now(), pid: PID, token: LOAD_TOKEN }) + "\n";
  const { appendFile } = await import("node:fs/promises");
  await appendFile(SIDE_LOG, line, "utf8");
  return line;
}

// committed proof = a phase_completed marker carrying this dedupeKey
async function committedExists(dedupeKey) {
  const { readFile } = await import("node:fs/promises");
  try {
    const txt = await readFile(SIDE_LOG, "utf8");
    return txt.split("\n").some((l) => l.includes(`"event":"phase_completed"`) && l.includes(`"dedupeKey":"${dedupeKey}"`));
  } catch {
    return false;
  }
}

async function writeArtifact(content) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(RESULT_FILE, content, "utf8");
}

// heartbeat loop while delaying, to open a kill window
async function delayWithHeartbeat(ms) {
  const ctx = Context.current();
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    ctx.heartbeat(Date.now());
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * RAW at-least-once writer + read-only phases.
 * Writer: started -> MUTATE (artifact + phase_mutated marker) -> delay(kill window) -> completed
 * A kill after mutation, before completed => retry re-runs from scratch => SECOND mutation (duplicate).
 */
export async function phaseNaive({ phase, delayMs = 0, mutateFirst = false }) {
  const info = Context.current().info;
  const isWriter = phase === "p_writer";
  await appendMarker({ event: "phase_started", phase, activityId: info.activityId, attempt: info.attempt });
  if (isWriter && mutateFirst) {
    await writeArtifact(`writer-result:${info.activityId}:attempt:${info.attempt}\n`);
    await appendMarker({ event: "phase_mutated", phase, activityId: info.activityId, attempt: info.attempt });
  }
  if (delayMs > 0) await delayWithHeartbeat(delayMs);
  if (isWriter && !mutateFirst) {
    await writeArtifact(`writer-result:${info.activityId}:attempt:${info.attempt}\n`);
    await appendMarker({ event: "phase_mutated", phase, activityId: info.activityId, attempt: info.attempt });
  }
  await appendMarker({ event: "phase_completed", phase, activityId: info.activityId, attempt: info.attempt });
  return { phase, ok: true, attempt: info.attempt };
}

/**
 * Idempotent writer: commit-token pattern.
 * On start: if a COMMITTED (completed) marker with our dedupeKey exists => skip mutation.
 * Else: started -> MUTATE + write completed(committed, dedupeKey) -> delay(kill window) -> completed again.
 * A kill after mutation => retry sees committed marker => skips mutation => exactly-once mutation.
 * NOTE: for the idempotent variant the mutation must happen BEFORE the kill window so the
 * commit token exists before any crash; the tail delay then proves retry-safe behavior.
 */
export async function phaseIdem({ phase, delayMs = 0 }) {
  const info = Context.current().info;
  const dedupeKey = `${info.activityId}`;
  const isWriter = phase === "p_writer";
  await appendMarker({ event: "phase_started", phase, activityId: info.activityId, attempt: info.attempt, dedupeKey });
  if (await committedExists(dedupeKey)) {
    if (delayMs > 0) await delayWithHeartbeat(delayMs);
    await appendMarker({ event: "phase_skipped_dup", phase, activityId: info.activityId, attempt: info.attempt, dedupeKey });
    return { phase, ok: true, dedupe: "duplicate-skipped", attempt: info.attempt };
  }
  if (isWriter) {
    await writeArtifact(`writer-result:${dedupeKey}:attempt:${info.attempt}\n`);
    await appendMarker({ event: "phase_mutated", phase, activityId: info.activityId, attempt: info.attempt, dedupeKey });
  }
  // COMMIT TOKEN — written atomically with the mutation, BEFORE the kill window.
  await appendMarker({ event: "phase_completed", phase, activityId: info.activityId, attempt: info.attempt, dedupeKey });
  if (delayMs > 0) await delayWithHeartbeat(delayMs); // tail proving retry-safety
  return { phase, ok: true, attempt: info.attempt };
}
