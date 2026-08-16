# RETIRED_BY_RC1_BOUNDARY_CHANGE — test disposition (RB-SSG4-FR4)

Per RB-SSG4-RC1 (Search Governance Objective & Enforcement Boundary
Reconciliation), the following shell-semantic test files were **retired**, not
silently deleted. Their machinery was removed from
`src/admission/search-scope-governor.mjs` in FR4 and replaced by the coarse
guard (`test-rb-ssg4-fr4-foundation.mjs`).

| Retired test file | What it asserted | Disposition |
|---|---|---|
| `test-rb-ssg4-fr2-default-deny.mjs` | per-token expansion-provenance table ($VAR/${VAR}/$(...)/glob → INDETERMINATE) | Superseded by `isConcreteRootToken` (principle-based). |
| `test-rb-ssg4-r1-indirection.mjs` | wrapper contracts, shell `-c` cluster parsing, xargs, find `-exec` descent | Superseded by `classifyComplexForm` → UNRESOLVED_EXECUTION_STRUCTURE restate. |
| `test-rb-ssg4-r3-indirection.mjs` | `env -S` split-string tokenizer, `xargs -I` replacement tracking | Retired (non-goal: no shell-semantic reconstruction). |
| `test-rb-ssg4-r5-positional-cwd.mjs` | positional-parameter substitution, xargs-replace cwd taint | Retired (non-goal: no positional evaluation). Cwd taint retained as a single coarse rule. |
| `test-rb-ssg4-r7-quote-aware-positional.mjs` | quote-aware positional substitution | Retired (non-goal: no positional evaluation). |

The invariants these tests protected (an unknown/indirected recursive root must
never enter the bounded-literal ADMIT lane) remain enforced and are re-proven by
`test-rb-ssg4-fr4-foundation.mjs` (B3/B4).
