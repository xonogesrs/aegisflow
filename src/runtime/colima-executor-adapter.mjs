// src/runtime/colima-executor-adapter.mjs
//
// Colima executor adapter: satisfies adapter/contract.mjs `runAdapter`.
//
// Runs the task card's runtime command inside an isolated container on the
// PINNED Colima instance (never the shell's implicit docker context):
//   - mode=readonly: source repo mounted read-only at /src, task scratch rw
//   - mode=writer:   source repo ro at /src, dedicated worktree rw at /work
//   - network none, --cap-drop ALL, no-new-privileges, pids/cpu/memory limits
//   - runtime socket never mounted into the container
//   - timeoutMs + abortSignal from the lifecycle request are honored
//
// The adapter is authority-free: it only produces well-formed results. It
// also records its own result on taskCard.runtime.lastExecutorResult so the
// deterministic pipeline reviewer can judge stdout markers.

import { assertAdapterRequest } from "../adapter/contract.mjs";
import { runTask, assertMountAllowlist } from "./colima-runtime.mjs";

export class ColimaExecutorError extends Error {
  constructor(reason, details) {
    super(`colima_executor_adapter: ${reason}`);
    this.name = "ColimaExecutorError";
    this.reason = reason;
    this.details = details;
  }
}

export function createColimaExecutorAdapter({ profile, repoPath, scratchRoot, resultSink }) {
  if (!profile || !repoPath || !scratchRoot) {
    throw new ColimaExecutorError("profile/repoPath/scratchRoot required");
  }

  async function runAdapter(request) {
    assertAdapterRequest(request);
    if (request.phase !== "executor") {
      return {
        status: "error",
        executionId: request.executionId,
        error: `unexpected_phase:${request.phase}`,
        stdout: "",
        stderr: "",
        metadata: {},
      };
    }
    const runtime = request.taskCard?.runtime ?? {};
    const mode = runtime.mode ?? "readonly";
    const command = runtime.command ?? "echo 'no command provided'";
    const network = runtime.network ?? "none";
    const limits = runtime.limits ?? {};

    let roMounts;
    let rwMounts;
    if (mode === "writer") {
      if (!runtime.worktreePath) {
        return {
          status: "error",
          executionId: request.executionId,
          error: "writer_mode_requires_worktreePath",
          stdout: "",
          stderr: "",
          metadata: { mode },
        };
      }
      roMounts = [{ source: repoPath, target: "/src" }];
      rwMounts = [{ source: runtime.worktreePath, target: "/work" }];
    } else {
      roMounts = [{ source: repoPath, target: "/src" }];
      rwMounts = [{
        source: runtime.scratchPath ?? `${scratchRoot}/${request.executionId}/scratch`,
        target: "/scratch",
      }];
      // graph wiring: optional extra read-write mounts（e.g. a shared results
      // dir for JOIN/verifier nodes）— still constrained to scratchRoot by the
      // allowlist gate below.
      for (const m of runtime.extraRwMounts ?? []) rwMounts.push(m);
    }
    // Fail closed on any mount outside the allowlist before a container starts.
    assertMountAllowlist({ roMounts, rwMounts, repoPaths: [repoPath], scratchRoot });

    const result = await runTask({
      profile,
      executionId: request.executionId,
      taskId: `${mode}-${request.attempt}`,
      command,
      roMounts,
      rwMounts,
      network,
      cpus: limits.cpus,
      memoryMiB: limits.memoryMiB,
      pidsLimit: limits.pidsLimit,
      timeoutMs: limits.timeoutMs ?? request.timeoutMs,
      abortSignal: request.abortSignal,
    });
    resultSink?.(request.executionId, result);
    result.metadata = {
      ...(result.metadata ?? {}),
      mode,
      profile,
      roMounts: roMounts.map((m) => `${m.source}:${m.target}:ro`),
      rwMounts: rwMounts.map((m) => `${m.source}:${m.target}`),
      network,
      containerName: result.containerName,
    };
    // Deterministic in-process channel for the pipeline reviewer (same taskCard
    // object is passed to both adapters by lifecycle-runner.mjs).
    if (request.taskCard && typeof request.taskCard === "object") {
      request.taskCard.runtime = request.taskCard.runtime ?? {};
      request.taskCard.runtime.lastExecutorResult = result;
    }
    return result;
  }

  return { runAdapter };
}
