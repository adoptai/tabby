import { ArtifactExtractor } from './artifact-extractor';

// ---------------------------------------------------------------------------
// Mock factories — just enough surface for listener registration + dispatch.
// ---------------------------------------------------------------------------

type PageEvent = 'request' | 'response';

function createMockPage() {
  const handlers: Record<PageEvent, ((arg: unknown) => unknown)[]> = {
    request: [],
    response: [],
  };
  return {
    on: jest.fn((event: PageEvent, handler: (arg: unknown) => unknown) => {
      handlers[event].push(handler);
    }),
    url: jest.fn().mockReturnValue('https://example.com/'),
    _handlers: handlers,
  };
}

function createMockRequest(url: string, headers: Record<string, string>) {
  return {
    url: () => url,
    allHeaders: jest.fn().mockResolvedValue(headers),
  };
}

function createMockResponse(url: string, headers: Record<string, string>) {
  return {
    url: () => url,
    allHeaders: jest.fn().mockResolvedValue(headers),
  };
}

/** Invoke all registered handlers for an event and wait for async work. */
async function fireEvent(page: ReturnType<typeof createMockPage>, event: PageEvent, arg: unknown): Promise<void> {
  await Promise.all(page._handlers[event].map((h) => h(arg)));
}

function buildExtractor(appConfig: Record<string, unknown>) {
  const page = createMockPage();
  const context = {} as any;
  const db = {} as any;
  const extractor = new ArtifactExtractor(
    page as any,
    context,
    appConfig,
    'tenant-1',
    'session-1',
    'app-1',
    db,
  );
  return { extractor, page };
}

// Access the private union helper without exposing it publicly.
function getUnionedHeaders(extractor: ArtifactExtractor): Record<string, Record<string, string>> {
  return (extractor as any).extractHeaders();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArtifactExtractor.registerRequestHeaderCapture', () => {
  it('is a no-op when allowlist is empty', () => {
    const { extractor, page } = buildExtractor({
      export_policy: { request_header_allowlist: [] },
    });
    extractor.registerRequestHeaderCapture();
    expect(page.on).not.toHaveBeenCalled();
  });

  it('captures only allowlisted request headers and preserves configured casing', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: { request_header_allowlist: ['Authorization', 'user_key'] },
    });
    extractor.registerRequestHeaderCapture();
    expect(page.on).toHaveBeenCalledWith('request', expect.any(Function));

    // Playwright returns all headers lowercased.
    await fireEvent(
      page,
      'request',
      createMockRequest('https://api.example.com/search', {
        authorization: 'Bearer jwt.value',
        user_key: 'abc123',
        cookie: 'session=secret-should-not-capture',
        'x-irrelevant': 'drop-me',
      }),
    );

    const result = getUnionedHeaders(extractor);
    expect(result).toEqual({
      'https://api.example.com/search': {
        Authorization: 'Bearer jwt.value',
        user_key: 'abc123',
      },
    });
  });

  it('scopes capture to target_urls when configured', async () => {
    const { extractor, page } = buildExtractor({
      target_urls: ['https://api.example.com/*'],
      export_policy: { request_header_allowlist: ['Authorization'] },
    });
    extractor.registerRequestHeaderCapture();

    await fireEvent(
      page,
      'request',
      createMockRequest('https://api.example.com/search', { authorization: 'Bearer one' }),
    );
    await fireEvent(
      page,
      'request',
      createMockRequest('https://tracker.example.net/beacon', { authorization: 'Bearer two' }),
    );

    const result = getUnionedHeaders(extractor);
    expect(Object.keys(result)).toEqual(['https://api.example.com/search']);
    expect(result['https://api.example.com/search']).toEqual({ Authorization: 'Bearer one' });
  });

  it('matches everything when target_urls is absent', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: { request_header_allowlist: ['Authorization'] },
    });
    extractor.registerRequestHeaderCapture();

    await fireEvent(
      page,
      'request',
      createMockRequest('https://anywhere.internal/x', { authorization: 'Bearer t' }),
    );

    const result = getUnionedHeaders(extractor);
    expect(result['https://anywhere.internal/x']).toEqual({ Authorization: 'Bearer t' });
  });

  it('caps the capture map at HEADER_CAPTURE_URL_CAP (LRU eviction)', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: { request_header_allowlist: ['Authorization'] },
    });
    extractor.registerRequestHeaderCapture();

    // Fire 510 unique URLs; oldest 10 should be evicted.
    for (let i = 0; i < 510; i++) {
      await fireEvent(
        page,
        'request',
        createMockRequest(`https://api.example.com/${i}`, { authorization: `Bearer ${i}` }),
      );
    }

    const result = getUnionedHeaders(extractor);
    expect(Object.keys(result)).toHaveLength(500);
    // URL 0..9 evicted; URL 10..509 retained.
    expect(result['https://api.example.com/0']).toBeUndefined();
    expect(result['https://api.example.com/10']).toBeDefined();
    expect(result['https://api.example.com/509']).toBeDefined();
  });

  it('swallows errors when request.allHeaders() throws (redirected/aborted request)', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: { request_header_allowlist: ['Authorization'] },
    });
    extractor.registerRequestHeaderCapture();

    const badReq = {
      url: () => 'https://api.example.com/bad',
      allHeaders: jest.fn().mockRejectedValue(new Error('aborted')),
    };
    await expect(fireEvent(page, 'request', badReq)).resolves.toBeUndefined();

    const result = getUnionedHeaders(extractor);
    expect(result).toEqual({});
  });
});

describe('ArtifactExtractor header union', () => {
  it('unions response and request maps; request wins on per-URL conflict', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: {
        header_allowlist: ['Authorization', 'Server'],
        request_header_allowlist: ['Authorization'],
      },
    });
    extractor.registerHeaderCapture();
    extractor.registerRequestHeaderCapture();

    const sameUrl = 'https://api.example.com/search';

    // Response has an old bearer + a Server header
    await fireEvent(
      page,
      'response',
      createMockResponse(sameUrl, { authorization: 'Bearer response-old', server: 'nginx' }),
    );

    // Request has the real (outbound) bearer
    await fireEvent(
      page,
      'request',
      createMockRequest(sameUrl, { authorization: 'Bearer request-new' }),
    );

    const result = getUnionedHeaders(extractor);
    expect(result[sameUrl]).toEqual({
      Server: 'nginx',
      Authorization: 'Bearer request-new', // request wins on conflict
    });
  });

  it('keeps response-only URLs intact when no matching request URL exists', async () => {
    const { extractor, page } = buildExtractor({
      export_policy: {
        header_allowlist: ['Server'],
        request_header_allowlist: ['Authorization'],
      },
    });
    extractor.registerHeaderCapture();
    extractor.registerRequestHeaderCapture();

    await fireEvent(page, 'response', createMockResponse('https://a.example/', { server: 'nginx' }));
    await fireEvent(
      page,
      'request',
      createMockRequest('https://b.example/', { authorization: 'Bearer z' }),
    );

    const result = getUnionedHeaders(extractor);
    expect(result).toEqual({
      'https://a.example/': { Server: 'nginx' },
      'https://b.example/': { Authorization: 'Bearer z' },
    });
  });
});
