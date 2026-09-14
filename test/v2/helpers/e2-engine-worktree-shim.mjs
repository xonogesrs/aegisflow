// test/v2/helpers/e2-engine-worktree-shim.mjs
//
// E2 REBOOT SOAK — engine-mode worktree shim (NEW file; E2-owned).
// Worktree seams for the continuation legs: writer phases never execute in
// engine mode (deterministic adapters), so these only need to exist as
// honest no-op bookkeeping. Zero repository mutation: no `git worktree add`
// is ever run, the source repo is untouched.

export function prepareWorktree() {
  throw new Error("e2 engine mode: prepareWorktree is unreachable (no writer phase dispatch in engine mode)");
}

export function verifyWorktree() {
  return { ok: true, mode: "e2-engine-no-worktree" };
}

export function revokeWorktree() { return { revoked: false }; }

export function captureWorktreeOutput() { return null; }
