import assert from "node:assert/strict";
import { classifyBashWait, decideBashWait, DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS } from "../lib/poll-wait-policy.js";

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; console.log("FAIL", name, "-", e.message); } }

// --- MUST BLOCK: the incident's exact waiter shapes ---
const blocking = [
  ["incident waiter", 'sleep 600; date; for p in $(pgrep -f "run-suite.mjs"); do echo $p; done; echo "(empty=done)"'],
  ["plain sleep+date+ps", "sleep 600; date; ps -eo pid= | head -2; echo AUTOCHECK_DONE"],
  ["bare poll chain", "sleep 600; pgrep -f runner; echo done"],
  ["date wrapper (old seam 3)", "sleep 30; date; ps; echo x"],
  ["for-loop poll only", 'for i in 1 2 3; do sleep 60; pgrep -f x; done'],
  ["while poll", 'while true; do sleep 30; ps aux | grep x; done'],
  ["ps aux | grep pipeline", "sleep 300; ps aux | grep -E 'runner' | grep -v grep | wc -l; ls -t /tmp | head -1"],
  ["sleep with unit", "sleep 90s; pgrep -f x"],
  ["bare sleep (no duration)", "sleep"],
  ["subsecond poll", "sleep 5; pgrep x"],
];
for (const [n, c] of blocking) {
  t("block " + n, () => {
    const v = classifyBashWait(c);
    assert.equal(v.pollOnly, true, `${n}: pollOnly=${v.pollOnly} reason=${v.reason}`);
    // plain short sleeps are admitted but clamped; only >= threshold must block
    const d = decideBashWait(c, { async: true });
    assert.equal(d.action, "block", n);
  });
}

// explicit async poll-only -> block
t("async explicit block", () => {
  assert.equal(decideBashWait("sleep 120", { async: true }).action, "block");
});
// async unset but >= threshold -> block (THE bypass seam)
t("auto-background seam block", () => {
  const d = decideBashWait("sleep 600; date; ps -eo pid= | head -2; echo AUTOCHECK_DONE", { async: false });
  assert.equal(d.action, "block", "async-unset poll > threshold must block");
});
// async unset, short -> allow, clamped under threshold
t("short poll admitted but clamped below threshold", () => {
  const d = decideBashWait("sleep 5; pgrep x", { async: false, timeoutMs: 300_000 });
  assert.equal(d.action, "allow");
  assert.equal(d.timeoutMs, DEFAULT_AUTO_BACKGROUND_THRESHOLD_MS);
});
t("short poll with async:true still refused", () => {
  assert.equal(decideBashWait("sleep 5; pgrep x", { async: true }).action, "block");
});

// --- MUST ALLOW: real work containing a legitimate sleep ---
const allowing = [
  ["loop with real body", 'for i in 1 2 3; do sleep 30; npm test; done'],
  ["sleep then git", "sleep 5 && git status"],
  ["sleep then build", "sleep 10; npm run build"],
  ["real long job", "sleep 600; ./run-suite.mjs --all"],
  ["plain work", "npm test"],
  ["compute unit", "/usr/bin/time -p node unit.mjs 2000000 15000"],
];
for (const [n, c] of allowing) {
  t("allow " + n, () => {
    const d = decideBashWait(c, { async: false, timeoutMs: 300_000 });
    assert.equal(d.action, "allow", `${n}: ${JSON.stringify(d)}`);
  });
}
// but an explicit async of real work is still allowed
t("allow async real work", () => {
  assert.equal(decideBashWait("npm test", { async: true }).action, "allow");
});

console.log(`policy-test: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
