# EXTERNAL_CBM_VERSION_AND_SOURCE

**Card:** `AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1`
**Component:** DeusData `codebase-memory-mcp`
**Recorded:** 2026-10-19 (UTC 11:05–11:12)

## 1. Upstream identity

| Item | Value | How verified |
|---|---|---|
| Repository | `https://github.com/DeusData/codebase-memory-mcp` | GitHub API repository read |
| Release | `v0.12.1`, published `2026-10-16T23:35:48Z`, `prerelease: false` | `GET /repos/DeusData/codebase-memory-mcp/releases/latest` |
| Release selector | `latest` = `v0.12.1` at time of installation | same |
| License | MIT (`Copyright (c) 2025 DeusData`) | `LICENSE` inside the release archive |
| Third-party notices | `THIRD_PARTY_NOTICES.md` (690,430 B) shipped in the archive | archive listing |
| Language / runtime | Pure C, single static binary, no language runtime, no API key | binary `file(1)` + `--help` |
| Platform support | macOS / Linux / Windows, arm64 + amd64 | release asset matrix |

## 2. Selected artifact

| Item | Value |
|---|---|
| Asset | `codebase-memory-mcp-darwin-arm64.tar.gz` |
| Asset size | 49,875,423 B |
| Archive SHA-256 (measured) | `9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2` |
| Archive SHA-256 (published `checksums.txt`) | `9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2` |
| Match | **exact** |
| Archive members | `codebase-memory-mcp`, `LICENSE`, `install.sh`, `THIRD_PARTY_NOTICES.md` |
| Extracted binary SHA-256 | `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e` |
| Installed binary SHA-256 | `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e` (identical) |
| Binary file type | `Mach-O 64-bit executable arm64` |
| Reported version | `codebase-memory-mcp 0.12.1` |
| Code signature | ad-hoc (`Signature=adhoc`, `TeamIdentifier=not set`) — upstream's documented macOS posture; release notes state the installer ad-hoc signs |

Only `codebase-memory-mcp-darwin-arm64.tar.gz` was downloaded. The `-ui-darwin-arm64` asset has the
same published checksum line and is the same payload with the UI graph; it was **not** used. The
`.mcpb` bundle variant was **not** used. No `install.sh` execution occurred on this machine — see
`INSTALLATION_CHANGE_MANIFEST.md`.

## 3. Why this version and not `main`

`main` carries CBM Lens Beta (PR #2068), which the release notes state is not part of `v0.12.1`.
The card requires a stable release or reproducible commit; `v0.12.1` is the newest non-prerelease tag
and is the version whose `checksums.txt` could be matched byte-for-byte. No source build was
performed, so no compiler/toolchain was introduced.

## 4. MCP surface

| Item | Value |
|---|---|
| Transport | MCP over stdio (`codebase-memory-mcp` with no arguments = "Run MCP server on stdio") |
| Protocol version negotiated | `2025-06-18` |
| `serverInfo` | `{"name":"codebase-memory-mcp","version":"0.12.1"}` |
| Tool count | 17 |
| Hosted service / API key | none; indexing and queries are local |
| Optional network path | `CBM Lens` UI model download from Hugging Face only after an explicit opt-in; disabled in this deployment (`ui_enabled=false`) |

The 17 tool names as actually returned by `tools/list` are recorded in
`evidence/cbm-tool-names.json`. They arrive in OMP as `codebase_memory_<tool>`.

## 5. Upstream evidence location

The unmodified archive, published `checksums.txt`, and the extracted release files remain at
`/tmp/cbm-dl/` for the duration of this card. They are scratch artifacts and are deliberately **not**
committed anywhere. The durable record is the checksum table above plus
`evidence/cbm-provenance.txt`.
