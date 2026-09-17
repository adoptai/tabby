import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import { enableDownloadCapture, listDownloads, getDownload, putDownload, markBrowserPolicyAbsent } from './download-capture';

// Drive the module with a mock Playwright context/page/download. enableDownloadCapture
// attaches page.on('download'); we capture that handler and fire it with a fake
// Download whose saveAs writes real bytes to the temp path the module chose.
function setup() {
  let dlHandler: (d: any) => Promise<void>;
  const ctx: any = {
    on: () => {},
    pages: () => [page],
  };
  const page: any = {
    on: (ev: string, cb: any) => {
      if (ev === 'download') dlHandler = cb;
    },
    context: () => ctx,
  };
  enableDownloadCapture(ctx);
  return { page, fire: (d: any) => dlHandler(d) };
}

function fakeDownload(name: string, bytes: Buffer) {
  return {
    suggestedFilename: () => name,
    url: () => `https://bank.test/${name}`,
    saveAs: async (dest: string) => {
      await fs.writeFile(dest, bytes);
    },
  };
}

/** A download whose file is sparse: a real size to stat(), no real bytes. */
function fakeSparseDownload(name: string, size: number) {
  return {
    suggestedFilename: () => name,
    url: () => `https://bank.test/${name}`,
    saveAs: async (dest: string) => {
      const fh = await fs.open(dest, 'w');
      await fh.truncate(size);
      await fh.close();
    },
  };
}

describe('download-capture', () => {
  it('captures a download, lists it (path-free), and returns base64 bytes', async () => {
    const { page, fire } = setup();
    const bytes = Buffer.from('%PDF-1.4 fake statement body');
    await fire(fakeDownload('statement.pdf', bytes));

    const list = listDownloads(page);
    expect(list.downloads).toHaveLength(1);
    const meta = list.downloads[0];
    expect(meta.suggested_filename).toBe('statement.pdf');
    expect(meta.state).toBe('completed');
    expect(meta.mime_type).toBe('application/pdf');
    expect(meta.size_bytes).toBe(bytes.length);
    expect((meta as any).path).toBeUndefined(); // never leak the on-disk path

    const got = await getDownload(page); // latest completed
    expect(got.filename).toBe('statement.pdf');
    expect(got.mime_type).toBe('application/pdf');
    expect(Buffer.from(got.base64, 'base64').equals(bytes)).toBe(true);
  });

  it('get_download returns a specific id and defaults to the newest completed', async () => {
    const { page, fire } = setup();
    await fire(fakeDownload('a.csv', Buffer.from('col1,col2')));
    await fire(fakeDownload('b.pdf', Buffer.from('%PDF b')));

    const first = listDownloads(page).downloads[0];
    const byId = await getDownload(page, first.id);
    expect(byId.filename).toBe('a.csv');
    expect(byId.mime_type).toBe('text/csv');

    const latest = await getDownload(page); // newest
    expect(latest.filename).toBe('b.pdf');
  });

  it('throws a clear error when no completed download exists', async () => {
    const { page } = setup();
    await expect(getDownload(page)).rejects.toThrow(/no completed download/);
  });

  it('throws for an unknown id', async () => {
    const { page, fire } = setup();
    await fire(fakeDownload('x.pdf', Buffer.from('x')));
    await expect(getDownload(page, 'dl-nope')).rejects.toThrow(/no download with id/);
  });

  // browser_policy.downloads=false means main.ts never calls
  // enableDownloadCapture and cancels each download as it starts. The list is
  // then permanently empty, and an empty list alone is indistinguishable from
  // "the click did nothing" -- which is how a replay reported "no file
  // arrived" for a step that worked, and a member was asked to waive the one
  // operation they came for.
  it('flags a context that is not capturing, so an empty list is not read as a failed click', () => {
    const page: any = { on: () => {}, context: () => ({}) };
    const list = listDownloads(page);
    expect(list.downloads).toEqual([]);
    expect(list.disabled_by_policy).toBe(true);
  });

  it('does not flag a capturing context, even before any download arrives', () => {
    const { page } = setup();
    const list = listDownloads(page);
    expect(list.downloads).toEqual([]);
    expect(list.disabled_by_policy).toBeUndefined();
  });

  // A MISSING browser_policy and one that says downloads:false both fall back to
  // the same defaults in main.ts and were reported identically. They call for
  // opposite responses: a deliberate false is a decision to respect, while a
  // missing policy means the app was never configured -- which is what an app
  // orphaned from its template looks like, and what hid that bug for two runs.
  it('separates an app with NO browser policy from one whose policy says no', () => {
    const context: any = {};
    const page: any = { on: () => {}, context: () => context };

    // Policy says no: flagged, but not as a configuration fault.
    expect(listDownloads(page).disabled_by_policy).toBe(true);
    expect(listDownloads(page).policy_absent).toBeUndefined();

    markBrowserPolicyAbsent(context);

    const absent = listDownloads(page);
    expect(absent.disabled_by_policy).toBe(true);
    expect(absent.policy_absent).toBe(true);
  });

  it('never claims a policy is absent on a context that is capturing', () => {
    // enableDownloadCapture wins: a capturing context had a policy that said yes.
    const { page } = setup();
    markBrowserPolicyAbsent(page.context());
    const list = listDownloads(page);
    expect(list.disabled_by_policy).toBeUndefined();
    expect(list.policy_absent).toBeUndefined();
  });
});

describe('put_download', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  /** Capture what was PUT by draining the streamed body the way S3 would. */
  function stubUpload(status = 200) {
    const seen: { url?: string; headers?: any; body: Buffer } = { body: Buffer.alloc(0) };
    global.fetch = (async (url: any, init: any) => {
      seen.url = String(url);
      seen.headers = init.headers;
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as any) chunks.push(Buffer.from(chunk));
      seen.body = Buffer.concat(chunks);
      return { ok: status >= 200 && status < 300, status, text: async () => 'denied' } as any;
    }) as any;
    return seen;
  }

  it('streams the file to the presigned URL and returns size and sha256', async () => {
    const { page, fire } = setup();
    const bytes = Buffer.from('PK\x03\x04 pretend xlsx payload');
    await fire(fakeDownload('report.xlsx', bytes));
    const seen = stubUpload();

    const res = await putDownload(page, { upload_url: 'https://s3.test/bucket/key?sig=1' });

    expect(seen.url).toBe('https://s3.test/bucket/key?sig=1');
    // The bytes S3 receives must be the file, unchanged — this is the whole point.
    expect(seen.body.equals(bytes)).toBe(true);
    expect(seen.headers['Content-Length']).toBe(String(bytes.length));
    expect(seen.headers['Content-Type'])
      .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.size_bytes).toBe(bytes.length);
    expect(res.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(res.upload_status).toBe(200);
  });

  it('has no size ceiling, unlike get_download', async () => {
    const { page, fire } = setup();
    // One byte past the inline cap: get_download must refuse it, put_download must not.
    const big = Buffer.alloc(EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES + 1, 7);
    await fire(fakeDownload('big.xlsx', big));
    const seen = stubUpload();

    await expect(getDownload(page)).rejects.toThrow(/inline limit/);
    const res = await putDownload(page, { upload_url: 'https://s3.test/k' });
    expect(res.size_bytes).toBe(big.length);
    expect(seen.body.length).toBe(big.length);
  });

  it('releases the local copy on success and says so afterwards', async () => {
    const { page, fire } = setup();
    await fire(fakeDownload('once.xlsx', Buffer.from('abc')));
    stubUpload();

    await putDownload(page, { upload_url: 'https://s3.test/k' });

    // The bytes are in the object store; keeping a second copy on the pod's
    // ephemeral disk is what the byte budget exists to prevent.
    const meta = listDownloads(page).downloads[0];
    expect(meta.uploaded_at).toBeTruthy();
    await expect(getDownload(page)).rejects.toThrow(/already uploaded/);
  });

  it('keeps the file when the store rejects the upload, so a retry can work', async () => {
    const { page, fire } = setup();
    const bytes = Buffer.from('retry me');
    await fire(fakeDownload('r.xlsx', bytes));
    stubUpload(403);

    // An expired presigned URL is the common case, and it must not cost the file.
    await expect(putDownload(page, { upload_url: 'https://s3.test/k' }))
      .rejects.toThrow(/403/);

    const seen = stubUpload(200);
    const res = await putDownload(page, { upload_url: 'https://s3.test/k2' });
    expect(res.size_bytes).toBe(bytes.length);
    expect(seen.body.equals(bytes)).toBe(true);
  });

  it('refuses a missing or non-http upload_url', async () => {
    const { page, fire } = setup();
    await fire(fakeDownload('x.pdf', Buffer.from('%PDF')));
    await expect(putDownload(page, { upload_url: '' })).rejects.toThrow(/required/);
    await expect(putDownload(page, { upload_url: 'file:///etc/passwd' }))
      .rejects.toThrow(/not allowed/);
  });

  it('evicts older files once the retained bytes exceed the budget', async () => {
    const { page, fire } = setup();
    // Two files that together exceed 1GB. A count-based cap alone keeps 20 of
    // these — several GB of ephemeral disk, which the kubelet answers by
    // evicting the pod rather than by any error the caller can see.
    //
    // Sparse, so the sizes are real to stat() without costing 1.4GB of RAM and
    // disk on every CI run.
    await fire(fakeSparseDownload('old.xlsx', 700 * 1024 * 1024));
    await fire(fakeSparseDownload('new.xlsx', 700 * 1024 * 1024));

    const [older, newer] = listDownloads(page).downloads;
    expect(older.state).toBe('failed');
    expect(older.error).toMatch(/size budget/);
    expect(newer.state).toBe('completed'); // the one just captured always survives
  });
});

describe('put_download — stream/hash integrity across sizes', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function stubUpload() {
    const seen: { body: Buffer; len?: string } = { body: Buffer.alloc(0) };
    global.fetch = (async (_u: any, init: any) => {
      seen.len = init.headers['Content-Length'];
      const chunks: Buffer[] = [];
      for await (const chunk of init.body as any) chunks.push(Buffer.from(chunk));
      seen.body = Buffer.concat(chunks);
      return { ok: true, status: 200, text: async () => '' } as any;
    }) as any;
    return seen;
  }

  // The hash is computed in the same pipeline the bytes travel, so what is hashed and
  // what is uploaded cannot diverge. Sizes span the boundaries where a flowing-mode
  // race would show up: empty, sub-chunk, and multi-chunk past the 64KiB default.
  it.each([
    ['zero-byte', 0],
    ['single-byte', 1],
    ['sub-chunk', 1024],
    ['exactly one 64KiB chunk', 65536],
    ['multi-chunk', 65536 * 3 + 17],
  ])('uploads %s files with a matching sha256 and length', async (_label, size) => {
    const { page, fire } = setup();
    // Pseudo-random so a dropped or duplicated chunk cannot coincidentally hash equal.
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    await fire(fakeDownload(`f${size}.bin`, bytes));
    const seen = stubUpload();

    const res = await putDownload(page, { upload_url: 'https://s3.test/k' });

    expect(seen.body.length).toBe(size);
    expect(seen.body.equals(bytes)).toBe(true);
    expect(seen.len).toBe(String(size));
    expect(res.size_bytes).toBe(size);
    expect(res.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
