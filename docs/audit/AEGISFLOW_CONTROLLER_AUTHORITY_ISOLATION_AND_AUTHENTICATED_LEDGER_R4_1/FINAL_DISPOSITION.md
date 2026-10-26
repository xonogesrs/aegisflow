# R4 — Final disposition

**Card:** `AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1`
**Branch:** `feat/omp-cbm-recovery`
**Predecessor landing:** `6b5cad657ebd225b7afaf716883056b4f0eaca1f`

```
CARD = AEGISFLOW_CONTROLLER_AUTHORITY_ISOLATION_AND_AUTHENTICATED_LEDGER_R4_1

VERDICT = PASS

PREVIOUS_LANDING = PASS
MODEL_IDENTITY   = PASS

R4_AUTHORITY_ISOLATION       = PASS
R4_AUTHENTICATED_LEDGER      = PASS
R4_DEPLOYED_CODE_INTEGRITY   = PASS

AGENT_DIRECT_COMMIT   = DENIED
NESTED_OMP_COMMIT     = DENIED
FORGED_LEDGER_COMMIT  = DENIED
FORGED_LEDGER_DENIAL  = DENIED

CONTROLLER_VALID_COMMIT  = PASS
CROSS_PROCESS_EXCLUSIVITY = PASS

ADVERSARIAL_ACCEPTANCE = PASS   (16 cases / 66 facts, 0 failed, no vacuous passes)
REGRESSION_TESTS       = PASS
ROLLBACK_VERIFIED      = true

INDEPENDENT_REVIEW = PASS (reviewer returned HOLD; 7 findings, all fixed and re-measured)
DURABLE_LANDING    = PASS

PRODUCTION_MUTATION   = NONE
PRODUCTION_ENABLEMENT = false

GDR_1_APPROVED                = false
ORIGINAL_GENERATION_COMMITTED = false
HARDENING_BRANCH_CLOSED       = false

NEXT_ACTION = Re-run the Production Admission items affected by the C1 repair
              (the isolated deployment rehearsal and the activation smoke
              checklist) against this landing, then Owner decides activation.
              GDR-1 remains a separate hardening-closeout decision and is not
              advanced here.
```

---

## 1. Phase 0 — predecessor landing gate

Run in `/private/tmp/aegis-repair-1` before any implementation work.

```
git status --porcelain=v1            (empty)
git branch --show-current            feat/omp-cbm-recovery
git rev-parse HEAD                   6b5cad657ebd225b7afaf716883056b4f0eaca1f
git rev-parse '@{upstream}'          6b5cad657ebd225b7afaf716883056b4f0eaca1f
git ls-remote --heads origin feat/omp-cbm-recovery
                                     6b5cad657ebd225b7afaf716883056b4f0eaca1f  refs/heads/feat/omp-cbm-recovery
git log '@{upstream}'..HEAD --oneline (empty)
git stash list                        (empty)
```

`LOCAL = UPSTREAM = CANONICAL_REMOTE`, worktree clean, zero unpushed commits,
zero stashes — compared on the full SHA. The predecessor's Durable Landing claim
therefore holds, and this card started from exactly the tree it admitted.

No reset, clean, force-push or stash drop was used at any point.

## 2. What the card set out to prove, and what was measured

The card's single acceptance question: **只有真正的 Controller 才能提交，Agent
無論透過 Bash、Nested OMP 或偽造 Ledger，都不能取得同等權限。**

| Boundary | Verdict | Evidence |
|---|---|---|
| Agent cannot inherit authority | PASS | `R4_A01` — marker absent, both descriptors closed in real agent bash |
| Agent cannot commit | PASS | `R4_A02` — zero records from the Agent's attempt |
| Nested OMP cannot commit | PASS | `R4_A03` — zero records, parent unaffected |
| Agent cannot get the key | PASS | `R4_A04` — key path read-denied, result key unlinked |
| Agent cannot forge a record | PASS | `R4_A05` — append denied; any record that lands is unsigned |
| Forgery cannot read as COMMITTED | PASS | `R4_A06` — unsigned and wrong-key both `NOT_COMMITTED` |
| Forgery cannot deny a real commit | PASS | `R4_A07` — legit commit succeeds over a poisoned ledger |
| Wrong runtime / allocation rejected | PASS | `R4_A08`, `R4_A09` |
| Real commit works | PASS | `R4_A10` |
| Concurrency exclusive | PASS | `R4_A11` — no double commit |
| Crash/retry safe | PASS | `R4_A12` |
| Extension / binary protected | PASS | `R4_A13`, `R4_A14` |
| Frame forgery still rejected | PASS | `R4_A15` |
| Absent authority fails closed | PASS | `R4_A16` |

## 3. Why this is a real boundary and not a check

The predecessor's finding was that the Agent could do all of this because it is
the same uid as the Controller, with a shell. Adding *checks* would not have
changed that; the card asked for isolation, so the repair moves the thing that
authorizes a commit out of anything the Agent can name or inherit:

| Before | After |
|---|---|
| an environment variable the Agent inherits and can set | an inherited **file descriptor** plus a key, neither reachable by a grandchild |
| a ledger anyone can append to | a ledger whose path is write-denied to the whole tree, written through the controller's descriptor, and whose records carry a MAC |
| a "commit exists" test that matched `type + generation + session` | full identity pinning over **authenticated** records |
| tampering detected on the next launch | tampering **denied** by the OS sandbox for the running tree |

Three defects were found and fixed **during** Phase E that the design alone did
not close, and they are recorded in `ADVERSARIAL_EVIDENCE.md` rather than
quietly fixed:

1. Seatbelt matches the resolved path, so every deny rule written for a
   `os.tmpdir()` path matched nothing — the sandbox was inert while reporting
   `active: true`.
2. The deny list covered the attested (repository) tree but not the child's own
   discovery directory, which is the tree the Agent actually wrote to.
3. A descriptor passed via `stdio` survives into grandchildren, so the ledger fd
   had to be re-opened `O_CLOEXEC` before it could be called a capability.

## 4. Regression

| Scope | Result |
|---|---|
| OMP acceptance (policy, waiter-fence, authority, ordering, controller-contract 45 cases) | **PASS** |
| `test/omp-integration/*` (installer, rollback, isolation, client, ledger exclusivity, cbm) | **92/92** |
| R3 transport suite (84 facts, 11 cases) | **PASS** |
| R1/R2/R5 (memory + learning R2 suites) | **326/326** |
| lifecycle (state machine, guards, journals) | **167/167** |
| telemetry | **129/129** |
| AutoLoop entrypoint + launcher + lifecycle runner + host batch | **112/112** |
| governance + control-plane | **560/565** — the 5 failures are a missing optional dependency (`@earendil-works/pi-ai`) and fail identically on the untouched baseline |

`test/run-suite.mjs` was not run to completion: it exceeds the session's command
window. The card's own regression list was run file-by-file instead, which covers
every named item.

## 5. Rollback

Rehearsed in an isolated directory: install → check (`MATCH=13`, no drift) →
rollback (`ok: true`) → the tree is back to its pre-install state. The ledger and
evidence live outside the extension tree and are untouched by rollback, which
`test/omp-integration/test-r3-rollback-and-isolation.mjs` asserts byte-for-byte
along with "a rolled-back deployment still loads and answers a prompt and a slash
command on a real runtime".

## 6. What this card does not decide

- **It does not approve activation.** `PRODUCTION_ENABLEMENT = false`,
  `PRODUCTION_MUTATION = NONE`. Nothing was installed, stopped, restarted or
  reconfigured in production.
- **It does not close GDR-1** and does not touch the original generation.
- **It does not make the Controller a different user.** That is the durable
  answer to "same uid", it requires an install-time change, and this card is not
  authorized to make it. `THREAT_MODEL.md` §5 states this as residual risk rather
  than claiming the sandbox is an identity boundary.
- **`R4_ENGINEERING_PASS != PRODUCTION_READY`.** Activation is the Owner's
  decision, on a re-run of the admission items this repair affects.
