import { api } from './client';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
}

export const authApi = {
  login: (data: LoginRequest) =>
    api.post<LoginResponse>('/login', data).then((r) => r.data),

  listOAuthProviders: () =>
    api.get<OAuthProvider[]>('/auth/oauth/providers').then((r) => r.data),

  logout: () =>
    api.post('/auth/logout').then((r) => r.data),
};
