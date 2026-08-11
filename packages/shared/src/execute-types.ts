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
  encoding?: 'utf-8' | 'base64';
  truncated?: boolean;
}

export const EXECUTE_LIMITS = {
  MAX_BODY_SIZE_BYTES: 1_048_576,   // 1MB
  MAX_HEADER_COUNT: 50,
  MAX_TIMEOUT_MS: 60_000,
  DEFAULT_TIMEOUT_MS: 30_000,
  ALLOWED_SCHEMES: ['https:', 'http:'] as readonly string[],
  MAX_RESPONSE_BODY_BYTES: 5_242_880, // 5MB

  // --- HAR capture budgets -------------------------------------------------
  // Separate from the /execute/fetch limit above, which caps ONE response
  // returned to a caller. HAR capture holds every entry of a whole session in
  // memory at once and then stringifies the lot at drain, so the figure that
  // matters is the total, not the individual response.
  //
  // A recording of ICICI's login captured 1100 entries and OOM-killed the
  // worker (1536Mi) at drain — after the bundle was assembled and before it was
  // persisted, so the entire recording was lost at the one moment nothing had
  // been written yet.

  /** Largest response body stored per HAR entry. Generous for a JSON API; a
   *  rendered page or a bundle is truncated, which costs the compiler nothing. */
  MAX_HAR_BODY_BYTES: 262_144, // 256KB
  /** Total body bytes stored across a whole capture. Once spent, entries keep
   *  their metadata and drop their bodies — the shape is what compiles, and a
   *  truncated capture beats a lost one. */
  MAX_HAR_BODY_TOTAL_BYTES: 67_108_864, // 64MB
  BROWSER_RATE_LIMIT_PER_MIN: 120,
} as const;

export const BROWSER_COMMANDS = [
  'navigate', 'click_element', 'click_by_text', 'click_at',
  // hover opens what a click then uses: a bank nav whose submenu only exists
  // while the pointer is over the parent. The recorder captures it and the
  // worker has handled it for a while, but this list did not -- so every
  // compiled hover step came back 400 Invalid command and the menu never
  // opened. The list is the API's allowlist; a command missing here cannot
  // reach the worker at all.
  'hover',
  // Walking history home. The only way back to the entry page on an app that
  // forbids navigate and whose deep pages link nowhere near it.
  'go_back',
  'type_text', 'type_into_label', 'press_key',
  'set_checked', 'select_option',
  'get_page_summary', 'get_page_info', 'screenshot',
  'wait_for_selector', 'scroll_page',
  'har_start', 'har_stop', 'har_status',
  'list_downloads', 'get_download',
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
