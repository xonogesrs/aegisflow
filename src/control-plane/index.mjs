// src/control-plane/index.mjs
//
// CP-2 — Control Plane public surface.
//
// P7 SUBTRACTION (M25-optimizer → OPTIONAL_ORCHESTRATION): the optimizer
// advisory is NO LONGER re-exported from the control-plane surface — it
// lives in the optional orchestration layer (src/orchestration/optimizer.mjs)
// and is consumed by the coordinator through the optional seam. The public
// control-plane surface is the contract + the coordinator only.

export * from "./contract.mjs";
export * from "./coordinator.mjs";
