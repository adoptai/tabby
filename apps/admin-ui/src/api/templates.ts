import { api } from './client';

export interface AppTemplate {
  id: string;
  tenant_id: string;
  name: string;
  profile_name_pattern: string | null;
  credential_ref_default: string | null;
  idle_shutdown_seconds: number | null;
  execute_enabled: boolean;
  extra_egress_allowlist: string[] | null;
  login_config: unknown;
  keepalive_config: unknown;
  export_policy: unknown;
  browser_policy: unknown;
  notification_config: unknown;
  created_at: string;
  updated_at: string;
}

export const templatesApi = {
  list: (params?: { tenant_id?: string }) =>
    api.get<AppTemplate[]>('/admin/app-templates', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<AppTemplate>(`/admin/app-templates/${id}`).then((r) => r.data),

  create: (data: Partial<AppTemplate>) =>
    api.post<AppTemplate>('/admin/app-templates', data).then((r) => r.data),

  update: (id: string, data: Partial<AppTemplate>) =>
    api.put<AppTemplate>(`/admin/app-templates/${id}`, data).then((r) => r.data),

  patch: (id: string, data: Partial<AppTemplate>) =>
    api.patch<AppTemplate>(`/admin/app-templates/${id}`, data).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/admin/app-templates/${id}`).then((r) => r.data),
};
