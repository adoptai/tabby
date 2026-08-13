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

export async function resolveOne(page: Page | Frame, params: Record<string, any>) {
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
  // role + accessible name, which is sometimes the ONLY unique handle.
  //
  // ICICI's Monthly and Annual radios share an id AND a name, so no selector
  // picks one of them: the recorder's only unique candidate was
  // `role_name: radio|Annual`. Without this the step fell back to clicking the
  // label text, which reported success while the form stayed on Monthly -- and
  // the replay downloaded a monthly statement while asking for the annual one.
  if (typeof params.role === 'string' && params.role && typeof params.name === 'string') {
    return page
      .getByRole(params.role as Parameters<Page['getByRole']>[0], { name: params.name, exact: true })
      .first();
  }
  throw new Error(
    'Provide "selector", "label", or "role" + "name" to identify the control',
  );
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

    case 'go_back': {
      // Returning to an earlier page WITHOUT a full load.
      //
      // A recorded journey can cross origins -- ICICI's statement portal is a
      // different host from the net-banking SPA -- and once there, nothing on
      // the page links back to the landing page. `navigate` is refused on these
      // apps because a full load destroys the session, so a replay that needed
      // to start its next operation from the beginning had no way home at all.
      //
      // History is that way: same tab, same cookies, and for an in-app SPA hop
      // it is a client-side pop rather than a load.
      const before = page.url();
      const resp = await page.goBack({ timeout: timeoutMs });
      return { url: page.url(), moved: page.url() !== before, had_entry: resp !== null };
    }

    case 'hover': {
      // Opening a menu that only appears on hover.
      //
      // A bank's top nav reveals its items on hover, so the click that follows
      // targets something that does not exist until the pointer is over the
      // parent. Playwright's click moves a real mouse, but only to the element
      // it is clicking -- nothing opens the parent first, and the run dead-ends
      // on a control that is absent or hidden.
      const selector = requireParam(params, 'selector', 'string');
      const scope = resolveScope(page, params);
      const el = await firstMatching(scope, selector, params);
      if (!el.matched) {
        throw new Error(await noMatchMessage(page, scope, selector, params));
      }
      await requireVisible(el.locator, timeoutMs, Number(params.settle_ms) || 0);
      await el.locator.hover({ timeout: timeoutMs });
      return el.usedFallback ? { used_fallback: el.usedFallback } : {};
    }

    case 'click_element': {
      const selector = requireParam(params, 'selector', 'string');
      // Same visible-first + overlay handling as click_by_text: a selector can
      // match hidden analytics/off-screen copies (strict-mode violation), and the
      // sticky-banner interception is not text-specific.
      const scope = resolveScope(page, params);

      // hover_first: do the whole gesture in ONE command.
      //
      // A menu that only exists while the pointer rests on its trigger cannot
      // survive an HTTP round trip. Measured on ICICI: hover returned ok, and
      // the submenu was not visible on any subsequent call -- checked at 1s, 2s,
      // 3s and 4s. As two commands the click was racing the menu closing, which
      // looked like a timing problem and got "fixed" twice by waiting LONGER,
      // the exact opposite of the cure.
      //
      // Held here: the pointer is still on the trigger when the target resolves,
      // because nothing returns to the caller in between.
      const hoverFirst = typeof params.hover_first === 'string' ? params.hover_first : '';
      if (hoverFirst) {
        // The opener gets ITS OWN fallbacks, never the click's.
        //
        // Spreading params handed the opener the fallbacks belonging to the
        // control it is supposed to reveal: on ICICI, when the positional
        // hover_first missed, the opener fell through to
        // `a.sub-menu-list-item-link:text-is("Credit Cards")` -- a submenu item,
        // which cannot exist until the menu it lives in has been opened. The
        // hover could only ever fail, and every locator after it then correctly
        // found nothing.
        const opener = await firstMatching(scope, hoverFirst, {
          ...params,
          selector: hoverFirst,
          fallbacks: Array.isArray(params.hover_fallbacks) ? params.hover_fallbacks : [],
        });
        if (!opener.matched) {
          throw new Error(await noMatchMessage(page, scope, hoverFirst, params));
        }
        await opener.locator.hover({ timeout: timeoutMs });
      }

      const el = await firstMatching(scope, selector, params);
      if (!el.matched) {
        throw new Error(await noMatchMessage(page, scope, selector, params));
      }
      await clickThroughOverlays(el.locator, timeoutMs, Number(params.settle_ms) || 0);
      return el.usedFallback ? { used_fallback: el.usedFallback } : {};
    }

    case 'click_by_text': {
      const text = requireParam(params, 'text', 'string');
      const textScope = resolveScope(page, params);

      // hover_first, for the same reason click_element honours it: the whole
      // gesture has to be ONE command.
      //
      // It was implemented only on click_element, and nothing here rejected the
      // parameter -- it was simply ignored. The compiler emits the reveal
      // gesture as click_by_text whenever the control has usable text, which is
      // the common case for a nav item, so the hover silently never happened.
      // ICICI's submenu is not merely hidden until hovered, it is ABSENT from
      // the DOM, so the failure read "nothing on the page matches this control"
      // and looked like a bad locator rather than a skipped hover.
      //
      // Measured: the flyout goes display:none -> block while the pointer rests
      // on the box and is back to none within 500ms of it leaving, so holding
      // the pointer across the resolve is the only shape that works.
      const hoverFirst = typeof params.hover_first === 'string' ? params.hover_first : '';
      if (hoverFirst) {
        // Same separation as click_element: the opener never borrows the click's fallbacks.
        const opener = await firstMatching(textScope, hoverFirst, {
          ...params,
          selector: hoverFirst,
          fallbacks: Array.isArray(params.hover_fallbacks) ? params.hover_fallbacks : [],
        });
        if (!opener.matched) {
          throw new Error(await noMatchMessage(page, textScope, hoverFirst, params));
        }
        await opener.locator.hover({ timeout: timeoutMs });
      }

      await clickByText(textScope, params, text, timeoutMs);
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
      //
      // force, because the select we need is usually INVISIBLE. Portals like
      // Finacle draw a styled div over the native control and hide it; without
      // force, selectOption waits for actionability on an element that will
      // never be actionable, and the command hangs until the worker times out
      // (observed as `HTTP 504 Worker browser command timed out` on every
      // dropdown of an ICICI statement replay). force skips the actionability
      // wait, which is exactly right here: the element is real and settable, it
      // is simply not something a human would click.
      //
      // A short timeout on top, so a genuinely missing select fails fast rather
      // than burning the caller's whole budget.
      const selectOpts = { timeout: Math.min(timeoutMs, 5000), force: true };
      let chosen: string[];
      try {
        chosen = await target.selectOption({ value }, selectOpts);
      } catch {
        chosen = await target.selectOption({ label: value }, selectOpts);
      }
      // The widget that hid the select is listening for `change`, not for
      // Playwright's internal update -- an overlay that renders the chosen label
      // stays stale otherwise, and any form that reads the DOM on change never
      // runs. Dispatched after the value is set, so listeners see the new one.
      if (typeof target.dispatchEvent === 'function') {
        await target.dispatchEvent('change').catch(() => undefined);
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
      // ready_state, because "where are you" is not "are you ready".
      //
      // A caller deciding whether it may act next had only the URL to go on,
      // and a form postback re-renders WITHOUT changing it: ICICI's statement
      // portal answered a click while still processing the previous one, kept
      // the earlier selection, and showed "we are unable to process your
      // request". Clicking a page that has not finished loading is not a
      // faster click, it is a lost one.
      //
      // Additive: url and title are unchanged for every existing caller.
      let readyState = 'unknown';
      try {
        // Only a string is an answer. Anything else means we did not actually
        // read document.readyState, and reporting it verbatim would let a
        // caller's "is the page settled?" check compare against nonsense.
        const observed = await page.evaluate(() => document.readyState);
        readyState = typeof observed === 'string' ? observed : 'unknown';
      } catch {
        // Mid-navigation the execution context is destroyed — which is itself
        // the answer, so report it rather than failing the command.
        readyState = 'loading';
      }
      return { url: page.url(), title: await page.title(), ready_state: readyState };
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
/**
 * How long an element that EXISTS may take to become visible before we stop.
 *
 * Playwright's click and hover auto-wait for visibility, so a control that
 * resolves but never appears burns the whole timeout retrying -- and retrying
 * a click against a sidebar that is still re-rendering is not a safe no-op. One
 * ICICI session lost its auth cookie during three such attempts: 30s of hover,
 * then 30s of click, against a positional selector on a page where the element
 * was hidden. Whatever moved under the cursor got clicked.
 *
 * Short, because an element that is going to appear appears quickly once it is
 * in the DOM; long enough that a transition or a slow render is not mistaken
 * for a hidden control.
 */
const INVISIBLE_GRACE_MS = 3_000;

/** Stop early when a control exists but stays hidden, instead of retrying into it. */
export async function requireVisible(
  target: any,
  timeoutMs: number,
  settleMs = 0,
): Promise<void> {
  if (typeof target.waitFor !== 'function') return;
  // The RECORDING knows how long this control took to appear. ICICI's nav
  // submenu was measured at 4322ms; the flat 3s grace gave up while it was
  // still animating open, and the click after a successful hover failed as
  // "on the page but not visible". A measurement of this app on this
  // connection beats a constant -- the constant is the floor, and the cap
  // keeps one slow recording from stalling every step.
  const grace = Math.min(Math.max(INVISIBLE_GRACE_MS, settleMs), timeoutMs, 15000);
  try {
    await target.waitFor({ state: 'visible', timeout: grace });
  } catch {
    throw new Error(
      'this control is on the page but not visible, so acting on it would either ' +
        'do nothing or hit whatever is on top of it. Something that should have ' +
        'revealed it has not run — a menu that opens on hover, a tab, an accordion — ' +
        'or the page is not the one these steps were recorded for. Read the page ' +
        '(get_page_summary) and check where you actually are.',
    );
  }
}

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
): Promise<{ locator: any; usedFallback?: string; matched: boolean }> {
  // Short by design. This is "has the page finished painting", not "will this
  // control ever appear" -- the caller's own timeout still governs the action.
  const settleTimeoutMs = Math.min(Number(params.timeout_ms) || 5000, 5000);
  const visibleFirst = (loc: any) => {
    const vis = loc.filter({ visible: true });
    return { loc, vis };
  };

  // count() is a SNAPSHOT -- it is the one Playwright call here that does not
  // auto-wait. hover(), click() and filter().first() all do, so a control that
  // renders a moment late made this function alone declare "nothing matches",
  // for the primary AND every fallback at once.
  //
  // That is what an operation running immediately after the session lands looks
  // like: an ICICI replay failed read_credit_card on
  // `#subContainer4 > ul > li:nth-of-type(1) > a` while that exact selector was
  // present, visible and reading "Credit Cards" when probed seconds later. The
  // same skill passed on other runs. Intermittent, every locator failing
  // together, and a DOM that always looked healthy by the time anyone checked --
  // all of it explained by asking a still-painting page a question that does not
  // wait for an answer.
  //
  // Bounded and cheap: nothing here waits longer than the caller's own timeout,
  // and a selector that is genuinely absent still falls through to the
  // fallbacks, just a beat later.
  const attached = async (loc: any): Promise<boolean> => {
    try {
      await loc.first().waitFor({ state: 'attached', timeout: settleTimeoutMs });
      return true;
    } catch {
      return (await loc.count()) > 0;
    }
  };

  const primary = scope.locator(selector);
  const { vis } = visibleFirst(primary);
  if (await attached(primary)) {
    return { locator: (await vis.count()) > 0 ? vis.first() : primary.first(), matched: true };
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
      // Snapshot, deliberately: the primary above already waited out the paint,
      // so a fallback that counts 0 now is genuinely absent. Waiting again per
      // fallback would multiply the cost of a miss by the number of alternatives
      // for no new information.
      if ((await loc.count()) > 0) {
        const v = loc.filter({ visible: true });
        return {
          locator: (await v.count()) > 0 ? v.first() : loc.first(),
          usedFallback: label,
          matched: true,
        };
      }
    } catch {
      /* a malformed fallback is not a reason to stop trying the others */
    }
  }

  // Nothing matched: hand back the primary so the caller reports it by name.
  return { locator: primary.first(), matched: false };
}

/**
 * What the page actually offers, when nothing we were told to click exists.
 *
 * "Nothing matches, read the page" sends the caller back to guessing: an ICICI
 * replay answered it with screenshots and probing until a human supplied the
 * answer from a skill they had written by hand. A customer building their first
 * skill has no such reference, so the failure itself has to carry the options --
 * the summariser already extracts addressable controls, and a dead end that
 * lists what IS there is a choice between real things instead of a search.
 *
 * Ranked by resemblance to what was asked for, because a bank page has hundreds
 * of controls and the useful ones are the ones that look like the target.
 */
async function noMatchMessage(
  page: Page,
  scope: Page | Frame,
  wanted: string,
  params: Record<string, any>,
): Promise<string> {
  const head =
    `nothing on the page matches ${JSON.stringify(wanted)}` +
    (Array.isArray(params.fallbacks) && params.fallbacks.length
      ? `, nor any of the ${params.fallbacks.length} recorded alternative(s)`
      : '') +
    '.';

  let options: string[] = [];
  try {
    const summary: any = await scope.evaluate(pageSummaryScript);
    const words = wanted.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
    const score = (label: string): number => {
      const l = label.toLowerCase();
      return words.reduce((n, w) => (w.length > 2 && l.includes(w) ? n + 1 : n), 0);
    };
    const seen = new Set<string>();
    options = (summary?.elements || [])
      .filter((e: any) => e && (e.text || e.label) && e.selector)
      .map((e: any) => ({ label: String(e.text || e.label).slice(0, 60), sel: String(e.selector) }))
      .filter((o: any) => (seen.has(o.sel) ? false : (seen.add(o.sel), true)))
      .sort((a: any, b: any) => score(b.label) - score(a.label))
      .slice(0, 12)
      .map((o: any) => `  ${JSON.stringify(o.label)} -> ${o.sel}`);
  } catch {
    /* a page we cannot summarise still gets the honest first line */
  }

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  const framesNote = frames.length
    ? `\n\n${frames.length} embedded frame(s) are NOT covered above; pass frame_url to act inside one: ` +
      frames.map((f) => f.url()).join(', ')
    : '';

  if (!options.length) {
    return `${head} The page exposes no addressable controls to suggest — it may not have finished loading.${framesNote}`;
  }
  return (
    `${head}\n\nControls that ARE on the page, closest first:\n${options.join('\n')}` +
    `\n\nAddress one of these rather than retrying the same locator.${framesNote}`
  );
}

async function clickThroughOverlays(
  target: any,
  timeoutMs: number,
  settleMs = 0,
): Promise<void> {
  if (await matchesNothing(target, timeoutMs)) {
    throw new Error(
      'nothing on the page matches this control. Read the page (get_page_summary) ' +
        'and address something that is actually there — waiting longer will not ' +
        'make it appear, and if the content sits in an embedded frame, pass frame_url.',
    );
  }
  await requireVisible(target, timeoutMs, settleMs);
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
  await clickThroughOverlays(target, timeoutMs, Number(params.settle_ms) || 0);
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
