// Child-process output must be bounded while it is being captured, not only
// when the result is reported（memory-exhaustion hardening）.
import test from "node:test";
import assert from "node:assert/strict";
import { runBoundedCommand } from "../src/c2d/mutation-run.mjs";

test("runBoundedCommand: a child emitting ~256 MiB cannot grow captured output or RSS", async () => {
  const script = "const c = Buffer.alloc(1 << 20, 65); for (let i = 0; i < 256; i++) { process.stdout.write(c); process.stderr.write(c); }";
  const before = process.memoryUsage().rss;
  const res = await runBoundedCommand(process.execPath, ["-e", script], { timeoutMs: 60_000 });
  const grown = process.memoryUsage().rss - before;
  assert.equal(res.exit_code, 0);
  assert.ok(res.stdout.length <= 20000, "reported stdout must stay within the report cap");
  assert.ok(res.stderr.length <= 20000, "reported stderr must stay within the report cap");
  assert.ok(grown < 128 * 1024 * 1024, `RSS grew ${(grown / 1048576).toFixed(0)} MiB while draining 512 MiB of child output`);
});
