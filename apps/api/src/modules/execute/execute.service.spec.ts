import { CredentialVolatility } from '@browser-hitl/shared';
import type { CredentialSet } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock ioredis (ExecuteService opens a Redis client for rate limiting / locks)
// ---------------------------------------------------------------------------
const mockRedis = {
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  eval: jest.fn().mockResolvedValue(1),
  on: jest.fn(),
};

jest.mock('ioredis', () => jest.fn().mockImplementation(() => mockRedis));

import { ExecuteService } from './execute.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCredSet(headers: Array<{ name: string; value: string }>): CredentialSet {
  return {
    cookies: [],
    headers: headers.map((h) => ({ ...h, volatility: CredentialVolatility.SEMI_STABLE })),
  };
}

function makeService(credOverrides: Partial<Record<string, any>> = {}) {
  const credentialsService = {
    resolveActiveProfile: jest.fn().mockResolvedValue({
      app_id: 'app-1', profile_id: 'quickbooks-sandbox', target_domains: ['sandbox.qbo.intuit.com'],
    }),
    findHealthySession: jest.fn().mockResolvedValue({ id: 'sess-1', pod_name: 'pod-1' }),
    touchSessionActivity: jest.fn().mockResolvedValue(undefined),
    getCredentialsForSession: jest.fn().mockResolvedValue(makeCredSet([])),
    ...credOverrides,
  };
  const jwtService = { sign: jest.fn().mockReturnValue('worker-token') };
  const service = new ExecuteService(credentialsService as any, jwtService as any);
  return { service, credentialsService };
}

/** Capture the JSON body forwarded to the worker via global fetch. */
function mockWorkerFetch(): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ status: 200, headers: {}, body: '{}' }),
    text: async () => '',
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

function forwardedHeaders(fetchMock: jest.Mock): Record<string, string> {
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/execute/fetch'));
  return JSON.parse(call![1].body).headers;
}

const baseParams = {
  tenantId: 'tenant-1',
  profileId: 'quickbooks-sandbox',
  role: 'Agent',
  unrestrictedProfiles: true,
  ownerUserId: 'user-1',
};

describe('ExecuteService.executeFetch — attach_captured_credentials', () => {
  beforeEach(() => jest.clearAllMocks());

  it('injects the captured bearer into the worker fetch when attachCaptured is set', async () => {
    const fetchMock = mockWorkerFetch();
    const { service, credentialsService } = makeService({
      getCredentialsForSession: jest.fn().mockResolvedValue(
        makeCredSet([{ name: 'authorization', value: 'Intuit_live_bearer_xyz' }]),
      ),
    });

    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST', headers: { 'content-type': 'application/json' } },
      attachCaptured: true,
    });

    expect(credentialsService.getCredentialsForSession).toHaveBeenCalledWith(
      expect.objectContaining({ profile_id: 'quickbooks-sandbox' }),
      expect.objectContaining({ id: 'sess-1' }),
      'tenant-1',
      expect.any(String),
      { forceRefresh: false },
    );
    const headers = forwardedHeaders(fetchMock);
    expect(headers.authorization).toBe('Intuit_live_bearer_xyz');
    expect(headers['content-type']).toBe('application/json');
  });

  it('lets a caller-supplied header win over a captured one (case-insensitive)', async () => {
    const fetchMock = mockWorkerFetch();
    const { service } = makeService({
      getCredentialsForSession: jest.fn().mockResolvedValue(
        makeCredSet([{ name: 'authorization', value: 'captured' }]),
      ),
    });

    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST', headers: { Authorization: 'caller' } },
      attachCaptured: true,
    });

    const headers = forwardedHeaders(fetchMock);
    expect(headers.Authorization).toBe('caller');
    expect(headers.authorization).toBeUndefined();
  });

  it('does not fetch or attach credentials when attachCaptured is not set', async () => {
    const fetchMock = mockWorkerFetch();
    const { service, credentialsService } = makeService();

    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST', headers: { 'content-type': 'application/json' } },
    });

    expect(credentialsService.getCredentialsForSession).not.toHaveBeenCalled();
    expect(forwardedHeaders(fetchMock)).toEqual({ 'content-type': 'application/json' });
  });

  it('forwards caller headers only (fail-soft) when credential lookup throws', async () => {
    const fetchMock = mockWorkerFetch();
    const { service } = makeService({
      getCredentialsForSession: jest.fn().mockRejectedValue(new Error('bundle missing')),
    });

    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST', headers: { 'content-type': 'application/json' } },
      attachCaptured: true,
    });

    expect(forwardedHeaders(fetchMock)).toEqual({ 'content-type': 'application/json' });
  });

  it('does NOT attach captured credentials for a host outside the profile capture scope', async () => {
    const fetchMock = mockWorkerFetch();
    const { service, credentialsService } = makeService({
      getCredentialsForSession: jest.fn().mockResolvedValue(
        makeCredSet([{ name: 'authorization', value: 'Intuit_live_bearer_xyz' }]),
      ),
    });

    // Attacker-influenced URL on a host NOT in target_domains (['sandbox.qbo.intuit.com']).
    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://evil.example.com/steal', method: 'GET' },
      attachCaptured: true,
    });

    // The captured bearer must never be fetched or forwarded off-scope.
    expect(credentialsService.getCredentialsForSession).not.toHaveBeenCalled();
    const headers = forwardedHeaders(fetchMock) || {};
    expect(headers.authorization).toBeUndefined();
  });

  it('rejects when merging captured headers exceeds MAX_HEADER_COUNT', async () => {
    mockWorkerFetch();
    const { service } = makeService({
      getCredentialsForSession: jest.fn().mockResolvedValue(
        makeCredSet([{ name: 'authorization', value: 'x' }, { name: 'x-extra', value: 'y' }]),
      ),
    });
    // 50 caller headers passes validateRequest (limit is 50); +2 captured pushes it over.
    const callerHeaders: Record<string, string> = {};
    for (let i = 0; i < 50; i++) callerHeaders[`h${i}`] = String(i);

    await expect(service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST', headers: callerHeaders },
      attachCaptured: true,
    })).rejects.toThrow(/Too many headers/);
  });

  it('passes forceRefresh through when refreshCredentials is set', async () => {
    mockWorkerFetch();
    const { service, credentialsService } = makeService({
      getCredentialsForSession: jest.fn().mockResolvedValue(
        makeCredSet([{ name: 'authorization', value: 'fresh' }]),
      ),
    });

    await service.executeFetch({
      ...baseParams,
      request: { url: 'https://sandbox.qbo.intuit.com/api/v4/graphql', method: 'POST' },
      attachCaptured: true,
      refreshCredentials: true,
    });

    expect(credentialsService.getCredentialsForSession).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'tenant-1', expect.any(String),
      { forceRefresh: true },
    );
  });
});
