// src/learning/transfer-metrics/seam.mjs
//
// Unique production integration seam. Hardcoded disabled.
// No env, CLI, config, remote, or test-credential override exists.
// Enabling requires a later independent admission card.

export const TRANSFER_METRICS_ENABLED = false;
export const PRODUCTION_EFFECT = "NO_PRODUCTION_EFFECT";
export const DISABLED_STATUS = "DISABLED";

export function isTransferMetricsEnabled() {
  return false;
}

export function recordTransferEvent(_event, _principal) {
  return {
    status: DISABLED_STATUS,
    production_effect: PRODUCTION_EFFECT,
  };
}

export function getTransferMetricsWriter() {
  return null;
}
