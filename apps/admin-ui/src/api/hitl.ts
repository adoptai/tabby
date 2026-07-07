import { api } from './client';

export interface InputRequest {
  input_type: string;
  value: string;
  step_index: number;
}

export const hitlApi = {
  takeover: (sessionId: string, idempotencyKey?: string) =>
    api.post(`/sessions/${sessionId}/takeover`, {}, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }).then((r) => r.data),

  release: (sessionId: string, idempotencyKey?: string) =>
    api.post(`/sessions/${sessionId}/release`, {}, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }).then((r) => r.data),

  submitInput: (sessionId: string, input: InputRequest, idempotencyKey?: string) =>
    api.post(`/sessions/${sessionId}/input`, input, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }).then((r) => r.data),

  acknowledge: (sessionId: string, note?: string, idempotencyKey?: string) =>
    api.post(`/sessions/${sessionId}/acknowledge`, note ? { note } : {}, {
      headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    }).then((r) => r.data),
};
