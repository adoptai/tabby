'use strict';

// Integration + unit tests for the egress proxy's residential upstream chaining.
// Run with: node --test charts/browser-hitl/files/egress-proxy/server.test.js
//
// The risky code is the nested-CONNECT tunnel (connect to Oxylabs, send a nested
// CONNECT, parse its 200, splice sockets). These tests stand up a mock upstream
// proxy + a mock origin in-process and drive real CONNECT requests through the
// proxy, covering: happy path (+ sticky sessid), upstream 407, connect timeout,
// allowlist-denied still 403s, non-residential dials direct, and infra bypass.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const http = require('node:http');

const SESSION_ID = 'sess-abc-123-def';
const SANITIZED_SESSION_ID = 'sessabc123def';

// Mock upstream (Oxylabs) proxy — behaviour switched per test via `upstreamMode`.
let upstreamMode = 'ok'; // 'ok' | 'auth' | 'hang'
let upstreamConnects = 0;
let lastUpstreamAuthB64 = null;
let lastUpstreamConnectLine = null;

const upstream = net.createServer((sock) => {
  upstreamConnects += 1;
  let hbuf = Buffer.alloc(0);
  const onData = (chunk) => {
    hbuf = Buffer.concat([hbuf, chunk]);
    const idx = hbuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    sock.removeListener('data', onData);
    const lines = hbuf.slice(0, idx).toString('utf8').split('\r\n');
    lastUpstreamConnectLine = lines[0];
    const authLine = lines.find((l) => /^proxy-authorization:/i.test(l));
    lastUpstreamAuthB64 = authLine ? authLine.replace(/^proxy-authorization:\s*basic\s+/i, '') : null;

    if (upstreamMode === 'auth') {
      sock.write('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n');
      sock.destroy();
      return;
    }
    if (upstreamMode === 'hang') {
      return; // never reply → exercises the client-side connect timeout
    }
    const m = lines[0].match(/^CONNECT\s+([^:]+):(\d+)/);
    const target = net.connect(parseInt(m[2], 10), m[1], () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const leftover = hbuf.slice(idx + 4);
      if (leftover.length) target.write(leftover);
      target.pipe(sock);
      sock.pipe(target);
    });
    target.on('error', () => sock.destroy());
  };
  sock.on('data', onData);
  sock.on('error', () => {});
});

// Mock origin (the "vendor target").
const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
  res.end('OK-ORIGIN');
});

let server; // the module under test
let proxyPort;
let originPort;

function listen(srv) {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
}

test.before(async () => {
  const upstreamPort = await listen(upstream);
  originPort = await listen(origin);

  process.env.EGRESS_PROXY_SESSION_KEY = 'testkey';
  process.env.EGRESS_PROXY_ALLOW_INSECURE_ADMIN = 'true';
  process.env.EGRESS_UPSTREAM_CONNECT_TIMEOUT_MS = '400';
  process.env.EGRESS_UPSTREAM_PROXY_URL =
    `http://user-sessid-{sessionId}:secretpass@127.0.0.1:${upstreamPort}`;

  server = require('./server.js');
  proxyPort = await listen(server.proxyServer);
});

test.after(() => {
  server.proxyServer.close();
  upstream.close();
  origin.close();
});

test.beforeEach(() => {
  upstreamMode = 'ok';
  upstreamConnects = 0;
  lastUpstreamAuthB64 = null;
  lastUpstreamConnectLine = null;
  server.sessionAllowlist.clear();
  server.sessionResidential.clear();
  server.sessionByPodIp.clear();
});

// Drive a CONNECT with NO Proxy-Authorization — exactly what Chromium sends on
// its first attempt, and what browser-process traffic sends always.
function connectWithoutAuth(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let status = null;
    const finish = (extra = {}) => {
      resolve({ status, body: buf.toString('utf8'), ...extra });
      sock.destroy();
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (status === null) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          const line = buf.slice(0, buf.indexOf('\r\n')).toString('utf8');
          const m = line.match(/HTTP\/\d\.\d\s+(\d{3})/);
          status = m ? parseInt(m[1], 10) : 0;
          buf = buf.slice(idx + 4);
          if (status === 200) {
            sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          } else {
            clearTimeout(timer);
            finish();
          }
        }
      }
    });
    sock.on('close', () => { clearTimeout(timer); finish(); });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// Drive a CONNECT through the proxy using a valid session Proxy-Authorization.
function connectThroughProxy(host, port, { sendGet = true, timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    let buf = Buffer.alloc(0);
    let status = null;
    const finish = (extra = {}) => {
      resolve({ status, body: buf.toString('utf8'), ...extra });
      sock.destroy();
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    sock.on('connect', () => {
      const secret = server.expectedSessionSecret(SESSION_ID);
      const auth = Buffer.from(`${SESSION_ID}:${secret}`, 'utf8').toString('base64');
      sock.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n` +
          `Proxy-Authorization: Basic ${auth}\r\n\r\n`,
      );
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (status === null) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx !== -1) {
          const line = buf.slice(0, buf.indexOf('\r\n')).toString('utf8');
          const m = line.match(/HTTP\/\d\.\d\s+(\d{3})/);
          status = m ? parseInt(m[1], 10) : 0;
          buf = buf.slice(idx + 4);
          if (status === 200 && sendGet) {
            sock.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          } else if (status !== 200) {
            clearTimeout(timer);
            finish();
          }
        }
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      finish();
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

test('residential CONNECT tunnels through the upstream and reaches the origin', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);

  const res = await connectThroughProxy('127.0.0.1', originPort);

  assert.strictEqual(res.status, 200, 'proxy established the tunnel');
  assert.match(res.body, /OK-ORIGIN/, 'origin response came back through the tunnel');
  assert.strictEqual(upstreamConnects, 1, 'exactly one upstream dial');
  assert.match(lastUpstreamConnectLine, /^CONNECT 127\.0\.0\.1:/, 'nested CONNECT sent to upstream');
});

test('sticky sessid: sanitized session id is substituted into the upstream username', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);

  await connectThroughProxy('127.0.0.1', originPort);

  const decoded = Buffer.from(lastUpstreamAuthB64, 'base64').toString('utf8');
  assert.ok(decoded.includes(`sessid-${SANITIZED_SESSION_ID}`), `sticky sessid present: ${decoded}`);
  assert.ok(decoded.endsWith(':secretpass'), 'upstream password preserved');
});

test('upstream 407 surfaces to the client as 502', async () => {
  upstreamMode = 'auth';
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);

  const res = await connectThroughProxy('127.0.0.1', originPort, { sendGet: false });

  assert.strictEqual(res.status, 502, 'client gets 502 on upstream auth failure');
});

test('upstream that never responds trips the connect timeout → 502', async () => {
  upstreamMode = 'hang';
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);

  const res = await connectThroughProxy('127.0.0.1', originPort, { sendGet: false, timeoutMs: 3000 });

  assert.strictEqual(res.status, 502, 'client gets 502 after the upstream timeout');
  assert.ok(!res.timedOut, 'proxy answered before the test timeout (timeout path fired)');
});

test('allowlist-denied host still 403s and never touches the upstream', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);

  const res = await connectThroughProxy('evil.example.com', 443, { sendGet: false });

  assert.strictEqual(res.status, 403, 'denied host is 403');
  assert.strictEqual(upstreamConnects, 0, 'upstream never dialled for a denied host');
});

test('non-residential session dials the target directly (upstream untouched)', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, false);

  const res = await connectThroughProxy('127.0.0.1', originPort);

  assert.strictEqual(res.status, 200, 'direct tunnel established');
  assert.match(res.body, /OK-ORIGIN/, 'origin reachable directly');
  assert.strictEqual(upstreamConnects, 0, 'upstream not used for a non-residential session');
});

// --- Pure routing-decision unit tests ---

test('parseUpstreamProxy: empty → null, valid → parsed with decoded username template', () => {
  assert.strictEqual(server.parseUpstreamProxy(''), null);
  const parsed = server.parseUpstreamProxy('http://user-sessid-{sessionId}:p@ss@host.example:7777');
  assert.strictEqual(parsed.hostname, 'host.example');
  assert.strictEqual(parsed.port, 7777);
  assert.strictEqual(parsed.usernameTemplate, 'user-sessid-{sessionId}');
});

test('isInfraOrInternal: adopt.ai + cluster-internal + bare names bypass; external does not', () => {
  assert.strictEqual(server.isInfraOrInternal('cdn.adopt.ai'), true);
  assert.strictEqual(server.isInfraOrInternal('adopt.ai'), true);
  assert.strictEqual(server.isInfraOrInternal('browser-hitl-api'), true, 'single-label service name');
  assert.strictEqual(server.isInfraOrInternal('svc.namespace.svc.cluster.local'), true);
  assert.strictEqual(server.isInfraOrInternal('app.vendor.com'), false, 'external vendor host');
});

test('shouldRouteResidential: precedence honours flag + infra bypass', () => {
  const sid = 'route-test';
  server.sessionResidential.set(sid, true);
  assert.strictEqual(server.shouldRouteResidential('app.vendor.com', sid), true);
  assert.strictEqual(server.shouldRouteResidential('cdn.adopt.ai', sid), false, 'infra never routes residential');
  server.sessionResidential.set(sid, false);
  assert.strictEqual(server.shouldRouteResidential('app.vendor.com', sid), false, 'flag off → direct');
  assert.strictEqual(server.shouldRouteResidential('app.vendor.com', null), false, 'no session → direct');
});

test('buildUpstreamAuth: strips non-alphanumerics from the session id for the sticky sessid', () => {
  const header = server.buildUpstreamAuth('a1b2-c3d4-e5');
  const decoded = Buffer.from(header.replace(/^Basic\s+/, ''), 'base64').toString('utf8');
  assert.ok(decoded.startsWith('user-sessid-a1b2c3d4e5:'), decoded);
});

// --- pod-IP session identity ---------------------------------------------
// Proxy-Authorization only covers requests Playwright manages: the browser
// sends it in response to a 407, and unmanaged traffic (Chromium's own
// browser-process requests) never gets that challenge answered, which surfaced
// as a modal proxy-login prompt that froze the session. Source IP is present on
// every connection, so it covers what the header cannot.

test('pod-IP identity: unauthenticated CONNECT is attributed to the session and routes residential', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);
  server.bindPodIp('127.0.0.1', SESSION_ID); // the test client's source IP

  const res = await connectWithoutAuth('127.0.0.1', originPort);

  assert.strictEqual(res.status, 200, 'no 407 — identity came from the pod IP');
  assert.match(res.body, /OK-ORIGIN/, 'origin reached through the tunnel');
  assert.strictEqual(upstreamConnects, 1, 'residential upstream was used');
});

test('pod-IP identity: without a binding an unauthenticated CONNECT still gets 407', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);
  // no bindPodIp — fail-closed must be preserved

  const res = await connectWithoutAuth('127.0.0.1', originPort);

  assert.strictEqual(res.status, 407, 'unidentified request is still challenged');
  assert.strictEqual(upstreamConnects, 0, 'never reached the upstream');
});

test('pod-IP identity: Proxy-Authorization wins over a conflicting IP binding', async () => {
  server.sessionAllowlist.set(SESSION_ID, new Set(['127.0.0.1']));
  server.sessionResidential.set(SESSION_ID, true);
  // IP claims a DIFFERENT session that is not allowed to reach the origin
  server.sessionByPodIp.set('127.0.0.1', 'other-session');
  server.sessionAllowlist.set('other-session', new Set(['blocked.example']));
  server.sessionResidential.set('other-session', false);

  const res = await connectThroughProxy('127.0.0.1', originPort);

  assert.strictEqual(res.status, 200, 'header-identified session was used, not the IP one');
  assert.strictEqual(upstreamConnects, 1, 'residential flag came from the header session');
});

test('bindPodIp keeps the mapping 1:1 in both directions (pod IPs get recycled)', () => {
  server.sessionByPodIp.clear();

  // same session moves to a new IP → old IP must not linger
  server.bindPodIp('10.0.0.1', 'session-a');
  server.bindPodIp('10.0.0.2', 'session-a');
  assert.strictEqual(server.sessionByPodIp.get('10.0.0.1'), undefined, 'stale IP released');
  assert.strictEqual(server.sessionByPodIp.get('10.0.0.2'), 'session-a');

  // recycled IP reassigned to a new session → newest claim wins
  server.bindPodIp('10.0.0.2', 'session-b');
  assert.strictEqual(server.sessionByPodIp.get('10.0.0.2'), 'session-b', 'recycled IP re-pointed');
  assert.strictEqual(server.sessionByPodIp.size, 1, 'no duplicate claims left behind');

  server.unbindSession('session-b');
  assert.strictEqual(server.sessionByPodIp.size, 0, 'unbind removes every IP for the session');
});

test('normalizeIp strips the IPv4-mapped IPv6 prefix Node reports on dual-stack sockets', () => {
  assert.strictEqual(server.normalizeIp('::ffff:10.244.0.7'), '10.244.0.7');
  assert.strictEqual(server.normalizeIp('10.244.0.7'), '10.244.0.7');
  assert.strictEqual(server.normalizeIp(''), '');
  assert.strictEqual(server.normalizeIp(undefined), '');
  // a mapped address must resolve to the same session as its bare form
  server.sessionByPodIp.clear();
  server.bindPodIp('::ffff:10.244.0.9', 'session-c');
  assert.strictEqual(server.sessionByPodIp.get('10.244.0.9'), 'session-c');
});
