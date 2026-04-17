# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Preferred:** open a private advisory via [GitHub Security Advisories](https://github.com/adoptai/tabby/security/advisories/new).

**Email:** iain@adopt.ai, moraski@adopt.ai

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and provide a detailed response within 5 business days.

**Do not** open a public GitHub issue for security vulnerabilities.

## Security Posture

This project underwent a 40+ item red team security audit. All remediations completed and graded (S/A tier).

## Key Security Features

- **Authentication:** JWT with `jti`-based revocation (Redis blacklist), bcrypt cost 12, account lockout (5 failures / 15 min), password complexity enforcement, OAuth 2.0 Client Credentials for agents
- **Authorization:** 4-role RBAC (Admin/Operator/Viewer/Agent) enforced on all controllers
- **Input validation:** class-validator DTOs with `whitelist: true` and `forbidNonWhitelisted: true`
- **Rate limiting:** Global 60/min + per-endpoint overrides (login: 5/min, stream: 3/min)
- **Security headers:** Helmet (HSTS, X-Frame-Options, CSP, etc.), CORS with configurable origin
- **Metrics protection:** Bearer token auth with timing-safe comparison
- **Network security:** Kubernetes NetworkPolicies, NATS token auth, TLS via cert-manager
- **Data encryption:** AES-256-GCM for artifact bundles (per-tenant key)
- **Audit trail:** Append-only SHA-256 hash chain with daily integrity anchors
- **Secrets management:** No hardcoded defaults in production values
- **Login safety:** 3-barrier serialization (Redis lock, DB transaction, per-worker rate limit) preventing account lockout
- **CDP streaming security:** Strict command/event whitelists, message-level inspection, 64KB frame limit, `Target.*` domain rejection

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x | Yes |

## SBOM

A CycloneDX Software Bill of Materials is generated in CI and attached to container images via cosign.
