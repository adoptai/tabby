import { Express, Request, Response } from 'express';
import { Page } from 'playwright';
import {
  BROWSER_COMMANDS,
  EXECUTE_LIMITS,
  type ExecuteBrowserRequest,
  type ExecuteBrowserResponse,
} from '@browser-hitl/shared';
import { startHarCapture, stopHarCapture, getHarStatus, cleanupHarListeners } from './har-capture';

export { cleanupHarListeners };

export function registerBrowserHandler(app: Express, page: Page): void {
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

      const params = body.params || {};
      const timeoutMs = Math.min(
        Math.max(body.timeout_ms || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );

      const result = await dispatchCommand(page, body.command, params, timeoutMs);
      const response: ExecuteBrowserResponse = { success: true, data: result };
      res.json(response);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Browser handler error: ${message}`);
      res.json({ success: false, error: message } satisfies ExecuteBrowserResponse);
    }
  });
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
      await page.locator(selector).click({ timeout: timeoutMs });
      return {};
    }

    case 'click_by_text': {
      const text = requireParam(params, 'text', 'string');
      await clickByText(page, params, text, timeoutMs);
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
      await page.locator(selector).fill(text, { timeout: timeoutMs });
      return {};
    }

    case 'type_into_label': {
      const label = requireParam(params, 'label', 'string');
      const text = requireParam(params, 'text', 'string');
      await page.getByLabel(label).fill(text, { timeout: timeoutMs });
      return {};
    }

    case 'press_key': {
      const key = requireParam(params, 'key', 'string');
      await page.keyboard.press(key);
      return {};
    }

    case 'get_page_summary': {
      const summary = await page.evaluate(() => {
        const title = document.title;
        const url = window.location.href;
        const links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 50)
          .map(a => ({ text: (a as HTMLAnchorElement).textContent?.trim() || '', href: (a as HTMLAnchorElement).href }));
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
          .slice(0, 50)
          .map(b => ({ text: (b as HTMLElement).textContent?.trim() || '', tag: b.tagName.toLowerCase() }));
        const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
          .slice(0, 50)
          .map(i => ({
            tag: i.tagName.toLowerCase(),
            type: (i as HTMLInputElement).type || '',
            name: (i as HTMLInputElement).name || '',
            id: i.id || '',
            placeholder: (i as HTMLInputElement).placeholder || '',
          }));
        const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
          .slice(0, 20)
          .map(h => ({ level: h.tagName, text: (h as HTMLElement).textContent?.trim() || '' }));
        return { title, url, links, buttons, inputs, headings };
      });
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
      await page.locator(selector).waitFor({ timeout: timeoutMs });
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

    default:
      throw new Error(`Unhandled command: ${command}`);
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
  page: Page,
  params: Record<string, any>,
  text: string,
  timeoutMs: number,
): Promise<void> {
  const exact = params.exact === true;
  const within = typeof params.within === 'string' && params.within ? params.within : '';
  const nth = Number.isInteger(params.nth) ? params.nth : 0;

  const scope = within ? page.locator(within) : page;
  const matches = scope.getByText(text, { exact });

  // Prefer visible matches so the hidden analytics/off-screen copies never cause
  // a strict-mode violation. Only fall back to all matches when nothing is
  // currently visible, so a genuinely-missing target still errors clearly.
  const visible = matches.filter({ visible: true });
  const target = (await visible.count()) > 0 ? visible.nth(nth) : matches.nth(nth);
  await target.click({ timeout: timeoutMs });
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
