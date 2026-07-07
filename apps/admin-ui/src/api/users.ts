import { api } from './client';
import type { PaginatedResponse } from './sessions';

export interface User {
  id: string;
  email: string;
  role: string;
  tenant_id: string;
  status: string;
  created_at: string;
}

export const usersApi = {
  list: (params?: { limit?: number; offset?: number }) =>
    api.get<PaginatedResponse<User>>('/users', { params }).then((r) => r.data),

  create: (data: { email: string; password: string; role: string; tenant_id: string }) =>
    api.post<User>('/users', data).then((r) => r.data),

  remove: (id: string) =>
    api.delete(`/users/${id}`).then((r) => r.data),
};
