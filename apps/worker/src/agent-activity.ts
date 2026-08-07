/**
 * Tracks whether an agent (the harness, via /execute/browser and /execute/fetch)
 * is currently driving this worker's page, so the keepalive loop can stay out of
 * its way.
 *
 * Keepalive exists to stop a portal's idle timer from expiring an unattended
 * session. When an agent is actively working the page, that premise is false
 * twice over:
 *
 *  1. The agent's own clicks/navigations already reset the portal's idle timer,
 *     so the keepalive action is redundant.
 *  2. Worse, it is destructive. A synthetic mouse-move/scroll landing between an
 *     agent's locator resolution and its click moves the target and misclicks; a
 *     'goto' keepalive reloads the page out from under a half-finished flow. The
 *     robotic input is also exactly what reCAPTCHA v3 / fingerprint SDKs score,
 *     and it is far more suspicious interleaved with real interaction than alone.
 *
 * Two distinct signals, because they answer different questions:
 *
 *  - `isAgentBusy()` — is a command in flight right now? Every command counts,
 *    including read-only ones: a scroll injected during `screenshot` or
 *    `get_page_summary` corrupts what those return.
 *  - `msSinceAgentActivity()` — how long since the agent did something that
 *    actually reset the portal's server-side idle timer? Only server-touching
 *    commands count here. Per the platform gotcha that `screenshot` is not a
 *    keepalive (it captures pixels, it makes no request), a session that has
 *    only been screenshotted is still going stale and still needs the nudge.
 *
 * Module-level state is correct here: one worker pod owns exactly one page.
 */

/** Commands that hit the origin server, and so reset its idle timer. */
const IDLE_RESETTING_COMMANDS = new Set([
  'navigate',
  'click_element',
  'click_by_text',
  'click_at',
  'type_text',
  'type_into_label',
  'press_key',
]);

let inFlight = 0;
let lastActivityAt = 0;

/** True if the given browser command resets the origin's server-side idle timer. */
export function isIdleResettingCommand(command: string): boolean {
  return IDLE_RESETTING_COMMANDS.has(command);
}

/**
 * Mark the start of an agent command. `resetsIdleTimer` should be false for
 * read-only commands (screenshot, get_page_summary, har_status, ...): they still
 * make the agent "busy", but they do not keep the portal session alive.
 */
export function beginAgentCommand(resetsIdleTimer: boolean): void {
  inFlight += 1;
  if (resetsIdleTimer) lastActivityAt = Date.now();
}

/** Mark the end of an agent command. Pair with `beginAgentCommand` in a finally. */
export function endAgentCommand(resetsIdleTimer: boolean): void {
  inFlight = Math.max(0, inFlight - 1);
  // Stamp on completion too: a `navigate` that takes 40s kept the session alive
  // for those 40s, and the idle clock should run from when it finished.
  if (resetsIdleTimer) lastActivityAt = Date.now();
}

/** True while at least one agent command is executing against the page. */
export function isAgentBusy(): boolean {
  return inFlight > 0;
}

/**
 * Milliseconds since the agent last did something that reset the origin's idle
 * timer. `Infinity` when the agent has never touched this session — which is the
 * common case (plain credential-vending sessions) and must behave exactly as it
 * did before agent-awareness existed.
 */
export function msSinceAgentActivity(): number {
  return lastActivityAt === 0 ? Infinity : Date.now() - lastActivityAt;
}

/** Test-only: clear module state between cases. */
export function resetAgentActivity(): void {
  inFlight = 0;
  lastActivityAt = 0;
}
