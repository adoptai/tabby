import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import express from 'express';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { registerExecuteHandler } from './execute-handler';
import { registerBrowserHandler } from './execute-browser-handler';

const TEST_KEY = 'test-jwt-signing-key-minimum-32-characters-long';
const TEST_TENANT = 'tenant-test-123';

function signToken(claims: Record<string, any> = {}, expiresIn: string = '2m'): string {
  const secret: jwt.Secret = TEST_KEY;
  const options: jwt.SignOptions = { algorithm: 'HS256', expiresIn: expiresIn as any };
  return jwt.sign(
    { sub: 'execute-proxy', tenant_id: TEST_TENANT, ...claims },
    secret,
    options,
  );
}

function mockApiResponse(overrides: Record<string, any> = {}) {
  return {
    status: jest.fn().mockReturnValue(200),
    headers: jest.fn().mockReturnValue({ 'content-type': 'application/json' }),
    body: jest.fn().mockResolvedValue(Buffer.from('{"via":"context"}')),
    ...overrides,
  };
}

function mockPage(overrides: { contextFetch?: jest.Mock } = {}): any {
  const contextFetch = overrides.contextFetch
    ?? jest.fn().mockResolvedValue(mockApiResponse());
  return {
    evaluate: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: 'ok' }),
    // Cross-origin / CSP-refused fetches are served off-page through the
    // BrowserContext's APIRequestContext, which shares its cookie jar.
    context: jest.fn().mockReturnValue({ request: { fetch: contextFetch } }),
    goto: jest.fn().mockResolvedValue(undefined),
    url: jest.fn().mockReturnValue('https://example.com'),
    title: jest.fn().mockResolvedValue('Example'),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('png-data')),
    locator: jest.fn().mockReturnValue({
      click: jest.fn().mockResolvedValue(undefined),
      fill: jest.fn().mockResolvedValue(undefined),
      waitFor: jest.fn().mockResolvedValue(undefined),
    }),
    getByText: jest.fn().mockReturnValue({ click: jest.fn().mockResolvedValue(undefined) }),
    getByLabel: jest.fn().mockReturnValue({ fill: jest.fn().mockResolvedValue(undefined) }),
    mouse: { click: jest.fn().mockResolvedValue(undefined), wheel: jest.fn().mockResolvedValue(undefined) },
    keyboard: { press: jest.fn().mockResolvedValue(undefined) },
    on: jest.fn(),
    removeListener: jest.fn(),
  };
}

function request(
  server: http.Server,
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, 'http://localhost');
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: 'localhost',
        port: (server.address() as any).port,
        path: url.pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('execute handlers (integration)', () => {
  let server: http.Server;
  let page: any;

  beforeAll((done) => {
    // Set env vars for auth middleware
    process.env.JWT_SIGNING_KEY = TEST_KEY;
    process.env.TENANT_ID = TEST_TENANT;

    // Dynamic require so env vars are read fresh
    const { executeAuthMiddleware } = require('./execute-auth');

    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/execute', executeAuthMiddleware);

    page = mockPage();
    registerExecuteHandler(app, page);
    registerBrowserHandler(app, page);

    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
    delete process.env.JWT_SIGNING_KEY;
    delete process.env.TENANT_ID;
  });

  // ─── Auth middleware ─────────────────────────────────────────────

  describe('auth middleware', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(server, 'POST', '/execute/fetch', { url: 'https://example.com' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Missing or invalid Authorization/);
    });

    it('returns 401 for an expired token', async () => {
      const token = signToken({}, '-1s');
      const res = await request(server, 'POST', '/execute/fetch', { url: 'https://example.com' }, {
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid or expired/);
    });

    it('returns 401 for a token signed with the wrong key', async () => {
      const badSecret: jwt.Secret = 'wrong-secret-key-also-32-chars-long!';
      const badToken = jwt.sign({ sub: 'x' }, badSecret, { algorithm: 'HS256' } as jwt.SignOptions);
      const res = await request(server, 'POST', '/execute/fetch', { url: 'https://example.com' }, {
        Authorization: `Bearer ${badToken}`,
      });
      expect(res.status).toBe(401);
    });

    it('returns 403 when tenant_id does not match worker TENANT_ID', async () => {
      const token = signToken({ tenant_id: 'wrong-tenant' });
      const res = await request(server, 'POST', '/execute/fetch', { url: 'https://example.com' }, {
        Authorization: `Bearer ${token}`,
      });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/tenant mismatch/i);
    });

    it('passes through with a valid token', async () => {
      const token = signToken();
      const res = await request(server, 'POST', '/execute/fetch', { url: 'https://example.com' }, {
        Authorization: `Bearer ${token}`,
      });
      // Should reach the handler (200) not the middleware (401/403)
      expect(res.status).toBe(200);
    });
  });

  // ─── Execute fetch handler ───────────────────────────────────────

  describe('/execute/fetch', () => {
    const auth = () => ({ Authorization: `Bearer ${signToken()}` });

    it('returns 400 for missing url', async () => {
      const res = await request(server, 'POST', '/execute/fetch', { method: 'GET' }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Missing or invalid "url"/);
    });

    it('returns 400 for invalid URL', async () => {
      const res = await request(server, 'POST', '/execute/fetch', { url: 'not-a-url' }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid URL/);
    });

    it('returns 400 for disallowed scheme', async () => {
      const res = await request(server, 'POST', '/execute/fetch', { url: 'ftp://files.example.com' }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Scheme.*not allowed/);
    });

    it('returns 400 for too many headers', async () => {
      const headers: Record<string, string> = {};
      for (let i = 0; i < 51; i++) headers[`X-H-${i}`] = 'v';
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://example.com',
        headers,
      }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Too many headers/);
    });

    it('returns 200 with page.evaluate result for valid request', async () => {
      // Same-origin as page.url() so this still exercises the in-page path.
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://example.com/data',
        method: 'GET',
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(200);
      expect(res.body.body).toBe('ok');
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('returns 502 only when both the in-page and off-page fetches fail', async () => {
      // A failed in-page fetch now retries through the BrowserContext (CSP /
      // service-worker refusals are recoverable there), so 502 means both failed.
      page.evaluate.mockRejectedValueOnce(new Error('page crashed'));
      (page.context().request.fetch as jest.Mock)
        .mockRejectedValueOnce(new Error('context unreachable'));
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://example.com/data',
      }, auth());
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Browser fetch failed/);
    });

    it('passes through base64 encoding + truncated flags for binary responses', async () => {
      page.evaluate.mockResolvedValueOnce({
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: 'JVBERi0xLjM=', // base64("%PDF-1.3")
        encoding: 'base64',
        truncated: false,
      });
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://example.com/statement.pdf',
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.encoding).toBe('base64');
      expect(res.body.truncated).toBe(false);
      expect(res.body.body).toBe('JVBERi0xLjM=');
    });
  });

  // ─── Execute browser handler ─────────────────────────────────────

  describe('/execute/browser', () => {
    const auth = () => ({ Authorization: `Bearer ${signToken()}` });

    it('returns 400 for missing command', async () => {
      const res = await request(server, 'POST', '/execute/browser', { params: {} }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Missing or invalid "command"/);
    });

    it('returns 400 for unknown command', async () => {
      const res = await request(server, 'POST', '/execute/browser', {
        command: 'eval_arbitrary_js',
        params: {},
      }, auth());
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Unknown command/);
    });

    it('returns success for get_page_info command', async () => {
      const res = await request(server, 'POST', '/execute/browser', {
        command: 'get_page_info',
        params: {},
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // ready_state too: a caller deciding whether it may act next needs to know
      // whether the page has finished loading, not only where it is.
      expect(res.body.data).toEqual({
        url: 'https://example.com', title: 'Example', ready_state: expect.any(String),
      });
    });

    it('returns success for screenshot command', async () => {
      const res = await request(server, 'POST', '/execute/browser', {
        command: 'screenshot',
        params: {},
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.mimeType).toBe('image/png');
      expect(res.body.data.base64).toBeTruthy();
    });

    it('returns error for navigate with missing url param', async () => {
      const res = await request(server, 'POST', '/execute/browser', {
        command: 'navigate',
        params: {},
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/Missing required parameter: url/);
    });

    it('returns error for navigate with disallowed scheme', async () => {
      const res = await request(server, 'POST', '/execute/browser', {
        command: 'navigate',
        params: { url: 'file:///etc/passwd' },
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toMatch(/not allowed/);
    });
  });


  // ─── Cross-origin routing ────────────────────────────────────────

  describe('cross-origin routing', () => {
    // An in-page fetch() carries the page's origin, so a target that sends no CORS
    // headers fails as "TypeError: Failed to fetch" even with a perfectly valid
    // session. Multi-origin apps are the norm for bank portals (ICICI serves its
    // dashboard from retailnetbanking.icici.bank.in and its statement APIs from
    // infinity.icici.bank.in), so those calls must go off-page through the
    // BrowserContext, which shares cookies but attaches no origin.
    let contextFetch: jest.Mock;

    beforeEach(() => {
      contextFetch = page.context().request.fetch as jest.Mock;
      contextFetch.mockReset();
      contextFetch.mockResolvedValue(mockApiResponse());
      (page.evaluate as jest.Mock).mockReset();
      (page.evaluate as jest.Mock).mockResolvedValue({
        status: 200, headers: {}, body: 'in-page', encoding: 'utf-8', truncated: false,
      });
      (page.url as jest.Mock).mockReturnValue('https://example.com/dashboard');
    });

    it('routes a cross-origin target off-page so CORS cannot block it', async () => {
      const res = await request(
        server, 'POST', '/execute/fetch',
        { url: 'https://other-host.example/v1/statement' },
        { Authorization: `Bearer ${signToken()}` },
      );
      expect(res.status).toBe(200);
      expect(contextFetch).toHaveBeenCalledTimes(1);
      expect(page.evaluate).not.toHaveBeenCalled();
      expect(res.body.body).toBe('{"via":"context"}');
    });

    it('keeps same-origin calls in the page so JS interceptors still run', async () => {
      const res = await request(
        server, 'POST', '/execute/fetch',
        { url: 'https://example.com/dashboardAPI/summary' },
        { Authorization: `Bearer ${signToken()}` },
      );
      expect(res.status).toBe(200);
      expect(page.evaluate).toHaveBeenCalledTimes(1);
      expect(contextFetch).not.toHaveBeenCalled();
      expect(res.body.body).toBe('in-page');
    });

    it('falls back off-page when a same-origin fetch is refused (CSP, service worker)', async () => {
      (page.evaluate as jest.Mock).mockRejectedValue(new Error('TypeError: Failed to fetch'));
      const res = await request(
        server, 'POST', '/execute/fetch',
        { url: 'https://example.com/dashboardAPI/summary' },
        { Authorization: `Bearer ${signToken()}` },
      );
      expect(res.status).toBe(200);
      expect(contextFetch).toHaveBeenCalledTimes(1);
      expect(res.body.body).toBe('{"via":"context"}');
    });

    it('reports the target status instead of throwing on 4xx', async () => {
      // Callers need to see a 401/403 to react to it; failOnStatusCode must stay off.
      contextFetch.mockResolvedValue(mockApiResponse({ status: jest.fn().mockReturnValue(403) }));
      const res = await request(
        server, 'POST', '/execute/fetch',
        { url: 'https://other-host.example/v1/statement' },
        { Authorization: `Bearer ${signToken()}` },
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(403);
    });
  });
});

describe('/execute/fetch upload_url sink', () => {
  const TEST_KEY2 = 'test-jwt-signing-key-minimum-32-characters-long';
  let server: http.Server;
  let contextFetch: jest.Mock;
  const realFetch = global.fetch;

  /** Stand in for the object store, draining whatever is PUT to it. */
  function stubStore(status = 200) {
    const seen: { url?: string; headers?: any; body: Buffer } = { body: Buffer.alloc(0) };
    global.fetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.headers = init.headers;
      const src = init.body;
      if (src && typeof src[Symbol.asyncIterator] === 'function') {
        const chunks: Buffer[] = [];
        for await (const c of src) chunks.push(Buffer.from(c));
        seen.body = Buffer.concat(chunks);
      } else if (src) {
        seen.body = Buffer.from(src);
      }
      return { ok: status >= 200 && status < 300, status, text: async () => 'store says no' } as any;
    }) as any;
    return seen;
  }

  /** An upstream response with the headers a real export carries. */
  function upstream(over: Record<string, any> = {}) {
    return {
      status: jest.fn().mockReturnValue(over.status ?? 200),
      headers: jest.fn().mockReturnValue(over.headers ?? {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="Flux.xlsx"',
      }),
      body: jest.fn().mockResolvedValue(over.body ?? Buffer.from('PK\x03\x04 xlsx bytes')),
    };
  }

  beforeAll((done) => {
    process.env.JWT_SIGNING_KEY = TEST_KEY2;
    process.env.TENANT_ID = TEST_TENANT;
    const { executeAuthMiddleware } = require('./execute-auth');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/execute', executeAuthMiddleware);
    contextFetch = jest.fn();
    registerExecuteHandler(app, mockPage({ contextFetch }));
    server = app.listen(0, done);
  });

  afterAll((done) => { server.close(done); });
  beforeEach(() => { contextFetch.mockClear(); });
  afterEach(() => { global.fetch = realFetch; });

  const auth = () => ({ Authorization: `Bearer ${signToken()}` });
  const call = (body: any) => request(server, 'POST', '/execute/fetch', body, auth());

  it('streams an attachment to the store and returns metadata, not bytes', async () => {
    const bytes = Buffer.from('PK\x03\x04 a real spreadsheet');
    contextFetch.mockResolvedValue(upstream({ body: bytes }));
    const seen = stubStore();

    const res = await call({ url: 'https://wd5.workday.com/doc?download=true', upload_url: 'https://s3.test/k?sig=1' });

    expect(res.status).toBe(200);
    expect(seen.body.equals(bytes)).toBe(true);
    expect(res.body.uploaded.uploaded).toBe(true);
    expect(res.body.uploaded.size_bytes).toBe(bytes.length);
    expect(res.body.uploaded.filename).toBe('Flux.xlsx');
    expect(res.body.uploaded.sha256).toHaveLength(64);
    // The bytes must not also come back inline — that is the whole point.
    expect(res.body.body).not.toContain('PK');
    expect(res.body.encoding).toBe('utf-8');
  });

  it('refuses to store an auth wall that answers 200 with an HTML login page', async () => {
    // Exactly what Workday returns for a document URL once the session lapses:
    // 200, text/html, a JS redirect to login — and no content-disposition.
    const login = Buffer.from('<html><script>var redirectUrl="/login.htmld"</script></html>');
    contextFetch.mockResolvedValue(upstream({
      headers: { 'content-type': 'text/html;charset=UTF-8' },
      body: login,
    }));
    const seen = stubStore();

    const res = await call({ url: 'https://wd5.workday.com/doc', upload_url: 'https://s3.test/k' });

    expect(res.body.uploaded.uploaded).toBe(false);
    expect(res.body.uploaded.skipped_reason).toMatch(/not an attachment/);
    expect(seen.url).toBeUndefined(); // nothing was PUT anywhere
    // The caller gets the page itself, so it can see WHY and re-login.
    expect(res.body.body).toContain('login.htmld');
  });

  it('uploads a non-attachment anyway when the caller insists', async () => {
    const csv = Buffer.from('col1,col2\n1,2');
    contextFetch.mockResolvedValue(upstream({ headers: { 'content-type': 'text/csv' }, body: csv }));
    const seen = stubStore();

    const res = await call({
      url: 'https://x.test/export.csv', upload_url: 'https://s3.test/k', upload_always: true,
    });

    expect(res.body.uploaded.uploaded).toBe(true);
    expect(seen.body.equals(csv)).toBe(true);
  });

  it('never stores the body of a failed upstream request', async () => {
    contextFetch.mockResolvedValue(upstream({
      status: 403,
      headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="x.xlsx"' },
      body: Buffer.from('Forbidden'),
    }));
    const seen = stubStore();

    const res = await call({ url: 'https://x.test/doc', upload_url: 'https://s3.test/k' });

    expect(res.body.status).toBe(403);
    expect(res.body.uploaded.uploaded).toBe(false);
    expect(res.body.uploaded.skipped_reason).toMatch(/403/);
    expect(seen.url).toBeUndefined();
  });

  it('fails loudly over the sink limit rather than storing a short object', async () => {
    const huge = Buffer.alloc(16, 1);
    Object.defineProperty(huge, 'length', { value: EXECUTE_LIMITS.MAX_SINK_BODY_BYTES + 1 });
    contextFetch.mockResolvedValue(upstream({ body: huge }));
    const seen = stubStore();

    const res = await call({ url: 'https://x.test/big.xlsx', upload_url: 'https://s3.test/k' });

    // 413, not a truncated upload: a short object in the store is a file nobody
    // finds out is broken until they open it.
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/sink limit/);
    expect(res.body.error).toMatch(/put_download/); // names the route that has no ceiling
    expect(seen.url).toBeUndefined();
  });

  it('surfaces a store rejection instead of reporting success', async () => {
    contextFetch.mockResolvedValue(upstream());
    stubStore(403);
    const res = await call({ url: 'https://x.test/doc', upload_url: 'https://s3.test/k' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/403/);
  });

  it('rejects a bad upload_url before fetching anything', async () => {
    contextFetch.mockResolvedValue(upstream());
    const res = await call({ url: 'https://x.test/doc', upload_url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/);
    expect(contextFetch).not.toHaveBeenCalled();
  });

  it('leaves the ordinary inline path untouched when no upload_url is given', async () => {
    contextFetch.mockResolvedValue(upstream({
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"ok":true}'),
    }));
    const res = await call({ url: 'https://other.test/api' });
    expect(res.body.uploaded).toBeUndefined();
    expect(res.body.body).toBe('{"ok":true}');
  });
});

describe('/execute/fetch sink — review follow-ups', () => {
  let server: http.Server;
  let contextFetch: jest.Mock;
  const realFetch = global.fetch;

  function stubStore(status = 200) {
    const seen: { url?: string; headers?: any } = {};
    global.fetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.headers = init.headers;
      if (init.body && typeof init.body[Symbol.asyncIterator] === 'function') {
        for await (const _c of init.body) { /* drain */ }
      }
      return { ok: status >= 200 && status < 300, status, text: async () => 'SECRET-INTERNAL-BODY' } as any;
    }) as any;
    return seen;
  }

  beforeAll((done) => {
    process.env.JWT_SIGNING_KEY = TEST_KEY;
    process.env.TENANT_ID = TEST_TENANT;
    const { executeAuthMiddleware } = require('./execute-auth');
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/execute', executeAuthMiddleware);
    contextFetch = jest.fn();
    registerExecuteHandler(app, mockPage({ contextFetch }));
    server = app.listen(0, done);
  });
  afterAll((done) => { server.close(done); });
  beforeEach(() => { contextFetch.mockClear(); });
  afterEach(() => { global.fetch = realFetch; });

  const call = (body: any) =>
    request(server, 'POST', '/execute/fetch', body, { Authorization: `Bearer ${signToken()}` });

  it('refuses an oversized response on content-length, before reading the body', async () => {
    // The point of the limit is to not hold the response. Checking only after
    // resp.body() would materialise the whole thing to decide it was too big.
    const bodyFn = jest.fn();
    contextFetch.mockResolvedValue({
      status: () => 200,
      headers: () => ({
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': 'attachment; filename="huge.xlsx"',
        'content-length': String(EXECUTE_LIMITS.MAX_SINK_BODY_BYTES + 1),
      }),
      body: bodyFn,
    });
    const seen = stubStore();

    const res = await call({ url: 'https://x.test/huge.xlsx', upload_url: 'https://s3.test/k' });

    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/content-length/);
    expect(bodyFn).not.toHaveBeenCalled(); // never buffered
    expect(seen.url).toBeUndefined();
  });

  it('refuses an internal upload_url before fetching anything', async () => {
    // upload_url is caller-supplied and the PUT does not go through the browser's
    // egress allowlist, so cloud metadata and internal services must be refused here.
    for (const target of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:9000/bucket/key',
      'http://10.0.0.5/internal',
      'http://[::1]:9000/k',
    ]) {
      const res = await call({ url: 'https://x.test/doc', upload_url: target });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/blocked address/);
    }
    expect(contextFetch).not.toHaveBeenCalled();
  });

  it('does not echo the object store response body back to the caller', async () => {
    contextFetch.mockResolvedValue({
      status: () => 200,
      headers: () => ({
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="a.pdf"',
      }),
      body: async () => Buffer.from('%PDF'),
    });
    stubStore(403);
    const res = await call({ url: 'https://x.test/doc', upload_url: 'https://s3.test/k' });
    // Returning an arbitrary host's body would make this a read oracle.
    expect(res.body.error).toMatch(/403/);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-INTERNAL-BODY');
  });

  it('does not let caller upload_headers override the computed Content-Length', async () => {
    contextFetch.mockResolvedValue({
      status: () => 200,
      headers: () => ({
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="a.pdf"',
      }),
      body: async () => Buffer.from('%PDF-1.4 twenty-ish bytes'),
    });
    const seen = stubStore();
    await call({
      url: 'https://x.test/doc',
      upload_url: 'https://s3.test/k',
      upload_headers: { 'Content-Length': '1', 'Content-Type': 'text/plain', 'x-amz-acl': 'private' },
    });
    expect(seen.headers['Content-Length']).toBe('25');       // real size wins
    expect(seen.headers['Content-Type']).toBe('application/pdf');
    expect(seen.headers['x-amz-acl']).toBe('private');       // unrelated ones still pass
  });

  it('base64s a skipped binary instead of mangling it with a UTF-8 decode', async () => {
    // A skipped response is usually an HTML auth wall, but a non-2xx with a binary
    // body must survive rather than come back as U+FFFD soup.
    const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xc3, 0x28, 0xff, 0xfe]);
    contextFetch.mockResolvedValue({
      status: () => 500,
      headers: () => ({ 'content-type': 'application/pdf' }),
      body: async () => pdf,
    });
    stubStore();
    const res = await call({ url: 'https://x.test/doc', upload_url: 'https://s3.test/k' });
    expect(res.body.uploaded.uploaded).toBe(false);
    expect(res.body.encoding).toBe('base64');
    expect(Buffer.from(res.body.body, 'base64').equals(pdf)).toBe(true);
  });

  it('still returns a skipped HTML auth wall as readable text', async () => {
    contextFetch.mockResolvedValue({
      status: () => 200,
      headers: () => ({ 'content-type': 'text/html;charset=UTF-8' }),
      body: async () => Buffer.from('<script>var redirectUrl="/login.htmld"</script>'),
    });
    stubStore();
    const res = await call({ url: 'https://x.test/doc', upload_url: 'https://s3.test/k' });
    expect(res.body.encoding).toBe('utf-8');
    expect(res.body.body).toContain('login.htmld');
  });
});
