import { randomBytes, createHash } from "node:crypto";
import { C2dHoldError, HOLD } from "./fs-atomic.mjs";

const EXEC_RE = /^exec_[0-9a-f]{32}$/;

export function mintSecret() {
  return randomBytes(32).toString("hex");
}

export function secretDigest(secret) {
  return createHash("sha256").update(String(secret), "utf8").digest("hex");
}

export function mintExecutionId() {
  return `exec_${randomBytes(16).toString("hex")}`;
}

export function validateExecutionId(id) {
  if (typeof id !== "string" || !EXEC_RE.test(id)) {
    throw new C2dHoldError(HOLD.INVALID_EXECUTION_ID, `invalid execution_id: ${id}`);
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0")) {
    throw new C2dHoldError(HOLD.INVALID_EXECUTION_ID, `unsafe execution_id: ${id}`);
  }
  return id;
}

export function mintChainId() {
  return `chain_${randomBytes(12).toString("hex")}`;
}

export function mintCheckpointId() {
  return `ckpt_${randomBytes(12).toString("hex")}`;
}

export function mintTransitionId() {
  return `tr_${randomBytes(8).toString("hex")}`;
}

export function mintLeaseId() {
  return `lease_${randomBytes(8).toString("hex")}`;
}
