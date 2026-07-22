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

  it('includes extra_allowlist and allow_all in the PUT body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    process.env.EGRESS_PROXY_ALLOWLIST_URL = 'http://egress-proxy:8095/allowlist';

    const service = new PodManagerService();
    await service.syncEgressAllowlist('session-1', ['https://example.com/login'], ['.expedia.com'], true, true);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body).toEqual({
      session_id: 'session-1',
      target_urls: ['https://example.com/login'],
      extra_allowlist: ['.expedia.com'],
      allow_all: true,
      residential: true,
    });
  });

  it('defaults extra_allowlist to [] and allow_all to false', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as any;

    process.env.EGRESS_PROXY_ALLOWLIST_URL = 'http://egress-proxy:8095/allowlist';

    const service = new PodManagerService();
    await service.syncEgressAllowlist('session-1', ['https://example.com/login']);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(body.extra_allowlist).toEqual([]);
    expect(body.allow_all).toBe(false);
    expect(body.residential).toBe(false);
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

describe('PodManagerService worker pod resources', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env.WORKER_CPU_REQUEST;
    delete process.env.WORKER_CPU_LIMIT;
    delete process.env.WORKER_MEM_REQUEST;
    delete process.env.WORKER_MEM_LIMIT;
    delete process.env.NOVNC_CPU_REQUEST;
    delete process.env.NOVNC_CPU_LIMIT;
    delete process.env.NOVNC_MEM_REQUEST;
    delete process.env.NOVNC_MEM_LIMIT;
    delete process.env.WORKER_NODE_SELECTOR;
    delete process.env.WORKER_TOLERATIONS;
    delete process.env.WORKER_AFFINITY;
    delete process.env.EGRESS_PROXY_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('uses default resource values when env vars are not set', () => {
    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    const workerContainer = podSpec.spec.containers.find((c: any) => c.name === 'worker');
    expect(workerContainer.resources).toEqual({
      requests: { cpu: '500m', memory: '1Gi' },
      limits: { cpu: '1500m', memory: '1536Mi' },
    });
  });

  it('uses env var resource values when set', () => {
    process.env.WORKER_CPU_REQUEST = '2000m';
    process.env.WORKER_CPU_LIMIT = '4000m';
    process.env.WORKER_MEM_REQUEST = '4Gi';
    process.env.WORKER_MEM_LIMIT = '8Gi';

    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    const workerContainer = podSpec.spec.containers.find((c: any) => c.name === 'worker');
    expect(workerContainer.resources).toEqual({
      requests: { cpu: '2000m', memory: '4Gi' },
      limits: { cpu: '4000m', memory: '8Gi' },
    });
  });

  it('uses default noVNC resource values when env vars are not set', () => {
    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    const novncContainer = podSpec.spec.containers.find((c: any) => c.name === 'novnc');
    expect(novncContainer.resources).toEqual({
      requests: { cpu: '0.1', memory: '128Mi' },
      limits: { cpu: '0.5', memory: '256Mi' },
    });
  });

  it('uses env var noVNC resource values when set', () => {
    process.env.NOVNC_CPU_REQUEST = '200m';
    process.env.NOVNC_CPU_LIMIT = '500m';
    process.env.NOVNC_MEM_REQUEST = '256Mi';
    process.env.NOVNC_MEM_LIMIT = '512Mi';

    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    const novncContainer = podSpec.spec.containers.find((c: any) => c.name === 'novnc');
    expect(novncContainer.resources).toEqual({
      requests: { cpu: '200m', memory: '256Mi' },
      limits: { cpu: '500m', memory: '512Mi' },
    });
  });

  it('applies nodeSelector to pod spec when WORKER_NODE_SELECTOR is set', () => {
    process.env.WORKER_NODE_SELECTOR = '{"kubernetes.io/arch":"amd64","node-role":"worker"}';

    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    expect(podSpec.spec.nodeSelector).toEqual({
      'kubernetes.io/arch': 'amd64',
      'node-role': 'worker',
    });
  });

  it('applies tolerations to pod spec when WORKER_TOLERATIONS is set', () => {
    process.env.WORKER_TOLERATIONS = '[{"key":"dedicated","operator":"Equal","value":"browser","effect":"NoSchedule"}]';

    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    expect(podSpec.spec.tolerations).toEqual([
      { key: 'dedicated', operator: 'Equal', value: 'browser', effect: 'NoSchedule' },
    ]);
  });

  it('omits nodeSelector when WORKER_NODE_SELECTOR is not set', () => {
    const service = new PodManagerService();
    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    expect(podSpec.spec.nodeSelector).toBeUndefined();
    expect(podSpec.spec.tolerations).toBeUndefined();
    expect(podSpec.spec.affinity).toBeUndefined();
  });

  it('logs a warning and skips nodeSelector on invalid JSON', () => {
    process.env.WORKER_NODE_SELECTOR = 'not-valid-json';

    const service = new PodManagerService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    const podSpec = (service as any).buildPodSpec(
      'worker-session-1',
      { id: 'session-1', app_id: 'app-1', tenant_id: 'tenant-1' },
      {},
    );

    expect(podSpec.spec.nodeSelector).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('WORKER_NODE_SELECTOR'));
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
