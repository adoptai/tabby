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
      ).catch((err: Error) => {
        throw new ExecuteError(502, `Browser fetch failed: ${err.message}`);
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
