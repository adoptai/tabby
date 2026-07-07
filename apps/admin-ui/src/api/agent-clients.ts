import { api } from './client';

export interface AgentClient {
  id: string;
  client_id: string;
  name: string;
  tenant_id: string;
  allowed_profiles: string[] | null;
  unrestricted_profiles: boolean;
  token_ttl_seconds: number | null;
  rate_limit_per_minute: number | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface RegisterAgentClientResponse {
  client_id: string;
  client_secret: string;
  id: string;
}

export const agentClientsApi = {
  list: (tenantId: string) =>
    api.get<AgentClient[]>(`/admin/agent-clients/${tenantId}`).then((r) => r.data),

  register: (data: {
    name: string;
    tenant_id: string;
    allowed_profiles?: string[];
    unrestricted_profiles?: boolean;
    token_ttl_seconds?: number;
    rate_limit_per_minute?: number;
  }) =>
    api.post<RegisterAgentClientResponse>('/admin/agent-clients', data).then((r) => r.data),

  revoke: (id: string) =>
    api.delete(`/admin/agent-clients/${id}`).then((r) => r.data),

  rotateSecret: (id: string) =>
    api.post<{ client_secret: string }>(`/admin/agent-clients/${id}/rotate-secret`).then((r) => r.data),
};
