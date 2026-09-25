# Third-Party Notices

AegisFlow itself is licensed under the Apache License, Version 2.0 (see
`LICENSE`). This file records the third-party components and services that
AegisFlow uses, and the trademark position that applies to the names of those
components.

## Scope: what AegisFlow redistributes

**AegisFlow redistributes no third-party source code, object code, container
image, or binary artifact.**

- No third-party file is committed to this repository. The tree contains only
  first-party code; the two files under
  `pi-extensions/search-scope-governor/vendor/` are byte-identical copies of
  this project's own `src/admission/*` modules, not third-party code.
- `node_modules/` is not tracked and is not part of any published artifact;
  it is recreated by `npm install` from the public npm registry, where each
  package carries its own license and notice files.
- AegisFlow produces no bundled build output (no bundler, no committed
  `dist/`, no published npm package).
- Consequently, no third-party license text, `NOTICE` file, or attribution is
  required to be reproduced by this repository today. If AegisFlow later ships
  a bundled artifact (npm package, container image, or single-file build),
  the obligations below become live and must be discharged for whichever
  packages are actually included.

License inventory below is derived mechanically from `package-lock.json` and
verified against the published npm metadata of each package. Distribution
across **93** resolved packages: `Apache-2.0` (47), `MIT` (33), `BSD-3-Clause` (11), `0BSD` (1), `ISC` (1).

## LINKED DEPENDENCY — npm packages resolved at install time

### Direct runtime dependency

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @earendil-works/pi-ai | 0.83.0 | MIT | registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.83.0.tgz |

`@earendil-works/pi-ai` is the provider-neutral LLM API library AegisFlow uses
for provider access. It is a normal npm dependency: installed by the consumer,
never vendored into this repository.

### Transitive dependencies (92 packages)

These are pulled in by the direct dependency's own manifest. They are listed
so that a redistributor can see the complete obligation set; AegisFlow does not
ship them.

| Package | Version | License | Source |
| --- | --- | --- | --- |
| @anthropic-ai/sdk | 0.91.1 | MIT | registry.npmjs.org/@anthropic-ai/sdk/-/sdk-0.91.1.tgz |
| @aws-crypto/sha256-browser | 5.2.0 | Apache-2.0 | registry.npmjs.org/@aws-crypto/sha256-browser/-/sha256-browser-5.2.0.tgz |
| @aws-crypto/sha256-js | 5.2.0 | Apache-2.0 | registry.npmjs.org/@aws-crypto/sha256-js/-/sha256-js-5.2.0.tgz |
| @aws-crypto/supports-web-crypto | 5.2.0 | Apache-2.0 | registry.npmjs.org/@aws-crypto/supports-web-crypto/-/supports-web-crypto-5.2.0.tgz |
| @aws-crypto/util | 5.2.0 | Apache-2.0 | registry.npmjs.org/@aws-crypto/util/-/util-5.2.0.tgz |
| @aws-sdk/client-bedrock-runtime | 3.1048.0 | Apache-2.0 | registry.npmjs.org/@aws-sdk/client-bedrock-runtime/-/client-bedrock-runtime-3.1048.0.tgz |
| @aws-sdk/core | 3.977.4 | Apache-2.0 | registry.npmjs.org/@aws-sdk/core/-/core-3.977.4.tgz |
| @aws-sdk/credential-provider-env | 3.972.65 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-env/-/credential-provider-env-3.972.65.tgz |
| @aws-sdk/credential-provider-http | 3.972.67 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-http/-/credential-provider-http-3.972.67.tgz |
| @aws-sdk/credential-provider-ini | 3.973.10 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-ini/-/credential-provider-ini-3.973.10.tgz |
| @aws-sdk/credential-provider-login | 3.972.72 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-login/-/credential-provider-login-3.972.72.tgz |
| @aws-sdk/credential-provider-node | 3.972.76 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-node/-/credential-provider-node-3.972.76.tgz |
| @aws-sdk/credential-provider-process | 3.972.65 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-process/-/credential-provider-process-3.972.65.tgz |
| @aws-sdk/credential-provider-sso | 3.973.9 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-sso/-/credential-provider-sso-3.973.9.tgz |
| @aws-sdk/credential-provider-web-identity | 3.972.71 | Apache-2.0 | registry.npmjs.org/@aws-sdk/credential-provider-web-identity/-/credential-provider-web-identity-3.972.71.tgz |
| @aws-sdk/eventstream-handler-node | 3.972.31 | Apache-2.0 | registry.npmjs.org/@aws-sdk/eventstream-handler-node/-/eventstream-handler-node-3.972.31.tgz |
| @aws-sdk/middleware-eventstream | 3.972.26 | Apache-2.0 | registry.npmjs.org/@aws-sdk/middleware-eventstream/-/middleware-eventstream-3.972.26.tgz |
| @aws-sdk/middleware-websocket | 3.972.47 | Apache-2.0 | registry.npmjs.org/@aws-sdk/middleware-websocket/-/middleware-websocket-3.972.47.tgz |
| @aws-sdk/nested-clients | 3.997.39 | Apache-2.0 | registry.npmjs.org/@aws-sdk/nested-clients/-/nested-clients-3.997.39.tgz |
| @aws-sdk/signature-v4-multi-region | 3.996.43 | Apache-2.0 | registry.npmjs.org/@aws-sdk/signature-v4-multi-region/-/signature-v4-multi-region-3.996.43.tgz |
| @aws-sdk/token-providers | 3.1048.0 | Apache-2.0 | registry.npmjs.org/@aws-sdk/token-providers/-/token-providers-3.1048.0.tgz |
| @aws-sdk/token-providers | 3.1100.0 | Apache-2.0 | registry.npmjs.org/@aws-sdk/token-providers/-/token-providers-3.1100.0.tgz |
| @aws-sdk/types | 3.974.2 | Apache-2.0 | registry.npmjs.org/@aws-sdk/types/-/types-3.974.2.tgz |
| @aws-sdk/util-locate-window | 3.965.8 | Apache-2.0 | registry.npmjs.org/@aws-sdk/util-locate-window/-/util-locate-window-3.965.8.tgz |
| @aws-sdk/xml-builder | 3.972.37 | Apache-2.0 | registry.npmjs.org/@aws-sdk/xml-builder/-/xml-builder-3.972.37.tgz |
| @aws/lambda-invoke-store | 0.3.0 | Apache-2.0 | registry.npmjs.org/@aws/lambda-invoke-store/-/lambda-invoke-store-0.3.0.tgz |
| @babel/runtime | 7.29.7 | MIT | registry.npmjs.org/@babel/runtime/-/runtime-7.29.7.tgz |
| @google/genai | 1.52.0 | Apache-2.0 | registry.npmjs.org/@google/genai/-/genai-1.52.0.tgz |
| @mistralai/mistralai | 2.2.6 | Apache-2.0 | registry.npmjs.org/@mistralai/mistralai/-/mistralai-2.2.6.tgz |
| @opentelemetry/api | 1.9.0 | Apache-2.0 | registry.npmjs.org/@opentelemetry/api/-/api-1.9.0.tgz |
| @opentelemetry/semantic-conventions | 1.43.0 | Apache-2.0 | registry.npmjs.org/@opentelemetry/semantic-conventions/-/semantic-conventions-1.43.0.tgz |
| @protobufjs/aspromise | 1.1.2 | BSD-3-Clause | registry.npmjs.org/@protobufjs/aspromise/-/aspromise-1.1.2.tgz |
| @protobufjs/base64 | 1.1.2 | BSD-3-Clause | registry.npmjs.org/@protobufjs/base64/-/base64-1.1.2.tgz |
| @protobufjs/codegen | 2.0.5 | BSD-3-Clause | registry.npmjs.org/@protobufjs/codegen/-/codegen-2.0.5.tgz |
| @protobufjs/eventemitter | 1.1.1 | BSD-3-Clause | registry.npmjs.org/@protobufjs/eventemitter/-/eventemitter-1.1.1.tgz |
| @protobufjs/fetch | 1.1.1 | BSD-3-Clause | registry.npmjs.org/@protobufjs/fetch/-/fetch-1.1.1.tgz |
| @protobufjs/float | 1.0.2 | BSD-3-Clause | registry.npmjs.org/@protobufjs/float/-/float-1.0.2.tgz |
| @protobufjs/path | 1.1.2 | BSD-3-Clause | registry.npmjs.org/@protobufjs/path/-/path-1.1.2.tgz |
| @protobufjs/pool | 1.1.0 | BSD-3-Clause | registry.npmjs.org/@protobufjs/pool/-/pool-1.1.0.tgz |
| @protobufjs/utf8 | 1.1.2 | BSD-3-Clause | registry.npmjs.org/@protobufjs/utf8/-/utf8-1.1.2.tgz |
| @smithy/core | 3.31.1 | Apache-2.0 | registry.npmjs.org/@smithy/core/-/core-3.31.1.tgz |
| @smithy/credential-provider-imds | 4.4.16 | Apache-2.0 | registry.npmjs.org/@smithy/credential-provider-imds/-/credential-provider-imds-4.4.16.tgz |
| @smithy/fetch-http-handler | 5.6.13 | Apache-2.0 | registry.npmjs.org/@smithy/fetch-http-handler/-/fetch-http-handler-5.6.13.tgz |
| @smithy/is-array-buffer | 2.2.0 | Apache-2.0 | registry.npmjs.org/@smithy/is-array-buffer/-/is-array-buffer-2.2.0.tgz |
| @smithy/node-http-handler | 4.7.3 | Apache-2.0 | registry.npmjs.org/@smithy/node-http-handler/-/node-http-handler-4.7.3.tgz |
| @smithy/node-http-handler | 4.9.13 | Apache-2.0 | registry.npmjs.org/@smithy/node-http-handler/-/node-http-handler-4.9.13.tgz |
| @smithy/node-http-handler | 4.9.13 | Apache-2.0 | registry.npmjs.org/@smithy/node-http-handler/-/node-http-handler-4.9.13.tgz |
| @smithy/signature-v4 | 5.6.12 | Apache-2.0 | registry.npmjs.org/@smithy/signature-v4/-/signature-v4-5.6.12.tgz |
| @smithy/types | 4.16.1 | Apache-2.0 | registry.npmjs.org/@smithy/types/-/types-4.16.1.tgz |
| @smithy/util-buffer-from | 2.2.0 | Apache-2.0 | registry.npmjs.org/@smithy/util-buffer-from/-/util-buffer-from-2.2.0.tgz |
| @smithy/util-utf8 | 2.3.0 | Apache-2.0 | registry.npmjs.org/@smithy/util-utf8/-/util-utf8-2.3.0.tgz |
| @types/node | 26.1.2 | MIT | registry.npmjs.org/@types/node/-/node-26.1.2.tgz |
| @types/retry | 0.12.0 | MIT | registry.npmjs.org/@types/retry/-/retry-0.12.0.tgz |
| agent-base | 7.1.4 | MIT | registry.npmjs.org/agent-base/-/agent-base-7.1.4.tgz |
| base64-js | 1.5.1 | MIT | registry.npmjs.org/base64-js/-/base64-js-1.5.1.tgz |
| bignumber.js | 9.3.1 | MIT | registry.npmjs.org/bignumber.js/-/bignumber.js-9.3.1.tgz |
| bowser | 2.14.1 | MIT | registry.npmjs.org/bowser/-/bowser-2.14.1.tgz |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause | registry.npmjs.org/buffer-equal-constant-time/-/buffer-equal-constant-time-1.0.1.tgz |
| data-uri-to-buffer | 4.0.1 | MIT | registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz |
| debug | 4.4.3 | MIT | registry.npmjs.org/debug/-/debug-4.4.3.tgz |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 | registry.npmjs.org/ecdsa-sig-formatter/-/ecdsa-sig-formatter-1.0.11.tgz |
| extend | 3.0.2 | MIT | registry.npmjs.org/extend/-/extend-3.0.2.tgz |
| fetch-blob | 3.2.0 | MIT | registry.npmjs.org/fetch-blob/-/fetch-blob-3.2.0.tgz |
| formdata-polyfill | 4.0.10 | MIT | registry.npmjs.org/formdata-polyfill/-/formdata-polyfill-4.0.10.tgz |
| gaxios | 7.3.0 | Apache-2.0 | registry.npmjs.org/gaxios/-/gaxios-7.3.0.tgz |
| gcp-metadata | 8.1.2 | Apache-2.0 | registry.npmjs.org/gcp-metadata/-/gcp-metadata-8.1.2.tgz |
| google-auth-library | 10.9.1 | Apache-2.0 | registry.npmjs.org/google-auth-library/-/google-auth-library-10.9.1.tgz |
| google-logging-utils | 1.1.3 | Apache-2.0 | registry.npmjs.org/google-logging-utils/-/google-logging-utils-1.1.3.tgz |
| http-proxy-agent | 7.0.2 | MIT | registry.npmjs.org/http-proxy-agent/-/http-proxy-agent-7.0.2.tgz |
| https-proxy-agent | 7.0.6 | MIT | registry.npmjs.org/https-proxy-agent/-/https-proxy-agent-7.0.6.tgz |
| json-bigint | 1.0.0 | MIT | registry.npmjs.org/json-bigint/-/json-bigint-1.0.0.tgz |
| json-schema-to-ts | 3.1.1 | MIT | registry.npmjs.org/json-schema-to-ts/-/json-schema-to-ts-3.1.1.tgz |
| jwa | 2.0.1 | MIT | registry.npmjs.org/jwa/-/jwa-2.0.1.tgz |
| jws | 4.0.1 | MIT | registry.npmjs.org/jws/-/jws-4.0.1.tgz |
| long | 5.3.2 | Apache-2.0 | registry.npmjs.org/long/-/long-5.3.2.tgz |
| ms | 2.1.3 | MIT | registry.npmjs.org/ms/-/ms-2.1.3.tgz |
| node-domexception | 1.0.0 | MIT | registry.npmjs.org/node-domexception/-/node-domexception-1.0.0.tgz |
| node-fetch | 3.3.2 | MIT | registry.npmjs.org/node-fetch/-/node-fetch-3.3.2.tgz |
| openai | 6.26.0 | Apache-2.0 | registry.npmjs.org/openai/-/openai-6.26.0.tgz |
| p-retry | 4.6.2 | MIT | registry.npmjs.org/p-retry/-/p-retry-4.6.2.tgz |
| partial-json | 0.1.7 | MIT | registry.npmjs.org/partial-json/-/partial-json-0.1.7.tgz |
| protobufjs | 7.6.5 | BSD-3-Clause | registry.npmjs.org/protobufjs/-/protobufjs-7.6.5.tgz |
| retry | 0.13.1 | MIT | registry.npmjs.org/retry/-/retry-0.13.1.tgz |
| safe-buffer | 5.2.1 | MIT | registry.npmjs.org/safe-buffer/-/safe-buffer-5.2.1.tgz |
| ts-algebra | 2.0.0 | MIT | registry.npmjs.org/ts-algebra/-/ts-algebra-2.0.0.tgz |
| tslib | 2.8.1 | 0BSD | registry.npmjs.org/tslib/-/tslib-2.8.1.tgz |
| typebox | 1.3.7 | MIT | registry.npmjs.org/typebox/-/typebox-1.3.7.tgz |
| undici-types | 8.3.0 | MIT | registry.npmjs.org/undici-types/-/undici-types-8.3.0.tgz |
| web-streams-polyfill | 3.3.3 | MIT | registry.npmjs.org/web-streams-polyfill/-/web-streams-polyfill-3.3.3.tgz |
| ws | 8.21.1 | MIT | registry.npmjs.org/ws/-/ws-8.21.1.tgz |
| zod | 4.4.3 | MIT | registry.npmjs.org/zod/-/zod-4.4.3.tgz |
| zod-to-json-schema | 3.25.2 | ISC | registry.npmjs.org/zod-to-json-schema/-/zod-to-json-schema-3.25.2.tgz |

Unknown declared licenses across the whole resolution: **0**.

Required attribution if these packages are ever redistributed with AegisFlow:
retain each package's own license and copyright notice (MIT, ISC, BSD-3-Clause,
0BSD), and additionally propagate each Apache-2.0 package's `NOTICE` file if
one exists.

## OPTIONAL INTEGRATION — not installed, not declared, never redistributed

| Component | License | Status |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | MIT | Optional peer: the Pi agent CLI that AegisFlow's Pi extension integrates with. Declared under `peerDependencies` with `optional: true`; supplied by the operator's own installation. AegisFlow redistributes none of it — the extension imports the host's types and executes the host's CLI. |
| Temporal TypeScript SDK (`@temporalio/*`) | MIT | **Not a dependency of this repository.** It was used in a one-off durability evaluation that compared an external workflow engine against AegisFlow's in-process durable layer. That evaluation harness is internal operational tooling and is not part of the published tree; no source file imports it, and it is deliberately absent from `dependencies`, `optionalDependencies` and the lockfile. The comparison's conclusion (keep the in-process layer) is summarised in `docs/durable-execution.md`. |
| Restate (`@restatedev/restate-server`) | BSL (source-available, non-OSI) | **Evaluated and rejected.** Recorded only so the evaluation is not mistaken for a dependency: the candidate was eliminated by AegisFlow's own gate (a default phone-home analytics dependency plus a non-OSI licence) and was never adopted, bundled or declared. |

## EXTERNAL TOOL — executed by the operator, never bundled

| Tool | Role | Distribution |
| --- | --- | --- |
| `pi` (Pi coding agent CLI) | The agent runtime AegisFlow drives; its runtime identity and tool vocabulary are pinned by the admission contract, and it is launched as a subprocess. | Installed and licensed by the operator. |
| Colima + Docker | Sandbox runtime for isolated task containers. AegisFlow invokes the CLIs; it does not ship them, nor any image but a pinned public `alpine` digest reference. | Installed and licensed by the operator. |
| `git`, `gh` | Repository operations and (optionally) GitHub API access from operator-run scripts. | Installed and licensed by the operator. |

## NETWORK SERVICE — contacted at runtime, no code exchanged

| Service | Role |
| --- | --- |
| Model provider APIs reachable through `pi-ai` (for example Anthropic, OpenAI, Google, Mistral, AWS Bedrock, DeepSeek, Z.ai/GLM, or an operator-run gateway) | Inference. Credentials are supplied by the operator through the environment or the provider CLI's own auth store; no credential is stored in this repository. |
| GitHub (`github.com`) | Repository hosting and the operator's push/review workflow. |

Any operator-configured endpoint (for example an internal model gateway) is a
deployment choice; it is not a dependency of this repository.

## Trademarks and endorsement

All third-party names, product names, and marks referenced in this repository
or in its documentation — including but not limited to Pi, pi-ai, Anthropic,
Claude, OpenAI, GPT, Google, Gemini, Mistral, DeepSeek, Z.ai, GLM, Amazon Web
Services, Bedrock, Temporal, Restate, Docker, Colima, GitHub, and Node.js —
are the property of their respective owners.

They are used for identification purposes only. AegisFlow is an independent
project: it is **not affiliated with, sponsored by, certified by, or endorsed
by** any of these owners, and no statement in this repository should be read
as claiming otherwise. AegisFlow is not an official integration of any provider
unless a provider states so separately.
