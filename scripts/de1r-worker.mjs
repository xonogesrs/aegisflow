// DE-1R harness source (preserved from ~/.de1r/harness). Reproduce: copy to a
// dir with `npm i @temporalio/client@1.9.3 @temporalio/worker@1.9.3 @temporalio/workflow@1.9.3 @temporalio/activity@1.9.3`
// and run `node de1r-bakeoff.mjs` against a `temporal server start-dev` on 127.0.0.1:7233.

// de1r harness — worker entry
import { Worker } from "@temporalio/worker";
import * as activities from "./activities.mjs";
import { configurePaths } from "./activities.mjs";

const sideLog = process.env.DE1R_SIDE_LOG ?? "/Users/zhengfengqing/.de1r/data/side-effects.jsonl";
const resultFile = process.env.DE1R_RESULT_FILE ?? "/Users/zhengfengqing/.de1r/data/result.txt";
const taskQueue = process.env.DE1R_TASK_QUEUE ?? "de1r";
configurePaths({ sideLog, resultFile });

const worker = await Worker.create({
  workDir: new URL(".", import.meta.url).pathname,
  taskQueue,
  workflowsPath: new URL("./workflow.mjs", import.meta.url).pathname,
  activities,
  maxConcurrentActivityTaskExecutions: 2,
  maxConcurrentWorkflowTaskExecutions: 4,
});

await worker.run();
