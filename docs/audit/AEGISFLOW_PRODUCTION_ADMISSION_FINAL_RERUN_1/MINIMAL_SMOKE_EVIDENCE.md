# Minimal isolated smoke evidence

No test touched live PID 4905, live CBM, production extension/config, or production ledger. Tests ran from `283b7e155877a366a6b3dbf53288a4e54328f09e` with temporary state. For this final rerun, the only changed deployment condition was child Node selection: `PATH=/usr/local/bin:/usr/bin:/bin`.

| Required fact | Evidence used | Result |
| --- | --- | --- |
| `NORMAL_PROMPT`, `TOOL_CALLING`, `SLASH_COMMAND` | C1 card's 45-case OMP acceptance and 103/103 regression reported by predecessor; R4 final disposition records real runtime acceptance. Production OMP binary SHA still matches predecessor baseline. | `PASS` by prior same-build evidence; not rerun |
| `CBM_QUERY` | Prior production admission's CBM routing and unchanged live `mcp.json`/CBM binary. CBM is separate stdio MCP server. | `PASS` by prior evidence; not rerun |
| `CBM_MEMORY_ACCESS` | C1 real governed probe: child returned `AVAILABLE` with seeded record; pinned root-owned Node `test-omp-cbm-query.mjs` 11/11, including populated query and legacy alias. | `PASS` |
| `AUTOLOOP_DISPATCH` | Prior admission isolated AutoLoop probe; current `al-omp status` remains `OFF`/`native`. | `PASS` for existing dispatch behavior; activation remains off |
| `CONTROLLER_VALID_COMMIT` | C1 real governed probe committed after query and recorded ledger; R4 `R4_A10` authenticated commit. | `PASS` by prior evidence |
| `AGENT_COMMIT_DENIED` | R4 `R4_A01`–`A03`: no inherited descriptor/key, direct and nested attempt denied. | `PASS` by prior evidence |
| `LEDGER_FORGERY_DENIED` | R4 `R4_A05`–`A07`: append denied and unsigned/wrong-key records rejected without blocking legitimate commit. | `PASS` by prior evidence |
| C1 trust boundary under pinned Node PATH | `env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test test/omp-integration/test-c1-trust-boundary.mjs` | 10/10 PASS, 0 fail |
| EKM query under pinned Node PATH | `env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test test/omp-integration/test-omp-cbm-query.mjs` | 11/11 PASS, 0 fail |
| Isolated install rollback | `env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node --test test/omp-integration/test-omp-rollback.mjs` | 7/7 PASS, exact bytes and refused-drift cases |

Combined raw result: [pinned-path-tests.tap](evidence/pinned-path-tests.tap), `28/28 PASS`, zero failures/skips. The 10/10 C1 unit test has negative controls but permits an `UNAVAILABLE` branch in one tool assertion; it does not alone prove live child function. The prior C1 governed probe does: `isolation.active=true`, `AVAILABLE`, one seeded record, valid controller commit, and a pre-repair planted-module control. This rerun does not misstate 10/10 as a new governed acceptance run. Root-owned Node v22.22.2 also passed an explicit `require("node:sqlite")` check.

The prior real-runtime C1 probe used the default Homebrew Node, not the pinned root-owned Node. The pinned-path tests exercise the exact child resolver, child runner, query, memory store, and authority-env refusal. The day-of activation smoke in the runbook therefore repeats one governed `ekm_query` and one valid/denied commit under the pinned PATH before accepting traffic. A failure blocks activation and triggers rollback.

Prior source: [C1 evidence](../AEGISFLOW_C1_MINIMAL_TRUST_BOUNDARY_REPAIR_1/EVIDENCE.json), [R4 adversarial evidence](../AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1/ADVERSARIAL_EVIDENCE.md), [prior isolated rehearsal](../AEGISFLOW_PRODUCTION_ENABLEMENT_ADMISSION_AND_ROLLBACK_READINESS_1/ISOLATED_REHEARSAL_EVIDENCE.md). The 45-case and 103/103 counts were supplied in the predecessor closeout; raw result bundles are not part of this repository card.
