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
