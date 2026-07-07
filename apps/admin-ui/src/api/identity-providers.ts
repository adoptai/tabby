import { api } from './client';

export interface IdentityProviderConfig {
  id: string;
  name: string;
  provider_type: 'oidc' | 'saml';
  issuer_url: string | null;
  jwks_uri: string | null;
  auth_url: string | null;
  token_url: string | null;
  userinfo_url: string | null;
  sign_out_url: string | null;
  scopes: string | null;
  audience: string | null;
  user_id_claim: string;
  email_claim: string;
  name_claim: string | null;
  tenant_id_claim: string | null;
  enabled: boolean;
  allow_auto_provision: boolean;
  allow_shared_session_fallback: boolean;
  admin_domains: string[];
  default_role: string;
  role_claim: string | null;
  admin_role_values: string[];
  editor_role_values: string[];
  created_at: string;
  updated_at: string;
}

export const idpApi = {
  list: () =>
    api.get<IdentityProviderConfig[]>('/admin/identity-providers').then((r) => r.data),

  get: (id: string) =>
    api.get<IdentityProviderConfig>(`/admin/identity-providers/${id}`).then((r) => r.data),

  create: (data: Partial<IdentityProviderConfig>) =>
    api.post<IdentityProviderConfig>('/admin/identity-providers', data).then((r) => r.data),

  update: (id: string, data: Partial<IdentityProviderConfig>) =>
    api.put<IdentityProviderConfig>(`/admin/identity-providers/${id}`, data).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/admin/identity-providers/${id}`).then((r) => r.data),

  test: (id: string) =>
    api.get<{ key_count: number; latency_ms: number }>(`/admin/identity-providers/${id}/test`).then((r) => r.data),
};
