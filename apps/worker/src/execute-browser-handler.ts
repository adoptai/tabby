import { Express, Request, Response } from 'express';
import { Frame, Page } from 'playwright';
import {
  BROWSER_COMMANDS,
  EXECUTE_LIMITS,
  type ExecuteBrowserRequest,
  type ExecuteBrowserResponse,
} from '@browser-hitl/shared';
import { startHarCapture, stopHarCapture, getHarStatus, cleanupHarListeners } from './har-capture';
import { listDownloads, getDownload } from './download-capture';
import { beginAgentCommand, endAgentCommand, isIdleResettingCommand } from './agent-activity';
import { pageSummaryScript } from './page-summary.injected';

export { cleanupHarListeners };

export interface BrowserHandlerOptions {
  /** Refuse `navigate` — see BrowserPolicy.block_navigate. */
  blockNavigate?: boolean;
}

export function registerBrowserHandler(
  app: Express,
  page: Page,
  opts: BrowserHandlerOptions = {},
): void {
  app.post('/execute/browser', async (req: Request, res: Response) => {
    try {
      const body = req.body as ExecuteBrowserRequest;

      if (!body || !body.command || typeof body.command !== 'string') {
        res.status(400).json({ success: false, error: 'Missing or invalid "command" field' });
        return;
      }

      if (!BROWSER_COMMANDS.includes(body.command as any)) {
        res.status(400).json({
          success: false,
          error: `Unknown command "${body.command}". Valid: ${BROWSER_COMMANDS.join(', ')}`,
        });
        return;
      }

      // Enforced here rather than asked for in SKILL.md. A reload destroys the
      // session on refresh-sensitive portals, and an agent that gets stuck will
      // reach for navigate however firmly the prose tells it not to — which is
      // precisely how the observed ICICI run ended, with the human asked to sign
      // in again mid-task. The message names the alternative, because a refusal
      // an agent cannot act on just becomes a different dead end.
      if (opts.blockNavigate && body.command === 'navigate') {
        res.json({
          success: false,
          error:
            'navigate is disabled for this app: a full-page load destroys its session, ' +
            'and the next call would land on its signed-out screen. Move around the app ' +
            'the way a person does — click_element with a selector from get_page_summary, ' +
            'or click_by_text on a menu item. These are client-side route changes and keep ' +
            'the session alive.',
        } satisfies ExecuteBrowserResponse);
        return;
      }

      const params = body.params || {};
      const timeoutMs = Math.min(
        Math.max(body.timeout_ms || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );

      // Tell the keepalive loop an agent is driving the page, so it does not
      // inject a mouse-move/scroll/reload into the middle of this command.
      const resetsIdle = isIdleResettingCommand(body.command);
      beginAgentCommand(resetsIdle);
      let result: unknown;
      try {
        result = await dispatchCommand(page, body.command, params, timeoutMs);
      } finally {
        endAgentCommand(resetsIdle);
      }
      const response: ExecuteBrowserResponse = { success: true, data: result };
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Browser handler error: ${message}`);
      res.json({ success: false, error: message } satisfies ExecuteBrowserResponse);
    }
  });
}

/**
 * The single element a command should act on, addressed however the caller can.
 *
 * `selector` when the page summary gave one, `label` when it did not — the same
 * two ways every other command accepts, so an agent does not have to know which
 * one a given control supports.
 */
/**
 * The frame a command addresses — the page itself unless one is named.
 *
 * Bank portals embed whole applications in iframes (ICICI serves statements
 * from Finacle that way). The recorder already captured those clicks, because
 * `addInitScript` runs in every frame, but every command here operated on the
 * top-level page — so a control the human successfully clicked compiled into a
 * step that could not be executed, and `get_page_summary` reported the page as
 * if the embedded app were not there. One run concluded the portal was
 * "fundamentally frame-gated"; it was not, we simply never looked inside.
 *
 * Matching is by name first (stable), then URL: exact, then ignoring the query
 * string, which is where session tokens churn between the recording and now.
 */
function resolveScope(page: Page, params: Record<string, any>): Page | Frame {
  const name = typeof params.frame_name === 'string' ? params.frame_name.trim() : '';
  const url = typeof params.frame_url === 'string' ? params.frame_url.trim() : '';
  if (!name && !url) return page;

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  if (name) {
    const byName = frames.find((f) => f.name() === name);
    if (byName) return byName;
  }
  if (url) {
    const exact = frames.find((f) => f.url() === url);
    if (exact) return exact;
    const bare = (u: string) => u.split('?')[0].split('#')[0];
    const byPath = frames.find((f) => bare(f.url()) === bare(url));
    if (byPath) return byPath;
  }
  throw new Error(
    `No frame matched ${name ? `name "${name}"` : `url "${url}"`}. ` +
      `Frames present: ${frames.map((f) => f.url() || '(blank)').join(', ') || 'none'}. ` +
      `The embedded app may not have loaded yet — wait for it, then retry.`,
  );
}

async function resolveOne(page: Page | Frame, params: Record<string, any>) {
  if (typeof params.selector === 'string' && params.selector) {
    const all = page.locator(params.selector);
    // Visible-first, but fall back to the first match: the whole point of
    // set_checked is controls that are deliberately NOT visible.
    const vis = all.filter({ visible: true });
    return (await vis.count()) > 0 ? vis.first() : all.first();
  }
  if (typeof params.label === 'string' && params.label) {
    return page.getByLabel(params.label).first();
  }
  throw new Error('Provide either "selector" or "label" to identify the control');
}

export async function dispatchCommand(
  page: Page,
  command: string,
  params: Record<string, any>,
  timeoutMs: number,
): Promise<any> {
  switch (command) {
    case 'navigate': {
      const url = requireParam(params, 'url', 'string');
      const parsed = new URL(url);
      if (!EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)) {
        throw new Error(`Scheme "${parsed.protocol}" not allowed`);
      }
      await page.goto(url, { timeout: timeoutMs });
      return { url: page.url(), title: await page.title() };
    }

    case 'click_element': {
      const selector = requireParam(params, 'selector', 'string');
      // Same visible-first + overlay handling as click_by_text: a selector can
      // match hidden analytics/off-screen copies (strict-mode violation), and the
      // sticky-banner interception is not text-specific.
      const scope = resolveScope(page, params);
      const el = await firstMatching(scope, selector, params);
      await clickThroughOverlays(el.locator, timeoutMs);
      return el.usedFallback ? { used_fallback: el.usedFallback } : {};
    }

    case 'click_by_text': {
      const text = requireParam(params, 'text', 'string');
      await clickByText(resolveScope(page, params), params, text, timeoutMs);
      return {};
    }

    case 'click_at': {
      const x = requireParam(params, 'x', 'number');
      const y = requireParam(params, 'y', 'number');
      await page.mouse.click(x, y);
      return {};
    }

    case 'type_text': {
      const selector = requireParam(params, 'selector', 'string');
      const text = requireParam(params, 'text', 'string');
      await resolveScope(page, params).locator(selector).fill(text, { timeout: timeoutMs });
      return {};
    }

    case 'type_into_label': {
      const label = requireParam(params, 'label', 'string');
      const text = requireParam(params, 'text', 'string');
      await resolveScope(page, params).getByLabel(label).fill(text, { timeout: timeoutMs });
      return {};
    }

    case 'set_checked': {
      // Radios and checkboxes have no command that can set them, and clicking
      // their label reports success whether or not the state changed — which is
      // how an agent ends up stuck, sure it clicked "Annual" while the form
      // still says Monthly. This sets the control and REPORTS what it actually
      // holds afterwards.
      const want = params.checked !== false;
      const target = await resolveOne(resolveScope(page, params), params);
      const timeout = timeoutMs;

      const attempts: Array<() => Promise<void>> = [
        // 1. The ordinary way.
        async () => (want ? target.check({ timeout }) : target.uncheck({ timeout })),
        // 2. Visually hidden but real. The canonical bank pattern is an input
        //    with display:none behind a styled label, which fails actionability
        //    while being perfectly functional.
        async () => (want ? target.check({ force: true, timeout }) : target.uncheck({ force: true, timeout })),
        // 3. Click the label, which is what a person actually clicks. Covers
        //    inputs that are not merely hidden but unclickable in principle.
        async () => {
          const id = await target.getAttribute('id');
          const label = id
            ? page.locator(`label[for="${id}"]`)
            : target.locator('xpath=ancestor::label[1]');
          await label.first().click({ timeout });
        },
      ];

      let lastError = '';
      for (const attempt of attempts) {
        try {
          await attempt();
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          continue;
        }
        // Verified, not assumed: a click that lands but changes nothing is the
        // failure we are here to remove.
        try {
          if ((await target.isChecked()) === want) return { checked: want, verified: true };
        } catch {
          // Cannot read it back — report the attempt without claiming success.
          return { checked: want, verified: false };
        }
      }
      throw new Error(
        `Could not set the control to ${want ? 'checked' : 'unchecked'}` +
          (lastError ? `: ${lastError}` : '. The click landed but the state did not change.'),
      );
    }

    case 'select_option': {
      // Native <select> cannot be driven by any click command, so a recorded
      // dropdown choice had no way to be replayed at all.
      const target = await resolveOne(resolveScope(page, params), params);
      const value = params.value ?? params.label ?? params.option;
      if (typeof value !== 'string' || !value) {
        throw new Error('select_option requires "value" (the option value or its visible label)');
      }
      // Match by value first, then by visible label — a recording carries
      // whichever the page exposed.
      let chosen: string[];
      try {
        chosen = await target.selectOption({ value }, { timeout: timeoutMs });
      } catch {
        chosen = await target.selectOption({ label: value }, { timeout: timeoutMs });
      }
      return { selected: chosen };
    }

    case 'press_key': {
      const key = requireParam(params, 'key', 'string');
      await page.keyboard.press(key);
      return {};
    }

    case 'get_page_summary': {
      // Always report the frames on the page, even when summarising the main
      // one. The summariser reads a single document, so an app embedded in an
      // iframe was simply absent from its output — and a caller reading that
      // output had no way to tell "this control does not exist" from "this
      // control is one frame down". Naming the frames turns a dead end into a
      // next step: pass frame_url (or frame_name) to summarise inside one.
      const scope = resolveScope(page, params);
      const summary: any = await scope.evaluate(pageSummaryScript);
      const others = page.frames().filter((f) => f !== page.mainFrame());
      if (others.length > 0) {
        summary.frames = others.map((f) => ({
          url: f.url(),
          name: f.name() || undefined,
        }));
        if (scope === page) {
          summary.frames_note =
            `${others.length} embedded frame(s) are NOT included above. ` +
            `Re-run get_page_summary with frame_url set to one of them to read inside it, ` +
            `and pass the same frame_url to click_element/type_text to act in it.`;
        }
      }
      return summary;
    }

    case 'get_page_info': {
      return { url: page.url(), title: await page.title() };
    }

    case 'screenshot': {
      const buffer = await page.screenshot({ type: 'png' });
      return { base64: buffer.toString('base64'), mimeType: 'image/png' };
    }

    case 'wait_for_selector': {
      const selector = requireParam(params, 'selector', 'string');
      await resolveScope(page, params).locator(selector).waitFor({ timeout: timeoutMs });
      return {};
    }

    case 'scroll_page': {
      const dx = typeof params.dx === 'number' ? params.dx : 0;
      const dy = typeof params.dy === 'number' ? params.dy : 300;
      await page.mouse.wheel(dx, dy);
      return {};
    }

    case 'har_start': {
      return startHarCapture(page);
    }

    case 'har_stop': {
      return stopHarCapture(page);
    }

    case 'har_status': {
      return getHarStatus(page);
    }

    case 'list_downloads': {
      return listDownloads(page);
    }

    case 'get_download': {
      const id = typeof params.id === 'string' && params.id ? params.id : undefined;
      return getDownload(page, id);
    }

    default:
      throw new Error(`Unhandled command: ${command}`);
  }
}

/**
 * Click a resolved locator, falling back to a DOM-dispatched click when a real
 * mouse click cannot be delivered.
 *
 * Real SPA/bank portals overlay sticky banners (news / service-update
 * notifications, cookie notices) that cover a target's click point. Playwright
 * correctly refuses a click it cannot deliver ("<div …> intercepts pointer
 * events") and times out — even though THIS is the right, visible element and a
 * human clicking it directly works (observed on HSBCnet: a `newsNotification`
 * widget obscured the per-row statement "Download" link, so the click never
 * landed and no download fired). The DOM dispatch bypasses the pointer-event
 * hit-test, the same effect as the manual click.
 *
 * Only for a genuine OVERLAY interception — Playwright always includes
 * "intercepts pointer events" in that error. A plain "Timeout exceeded" means
 * the element was never found/actionable (e.g. a wrong selector or label), where
 * a DOM dispatch cannot help and would just burn a second timeout, so those
 * re-throw unchanged.
 */
/**
 * How long to wait before deciding a locator matches NOTHING.
 *
 * A control that exists appears within a second or two of the page settling; a
 * locator that is simply wrong never appears at all, and waiting the full
 * command timeout for it is pure delay. A replay driving a handful of wrong
 * selectors spent thirty seconds on each and looked, from outside, like it had
 * hung -- ten minutes of a live session to learn nothing the first two seconds
 * would not have told us.
 *
 * Generous enough that a slow bank page is never mistaken for a bad selector.
 */
const ZERO_MATCH_GRACE_MS = 4_000;

/** True when the locator still matches nothing after a short grace period. */
async function matchesNothing(target: any, timeoutMs: number): Promise<boolean> {
  const grace = Math.min(ZERO_MATCH_GRACE_MS, timeoutMs);
  const deadline = Date.now() + grace;
  for (;;) {
    try {
      if (typeof target.count === 'function') {
        if ((await target.count()) > 0) return false;
      } else {
        return false; // not a locator we can count; let the click decide
      }
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The recorded control, by the first way of addressing it that actually matches.
 *
 * The recorder ranks several ways to name a control -- id, aria-label, visible
 * text, css path -- and the compiler commits to one. On a portal whose nav is
 * icon divs the winner is a positional css path, and one shifted node kills the
 * step even though the text that would have worked was recorded alongside it.
 * An ICICI replay failed every nav step this way while a hand-written skill
 * clicking the same controls by text worked.
 *
 * So try the alternatives the recording carries, in the order it ranked them,
 * and report which one was used so a repair pass can promote it. This is cheap
 * because a locator that matches nothing now fails in seconds rather than
 * waiting out the command timeout.
 */
async function firstMatching(
  scope: Page | Frame,
  selector: string,
  params: Record<string, any>,
): Promise<{ locator: any; usedFallback?: string }> {
  const visibleFirst = (loc: any) => {
    const vis = loc.filter({ visible: true });
    return { loc, vis };
  };

  const primary = scope.locator(selector);
  const { vis } = visibleFirst(primary);
  if ((await primary.count()) > 0) {
    return { locator: (await vis.count()) > 0 ? vis.first() : primary.first() };
  }

  const fallbacks = Array.isArray(params.fallbacks) ? params.fallbacks : [];
  for (const fb of fallbacks) {
    if (!fb || typeof fb !== 'object') continue;
    let loc: any = null;
    let label = '';
    if (typeof fb.selector === 'string' && fb.selector) {
      loc = scope.locator(fb.selector);
      label = fb.selector;
    } else if (typeof fb.text === 'string' && fb.text) {
      loc = scope.getByText(fb.text, { exact: true });
      label = `text=${fb.text}`;
    }
    if (!loc) continue;
    try {
      if ((await loc.count()) > 0) {
        const v = loc.filter({ visible: true });
        return {
          locator: (await v.count()) > 0 ? v.first() : loc.first(),
          usedFallback: label,
        };
      }
    } catch {
      /* a malformed fallback is not a reason to stop trying the others */
    }
  }

  // Nothing matched: hand back the primary so the caller reports it by name.
  return { locator: primary.first() };
}

async function clickThroughOverlays(target: any, timeoutMs: number): Promise<void> {
  if (await matchesNothing(target, timeoutMs)) {
    throw new Error(
      'nothing on the page matches this control. Read the page (get_page_summary) ' +
        'and address something that is actually there — waiting longer will not ' +
        'make it appear, and if the content sits in an embedded frame, pass frame_url.',
    );
  }
  try {
    await target.click({ timeout: timeoutMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/intercepts pointer events/i.test(msg)) {
      await target.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => undefined);
      await target.dispatchEvent('click');
    } else {
      throw err;
    }
  }
}

/**
 * Click an element by its visible text, tolerant of the two things that make a
 * naive `getByText(text, { exact: true }).click()` fail on real SPA portals:
 *
 *  1. Duplicate text. A nav label like "Cards" is rendered in several nodes —
 *     the visible sidebar item plus hidden copies (analytics/telemetry trackers,
 *     off-screen scroll clones). A plain locator click throws a Playwright
 *     strict-mode violation on >1 match. We prefer the VISIBLE match(es) and
 *     click the nth (first by default), which is what a human does.
 *  2. Near-miss labels. The exact text a skill recorded ("Credit Cards") often
 *     differs slightly from the DOM ("Credit Card"); exact matching then times
 *     out. We default to Playwright's natural substring + normalized-whitespace
 *     matching. Callers can still force exact with `exact: true`.
 *
 * Optional params: `exact` (default false), `within` (CSS selector to scope the
 * search to a container — e.g. a specific sidenav), `nth` (0-based index among
 * the visible matches, default 0).
 */
async function clickByText(
  page: Page | Frame,
  params: Record<string, any>,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const explicitExact = typeof params.exact === 'boolean' ? params.exact : undefined;
  const within = typeof params.within === 'string' && params.within ? params.within : '';
  const nth = Number.isInteger(params.nth) ? params.nth : 0;

  const scope = within ? page.locator(within) : page;

  // Prefer visible matches so the hidden analytics/off-screen copies never cause
  // a strict-mode violation. Only fall back to all matches when nothing is
  // currently visible, so a genuinely-missing target still errors clearly.
  const resolve = async (exact: boolean) => {
    const matches = scope.getByText(text, { exact });
    const visible = matches.filter({ visible: true });
    return (await visible.count()) > 0 ? visible.nth(nth) : matches.nth(nth);
  };

  // Default is EXACT-first, substring only as a rescue. Defaulting straight to
  // substring silently widened every already-compiled skill that omits `exact`:
  // a sidebar with "Log out" and "Log out of all devices" made click_by_text
  // "Log out" ambiguous, and nth(0) then picks DOM order. Trying exact first
  // keeps those precise while still rescuing the near-miss labels substring
  // matching exists for ("Credit Cards" recorded, "Credit Card" in the DOM).
  let target;
  if (explicitExact !== undefined) {
    target = await resolve(explicitExact);
  } else {
    const exactCount = await scope.getByText(text, { exact: true }).count();
    target = await resolve(exactCount > 0);
  }
  await clickThroughOverlays(target, timeoutMs);
}

function requireParam(params: Record<string, any>, name: string, type: string): any {
  const value = params[name];
  if (value === undefined || value === null) {
    throw new Error(`Missing required parameter: ${name}`);
  }
  if (typeof value !== type) {
    throw new Error(`Parameter "${name}" must be ${type}, got ${typeof value}`);
  }
  return value;
}
