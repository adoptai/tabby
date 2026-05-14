# Aikido Security — HIGH/CRITICAL Action Plan

_Generated: 2026-05-13. Source: `docs/aikido.md`._

---

## 1. Summary Table

| # | Package | Severity | Current (resolved) | Fix version | Type | File to edit |
|---|---------|----------|--------------------|-------------|------|--------------|
| 1 | `axios` | CRITICAL (3 CVEs) + HIGH (5 CVEs) | 1.13.5 (transitive) | ≥ 1.15.2 | Transitive — no direct dep found | `package.json` root override |
| 2 | GitHub Actions template injection | CRITICAL | — | Code change | SAST | `.github/workflows/ci.yaml`, `deploy-production.yaml` |
| 3 | `lodash` | CRITICAL (CVE-2026-4800) | 4.17.23 (transitive) | ≥ 4.18.1 | Transitive — override already exists at `>=4.17.21` | `package.json` root override |
| 4 | `next` | HIGH (15 CVEs) | 15.5.12 (direct) | ≥ 15.5.16 | Direct dep | `apps/admin-ui/package.json` |
| 5 | `@slack/bolt` | HIGH (1 CVE) | 3.22.0 (direct) | Patch version (check changelog) | Direct dep | `apps/slack-bot/package.json` |
| 6 | Express without Helmet (`health-server.ts`) | HIGH | — | Code change | SAST | `apps/worker/src/health-server.ts` |
| 7 | Generic API Key in git history (`e2e_uat_22_4.py`, `STARTUP.md`) | HIGH | — | Key rotation / ignore | Secrets in history | Out-of-band: rotate key, mark resolved in Aikido |
| 8 | 4 exposed secrets in `values.yaml` / `values-local.yaml` | HIGH | — | Rotate secrets, scrub | Secrets in history | Out-of-band |
| 9 | Potential file inclusion (`streaming.controller.ts`, `credential-resolver.ts`) | HIGH | — | Code review / sanitization | SAST | `apps/api/src/modules/streaming/streaming.controller.ts`, `apps/worker/src/credential-resolver.ts` |
| 10 | `multer` | HIGH (3 CVEs) | 2.0.2 (transitive) | ≥ 2.1.1 | Transitive — override already at `>=2.0.1` | `package.json` root override |
| 11 | `path-to-regexp` | HIGH (3 CVEs) | 0.1.12 / 3.3.0 / 8.3.0 (transitive) | ≥ 8.4.0 | Transitive | `package.json` root override |
| 12 | `fast-xml-parser` | HIGH (5 CVEs) | 5.3.7 (transitive) | ≥ 5.7.2 | Transitive — override already at `>=5.3.6` | `package.json` root override |

---

## 2. Fix Instructions per Vulnerability

### 2.1 axios — bump pnpm override to ≥ 1.15.2

`axios` is **not a direct dep** in any app's `package.json` — it is pulled in transitively (likely via `minio`, `@sentry/node`, or similar). Fix via the root-level pnpm override.

**File:** `/home/moraski/work/tabby/package.json` — `pnpm.overrides` block.

Current state:
```json
"pnpm": {
  "overrides": {
    "fast-xml-parser": ">=5.3.6",
    "lodash": ">=4.17.21",
    "multer": ">=2.0.1"
  }
}
```

Add `axios`:
```json
"pnpm": {
  "overrides": {
    "axios": ">=1.15.2",
    "fast-xml-parser": ">=5.7.2",
    "lodash": ">=4.18.1",
    "multer": ">=2.1.1",
    "path-to-regexp": ">=8.4.0"
  }
}
```

Then run:
```bash
pnpm install
```

> **Breaking-change risk for axios 1.13 → 1.15:** Low. The 1.x minor series has been stable; no known API breaks between these patch/minor releases. The changes are security-only fixes (SSRF protection, prototype pollution guards).

> **Breaking-change risk for path-to-regexp ≥ 8.4.0:** path-to-regexp 8.x is a major rewrite (named groups syntax changed). However, since this is only a transitive dep (used internally by express/NestJS router), forcing the whole tree to 8.x via an override could break older consumers that expect the 0.x or 3.x API. **See caveat in section 4.**

---

### 2.2 lodash — tighten existing override to ≥ 4.18.1

The existing override `"lodash": ">=4.17.21"` allows 4.17.21–4.17.23, which are still vulnerable. Tighten it:

**File:** `/home/moraski/work/tabby/package.json`

Change:
```json
"lodash": ">=4.17.21"
```
To:
```json
"lodash": ">=4.18.1"
```

---

### 2.3 fast-xml-parser — tighten existing override to ≥ 5.7.2

**File:** `/home/moraski/work/tabby/package.json`

Change:
```json
"fast-xml-parser": ">=5.3.6"
```
To:
```json
"fast-xml-parser": ">=5.7.2"
```

---

### 2.4 multer — tighten existing override to ≥ 2.1.1

**File:** `/home/moraski/work/tabby/package.json`

Change:
```json
"multer": ">=2.0.1"
```
To:
```json
"multer": ">=2.1.1"
```

---

### 2.5 next.js — bump direct dep to ≥ 15.5.16

**File:** `/home/moraski/work/tabby/apps/admin-ui/package.json`

Change:
```json
"next": "^15.1.6"
```
To:
```json
"next": "^15.5.16"
```

Then `pnpm install`.

> **Breaking-change risk:** Negligible. These are all patch/security releases within the 15.x line. The admin-ui has no customised Next.js config that conflicts with 15.5.x behaviour.

---

### 2.6 @slack/bolt — bump to patched version

**File:** `/home/moraski/work/tabby/apps/slack-bot/package.json`

The current resolved version is 3.22.0. The CVE (improper `ssl_check` authentication bypass) was fixed in a patch release. Check the [changelog](https://github.com/slackapi/bolt-js/releases) for the exact patched version, then update:

```json
"@slack/bolt": "^3.23.0"   // or whatever patched version is released
```

If 3.22.x is already patched, a `pnpm update @slack/bolt` within `apps/slack-bot` will suffice.

> **Impact scope:** The `ssl_check` bypass only matters if the Slack HTTP adapter is used (Socket Mode is not affected). In production, the app runs in Socket Mode (`main.ts`) where this path is not exercised. Still worth patching.

---

### 2.7 GitHub Actions — template injection in ci.yaml and deploy-production.yaml

#### ci.yaml — line 31

**Vulnerable:**
```yaml
run: echo "${{ github.event.pull_request.title }}" | npx commitlint --verbose
```

**Safe replacement** — write the value to an env var first (env context is not injectable):
```yaml
- name: Validate PR title follows conventional commits
  env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "$PR_TITLE" | npx commitlint --verbose
```

#### deploy-production.yaml — lines 29–34

**Vulnerable:**
```yaml
run: |
  if [ "${{ github.event.inputs.confirm }}" != "deploy" ]; then
    echo "::error::You must type 'deploy' to confirm. Got: '${{ github.event.inputs.confirm }}'"
    exit 1
  fi
```

**Safe replacement:**
```yaml
- name: Validate manual trigger
  if: github.event_name == 'workflow_dispatch'
  env:
    CONFIRM_INPUT: ${{ github.event.inputs.confirm }}
  run: |
    if [ "$CONFIRM_INPUT" != "deploy" ]; then
      echo "::error::You must type 'deploy' to confirm."
      exit 1
    fi
```

> **Note:** The `github.event.inputs.confirm` field is user-supplied from `workflow_dispatch`. While it is restricted to GitHub authenticated users, moving it to an env var eliminates the injection vector entirely. The `github.event.pull_request.title` is the higher-risk one — it's controllable by any PR author in a public repo.

---

### 2.8 Express without Helmet — worker health-server.ts

**File:** `/home/moraski/work/tabby/apps/worker/src/health-server.ts`

The worker's health server uses bare Express with no Helmet. This server is internal-only (K8s liveness probe on port 8091, not exposed externally), so the practical risk is low. However, Aikido flags it.

`express` is already a direct dep in `apps/worker/package.json`. Add `helmet`:

1. Add to `apps/worker/package.json` dependencies:
   ```json
   "helmet": "^8.1.0"
   ```

2. Edit `health-server.ts` — add after the `express()` call:
   ```typescript
   import helmet from 'helmet';
   // ...
   const app = express();
   app.use(helmet());
   ```

> The API (`apps/api`) already has `helmet ^8.1.0` as a direct dep and uses it in `main.ts`. This just brings the worker health server into parity.

---

### 2.9 Potential file inclusion — streaming.controller.ts and credential-resolver.ts

Aikido flags `readFile` calls as potential file-inclusion vectors. Review status:

#### `apps/api/src/modules/streaming/streaming.controller.ts`

`readFile` is called in `loadNoVncAsset()` via `require.resolve('@novnc/novnc/...')`. The asset path is:
- Validated by `normalizeNoVncAssetPath()` which enforces `[A-Za-z0-9._/-]+` and rejects `..`.
- Resolved through `require.resolve()` which pins it to the installed npm package location.

**Assessment:** Not exploitable as-is. Path traversal is already blocked. **Mark as verified/accepted in Aikido.**

#### `apps/worker/src/credential-resolver.ts`

`readFile` reads from `join(mountRoot, secretName, 'username')` and `join(mountRoot, secretName, 'password')`. The `secretName` comes from `credentialRef.replace('k8s:secret/', '')`. No sanitization on `secretName`.

**Mitigation needed:** Add a check that `secretName` contains only safe characters before constructing the path:

```typescript
const secretName = credentialRef.replace('k8s:secret/', '').trim();
if (!secretName || !/^[a-zA-Z0-9_-]+$/.test(secretName)) {
  throw new Error(`Invalid credential_ref: ${credentialRef}`);
}
```

The `credentialRef` value comes from the database (`app.login_config.credential_ref`), so an attacker would need DB write access to exploit this. Nevertheless, defense-in-depth validation is good practice.

---

### 2.10 Exposed secrets in git history

**Files:** `scripts/e2e_uat_22_4.py`, `STARTUP.md`, `charts/browser-hitl/values.yaml`, `charts/browser-hitl/values-local.yaml`

These are secrets that were committed at some point and appear in git history. Steps:

1. **Identify the secrets:** Check Aikido for the masked values (`*****2345`). Contact the team to determine if these are real or placeholder test values.
2. **If real:** Rotate/revoke the keys immediately. Git history cannot be scrubbed without a force-push rewrite — note the repo is flagged as public by Aikido ("Finding dangerous in public repo").
3. **If placeholder/test:** Mark as accepted in Aikido with a comment.
4. `values-local.yaml` is committed to git intentionally (local dev config per CLAUDE.md), but should not contain production-grade secrets. Verify the flagged values are dev-only.

---

## 3. What to Test After

1. **After pnpm override changes + `pnpm install`:**
   ```bash
   pnpm run build
   pnpm run test
   pnpm run lint
   ```
   Verify the lockfile shows the new resolved versions:
   ```bash
   grep "axios@\|lodash@\|multer@\|fast-xml-parser@\|path-to-regexp@" pnpm-lock.yaml
   ```

2. **After next.js bump:**
   - Build admin-ui: `cd apps/admin-ui && pnpm run build`
   - Smoke-test the admin UI in Kind: `make kind-reload-all`

3. **After @slack/bolt bump:**
   - Ensure the bot still connects: deploy to staging and check Socket Mode connects.

4. **After GitHub Actions workflow fixes:**
   - Open a test PR with a title containing shell-special characters (e.g., `feat: fix $(id) test`). Verify commitlint runs without executing the injected command.

5. **After credential-resolver.ts sanitization:**
   - Run the existing credential-resolver spec: `pnpm --filter @browser-hitl/worker run test`
   - Add a test case for a `credentialRef` containing `../` to verify it throws.

6. **After Helmet on health-server.ts:**
   - Run `curl -I http://localhost:8091/health` on a local worker — confirm security headers appear (`X-Content-Type-Options`, `X-Frame-Options`, etc.).

---

## 4. Vulnerabilities Needing More Than a Version Bump

| # | Issue | Why it's not a simple bump |
|---|-------|---------------------------|
| 1 | **GitHub Actions template injection** | Requires YAML code changes in two workflow files — not a dep bump. |
| 2 | **Express without Helmet (worker)** | Requires adding `helmet` as a dep AND modifying `health-server.ts`. |
| 3 | **File inclusion in credential-resolver.ts** | Requires adding input validation logic. |
| 4 | **Exposed secrets in git history** | Cannot be fixed by any code change — requires key rotation and potentially a git history rewrite. |
| 5 | **path-to-regexp override caveat** | Forcing `>=8.4.0` via pnpm override affects ALL consumers in the monorepo tree. `path-to-regexp` 8.x changed the named-group syntax. Express 4.x and NestJS router internally use path-to-regexp 0.x / 3.x — overriding to 8.x will break routing. **Do not apply a blanket override for path-to-regexp.** Instead, wait for Express/NestJS to ship their own fix and bump those frameworks. Alternatively, pin the override narrowly to packages that accept 8.x. |
