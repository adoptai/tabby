import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockSessionStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

Object.defineProperty(window, 'sessionStorage', { value: mockSessionStorage });

describe('useRole', () => {
  beforeEach(() => {
    mockSessionStorage.clear();
    vi.resetModules();
  });

  it('returns null when not authenticated', async () => {
    const { useRole } = await import('./use-role');
    const { result } = renderHook(() => useRole());
    expect(result.current).toBeNull();
  });

  it('returns role from token', async () => {
    const payload = { sub: 'u1', tenant_id: 't1', role: 'Operator' };
    const token = `h.${btoa(JSON.stringify(payload))}.s`;
    const { useAuthStore } = await import('@/stores/auth');
    useAuthStore.getState().setToken(token);

    const { useRole, useHasRole } = await import('./use-role');
    const { result: roleResult } = renderHook(() => useRole());
    expect(roleResult.current).toBe('Operator');

    const { result: hasResult } = renderHook(() => useHasRole('Admin', 'Operator'));
    expect(hasResult.current).toBe(true);

    const { result: noResult } = renderHook(() => useHasRole('Admin'));
    expect(noResult.current).toBe(false);
  });
});
