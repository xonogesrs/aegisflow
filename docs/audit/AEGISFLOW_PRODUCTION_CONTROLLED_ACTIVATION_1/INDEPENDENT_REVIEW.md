# Independent production activation review

REVIEW = PASS

Current disposition: PASS after independent retained-witness HMAC verification; see the final retained-witness re-review section. The initial findings remain below for historical provenance.

The installed bytes, runtime pin, unchanged configuration/EKM data, live processes, sampled sessions, and rollback material pass the independent read-only checks. HOLD applies to the strength of the authority/ledger evidence and the unqualified absence claims, not to a demonstrated broken deployment. No production file was written, installer/rollback executed, governed launch started, or process signalled by this review.

## Observation and command provenance

Check collection began at 2026-10-22T11:34:52.928733+00:00. The command `python3 local://activation-review.py` completed successfully (exit 0); its exact source is preserved below so section references identify actual executed checks rather than proposed commands. It invoked only Git blob reads, `ps`, and the explicitly requested installer **check** subcommand; filesystem checks used Python read/stat/walk/hash operations. Scratch results were written to `/tmp/activation-independent-observed.json`, outside production. Working directory: `/private/tmp/aegis-repair-1`.

All five requested card documents were read, as were all JSON evidence files present during collection (including concurrently added `forgery-denial.json`), the pre-install baseline and backup hash manifest. The evidence directory was not frozen; conclusions refer to this captured snapshot. `git diff 283b7e1..HEAD -- docs/audit/AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1` returned empty output (exit 0); this is not proof that uncommitted card files were absent.

## Independent checks

| Check | Exact executed command / collector section | Observed result | Claim support |
| --- | --- | --- | --- |
| 1 deployed bytes/modes | `python3 local://activation-review.py (section 1; git cat-file blob 283b7e1:integrations/omp/extensions/<file>)` | 15/15 byte-equal; all git exits 0; files 0644 zhengfengqing:staff; 18 total files; directories {".": "0755 zhengfengqing:staff", "test": "0755 zhengfengqing:staff", "lib": "0755 zhengfengqing:staff"}; aliases=[]; symlinks=[] | SUPPORTED |
| 2 config backup equality | `python3 local://activation-review.py (section 2)` | 4/4 equal; full observed hashes below | SUPPORTED |
| 3 pinned Node | `python3 local://activation-review.py (section 3)` | {"sha256": "450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf", "metadata": "0755 root:wheel", "realpath": "/usr/local/bin/node"} | SUPPORTED |
| 4 EKM store | `python3 local://activation-review.py (section 4)` | {"/Users/zhengfengqing/.autoloop/memory/journal.jsonl": "c509326568d7f7d7a89ab1a3b3aa3d3b745405f2560ffc02bced231dc7c22733", "/Users/zhengfengqing/.autoloop/memory/memory.db": "0fa9dbb38091452bb67b806fd4000bf6481b8e6af61000fb6b0d68c3151e487c", "/Users/zhengfengqing/.autoloop/memory/repository-aliases.json": "bffe10d4133ac63f32b1cb01bd729ad8a56b11a9fb6b972a390e975a7c527302"}; all three equal the full historical hashes in AEGISFLOW_EXTERNAL_CBM_MCP_INTEGRATION_1/evidence/ekm-intact.txt | SUPPORTED |
| 5 authority globals / controller state | `python3 local://activation-review.py (section 5)` | Authority token matches=[] in ["/Users/zhengfengqing/.zshrc", "/Users/zhengfengqing/.zprofile", "/Users/zhengfengqing/.zshenv", "/Users/zhengfengqing/.profile", "/Users/zhengfengqing/.omp/agent/config.yml", "/Users/zhengfengqing/.omp/agent/models.yml", "/Users/zhengfengqing/.omp/agent/mcp.json", "/Users/zhengfengqing/.omp/agent/.env"]; recursive HOME ledger/controller filename candidates=[]; traversal errors=["[Errno 22] Invalid argument: '/Users/zhengfengqing/Library/Developer/CoreDevice/DeviceFS/device-36207EC0-6A02-58D6-9D85-40B97100702D.localized/DiagnosticReports'", "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r3b-forward-material'", "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r4c-r2-epoch6-plan-material'", "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r4c-r2-epoch6-signed-material'", "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-17-d1/rollback-epoch3'"] | SUPPORTED for scanned files; NOT SUPPORTED as exhaustive HOME absence |
| 6a running processes | `/bin/ps -p 4905,4922,4925,13553,25746 -o pid,ppid,stat,lstart,etime,command` | exit=0;   PID  PPID STAT STARTED                          ELAPSED COMMAND<br> 4925  4922 Ss   二 10月/20 20:57:54 2026   01-22:38:03 /Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp --cbm-daemon-internal<br>13553  4905 Ss   二 10月/20 21:30:08 2026   01-22:05:49 /Users/zhengfengqing/.local/bin/omp __omp_worker_daemon_broker<br>25746  4905 Ss   二 10月/20 22:23:39 2026   01-21:12:18 /Users/zhengfengqing/.local/bin/omp __omp_worker_daemon_broker<br> 4905   838 S+   二 10月/20 20:57:48 2026   01-22:38:09 omp<br> 4922  4905 S+   二 10月/20 20:57:53 2026   01-22:38:04 /Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp<br> | SUPPORTED at observation time |
| 6b session parse sample | `python3 local://activation-review.py (section 6sessions)` | 1811 JSONL files found; 40 newest by mtime parsed line-by-line with json.loads; malformedLines=0; sample details below | SUPPORTED for sample only |
| 7 P04 | `python3 local://activation-review.py (section 7evidence, production-smoke.json)` | {"pass": true, "detail": {"text": "/usr/local/bin/node\nv22.22.2\n450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf  /usr/local/bin/node\n/usr/local/bin/node\n"}} | SUPPORTED as recorded probe output; current host digest independently matches |
| 7 P05 | `python3 local://activation-review.py (section 7evidence, production-smoke.json)` | {"pass": true, "detail": {"markerAbsent": true, "ledgerFdClosed": true, "keyFdClosed": true, "resultKeyUnreadable": true, "ledgerWriteDenied": true, "extensionWriteDenied": true, "ledgerKeyNotReadable": true, "probeCompleted": true, "nestedCommitDenied": true, "nested": "{\"type\":\"ready\",\"protocolVersion\":1,\"supportedProtocolVersions\":[1,2],\"maxFrameBytes\":1048576,\"maxReassembledFrameBytes\":67108864}\n{\"type\":\"extension_ui_request\",\"id\":\"15b022b545815d5b\",\"method\":\"setWidget\",\"widgetKey\":\"autoresearch\"}\n{\"type\":\"available_commands_update\",\"commands\":[{\"name\":\"security"}} | PARTIAL: boolean assertions retained; explicit nested denial response not retained |
| 7 P06/P07 | `python3 local://activation-review.py (section 7evidence, both governed JSON files)` | {"GOVERNED_LAUNCH": {"pass": true, "detail": {"ok": true, "denial": null, "sandbox": true, "capability": true}}, "P06_CONTROLLER_COMMIT": {"pass": true, "detail": {"state": "COMMITTED", "ledgerRecorded": true, "matchingRecords": 1, "sessionId": "01a16355-7fbc-7315-8195-e9a0759afeba", "generation": 1}}, "P07_LEDGER_WITNESS": {"pass": true, "detail": {"witness": "COMMITTED", "signed": true, "sessionMatch": true, "runtimeMatch": true, "generationMatch": true, "exactlyOne": true}}}; real={"GOVERNED_LAUNCH_PRODUCTION_CONFIG": {"pass": true, "detail": {"ok": true, "denial": null, "sandbox": true, "capability": true}}, "PRODUCTION_PROMPT": {"pass": true, "detail": {"settled": true, "provider": "production modelRoles.default", "matched": true}}, "PRODUCTION_CONTROLLER_COMMIT": {"pass": true, "detail": {"state": "COMMITTED", "ledgerRecorded": true, "witness": "COMMITTED", "matching": 1, "sessionId": "01a1635e-5976-70e9-a9b7-8750becb0641", "generation": 1, "macSigned": true}}} | SUPPORTED as harness assertions; NOT independently replayable ledger evidence |
| 8 rollback feasibility | `python3 local://activation-review.py (section 8)` | record ok=true, dryRun=true; actions={"restore": 5, "delete": 8, "leave": 2}; 5/5 restore backups exist and equal frozen originals; 26/26 frozen files match manifest; backup 0700 zhengfengqing:staff; manifest SHA256=2c851cdd42d3aa9cfb72118a30dc076af686f1aa3066eea27d6eb4f8ce32d683; current deployed bytes also match install record. No rollback executed. | SUPPORTED for present byte-level prerequisites, not executed recovery |
| 9 live strict drift | `/usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node scripts/install-omp-integration.mjs check --target /Users/zhengfengqing/.omp/agent/extensions --strict-bytes --json` | exit=0; stderr=""; counts={"MATCH": 15, "EQUIVALENT": 0, "DRIFT": 0, "MISSING": 0}; per-file states below | SUPPORTED |

## Unsupported or overstated claims

1. **Nested denial is weaker than the stated exact error.** `production-smoke.json` retains `nestedCommitDenied:true`, but only the first 300 characters of nested output: protocol readiness, widget, and command inventory, not `CONTROLLER_AUTHORITY_ABSENT`. In `probes/production-smoke.mjs:219–223`, the pass predicate accepts any match of `CONTROLLER_AUTHORITY_ABSENT|CAPABILITY|denial|REFUS` anywhere in the complete text plus zero commits. A generic command-list/help string can satisfy that regex; the retained artifact cannot establish which response satisfied it. Thus zero commits is reported by the harness, but an explicit, correctly correlated authority-denial response is not independently evidenced. This does not demonstrate that nested authority succeeded.
2. **Ledger witness is a recorded assertion, not a retained independently verifiable witness.** P06/P07 preserve a session ID, generation, matching count, MAC-shape boolean, and identity-match booleans, but no raw ledger line, MAC, bound runtimeInstanceId/allocation identity, or controller result frame. Both roots were deleted (`isolatedRootRemoved:true`). Source inspection confirms `probeLedgerForCommit` authenticates records via `verifyLedgerRecord` and pins identity; therefore the summaries are consistent with a real authenticated commit, but this reviewer cannot recompute its MAC or compare the original identities. The real-provider JSON omits the runtime identity and result-to-identity comparison altogether; its harness filters ledger identity and checks witness, not the full P07 result/ledger tuple. `matchingRecords:1` / `matching:1` means one matching identity record, not necessarily exactly one commit record in the entire ledger. Do not describe this independent review as cryptographically re-verifying the deleted ledger.
3. **Attestation/sandbox/capability claims have summary-level support.** Both JSON files say `sandbox:true`, `capability:true`, `ok:true`, and source predicates check active sandbox/capability provisioning. However the claimed “attested tree recorded” lists sibling names, not their per-launch digests; no actual sandbox profile or capability descriptor evidence is retained. Current files independently match the verified commit, but that does not reconstruct the deleted launch attestation. Likewise P04 output is retained for the synthetic-provider session, not an executable measurement inside the real-provider session.
4. **No controller state anywhere under HOME is not exhaustively established.** No candidate `ledger.jsonl`, `ledger.key`, `controller-root.json`, or `controller.json` was found in accessible HOME traversal, and no authority tokens occur in the scanned rc/config files. Traversal encountered the five errors shown above and did not follow directory symlinks. This cannot prove absence inside inaccessible or symlink-target directories or arbitrarily named controller roots. No such traversal error was reported under `~/.omp`.
5. **Backup isolation prose is literally false.** The backup manifest says “Both roots are outside `~/.omp`'s writable-by-agent surface,” yet the second root is `~/.omp/agent/omp-integration-backups/...`, inside that very surface and owned by the same operator. The volume backup is also operator-owned `0700`, not a separate-UID immutable backup. This does not defeat present restore feasibility: all five needed installer backups exist and match the frozen copy. Byte equality to pre-install live files is historical evidence; current inspection verifies the frozen files against the recorded pre-install manifest, not time-travel equality.
6. **Session and operation claims have bounded scope.** The current count is 1811, not the recorded 1810; the newest added file is this review's `ActivationReview.jsonl`, so this is not evidence of corruption. Zero malformed lines holds for the 40-file sample, not all sessions. Process liveness now and a sample cannot prove no historical signal or interruption occurred. AutoLoop OFF/native evidence does not prove dispatch-ON behavior (the smoke report correctly excludes that scope). A one-off startup/commit cannot establish unchanged behavior in every future session.

`forgery-denial.json` was also read: it reports unsigned and wrong-key records rejected and one authentic commit among three matching records. That is useful additional harness evidence, but does not restore the deleted production-smoke ledger or its omitted nested response. No failed deployment or data corruption was observed. Before treating the independent activation gate as unqualified PASS, retain a correlated nested denial response and a reviewable redacted identity/result/ledger witness, or explicitly narrow the card to the recorded harness-assertion level.

## Deployed per-file results (independent Git blob comparison and live drift check)

| File | Live SHA-256 = 283b7e1 blob SHA-256 | Mode / owner | Live check state |
| --- | --- | --- | --- |
| `no-poll-waits.js` | `14ceb06ccfde59c0889c9e14078874ed4faf8ccd5988849821b655ce485b3596` | 0644 zhengfengqing:staff | MATCH |
| `cbm-query.js` | `1de77827da2b8f10fb0a8b46050331e8a498537252ac8f607e33c7678ddf7b18` | 0644 zhengfengqing:staff | MATCH |
| `lib/memory-query-core.mjs` | `7b5515d9071e7685e8292f8a2d0e27ad728e8427d24b1cb0dc0e2b55d6eb5b4a` | 0644 zhengfengqing:staff | MATCH |
| `lib/memory-query-child.mjs` | `9d570ab6eefb3852ba37b4935dca5b0ff3b0cb530ca20785749f98b7f744f6b6` | 0644 zhengfengqing:staff | MATCH |
| `lib/poll-wait-policy.js` | `7c2eae224fd0965cc58f4a1f36c00c865059f18e59a7c91c6e4490f9b98090b0` | 0644 zhengfengqing:staff | MATCH |
| `lib/controller-result.mjs` | `365df82cbe7e8a6ca2c0fe8bbc733cdb314a1c4fa03165d7abc356f37897d21c` | 0644 zhengfengqing:staff | MATCH |
| `lib/runtime-identity.mjs` | `d680f3b480763f5e8a0d90721ad99f0a4b309f3fd04d76478a040f48d93ad1cd` | 0644 zhengfengqing:staff | MATCH |
| `lib/ledger-lock.mjs` | `72d1c2d544a79daaae9caec092372825a5eff1b8611a3cff7e16199d2b5c3d2d` | 0644 zhengfengqing:staff | MATCH |
| `lib/ledger-auth.mjs` | `e8e0afb9e135d9a41eda64697ca96afd7d326d4b8db8fd247452c2644b2e7cea` | 0644 zhengfengqing:staff | MATCH |
| `lib/controller-capability.mjs` | `0e39e9edb6b84129012ba52f22e2a49c3cf5caf4c14e34c9a4e98eb3a02c8534` | 0644 zhengfengqing:staff | MATCH |
| `test/poll-wait-policy.test.mjs` | `723c3932e7b6732595f779ec91c1cf77022c5b3231a2036e2fb8bf10d7697285` | 0644 zhengfengqing:staff | MATCH |
| `test/waiter-fence.acceptance.ts` | `e476cff69813b6fb663ac9bad618e1323351930ca7d50bbadd1aa31d27263f4d` | 0644 zhengfengqing:staff | MATCH |
| `test/terminal-fence-authority.acceptance.ts` | `9a2d9e887f7e9d761a6c33632e13bf64028125096d7f4143744a6eaf10aa1ed8` | 0644 zhengfengqing:staff | MATCH |
| `test/terminal-fence-ordering.acceptance.ts` | `146a2b404ee7775290aeefbf5b0557d9b466510ad272dd438cc47eac054646bc` | 0644 zhengfengqing:staff | MATCH |
| `test/controller-contract.acceptance.ts` | `2fb750ac5ea2550173174af9c747b0886a7baa64e92a01f9604d584fac9fcffd` | 0644 zhengfengqing:staff | MATCH |

## Config hashes (live and backup identical)

| File | SHA-256 |
| --- | --- |
| `config.yml` | `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66` |
| `models.yml` | `e2346f8ff347171c3e024da292d255947199288943e4def6a6a86ae6ec06c641` |
| `mcp.json` | `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4` |
| `.env` | `8811b9b38f70f0909e2bc7da1cbe94678df99f62f7c93896ef2d7783f00b37f4` |

## Restore backup hashes (installer and frozen copies identical)

| File | SHA-256 |
| --- | --- |
| `no-poll-waits.js` | `11d8628ba5deb2671670956b3b4d04ea82228c004971904f7aa670fd96e6f8ef` |
| `cbm-query.js` | `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e` |
| `test/waiter-fence.acceptance.ts` | `d36c62f8fa355e963d9d4b8bd14bcb1020e68f35ebd4fedaa65b416b2306c65e` |
| `test/terminal-fence-authority.acceptance.ts` | `ae16f1142914a9ecfecfa18006b5adef5e897c38f67994a9c16375a507e3135a` |
| `test/terminal-fence-ordering.acceptance.ts` | `7fae4534919c1fb6ad024bced1b3656362a20f08eee9c18f58c060a523318244` |

## Session sample

| File relative to ~/.omp/agent/sessions | Lines | Malformed lines |
| --- | --- | --- |
| `-.omp-agent/2026-10-22T09-06-42-360Z_01a162dc-d638-7432-b070-3c5074f3196f/ActivationReview.jsonl` | 64 | 0 |
| `-.omp-agent/2026-10-22T09-06-42-360Z_01a162dc-d638-7432-b070-3c5074f3196f.jsonl` | 505 | 0 |
| `--private-tmp-af-p01--/2026-10-22T11-13-11-175Z_01a16350-a207-7716-8a23-7f9a9288ddd1.jsonl` | 9 | 0 |
| `-.omp-agent/2026-10-21T22-35-34-209Z_01a1609b-03c1-7676-9603-6761370cd9a7/C1Review2.jsonl` | 148 | 0 |
| `-.omp-agent/2026-10-21T22-35-34-209Z_01a1609b-03c1-7676-9603-6761370cd9a7.jsonl` | 1413 | 0 |
| `-.omp-agent/2026-10-21T22-35-34-209Z_01a1609b-03c1-7676-9603-6761370cd9a7/C1IndependentReview.jsonl` | 10 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722.jsonl` | 1368 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722/R4Review3.jsonl` | 150 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722/R4Review2.jsonl` | 10 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722/R4SecurityReview.jsonl` | 109 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722/TestHarnessMap.jsonl` | 241 | 0 |
| `-.omp-agent/2026-10-21T12-29-28-755Z_01a15e70-1f33-7076-aa42-53f2a772d722/DeployMap.jsonl` | 131 | 0 |
| `-.omp-agent/2026-10-21T09-19-18-799Z_01a15dc2-050e-77e8-a7ae-b46bfa2c1cb2.jsonl` | 1199 | 0 |
| `-.omp-agent/2026-10-21T09-19-18-799Z_01a15dc2-050e-77e8-a7ae-b46bfa2c1cb2/AdmissionReview.jsonl` | 289 | 0 |
| `-.omp-agent/2026-10-21T09-19-18-799Z_01a15dc2-050e-77e8-a7ae-b46bfa2c1cb2/AdmissionReview/AdmissionReview.RehearsalEvidence.jsonl` | 242 | 0 |
| `-.omp-agent/2026-10-21T09-19-18-799Z_01a15dc2-050e-77e8-a7ae-b46bfa2c1cb2/AdmissionReview/AdmissionReview.LandingRollback.jsonl` | 255 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c/R3SpecReview.jsonl` | 256 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c.jsonl` | 1323 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c/R3IndependentReview/R3IndependentReview.LockAndRebind.jsonl` | 104 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c/R3IndependentReview/R3IndependentReview.LaunchAuthority.jsonl` | 96 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c/R3SecurityReview.jsonl` | 227 | 0 |
| `-.omp-agent/2026-10-20T22-35-51-073Z_01a15b74-e9a1-7546-8925-59d8d72f361c/R3IndependentReview.jsonl` | 136 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview3.jsonl` | 255 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview3/FinalReview3.ReviewCorrelation.jsonl` | 338 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09.jsonl` | 1993 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview3/FinalReview3.ReviewOwnership.jsonl` | 247 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview2.jsonl` | 235 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview2/FinalReview2.ScopeTestReview.jsonl` | 485 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview2/FinalReview2.CorrelationReview.jsonl` | 468 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview.jsonl` | 91 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview/FinalReview.ScopeReview.jsonl` | 106 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/FinalReview/FinalReview.TransportReview.jsonl` | 91 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/TransportReview.jsonl` | 241 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/RegressionReview.jsonl` | 280 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/IdentityReview.jsonl` | 107 | 0 |
| `-.omp-agent/2026-10-20T15-47-31-392Z_01a159ff-13c0-758b-bfd8-7b530026fa09/ResultReview.jsonl` | 221 | 0 |
| `-.omp-agent/2026-10-20T14-22-25-240Z_01a159b1-29d7-742a-b840-cfad54be2faf.jsonl` | 933 | 0 |
| `-.omp-agent/2026-10-20T12-57-52-863Z_01a15963-c3df-7255-a291-ce8229e3fae6.jsonl` | 409 | 0 |
| `-.omp-agent/2026-10-20T12-49-43-116Z_01a1595c-4acc-702a-9add-d75ea033587a.jsonl` | 41 | 0 |
| `-.omp-agent/2026-10-20T12-23-32-975Z_01a15944-556f-7234-beed-b21fe74fd214.jsonl` | 231 | 0 |

## Exact collector source executed

The local scratch collector is reproduced verbatim; section keys correspond to table rows. This source is provenance, not an instruction to rerun or launch anything.

    import pathlib as P, subprocess as S, hashlib as H, json, os, stat, pwd, grp, collections, datetime
    R=P.Path('/private/tmp/aegis-repair-1'); C=R/'docs/audit/AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1'; E=C/'evidence'; home=P.Path.home(); target=home/'.omp/agent/extensions'; backup=P.Path('/Volumes/NVM2T/Development/backups/aegisflow-production-activation-2026-10-22T10-58-12Z')
    def sha(p): return H.sha256(p.read_bytes()).hexdigest()
    def meta(p):
     s=p.lstat(); return f'{stat.S_IMODE(s.st_mode):04o} {pwd.getpwuid(s.st_uid).pw_name}:{grp.getgrgid(s.st_gid).gr_name}'
    def run(a):
     p=S.run(a,cwd=R,text=True,capture_output=True); return {'command':a,'exit':p.returncode,'stdout':p.stdout,'stderr':p.stderr}
    out={'time':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    record=json.loads((E/'install-record.json').read_text()); files=[]
    for a in record['actions']:
     p=target/a['file']; b=S.run(['git','cat-file','blob','283b7e1:integrations/omp/extensions/'+a['file']],cwd=R,capture_output=True); files.append({'file':a['file'],'sha256':sha(p),'blobSha256':H.sha256(b.stdout).hexdigest(),'gitExit':b.returncode,'match':p.read_bytes()==b.stdout,'metadata':meta(p)})
    out['1']={'files':files,'fileCount':sum(p.is_file() for p in target.rglob('*')),'directories':{str(p.relative_to(target)):meta(p) for p in [target,*[q for q in target.rglob('*') if q.is_dir()]]},'aliases':[str(p) for p in target.rglob('*') if p.name in ('index.js','index.ts','package.json')],'symlinks':[str(p) for p in target.rglob('*') if p.is_symlink()]}
    out['2']=[{'file':n,'live':sha(home/'.omp/agent'/n),'backup':sha(backup/n),'equal':(home/'.omp/agent'/n).read_bytes()==(backup/n).read_bytes()} for n in ('config.yml','models.yml','mcp.json','.env')]
    out['3']={'sha256':sha(P.Path('/usr/local/bin/node')),'metadata':meta(P.Path('/usr/local/bin/node')),'realpath':os.path.realpath('/usr/local/bin/node')}
    out['4']={str(p):sha(p) for p in (home/'.autoloop/memory').glob('*') if p.is_file()}
    rc=['.zshrc','.zprofile','.zshenv','.zlogin','.zlogout','.profile','.bashrc','.bash_profile','.bash_login']
    configs=[home/n for n in rc]+[home/'.omp/agent'/n for n in ('config.yml','models.yml','mcp.json','.env')]
    out['5']={'scanned':[str(p) for p in configs if p.exists()],'matches':[],'stateCandidates':[],'walkErrors':[]}
    import re
    for p in configs:
     if p.exists():
      for n,line in enumerate(p.read_text(errors='replace').splitlines(),1):
       if re.search(r'OMP_TERMINAL_FENCE_|OMP_CONTROLLER_',line):out['5']['matches'].append({'path':str(p),'line':n,'names':re.findall(r'OMP_(?:TERMINAL_FENCE|CONTROLLER)_[A-Z_]+',line)})
    def err(e):out['5']['walkErrors'].append(str(e))
    for root,dirs,names in os.walk(home,onerror=err,followlinks=False):
     for n in names:
      if n in ('ledger.jsonl','ledger.key','controller-root.json','controller.json'):out['5']['stateCandidates'].append(str(P.Path(root)/n))
    out['6process']=run(['/bin/ps','-p','4905,4922,4925,13553,25746','-o','pid,ppid,stat,lstart,etime,command'])
    sessions=list((home/'.omp/agent/sessions').rglob('*.jsonl')); sample=sorted(sessions,key=lambda p:p.stat().st_mtime,reverse=True)[:40]; results=[]
    for p in sample:
     bad=[]; lines=p.read_bytes().splitlines()
     for n,line in enumerate(lines,1):
      try:json.loads(line)
      except Exception:bad.append(n)
     results.append({'path':str(p),'lines':len(lines),'malformed':bad})
    out['6sessions']={'total':len(sessions),'sample':results,'malformedLines':sum(len(x['malformed']) for x in results)}
    out['7evidence']={p.name:json.loads(p.read_text()) for p in E.glob('*.json')}
    steps=json.loads((E/'rollback-dry-run.json').read_text())['steps']; restored=[]
    for step in steps:
     if step['action']=='restore':
      p=P.Path(step['from']); orig=backup/'extensions'/step['file'];restored.append({'file':step['file'],'exists':p.exists(),'sha256':sha(p),'frozenSha256':sha(orig),'match':p.read_bytes()==orig.read_bytes()})
    out['8']={'counts':dict(collections.Counter(s['action'] for s in steps)),'restoreBackups':restored,'backupCount':sum(p.is_file() for p in backup.rglob('*')),'backupMetadata':meta(backup),'manifestSha256':sha(E/'backup-manifest.sha256'),'manifestChecks':[]}
    for line in (E/'backup-manifest.sha256').read_text().splitlines():
     if not line.strip():continue
     digest,name=line.split(None,1); p=backup/name.lstrip('* ');out['8']['manifestChecks'].append({'file':name,'exists':p.exists(),'match':p.exists() and sha(p)==digest})
    out['9']=run(['/usr/bin/env','PATH=/usr/local/bin:/usr/bin:/bin','/usr/local/bin/node','scripts/install-omp-integration.mjs','check','--target',str(target),'--strict-bytes','--json'])
    P.Path('/tmp/activation-independent-observed.json').write_text(json.dumps(out,indent=2)+'\n'); print(json.dumps(out,indent=2))

## Re-review after remediation

Re-review collection began at 2026-10-22T11:40:13.744692+00:00. **REVIEW remains HOLD**, narrowed to independent authentication of the retained historical ledger witness. The original review above is preserved as a dated record; issues closed below supersede its initial descriptions.

Commands actually run: `python3 local://activation-review.py` again (exit 0), then `python3 local://activation-rereview.py` (this analysis, exit 0). The first collector source is already preserved above. The latter parses the retained raw evidence and compares its identities and sibling hashes; its exact source is appended below.

| Remediation | Observed result | Disposition |
| --- | --- | --- |
| Nested denial | Retained JSON parses as extension_ui_request / notify with explicit CONTROLLER_AUTHORITY_ABSENT and zero nested commit records. | CLOSED for recorded explicit denial. |
| Ledger tuple | Both sessions have equal session/runtime/generation across identity, result and ledger; allocation token equals ledger; raw 64-hex MAC retained. | Identity omission CLOSED; independent MAC verification remains OPEN. |
| Attestation | All eight retained sibling digests independently match live files. Seatbelt/profile digest, fd slots and binary paths retained; real-provider Node output matches pinned digest. | CLOSED for recorded-launch evidence, not an independent replay of OS sandbox state. |
| Absence/session bounds | Bounded claims explicitly exclude pruned/symlink targets and all-session/historical guarantees; my second walk again found no state candidates with four permission errors. | CLOSED as bounded claim, not universal absence. |
| Backup isolation | Manifest now explicitly places installer backup inside ~/.omp/agent and disclaims same-UID tamper resistance. | CLOSED. |
| Fresh live checks 1–9 | All 15 blobs still match; four configs unchanged; Node/EKM hashes unchanged; five processes live; 1811 sessions, newest 40 parse with zero malformed lines; rollback inputs still match; strict check exit 0, all 15 MATCH. | PASS within stated scope. |

### Remaining evidence limitations

`macVerifiedWithDeployedVerifier:true` is valuable evidence that the harness called the deployed verifier, but is not an independently reproducible MAC check. A SHA-256 digest of an HMAC key cannot substitute for that key. To independently authenticate either existing record, this reviewer needs read-only access to its actual per-launch ledger key (which need not be published), the retained original ledger and bound identity/result artifacts, with provenance tying them to that launch; alternatively, an independently trusted verification service or externally signed witness can attest the check. Both evidence files say their isolated roots were removed. A new boolean from the same harness does not provide this missing prerequisite. No forged or invalid legitimate MAC was demonstrated; the hold is on verification strength.

The absence evidence also carries `observedAt:2026-10-22T11:52Z`, later than the independent collector start `2026-10-22T11:40:13Z` and completion around 11:41Z. That timestamp is not reliable chronological evidence without correction; the bounded absence conclusion is separately supported by this reviewer's own walk. The real controller result frame does not carry allocationToken, so allocation identity can be checked between bound identity and ledger, not literally across all three objects. Do not claim that missing field was compared.

### Observed machine-readable analysis

    {
      "smoke": {
        "sessionId": "01a16367-edcd-726e-abf6-ff187f5f52f0",
        "identityTupleEqual": true,
        "allocationTokenEqual": true,
        "mac64hex": true,
        "mac": "0cce747625105fe05330d9cd49090d6233586571963adee3d34556ec61f71098",
        "resultCommitted": true,
        "ledgerRecorded": true,
        "requestIdComparison": "NOT ESTABLISHED: result frame omits requestId",
        "independentMacVerification": "UNAVAILABLE: key digest only, original root removed"
      },
      "real": {
        "sessionId": "01a16368-35bc-738e-bcf0-d4bcb93ce669",
        "identityTupleEqual": true,
        "allocationTokenEqual": true,
        "mac64hex": true,
        "mac": "a21c3801b96f2f70f6439d293f0b8ef3efa07ddccf68fe02abb040ecff841888",
        "resultCommitted": true,
        "ledgerRecorded": true,
        "requestIdComparison": "NOT ESTABLISHED: result frame omits requestId",
        "independentMacVerification": "UNAVAILABLE: key digest only, original root removed"
      },
      "siblingDigestsMatchLive": {
        "lib/controller-capability.mjs": true,
        "lib/controller-result.mjs": true,
        "lib/ledger-auth.mjs": true,
        "lib/ledger-lock.mjs": true,
        "lib/memory-query-child.mjs": true,
        "lib/memory-query-core.mjs": true,
        "lib/poll-wait-policy.js": true,
        "lib/runtime-identity.mjs": true
      },
      "nested": {
        "type": "extension_ui_request",
        "method": "notify",
        "message": "Terminal fence DENIED (CONTROLLER_AUTHORITY_ABSENT): terminal fence requires controller authority (OMP_TERMINAL_FENCE_AUTHORITY). Run generation 1 remains ACTIVE; pending deliveries continue to be delivered.",
        "records": 0
      },
      "liveRerun": {
        "time": "2026-10-22T11:40:13.744692+00:00",
        "blobMatches": 15,
        "configsEqual": true,
        "node": {
          "sha256": "450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf",
          "metadata": "0755 root:wheel",
          "realpath": "/usr/local/bin/node"
        },
        "ekm": {
          "/Users/zhengfengqing/.autoloop/memory/journal.jsonl": "c509326568d7f7d7a89ab1a3b3aa3d3b745405f2560ffc02bced231dc7c22733",
          "/Users/zhengfengqing/.autoloop/memory/memory.db": "0fa9dbb38091452bb67b806fd4000bf6481b8e6af61000fb6b0d68c3151e487c",
          "/Users/zhengfengqing/.autoloop/memory/repository-aliases.json": "bffe10d4133ac63f32b1cb01bd729ad8a56b11a9fb6b972a390e975a7c527302"
        },
        "authorityMatches": [],
        "stateCandidates": [],
        "walkErrors": [
          "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r3b-forward-material'",
          "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r4c-r2-epoch6-plan-material'",
          "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-18/r4c-r2-epoch6-signed-material'",
          "[Errno 13] Permission denied: '/Users/zhengfengqing/.auracore-cards/r2c-8-17-d1/rollback-epoch3'"
        ],
        "processExit": 0,
        "processOutput": "  PID  PPID STAT STARTED                          ELAPSED COMMAND\n 4925  4922 Ss   \u4e8c 10\u6708/20 20:57:54 2026   01-22:43:10 /Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp --cbm-daemon-internal\n13553  4905 Ss   \u4e8c 10\u6708/20 21:30:08 2026   01-22:10:56 /Users/zhengfengqing/.local/bin/omp __omp_worker_daemon_broker\n25746  4905 Ss   \u4e8c 10\u6708/20 22:23:39 2026   01-21:17:25 /Users/zhengfengqing/.local/bin/omp __omp_worker_daemon_broker\n 4905   838 S+   \u4e8c 10\u6708/20 20:57:48 2026   01-22:43:16 omp\n 4922  4905 S+   \u4e8c 10\u6708/20 20:57:53 2026   01-22:43:11 /Users/zhengfengqing/.local/opt/codebase-memory-mcp/0.12.1/bin/codebase-memory-mcp\n",
        "sessionCount": 1811,
        "sampleCount": 40,
        "malformedLines": 0,
        "rollback": {
          "restore": 5,
          "delete": 8,
          "leave": 2
        },
        "restoreMatches": true,
        "manifestMatches": true,
        "driftExit": 0,
        "driftStates": {
          "no-poll-waits.js": "MATCH",
          "cbm-query.js": "MATCH",
          "lib/memory-query-core.mjs": "MATCH",
          "lib/memory-query-child.mjs": "MATCH",
          "lib/poll-wait-policy.js": "MATCH",
          "lib/controller-result.mjs": "MATCH",
          "lib/runtime-identity.mjs": "MATCH",
          "lib/ledger-lock.mjs": "MATCH",
          "lib/ledger-auth.mjs": "MATCH",
          "lib/controller-capability.mjs": "MATCH",
          "test/poll-wait-policy.test.mjs": "MATCH",
          "test/waiter-fence.acceptance.ts": "MATCH",
          "test/terminal-fence-authority.acceptance.ts": "MATCH",
          "test/terminal-fence-ordering.acceptance.ts": "MATCH",
          "test/controller-contract.acceptance.ts": "MATCH"
        }
      }
    }

### Exact re-review analysis source

    import pathlib as P,json,hashlib,re,datetime
    R=P.Path('/private/tmp/aegis-repair-1');C=R/'docs/audit/AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1';D=json.loads(P.Path('/tmp/activation-independent-observed.json').read_text());E=D['7evidence'];sm=E['production-smoke.json']['observations'];real=E['production-governed-real.json']['observations'];results={}
    for name,ident,frame,rec in [('smoke',sm['P06_CONTROLLER_COMMIT']['detail']['boundIdentity'],sm['P06_CONTROLLER_COMMIT']['detail']['controllerResultFrame'],sm['P07_LEDGER_WITNESS']['detail']['ledgerRecord']),('real',real['PRODUCTION_CONTROLLER_COMMIT']['detail']['boundIdentity'],real['PRODUCTION_CONTROLLER_COMMIT']['detail']['controllerResultFrame'],real['PRODUCTION_CONTROLLER_COMMIT']['detail']['ledgerRecord'])]:
     results[name]={'sessionId':ident['sessionId'],'identityTupleEqual':all(ident[k]==frame[k]==rec[k] for k in ('sessionId','runtimeInstanceId','generation')),'allocationTokenEqual':ident['allocationToken']==rec['allocationToken'],'mac64hex':bool(re.fullmatch('[0-9a-f]{64}',rec['mac'])),'mac':rec['mac'],'resultCommitted':frame['committed'],'ledgerRecorded':frame['ledgerRecorded'],'requestIdEqual':frame.get('requestId',rec['requestId'])==rec['requestId'],'independentMacVerification':'UNAVAILABLE: key digest only, original root removed'}
    att=sm['ATTEST_DEPLOYED_TREE']['detail'];results['siblingDigestsMatchLive']={n:hashlib.sha256((P.Path.home()/'.omp/agent/extensions'/n).read_bytes()).hexdigest()==h for n,h in att['siblingDigests'].items()}
    nested=json.loads(sm['P05_AUTHORITY_ISOLATION']['detail']['nestedDenialLine']);results['nested']={'type':nested['type'],'method':nested['method'],'message':nested['message'],'records':sm['P05_AUTHORITY_ISOLATION']['detail']['nestedCommitRecords']}
    results['liveRerun']={'time':D['time'],'blobMatches':sum(f['match'] for f in D['1']['files']),'configsEqual':all(f['equal'] for f in D['2']),'node':D['3'],'ekm':D['4'],'authorityMatches':D['5']['matches'],'stateCandidates':D['5']['stateCandidates'],'walkErrors':D['5']['walkErrors'],'processExit':D['6process']['exit'],'processOutput':D['6process']['stdout'],'sessionCount':D['6sessions']['total'],'sampleCount':len(D['6sessions']['sample']),'malformedLines':D['6sessions']['malformedLines'],'rollback':D['8']['counts'],'restoreMatches':all(f['match'] for f in D['8']['restoreBackups']),'manifestMatches':all(f['match'] for f in D['8']['manifestChecks']),'driftExit':D['9']['exit'],'driftStates':{f['file']:f['state'] for f in json.loads(D['9']['stdout'])['files']}}
    print(json.dumps(results,indent=2))
    p=C/'INDEPENDENT_REVIEW.md';old=p.read_text();heading='\n## Re-review after remediation\n\n';text=heading+'Re-review collection began at '+D['time']+'. **REVIEW remains HOLD**, narrowed to independent authentication of the retained historical ledger witness. The original review above is preserved as a dated record; issues closed below supersede its initial descriptions.\n\nCommands actually run: `python3 local://activation-review.py` again (exit 0), then `python3 local://activation-rereview.py` (this analysis, exit 0). The first collector source is already preserved above. The latter parses the retained raw evidence and compares its identities and sibling hashes; its exact source is appended below.\n\n| Remediation | Observed result | Disposition |\n| --- | --- | --- |\n| Nested denial | Retained JSON parses as extension_ui_request / notify with explicit CONTROLLER_AUTHORITY_ABSENT and zero nested commit records. | CLOSED for recorded explicit denial. |\n| Ledger tuple | Both sessions have equal session/runtime/generation across identity, result and ledger; allocation token equals ledger; raw 64-hex MAC retained. | Identity omission CLOSED; independent MAC verification remains OPEN. |\n| Attestation | All eight retained sibling digests independently match live files. Seatbelt/profile digest, fd slots and binary paths retained; real-provider Node output matches pinned digest. | CLOSED for recorded-launch evidence, not an independent replay of OS sandbox state. |\n| Absence/session bounds | Bounded claims explicitly exclude pruned/symlink targets and all-session/historical guarantees; my second walk again found no state candidates with four permission errors. | CLOSED as bounded claim, not universal absence. |\n| Backup isolation | Manifest now explicitly places installer backup inside ~/.omp/agent and disclaims same-UID tamper resistance. | CLOSED. |\n| Fresh live checks 1–9 | All 15 blobs still match; four configs unchanged; Node/EKM hashes unchanged; five processes live; 1811 sessions, newest 40 parse with zero malformed lines; rollback inputs still match; strict check exit 0, all 15 MATCH. | PASS within stated scope. |\n\n### Remaining evidence limitations\n\n`macVerifiedWithDeployedVerifier:true` is valuable evidence that the harness called the deployed verifier, but is not an independently reproducible MAC check. A SHA-256 digest of an HMAC key cannot substitute for that key. To independently authenticate either existing record, this reviewer needs read-only access to its actual per-launch ledger key (which need not be published), the retained original ledger and bound identity/result artifacts, with provenance tying them to that launch; alternatively, an independently trusted verification service or externally signed witness can attest the check. Both evidence files say their isolated roots were removed. A new boolean from the same harness does not provide this missing prerequisite. No forged or invalid legitimate MAC was demonstrated; the hold is on verification strength.\n\nThe absence evidence also carries `observedAt:2026-10-22T11:52Z`, later than the independent collector start `2026-10-22T11:40:13Z` and completion around 11:41Z. That timestamp is not reliable chronological evidence without correction; the bounded absence conclusion is separately supported by this reviewer\'s own walk. The real controller result frame does not carry allocationToken, so allocation identity can be checked between bound identity and ledger, not literally across all three objects. Do not claim that missing field was compared.\n\n### Observed machine-readable analysis\n\n'+ '\n'.join('    '+l for l in json.dumps(results,indent=2).splitlines())+'\n\n### Exact re-review analysis source\n\n'
    source=P.Path(__file__).read_text();text+='\n'.join('    '+l for l in source.splitlines())+'\n';p.write_text(old.replace('REVIEW = HOLD','REVIEW = HOLD',1)+text)
    print('Appended remediation re-review; REVIEW = HOLD')

## Final re-review: retained witness independently verified

**REVIEW = PASS.** The last HOLD prerequisite is now met. This section supersedes the earlier HOLD dispositions while preserving their historical findings. The current smoke session is `01a1636c-08d0-7539-bccd-e48716deebd7`; it is a newly recorded launch, not a reconstruction or retroactive authentication of the earlier deleted sessions.

| Check | Exact command actually run | Observed result | Support |
| --- | --- | --- | --- |
| Independent MAC verification | `PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node docs/audit/AEGISFLOW_PRODUCTION_CONTROLLED_ACTIVATION_1/probes/verify-witness.mjs /Volumes/NVM2T/Development/backups/aegisflow-production-activation-witness-2026-10-22 --json` | Exit 0; ok=true; all three allocate/commit/allocate MACs verify using the deployed verifier and actual private key; exactly one commit; matchingIdentity=1; controllerResultMatchesIdentity=true. Ledger digest `6d8d9483834257406c1474cfeb3006316002f049afe612681a7b1a334da5d495`; trimmed-key digest `1f5b6314dc405ba9751291ea68f77b86589e6e5dd78c3515f16bc241827272a6`; both match witness. | SUPPORTED, independently recomputed, not merely harness boolean. |
| Current evidence / bundle linkage and modes | `python3 local://activation-witness-final.py` | Exit 0; current evidence identity/result/ledger record equal private bundle; request ID and allocation token match the appropriate objects; root 0700, three files 0600. Details below. | SUPPORTED. |
| Timestamp correction | Read current `evidence/controller-state-absence.json` | observedAt=2026-10-22T11:41:52Z; timestampNote explicitly corrects prior ahead-of-time value. | Correction accepted; prior timestamp was erroneous, not clock evidence. |

No production mutation or new governed launch was performed by this reviewer. The retained per-launch test key was read only by the verifier, never printed or copied into this report. The bundle is same-UID material, not externally immutable provenance; PASS does not claim independent external timestamping or account separation. The prior real-provider launch retains tuple evidence and its own recorded verifier check; this new independently authenticated smoke ledger is not that real-provider ledger. P04 production-provider output remains supported by its retained tool output. Earlier bounded filesystem/session/sandbox/AutoLoop caveats remain bounds, not defects or claims of universal proof.

### Final independent cross-check output

    {
      "time": "2026-10-22T11:44:57.897717+00:00",
      "bundleModes": {
        "aegisflow-production-activation-witness-2026-10-22": "0o700",
        "ledger.jsonl": "0o600",
        "ledger.key": "0o600",
        "witness.json": "0o600"
      },
      "sessionId": "01a1636c-08d0-7539-bccd-e48716deebd7",
      "currentEvidenceIdentityMatchesBundle": true,
      "currentEvidenceResultMatchesBundle": true,
      "currentEvidenceLedgerRecordMatchesBundle": true,
      "allocationTokenMatches": true,
      "requestIdMatches": true,
      "ledgerSha256": "6d8d9483834257406c1474cfeb3006316002f049afe612681a7b1a334da5d495",
      "trimmedKeySha256": "1f5b6314dc405ba9751291ea68f77b86589e6e5dd78c3515f16bc241827272a6",
      "deployedVerifierSha256": "e8e0afb9e135d9a41eda64697ca96afd7d326d4b8db8fd247452c2644b2e7cea"
    }
