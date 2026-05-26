import { Express, Request, Response } from 'express';
import { Page } from 'playwright';
import {
  BROWSER_COMMANDS,
  EXECUTE_LIMITS,
  type ExecuteBrowserRequest,
  type ExecuteBrowserResponse,
} from '@browser-hitl/shared';

interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    queryString: Array<{ name: string; value: string }>;
    postData: Record<string, any>;
  };
  response: {
    status: number;
    statusText: string;
    headers: Array<{ name: string; value: string }>;
    content: { mimeType: string; text: string };
  };
  time: number;
}

interface HarCapture {
  entries: HarEntry[];
  requestIdMap: WeakMap<any, string>;
  pendingRequests: Map<string, { startTime: number; entry: Partial<HarEntry> }>;
  nextId: number;
  onRequest: (request: any) => void;
  onResponse: (response: any) => void;
}

const activeHarByPage = new WeakMap<Page, HarCapture>();

function detachHarListeners(page: Page): void {
  const capture = activeHarByPage.get(page);
  if (capture) {
    page.removeListener('request', capture.onRequest);
    page.removeListener('response', capture.onResponse);
    activeHarByPage.delete(page);
  }
}

export function cleanupHarListeners(page: Page): void {
  detachHarListeners(page);
}

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

async function dispatchCommand(
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
      const exact = params.exact !== false;
      await page.getByText(text, { exact }).click({ timeout: timeoutMs });
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
      detachHarListeners(page);

      const entries: HarEntry[] = [];
      const requestIdMap = new WeakMap<any, string>();
      const pendingRequests = new Map<string, { startTime: number; entry: Partial<HarEntry> }>();
      let nextId = 0;

      const onRequest = (request: any) => {
        const url: string = request.url();
        const startTime = Date.now();
        const headers: Array<{ name: string; value: string }> = [];
        const reqHeaders = request.headers();
        for (const [name, value] of Object.entries(reqHeaders)) {
          headers.push({ name, value: String(value) });
        }

        const queryString: Array<{ name: string; value: string }> = [];
        try {
          const parsed = new URL(url);
          parsed.searchParams.forEach((v, k) => queryString.push({ name: k, value: v }));
        } catch { /* ignore invalid URLs */ }

        const postData: Record<string, any> = {};
        if (request.postData()) {
          postData.text = request.postData();
          postData.mimeType = reqHeaders['content-type'] || '';
        }

        const partial: Partial<HarEntry> = {
          startedDateTime: new Date(startTime).toISOString(),
          request: { method: request.method(), url, headers, queryString, postData },
        };
        const id = String(nextId++);
        requestIdMap.set(request, id);
        pendingRequests.set(id, { startTime, entry: partial });
      };

      const onResponse = async (response: any) => {
        const request = response.request();
        const id = requestIdMap.get(request);
        if (id === undefined) return;

        const match = pendingRequests.get(id);
        if (!match) return;
        pendingRequests.delete(id);

        const respHeaders: Array<{ name: string; value: string }> = [];
        const rawHeaders = response.headers();
        for (const [name, value] of Object.entries(rawHeaders)) {
          respHeaders.push({ name, value: String(value) });
        }

        let bodyText = '';
        try {
          const buf = await response.body();
          bodyText = buf.toString('utf8').slice(0, EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES);
        } catch { /* streaming or consumed — store empty */ }

        const entry: HarEntry = {
          ...(match.entry as HarEntry),
          response: {
            status: response.status(),
            statusText: response.statusText(),
            headers: respHeaders,
            content: {
              mimeType: rawHeaders['content-type'] || '',
              text: bodyText,
            },
          },
          time: Date.now() - match.startTime,
        };
        entries.push(entry);
      };

      page.on('request', onRequest);
      page.on('response', onResponse);
      activeHarByPage.set(page, { entries, requestIdMap, pendingRequests, nextId, onRequest, onResponse });

      return { status: 'started', entry_count: 0 };
    }

    case 'har_stop': {
      const capture = activeHarByPage.get(page);
      if (!capture) {
        return { status: 'not_active', har: null };
      }
      const entries = capture.entries;
      detachHarListeners(page);

      const har = {
        log: {
          version: '1.2',
          creator: { name: 'tabby-execute-browser', version: '1.0' },
          entries,
        },
      };
      return { status: 'stopped', entry_count: entries.length, har };
    }

    case 'har_status': {
      const capture = activeHarByPage.get(page);
      if (!capture) {
        return { active: false, entry_count: 0 };
      }
      return { active: true, entry_count: capture.entries.length };
    }

    default:
      throw new Error(`Unhandled command: ${command}`);
  }
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
