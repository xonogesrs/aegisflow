// test/rollover/helpers/spawn-adapter-internals.mjs
//
// Test-only re-export of the spawn adapter's internal session-id derivation
// contract (the adapter module does not export it; the derivation contract is
// pinned here so a change to the session-file convention fails this suite).

export { sessionIdFromSessionFile } from "../../../src/adapter/pi-spawn-adapter.mjs";
