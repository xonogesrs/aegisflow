// adapter/scripted-adapter.mjs
//
// Deterministic, fully offline adapter for exercising lifecycle-runner.mjs
// without any subprocess, network, or provider call. Never spawns a
// process, never touches a real provider session. Each call consumes the
// next entry of a pre-scripted call sequence and returns its normalized
// result; any call-order mismatch or sequence exhaustion fails closed
// rather than guessing or silently reusing a prior step.

import { assertAdapterRequest, assertAdapterResult } from "./contract.mjs";

export class ScriptedAdapterSequenceError extends Error {
  constructor(reason, detail) {
    super(`scripted_adapter_sequence_error: ${reason}`);
    this.name = "ScriptedAdapterSequenceError";
    this.reason = reason;
    this.detail = detail;
  }
}

export function createScriptedAdapter(script) {
  if (!Array.isArray(script)) throw new TypeError("script must be an array of scripted steps");
  let cursor = 0;
  const callRecord = [];

  async function runAdapter(request) {
    assertAdapterRequest(request);

    if (request.abortSignal && request.abortSignal.aborted) {
      const result = {
        status: "aborted",
        executionId: request.executionId,
        stdout: "",
        stderr: "",
        signal: null,
        error: null,
        metadata: {},
      };
      callRecord.push({ phase: request.phase, attempt: request.attempt, consumed: false, result });
      return result;
    }

    if (cursor >= script.length) {
      throw new ScriptedAdapterSequenceError("script_exhausted", {
        phase: request.phase,
        attempt: request.attempt,
        cursor,
        scriptLength: script.length,
      });
    }

    const step = script[cursor];
    const expect = step.expect || {};
    if (expect.phase !== undefined && expect.phase !== request.phase) {
      throw new ScriptedAdapterSequenceError("phase_mismatch", {
        cursor,
        expectedPhase: expect.phase,
        actualPhase: request.phase,
      });
    }
    if (expect.attempt !== undefined && expect.attempt !== request.attempt) {
      throw new ScriptedAdapterSequenceError("attempt_mismatch", {
        cursor,
        expectedAttempt: expect.attempt,
        actualAttempt: request.attempt,
      });
    }

    cursor += 1;
    // C4N test wiring: a scripted result may be a pure function of the
    // request（e.g. to bind evidence contract_id to the phase execution id
    // from the task card）. Static result objects continue to work unchanged.
    const baseResult = typeof step.result === "function" ? step.result(request) : step.result;
    const result = { ...baseResult, executionId: baseResult.executionId ?? request.executionId };
    assertAdapterResult(result);
    callRecord.push({ phase: request.phase, attempt: request.attempt, consumed: true, result });
    return result;
  }

  return {
    runAdapter,
    get callRecord() {
      return callRecord.slice();
    },
    get remaining() {
      return script.length - cursor;
    },
  };
}
