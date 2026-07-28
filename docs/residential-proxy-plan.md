# Residential Proxy Support — Exploration Plan

> Internal planning doc. Not a committed feature. Context for future investigation.

## Background

Rahul raised the question of whether Tabby can route browser traffic through residential proxies. Banks and other high-security targets detect datacenter IP ranges (AWS, Azure, GCP) and may reject or rate-limit requests originating from them.

## Current Egress Architecture

Tabby already has a custom egress proxy (`server.js` on port 3128) that all worker browser traffic routes through:

```
Worker Pod (Chromium)
  → Playwright proxy config (EGRESS_PROXY_URL)
    → Egress Proxy (Node.js, port 3128)
      → Direct internet connection
```

Key properties of the current proxy:
- **Per-session allowlist enforcement** — each session only reaches its configured `target_urls` + `extra_egress_allowlist`
- **Session-scoped HMAC auth** — workers authenticate to the proxy with `sessionId:HMAC(key, sessionId)`
- **NetworkPolicy isolation** — worker pods have no direct internet egress; all external traffic goes through the proxy
- **Admin API** (port 8095) — controller manages per-session allowlists via REST
- **No upstream proxy chaining** — the proxy connects directly to the target host via `net.connect` / `https.request`

### Key files
- `charts/browser-hitl/files/egress-proxy/server.js` — proxy implementation
- `apps/worker/src/main.ts` lines 100-124 — Playwright proxy configuration
- `apps/controller/src/pod-manager.service.ts` lines 514-541 — session-scoped proxy URL generation
- `charts/browser-hitl/values.yaml` lines 319-343 — egress proxy Helm values

## What Would Need to Change

### Option A: Upstream proxy chaining in the egress proxy (recommended)

Add upstream proxy support to `server.js` so it chains to an external residential proxy provider instead of connecting directly.

```
Worker Pod (Chromium)
  → Egress Proxy (existing, port 3128)
    → Residential Proxy Provider (BrightData, Oxylabs, etc.)
      → Target website
```

**Changes needed:**
1. **`server.js`** — on `CONNECT` tunnel and HTTP proxy, connect to the upstream proxy instead of the target directly. Most residential providers expose an HTTP/SOCKS5 proxy endpoint with username:password auth.
2. **Helm values** — new config:
   ```yaml
   egressProxy:
     upstreamProxy:
       enabled: false
       url: ""              # e.g. http://user:pass@proxy.brightdata.com:22225
       type: "http"         # http | socks5
       bypassList: []       # hosts that should NOT go through the residential proxy
   ```
3. **Per-app or per-template config** (optional) — allow specifying upstream proxy at the app/template level for per-target proxy routing (banks get residential, Salesforce gets direct)

**Advantages:**
- Minimal change — only touches the egress proxy, not Playwright or the worker
- Preserves all existing allowlist enforcement and session isolation
- Residential proxy provider handles IP rotation, geo-targeting, session stickiness
- Can be enabled per-deployment (on-prem stays direct, cloud gets residential)

### Option B: Playwright-level proxy (per browser context)

Configure the residential proxy directly in Playwright's launch options instead of chaining through the egress proxy.

```
Worker Pod (Chromium)
  → Residential Proxy (direct from browser)
  → Egress Proxy (only for allowlist enforcement on non-proxied traffic)
```

**Changes needed:**
1. **`apps/worker/src/main.ts`** — read a `RESIDENTIAL_PROXY_URL` and pass it to `browser.newContext({ proxy: { server, username, password } })`
2. **App template / application entity** — new field for proxy config
3. **Controller** — adjust NetworkPolicy to allow worker egress to the residential proxy endpoint

**Disadvantages:**
- Bypasses the egress proxy allowlist enforcement (the browser connects directly to the residential proxy, which then connects anywhere)
- Would need to replicate allowlist logic in the residential proxy provider's config, or accept that the allowlist is weakened
- More invasive change across multiple components

### Option C: Sidecar proxy (envoy/squid)

Deploy a sidecar container in the worker pod that chains to the residential proxy.

**Disadvantages:**
- Adds complexity to pod spec
- Duplicates what the existing egress proxy already does
- More resource overhead per pod

## Residential Proxy Providers

| Provider | Endpoint | Protocol | Session stickiness | Geo-targeting | Pricing |
|---|---|---|---|---|---|
| BrightData | `brd.superproxy.io:33335` | HTTP CONNECT | `username-session-{id}` | Country/city/ASN | Per GB |
| Oxylabs | `pr.oxylabs.io:7777` | HTTP CONNECT | `username-sessid-{id}` | Country/city | Per GB |
| Smartproxy | `gate.smartproxy.com:10001` | HTTP CONNECT | `username-sessid-{id}` (up to 30min) | Country/city | Per GB or per request |
| IPRoyal | `geo.iproyal.com:12321` | HTTP/SOCKS5 | Session ID in username | Country | Per GB |

All providers expose a single gateway endpoint with username/password auth. Session stickiness (same exit IP for the duration of a Tabby session) is controlled via the username field — e.g., `brd-customer-XXXXX-session-{tabbySessionId}`. The egress proxy could map Tabby's `sessionId` directly to the provider's session ID.

**Important: use HTTP CONNECT, not SOCKS5.** Playwright does not support username/password auth for SOCKS5 proxies — only HTTP proxies carry credentials correctly.

## Considerations

### TLS Fingerprinting
Residential proxies solve the IP reputation problem but NOT TLS fingerprinting. Chromium's TLS fingerprint is well-known and can be detected regardless of IP. Tabby already uses CloakBrowser (stealth Chromium) as a mitigation — this is orthogonal to proxy choice.

### Session Stickiness
For Tabby's use case (persistent browser sessions), we need sticky sessions — the same IP for the duration of a login session. Most providers support this via session IDs in the proxy username. The egress proxy could map `sessionId` → residential proxy session ID.

### Cost
Residential proxy traffic is priced per GB ($5-15/GB typically). Tabby sessions are long-lived with periodic keepalive traffic, so bandwidth per session is low. But at scale, this needs budgeting.

### Per-Target Routing
Not all targets need residential IPs. A bank might, but Salesforce probably doesn't. The ideal setup routes selectively:
- Domains matching a "residential required" list → upstream residential proxy
- Everything else → direct (current behavior)

This could be configured at the app template level.

### On-Prem Implications
On-prem deployments may not need residential proxies (traffic originates from the customer's own network, which is already trusted by their SaaS providers). This should be a cloud-only or opt-in feature.

## Recommendation

**Option A (upstream chaining in the egress proxy)** is the right approach. It's the smallest change, preserves all existing security properties, and the egress proxy is already the single chokepoint for all worker traffic.

Estimated effort: ~2-3 days for a basic implementation (upstream chaining + Helm config). Per-app routing adds another 1-2 days.

## Not Explored Yet

- Specific provider selection (needs pricing comparison for expected traffic volume)
- Geo-targeting requirements (do sessions need to originate from a specific country?)
- Whether banks actually block based on IP range alone or use additional signals
- Legal/compliance implications of routing through residential IPs for bank access
- Whether the customer (AA) would provide their own residential proxy or we'd provision one
