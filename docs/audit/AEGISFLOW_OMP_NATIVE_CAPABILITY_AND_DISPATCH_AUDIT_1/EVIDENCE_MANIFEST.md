# Evidence manifest — reproducibility

**Card:** `AEGISFLOW_OMP_NATIVE_CAPABILITY_AND_DISPATCH_AUDIT_1`
Every number in the six reports is produced by the queries below against read-only artefacts. No snapshot was taken and no state was copied into the repository beyond this manifest.

---

## 1. Committed deliverables

| File | Purpose |
|---|---|
| `OMP_NATIVE_DISPATCH_ARCHITECTURE.md` | baseline freeze; discovery, skill, tool, extension, MCP and prompt mechanisms; AegisFlow intervention points |
| `AEGISFLOW_COMPONENT_INVENTORY.md` | per-component inventory with registration/visibility/invocation/execution/value/conflict/disposition |
| `SKILL_AND_TOOL_INVOCATION_EVIDENCE.md` | call/result census, skill loads, extension and plugin evidence, failure observations |
| `INTEGRATION_BOUNDARY_AND_OVERLAP.md` | boundary table, overlap matrix, double-routing and fragility assessment |
| `ROOT_CAUSE_CANDIDATES.md` | classified candidates A–J with mechanism and evidence |
| `AUDIT_VERDICT.md` | verdict, the six required answers, class roll-up, non-claims, landing state |

---

## 2. External artefacts (not committed; machine-local)

| Artefact | Path | Identity |
|---|---|---|
| OMP executable | `/Users/zhengfengqing/.local/bin/omp` | sha256 `fa41b27d434380e99b713e4f9ced0f73eb1fc0c409fdf23a57c119971d24bac5`, 195,462,176 B, mtime 2026-10-18 12:52 +08:00 |
| OMP readable source | `~/node_modules/@oh-my-pi/pi-coding-agent` | `@oh-my-pi/pi-coding-agent@18.8.9`, 1,393 `.ts` files |
| Agent config | `~/.omp/agent/config.yml` | `modelRoles.smol: google-antigravity/gemini-3.8-flash` |
| Pre-repair config backup | `~/.omp/agent/config.yml.bak-pre-skilldesc-20261019` | differs from live config in the `smol` line only |
| Skill description cache | `~/.omp/agent/skill-descriptions.db` | 11 rows, table `skill_descriptions` |
| Session corpus | `~/.omp/agent/sessions/**/*.jsonl` | 1,735 files, 2026-08-16 → 2026-10-19 |
| Log corpus | `~/.omp/logs/*.log` | JSONL, 553 files |
| Plugin registry | `~/.omp/plugins/omp-plugins.lock.json` | `pi-jev 0.7.0`, `omp-computer-use 0.1.0`, `omp-grok-build 0.1.0`, `zmarketplace 0.7.8`, all `enabled: true` |
| MCP config | `~/.omp/agent/mcp.json` | one server: `kicad` (stdio) |
| CBM store | `~/.autoloop/memory/memory.db` | 8 `memory_records`, 8 FTS rows, 0 conflicts |
| Pilot runtime | `/Volumes/NVM2T/Development/autoloop-omp-pilot/runtime/**` | 462 run directories; 38 session JSONL files, 116 tool calls in 25 of them |
| Deployed extensions | `~/.omp/agent/extensions/` | `no-poll-waits.js`, `cbm-query.js` (+ ORCA files) |
| Deployed-vs-published check | `node scripts/install-omp-integration.mjs check --json` | 6 MATCH, 1 EQUIVALENT, 0 DRIFT, 0 MISSING |

---

## 3. Queries used (verbatim)

### 3.1 Tool call census

```python
import json, glob, os, collections
files = sorted(glob.glob(os.path.expanduser('~/.omp/agent/sessions/**/*.jsonl'), recursive=True))
calls, results = collections.Counter(), collections.Counter()
for f in files:
    for line in open(f, encoding='utf-8', errors='replace'):
        try: r = json.loads(line)
        except Exception: continue
        m = r.get('message') or {}
        if m.get('role') == 'toolResult' and isinstance(m.get('toolName'), str):
            results[m['toolName']] += 1
        for c in m.get('content') or []:
            if isinstance(c, dict) and c.get('type') == 'toolCall' and isinstance(c.get('name'), str):
                calls[c['name']] += 1
```

Reported: 1,735 files; 28 distinct call names including 3 malformed-name records (transcript corruption, not tools).

### 3.2 Skill loads and `xd://` device usage

```python
# inside the same loop, for each toolCall
p = (c.get('arguments') or {}).get('path')
if isinstance(p, str) and p.startswith('skill://'):
    skills[p.split('://', 1)[1].split('/')[0]] += 1
for d in re.findall(r'xd://([A-Za-z0-9_\-]+)', json.dumps(c.get('arguments') or {})):
    devices[d] += 1
```

### 3.3 Jev auto-suggestion messages

```python
if r.get('type') == 'custom_message' and r.get('customType') == 'jev-auto':
    …  # printed verbatim in SKILL_AND_TOOL_INVOCATION_EVIDENCE.md §4.1
```

### 3.4 Compression log history

```python
for line in open(logfile):
    r = json.loads(line)
    if 'Skill description compression' in r.get('message', ''):
        rows.append((r['timestamp'], r.get('message'), r.get('skill')))
```

Result: 1,877 events from 2026-10-15T00:02 to 2026-10-19T08:02; **zero** after 2026-10-19T08:03.

### 3.5 Secret hygiene check (fingerprints only, never values)

```python
# lengths and sha256 prefixes only
env = re.search(r'MERGE_GATEWAY_API_KEY=(\S+)', open('~/.omp/agent/.env').read()).group(1)
yml = re.search(r'apiKey:\s*(\S+)', open('~/.omp/agent/models.yml').read()).group(1)
# env: len 46, sha256 prefix e2962c68414e
# yml: len 46, sha256 prefix 7eecf55e928b
```

No full credential appears in any committed file, log excerpt or report.

### 3.6 Offline extension loadability probes

```bash
# pi-jev: registers 3 tools + 7 handlers, creates no session
bun -e 'const m = await import(process.env.HOME + "/.omp/plugins/node_modules/pi-jev/extensions/index.ts"); /* stub pi */'

# cbm-query: registers cbm_query
node -e 'const m = await import(process.env.HOME + "/.omp/agent/extensions/cbm-query.js"); /* stub pi with zod shim */'
```

Both probes ran with an in-memory stub `pi`; they performed no model call, wrote no file, and started no MCP server.

---

## 4. Non-reproduction disclosure

The corpus is live and grows while sessions run. Counts in these reports are as of the audit window (2026-10-19, +08:00). A later recount will differ by the sessions created after that window; the ratios and the zero/non-zero distinctions are what the conclusions rely on, and those are stable across the corpus's 65-day span.
