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
  // How `body` is encoded. 'utf-8' (default) for textual responses; 'base64'
  // when the response is binary (e.g. application/pdf) and reading it as text
  // would corrupt the bytes. Optional for backward compatibility.
  encoding?: 'utf-8' | 'base64';
  // True when the response exceeded MAX_RESPONSE_BODY_BYTES and was cut off.
  // For binary bodies a truncated payload is unusable, so consumers should error.
  truncated?: boolean;
}

export const EXECUTE_LIMITS = {
  MAX_BODY_SIZE_BYTES: 1_048_576,   // 1MB
  MAX_HEADER_COUNT: 50,
  MAX_TIMEOUT_MS: 60_000,
  DEFAULT_TIMEOUT_MS: 30_000,
  ALLOWED_SCHEMES: ['https:', 'http:'] as readonly string[],
  MAX_RESPONSE_BODY_BYTES: 5_242_880, // 5MB
  BROWSER_RATE_LIMIT_PER_MIN: 120,
} as const;

export const BROWSER_COMMANDS = [
  'navigate', 'click_element', 'click_by_text', 'click_at',
  'type_text', 'type_into_label', 'press_key',
  'get_page_summary', 'get_page_info', 'screenshot',
  'wait_for_selector', 'scroll_page',
  'har_start', 'har_stop', 'har_status',
] as const;

export type BrowserCommandName = typeof BROWSER_COMMANDS[number];

export interface ExecuteBrowserRequest {
  command: string;
  params: Record<string, any>;
  timeout_ms?: number;
}

export interface ExecuteBrowserResponse {
  success: boolean;
  data?: any;
  error?: string;
}
