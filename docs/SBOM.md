# Software Bill of Materials (SBOM)

**Generated**: 2026-02-20
**Tool**: syft v1.42.1 (Anchore) + pnpm licenses + pnpm audit
**Format**: Human-readable summary with full inventory. Machine-readable CycloneDX JSON available via `syft dir:. -o cyclonedx-json`.
**Scope**: All workspace packages (8 package.json files, pnpm monorepo)

---

## Summary

| Metric | Value |
|--------|-------|
| Total resolved packages | 877 |
| Unique package names (syft) | 1,051 (includes GHA action versions) |
| Direct runtime dependencies | 58 |
| Direct dev dependencies | 35 |
| Workspace packages | 8 |
| Known vulnerabilities | 12 (1 critical, 6 high, 2 moderate, 3 low) |
| Packages with multiple versions | 30+ |
| License types | 16 |
| Copyleft-licensed packages | 3 |
| Unknown-licensed packages | 1 |

---

## Direct Dependencies by Workspace Package

### @browser-hitl/api (29 runtime, 13 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| @nestjs/common | ^10.4.15 | NestJS core framework |
| @nestjs/core | ^10.4.15 | NestJS core framework |
| @nestjs/jwt | ^10.2.0 | JWT authentication |
| @nestjs/passport | ^10.0.3 | Passport.js integration |
| @nestjs/platform-express | ^10.4.15 | Express HTTP adapter |
| @nestjs/platform-ws | ^10.4.15 | WebSocket adapter |
| @nestjs/schedule | ^4.1.2 | Cron/scheduled tasks |
| @nestjs/swagger | ^11.2.6 | OpenAPI documentation |
| @nestjs/throttler | ^6.3.0 | Rate limiting |
| @nestjs/typeorm | ^10.0.2 | TypeORM integration |
| @nestjs/websockets | ^10.4.15 | WebSocket gateway |
| @novnc/novnc | 1.5.0 | VNC web client |
| bcryptjs | ^3.0.3 | Password hashing |
| class-transformer | ^0.5.1 | DTO transformation |
| class-validator | ^0.14.1 | DTO validation |
| helmet | ^8.1.0 | Security headers |
| ioredis | ^5.4.2 | Redis client |
| minio | ^8.0.4 | S3-compatible object storage |
| nats | ^2.28.3 | NATS JetStream messaging |
| passport | ^0.7.0 | Authentication middleware |
| passport-jwt | ^4.0.1 | JWT passport strategy |
| passport-local | ^1.0.0 | Local passport strategy |
| pg | ^8.13.1 | PostgreSQL driver |
| prom-client | ^15.1.3 | Prometheus metrics |
| reflect-metadata | ^0.2.2 | TypeScript decorators |
| rxjs | ^7.8.1 | Reactive extensions |
| typeorm | ^0.3.20 | ORM |
| uuid | ^11.0.5 | UUID generation |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/controller (12 runtime, 8 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| @kubernetes/client-node | ^1.0.0 | Kubernetes API client |
| @nestjs/common | ^10.4.15 | NestJS framework |
| @nestjs/core | ^10.4.15 | NestJS framework |
| @nestjs/platform-express | ^10.4.15 | Express adapter |
| @nestjs/schedule | ^4.1.2 | Scheduled reconcile loop |
| @nestjs/typeorm | ^10.0.2 | TypeORM integration |
| nats | ^2.28.3 | NATS messaging |
| pg | ^8.13.1 | PostgreSQL driver |
| reflect-metadata | ^0.2.2 | Decorators |
| rxjs | ^7.8.1 | Reactive extensions |
| typeorm | ^0.3.20 | ORM |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/worker (7 runtime, 7 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| express | ^4.21.2 | Health HTTP server |
| ioredis | ^5.4.2 | Redis (OTP relay) |
| minio | ^8.0.4 | Artifact upload |
| nats | ^2.28.3 | Event publishing |
| pg | ^8.13.1 | Session state queries |
| playwright | 1.50.0 | Browser automation |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/slack-bot (3 runtime, 2 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| @slack/bolt | ^3.18.0 | Slack app framework |
| nats | ^2.28.3 | Event subscription |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/teams-bot (3 runtime, 2 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| botbuilder | ^4.23.3 | Teams Bot Framework |
| nats | ^2.28.3 | Event subscription |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/admin-ui (4 runtime, 3 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| next | ^15.1.6 | React framework |
| react | ^19.0.0 | UI library |
| react-dom | ^19.0.0 | DOM renderer |
| @browser-hitl/shared | workspace:* | Shared types/constants |

### @browser-hitl/shared (0 runtime, 5 dev)

Pure TypeScript types, constants, and validators. No runtime dependencies.

### Root workspace (0 runtime, 4 dev)

| Package | Version | Purpose |
|---------|---------|---------|
| husky | ^9.1.7 | Git hooks |
| lint-staged | ^16.2.7 | Pre-commit linting |
| nx | ^21.1.3 | Monorepo orchestration |
| typescript | ^5.7.3 | TypeScript compiler |

---

## License Distribution

| License | Count | Percentage | Category |
|---------|-------|------------|----------|
| MIT | 743 | 84.7% | Permissive |
| ISC | 38 | 4.3% | Permissive |
| Apache-2.0 | 37 | 4.2% | Permissive |
| BSD-3-Clause | 24 | 2.7% | Permissive |
| BSD-2-Clause | 17 | 1.9% | Permissive |
| Unlicense | 4 | 0.5% | Public domain |
| BlueOak-1.0.0 | 4 | 0.5% | Permissive |
| LGPL-3.0-or-later | 2 | 0.2% | Weak copyleft |
| MPL-2.0 | 1 | 0.1% | Weak copyleft |
| (Unlicense OR Apache-2.0) | 1 | 0.1% | Permissive (dual) |
| Python-2.0 | 1 | 0.1% | Permissive |
| CC-BY-4.0 | 1 | 0.1% | Permissive (data) |
| Unknown | 1 | 0.1% | Unclassified |
| (MIT AND BSD-3-Clause) | 1 | 0.1% | Permissive |
| 0BSD | 1 | 0.1% | Permissive |
| (MIT OR CC0-1.0) | 1 | 0.1% | Permissive (dual) |

### Copyleft / Restrictive License Packages

| Package | Version | License | Risk | Notes |
|---------|---------|---------|------|-------|
| @img/sharp-libvips-linux-x64 | 1.2.4 | LGPL-3.0-or-later | Low | Native image library binary; dynamically linked. LGPL permits dynamic linking without copyleft propagation. Transitive dependency of `sharp` (pulled by `next`). |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | LGPL-3.0-or-later | Low | Same as above, musl variant. |
| @novnc/novnc | 1.5.0 | MPL-2.0 | Medium | VNC web client. MPL-2.0 is file-level copyleft — modifications to noVNC source files must be shared under MPL-2.0, but surrounding code is unaffected. This is a direct dependency of the API package used for VNC streaming. |

### Unknown License Package

| Package | Version | Notes |
|---------|---------|-------|
| pause | 0.0.1 | Tiny stream pause utility by TJ Holowaychuk. No LICENSE file in package. Likely MIT (author's standard license). Transitive dependency via Express. |

---

## Known Vulnerabilities

**Scan date**: 2026-02-20
**Source**: pnpm audit (npm advisory database)
**Total**: 12 findings (1 critical, 6 high, 2 moderate, 3 low)

### Critical (1)

| Package | Version | Advisory | Path | Impact |
|---------|---------|----------|------|--------|
| fast-xml-parser | >=4.1.3 <5.3.5 | [GHSA-m7jm-9gc2-mpf2](https://github.com/advisories/GHSA-m7jm-9gc2-mpf2) | api > minio > fast-xml-parser | Entity encoding bypass via regex injection in DOCTYPE entity names. Affects XML parsing in MinIO client. |

### High (6)

| Package | Version | Advisory | Path | Impact |
|---------|---------|----------|------|--------|
| playwright | <1.55.1 | [GHSA-7mvr-c777-76hp](https://github.com/advisories/GHSA-7mvr-c777-76hp) | worker > playwright | SSL certificate not verified during browser download. Build-time risk only. |
| glob | >=10.2.0 <10.5.0 | [GHSA-5j98-mcp5-4vw2](https://github.com/advisories/GHSA-5j98-mcp5-4vw2) | api > @nestjs/cli > glob | Command injection via -c/--cmd flag. Dev-only CLI tool. |
| fast-xml-parser | >=4.1.3 <5.3.6 | [GHSA-jmr7-xgp7-cmfj](https://github.com/advisories/GHSA-jmr7-xgp7-cmfj) | api > minio > fast-xml-parser | DoS via entity expansion in DOCTYPE (no expansion limit). |
| minimatch | >=9.0.0 <9.0.5 | [GHSA-pppg-cpjq-h7pm](https://github.com/advisories/GHSA-pppg-cpjq-h7pm) | api > @nestjs/cli > minimatch | ReDoS via repeated wildcards. Dev-only CLI tool. |
| ajv | >=6.0.0 <6.12.6 | [GHSA-jqhg-jcr4-r42h](https://github.com/advisories/GHSA-jqhg-jcr4-r42h) | api > @nestjs/cli > ... > ajv | Prototype pollution. Dev-only transitive. |
| minimatch | <3.0.5 | [GHSA-hmwf-3rmh-h4r3](https://github.com/advisories/GHSA-hmwf-3rmh-h4r3) | api > @nestjs/cli > ... > minimatch | ReDoS via brace expansion. Dev-only transitive. |

### Moderate (2)

| Package | Version | Advisory | Path | Impact |
|---------|---------|----------|------|--------|
| ajv | >=7.0.0-alpha.0 <8.18.0 | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | api > @nestjs/cli > ... > ajv | ReDoS when using `$data` option. Dev-only transitive. |
| ajv | >=7.0.0-alpha.0 <8.18.0 | [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | api > @nestjs/cli > @angular-devkit/core > ajv | Same as above, different path. |

### Low (3)

| Package | Version | Advisory | Path | Impact |
|---------|---------|----------|------|--------|
| tmp | <=0.2.3 | [GHSA-52f5-9888-hmc6](https://github.com/advisories/GHSA-52f5-9888-hmc6) | api > @nestjs/cli > ... > tmp | Symlink dir write. Dev-only. |
| webpack | >=5.49.0 <=5.104.0 | [GHSA-8fgc-7cc6-rx7x](https://github.com/advisories/GHSA-8fgc-7cc6-rx7x) | api > @nestjs/cli > webpack | SSRF via URL userinfo in buildHttp. Build-time only. |
| webpack | >=5.49.0 <5.104.0 | [GHSA-38r7-794h-5758](https://github.com/advisories/GHSA-38r7-794h-5758) | api > @nestjs/cli > webpack | SSRF via HTTP redirects in buildHttp. Build-time only. |

---

## Multi-Version Packages (Top 15)

Packages resolved to multiple versions, indicating dependency conflicts or version range mismatches.

| Package | Versions Installed | Notes |
|---------|--------------------|-------|
| uuid | 8.3.2, 9.0.1, 10.0.0, 11.0.3, 11.1.0 | 5 versions. Direct dep is ^11.0.5. Transitive deps pull older majors. |
| wrap-ansi | 6.2.0, 7.0.0, 8.1.0, 9.0.2 | 4 versions. CLI formatting libraries. |
| string-width | 4.2.3, 5.1.2, 7.2.0, 8.2.0 | 4 versions. Terminal output formatting. |
| @types/jsonwebtoken | 8.5.9, 9.0.5, 9.0.6, 9.0.10 | 4 versions. Type definitions only. |
| ws | 7.5.10, 8.18.0, 8.19.0 | 3 versions. WebSocket library. |
| @types/node | 22.19.11, 24.10.13, 25.2.3 | 3 versions. Type definitions. |
| emoji-regex | 8.0.0, 9.2.2, 10.6.0 | 3 versions. String width calculation. |
| commander | 2.20.3, 4.1.1, 14.0.3 | 3 versions. CLI argument parsing. |
| ajv | 6.12.6, 8.12.0, 8.18.0 | 3 versions. JSON schema validation. |
| ansi-styles | 4.3.0, 5.2.0, 6.2.3 | 3 versions. Terminal styling. |
| minimatch | 3.1.2, 9.0.3, 9.0.5 | 3 versions. Glob matching. |
| glob | 7.2.3, 10.4.5, 10.5.0 | 3 versions. File globbing. |
| path-to-regexp | 0.1.12, 3.3.0, 8.3.0 | 3 versions. Express route matching. |
| eventemitter3 | 3.1.2, 4.0.7, 5.0.4 | 3 versions. Event emitter. |
| jsonc-parser | 3.2.0, 3.2.1, 3.3.1 | 3 versions. JSONC parsing. |

---

## Full Package Inventory (877 packages)

| Package | Version(s) | License |
|---------|-----------|---------|
| @angular-devkit/core | 17.3.11 | MIT |
| @angular-devkit/schematics | 17.3.11 | MIT |
| @angular-devkit/schematics-cli | 17.3.11 | MIT |
| @azure/abort-controller | 2.1.2 | MIT |
| @azure/core-auth | 1.10.1 | MIT |
| @azure/core-client | 1.10.1 | MIT |
| @azure/core-http-compat | 2.3.2 | MIT |
| @azure/core-rest-pipeline | 1.22.2 | MIT |
| @azure/core-tracing | 1.3.1 | MIT |
| @azure/core-util | 1.13.1 | MIT |
| @azure/identity | 4.13.0 | MIT |
| @azure/logger | 1.3.0 | MIT |
| @azure/msal-browser | 4.28.2 | MIT |
| @azure/msal-common | 14.16.1, 15.14.2 | MIT |
| @azure/msal-node | 2.16.3, 3.8.7 | MIT |
| @babel/code-frame | 7.29.0 | MIT |
| @babel/compat-data | 7.29.0 | MIT |
| @babel/core | 7.29.0 | MIT |
| @babel/generator | 7.29.1 | MIT |
| @babel/helper-compilation-targets | 7.28.6 | MIT |
| @babel/helper-globals | 7.28.0 | MIT |
| @babel/helper-module-imports | 7.28.6 | MIT |
| @babel/helper-module-transforms | 7.28.6 | MIT |
| @babel/helper-plugin-utils | 7.28.6 | MIT |
| @babel/helper-string-parser | 7.27.1 | MIT |
| @babel/helper-validator-identifier | 7.28.5 | MIT |
| @babel/helper-validator-option | 7.27.1 | MIT |
| @babel/helpers | 7.28.6 | MIT |
| @babel/parser | 7.29.0 | MIT |
| @babel/plugin-syntax-async-generators | 7.8.4 | MIT |
| @babel/plugin-syntax-bigint | 7.8.3 | MIT |
| @babel/plugin-syntax-class-properties | 7.12.13 | MIT |
| @babel/plugin-syntax-class-static-block | 7.14.5 | MIT |
| @babel/plugin-syntax-import-attributes | 7.28.6 | MIT |
| @babel/plugin-syntax-import-meta | 7.10.4 | MIT |
| @babel/plugin-syntax-json-strings | 7.8.3 | MIT |
| @babel/plugin-syntax-jsx | 7.28.6 | MIT |
| @babel/plugin-syntax-logical-assignment-operators | 7.10.4 | MIT |
| @babel/plugin-syntax-nullish-coalescing-operator | 7.8.3 | MIT |
| @babel/plugin-syntax-numeric-separator | 7.10.4 | MIT |
| @babel/plugin-syntax-object-rest-spread | 7.8.3 | MIT |
| @babel/plugin-syntax-optional-catch-binding | 7.8.3 | MIT |
| @babel/plugin-syntax-optional-chaining | 7.8.3 | MIT |
| @babel/plugin-syntax-private-property-in-object | 7.14.5 | MIT |
| @babel/plugin-syntax-top-level-await | 7.14.5 | MIT |
| @babel/plugin-syntax-typescript | 7.28.6 | MIT |
| @babel/template | 7.28.6 | MIT |
| @babel/traverse | 7.29.0 | MIT |
| @babel/types | 7.29.0 | MIT |
| @bcoe/v8-coverage | 0.2.3 | MIT |
| @borewit/text-codec | 0.2.1 | MIT |
| @colors/colors | 1.5.0 | MIT |
| @cspotcode/source-map-support | 0.8.1 | MIT |
| @emnapi/core | 1.8.1 | MIT |
| @emnapi/runtime | 1.8.1 | MIT |
| @emnapi/wasi-threads | 1.1.0 | MIT |
| @img/colour | 1.0.0 | MIT |
| @img/sharp-libvips-linux-x64 | 1.2.4 | LGPL-3.0-or-later |
| @img/sharp-libvips-linuxmusl-x64 | 1.2.4 | LGPL-3.0-or-later |
| @img/sharp-linux-x64 | 0.34.5 | Apache-2.0 |
| @img/sharp-linuxmusl-x64 | 0.34.5 | Apache-2.0 |
| @ioredis/commands | 1.5.0 | MIT |
| @isaacs/cliui | 8.0.2 | ISC |
| @istanbuljs/load-nyc-config | 1.1.0 | ISC |
| @istanbuljs/schema | 0.1.3 | MIT |
| @jest/console | 29.7.0 | MIT |
| @jest/core | 29.7.0 | MIT |
| @jest/diff-sequences | 30.0.1 | MIT |
| @jest/environment | 29.7.0 | MIT |
| @jest/expect | 29.7.0 | MIT |
| @jest/expect-utils | 29.7.0 | MIT |
| @jest/fake-timers | 29.7.0 | MIT |
| @jest/get-type | 30.1.0 | MIT |
| @jest/globals | 29.7.0 | MIT |
| @jest/reporters | 29.7.0 | MIT |
| @jest/schemas | 29.6.3, 30.0.5 | MIT |
| @jest/source-map | 29.6.3 | MIT |
| @jest/test-result | 29.7.0 | MIT |
| @jest/test-sequencer | 29.7.0 | MIT |
| @jest/transform | 29.7.0 | MIT |
| @jest/types | 29.6.3 | MIT |
| @jridgewell/gen-mapping | 0.3.13 | MIT |
| @jridgewell/remapping | 2.3.5 | MIT |
| @jridgewell/resolve-uri | 3.1.2 | MIT |
| @jridgewell/source-map | 0.3.11 | MIT |
| @jridgewell/sourcemap-codec | 1.5.5 | MIT |
| @jridgewell/trace-mapping | 0.3.9, 0.3.31 | MIT |
| @jsep-plugin/assignment | 1.3.0 | MIT |
| @jsep-plugin/regex | 1.0.4 | MIT |
| @kubernetes/client-node | 1.4.0 | Apache-2.0 |
| @ljharb/through | 2.3.14 | MIT |
| @lukeed/csprng | 1.1.0 | MIT |
| @microsoft/tsdoc | 0.16.0 | MIT |
| @napi-rs/wasm-runtime | 0.2.4 | MIT |
| @nestjs/cli | 10.4.9 | MIT |
| @nestjs/common | 10.4.22 | MIT |
| @nestjs/core | 10.4.22 | MIT |
| @nestjs/jwt | 10.2.0 | MIT |
| @nestjs/mapped-types | 2.1.0 | MIT |
| @nestjs/passport | 10.0.3 | MIT |
| @nestjs/platform-express | 10.4.22 | MIT |
| @nestjs/platform-ws | 10.4.22 | MIT |
| @nestjs/schedule | 4.1.2 | MIT |
| @nestjs/schematics | 10.2.3 | MIT |
| @nestjs/swagger | 11.2.6 | MIT |
| @nestjs/testing | 10.4.22 | MIT |
| @nestjs/throttler | 6.5.0 | MIT |
| @nestjs/typeorm | 10.0.2 | MIT |
| @nestjs/websockets | 10.4.22 | MIT |
| @next/env | 15.5.12 | MIT |
| @next/swc-linux-x64-gnu | 15.5.12 | MIT |
| @next/swc-linux-x64-musl | 15.5.12 | MIT |
| @novnc/novnc | 1.5.0 | MPL-2.0 |
| @nuxtjs/opencollective | 0.3.2 | MIT |
| @nx/nx-linux-x64-gnu | 21.6.10 | MIT |
| @nx/nx-linux-x64-musl | 21.6.10 | MIT |
| @opentelemetry/api | 1.9.0 | Apache-2.0 |
| @pkgjs/parseargs | 0.11.0 | MIT |
| @scarf/scarf | 1.4.0 | Apache-2.0 |
| @sinclair/typebox | 0.27.10, 0.34.48 | MIT |
| @sinonjs/commons | 3.0.1 | BSD-3-Clause |
| @sinonjs/fake-timers | 10.3.0 | BSD-3-Clause |
| @slack/bolt | 3.22.0 | MIT |
| @slack/logger | 3.0.0, 4.0.0 | MIT |
| @slack/oauth | 2.6.3 | MIT |
| @slack/socket-mode | 1.3.6 | MIT |
| @slack/types | 2.20.0 | MIT |
| @slack/web-api | 6.13.0 | MIT |
| @sqltools/formatter | 1.2.5 | MIT |
| @swc/helpers | 0.5.15 | Apache-2.0 |
| @tokenizer/inflate | 0.2.7 | MIT |
| @tokenizer/token | 0.3.0 | MIT |
| @tsconfig/node10 | 1.0.12 | MIT |
| @tsconfig/node12 | 1.0.11 | MIT |
| @tsconfig/node14 | 1.0.3 | MIT |
| @tsconfig/node16 | 1.0.4 | MIT |
| @tybys/wasm-util | 0.9.0 | MIT |
| @types/babel__core | 7.20.5 | MIT |
| @types/babel__generator | 7.27.0 | MIT |
| @types/babel__template | 7.4.4 | MIT |
| @types/babel__traverse | 7.28.0 | MIT |
| @types/bcrypt | 5.0.2 | MIT |
| @types/bcryptjs | 3.0.0 | MIT |
| @types/body-parser | 1.19.6 | MIT |
| @types/connect | 3.4.38 | MIT |
| @types/eslint | 9.6.1 | MIT |
| @types/eslint-scope | 3.7.7 | MIT |
| @types/estree | 1.0.8 | MIT |
| @types/express | 4.17.25, 5.0.6 | MIT |
| @types/express-serve-static-core | 4.19.8, 5.1.1 | MIT |
| @types/graceful-fs | 4.1.9 | MIT |
| @types/http-errors | 2.0.5 | MIT |
| @types/is-stream | 1.1.0 | MIT |
| @types/istanbul-lib-coverage | 2.0.6 | MIT |
| @types/istanbul-lib-report | 3.0.3 | MIT |
| @types/istanbul-reports | 3.0.4 | MIT |
| @types/jest | 29.5.14 | MIT |
| @types/js-yaml | 4.0.9 | MIT |
| @types/json-schema | 7.0.15 | MIT |
| @types/jsonwebtoken | 8.5.9, 9.0.5, 9.0.6, 9.0.10 | MIT |
| @types/luxon | 3.4.2 | MIT |
| @types/mime | 1.3.5 | MIT |
| @types/ms | 2.1.0 | MIT |
| @types/node | 22.19.11, 24.10.13, 25.2.3 | MIT |
| @types/node-fetch | 2.6.13 | MIT |
| @types/passport | 1.0.17 | MIT |
| @types/passport-jwt | 4.0.1 | MIT |
| @types/passport-local | 1.0.38 | MIT |
| @types/passport-strategy | 0.2.38 | MIT |
| @types/pg | 8.16.0 | MIT |
| @types/promise.allsettled | 1.0.6 | MIT |
| @types/qs | 6.14.0 | MIT |
| @types/range-parser | 1.2.7 | MIT |
| @types/react | 19.2.14 | MIT |
| @types/react-dom | 19.2.3 | MIT |
| @types/retry | 0.12.0 | MIT |
| @types/send | 0.17.6, 1.2.1 | MIT |
| @types/serve-static | 1.15.10, 2.2.0 | MIT |
| @types/stack-utils | 2.0.3 | MIT |
| @types/stream-buffers | 3.0.8 | MIT |
| @types/tsscmp | 1.0.2 | MIT |
| @types/uuid | 10.0.0 | MIT |
| @types/validator | 13.15.10 | MIT |
| @types/ws | 6.0.4, 7.4.7 | MIT |
| @types/yargs | 17.0.35 | MIT |
| @types/yargs-parser | 21.0.3 | MIT |
| @typespec/ts-http-runtime | 0.3.3 | MIT |
| @webassemblyjs/ast | 1.14.1 | MIT |
| @webassemblyjs/floating-point-hex-parser | 1.13.2 | MIT |
| @webassemblyjs/helper-api-error | 1.13.2 | MIT |
| @webassemblyjs/helper-buffer | 1.14.1 | MIT |
| @webassemblyjs/helper-numbers | 1.13.2 | MIT |
| @webassemblyjs/helper-wasm-bytecode | 1.13.2 | MIT |
| @webassemblyjs/helper-wasm-section | 1.14.1 | MIT |
| @webassemblyjs/ieee754 | 1.13.2 | MIT |
| @webassemblyjs/leb128 | 1.13.2 | Apache-2.0 |
| @webassemblyjs/utf8 | 1.13.2 | MIT |
| @webassemblyjs/wasm-edit | 1.14.1 | MIT |
| @webassemblyjs/wasm-gen | 1.14.1 | MIT |
| @webassemblyjs/wasm-opt | 1.14.1 | MIT |
| @webassemblyjs/wasm-parser | 1.14.1 | MIT |
| @webassemblyjs/wast-printer | 1.14.1 | MIT |
| @xtuc/ieee754 | 1.2.0 | BSD-3-Clause |
| @xtuc/long | 4.2.2 | Apache-2.0 |
| @yarnpkg/lockfile | 1.1.0 | BSD-2-Clause |
| @yarnpkg/parsers | 3.0.2 | BSD-2-Clause |
| @zkochan/js-yaml | 0.0.7 | MIT |
| @zxing/text-encoding | 0.9.0 | (Unlicense OR Apache-2.0) |
| accepts | 1.3.8 | MIT |
| acorn | 8.15.0 | MIT |
| acorn-walk | 8.3.4 | MIT |
| adaptivecards | 1.2.3 | MIT |
| agent-base | 7.1.4 | MIT |
| ajv | 6.12.6, 8.12.0, 8.18.0 | MIT |
| ajv-formats | 2.1.1 | MIT |
| ajv-keywords | 3.5.2, 5.1.0 | MIT |
| ansi-colors | 4.1.3 | MIT |
| ansi-escapes | 4.3.2, 7.3.0 | MIT |
| ansi-regex | 5.0.1, 6.2.2 | MIT |
| ansi-styles | 4.3.0, 5.2.0, 6.2.3 | MIT |
| ansis | 4.2.0 | ISC |
| anymatch | 3.1.3 | ISC |
| app-root-path | 3.1.0 | MIT |
| append-field | 1.0.0 | MIT |
| arg | 4.1.3 | MIT |
| argparse | 1.0.10 | MIT |
| argparse | 2.0.1 | Python-2.0 |
| array-buffer-byte-length | 1.0.2 | MIT |
| array-flatten | 1.1.1 | MIT |
| array-timsort | 1.0.3 | MIT |
| array.prototype.map | 1.0.8 | MIT |
| arraybuffer.prototype.slice | 1.0.4 | MIT |
| async | 3.2.6 | MIT |
| async-function | 1.0.0 | MIT |
| asynckit | 0.4.0 | MIT |
| available-typed-arrays | 1.0.7 | MIT |
| axios | 1.13.5 | MIT |
| b4a | 1.7.5 | Apache-2.0 |
| babel-jest | 29.7.0 | MIT |
| babel-plugin-istanbul | 6.1.1 | BSD-3-Clause |
| babel-plugin-jest-hoist | 29.6.3 | MIT |
| babel-preset-current-node-syntax | 1.2.0 | MIT |
| babel-preset-jest | 29.6.3 | MIT |
| balanced-match | 1.0.2 | MIT |
| bare-events | 2.8.2 | Apache-2.0 |
| bare-fs | 4.5.4 | Apache-2.0 |
| bare-os | 3.6.2 | Apache-2.0 |
| bare-path | 3.0.0 | Apache-2.0 |
| bare-stream | 2.8.0 | Apache-2.0 |
| bare-url | 2.3.2 | Apache-2.0 |
| base64-js | 1.5.1 | MIT |
| base64url | 3.0.1 | MIT |
| baseline-browser-mapping | 2.9.19 | Apache-2.0 |
| bcryptjs | 3.0.3 | BSD-3-Clause |
| binary-extensions | 2.3.0 | MIT |
| bintrees | 1.0.2 | MIT |
| bl | 4.1.0 | MIT |
| block-stream2 | 2.1.0 | MIT |
| body-parser | 1.20.4 | MIT |
| botbuilder | 4.23.3 | MIT |
| botbuilder-core | 4.23.3 | MIT |
| botbuilder-dialogs-adaptive-runtime-core | 4.23.3-preview | MIT |
| botbuilder-stdlib | 4.23.3-internal | MIT |
| botframework-connector | 4.23.3 | MIT |
| botframework-schema | 4.23.3 | MIT |
| botframework-streaming | 4.23.3 | MIT |
| brace-expansion | 1.1.12, 2.0.2 | MIT |
| braces | 3.0.3 | MIT |
| browser-or-node | 2.1.1 | MIT |
| browserslist | 4.28.1 | MIT |
| bs-logger | 0.2.6 | MIT |
| bser | 2.1.1 | Apache-2.0 |
| buffer | 5.7.1, 6.0.3 | MIT |
| buffer-crc32 | 1.0.0 | MIT |
| buffer-equal-constant-time | 1.0.1 | BSD-3-Clause |
| buffer-from | 1.1.2 | MIT |
| bundle-name | 4.1.0 | MIT |
| busboy | 1.6.0 | MIT |
| bytes | 3.1.2 | MIT |
| call-bind | 1.0.8 | MIT |
| call-bind-apply-helpers | 1.0.2 | MIT |
| call-bound | 1.0.4 | MIT |
| callsites | 3.1.0 | MIT |
| camelcase | 5.3.1, 6.3.0 | MIT |
| caniuse-lite | 1.0.30001770 | CC-BY-4.0 |
| chalk | 4.1.2, 5.6.2 | MIT |
| char-regex | 1.0.2 | MIT |
| chardet | 0.7.0 | MIT |
| chokidar | 3.6.0 | MIT |
| chrome-trace-event | 1.0.4 | MIT |
| ci-info | 3.9.0 | MIT |
| cjs-module-lexer | 1.4.3 | MIT |
| class-transformer | 0.5.1 | MIT |
| class-validator | 0.14.3 | MIT |
| cli-cursor | 3.1.0, 5.0.0 | MIT |
| cli-spinners | 2.6.1, 2.9.2 | MIT |
| cli-table3 | 0.6.5 | MIT |
| cli-truncate | 5.1.1 | MIT |
| cli-width | 3.0.0, 4.1.0 | ISC |
| client-only | 0.0.1 | MIT |
| cliui | 8.0.1 | ISC |
| clone | 1.0.4 | MIT |
| cluster-key-slot | 1.1.2 | Apache-2.0 |
| co | 4.6.0 | MIT |
| collect-v8-coverage | 1.0.3 | MIT |
| color-convert | 2.0.1 | MIT |
| color-name | 1.1.4 | MIT |
| colorette | 2.0.20 | MIT |
| combined-stream | 1.0.8 | MIT |
| commander | 2.20.3, 4.1.1, 14.0.3 | MIT |
| comment-json | 4.2.5 | MIT |
| concat-map | 0.0.1 | MIT |
| concat-stream | 2.0.0 | MIT |
| consola | 2.15.3 | MIT |
| content-disposition | 0.5.4 | MIT |
| content-type | 1.0.5 | MIT |
| convert-source-map | 2.0.0 | MIT |
| cookie | 0.7.2 | MIT |
| cookie-signature | 1.0.7 | MIT |
| core-util-is | 1.0.3 | MIT |
| cors | 2.8.5 | MIT |
| cosmiconfig | 8.3.6 | MIT |
| create-jest | 29.7.0 | MIT |
| create-require | 1.1.1 | MIT |
| cron | 3.2.1 | MIT |
| cross-fetch | 4.1.0 | MIT |
| cross-spawn | 7.0.6 | MIT |
| csstype | 3.2.3 | MIT |
| data-view-buffer | 1.0.2 | MIT |
| data-view-byte-length | 1.0.2 | MIT |
| data-view-byte-offset | 1.0.1 | MIT |
| dayjs | 1.11.19 | MIT |
| debug | 2.6.9, 4.4.3 | MIT |
| decode-uri-component | 0.2.2 | MIT |
| dedent | 1.7.1 | MIT |
| deepmerge | 4.3.1 | MIT |
| default-browser | 5.5.0 | MIT |
| default-browser-id | 5.0.1 | MIT |
| defaults | 1.0.4 | MIT |
| define-data-property | 1.1.4 | MIT |
| define-lazy-prop | 2.0.0, 3.0.0 | MIT |
| define-properties | 1.2.1 | MIT |
| delayed-stream | 1.0.0 | MIT |
| denque | 2.1.0 | Apache-2.0 |
| depd | 2.0.0 | MIT |
| dependency-graph | 1.0.0 | MIT |
| destroy | 1.2.0 | MIT |
| detect-libc | 2.1.2 | Apache-2.0 |
| detect-newline | 3.1.0 | MIT |
| diff | 4.0.4 | BSD-3-Clause |
| diff-sequences | 29.6.3 | MIT |
| dom-serializer | 2.0.0 | MIT |
| domelementtype | 2.3.0 | BSD-2-Clause |
| domhandler | 5.0.3 | BSD-2-Clause |
| domutils | 3.2.2 | BSD-2-Clause |
| dotenv | 16.4.7, 16.6.1 | BSD-2-Clause |
| dotenv-expand | 11.0.7 | BSD-2-Clause |
| dunder-proto | 1.0.1 | MIT |
| eastasianwidth | 0.2.0 | MIT |
| ecdsa-sig-formatter | 1.0.11 | Apache-2.0 |
| ee-first | 1.1.1 | MIT |
| electron-to-chromium | 1.5.286 | ISC |
| emittery | 0.13.1 | MIT |
| emoji-regex | 8.0.0, 9.2.2, 10.6.0 | MIT |
| encodeurl | 2.0.0 | MIT |
| end-of-stream | 1.4.5 | MIT |
| enhanced-resolve | 5.19.0 | MIT |
| enquirer | 2.3.6 | MIT |
| entities | 4.5.0 | BSD-2-Clause |
| environment | 1.1.0 | MIT |
| error-ex | 1.3.4 | MIT |
| es-abstract | 1.24.1 | MIT |
| es-array-method-boxes-properly | 1.0.0 | MIT |
| es-define-property | 1.0.1 | MIT |
| es-errors | 1.3.0 | MIT |
| es-get-iterator | 1.1.3 | MIT |
| es-module-lexer | 1.7.0 | MIT |
| es-object-atoms | 1.1.1 | MIT |
| es-set-tostringtag | 2.1.0 | MIT |
| es-to-primitive | 1.3.0 | MIT |
| escalade | 3.2.0 | MIT |
| escape-html | 1.0.3 | MIT |
| escape-string-regexp | 1.0.5, 2.0.0 | MIT |
| eslint-scope | 5.1.1 | BSD-2-Clause |
| esprima | 4.0.1 | BSD-2-Clause |
| esrecurse | 4.3.0 | BSD-2-Clause |
| estraverse | 4.3.0, 5.3.0 | BSD-2-Clause |
| etag | 1.8.1 | MIT |
| eventemitter3 | 3.1.2, 4.0.7, 5.0.4 | MIT |
| events | 3.3.0 | MIT |
| events-universal | 1.0.1 | Apache-2.0 |
| execa | 5.1.1 | MIT |
| exit | 0.1.2 | MIT |
| expect | 29.7.0 | MIT |
| express | 4.22.1 | MIT |
| external-editor | 3.1.0 | MIT |
| fast-deep-equal | 3.1.3 | MIT |
| fast-fifo | 1.3.2 | MIT |
| fast-json-stable-stringify | 2.1.0 | MIT |
| fast-safe-stringify | 2.1.1 | MIT |
| fast-uri | 3.1.0 | BSD-3-Clause |
| fast-xml-parser | 4.5.3 | MIT |
| fb-watchman | 2.0.2 | Apache-2.0 |
| fflate | 0.8.2 | MIT |
| figures | 3.2.0 | MIT |
| file-type | 20.4.1 | MIT |
| filename-reserved-regex | 3.0.0 | MIT |
| filenamify | 6.0.0 | MIT |
| fill-range | 7.1.1 | MIT |
| filter-obj | 1.1.0 | MIT |
| finalhandler | 1.3.2 | MIT |
| find-up | 4.1.0 | MIT |
| finity | 0.5.4 | MIT |
| flat | 5.0.2 | BSD-3-Clause |
| follow-redirects | 1.15.11 | MIT |
| for-each | 0.3.5 | MIT |
| foreground-child | 3.3.1 | ISC |
| fork-ts-checker-webpack-plugin | 9.0.2 | MIT |
| form-data | 2.5.5, 4.0.5 | MIT |
| forwarded | 0.2.0 | MIT |
| fresh | 0.5.2 | MIT |
| front-matter | 4.0.2 | MIT |
| fs-constants | 1.0.0 | MIT |
| fs-extra | 10.1.0, 11.3.3 | MIT |
| fs-monkey | 1.1.0 | Unlicense |
| fs.realpath | 1.0.0 | ISC |
| function-bind | 1.1.2 | MIT |
| function.prototype.name | 1.1.8 | MIT |
| functions-have-names | 1.2.3 | MIT |
| generator-function | 2.0.1 | MIT |
| gensync | 1.0.0-beta.2 | MIT |
| get-caller-file | 2.0.5 | ISC |
| get-east-asian-width | 1.5.0 | MIT |
| get-intrinsic | 1.3.0 | MIT |
| get-package-type | 0.1.0 | MIT |
| get-proto | 1.0.1 | MIT |
| get-stream | 6.0.1 | MIT |
| get-symbol-description | 1.1.0 | MIT |
| glob | 7.2.3, 10.4.5, 10.5.0 | ISC |
| glob-parent | 5.1.2 | ISC |
| glob-to-regexp | 0.4.1 | BSD-2-Clause |
| globalthis | 1.0.4 | MIT |
| gopd | 1.2.0 | MIT |
| graceful-fs | 4.2.11 | ISC |
| handlebars | 4.7.8 | MIT |
| has-bigints | 1.1.0 | MIT |
| has-flag | 4.0.0 | MIT |
| has-own-prop | 2.0.0 | MIT |
| has-property-descriptors | 1.0.2 | MIT |
| has-proto | 1.2.0 | MIT |
| has-symbols | 1.1.0 | MIT |
| has-tostringtag | 1.0.2 | MIT |
| hasown | 2.0.2 | MIT |
| helmet | 8.1.0 | MIT |
| hpagent | 1.2.0 | MIT |
| html-escaper | 2.0.2 | MIT |
| htmlparser2 | 9.1.0 | MIT |
| http-errors | 2.0.1 | MIT |
| http-proxy-agent | 7.0.2 | MIT |
| https-proxy-agent | 7.0.6 | MIT |
| human-signals | 2.1.0 | Apache-2.0 |
| husky | 9.1.7 | MIT |
| iconv-lite | 0.4.24 | MIT |
| ieee754 | 1.2.1 | BSD-3-Clause |
| ignore | 5.3.2 | MIT |
| import-fresh | 3.3.1 | MIT |
| import-local | 3.2.0 | MIT |
| imurmurhash | 0.1.4 | MIT |
| inflight | 1.0.6 | ISC |
| inherits | 2.0.4 | ISC |
| inquirer | 8.2.6, 9.2.15 | MIT |
| internal-slot | 1.1.0 | MIT |
| ioredis | 5.9.3 | MIT |
| ip-address | 10.1.0 | MIT |
| ipaddr.js | 1.9.1, 2.3.0 | MIT |
| is-arguments | 1.2.0 | MIT |
| is-array-buffer | 3.0.5 | MIT |
| is-arrayish | 0.2.1 | MIT |
| is-async-function | 2.1.1 | MIT |
| is-bigint | 1.1.0 | MIT |
| is-binary-path | 2.1.0 | MIT |
| is-boolean-object | 1.2.2 | MIT |
| is-callable | 1.2.7 | MIT |
| is-core-module | 2.16.1 | MIT |
| is-data-view | 1.0.2 | MIT |
| is-date-object | 1.1.0 | MIT |
| is-docker | 2.2.1, 3.0.0 | MIT |
| is-electron | 2.2.2 | MIT |
| is-extglob | 2.1.1 | MIT |
| is-finalizationregistry | 1.1.1 | MIT |
| is-fullwidth-code-point | 3.0.0, 5.1.0 | MIT |
| is-generator-fn | 2.1.0 | MIT |
| is-generator-function | 1.1.2 | MIT |
| is-glob | 4.0.3 | MIT |
| is-inside-container | 1.0.0 | MIT |
| is-interactive | 1.0.0 | MIT |
| is-map | 2.0.3 | MIT |
| is-negative-zero | 2.0.3 | MIT |
| is-number | 7.0.0 | MIT |
| is-number-object | 1.1.1 | MIT |
| is-regex | 1.2.1 | MIT |
| is-set | 2.0.3 | MIT |
| is-shared-array-buffer | 1.0.4 | MIT |
| is-stream | 1.1.0, 2.0.1 | MIT |
| is-string | 1.1.1 | MIT |
| is-symbol | 1.1.1 | MIT |
| is-typed-array | 1.1.15 | MIT |
| is-unicode-supported | 0.1.0 | MIT |
| is-weakmap | 2.0.2 | MIT |
| is-weakref | 1.1.1 | MIT |
| is-weakset | 2.0.4 | MIT |
| is-wsl | 2.2.0, 3.1.1 | MIT |
| isarray | 2.0.5 | MIT |
| isexe | 2.0.0 | ISC |
| isomorphic-ws | 5.0.0 | MIT |
| istanbul-lib-coverage | 3.2.2 | BSD-3-Clause |
| istanbul-lib-instrument | 5.2.1, 6.0.3 | BSD-3-Clause |
| istanbul-lib-report | 3.0.1 | BSD-3-Clause |
| istanbul-lib-source-maps | 4.0.1 | BSD-3-Clause |
| istanbul-reports | 3.2.0 | BSD-3-Clause |
| iterare | 1.2.1 | ISC |
| iterate-iterator | 1.0.2 | MIT |
| iterate-value | 1.0.2 | MIT |
| jackspeak | 3.4.3 | BlueOak-1.0.0 |
| jest | 29.7.0 | MIT |
| jest-changed-files | 29.7.0 | MIT |
| jest-circus | 29.7.0 | MIT |
| jest-cli | 29.7.0 | MIT |
| jest-config | 29.7.0 | MIT |
| jest-diff | 29.7.0, 30.2.0 | MIT |
| jest-docblock | 29.7.0 | MIT |
| jest-each | 29.7.0 | MIT |
| jest-environment-node | 29.7.0 | MIT |
| jest-get-type | 29.6.3 | MIT |
| jest-haste-map | 29.7.0 | MIT |
| jest-leak-detector | 29.7.0 | MIT |
| jest-matcher-utils | 29.7.0 | MIT |
| jest-message-util | 29.7.0 | MIT |
| jest-mock | 29.7.0 | MIT |
| jest-pnp-resolver | 1.2.3 | MIT |
| jest-regex-util | 29.6.3 | MIT |
| jest-resolve | 29.7.0 | MIT |
| jest-resolve-dependencies | 29.7.0 | MIT |
| jest-runner | 29.7.0 | MIT |
| jest-runtime | 29.7.0 | MIT |
| jest-snapshot | 29.7.0 | MIT |
| jest-util | 29.7.0 | MIT |
| jest-validate | 29.7.0 | MIT |
| jest-watcher | 29.7.0 | MIT |
| jest-worker | 27.5.1, 29.7.0 | MIT |
| jose | 6.1.3 | MIT |
| js-tokens | 4.0.0 | MIT |
| js-yaml | 3.14.2, 4.1.1 | MIT |
| jsep | 1.4.0 | MIT |
| jsesc | 3.1.0 | MIT |
| json-parse-even-better-errors | 2.3.1 | MIT |
| json-schema-traverse | 0.4.1, 1.0.0 | MIT |
| json5 | 2.2.3 | MIT |
| jsonc-parser | 3.2.0, 3.2.1, 3.3.1 | MIT |
| jsonfile | 6.2.0 | MIT |
| jsonpath-plus | 10.4.0 | MIT |
| jsonwebtoken | 9.0.2, 9.0.3 | MIT |
| jwa | 1.4.2, 2.0.1 | MIT |
| jws | 3.2.3, 4.0.1 | MIT |
| kleur | 3.0.3 | MIT |
| leven | 3.1.0 | MIT |
| libphonenumber-js | 1.12.37 | MIT |
| lines-and-columns | 1.2.4, 2.0.3 | MIT |
| lint-staged | 16.2.7 | MIT |
| listr2 | 9.0.5 | MIT |
| loader-runner | 4.3.1 | MIT |
| locate-path | 5.0.0 | MIT |
| lodash | 4.17.23 | MIT |
| lodash.defaults | 4.2.0 | MIT |
| lodash.includes | 4.3.0 | MIT |
| lodash.isarguments | 3.1.0 | MIT |
| lodash.isboolean | 3.0.3 | MIT |
| lodash.isinteger | 4.0.4 | MIT |
| lodash.isnumber | 3.0.3 | MIT |
| lodash.isplainobject | 4.0.6 | MIT |
| lodash.isstring | 4.0.1 | MIT |
| lodash.memoize | 4.1.2 | MIT |
| lodash.once | 4.1.1 | MIT |
| log-symbols | 4.1.0 | MIT |
| log-update | 6.1.0 | MIT |
| lru-cache | 5.1.1, 10.4.3 | ISC |
| luxon | 3.5.0 | MIT |
| magic-string | 0.30.8 | MIT |
| make-dir | 4.0.0 | MIT |
| make-error | 1.3.6 | ISC |
| makeerror | 1.0.12 | BSD-3-Clause |
| math-intrinsics | 1.1.0 | MIT |
| media-typer | 0.3.0 | MIT |
| memfs | 3.5.3 | Unlicense |
| merge-descriptors | 1.0.3 | MIT |
| merge-stream | 2.0.0 | MIT |
| methods | 1.1.2 | MIT |
| micromatch | 4.0.8 | MIT |
| mime | 1.6.0 | MIT |
| mime-db | 1.52.0 | MIT |
| mime-types | 2.1.35 | MIT |
| mimic-fn | 2.1.0 | MIT |
| mimic-function | 5.0.1 | MIT |
| minimatch | 3.1.2, 9.0.3, 9.0.5 | ISC |
| minimist | 1.2.8 | MIT |
| minio | 8.0.6 | Apache-2.0 |
| minipass | 7.1.2 | ISC |
| mkdirp | 0.5.6 | MIT |
| ms | 2.0.0, 2.1.3 | MIT |
| multer | 2.0.2 | MIT |
| mute-stream | 0.0.8, 1.0.0 | ISC |
| nano-spawn | 2.0.0 | MIT |
| nanoid | 3.3.11 | MIT |
| nats | 2.29.3 | Apache-2.0 |
| natural-compare | 1.4.0 | MIT |
| negotiator | 0.6.3 | MIT |
| neo-async | 2.6.2 | MIT |
| next | 15.5.12 | MIT |
| nkeys.js | 1.1.0 | Apache-2.0 |
| node-abort-controller | 3.1.1 | MIT |
| node-emoji | 1.11.0 | MIT |
| node-fetch | 2.7.0 | MIT |
| node-int64 | 0.4.0 | MIT |
| node-machine-id | 1.1.12 | MIT |
| node-releases | 2.0.27 | MIT |
| normalize-path | 3.0.0 | MIT |
| npm-run-path | 4.0.1 | MIT |
| nx | 21.6.10 | MIT |
| oauth4webapi | 3.8.5 | MIT |
| object-assign | 4.1.1 | MIT |
| object-hash | 3.0.0 | MIT |
| object-inspect | 1.13.4 | MIT |
| object-keys | 1.1.1 | MIT |
| object.assign | 4.1.7 | MIT |
| on-finished | 2.4.1 | MIT |
| once | 1.4.0 | ISC |
| onetime | 5.1.2, 7.0.0 | MIT |
| open | 8.4.2, 10.2.0 | MIT |
| openid-client | 6.8.2 | MIT |
| openssl-wrapper | 0.3.4 | MIT |
| ora | 5.3.0, 5.4.1 | MIT |
| os-tmpdir | 1.0.2 | MIT |
| own-keys | 1.0.1 | MIT |
| p-finally | 1.0.0 | MIT |
| p-limit | 2.3.0, 3.1.0 | MIT |
| p-locate | 4.1.0 | MIT |
| p-queue | 6.6.2 | MIT |
| p-retry | 4.6.2 | MIT |
| p-timeout | 3.2.0 | MIT |
| p-try | 2.2.0 | MIT |
| package-json-from-dist | 1.0.1 | BlueOak-1.0.0 |
| parent-module | 1.0.1 | MIT |
| parse-json | 5.2.0 | MIT |
| parseurl | 1.3.3 | MIT |
| passport | 0.7.0 | MIT |
| passport-jwt | 4.0.1 | MIT |
| passport-local | 1.0.0 | MIT |
| passport-strategy | 1.0.0 | MIT |
| path-exists | 4.0.0 | MIT |
| path-is-absolute | 1.0.1 | MIT |
| path-key | 3.1.1 | MIT |
| path-parse | 1.0.7 | MIT |
| path-scurry | 1.11.1 | BlueOak-1.0.0 |
| path-to-regexp | 0.1.12, 3.3.0, 8.3.0 | MIT |
| path-type | 4.0.0 | MIT |
| pause | 0.0.1 | Unknown |
| pg | 8.18.0 | MIT |
| pg-cloudflare | 1.3.0 | MIT |
| pg-connection-string | 2.11.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.11.0 | MIT |
| pg-protocol | 1.11.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| picocolors | 1.1.1 | ISC |
| picomatch | 2.3.1, 4.0.1 | MIT |
| pidtree | 0.6.0 | MIT |
| pirates | 4.0.7 | MIT |
| pkg-dir | 4.2.0 | MIT |
| playwright | 1.50.0 | Apache-2.0 |
| playwright-core | 1.50.0 | Apache-2.0 |
| pluralize | 8.0.0 | MIT |
| possible-typed-array-names | 1.1.0 | MIT |
| postcss | 8.4.31 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| pretty-format | 29.7.0, 30.2.0 | MIT |
| prom-client | 15.1.3 | Apache-2.0 |
| promise.allsettled | 1.0.7 | MIT |
| prompts | 2.4.2 | MIT |
| proxy-addr | 2.0.7 | MIT |
| proxy-from-env | 1.1.0 | MIT |
| pump | 3.0.3 | MIT |
| punycode | 2.3.1 | MIT |
| pure-rand | 6.1.0 | MIT |
| qs | 6.14.2 | BSD-3-Clause |
| query-string | 7.1.3 | MIT |
| randombytes | 2.1.0 | MIT |
| range-parser | 1.2.1 | MIT |
| raw-body | 2.5.3 | MIT |
| react | 19.2.4 | MIT |
| react-dom | 19.2.4 | MIT |
| react-is | 18.3.1 | MIT |
| readable-stream | 3.6.2 | MIT |
| readdirp | 3.6.0 | MIT |
| redis-errors | 1.2.0 | MIT |
| redis-parser | 3.0.0 | MIT |
| reflect-metadata | 0.2.2 | Apache-2.0 |
| reflect.getprototypeof | 1.0.10 | MIT |
| regexp.prototype.flags | 1.5.4 | MIT |
| repeat-string | 1.6.1 | MIT |
| require-directory | 2.1.1 | MIT |
| require-from-string | 2.0.2 | MIT |
| resolve | 1.22.11 | MIT |
| resolve-cwd | 3.0.0 | MIT |
| resolve-from | 4.0.0, 5.0.0 | MIT |
| resolve.exports | 2.0.3 | MIT |
| restore-cursor | 3.1.0, 5.1.0 | MIT |
| retry | 0.13.1 | MIT |
| rfc4648 | 1.5.4 | MIT |
| rfdc | 1.4.1 | MIT |
| rsa-pem-from-mod-exp | 0.8.6 | MIT |
| run-applescript | 7.1.0 | MIT |
| run-async | 2.4.1, 3.0.0 | MIT |
| rxjs | 7.8.1, 7.8.2 | Apache-2.0 |
| safe-array-concat | 1.1.3 | MIT |
| safe-buffer | 5.2.1 | MIT |
| safe-push-apply | 1.0.0 | MIT |
| safe-regex-test | 1.1.0 | MIT |
| safer-buffer | 2.1.2 | MIT |
| sax | 1.4.4 | BlueOak-1.0.0 |
| scheduler | 0.27.0 | MIT |
| schema-utils | 3.3.0, 4.3.3 | MIT |
| semver | 6.3.1, 7.7.4 | ISC |
| send | 0.19.2 | MIT |
| serialize-javascript | 6.0.2 | BSD-3-Clause |
| serve-static | 1.16.3 | MIT |
| set-function-length | 1.2.2 | MIT |
| set-function-name | 2.0.2 | MIT |
| set-proto | 1.0.0 | MIT |
| setprototypeof | 1.2.0 | ISC |
| sha.js | 2.4.12 | (MIT AND BSD-3-Clause) |
| sharp | 0.34.5 | Apache-2.0 |
| shebang-command | 2.0.0 | MIT |
| shebang-regex | 3.0.0 | MIT |
| side-channel | 1.1.0 | MIT |
| side-channel-list | 1.0.0 | MIT |
| side-channel-map | 1.0.1 | MIT |
| side-channel-weakmap | 1.0.2 | MIT |
| signal-exit | 3.0.7, 4.1.0 | ISC |
| sisteransi | 1.0.5 | MIT |
| slash | 3.0.0 | MIT |
| slice-ansi | 7.1.2 | MIT |
| smart-buffer | 4.2.0 | MIT |
| socks | 2.8.7 | MIT |
| socks-proxy-agent | 8.0.5 | MIT |
| source-map | 0.6.1, 0.7.4 | BSD-3-Clause |
| source-map-js | 1.2.1 | BSD-3-Clause |
| source-map-support | 0.5.13, 0.5.21 | MIT |
| split-on-first | 1.1.0 | MIT |
| split2 | 4.2.0 | ISC |
| sprintf-js | 1.0.3 | BSD-3-Clause |
| sql-highlight | 6.1.0 | MIT |
| stack-utils | 2.0.6 | MIT |
| standard-as-callback | 2.1.0 | MIT |
| statuses | 2.0.2 | MIT |
| stop-iteration-iterator | 1.1.0 | MIT |
| stream-buffers | 3.0.3 | Unlicense |
| stream-chain | 2.2.5 | BSD-3-Clause |
| stream-json | 1.9.1 | BSD-3-Clause |
| streamsearch | 1.1.0 | MIT |
| streamx | 2.23.0 | MIT |
| strict-uri-encode | 2.0.0 | MIT |
| string-argv | 0.3.2 | MIT |
| string-length | 4.0.2 | MIT |
| string-width | 4.2.3, 5.1.2, 7.2.0, 8.2.0 | MIT |
| string.prototype.trim | 1.2.10 | MIT |
| string.prototype.trimend | 1.0.9 | MIT |
| string.prototype.trimstart | 1.0.8 | MIT |
| string_decoder | 1.3.0 | MIT |
| strip-ansi | 6.0.1, 7.1.2 | MIT |
| strip-bom | 3.0.0, 4.0.0 | MIT |
| strip-final-newline | 2.0.0 | MIT |
| strip-json-comments | 3.1.1 | MIT |
| strnum | 1.1.2 | MIT |
| strtok3 | 10.3.4 | MIT |
| styled-jsx | 5.1.6 | MIT |
| supports-color | 7.2.0, 8.1.1 | MIT |
| supports-preserve-symlinks-flag | 1.0.0 | MIT |
| swagger-ui-dist | 5.31.0 | Apache-2.0 |
| symbol-observable | 4.0.0 | MIT |
| tapable | 2.3.0 | MIT |
| tar-fs | 3.1.1 | MIT |
| tar-stream | 2.2.0, 3.1.7 | MIT |
| tdigest | 0.1.2 | MIT |
| teex | 1.0.1 | MIT |
| terser | 5.46.0 | BSD-2-Clause |
| terser-webpack-plugin | 5.3.16 | MIT |
| test-exclude | 6.0.0 | ISC |
| text-decoder | 1.2.7 | Apache-2.0 |
| through | 2.3.8 | MIT |
| through2 | 4.0.2 | MIT |
| tmp | 0.0.33, 0.2.5 | MIT |
| tmpl | 1.0.5 | BSD-3-Clause |
| to-buffer | 1.2.2 | MIT |
| to-regex-range | 5.0.1 | MIT |
| toidentifier | 1.0.1 | MIT |
| token-types | 6.1.2 | MIT |
| tr46 | 0.0.3 | MIT |
| tree-kill | 1.2.2 | MIT |
| ts-jest | 29.4.6 | MIT |
| ts-node | 10.9.2 | MIT |
| tsconfig-paths | 4.2.0 | MIT |
| tsconfig-paths-webpack-plugin | 4.2.0 | MIT |
| tslib | 2.8.1 | 0BSD |
| tsscmp | 1.0.6 | MIT |
| tweetnacl | 1.0.3 | Unlicense |
| type-detect | 4.0.8 | MIT |
| type-fest | 0.21.3, 4.41.0 | (MIT OR CC0-1.0) |
| type-is | 1.6.18 | MIT |
| typed-array-buffer | 1.0.3 | MIT |
| typed-array-byte-length | 1.0.3 | MIT |
| typed-array-byte-offset | 1.0.4 | MIT |
| typed-array-length | 1.0.7 | MIT |
| typedarray | 0.0.6 | MIT |
| typeorm | 0.3.28 | MIT |
| typescript | 5.7.2, 5.9.3 | Apache-2.0 |
| uglify-js | 3.19.3 | BSD-2-Clause |
| uid | 2.0.2 | MIT |
| uint8array-extras | 1.5.0 | MIT |
| unbox-primitive | 1.1.0 | MIT |
| undici-types | 6.21.0, 7.16.0 | MIT |
| universalify | 2.0.1 | MIT |
| unpipe | 1.0.0 | MIT |
| update-browserslist-db | 1.2.3 | MIT |
| uri-js | 4.4.1 | BSD-2-Clause |
| util | 0.12.5 | MIT |
| util-deprecate | 1.0.2 | MIT |
| utils-merge | 1.0.1 | MIT |
| uuid | 8.3.2, 9.0.1, 10.0.0, 11.0.3, 11.1.0 | MIT |
| v8-compile-cache-lib | 3.0.1 | MIT |
| v8-to-istanbul | 9.3.0 | ISC |
| validator | 13.15.26 | MIT |
| vary | 1.1.2 | MIT |
| walker | 1.0.8 | Apache-2.0 |
| watchpack | 2.5.1 | MIT |
| wcwidth | 1.0.1 | MIT |
| web-encoding | 1.1.5 | MIT |
| webidl-conversions | 3.0.1 | BSD-2-Clause |
| webpack | 5.97.1 | MIT |
| webpack-node-externals | 3.0.0 | MIT |
| webpack-sources | 3.3.4 | MIT |
| whatwg-url | 5.0.0 | MIT |
| which | 2.0.2 | ISC |
| which-boxed-primitive | 1.1.1 | MIT |
| which-builtin-type | 1.2.1 | MIT |
| which-collection | 1.0.2 | MIT |
| which-typed-array | 1.1.20 | MIT |
| wordwrap | 1.0.0 | MIT |
| wrap-ansi | 6.2.0, 7.0.0, 8.1.0, 9.0.2 | MIT |
| wrappy | 1.0.2 | ISC |
| write-file-atomic | 4.0.2 | ISC |
| ws | 7.5.10, 8.18.0, 8.19.0 | MIT |
| wsl-utils | 0.1.0 | MIT |
| xml2js | 0.6.2 | MIT |
| xmlbuilder | 11.0.1 | MIT |
| xtend | 4.0.2 | MIT |
| y18n | 5.0.8 | ISC |
| yallist | 3.1.1 | ISC |
| yaml | 2.8.2 | ISC |
| yargs | 17.7.2 | MIT |
| yargs-parser | 21.1.1 | ISC |
| yn | 3.1.1 | MIT |
| yocto-queue | 0.1.0 | MIT |
| zod | 3.25.76 | MIT |

---

## Regeneration

```bash
# Human-readable table
syft dir:. -o syft-table

# CycloneDX JSON (machine-readable, for CI/CD)
syft dir:. -o cyclonedx-json > sbom-cyclonedx.json

# SPDX JSON
syft dir:. -o spdx-json > sbom-spdx.json

# License audit
pnpm licenses list

# Vulnerability scan
pnpm audit
```
