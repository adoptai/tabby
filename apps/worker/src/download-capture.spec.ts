import * as fs from 'fs/promises';
import { enableDownloadCapture, listDownloads, getDownload } from './download-capture';

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
});
