# Implementation Prompt: VNC Pre-Authentication via Short-Link Grant

## Context

Tabby's VNC viewer requires a `tabby_vnc` HttpOnly cookie for access. Today this cookie is set via an OAuth redirect through Frontegg, which requires registering a callback URL per Tabby deployment. This doesn't scale for on-prem customers.

The fix: pre-generate the VNC cookie at short-link creation time (when the caller is already authenticated) and set it when the user opens the short-link. No OAuth redirect needed.

## Branch

Use the existing branch: `feat/nats-resilience-controller-scaling`

This branch already contains NATS reconnect, controller multi-replica scaling, circuit breaker, pod idempotency, Grafana labels, and other resilience improvements. The VNC pre-auth changes will be added to this branch.

## What to Implement

### 1. Pre-generate VNC grant at short-link creation

**File:** `apps/api/src/modules/hitl/hitl.controller.ts`

In the `shortLink()` method (line 66), after generating the short-link:

1. Look up the session to get `owner_user_id` and `tenant_id`
2. Generate a `tabby_vnc` JWT with payload: `{ sub: owner_user_id, tenant_id, type: 'vnc_access', owner_user_id, jti: randomUUID() }`, 1h TTL
3. Store in Redis: key `vnc:grant:{shortId}` → the JWT string, TTL 600s (same as short-link)

The caller (`req.user`) is already authenticated — use `req.user.owner_user_id` or look up the session's `owner_user_id`.

**Reference for JWT generation:** See how `auth.controller.ts:620-630` generates the same JWT today:
```typescript
const vncPayload = {
  sub: ownerUser.id,
  tenant_id: session.tenant_id,
  type: 'vnc_access',
  owner_user_id: session.owner_user_id,
  jti: randomUUID(),
};
const vncToken = this.jwtService.sign(vncPayload, { expiresIn: 3600 });
```

### 2. Consume VNC grant on short-link access

**File:** `apps/api/src/modules/streaming/streaming.controller.ts`

In `ShortLinkController.redirect()` (around line 196), after resolving the short-link URL and extracting the sessionId, **before** the OAuth redirect fallback (line 219):

1. Check Redis for `vnc:grant:{shortId}`
2. If found: `GETDEL` (one-time use), set the cookie, redirect to the VNC URL
3. If not found: fall back to existing OAuth redirect flow (unchanged)

```typescript
// After line 217 (invalid cookie fall-through), before line 219 (OAuth redirect):
const vncGrant = await this.streamTokenService.consumeVncGrant(shortId);
if (vncGrant) {
  const isHttps = PUBLIC_BASE_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
  res.cookie('tabby_vnc', vncGrant, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    maxAge: 3600 * 1000,
    path: '/',
  });
  res.redirect(302, url);
  return;
}
```

This is the exact same `res.cookie()` + `res.redirect()` pattern used in `auth.controller.ts:668-714` (the OAuth callback). It's proven in production.

### 3. Add Redis methods to StreamTokenService

**File:** `apps/api/src/modules/streaming/stream-token.service.ts`

Add two methods:

```typescript
async storeVncGrant(shortId: string, vncToken: string): Promise<void> {
  await this.redis.set(
    REDIS_KEYS.vncGrant(shortId),
    vncToken,
    'EX',
    REDIS_TTL.VNC_SHORT_LINK_SECONDS, // 600s, same as short-link
  );
}

async consumeVncGrant(shortId: string): Promise<string | null> {
  // GETDEL: atomic get + delete, one-time use
  return this.redis.getdel(REDIS_KEYS.vncGrant(shortId));
}
```

### 4. Add Redis key constant

**File:** `packages/shared/src/constants.ts`

Add to `REDIS_KEYS`:
```typescript
vncGrant: (shortId: string) => `vnc:grant:${shortId}`,
```

### 5. Inject dependencies in ShortLinkController

The `ShortLinkController` needs `StreamTokenService` injected if not already available. Check current constructor — it may already have it since it calls `resolveShortLink()`. If not, add it.

## What NOT to Change

- The OAuth redirect flow in `streaming.controller.ts` lines 219-230 must remain as a **fallback**. Standalone/open-source Tabby without platform integration still needs it.
- The email gate fallback must remain.
- The `auth.controller.ts` OAuth callback cookie-setting must remain (used for admin-UI login).
- Do NOT change how `tabby_vnc` cookies are validated — the existing checks in `vnc-ws-proxy.service.ts` and `cdp-ws-proxy.service.ts` work unchanged.

## Security Requirements

- VNC grant is **one-time use** (GETDEL). If someone copies the short-link after the first access, the grant is gone and they fall back to OAuth/email gate.
- VNC grant TTL matches short-link TTL (600s). If the short-link expires, the grant expires too.
- The `tabby_vnc` JWT has `type: 'vnc_access'` — it cannot be used for API calls (no `role` field, rejected by `RolesGuard`).
- The cookie is `HttpOnly; Secure; SameSite=Lax` — cannot be read by JavaScript, only sent on same-site requests.
- The `owner_user_id` in the cookie is validated against the session's `owner_user_id` on every WebSocket upgrade.

## Tests Required

Follow the existing test patterns in the codebase (see `apps/api/src/modules/credentials/credentials.spec.ts` for integration-style tests).

### Unit/Integration tests to write:

1. **`stream-token.service` tests:**
   - `storeVncGrant` stores in Redis with correct key and TTL
   - `consumeVncGrant` returns the token and deletes it (one-time)
   - `consumeVncGrant` returns null when no grant exists
   - `consumeVncGrant` returns null on second call (already consumed)

2. **`ShortLinkController` tests:**
   - Short-link with VNC grant: sets `tabby_vnc` cookie and redirects (200 + Set-Cookie + Location)
   - Short-link without VNC grant: falls back to OAuth redirect (existing behavior)
   - Short-link with valid existing `tabby_vnc` cookie: redirects without consuming grant (existing behavior)
   - Short-link accessed twice: first access gets cookie, second access falls back to OAuth (grant consumed)

3. **`hitl.controller` tests:**
   - `POST /sessions/:id/short-link` generates VNC grant in Redis alongside the short-link
   - VNC grant contains correct `owner_user_id` and `tenant_id` from the session

### Manual test checklist:

- [ ] Generate short-link via MCP flow → open in browser → VNC loads without OAuth redirect
- [ ] Open same short-link in incognito → VNC loads (fresh cookie set)
- [ ] Open same short-link a second time after first access → falls back to OAuth (grant consumed)
- [ ] Open a non-short-link VNC URL directly → OAuth redirect works as before (fallback)
- [ ] Verify `tabby_vnc` cookie is HttpOnly, Secure, SameSite=Lax in browser DevTools
- [ ] Verify WebSocket upgrade succeeds with the pre-set cookie
- [ ] Verify a different user opening the VNC after cookie is set gets 403 (owner mismatch)

## Key Files to Read Before Starting

- `apps/api/src/modules/hitl/hitl.controller.ts` — `shortLink()` method (line 66)
- `apps/api/src/modules/streaming/streaming.controller.ts` — `ShortLinkController.redirect()` (line ~170)
- `apps/api/src/modules/streaming/stream-token.service.ts` — Redis patterns for stream tokens and short-links
- `apps/api/src/modules/auth/auth.controller.ts` — `handleOauthCallback()` (line ~620) — reference for how `tabby_vnc` cookie is generated today
- `apps/api/src/modules/streaming/vnc-ws-proxy.service.ts` — how the cookie is validated on WebSocket upgrade
- `packages/shared/src/constants.ts` — `REDIS_KEYS` and `REDIS_TTL`

## Git / Commit Rules

- **Do NOT commit anything inside `docs/`** — those files are local drafts and not ready for the repo yet.
- `scripts/scale-test.sh` can be committed in the final commit.
- When staging files, add specific paths — do not use `git add -A` or `git add .`.

## Code Standards

- Follow existing NestJS patterns (decorators, dependency injection, guards)
- Use `@browser-hitl/shared` for shared constants
- No comments unless the WHY is non-obvious
- Run `pnpm run build && pnpm run test && helm lint charts/browser-hitl/` before committing
- Conventional commits: `feat(streaming): pre-authenticate VNC access via short-link grant`
- Tests must pass with: `TENANT_ENCRYPTION_KEY=$(printf '0%.0s' {1..64}) pnpm run test`
