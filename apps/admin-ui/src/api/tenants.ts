import { api } from './client';
import type { PaginatedResponse } from './sessions';

export interface Tenant {
  id: string;
  name: string;
  max_sessions: number;
  created_at: string;
  updated_at: string;
}

export const tenantsApi = {
  list: (params?: { limit?: number; offset?: number }) =>
    api.get<PaginatedResponse<Tenant>>('/tenants', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<Tenant>(`/tenants/${id}`).then((r) => r.data),

  create: (data: { name: string; id?: string; max_sessions?: number }) =>
    api.post<Tenant>('/tenants', data).then((r) => r.data),

  update: (id: string, data: { max_sessions?: number }) =>
    api.patch<Tenant>(`/tenants/${id}`, data).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/tenants/${id}`).then((r) => r.data),
};
