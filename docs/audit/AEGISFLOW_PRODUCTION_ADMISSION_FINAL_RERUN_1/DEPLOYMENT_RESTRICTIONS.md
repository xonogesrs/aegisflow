# Deployment restrictions

These conditions are mandatory for an Owner-authorized governed launch. Admission does not activate production.

| Boundary | Disposition | Evidence | Required deployment condition |
| --- | --- | --- | --- |
| C1: capability and module resolution | `ACCEPTABLE` | C1 real governed probe: 9/9 facts, including a planted module that executes on the pre-repair path but not on repaired path; R4 agent/ledger adversarial probe 16/16. | Install exact `283b7e1` extension tree. Explicitly set trusted repo root. Attest loaded extension tree. Governed launch must report active sandbox and provisioned capability. |
| Node child provenance | `PASS`, conditional on pinned launch environment | Root-owned `/usr/local/bin/node` v22.22.2, SHA-256 `450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf`; `/usr`, `/usr/local`, `/usr/local/bin`, and binary are root:wheel `0755`. `node:sqlite` loads. Pinned PATH C1 and EKM tests: 21/21. | Controller passes `env.PATH=/usr/local/bin:/usr/bin:/bin` to `launchGovernedRuntime`. Verify `/usr/local/bin/node` realpath, root ownership, non-writable ancestors, and exact SHA-256 immediately before launch and at day-of smoke. Fail closed if any differs. Do not prepend operator/Agent-writable directories. |
| C2: per-session ledger | `ACCEPTABLE_WITH_RESTRICTION` | Prior admission reproduced double commit when two controllers use separate state dirs; R4 proved authenticated exclusivity within one ledger. | One local state directory and one live controller per session; every successor uses same directory and session identity. No network filesystem. |
| C3: per-correlator IDs | `ACCEPTABLE_WITH_RESTRICTION` | R3/R4 cross-instance frame, replay, and distinct-key cases passed. | One launch, correlator, and key per controller instance. Reconcile crash from ledger; never resume old key. |
| C4: non-durable fence | `ACCEPTABLE_WITH_RESTRICTION` | Prior admission crash probe: ledger witness and fresh-generation recovery. | Ledger is durable truth. Unreadable ledger means `UNKNOWN` and no retry. New closeout uses new generation. Do not claim suppressed-job identity survives crash. |

`/usr/local/bin/node` is a concrete current-host option, not a portable path baked into source. It is root-owned today; the runbook checks this again at activation. The C1 child still has no controller descriptor or key if a different executable is selected. That fact limits commit authority exposure; it does **not** make arbitrary child code safe. A substituted child could read accessible data, forge query output, or disrupt service. PATH pinning and file provenance control those risks.

The controller API already accepts `env.PATH` and forwards it to the governed runtime (`src/control-plane/controller-client.mjs`). `cbm-query.js` resolves its child from that PATH. No launcher or extension code change is required for this deployment configuration. The normal interactive OMP shell PATH remains unpinned and must not be used as evidence for governed activation.

No code enforces C2's session-to-directory uniqueness across independently configured controllers. Owner/operator must enforce mapping and check it before each launch. If that cannot be guaranteed, admission becomes HOLD before activation.
