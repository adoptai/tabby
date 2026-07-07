import { api } from './client';

export interface Session {
  id: string;
  app_id: string;
  tenant_id: string;
  state: string;
  health_result_type: string | null;
  pod_name: string | null;
  retry_count: number;
  hitl_attempt_count: number;
  pending_input_request: unknown | null;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
  application?: {
    id: string;
    name: string;
  };
}

export interface Intervention {
  id: string;
  session_id: string;
  type: string;
  outcome: string | null;
  input_request_metadata: unknown | null;
  human_note: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface StreamResponse {
  url: string;
  stream_token?: string;
  mode?: string;
}

export const sessionsApi = {
  list: (params: { limit?: number; offset?: number }) =>
    api.get<PaginatedResponse<Session>>('/sessions', { params }).then((r) => r.data),

  get: (id: string) =>
    api.get<Session>(`/sessions/${id}`).then((r) => r.data),

  interventions: (id: string, params?: { limit?: number; offset?: number }) =>
    api.get<PaginatedResponse<Intervention>>(`/sessions/${id}/interventions`, { params }).then((r) => r.data),

  scale: (appId: string, desiredSessions: number) =>
    api.post(`/apps/${appId}/sessions/scale`, { desired_sessions: desiredSessions }).then((r) => r.data),

  stream: (id: string) =>
    api.post<StreamResponse>(`/sessions/${id}/stream`).then((r) => r.data),

  shortLink: (id: string, mode?: string) =>
    api.post<{ short_url: string }>(`/sessions/${id}/short-link`, mode ? { mode } : {}).then((r) => r.data),
};
