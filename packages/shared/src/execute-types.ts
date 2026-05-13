export interface ExecuteFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeout_ms?: number;
}

export interface ExecuteFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const EXECUTE_LIMITS = {
  MAX_BODY_SIZE_BYTES: 1_048_576,   // 1MB
  MAX_HEADER_COUNT: 50,
  MAX_TIMEOUT_MS: 60_000,
  DEFAULT_TIMEOUT_MS: 30_000,
  ALLOWED_SCHEMES: ['https:', 'http:'] as readonly string[],
  MAX_RESPONSE_BODY_BYTES: 5_242_880, // 5MB
} as const;
