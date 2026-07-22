'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

const PROXY_PORT = parseInt(process.env.EGRESS_PROXY_PORT || '3128', 10);
const ADMIN_PORT = parseInt(process.env.EGRESS_PROXY_ADMIN_PORT || '8095', 10);
const ADMIN_TOKEN = (process.env.EGRESS_PROXY_ADMIN_TOKEN || '').trim();
const ALLOW_INSECURE_ADMIN = (process.env.EGRESS_PROXY_ALLOW_INSECURE_ADMIN || '')
  .trim()
  .toLowerCase() === 'true';
const SESSION_KEY = (process.env.EGRESS_PROXY_SESSION_KEY || '').trim();
const ALLOW_INSECURE_SESSION_ALLOWLIST = (process.env.EGRESS_PROXY_ALLOW_INSECURE_SESSION_ALLOWLIST || '')
  .trim()
  .toLowerCase() === 'true';
const DEFAULT_ALLOWLIST = parseAllowlist(process.env.EGRESS_PROXY_DEFAULT_ALLOWLIST || '');

// Upstream residential proxy (e.g. Oxylabs), chained beneath this proxy for
// sessions flagged residential. Full proxy URL incl. server-side credentials;
// the username may contain a `{sessionId}` placeholder for the vendor's sticky
// session-id option (same value → same exit IP). Parsed once; NEVER logged
// (contains credentials). Absent/invalid → residential routing is a no-op.
const UPSTREAM_PROXY = parseUpstreamProxy(process.env.EGRESS_UPSTREAM_PROXY_URL || '');

// Tabby-owned infrastructure — always allowed, merged into every allowlist at
// match time. Immune to env/chart misconfiguration (cannot be removed by
// EGRESS_PROXY_DEFAULT_ALLOWLIST being unset or truncated). Eliminates the
// "noVNC client / CDN assets blocked" failure class (cdn.adopt.ai).
const TABBY_INFRASTRUCTURE_ALLOWLIST = ['.adopt.ai'];

// Sentinel domain that, when present in a session's allowlist, permits all
// egress for that session. Used for recording sessions (human-driven discovery
// of an arbitrary vendor whose domains are unknowable in advance — the recorder
// captures them via HAR instead).
const ALLOW_ALL_SENTINEL = '*';

const sessionAllowlist = new Map();
// sessionId → boolean: whether this session's non-infra egress chains through
// the residential upstream proxy. Populated alongside the allowlist by the
// controller's PUT /allowlist. In-memory (same volatility as sessionAllowlist).
const sessionResidential = new Map();

function log(message, extra) {
  if (typeof extra === 'undefined') {
    console.log(`[egress-proxy] ${message}`);
    return;
  }
  console.log(`[egress-proxy] ${message}`, extra);
}

function parseAllowlist(raw) {
  return raw
    .split(/[,\n]/)
    .map((item) => normalizeHost(item))
    .filter(Boolean);
}

function normalizeHost(host) {
  if (!host) {
    return '';
  }
  return String(host).trim().toLowerCase().replace(/\.$/, '');
}

function extractHostFromTarget(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    if (!parsed.hostname) {
      return null;
    }
    return normalizeHost(parsed.hostname);
  } catch {
    return null;
  }
}

function parseUpstreamProxy(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const u = new URL(trimmed);
    return {
      hostname: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 80,
      // decodeURIComponent so a `{sessionId}` placeholder survives URL parsing
      // even if the operator percent-encoded the braces.
      usernameTemplate: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch {
    // Do not echo the value — it contains credentials.
    console.error('[egress-proxy] EGRESS_UPSTREAM_PROXY_URL is not a valid URL; residential routing disabled');
    return null;
  }
}

// Suffix/exact match against a domain list (entries beginning with '.' match the
// bare apex and any subdomain). Mirrors the matching in isHostAllowed; kept
// separate so the residential-bypass decision does not perturb allowlist logic.
function hostMatchesList(normalized, list) {
  for (const entry of list) {
    if (!entry || entry === ALLOW_ALL_SENTINEL) {
      continue;
    }
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
        return true;
      }
    } else if (normalized === entry) {
      return true;
    }
  }
  return false;
}

// Tabby infrastructure (.adopt.ai + env DEFAULT_ALLOWLIST) and cluster-internal
// hosts always dial direct, never through the residential proxy — residential
// egress applies only to the external vendor target.
function isInfraOrInternal(hostname) {
  const normalized = normalizeHost(hostname);
  if (!normalized) {
    return true;
  }
  if (hostMatchesList(normalized, TABBY_INFRASTRUCTURE_ALLOWLIST) || hostMatchesList(normalized, DEFAULT_ALLOWLIST)) {
    return true;
  }
  // Single-label names (bare Service names) and cluster-internal suffixes.
  if (!normalized.includes('.')) {
    return true;
  }
  return /(?:\.local|\.internal|\.svc|\.svc\.cluster\.local|\.cluster\.local)$/.test(normalized);
}

// A session routes residential only when: an upstream is configured, the session
// is flagged residential, and the target is an external (non-infra) host.
function shouldRouteResidential(hostname, sessionId) {
  if (!UPSTREAM_PROXY || !sessionId || !sessionResidential.get(sessionId)) {
    return false;
  }
  return !isInfraOrInternal(hostname);
}

// Build the upstream Proxy-Authorization header for a session, substituting the
// sanitized sessionId into the vendor's sticky-session placeholder so the same
// session pins the same exit IP.
function buildUpstreamAuth(sessionId) {
  const stickyId = String(sessionId).replace(/[^a-zA-Z0-9]/g, '');
  const username = UPSTREAM_PROXY.usernameTemplate.replace(/\{sessionId\}/g, stickyId);
  const creds = `${username}:${UPSTREAM_PROXY.password}`;
  return `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`;
}

function expectedSessionSecret(sessionId) {
  return crypto.createHmac('sha256', SESSION_KEY).update(sessionId).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '', 'utf8');
  const rightBuffer = Buffer.from(right || '', 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function resolveSessionId(req) {
  if (!SESSION_KEY) {
    return null;
  }

  const authHeader = (req.headers['proxy-authorization'] || '').toString().trim();
  if (!authHeader.toLowerCase().startsWith('basic ')) {
    return null;
  }

  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice('basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const separator = decoded.indexOf(':');
  if (separator <= 0) {
    return null;
  }

  const sessionId = decoded.slice(0, separator).trim();
  const providedSecret = decoded.slice(separator + 1).trim();
  if (!sessionId || !providedSecret) {
    return null;
  }

  const expected = expectedSessionSecret(sessionId);
  if (!safeEqual(providedSecret, expected)) {
    return null;
  }

  return sessionId;
}

function isHostAllowed(hostname, sessionId) {
  const normalized = normalizeHost(hostname);
  if (!normalized) {
    return false;
  }

  const allowlist = new Set([...DEFAULT_ALLOWLIST, ...TABBY_INFRASTRUCTURE_ALLOWLIST]);
  if (sessionId) {
    const sessionDomains = sessionAllowlist.get(sessionId);
    if (sessionDomains) {
      if (sessionDomains.has(ALLOW_ALL_SENTINEL)) {
        return true;
      }
      for (const domain of sessionDomains) {
        allowlist.add(domain);
      }
    }
  } else if (ALLOW_INSECURE_SESSION_ALLOWLIST) {
    for (const domains of sessionAllowlist.values()) {
      if (domains.has(ALLOW_ALL_SENTINEL)) {
        return true;
      }
      for (const domain of domains) {
        allowlist.add(domain);
      }
    }
  }

  for (const entry of allowlist) {
    if (!entry) {
      continue;
    }
    if (entry.startsWith('.')) {
      const suffix = entry.slice(1);
      if (normalized === suffix || normalized.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }
    if (normalized === entry) {
      return true;
    }
  }

  return false;
}

function writeJson(res, statusCode, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function stripProxyHeaders(headers) {
  const cleaned = { ...headers };
  delete cleaned['proxy-connection'];
  delete cleaned['proxy-authorization'];
  delete cleaned['proxy-authenticate'];
  return cleaned;
}

function parseRequestTarget(req) {
  const rawTarget = req.url || '';
  try {
    return new URL(rawTarget);
  } catch {
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      return null;
    }
    try {
      const path = rawTarget.startsWith('/') ? rawTarget : `/${rawTarget}`;
      return new URL(`http://${hostHeader}${path}`);
    } catch {
      return null;
    }
  }
}

function denyHttp(res, hostname, reason = null) {
  writeJson(res, 403, {
    error: 'egress_denied',
    reason: reason || `Host ${hostname} is not in allowlist`,
  });
}

function denyConnect(socket, hostname, reason = null) {
  const body = JSON.stringify({
    error: 'egress_denied',
    reason: reason || `Host ${hostname} is not in allowlist`,
  });
  socket.write(
    `HTTP/1.1 403 Forbidden\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

function proxyHttpRequest(req, res) {
  const sessionId = resolveSessionId(req);
  if (!sessionId && !ALLOW_INSECURE_SESSION_ALLOWLIST) {
    denyHttp(res, 'unknown', 'Session-scoped proxy credentials are required');
    return;
  }

  const target = parseRequestTarget(req);
  if (!target || !target.hostname) {
    writeJson(res, 400, { error: 'invalid_target' });
    return;
  }

  const hostname = normalizeHost(target.hostname);
  if (!isHostAllowed(hostname, sessionId)) {
    denyHttp(res, hostname);
    return;
  }

  if (shouldRouteResidential(hostname, sessionId)) {
    proxyHttpViaUpstream(req, res, target, sessionId);
    return;
  }

  const isHttps = target.protocol === 'https:';
  const upstream = (isHttps ? https : http).request(
    {
      protocol: isHttps ? 'https:' : 'http:',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: stripProxyHeaders(req.headers),
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    writeJson(res, 502, {
      error: 'upstream_error',
      message: String(error && error.message ? error.message : error),
    });
  });

  req.pipe(upstream);
}

function requireProxyAuth(socket) {
  const body = JSON.stringify({ error: 'proxy_auth_required', reason: 'Session-scoped proxy credentials are required' });
  socket.write(
    'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      'Proxy-Authenticate: Basic realm="browser-hitl"\r\n' +
      'Connection: close\r\n' +
      'Content-Type: application/json; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      '\r\n' +
      body,
  );
  socket.destroy();
}

// Establish a CONNECT tunnel to the target THROUGH the upstream residential
// proxy: open a socket to the upstream, send a nested CONNECT with the vendor
// creds, wait for its "200 Connection Established", then splice the client and
// upstream sockets. The client's `head` bytes (TLS ClientHello) are held until
// the upstream tunnel is confirmed, so no plaintext leaks before the tunnel is
// up. Preserves the browser's TLS fingerprint (blind byte tunnel, no
// termination). On any upstream failure the client gets a 502.
const UPSTREAM_CONNECT_TIMEOUT_MS = parseInt(process.env.EGRESS_UPSTREAM_CONNECT_TIMEOUT_MS || '15000', 10);
const UPSTREAM_MAX_HEADER_BYTES = 65536;

function connectViaUpstream(clientSocket, head, targetHost, targetPort, sessionId) {
  const auth = buildUpstreamAuth(sessionId);
  const upstreamSocket = net.connect(UPSTREAM_PROXY.port, UPSTREAM_PROXY.hostname);
  upstreamSocket.setTimeout(UPSTREAM_CONNECT_TIMEOUT_MS);

  let established = false;
  let responseBuffer = Buffer.alloc(0);

  const fail = (reason) => {
    if (!established && !clientSocket.destroyed) {
      const body = JSON.stringify({ error: 'upstream_proxy_error', reason });
      clientSocket.write(
        'HTTP/1.1 502 Bad Gateway\r\n' +
          'Connection: close\r\n' +
          'Content-Type: application/json; charset=utf-8\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          '\r\n' +
          body,
      );
    }
    upstreamSocket.destroy();
    clientSocket.destroy();
  };

  const onData = (chunk) => {
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    const headerEnd = responseBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (responseBuffer.length > UPSTREAM_MAX_HEADER_BYTES) {
        fail('oversized upstream response');
      }
      return; // wait for the rest of the header
    }
    upstreamSocket.removeListener('data', onData);
    const statusLine = responseBuffer.slice(0, headerEnd).toString('utf8').split('\r\n')[0] || '';
    const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})/);
    const status = match ? parseInt(match[1], 10) : 0;
    if (status !== 200) {
      fail(`upstream CONNECT returned ${status || 'an invalid response'}`);
      return;
    }
    established = true;
    upstreamSocket.setTimeout(0);
    // Bytes past the header terminator already belong to the tunnel.
    const leftover = responseBuffer.slice(headerEnd + 4);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    if (leftover.length > 0) {
      clientSocket.write(leftover);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    log('residential CONNECT established', { session_id: sessionId, target: `${targetHost}:${targetPort}` });
  };

  upstreamSocket.on('connect', () => {
    upstreamSocket.write(
      `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Authorization: ${auth}\r\n` +
        'Connection: keep-alive\r\n' +
        '\r\n',
    );
  });
  upstreamSocket.on('data', onData);
  upstreamSocket.on('timeout', () => fail('upstream connect timeout'));
  upstreamSocket.on('error', (error) => fail(String(error && error.message ? error.message : 'upstream error')));
  clientSocket.on('error', () => upstreamSocket.destroy());
}

// Forward a plain-HTTP request through the upstream residential proxy using
// absolute-form request target + upstream Proxy-Authorization. Browser egress is
// almost entirely HTTPS/CONNECT, so this path is secondary.
function proxyHttpViaUpstream(req, res, target, sessionId) {
  const headers = stripProxyHeaders(req.headers);
  headers['proxy-authorization'] = buildUpstreamAuth(sessionId);
  const upstream = http.request(
    {
      host: UPSTREAM_PROXY.hostname,
      port: UPSTREAM_PROXY.port,
      method: req.method,
      path: target.href,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    writeJson(res, 502, {
      error: 'upstream_proxy_error',
      message: String(error && error.message ? error.message : error),
    });
  });
  req.pipe(upstream);
}

function proxyConnect(req, clientSocket, head) {
  const sessionId = resolveSessionId(req);
  if (!sessionId && !ALLOW_INSECURE_SESSION_ALLOWLIST) {
    requireProxyAuth(clientSocket);
    return;
  }

  const [rawHost, rawPort] = (req.url || '').split(':', 2);
  const hostname = normalizeHost(rawHost);
  const port = rawPort ? parseInt(rawPort, 10) : 443;
  if (!hostname || Number.isNaN(port) || port <= 0 || port > 65535) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  if (!isHostAllowed(hostname, sessionId)) {
    denyConnect(clientSocket, hostname);
    return;
  }

  if (shouldRouteResidential(hostname, sessionId)) {
    connectViaUpstream(clientSocket, head, hostname, port, sessionId);
    return;
  }

  clientSocket.on('error', () => {
    upstreamSocket?.destroy();
  });

  const upstreamSocket = net.connect(port, hostname, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) {
      upstreamSocket.write(head);
    }
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', () => {
    clientSocket.destroy();
  });
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.length > 1024 * 1024) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function checkAdminToken(req) {
  if (!ADMIN_TOKEN) {
    return ALLOW_INSECURE_ADMIN;
  }
  const provided = (req.headers['x-egress-admin-token'] || '').toString().trim();
  return provided === ADMIN_TOKEN;
}

async function handleAdmin(req, res) {
  if (req.url === '/healthz' && req.method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      default_allowlist_size: DEFAULT_ALLOWLIST.length,
      session_allowlist_size: sessionAllowlist.size,
      upstream_proxy_configured: Boolean(UPSTREAM_PROXY),
    });
    return;
  }

  if (!checkAdminToken(req)) {
    writeJson(res, 401, { error: 'unauthorized' });
    return;
  }

  const parsed = new URL(req.url || '/', 'http://localhost');

  if (req.method === 'PUT' && parsed.pathname === '/allowlist') {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body.session_id || '').trim();
      const targetUrls = Array.isArray(body.target_urls) ? body.target_urls : [];
      // Domain patterns (not URLs) added as-is — e.g. extra_egress_allowlist
      // from an AppTemplate, or auth domains discovered during recording.
      const extraAllowlist = Array.isArray(body.extra_allowlist) ? body.extra_allowlist : [];
      const allowAll = body.allow_all === true;
      const residential = body.residential === true;

      if (!sessionId) {
        writeJson(res, 400, { error: 'session_id_required' });
        return;
      }

      const domains = new Set();
      if (allowAll) {
        domains.add(ALLOW_ALL_SENTINEL);
      }
      for (const targetUrl of targetUrls) {
        const host = extractHostFromTarget(targetUrl);
        if (host) {
          domains.add(host);
        }
      }
      for (const entry of extraAllowlist) {
        const host = normalizeHost(entry);
        if (host) {
          domains.add(host);
        }
      }

      sessionAllowlist.set(sessionId, domains);
      sessionResidential.set(sessionId, residential);
      writeJson(res, 200, {
        updated: true,
        session_id: sessionId,
        domains: Array.from(domains).sort(),
        residential,
      });
      return;
    } catch (error) {
      writeJson(res, 400, {
        error: 'invalid_payload',
        message: String(error && error.message ? error.message : error),
      });
      return;
    }
  }

  if (req.method === 'DELETE' && parsed.pathname.startsWith('/allowlist/')) {
    const sessionId = decodeURIComponent(parsed.pathname.slice('/allowlist/'.length));
    if (!sessionId) {
      writeJson(res, 400, { error: 'session_id_required' });
      return;
    }
    const removed = sessionAllowlist.delete(sessionId);
    sessionResidential.delete(sessionId);
    writeJson(res, 200, { removed, session_id: sessionId });
    return;
  }

  if (req.method === 'GET' && parsed.pathname === '/allowlist') {
    const payload = {};
    for (const [sessionId, domains] of sessionAllowlist.entries()) {
      payload[sessionId] = Array.from(domains).sort();
    }
    writeJson(res, 200, {
      default_allowlist: Array.from(DEFAULT_ALLOWLIST).sort(),
      sessions: payload,
    });
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

const proxyServer = http.createServer(proxyHttpRequest);
proxyServer.on('connect', proxyConnect);
proxyServer.on('clientError', (error, socket) => {
  socket.end(
    'HTTP/1.1 400 Bad Request\r\n' +
      'Connection: close\r\n' +
      `Content-Length: ${Buffer.byteLength(String(error.message || 'bad request'))}\r\n` +
      '\r\n' +
      String(error.message || 'bad request'),
  );
});

const adminServer = http.createServer((req, res) => {
  void handleAdmin(req, res);
});

// Only start listening (and enforce the fail-closed startup guards) when run as
// a script. When required as a module (tests), export the internals instead so
// the routing decisions and the nested-CONNECT tunnel can be exercised directly.
if (require.main === module) {
  if (!ADMIN_TOKEN && !ALLOW_INSECURE_ADMIN) {
    console.error(
      '[egress-proxy] Refusing to start: EGRESS_PROXY_ADMIN_TOKEN is required unless EGRESS_PROXY_ALLOW_INSECURE_ADMIN=true',
    );
    process.exit(1);
  }

  if (!SESSION_KEY && !ALLOW_INSECURE_SESSION_ALLOWLIST) {
    console.error(
      '[egress-proxy] Refusing to start: EGRESS_PROXY_SESSION_KEY is required unless EGRESS_PROXY_ALLOW_INSECURE_SESSION_ALLOWLIST=true',
    );
    process.exit(1);
  }

  proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    log(`Proxy listening on 0.0.0.0:${PROXY_PORT}`);
  });

  adminServer.listen(ADMIN_PORT, '0.0.0.0', () => {
    log(`Admin API listening on 0.0.0.0:${ADMIN_PORT}`);
  });
}

module.exports = {
  proxyServer,
  adminServer,
  sessionAllowlist,
  sessionResidential,
  UPSTREAM_PROXY,
  parseUpstreamProxy,
  hostMatchesList,
  isInfraOrInternal,
  shouldRouteResidential,
  buildUpstreamAuth,
  expectedSessionSecret,
  TABBY_INFRASTRUCTURE_ALLOWLIST,
};
