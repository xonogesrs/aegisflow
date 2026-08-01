// adapter/pi-rpc-protocol.mjs
//
// Pure JSONL framing for Pi's --mode rpc protocol. No process, no I/O, no
// provider knowledge -- just chunk-tolerant line splitting with hard limits
// and strict per-line JSON parsing. Per Pi's own docs/rpc.md: "RPC mode
// uses strict JSONL semantics with LF (\n) as the only record delimiter,"
// clients must "accept optional \r\n input by stripping a trailing \r," and
// must not use a generic line reader (Node's readline also splits on
// U+2028/U+2029, which are valid inside JSON strings) -- this splitter only
// ever splits on "\n".

export class ProtocolLimitError extends Error {
  constructor(reason, detail) {
    super(`pi_rpc_protocol_limit: ${reason}`);
    this.name = "ProtocolLimitError";
    this.reason = reason;
    this.detail = detail;
  }
}

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024; // 2 MiB per line
const DEFAULT_MAX_CUMULATIVE_BYTES = 64 * 1024 * 1024; // 64 MiB per run

export function createJsonlSplitter({
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxCumulativeBytes = DEFAULT_MAX_CUMULATIVE_BYTES,
} = {}) {
  let buffer = "";
  let cumulative = 0;

  function push(chunkStr) {
    buffer += chunkStr;
    const lines = [];
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        throw new ProtocolLimitError("line_too_long", { lineBytes: Buffer.byteLength(line, "utf8"), maxLineBytes });
      }
      cumulative += Buffer.byteLength(line, "utf8");
      if (cumulative > maxCumulativeBytes) {
        throw new ProtocolLimitError("cumulative_limit_exceeded", { cumulative, maxCumulativeBytes });
      }
      if (line.length === 0) continue;
      lines.push(line);
    }
    return lines;
  }

  return {
    push,
    get hasIncompleteLine() {
      return buffer.length > 0;
    },
    get incompleteLine() {
      return buffer;
    },
    get cumulativeBytes() {
      return cumulative;
    },
  };
}

export function parseEventLine(line) {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
