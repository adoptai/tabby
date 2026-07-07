import { api } from './client';

export interface ServiceProfile {
  id: string;
  tenant_id: string;
  app_id: string;
  profile_id: string;
  version: number;
  version_state: string;
  login_config: unknown;
  credential_types: unknown;
  target_domains: string[];
  canary_request_count: number;
  canary_error_count: number;
  parent_version_id: string | null;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export const profilesApi = {
  list: (params?: { limit?: number; offset?: number }) =>
    api.get<ServiceProfile[]>('/admin/profiles', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<ServiceProfile>(`/admin/profiles/${id}`).then((r) => r.data),

  create: (data: Partial<ServiceProfile>) =>
    api.post<ServiceProfile>('/admin/profiles', data).then((r) => r.data),

  promote: (id: string) =>
    api.post(`/admin/profiles/${id}/promote`).then((r) => r.data),

  rollback: (id: string) =>
    api.post(`/admin/profiles/${id}/rollback`).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/admin/profiles/${id}`).then((r) => r.data),
};
