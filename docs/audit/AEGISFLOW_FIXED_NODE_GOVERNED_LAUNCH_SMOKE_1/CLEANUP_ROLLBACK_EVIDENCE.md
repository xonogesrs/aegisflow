# Cleanup and production invariance

The focused harness called `runtime.stop()`, closed its local provider, disposed its test controller root, then removed its own isolated OMP/config/session/extension/CBM/EKM root and short CBM runtime directory. S10 recorded `childExited=true`, `isolatedRootGone=true`, `cbmRuntimeGone=true`, `authorityGone=true`, `ledgerGone=true`. Test authority and ledger are absent; no further test-ledger write is possible.

The pre-existing R4 probe disposed each test controller root. Its three named scratch roots were removed only after the selected facts were copied into this card. The CBM CLI diagnostic scratch and six failed focused-harness scratch roots were also removed by exact path. No unknown session or stash was deleted. Existing CBM processes were observed and not signaled.

After smoke, live baseline hashes matched the prior [production baseline](../AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1/PRODUCTION_BASELINE_MANIFEST.md): OMP `f2a657b3320fcafa23055053940a45b26a8d3254e1412a158838013d670d6ec5`, deployed `no-poll-waits.js` `11d8628ba5deb2671670956b3b4d04ea82228c004971904f7aa670fd96e6f8ef`, deployed `cbm-query.js` `03c08f43b145602edfc47e427c4b4738cf3fa9d19bcc6ec204a61f30ff52b75e`, `config.yml` `108ca03cb80bc76e09b895936da8e2898d85d361a5e493b72ac3792e59528d66`, `models.yml` `e2346f8ff347171c3e024da292d255947199288943e4def6a6a86ae6ec06c641`, `mcp.json` `032839c1b99c6003c8e3781149fead036cb2a50a3d638f9d452710dabb5a67d4`, CBM binary `a36cfa1f5d10d8c4762501d63feef082711aae4704b9e8f9066db52779a8601e`. Root Node digest also stayed `450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf`. The production extension remains the older deployed copy; this card installed nothing there.

```text
TEST_AUTHORITY_REVOKED = true
ISOLATED_CLEANUP = PASS
PRODUCTION_MUTATION = NONE
PRODUCTION_ENABLEMENT = false
```
