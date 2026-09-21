import { EventEmitter } from 'events';

// The address guard resolves the host before deciding. Literal IPs are covered by
// the /execute/fetch integration tests; what is only reachable from here is the
// branch where the literal looks innocuous and only DNS reveals it — the shape a
// real attacker uses, since nobody puts 169.254.169.254 in a URL they expect to
// pass a check.
const lookup = jest.fn();
jest.mock('dns', () => ({ lookup: (...args: any[]) => (lookup as any)(...args) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { validateUploadUrl, uploadToPresignedUrl } = require('./presigned-upload');

/** promisify(dns.lookup) calls back (err, addresses) with all:true. */
function resolvesTo(...addresses: string[]) {
  lookup.mockImplementation((_host: string, _opts: any, cb: any) =>
    cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))));
}

describe('validateUploadUrl — DNS resolution', () => {
  beforeEach(() => lookup.mockReset());

  it('refuses a public-looking host that resolves to the metadata address', async () => {
    resolvesTo('169.254.169.254');
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .rejects.toThrow(/resolves to blocked address 169\.254\.169\.254/);
  });

  it('refuses when only one of several answers is internal', async () => {
    // A round-robin record where one A points inward still gets there sometimes.
    resolvesTo('93.184.216.34', '10.0.0.5');
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .rejects.toThrow(/resolves to blocked address 10\.0\.0\.5/);
  });

  it('refuses a host resolving to an IPv6 unique-local address', async () => {
    resolvesTo('fd00::1');
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .rejects.toThrow(/blocked address fd00::1/);
  });

  it('accepts a host that resolves entirely to public addresses', async () => {
    resolvesTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946');
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .resolves.toBe('https://store.example.com/k');
  });

  it('accepts a host that cannot be resolved at all', async () => {
    // Fails open by design: the worker's resolver may differ from the store's, and
    // the NetworkPolicy is the hard boundary. Asserted so the choice is deliberate.
    lookup.mockImplementation((_h: string, _o: any, cb: any) => cb(new Error('ENOTFOUND')));
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .resolves.toBe('https://store.example.com/k');
  });
});

describe('uploadToPresignedUrl — redirects', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it('destroys the source stream instead of leaking it when a redirect is refused', async () => {
    let init: any;
    global.fetch = (async (_u: any, i: any) => {
      init = i;
      return { ok: false, status: 308, text: async () => '' } as any;
    }) as any;

    const source: any = new EventEmitter();
    source.pipe = () => source;
    source.destroy = jest.fn();
    // Readable.toWeb needs a real stream shape; a redirect is detected after the
    // request returns, so the pipeline is already built by then.
    const { Readable } = require('stream');
    const real = Readable.from([Buffer.from('abc')]);
    const destroy = jest.spyOn(real, 'destroy');

    await expect(uploadToPresignedUrl('https://s3.test/k', real, 3, 'application/pdf', 'test'))
      .rejects.toThrow(/redirected \(308\); refusing to follow/);
    expect(init.redirect).toBe('manual');
    expect(destroy).toHaveBeenCalled();
  });
});

// Regression tests for the IPv4-mapped/transitional-encoding bypass. The guard
// used to unwrap `::ffff:a.b.c.d` with a regex that only matched the dotted form,
// but Node normalises `[::ffff:127.0.0.1]` to `::ffff:7f00:1` in URL.hostname, so
// the unwrap never fired and the mapped metadata address was ALLOWED. Each of
// these is a distinct way to write an internal IPv4 destination as IPv6.
describe('validateUploadUrl — IPv4 addresses written as IPv6', () => {
  beforeEach(() => lookup.mockReset());

  // The exact probe vectors from review, as URL literals so the test goes through
  // the same URL.hostname normalisation that defeated the previous check.
  it.each([
    ['http://[::ffff:127.0.0.1]/k', 'mapped loopback, dotted as written'],
    ['http://[::ffff:7f00:1]/k', 'mapped loopback, hex as Node normalises it'],
    ['http://[::ffff:a9fe:a9fe]/k', 'mapped 169.254.169.254, the metadata endpoint'],
    ['http://[64:ff9b::a9fe:a9fe]/k', 'NAT64 well-known prefix embedding the metadata address'],
    ['http://[2002:a9fe:a9fe::1]/k', '6to4 embedding the metadata address'],
  ])('refuses %s (%s)', async (url) => {
    await expect(validateUploadUrl(url, 'test')).rejects.toThrow(/is a blocked address/);
    // Not merely refused for the wrong reason: a literal must never reach DNS.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses a hostname that RESOLVES to a mapped internal address', async () => {
    // The literal check cannot see this one; only the resolved answer reveals it.
    resolvesTo('::ffff:a9fe:a9fe');
    await expect(validateUploadUrl('https://store.example.com/k', 'test'))
      .rejects.toThrow(/blocked address/);
  });

  it('still accepts a public IPv6 literal, so the rule is not "refuse all IPv6"', async () => {
    await expect(validateUploadUrl('https://[2606:4700:4700::1111]/k', 'test'))
      .resolves.toBe('https://[2606:4700:4700::1111]/k');
  });
});

// The PUT must leave the pod the same way the browser's traffic does. Nothing
// else constrains worker egress: the chart has no NetworkPolicy selecting the
// worker component, so a PUT on Node's default dispatcher would be the one path
// out that no host allowlist applies to.
describe('egressDispatcher — the PUT goes through the browser egress proxy', () => {
  const saved = process.env.EGRESS_PROXY_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.EGRESS_PROXY_URL;
    else process.env.EGRESS_PROXY_URL = saved;
    jest.resetModules();
  });

  function freshEgressDispatcher() {
    // The agent is cached per URL, so each case needs a fresh module registry.
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./presigned-upload').egressDispatcher;
  }

  it('returns no dispatcher when no proxy is configured, so local dev goes direct', () => {
    delete process.env.EGRESS_PROXY_URL;
    expect(freshEgressDispatcher()()).toBeUndefined();
  });

  it('returns a dispatcher when a proxy is configured', () => {
    process.env.EGRESS_PROXY_URL = 'http://egress-proxy:3128';
    expect(freshEgressDispatcher()()).toBeDefined();
  });

  it('reuses one agent across calls rather than leaking a connection pool per upload', () => {
    process.env.EGRESS_PROXY_URL = 'http://egress-proxy:3128';
    const egress = freshEgressDispatcher();
    expect(egress()).toBe(egress());
  });

  it('refuses an unparseable proxy URL instead of silently going direct', () => {
    // Failing open here would put the PUT back outside the allowlist, which is the
    // exact hole this routing closes — so it must throw, not fall back.
    process.env.EGRESS_PROXY_URL = 'not a url';
    expect(() => freshEgressDispatcher()()).toThrow(/not a valid URL/);
  });
});
