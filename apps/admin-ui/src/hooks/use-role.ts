import { useAuthStore } from '@/stores/auth';

export type AppRole = 'Admin' | 'Editor' | 'Operator' | 'Viewer' | 'Agent';

export function useRole(): AppRole | null {
  const user = useAuthStore((s) => s.user);
  return (user?.role as AppRole) ?? null;
}

export function useHasRole(...roles: AppRole[]): boolean {
  const role = useRole();
  if (!role) return false;
  return roles.includes(role);
}
