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

const sessionAllowlist = new Map();

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

  const allowlist = new Set(DEFAULT_ALLOWLIST);
  if (sessionId) {
    const sessionDomains = sessionAllowlist.get(sessionId);
    if (sessionDomains) {
      for (const domain of sessionDomains) {
        allowlist.add(domain);
      }
    }
  } else if (ALLOW_INSECURE_SESSION_ALLOWLIST) {
    for (const domains of sessionAllowlist.values()) {
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

      if (!sessionId) {
        writeJson(res, 400, { error: 'session_id_required' });
        return;
      }

      const domains = new Set();
      for (const targetUrl of targetUrls) {
        const host = extractHostFromTarget(targetUrl);
        if (host) {
          domains.add(host);
        }
      }

      sessionAllowlist.set(sessionId, domains);
      writeJson(res, 200, {
        updated: true,
        session_id: sessionId,
        domains: Array.from(domains).sort(),
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
