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

function mockPage(): any {
  return {
    evaluate: jest.fn().mockResolvedValue({ status: 200, headers: {}, body: 'ok' }),
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
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://api.example.com/data',
        method: 'GET',
      }, auth());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(200);
      expect(res.body.body).toBe('ok');
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('returns 502 when page.evaluate throws', async () => {
      page.evaluate.mockRejectedValueOnce(new Error('page crashed'));
      const res = await request(server, 'POST', '/execute/fetch', {
        url: 'https://api.example.com/data',
      }, auth());
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/Browser fetch failed/);
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
      expect(res.body.data).toEqual({ url: 'https://example.com', title: 'Example' });
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
});
