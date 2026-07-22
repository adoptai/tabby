import { create } from 'zustand';

export interface User {
  sub: string;
  tenant_id: string;
  role: string;
  token_type?: string;
  owner_user_id?: string;
  email?: string;
  name?: string;
  idp_id?: string;
  exp?: number;
}

interface AuthState {
  token: string | null;
  user: User | null;
  setToken: (token: string) => void;
  logout: () => void;
}

function decodeJwt(token: string): User | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(base64)) as User;
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set) => {
  const stored = localStorage.getItem('tabby_token');
  const initial = stored ? { token: stored, user: decodeJwt(stored) } : { token: null, user: null };

  return {
    ...initial,
    setToken: (token: string) => {
      localStorage.setItem('tabby_token', token);
      set({ token, user: decodeJwt(token) });
    },
    logout: () => {
      localStorage.removeItem('tabby_token');
      set({ token: null, user: null });
    },
  };
});

export function displayName(user: User | null): string {
  if (!user) return '';
  if (user.email) return user.email;
  if (user.name) return user.name;
  return user.sub.replace(/^(federated:|svc:)/, '');
}

export function userInitial(user: User | null): string {
  const name = displayName(user);
  return name.charAt(0).toUpperCase() || '?';
}
