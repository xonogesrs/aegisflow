# Fixed Node binary manifest

Card: `AEGISFLOW_FIXED_NODE_GOVERNED_LAUNCH_SMOKE_1`. Observed 2026-10-22 on this host.

| Check | Observation |
| --- | --- |
| Requested executable | `/usr/local/bin/node` |
| `realpath` | `/usr/local/bin/node` (regular file, no symlink) |
| Owner/mode | `root:wheel`, `0755` |
| Ancestors | `/`, `/usr`, `/usr/local`, `/usr/local/bin`: each `root:wheel`, `0755` |
| Operator/Agent write check | `test -w /usr/local/bin/node` and `test -w /usr/local/bin` both exit 1 |
| Version | `v22.22.2` |
| SHA-256 | `450f27e22fc8babf6eb2e19d77474d99b12f3c12515900c0266a0ca7ea526fbf` |
| Governed child PATH | `/usr/local/bin:/usr/bin:/bin` |
| Agent Bash observation | `command -v node` = `/usr/local/bin/node`; `node --version` = `v22.22.2`; in-session digest matches above |

The controller client received the fixed PATH as its child `env.PATH`. It is a launch setting, not a global shell PATH edit. The root-owned binary and all parent directories are not writable by the Agent UID on this host. The same provenance must be checked again before any Owner-authorized activation, per the prior [deployment restrictions](../AEGISFLOW_PRODUCTION_ADMISSION_FINAL_RERUN_1/DEPLOYMENT_RESTRICTIONS.md).
