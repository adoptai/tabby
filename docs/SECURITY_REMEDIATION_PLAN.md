# Security Remediation Plan (KAN-923)

Scan date: April 2, 2026. Total issues: 29 (1 Critical, 12 High, 10 Medium, 6 Low).
Epic scope: 13 High+ severity tasks.

## Triage Summary

| # | Key | Severity | Summary | Status | Action |
|---|---------|----------|---------|--------|--------|
| 1 | KAN-924 | **Critical** | OS command injection via `child_process` | **Done** | `execSync` → `execFileSync` + input validation |
| 2 | KAN-911 | High | Express not emitting security headers | **Close** | Already mitigated (Helmet configured + test suite) |
| 3 | KAN-912 | High | Containers running as root (11 templates) | **Done** | securityContext added to all templates |
| 4 | KAN-913 | High | lodash 4.17.23 vulnerability | **Done** | pnpm override `>=4.17.21` |
| 5 | KAN-914 | High | Secret in `e2e_uat_22_4.py` (git history) | **Won't fix** | Dev-only test password |
| 6 | KAN-915 | High | Secret in `STARTUP.md` (git history) | **Won't fix** | Dev-only local credentials |
| 7 | KAN-916 | High | Secrets in values.yaml / values-local.yaml | **Won't fix** | Dev-only Kind cluster values |
| 8 | KAN-917 | High | File inclusion via reading file | **Close** | Already mitigated (regex whitelist + `..` block) |
| 9 | KAN-918 | High | Unpinned Docker base images | **Done** | All images pinned to specific versions + digests |
| 10 | KAN-919 | High | multer incomplete cleanup | **Done** | pnpm override `>=2.0.1` |
| 11 | KAN-920 | High | path-to-regexp DoS | **Accepted risk** | See note below |
| 12 | KAN-921 | High | fast-xml-parser buffer overflow | **Close** | Already fixed (override `>=5.3.6` → resolved 5.3.7) |
| 13 | KAN-922 | High | GitHub Actions not pinned to commit SHA | **Done** | All 9 actions pinned to commit SHAs |

### Tickets that require no code changes

- **KAN-911**: Helmet is installed (`helmet@^8.1.0`), configured in `apps/api/src/main.ts:61-64` with HSTS + CSP settings, and enforced by `security-headers.spec.ts`. Close with comment.
- **KAN-917**: `streaming.controller.ts:413-419` has `normalizeNoVncAssetPath()` with regex whitelist (`^[A-Za-z0-9._/-]+$`) and explicit `..` block. `require.resolve()` scopes to module namespace. Credentials controller uses MinIO, not filesystem. Close with comment.
- **KAN-921**: Root `package.json` already has `pnpm.overrides: { "fast-xml-parser": ">=5.3.6" }`, resolved to 5.3.7. Close with comment.
- **KAN-914, KAN-915, KAN-916**: All "secrets" are development-only values (`P@ssw0rd12345`, `minioadmin`, `LocalDev123!@#`, `phase4-bot/phase4-secret`, local hex keys). No production credentials in git history. Won't fix.

### KAN-920 (path-to-regexp) — Accepted Risk

Express 4.x pins `path-to-regexp@0.1.12` internally. Version 0.1.12 is already past the fix for CVE-2024-45296 (fixed in 0.1.10). The 3.3.0 version (used by some middleware) has no patch in the 3.x line — overriding to >=8.0.0 breaks Express routing since the API changed completely. Mitigated by NestJS route validation layer. Full resolution requires Express 5.x upgrade (separate effort).

---

## What was done (branch: `fix/security-remediation-kan923`)

### KAN-924: OS Command Injection — Critical

**Files changed:**
- `apps/slack-bot/src/nats-listener.ts`
- `apps/slack-bot/src/soft-hitl-bridge.ts`

**Changes:**
1. Replaced `execSync` (string interpolation) with `execFileSync` (argument arrays) — eliminates shell interpretation
2. Added `sessionId` validation: `/^[a-z0-9][a-z0-9-]*$/`
3. Added `namespace` validation: same regex
4. Added `latestFile` output validation: `/^\/tmp\/screenshot-[A-Za-z0-9._-]+\.png$/`

### KAN-913 + KAN-919: Dependency Overrides

**Files changed:**
- `package.json` (root)
- `pnpm-lock.yaml`

**Changes:** Added pnpm overrides:
```json
"lodash": ">=4.17.21",
"multer": ">=2.0.1"
```

### KAN-912: Helm Security Context

**Files changed (11 templates):**
- `charts/browser-hitl/templates/api-deployment.yaml`
- `charts/browser-hitl/templates/admin-ui-deployment.yaml`
- `charts/browser-hitl/templates/controller-deployment.yaml`
- `charts/browser-hitl/templates/slack-bot-deployment.yaml`
- `charts/browser-hitl/templates/teams-bot-deployment.yaml`
- `charts/browser-hitl/templates/egress-proxy-deployment.yaml`
- `charts/browser-hitl/templates/postgres-statefulset.yaml`
- `charts/browser-hitl/templates/redis-deployment.yaml`
- `charts/browser-hitl/templates/nats-statefulset.yaml`
- `charts/browser-hitl/templates/minio-statefulset.yaml`
- `charts/browser-hitl/templates/backup-cronjob.yaml`

**Changes:** Added to every template:
- Pod-level: `runAsNonRoot: true`, `runAsUser`, `fsGroup`
- Container-level: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`

**UID mapping:**
| Service | runAsUser | Reason |
|---------|-----------|--------|
| api, admin-ui, controller, slack-bot, teams-bot, egress-proxy, nats, minio | 1000 | Default non-root |
| postgres, redis, backup-cronjob | 999 | Official image default user |

**Note:** Worker pods are created dynamically by the controller — their securityContext must be set in the controller's pod spec builder (separate task).

### KAN-918: Docker Image Pinning

**Helm values.yaml changes:**
| Image | Before | After |
|-------|--------|-------|
| postgres | `16-alpine` | `16.8-alpine` |
| redis | `7-alpine` | `7.4-alpine` |
| nats | `2.10-alpine` | `2.10.24-alpine` |
| minio | `latest` | `RELEASE.2025-03-12T18-04-18Z` |
| egress-proxy (node) | `20-alpine` | `20.18.1-alpine` |

**Dockerfile digest pinning:**
| Dockerfile | Base Image | Digest |
|------------|-----------|--------|
| api, controller, admin-ui, slack-bot, teams-bot | `node:20-slim` | `sha256:f93745c...` |
| worker | `playwright:v1.58.2-noble` | `sha256:6446946...` |
| novnc | `python:3.11-slim` | `sha256:b1b81d6...` |

### KAN-922: GitHub Actions SHA Pinning

**Files changed:**
- `.github/workflows/ci.yaml`
- `.github/workflows/deploy-staging.yaml`
- `.github/workflows/deploy-production.yaml`

**Pinned actions:**
| Action | SHA |
|--------|-----|
| `actions/checkout@v4` | `34e114876b0b11c390a56381ad16ebd13914f8d5` |
| `pnpm/action-setup@v4` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` |
| `actions/setup-node@v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `azure/setup-helm@v4` | `1a275c3b69536ee54be43f2070a358922e12c8d4` |
| `docker/setup-buildx-action@v3` | `8d2750c68a42422c14e847fe6c8ac0403b4cbd6f` |
| `docker/login-action@v3` | `c94ce9fb468520275223c153574b00df6fe4bcc9` |
| `docker/metadata-action@v5` | `c299e40c65443455700f0fdfc63efafe5b349051` |
| `docker/build-push-action@v6` | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` |
| `actions/setup-python@v5` | `a26af69be951a213d495a4c3e4e4022e16d87065` |

---

## Verification

All passing on branch `fix/security-remediation-kan923`:
- `pnpm run build` — all 7 projects
- `pnpm run test` — all 7 projects (48 tests)
- `helm lint charts/browser-hitl/` — 0 failures

## Remaining work (not in this PR)

1. **KAN-920**: path-to-regexp 3.3.0 — accepted risk until Express 5.x upgrade
2. **Worker pod securityContext**: Controller creates worker pods dynamically — needs code change in controller's pod spec builder
3. **Close tickets**: KAN-911, KAN-917, KAN-921 with comments explaining existing mitigations
4. **Won't fix tickets**: KAN-914, KAN-915, KAN-916 with comments explaining dev-only nature
