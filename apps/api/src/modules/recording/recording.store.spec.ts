import { RecordingStore } from './recording.store';
import type { RecordingBundle } from '@browser-hitl/shared';
import { Readable } from 'stream';

/** In-memory MinIO fake: putObject/getObject over a Map, plus provisionBucket. */
function makeMinioFake() {
  const objects = new Map<string, Buffer>();
  const client = {
    putObject: jest.fn(async (bucket: string, key: string, buf: Buffer) => {
      objects.set(`${bucket}/${key}`, buf);
    }),
    getObject: jest.fn(async (bucket: string, key: string) => {
      const buf = objects.get(`${bucket}/${key}`);
      if (!buf) {
        const err: any = new Error('NoSuchKey');
        err.code = 'NoSuchKey';
        throw err;
      }
      return Readable.from(buf);
    }),
  };
  const minio = {
    provisionBucket: jest.fn(async () => undefined),
    bucketName: (tenantId: string) => `artifact-bundles-${tenantId}`,
    getClient: () => client,
  };
  return { minio, objects };
}

const sampleBundle: RecordingBundle = {
  session_id: 'sess-1',
  recording_mode: 'login',
  started_at: '2026-06-15T00:00:00.000Z',
  stopped_at: '2026-06-15T00:05:00.000Z',
  har: { log: { version: '1.2', creator: { name: 'tabby-recording', version: '1.0' }, entries: [{ a: 1 }] } },
  click_events: [
    {
      event_type: 'input',
      tag_name: 'INPUT',
      element_id: 'pwd',
      class_name: null,
      selector: '#pwd',
      url: 'https://example.com/login',
      value: '[REDACTED]',
      field_role: 'password',
      is_redacted: true,
      timestamp: '2026-06-15T00:01:00.000Z',
    },
  ],
  url_events: [{ from_url: 'https://example.com/login', to_url: 'https://example.com/home', timestamp: 'x' }],
};

describe('RecordingStore', () => {
  it('persists encrypted and retrieves the same bundle (AES-256-GCM roundtrip)', async () => {
    const { minio, objects } = makeMinioFake();
    const store = new RecordingStore(minio as any);

    await store.persist('tenant-a', 'sess-1', sampleBundle);

    // Stored blob must be ciphertext, not plaintext JSON.
    const stored = objects.get('artifact-bundles-tenant-a/recordings/sess-1.json.enc')!;
    expect(stored).toBeInstanceOf(Buffer);
    expect(stored.toString('utf8')).not.toContain('session_id');
    expect(stored.length).toBeGreaterThan(28); // nonce(12) + authTag(16) + body

    const out = await store.retrieve('tenant-a', 'sess-1');
    expect(out).toEqual(sampleBundle);
  });

  it('returns null when no bundle exists', async () => {
    const { minio } = makeMinioFake();
    const store = new RecordingStore(minio as any);
    expect(await store.retrieve('tenant-a', 'missing')).toBeNull();
  });

  it('drains and parses a bundle from the worker', async () => {
    const { minio } = makeMinioFake();
    const store = new RecordingStore(minio as any);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, bundle: sampleBundle }) } as any);

    const out = await store.drainFromWorker('pod-xyz', 'sess-1');
    expect(out).toEqual(sampleBundle);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/recording/stop'),
      expect.objectContaining({ method: 'POST' }),
    );
    fetchMock.mockRestore();
  });

  it('throws when the worker reports failure', async () => {
    const { minio } = makeMinioFake();
    const store = new RecordingStore(minio as any);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: false, error: 'no recording' }) } as any);

    await expect(store.drainFromWorker('pod-xyz', 'sess-1')).rejects.toThrow('no recording');
    fetchMock.mockRestore();
  });
});
