# Third-party license inventory (CBM scope)

**Card:** `AEGISFLOW_CBM_UPSTREAM_PARITY_AND_PROVENANCE_AUDIT_1`
**Mode:** READ-ONLY AUDIT — compliance inventory only. No license file was
modified, and no infringement conclusion is drawn.

---

## 1. Headline

**No third-party license obligation attaches to CBM, because no third-party code
is present in CBM.** The subsystem is first-party, Apache-2.0, single-author.

Compliance work for this card therefore reduces to two checks that were already
satisfied before it started, plus one documentation gap worth recording.

---

## 2. First-party position

| Item | Value | Evidence |
|---|---|---|
| Repository license | Apache-2.0 | `LICENSE` (202 lines, Apache License 2.0) |
| `package.json` `license` | `Apache-2.0` | `package.json` |
| Copyright holder | `zhengfengqing (xonogesrs)`, 2026 | `NOTICE` |
| CBM file headers | no `SPDX-License-Identifier`, no `Copyright` line, no "adapted from" / "based on" / "ported from" | `grep -rn "copyright\|license\|SPDX\|adapted from\|based on\|ported from" src/memory integrations/omp/extensions/cbm-query.js scripts/autoloop-memory-query.mjs` → **0 matches** |
| Authors of record | 157 × `zhengfengqing <xonogears@gmail.com>`, 2 × `xonogesrs`, 1 × local — no imported commit | `git log --format='%an <%ae>' \| sort \| uniq -c` |
| CBM code lines | 6,073 | `wc -l` over `src/memory/**`, `cbm-query.js`, `autoloop-memory-query.mjs` |

### 2.1 Is the missing per-file header a defect?

**No, for the license.** Apache-2.0 does not require per-file headers; it requires
that recipients get a copy of the license and that `NOTICE` be preserved if one
exists. `LICENSE` is at the root and `NOTICE` names the copyright holder. The whole
tree is covered.

**It is a mild provenance weakness.** A reader of `src/memory/retrieval.mjs` cannot
tell from the file itself that it is first-party Apache-2.0 rather than a vendored
MIT component. Since this audit's central finding is that no upstream exists, a
one-line header per CBM module would make that permanent and self-evident. Recorded
as a **documentation candidate**, not a compliance obligation, and **not applied**
(card §9 forbids mutation).

---

## 3. Dependency inventory (the whole repository, since CBM adds none)

```
resolved packages: 93
  Apache-2.0      47
  MIT             33
  BSD-3-Clause    11
  0BSD             1
  ISC              1
unknown declared licenses: 0
copyleft / non-OSI (GPL, AGPL, SSPL, BSL, BUSL, CC-BY-NC, proprietary): 0
```

Source: `package-lock.json` parsed mechanically. This matches
`THIRD_PARTY_NOTICES.md` ("Distribution across **93** resolved packages:
`Apache-2.0` (47), `MIT` (33), `BSD-3-Clause` (11), `0BSD` (1), `ISC` (1)").

| Layer | Package | Version | License | Redistributed by AegisFlow? |
|---|---|---|---|---|
| Direct runtime dependency | `@earendil-works/pi-ai` | 0.83.0 | MIT | no — installed by the consumer |
| Peer (optional) | `@earendil-works/pi-coding-agent` | `>=0.84.0` | MIT | no |
| Transitive | 91 packages | per lockfile | see counts | no |

**CBM's own dependency count is zero.** `src/memory/sqlite-schema.mjs` imports
`node:sqlite` (a Node built-in) and nothing else; `local-store.mjs`,
`retrieval.mjs`, `canonical.mjs`, `validation.mjs` import only `node:*` and
first-party modules. `cbm-query.js` imports only `node:fs`, `node:path`,
`node:url` and dynamically loads the repo's own `src/memory/index.mjs`.

This is asserted by the CBM-1 research document as a design constraint
("**zero new external dependency** — the card forbids adding dependencies;
SQLite adds none") and it holds at `f731015`.

---

## 4. The two named candidate projects — obligations if adopted

Neither is present, so **no obligation exists today**. Recorded for the future
decision only.

| Project | License | Obligations that would attach **if code were vendored or redistributed** | Obligations **if merely executed as an external tool** |
|---|---|---|---|
| `DeusData/codebase-memory-mcp` | MIT | retain copyright + permission notice; no warranty/liability; **no** express patent grant | none beyond not misrepresenting the relationship |
| `@colbymchenry/codegraph@0.9.6` | MIT | same | same |
| `codebase-memory-mcp` third-party parsers | `THIRD_PARTY.md` in that repo | would apply to *their* redistribution, not to AegisFlow | none |

The card asks specifically: "do not assume all MIT licenses include an express
patent grant." **Confirmed for both candidates:** MIT grants copyright permissions
only. It contains no patent license clause. If either binary were ever vendored
into an AegisFlow artifact, a patent question would be open that MIT does not
answer — whereas Apache-2.0 (AegisFlow's own license) does contain an express
patent grant at §3.

That asymmetry is worth stating plainly: **adding an MIT-licensed code indexer to
an Apache-2.0 project does not weaken AegisFlow's grant for AegisFlow's code, but
it does not extend that grant to the added component.** Running the tool as a
separate process (the MCP model) avoids the redistribution question entirely.

---

## 5. Fork / modification notices

| Question | Answer | Evidence |
|---|---|---|
| Does AegisFlow carry a fork of any CBM project? | No | `CBM_PROVENANCE_AND_HISTORY.md` §4 |
| Does any file declare a modification of a third-party work? | No | header grep → 0 |
| Are there vendored files anywhere? | Two, both first-party | `pi-extensions/search-scope-governor/vendor/{search-scope-governor,pi-command-admission}.mjs` are byte-identical copies of AegisFlow's own `src/admission/*` modules (stated in `THIRD_PARTY_NOTICES.md` and confirmed by the file list) |
| Submodules? | none | `git submodule status` empty; no `.gitmodules` |
| Is `node_modules` tracked? | no | `.gitignore`; the working copy is a symlink to an external path |

---

## 6. Trademark / naming exposure

`THIRD_PARTY_NOTICES.md` ends with a trademark section that names Pi, pi-ai,
Anthropic, Claude, OpenAI, GPT, Google, Gemini, Mistral, DeepSeek, Z.ai, GLM, AWS,
Bedrock, Temporal, Restate, Docker, Colima, GitHub, Node.js.

**Not named there:** "CodeGraph", "codebase-memory-mcp", "DeusData",
"colbymchenry". None needs to be named today — AegisFlow does not reference them
in any committed file. If a future card adopts either, this section is where the
identification-only statement belongs.

The name "CBM" itself is AegisFlow's own abbreviation for "Codebase Memory"; it is
also used by the DeusData project as its own abbreviation. That is a **search
ambiguity**, not a legal one: the marks are the projects' names, not the three
letters, and the audit found no claim of affiliation in either direction. It is the
main practical reason to spell "AegisFlow CBM" in downstream documents.

---

## 7. Three-way disposition (card §7's required split)

### 7.1 Confirmed obligations

| # | Obligation | Status |
|---|---|---|
| 1 | Ship a copy of Apache-2.0 for first-party code | **met** — `LICENSE` at root |
| 2 | Preserve the `NOTICE` file content when redistributing | **met** — `NOTICE` exists and names holder |
| 3 | Do not imply endorsement by any named third party | **met** — trademark section disclaims affiliation |
| 4 | If AegisFlow ever redistributes a dependency, reproduce its license + NOTICE | **currently moot** — `THIRD_PARTY_NOTICES.md` states no third-party artifact is redistributed, and that remains true (no `dist/`, no npm package, no container image with bundled deps) |

### 7.2 Confirmed gaps

| # | Gap | Severity | Note |
|---|---|---|---|
| 1 | CBM modules carry no per-file provenance header | **informational** | not a license requirement; a readability/attribution improvement only |
| 2 | `THIRD_PARTY_NOTICES.md` has no row for the optional code-index tools even as *evaluated / not adopted* | **informational** | the file already does exactly this for Temporal and Restate; adding CodeGraph/DeusData in the same style would keep the "evaluated, not adopted" record complete |
| 3 | "CBM" is ambiguous with the DeusData project's abbreviation | **informational** | disambiguate by writing "AegisFlow CBM" |

Neither gap is a violation. All three were left unapplied (read-only card).

### 7.3 Awaiting confirmation

| # | Question | Why it is open |
|---|---|---|
| 1 | Whether the operator's pre-existing `@colbymchenry/codegraph` install (`~/.npm-global`, 2026-05-28) was ever used inside an AegisFlow session | No `.codegraph/` directory for any AegisFlow checkout exists, and `codegraph status` on this repo reports `Not initialized`; no transcript references the tool. Absence of evidence is strong here but is still absence |
| 2 | Whether a future card will adopt either candidate | outside this card's authority |
| 3 | Whether `node:sqlite`'s bundled SQLite is subject to any notice requirement in a redistributed Node runtime | Node's own distribution carries SQLite's public-domain notice; AegisFlow does not redistribute Node |

---

## 8. Non-claims

- This is not a legal opinion.
- It does not conclude that any party is or is not infringing.
- It does not modify, and does not propose modifying, any license or notice file.
- It records `0` unknown declared licenses in the lockfile; it does not audit the
  contents of each dependency's license text.
