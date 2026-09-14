// test/subagent/test-agent-command-admission.mjs
//
// Regression: buildAgentCommand() output MUST pass its own pre-spawn search
// admission gate (governSearch). The FR4 governor rejects recursive searches
// hidden behind command substitution; the scripted agent commands previously
// used FILES=$(grep -rl …)/$(find …) and were rejected by their own gate,
// turning every read-only subagent phase into EXECUTOR_ERROR → HOLD.
//
// Run: node --test test/subagent/test-agent-command-admission.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCommand } from "../../src/subagent/subagent-executor-adapter.mjs";
import { governSearch } from "../../src/admission/search-scope-governor.mjs";

const TASK_TYPES = [
  "count_todos",
  "inventory_markdown",
  "verify_writer",
  "write_report",
  "write_report_fail",
];

test("buildAgentCommand output passes governSearch for every taskType (bounded /src/docs root)", () => {
  for (const taskType of TASK_TYPES) {
    const cmd = buildAgentCommand(taskType);
    const d = governSearch({
      command: cmd,
      cwd: "/",
      authorizedRoots: ["/src/docs"],
      authoritativeRoots: ["/src/docs"],
    });
    assert.equal(
      d.admit,
      true,
      `${taskType} agent command must pass its own admission gate (got ${d.decision}/${d.holdCode}: ${d.reason})`
    );
  }
});

test("no recursive search hidden behind command substitution in generated scripts", () => {
  for (const taskType of TASK_TYPES) {
    const cmd = buildAgentCommand(taskType);
    // direct reproduction of the defect shape: $(grep -r / $(find …)
    assert.doesNotMatch(cmd, /\$\(\s*(grep|find)\b[^\n)]*-r[^\n)]*\)/, `${taskType}: recursive search behind $()`);
    assert.doesNotMatch(cmd, /\$\(\s*find\b/, `${taskType}: find behind $()`);
  }
});
