// DE-1R harness source (preserved from ~/.de1r/harness). Reproduce: copy to a
// dir with `npm i @temporalio/client@1.9.3 @temporalio/worker@1.9.3 @temporalio/workflow@1.9.3 @temporalio/activity@1.9.3`
// and run `node de1r-bakeoff.mjs` against a `temporal server start-dev` on 127.0.0.1:7233.

// de1r harness — deterministic workflow (pure orchestration, NO IO in workflow code)
// Mirrors DE-1 4-phase DAG: ro1 -> ro2 -> writer -> verifier, all work in activities.
import { proxyActivities } from "@temporalio/workflow";

export async function de1rGraph({ writerMode = "naive", roDelayMs = 0, writerDelayMs = 0, verifierDelayMs = 0 }) {
  const acts = proxyActivities({
    // NO taskQueue here: activities must inherit the workflow's task queue
    // (per-scenario isolation in the bake-off).
    startToCloseTimeout: "60s",
    heartbeatTimeout: "2s",
    retry: { maximumAttempts: 10, initialInterval: "500ms", backoffCoefficient: 1.5 },
  });

  // ro1 (read-only 1)
  await acts.phaseNaive({ phase: "p_ro1", delayMs: roDelayMs });
  // ro2 (read-only 2)
  await acts.phaseNaive({ phase: "p_ro2", delayMs: roDelayMs });
  // writer (mutation boundary) — RAW writer mutates BEFORE the kill window
  if (writerMode === "idem") {
    await acts.phaseIdem({ phase: "p_writer", delayMs: writerDelayMs });
  } else {
    await acts.phaseNaive({ phase: "p_writer", delayMs: writerDelayMs, mutateFirst: true });
  }
  // verifier
  await acts.phaseNaive({ phase: "p_verifier", delayMs: verifierDelayMs });

  return { graph: "de1r-4phase", writerMode, done: true };
}
