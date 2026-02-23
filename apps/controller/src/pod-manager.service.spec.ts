import { PodManagerService } from './pod-manager.service';
import { createHmac } from 'node:crypto';

jest.mock('@kubernetes/client-node', () => {
  class MockKubeConfig {
    loadFromCluster(): void {}
    loadFromDefault(): void {}
    makeApiClient(): any {
      return {};
    }
  }
  return { KubeConfig: MockKubeConfig };
});

describe('PodManagerService egress allowlist sync', () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it('sends PUT allowlist update payload with optional admin token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    process.env.EGRESS_PROXY_ALLOWLIST_URL = 'http://egress-proxy:8095/allowlist';
    process.env.EGRESS_PROXY_ALLOWLIST_TOKEN = 'test-admin-token';

    const service = new PodManagerService();
    await service.syncEgressAllowlist('session-1', ['https://example.com/login']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://egress-proxy:8095/allowlist',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          'content-type': 'application/json',
          'x-egress-admin-token': 'test-admin-token',
        }),
      }),
    );
  });

  it('sends DELETE allowlist cleanup with encoded session id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    process.env.EGRESS_PROXY_ALLOWLIST_URL = 'http://egress-proxy:8095/allowlist/';

    const service = new PodManagerService();
    await service.clearEgressAllowlist('session/with spaces');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://egress-proxy:8095/allowlist/session%2Fwith%20spaces',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  it('injects EGRESS_PROXY_URL into worker pod env', () => {
    process.env.EGRESS_PROXY_URL = 'http://browser-hitl-egress-proxy:3128';
    process.env.EGRESS_PROXY_SESSION_KEY = 'test-egress-session-key';
    const sessionId = 'session-1';
    const expectedSecret = createHmac('sha256', process.env.EGRESS_PROXY_SESSION_KEY)
      .update(sessionId)
      .digest('hex');

    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: sessionId, app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    const workerContainer = podSpec.spec.containers.find((c: any) => c.name === 'worker');
    const egressProxyEnv = workerContainer.env.find((e: any) => e.name === 'EGRESS_PROXY_URL');
    expect(egressProxyEnv).toEqual({
      name: 'EGRESS_PROXY_URL',
      value: `http://${sessionId}:${expectedSecret}@browser-hitl-egress-proxy:3128`,
    });
  });

  it('fails closed when proxy URL is configured without session key', () => {
    process.env.EGRESS_PROXY_URL = 'http://browser-hitl-egress-proxy:3128';
    delete process.env.EGRESS_PROXY_SESSION_KEY;

    const service = new PodManagerService();
    expect(() => (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    )).toThrow('EGRESS_PROXY_SESSION_KEY must be configured');
  });
});

describe('PodManagerService not-found handling', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('treats Kubernetes 404 body payload as missing pod', async () => {
    const error = new Error('HTTP-Code: 404');
    (error as any).body = '{"kind":"Status","reason":"NotFound","code":404}';
    const readNamespacedPod = jest.fn().mockRejectedValue(error);

    const service = new PodManagerService();
    (service as any).coreApi = { readNamespacedPod };

    await expect(service.podExists('worker-missing')).resolves.toBe(false);
    expect(readNamespacedPod).toHaveBeenCalledTimes(2);
  });

  it('ignores Kubernetes 404 payload when deleting pod', async () => {
    const error = new Error('Unknown API Status Code');
    (error as any).body = '{"kind":"Status","reason":"NotFound","code":404}';
    const deleteNamespacedPod = jest.fn().mockRejectedValue(error);

    const service = new PodManagerService();
    (service as any).coreApi = { deleteNamespacedPod };

    await expect(service.deleteWorkerPod('worker-missing')).resolves.toBeUndefined();
    expect(deleteNamespacedPod).toHaveBeenCalledTimes(1);
  });
});
