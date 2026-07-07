import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLocalStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(window, 'localStorage', { value: mockLocalStorage, configurable: true });

describe('useAuthStore', () => {
  beforeEach(() => {
    mockLocalStorage.clear();
    vi.resetModules();
  });

  it('starts with null when no stored token', async () => {
    const { useAuthStore } = await import('./auth');
    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
  });

  it('setToken stores token and decodes user', async () => {
    const { useAuthStore } = await import('./auth');
    const payload = { sub: 'federated:user-1', tenant_id: 't-1', role: 'Admin', email: 'admin@test.com' };
    const fakeToken = `header.${btoa(JSON.stringify(payload))}.signature`;
    useAuthStore.getState().setToken(fakeToken);

    const state = useAuthStore.getState();
    expect(state.token).toBe(fakeToken);
    expect(state.user?.sub).toBe('federated:user-1');
    expect(state.user?.role).toBe('Admin');
    expect(state.user?.email).toBe('admin@test.com');
    expect(mockLocalStorage.getItem('tabby_token')).toBe(fakeToken);
  });

  it('logout clears token and user', async () => {
    const { useAuthStore } = await import('./auth');
    const payload = { sub: 'user-1', tenant_id: 't-1', role: 'Admin' };
    const fakeToken = `header.${btoa(JSON.stringify(payload))}.signature`;
    useAuthStore.getState().setToken(fakeToken);
    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.token).toBeNull();
    expect(state.user).toBeNull();
    expect(mockLocalStorage.getItem('tabby_token')).toBeNull();
  });
});

describe('displayName', () => {
  it('returns email when available', async () => {
    const { displayName } = await import('./auth');
    expect(displayName({ sub: 'federated:u1', tenant_id: 't1', role: 'Admin', email: 'admin@test.com' }))
      .toBe('admin@test.com');
  });

  it('strips federated prefix from sub when no email', async () => {
    const { displayName } = await import('./auth');
    expect(displayName({ sub: 'federated:abc-123', tenant_id: 't1', role: 'Admin' }))
      .toBe('abc-123');
  });

  it('returns empty for null user', async () => {
    const { displayName } = await import('./auth');
    expect(displayName(null)).toBe('');
  });
});
