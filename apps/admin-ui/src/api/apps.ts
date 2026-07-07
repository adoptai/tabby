import { api } from './client';
import type { PaginatedResponse } from './sessions';

export interface Application {
  id: string;
  tenant_id: string;
  name: string;
  target_urls: string[];
  desired_session_count: number;
  execute_enabled: boolean;
  template_id: string | null;
  owner_user_id: string | null;
  login_config: unknown;
  keepalive_config: unknown;
  export_policy: unknown;
  browser_policy: unknown;
  notification_config: unknown;
  extra_egress_allowlist: string[] | null;
  credential_ref: string | null;
  created_at: string;
  updated_at: string;
}

export const appsApi = {
  list: (params?: { limit?: number; offset?: number; tenant_id?: string }) =>
    api.get<PaginatedResponse<Application>>('/apps', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<Application>(`/apps/${id}`).then((r) => r.data),

  create: (data: Partial<Application>) =>
    api.post<Application>('/apps', data).then((r) => r.data),

  update: (id: string, data: Partial<Application>) =>
    api.put<Application>(`/apps/${id}`, data).then((r) => r.data),

  deactivate: (id: string) =>
    api.delete(`/apps/${id}`).then((r) => r.data),

  destroy: (id: string) =>
    api.delete(`/apps/${id}/destroy`).then((r) => r.data),
};
