// src/v2/stack-a-internal.mjs
//
// AUTH1 (R-09) — the SINGLE explicit internal/test-harness surface for the
// legacy STACK_A engine. NOT a production surface: production execution MUST
// go through runAdmittedGraph (src/admission/admission-gate.mjs).
//
// The production-facing runAutoLoop / runDurableAutoLoop / resumeAutoLoop are
// UNCONDITIONALLY fail-closed dead-ends; the actual engine lives here under
// the *Internal names and is reachable ONLY through this module. There is no
// caller-forgeable boolean/string/context that can unlock the production
// names — reaching the engine requires importing this internal surface
// explicitly.

export { runAutoLoopInternal } from "../autoloop.mjs";
export { runDurableAutoLoopInternal, resumeAutoLoopInternal } from "./durable-execution.mjs";
