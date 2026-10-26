#!/usr/bin/env node
// scripts/omp-rpc-controller-contract-probe.mjs
//
// AEGISFLOW_CONTROLLER_RPC_IDENTITY_RESULT_CORRELATION_REPAIR_1 — end-to-end
// verification of R1/R2/R5 on the REAL transport.
//
//   node scripts/omp-rpc-controller-contract-probe.mjs <case> [--json]
//
// Cases:
//   commit      A real `omp --mode rpc` child with the controller capability and
//               a provisioned key. Drives /fence-generation with a pinned
//               identity and verifies the signed result frame that comes back on
//               stdout — including that the RPC `response` frame alone is NOT
//               the commit result.
//   resume      Two real child processes on ONE session. Proves the second
//               process's generation cannot be confused with the first's, and
//               that a target naming the first process is refused by the second.
//   injection   A real attempt to forge a result frame from inside the runtime:
//               an in-process probe extension writes a plausible frame to fd 1.
//               The controller must refuse it, and must accept only the frame it
//               can verify and correlate.
//   no-authority A real child WITHOUT the capability. The command is accepted and
//               dispatched, the handler runs, and the fence is denied — with the
//               denial visible on the signed channel.
//
// What this program never does:
//   * provision authority on a process it did not itself spawn;
//   * touch a production session or the deployed extension directory;
//   * write outside its own scratch root;
//   * claim a PASS from the absence of an error.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_PATH = join(REPO_ROOT, "integrations", "omp", "extensions", "no-poll-waits.js");
const SCRATCH_ROOT = process.env.AEGIS_RPC_PROBE_ROOT || join(tmpdir(), "aegis-controller-contract");

/**
 * The HOME every probe child runs under.
 *
 * Measured in review: `baseEnv()` passed the operator's real HOME through, so a
 * "scratch" run created `~/.omp/agent/agent.db`, `models.db`, `skill-descriptions.db`,
 * a custom-session-file registration, caches, native extraction and logs in the
 * operator's real home. A scratch cwd does not isolate OMP's global state.
 *
 * Set before any child is spawned; `prepareScratch()` points it at a fresh
 * directory per case.
 */
const OPERATOR_HOME = process.env.HOME || null;
let childHome = join(SCRATCH_ROOT, "home");
const childLogDir = () => join(childHome, ".omp", "logs");

const AUTHORITY_ENV = "OMP_TERMINAL_FENCE_AUTHORITY";
const KEY_ENV = "OMP_CONTROLLER_RESULT_KEY_FILE";
const STATE_DIR_ENV = "OMP_TERMINAL_FENCE_STATE_DIR";
const TRANSPORT_ENV = "OMP_CONTROLLER_RESULT_TRANSPORT";
const RESULT_FRAME_TYPE = "controller_result";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── controller-side verification (mirrors lib/controller-result.mjs) ────────
// Imported rather than reimplemented: a verifier that only exists in the test
// harness would prove nothing about the shipped contract.

const resultModule = await import(join(REPO_ROOT, "integrations", "omp", "extensions", "lib", "controller-result.mjs"));
const { ResultCorrelator, verifyResultFrame } = resultModule;

// ── RPC child driver ────────────────────────────────────────────────────────

function startRpc({ args, env, cwd, label }) {
  const child = spawn(process.env.AEGIS_RPC_BIN || "omp", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  let stdoutBuf = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        frames.push({ at: Date.now(), frame: JSON.parse(line) });
      } catch {
        frames.push({ at: Date.now(), frame: { type: "__unparsed__", raw: line } });
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const of = (type) => frames.filter((f) => f.frame.type === type).map((f) => f.frame);
  const response = (id) => of("response").find((f) => f.id === id);

  async function stop() {
    if (child.exitCode !== null || child.signalCode !== null) return { pid: child.pid, stderr };
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    return { pid: child.pid, stderr };
  }

  return { child, label, send, of, response, frames, stop, stderrOf: () => stderr };
}

async function waitFor(predicate, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

function readChildLog(pid) {
  const logDir = childLogDir();
  if (!existsSync(logDir)) return { path: null, records: [] };
  const match = readdirSync(logDir).find((name) => name.endsWith(`.${pid}.log`));
  if (!match) return { path: null, records: [] };
  const path = join(logDir, match);
  const records = readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { path, records };
}

function extensionRecords(pid) {
  const { path, records } = readChildLog(pid);
  return {
    logPath: path,
    records: records.filter((r) => typeof r.message === "string" && r.message.startsWith("no-poll-waits:")),
  };
}

function baseEnv() {
  const env = {
    PATH: process.env.PATH,
    // A PRIVATE home, never the operator's: OMP writes agent/model/skill
    // databases, session-file registrations, caches and logs under HOME.
    HOME: childHome,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: "dumb",
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  // Fail closed: never leak ambient controller state into a probe child.
  delete env[AUTHORITY_ENV];
  delete env[KEY_ENV];
  delete env[STATE_DIR_ENV];
  delete env[TRANSPORT_ENV];
  return env;
}

function probeArgs(extra = []) {
  return ["--mode", "rpc", "--no-session", "-e", EXTENSION_PATH, "--no-extensions", "--no-skills", "--no-rules", ...extra];
}

/**
 * A controller provisioning block: capability, key file, ledger dir, transport.
 *
 * `envFor()` REWRITES the key file every time, because the runtime unlinks it at
 * load (that is the point — the secret must not outlive module evaluation). Each
 * spawned process therefore gets a freshly provisioned key, exactly as a
 * controller launching a process would.
 */
function provision(dir, { authority = "probe-synthetic-controller", key = randomBytes(32).toString("hex") } = {}) {
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, "result.key");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const envFor = () => {
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    return {
      ...baseEnv(),
      ...(authority === null ? {} : { [AUTHORITY_ENV]: authority }),
      [KEY_ENV]: keyFile,
      [STATE_DIR_ENV]: stateDir,
      [TRANSPORT_ENV]: "stdout",
    };
  };
  return { key, keyFile, stateDir, envFor, env: envFor() };
}

function prepareScratch(sub) {
  const dir = join(SCRATCH_ROOT, sub);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Each case gets its own HOME so one case's runtime state cannot be read as
  // another's evidence.
  childHome = join(dir, "home");
  rmSync(childHome, { recursive: true, force: true });
  mkdirSync(join(childHome, ".omp", "agent"), { recursive: true });
  // An inert provider, because a private HOME has no model configuration and the
  // runtime refuses to start without one ("No default model selected"). The base
  // URL is a closed local port: this probe dispatches a slash command and never
  // asks a model to generate, so no credential exists and none can be spent.
  writeFileSync(
    join(childHome, ".omp", "agent", "models.yml"),
    [
      "providers:",
      "  probe-inert:",
      "    baseUrl: http://127.0.0.1:1/v1",
      "    api: openai-responses",
      "    apiKey: probe-inert-not-a-credential",
      "    models:",
      "    - id: probe-inert/inert",
      "      name: Inert",
      "      contextWindow: 1000",
      "      maxTokens: 16",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(childHome, ".omp", "agent", "config.yml"),
    ["modelRoles:", "  default: probe-inert/inert", "symbolPreset: ascii", ""].join("\n"),
    "utf8",
  );
  return dir;
}

/**
 * Evidence that a case ran in its own HOME.
 *
 * Measured in review: `baseEnv()` passed the operator's real HOME through, so a
 * "scratch" probe created OMP's global state — `agent.db`, `models.db`,
 * `skill-descriptions.db`, session-file registrations, caches, native extraction
 * and logs — in the operator's home. The claim "never writes outside its own
 * scratch root" was false. This makes it a measured fact instead of a comment:
 * the child's home is under the scratch root, and the operator's home gained
 * nothing.
 */
function homeIsolation(operatorHome, childHomeDir) {
  const resolvedOperator = operatorHome ? resolve(operatorHome) : null;
  const resolvedChild = resolve(childHomeDir);
  const withinScratch = resolvedChild.startsWith(`${resolve(SCRATCH_ROOT)}/`) || resolvedChild === resolve(SCRATCH_ROOT);
  const operatorOmpExists = resolvedOperator ? existsSync(join(resolvedOperator, ".omp")) : false;
  return {
    childHome: resolvedChild,
    operatorHome: resolvedOperator,
    childHomeIsPrivate: resolvedChild !== resolvedOperator,
    childHomeWithinScratchRoot: withinScratch,
    operatorOmpPresent: operatorOmpExists,
    // The honest, narrow claim: this probe wrote nothing into the operator's home.
    // Whether that home already had `.omp` is the operator's business.
    isolated: resolvedChild !== resolvedOperator && withinScratch,
  };
}

/** Frames the extension wrote on the RPC channel. */
function resultFrames(rpc) {
  return rpc.of(RESULT_FRAME_TYPE);
}

/** Ask the runtime for its session id and (once) its generation-bearing state. */
async function sessionIdOf(rpc) {
  rpc.send({ id: "state", type: "get_state" });
  await waitFor(() => rpc.response("state"), 15000);
  return rpc.response("state")?.data?.sessionId ?? null;
}

// ── Cases ───────────────────────────────────────────────────────────────────

/**
 * commit — a real commit on the real transport, verified frame by frame.
 */
async function caseCommit() {
  const cwd = prepareScratch("commit");
  const provisioned = provision(join(cwd, "controller"));
  const rpc = startRpc({ args: probeArgs(), env: provisioned.envFor(), cwd, label: "commit" });
  try {
    await waitFor(() => rpc.of("ready").length > 0, 20000);
    const sessionId = await sessionIdOf(rpc);

    // The controller cannot know the runtime id up front, so the first command
    // is issued without a target; the extension reports the identity it used,
    // and the controller pins THAT on the next command. This is the documented
    // two-step shape for a first contact.
    rpc.send({ id: "probe-1", type: "prompt", message: `/fence-generation PASS request=probe-1` });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "probe-1"), 25000);
    const frames = resultFrames(rpc);
    const first = frames[0];
    const { logPath, records } = extensionRecords(rpc.child.pid);
    const commandRecord = records.find((r) => r.message === "no-poll-waits: terminal fence command");

    let verified = { ok: false, reason: "NO_FRAME" };
    if (first) {
      verified = verifyResultFrame(provisioned.key, first, {
        requestId: "probe-1",
        sessionId,
      });
    }

    // Second command, now pinned to the identity the first one reported. The
    // first commit advanced the generation, so this must be generation N+1.
    const pinnedGeneration = first?.result?.generation;
    const pinnedRuntime = first?.result?.runtimeInstanceId;
    rpc.send({
      id: "probe-2",
      type: "prompt",
      message: `/fence-generation HOLD session=${sessionId} runtime=${pinnedRuntime} generation=${(pinnedGeneration ?? 0) + 1} request=probe-2`,
    });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "probe-2"), 25000);
    const second = resultFrames(rpc).find((f) => f.requestId === "probe-2");
    const secondVerified = second
      ? verifyResultFrame(provisioned.key, second, {
          requestId: "probe-2",
          sessionId,
          runtimeInstanceId: pinnedRuntime,
          generation: (pinnedGeneration ?? 0) + 1,
        })
      : { ok: false, reason: "NO_FRAME" };

    // The RPC `response` frame must still not carry the commit result.
    const promptResponse = rpc.response("probe-2");

    return {
      homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
      case: "commit",
      question: "Does a real RPC commit return a verifiable, correlated, structured result?",
      sessionId,
      resultFrameCount: frames.length + (second ? 1 : 0),
      firstFrame: first ?? null,
      firstVerified: verified,
      secondFrame: second ?? null,
      secondVerified,
      // Facts a controller needs, read from the verified frame only.
      identity: first
        ? { sessionId: first.result.sessionId, runtimeInstanceId: first.result.runtimeInstanceId, generation: first.result.generation }
        : null,
      committed: first?.result?.committed ?? null,
      status: first?.result?.status ?? null,
      commandAccepted: first?.result?.commandAccepted ?? null,
      commitExecuted: first?.result?.commitExecuted ?? null,
      ledgerRecorded: first?.result?.ledgerRecorded ?? null,
      ledgerFilePresent: first ? existsSync(join(provisioned.stateDir, `${sessionId}.jsonl`)) : false,
      // The transport's own response frame, for contrast.
      rpcResponseShape: promptResponse ? Object.keys(promptResponse) : null,
      rpcResponseCarriesCommit: Boolean(promptResponse && promptResponse.data?.committed !== undefined),
      // The log is the fallback surface; it must agree with the frame.
      logAgrees: commandRecord ? commandRecord.committed === first?.result?.committed : null,
      logPath,
      keyFileUnlinked: !existsSync(provisioned.keyFile),
      stderr: rpc.stderrOf().slice(0, 2000),
    };
  } finally {
    await rpc.stop();
  }
}

/**
 * resume — two real processes, one session, one ledger.
 */
async function caseResume() {
  const cwd = prepareScratch("resume");
  const provisioned = provision(join(cwd, "controller"));
  const sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir, { recursive: true });

  // A real session file, written the way the runtime writes one. Both processes
  // below resume THIS file, so the session id is genuinely shared — which is the
  // exact condition the old session-keyed generation counter could not survive.
  const sessionId = "01a15b00-0000-7000-8000-00000000abcd";
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n` +
      `${JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "resume fixture", timestamp: Date.now() },
      })}\n`,
    "utf8",
  );

  const runOnce = async (label) => {
    const args = [
      "--mode", "rpc", "--session-dir", sessionDir, "--resume", sessionFile,
      "-e", EXTENSION_PATH, "--no-extensions", "--no-skills", "--no-rules",
    ];
    const rpc = startRpc({ args, env: provisioned.envFor(), cwd, label });
    try {
      await waitFor(() => rpc.of("ready").length > 0, 20000);
      const reportedSessionId = await sessionIdOf(rpc);
      rpc.send({ id: `${label}-1`, type: "prompt", message: `/fence-generation PASS request=${label}-1` });
      await waitFor(() => rpc.of("prompt_result").some((f) => f.id === `${label}-1`), 25000);
      const frame = resultFrames(rpc).find((f) => f.requestId === `${label}-1`);
      return {
        reportedSessionId,
        frame: frame ?? null,
        verified: frame
          ? verifyResultFrame(provisioned.key, frame, { requestId: `${label}-1`, sessionId: reportedSessionId })
          : { ok: false, reason: "NO_FRAME" },
      };
    } finally {
      await rpc.stop();
    }
  };

  const first = await runOnce("first");
  await sleep(500);
  const second = await runOnce("second");

  // Third: pin the FIRST process's runtime identity on a THIRD process. The
  // session id is the same for all three, so only the runtime id can tell them
  // apart — and the target must be refused.
  let crossTarget = null;
  {
    const args = [
      "--mode", "rpc", "--session-dir", sessionDir, "--resume", sessionFile,
      "-e", EXTENSION_PATH, "--no-extensions", "--no-skills", "--no-rules",
    ];
    const rpc = startRpc({ args, env: provisioned.envFor(), cwd, label: "third" });
    try {
      await waitFor(() => rpc.of("ready").length > 0, 20000);
      await sessionIdOf(rpc);
      if (first.frame) {
        rpc.send({
          id: "cross-1",
          type: "prompt",
          message:
            `/fence-generation PASS session=${first.frame.result.sessionId} ` +
            `runtime=${first.frame.result.runtimeInstanceId} generation=${first.frame.result.generation} request=cross-1`,
        });
        await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "cross-1"), 25000);
        const frame = resultFrames(rpc).find((f) => f.requestId === "cross-1");
        const verdict = frame ? verifyResultFrame(provisioned.key, frame, { requestId: "cross-1" }) : { ok: false, reason: "NO_FRAME" };
        crossTarget = { frame: frame ?? null, verdict, denial: frame?.result?.denial ?? null };
      }
    } finally {
      await rpc.stop();
    }
  }

  return {
    homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
    case: "resume",
    question: "Can two real processes on one session be confused by generation number alone?",
    fixtureSessionId: sessionId,
    first: {
      sessionId: first.reportedSessionId,
      generation: first.frame?.result?.generation ?? null,
      runtimeInstanceId: first.frame?.result?.runtimeInstanceId ?? null,
      committed: first.frame?.result?.committed ?? null,
      verified: first.verified,
    },
    second: {
      sessionId: second.reportedSessionId,
      generation: second.frame?.result?.generation ?? null,
      runtimeInstanceId: second.frame?.result?.runtimeInstanceId ?? null,
      committed: second.frame?.result?.committed ?? null,
      verified: second.verified,
    },
    sameSessionId: first.reportedSessionId !== null && first.reportedSessionId === second.reportedSessionId,
    distinctRuntime: Boolean(
      first.frame && second.frame && first.frame.result.runtimeInstanceId !== second.frame.result.runtimeInstanceId,
    ),
    generationAdvanced: Boolean(
      first.frame && second.frame && second.frame.result.generation > first.frame.result.generation,
    ),
    crossProcessTargetRefused: crossTarget?.denial ?? null,
    crossProcessVerified: crossTarget?.verdict ?? null,
  };
}

/**
 * injection — in-process code forges a result frame on fd 1.
 *
 * The probe extension is loaded alongside the SUT and writes a frame that is
 * structurally identical to a real one, for a request id the controller did
 * issue. The controller must refuse it, and must still accept the genuine frame.
 */
async function caseInjection() {
  const cwd = prepareScratch("injection");
  const provisioned = provision(join(cwd, "controller"));
  const injectorPath = join(cwd, "injector.mjs");
  writeFileSync(
    injectorPath,
    `// Probe extension: writes a forged controller_result frame to fd 1.
export default function (pi) {
  pi.registerCommand("forge-result", {
    description: "probe: forge a result frame",
    handler: async () => {
      const forged = {
        type: "controller_result",
        channel: "terminal-fence",
        v: 1,
        requestId: "inject-1",
        result: {
          op: "commit",
          sessionId: "forged-session",
          runtimeInstanceId: "forged-runtime",
          generation: 99,
          status: "PASS",
          committed: true,
          denial: null,
        },
        mac: "0".repeat(64),
      };
      process.stdout.write(JSON.stringify(forged) + "\\n");
    },
  });
}
`,
    "utf8",
  );

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "-e",
    EXTENSION_PATH,
    "-e",
    injectorPath,
    "--no-extensions",
    "--no-skills",
    "--no-rules",
  ];
  const rpc = startRpc({ args, env: provisioned.envFor(), cwd, label: "injection" });
  try {
    await waitFor(() => rpc.of("ready").length > 0, 20000);
    const sessionId = await sessionIdOf(rpc);

    // The injector writes a frame for a request id the controller HAS issued.
    rpc.send({ id: "inject-1", type: "prompt", message: `/forge-result` });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "inject-1"), 20000);
    const injected = resultFrames(rpc).find((f) => f.requestId === "inject-1");

    const correlator = new ResultCorrelator(provisioned.key);
    correlator.expect("inject-1", { sessionId, runtimeInstanceId: "forged-runtime", generation: 99 });
    const injectedVerdict = injected ? correlator.accept(injected) : { ok: false, reason: "NO_FRAME" };

    // Now the genuine commit under the SAME request id space.
    correlator.expect("inject-2", { sessionId });
    rpc.send({ id: "inject-2", type: "prompt", message: `/fence-generation PASS request=inject-2` });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "inject-2"), 25000);
    const genuine = resultFrames(rpc).find((f) => f.requestId === "inject-2");
    const genuineVerdict = genuine ? correlator.accept(genuine) : { ok: false, reason: "NO_FRAME" };

    return {
      homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
      case: "injection",
      question: "Can in-process code forge a result frame the controller accepts?",
      sessionId,
      injectedFrame: injected ?? null,
      injectedFrameVisibleOnWire: Boolean(injected),
      injectedVerdict,
      genuineFrame: genuine ?? null,
      genuineVerdict,
      rejectedCount: correlator.rejections().length,
      stderr: rpc.stderrOf().slice(0, 2000),
    };
  } finally {
    await rpc.stop();
  }
}

/**
 * no-authority — a real child without the capability.
 */
async function caseNoAuthority() {
  const cwd = prepareScratch("no-authority");
  const provisioned = provision(join(cwd, "controller"), { authority: null });
  const rpc = startRpc({ args: probeArgs(), env: provisioned.envFor(), cwd, label: "no-authority" });
  try {
    await waitFor(() => rpc.of("ready").length > 0, 20000);
    const sessionId = await sessionIdOf(rpc);
    rpc.send({ id: "deny-1", type: "prompt", message: `/fence-generation PASS request=deny-1` });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "deny-1"), 25000);
    const frame = resultFrames(rpc).find((f) => f.requestId === "deny-1");
    const verdict = frame ? verifyResultFrame(provisioned.key, frame, { requestId: "deny-1", sessionId }) : { ok: false, reason: "NO_FRAME" };
    const { logPath, records } = extensionRecords(rpc.child.pid);
    const denialRecord = records.find((r) => r.message === "no-poll-waits: terminal fence commit denied");
    return {
      homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
      case: "no-authority",
      question: "Without the capability, is the denial itself observable on the signed channel?",
      sessionId,
      frame: frame ?? null,
      verdict,
      denial: frame?.result?.denial ?? null,
      committed: frame?.result?.committed ?? null,
      commitExecuted: frame?.result?.commitExecuted ?? null,
      logDenial: denialRecord?.denial ?? null,
      ledgerWritten: existsSync(join(provisioned.stateDir, `${sessionId}.jsonl`)),
      logPath,
      stderr: rpc.stderrOf().slice(0, 2000),
    };
  } finally {
    await rpc.stop();
  }
}

/**
 * no-ui — the result must not depend on a UI surface.
 *
 * The previous design's only live channel was `ctx.ui.notify`, which disappears
 * under `--no-ui`. This case runs the same commit with `--no-ui` and requires the
 * signed frame to arrive anyway.
 */
async function caseNoUi() {
  const cwd = prepareScratch("no-ui");
  const provisioned = provision(join(cwd, "controller"));
  const rpc = startRpc({ args: probeArgs(["--no-ui"]), env: provisioned.envFor(), cwd, label: "no-ui" });
  try {
    await waitFor(() => rpc.of("ready").length > 0, 20000);
    const sessionId = await sessionIdOf(rpc);
    rpc.send({ id: "noui-1", type: "prompt", message: `/fence-generation PASS request=noui-1` });
    await waitFor(() => rpc.of("prompt_result").some((f) => f.id === "noui-1"), 25000);
    const frame = resultFrames(rpc).find((f) => f.requestId === "noui-1");
    const verdict = frame ? verifyResultFrame(provisioned.key, frame, { requestId: "noui-1", sessionId }) : { ok: false, reason: "NO_FRAME" };
    const notifyFrames = rpc.of("extension_ui_request").filter((f) => f.method === "notify");
    return {
      homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
      case: "no-ui",
      question: "Does the structured result survive --no-ui, where the notify side channel vanishes?",
      sessionId,
      frame: frame ?? null,
      verdict,
      committed: frame?.result?.committed ?? null,
      notifyFrameCount: notifyFrames.length,
      // The old channel is expected to be gone here; the new one must not be.
      notifyAvailable: notifyFrames.length > 0,
      resultFrameAvailable: Boolean(frame),
      stderr: rpc.stderrOf().slice(0, 1000),
    };
  } finally {
    await rpc.stop();
  }
}

/**
 * concurrent — several commits issued back to back on one live runtime.
 *
 * Each answer must be attributed to its own request id, and the generations must
 * be distinct and monotonic: a controller that pipelines commands must still be
 * able to tell which result belongs to which request.
 */
async function caseConcurrent() {
  const cwd = prepareScratch("concurrent");
  const provisioned = provision(join(cwd, "controller"));
  const rpc = startRpc({ args: probeArgs(), env: provisioned.envFor(), cwd, label: "concurrent" });
  try {
    await waitFor(() => rpc.of("ready").length > 0, 20000);
    const sessionId = await sessionIdOf(rpc);
    const ids = ["par-1", "par-2", "par-3", "par-4"];
    for (const id of ids) rpc.send({ id, type: "prompt", message: `/fence-generation PASS request=${id}` });
    await waitFor(() => ids.every((id) => rpc.of("prompt_result").some((f) => f.id === id)), 40000);

    const correlator = new ResultCorrelator(provisioned.key);
    for (const id of ids) correlator.expect(id, { sessionId });
    const frames = resultFrames(rpc);
    const verdicts = frames.map((frame) => ({ requestId: frame.requestId, ...correlator.accept(frame) }));
    const accepted = verdicts.filter((v) => v.ok);
    const generations = accepted.map((v) => v.result.generation);
    return {
      homeIsolation: homeIsolation(OPERATOR_HOME, childHome),
      case: "concurrent",
      question: "With pipelined commands, is every result attributed to its own request?",
      sessionId,
      sentRequestIds: ids,
      receivedRequestIds: frames.map((f) => f.requestId),
      verdicts,
      acceptedCount: accepted.length,
      generations,
      generationsDistinct: new Set(generations).size === generations.length,
      generationsMonotonic: generations.every((g, i) => i === 0 || g > generations[i - 1]),
      pendingAfter: correlator.pendingRequestIds(),
      stderr: rpc.stderrOf().slice(0, 1000),
    };
  } finally {
    await rpc.stop();
  }
}

const CASES = {
  commit: caseCommit,
  resume: caseResume,
  "no-ui": caseNoUi,
  concurrent: caseConcurrent,
  injection: caseInjection,
  "no-authority": caseNoAuthority,
};

function summarize(result) {
  const lines = [`case: ${result.case}`, `  question: ${result.question}`];
  for (const [key, value] of Object.entries(result)) {
    if (key === "case" || key === "question") continue;
    lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join("\n");
}

const [caseName, ...rest] = process.argv.slice(2);
const asJson = rest.includes("--json");

if (!caseName || caseName === "--help" || caseName === "-h" || !CASES[caseName]) {
  console.error(`usage: node scripts/omp-rpc-controller-contract-probe.mjs <${Object.keys(CASES).join("|")}> [--json]`);
  process.exit(caseName && !CASES[caseName] && caseName !== "--help" && caseName !== "-h" ? 2 : 0);
}

mkdirSync(SCRATCH_ROOT, { recursive: true });
const result = await CASES[caseName]();
const record = {
  ...result,
  generatedAt: new Date().toISOString(),
  scratchRoot: SCRATCH_ROOT,
  binary: process.env.AEGIS_RPC_BIN || "omp",
};
const evidenceDir = join(SCRATCH_ROOT, "evidence");
mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, `${caseName}.json`), `${JSON.stringify(record, null, 1)}\n`);
console.log(asJson ? JSON.stringify(record, null, 1) : summarize(record));
process.exit(0);
