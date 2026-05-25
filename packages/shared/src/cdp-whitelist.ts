import { CDP_LIMITS } from './constants';

// ============================================================
// CDP Command/Event Whitelists (security: strict allow-lists)
// ============================================================

/**
 * INBOUND commands (client -> Chromium) — only these are forwarded.
 * All other commands are rejected and the connection is closed.
 */
export const CDP_ALLOWED_COMMANDS = new Set([
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Input.dispatchKeyEvent',
  'Input.dispatchMouseEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
]);

/**
 * OUTBOUND events (Chromium -> client) — only these are forwarded.
 * CDP domains auto-send events on enable, so we must filter strictly.
 */
export const CDP_ALLOWED_EVENTS = new Set([
  'Page.screencastFrame',
  'Page.screencastVisibilityChanged',
]);

/**
 * Validate and clamp screencast params to enforce CDP_LIMITS.
 * Prevents resource exhaustion via oversized quality/dimensions.
 */
export function sanitizeScreencastParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = { ...params };

  if (typeof sanitized.quality === 'number') {
    sanitized.quality = Math.max(1, Math.min(sanitized.quality, CDP_LIMITS.SCREENCAST_MAX_QUALITY));
  } else {
    sanitized.quality = 60;
  }

  if (typeof sanitized.maxWidth === 'number') {
    sanitized.maxWidth = Math.max(1, Math.min(sanitized.maxWidth, CDP_LIMITS.SCREENCAST_MAX_WIDTH));
  } else {
    sanitized.maxWidth = CDP_LIMITS.SCREENCAST_MAX_WIDTH;
  }

  if (typeof sanitized.maxHeight === 'number') {
    sanitized.maxHeight = Math.max(1, Math.min(sanitized.maxHeight, CDP_LIMITS.SCREENCAST_MAX_HEIGHT));
  } else {
    sanitized.maxHeight = CDP_LIMITS.SCREENCAST_MAX_HEIGHT;
  }

  if (typeof sanitized.everyNthFrame === 'number') {
    sanitized.everyNthFrame = Math.max(CDP_LIMITS.SCREENCAST_MIN_EVERY_NTH_FRAME, sanitized.everyNthFrame);
  } else {
    sanitized.everyNthFrame = CDP_LIMITS.SCREENCAST_MIN_EVERY_NTH_FRAME;
  }

  // Strip any format override — always use jpeg
  sanitized.format = 'jpeg';

  return sanitized;
}
