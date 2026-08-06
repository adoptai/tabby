import { Express, Request, Response } from 'express';
import { Page } from 'playwright';
import {
  EXECUTE_LIMITS,
  type ExecuteFetchRequest,
  type ExecuteFetchResponse,
} from '@browser-hitl/shared';

export function registerExecuteHandler(app: Express, page: Page): void {
  app.post('/execute/fetch', async (req: Request, res: Response) => {
    try {
      const body = req.body as ExecuteFetchRequest;

      if (!body || !body.url || typeof body.url !== 'string') {
        res.status(400).json({ error: 'Missing or invalid "url" field' });
        return;
      }

      let parsed: URL;
      try {
        parsed = new URL(body.url);
      } catch {
        res.status(400).json({ error: `Invalid URL: ${body.url}` });
        return;
      }

      if (!EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)) {
        res.status(400).json({
          error: `Scheme "${parsed.protocol}" not allowed. Use http: or https:`,
        });
        return;
      }

      const method = (body.method || 'GET').toUpperCase();
      const headers = body.headers || {};

      if (Object.keys(headers).length > EXECUTE_LIMITS.MAX_HEADER_COUNT) {
        res.status(400).json({
          error: `Too many headers (max ${EXECUTE_LIMITS.MAX_HEADER_COUNT})`,
        });
        return;
      }

      if (body.body && Buffer.byteLength(body.body, 'utf8') > EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES) {
        res.status(400).json({
          error: `Body too large (max ${EXECUTE_LIMITS.MAX_BODY_SIZE_BYTES} bytes)`,
        });
        return;
      }

      const timeoutMs = Math.min(
        Math.max(body.timeout_ms || EXECUTE_LIMITS.DEFAULT_TIMEOUT_MS, 1000),
        EXECUTE_LIMITS.MAX_TIMEOUT_MS,
      );

      const fetchUrl = body.url;
      const fetchBody = body.body ?? null;
      const maxResponseBytes = EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES;

      // An in-page fetch() is bound by the page's origin and the target's CORS
      // policy. Multi-origin apps therefore cannot be driven from a single page:
      // ICICI, for example, serves its dashboard from retailnetbanking.icici.bank.in
      // but its statement APIs from infinity.icici.bank.in, which sends no CORS
      // headers — the call dies as "TypeError: Failed to fetch" even though the
      // session is perfectly valid. That shape (auth portal + separate core-banking
      // host) is the norm for bank portals, not an ICICI quirk.
      //
      // Playwright's APIRequestContext is the way out: it shares the BrowserContext's
      // cookie jar and proxy (same primitive health-predicate-runner uses) but is not
      // a page fetch, so no origin is attached and CORS never applies. It also lifts
      // the browser's forbidden-header rules, so a captured Cookie/Authorization can
      // be sent explicitly.
      //
      // Same-origin calls keep using the in-page fetch, which preserves the page's JS
      // context (interceptors that mint per-request tokens still run).
      const context = page.context();
      const pageOrigin = (() => {
        try {
          const origin = new URL(page.url()).origin;
          // about:blank and other opaque origins serialize to the STRING "null"
          // rather than throwing, so this used to be "cross-origin" only by
          // accident (the string never equals a real origin). Keep that routing —
          // an in-page fetch from an opaque origin cannot pass CORS anyway — but
          // say so explicitly. Note the consequence: while the page sits on
          // about:blank (worker boot, warm-pool spare, post-crash) every fetch
          // goes off-page, and off-page traffic never fires page.on('request'),
          // so har_start/har_stop records nothing for it.
          return origin === 'null' ? null : origin;
        } catch { return null; }
      })();
      const isCrossOrigin = pageOrigin === null || pageOrigin !== parsed.origin;

      const fetchViaContext = async (): Promise<ExecuteFetchResponse> => {
        const resp = await context.request.fetch(fetchUrl, {
          method,
          headers,
          ...(fetchBody !== null && method !== 'GET' && method !== 'HEAD'
            ? { data: fetchBody }
            : {}),
          timeout: timeoutMs,
          maxRedirects: 10,
          // Report the target's own status rather than throwing on 4xx/5xx — callers
          // need to see a 401/403 to react to it.
          failOnStatusCode: false,
        });

        const respHeaders = resp.headers();
        const contentType = (respHeaders['content-type'] || '').toLowerCase();
        const isTextual =
          contentType === '' ||
          contentType.startsWith('text/') ||
          contentType.includes('json') ||
          contentType.includes('xml') ||
          contentType.includes('javascript') ||
          contentType.includes('x-www-form-urlencoded') ||
          contentType.includes('svg');

        const buf = await resp.body();
        if (isTextual) {
          const text = buf.toString('utf-8');
          const wasTruncated = text.length > maxResponseBytes;
          return {
            status: resp.status(),
            headers: respHeaders,
            body: wasTruncated ? text.slice(0, maxResponseBytes) : text,
            encoding: 'utf-8',
            truncated: wasTruncated,
          };
        }
        const wasTruncated = buf.length > maxResponseBytes;
        return {
          status: resp.status(),
          headers: respHeaders,
          body: (wasTruncated ? buf.subarray(0, maxResponseBytes) : buf).toString('base64'),
          encoding: 'base64',
          truncated: wasTruncated,
        };
      };

      if (isCrossOrigin) {
        const response = await fetchViaContext().catch((err: Error) => {
          throw new ExecuteError(502, `Cross-origin fetch failed: ${err.message}`);
        });
        res.json(response);
        return;
      }

      const result = await page.evaluate(
        async ({
          url, method: m, headers: h, body: b, maxBytes,
        }: {
          url: string; method: string; headers: Record<string, string>;
          body: string | null; maxBytes: number;
        }) => {
          // Headers forwarded as-is — callers may override Cookie/Authorization intentionally (API-layer ownership check scopes access to caller's own session)
          const init: RequestInit = {
            method: m,
            credentials: 'include',
            headers: h,
          };
          if (b !== null && m !== 'GET' && m !== 'HEAD') {
            init.body = b;
          }

          const resp = await fetch(url, init);

          const respHeaders: Record<string, string> = {};
          resp.headers.forEach((v, k) => { respHeaders[k] = v; });

          // Decide text vs binary from the response Content-Type. Textual
          // bodies (json/text/xml/form/svg) go through resp.text() as before;
          // anything else is read as raw bytes and base64-encoded so binary
          // payloads (e.g. application/pdf) survive transit intact instead of
          // being mangled by a UTF-8 text decode.
          const contentType = (respHeaders['content-type'] || '').toLowerCase();
          const isTextual =
            contentType === '' ||
            contentType.startsWith('text/') ||
            contentType.includes('json') ||
            contentType.includes('xml') ||
            contentType.includes('javascript') ||
            contentType.includes('x-www-form-urlencoded') ||
            contentType.includes('svg');

          if (isTextual) {
            const text = await resp.text();
            const wasTruncated = text.length > maxBytes;
            return {
              status: resp.status,
              headers: respHeaders,
              body: wasTruncated ? text.slice(0, maxBytes) : text,
              encoding: 'utf-8' as const,
              truncated: wasTruncated,
            };
          }

          const buf = new Uint8Array(await resp.arrayBuffer());
          const wasTruncated = buf.length > maxBytes;
          const bytes = wasTruncated ? buf.subarray(0, maxBytes) : buf;
          // Chunked base64 encode — String.fromCharCode.apply over the whole
          // array can blow the call stack for multi-MB payloads.
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(
              null,
              Array.from(bytes.subarray(i, i + CHUNK)),
            );
          }
          return {
            status: resp.status,
            headers: respHeaders,
            body: btoa(binary),
            encoding: 'base64' as const,
            truncated: wasTruncated,
          };
        },
        {
          url: fetchUrl,
          method,
          headers,
          body: fetchBody,
          maxBytes: maxResponseBytes,
        },
      ).catch(async (err: Error) => {
        // Same-origin fetches can still be refused by the page — a CSP connect-src
        // rule, or a service worker. Retry off-page before giving up, for the same
        // reason cross-origin goes there directly.
        try {
          return await fetchViaContext();
        } catch {
          throw new ExecuteError(502, `Browser fetch failed: ${err.message}`);
        }
      });

      const response: ExecuteFetchResponse = result;
      res.json(response);
    } catch (err: unknown) {
      if (err instanceof ExecuteError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Execute handler error: ${message}`);
      res.status(500).json({ error: 'Internal execute error' });
    }
  });
}

class ExecuteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
