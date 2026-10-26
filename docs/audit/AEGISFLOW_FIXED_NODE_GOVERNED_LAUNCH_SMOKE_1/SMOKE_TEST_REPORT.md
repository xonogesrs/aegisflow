# Fixed Node governed launch smoke report

Card: `AEGISFLOW_FIXED_NODE_GOVERNED_LAUNCH_SMOKE_1`. Scope: fixed Node PATH plus real isolated governed OMP launch. `10/10 PASS` before independent review.

Previous card landing: `81fc1ecccb8e2054252e7f2c3d70788c1cc3a9d2`; local HEAD, upstream, and canonical remote matched. Branch `feat/omp-cbm-recovery`; worktree clean; no unpushed commits; stash empty. The deployable controller/extension source was unchanged since `283b7e155877a366a6b3dbf53288a4e54328f09e`.

| ID | Result | Actual observation |
| --- | --- | --- |
| S01 Fixed Node Resolution | PASS | Governed Agent Bash resolved `/usr/local/bin/node`, v22.22.2, expected SHA-256. |
| S02 Governed Launch | PASS | Real `/Users/zhengfengqing/.local/bin/omp --mode rpc` launched through `launchGovernedRuntime`; seatbelt active; controller capability provisioned; identity bound. |
| S03 Normal Prompt | PASS | Fake local provider drove real OMP prompt; assistant `SMOKE_OK` and `session_settled` frames observed. |
| S04 Bash Tool | PASS | One real `bash` tool start and end; fixed Node output captured from tool result. |
| S05 CBM Query | PASS | Real external CBM v0.12.1 stdio MCP indexed an isolated one-file repo (6 nodes, 5 edges); `search_code` returned `fixedNodeSmoke` result. |
| S06 CBM/EKM Memory | PASS | Real `ekm_query` extension returned `AVAILABLE`, one seeded `fixedNodeSmoke` record, `isolation.active=true`. |
| S07 Agent Authority Isolation | PASS | Real Agent Bash had no authority marker, open ledger/key descriptors, readable result/ledger key, ledger path write, or writable extension. Agent command-channel and nested OMP attempts produced zero commit records. |
| S08 Ledger Forgery Denial | PASS | Agent append denied. Unsigned and wrong-key forged records did not produce `COMMITTED`; forged record did not block legitimate commit. |
| S09 Legitimate Controller Commit | PASS | Controller result `COMMITTED`; authenticated ledger probe `COMMITTED`; session, runtime, generation matched bound identity and ledger record; one signed commit. |
| S10 Session Closeout | PASS | OMP child exited; isolated root, test authority, ledger and CBM runtime directory removed. |

Evidence: [governed runtime](evidence/governed-smoke.json), [Agent Bash boundary](evidence/authority-bash-facts.json), [nested OMP and key denial](evidence/authority-nested-key-facts.json), [forgery and commit](evidence/authority-forgery-commit-facts.json). The R4 subset ran with `PATH=/usr/local/bin:/usr/bin:/bin` against the same reviewed controller/extension source. Its selected cases were A01–A07 and A10; this did not rerun the full R4 suite.

The local provider is a deterministic test model response source, not a controller stub. OMP, extensions, Bash, external CBM MCP, EKM child, controller client, sandbox and authenticated ledger were real executions. S05 used an isolated CBM cache and fixture. S06 used an isolated EKM store and fixture. No live production cache, session or ledger was queried or changed.
