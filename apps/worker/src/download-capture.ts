import { BrowserContext, Download, Page } from 'playwright';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Server-side download capture via Playwright `download` events.
 *
 * By default the worker cancels every download (browser_policy.downloads=false
 * in main.ts). When an app opts in (browser_policy.downloads=true), the context
 * is created with acceptDownloads and this module saves each download to a temp
 * file and keeps a small in-memory index. The `/execute/browser` commands
 * `list_downloads` and `get_download` expose them — `get_download` returns the
 * bytes as base64 (mirroring `screenshot`) so the harness can write the file to
 * its OUTPUTS. Bounded to EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES; larger exports
 * would need an out-of-band artifact path.
 */

export interface DownloadRecord {
  id: string;
  suggested_filename: string;
  url: string;
  mime_type: string;
  state: 'in_progress' | 'completed' | 'failed';
  size_bytes: number | null;
  path: string | null;
  created_at: string;
  error?: string;
}

/** Public (path-free) view returned by list_downloads. */
export type DownloadMeta = Omit<DownloadRecord, 'path'>;

const downloadsByContext = new WeakMap<BrowserContext, DownloadRecord[]>();
const MAX_DOWNLOADS = 20; // keep only the most recent N per context

function mimeFromName(name: string): string {
  const ext = path.extname(name || '').toLowerCase();
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.csv':
      return 'text/csv';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.json':
      return 'application/json';
    case '.txt':
      return 'text/plain';
    case '.zip':
      return 'application/zip';
    default:
      return 'application/octet-stream';
  }
}

function sanitize(name: string): string {
  return (name || 'download').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 128) || 'download';
}

/**
 * Attach download capture to a context (idempotent). Saves each download to a
 * temp file and indexes it. Call only when browser_policy.downloads is enabled;
 * the context must have been created with acceptDownloads: true.
 */
export function enableDownloadCapture(context: BrowserContext): void {
  if (downloadsByContext.has(context)) {
    return;
  }
  const records: DownloadRecord[] = [];
  downloadsByContext.set(context, records);
  const dir = path.join(os.tmpdir(), 'tabby-downloads');

  const attach = (page: Page) => {
    page.on('download', async (download: Download) => {
      const suggested = download.suggestedFilename() || 'download';
      const rec: DownloadRecord = {
        id: `dl-${Date.now()}-${records.length}`,
        suggested_filename: suggested,
        url: download.url(),
        mime_type: mimeFromName(suggested),
        state: 'in_progress',
        size_bytes: null,
        path: null,
        created_at: new Date().toISOString(),
      };
      records.push(rec);
      if (records.length > MAX_DOWNLOADS) {
        records.splice(0, records.length - MAX_DOWNLOADS);
      }
      try {
        await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, `${rec.id}-${sanitize(suggested)}`);
        await download.saveAs(dest);
        const stat = await fs.stat(dest);
        rec.path = dest;
        rec.size_bytes = stat.size;
        rec.state = 'completed';
      } catch (err) {
        rec.state = 'failed';
        rec.error = err instanceof Error ? err.message : String(err);
      }
    });
  };

  context.on('page', attach);
  for (const p of context.pages()) {
    attach(p);
  }
}

/** Metadata for every captured download on this page's context (newest last). */
export function listDownloads(page: Page): { downloads: DownloadMeta[] } {
  const records = downloadsByContext.get(page.context()) || [];
  return { downloads: records.map(({ path: _p, ...meta }) => meta) };
}

/**
 * Return a captured download's bytes as base64. Without `id`, returns the most
 * recent COMPLETED download. Throws if none, if the target is not completed, or
 * if it exceeds the inline size cap.
 */
export async function getDownload(
  page: Page,
  id?: string,
): Promise<{ id: string; filename: string; mime_type: string; size_bytes: number; base64: string }> {
  const records = downloadsByContext.get(page.context()) || [];
  const completed = records.filter((r) => r.state === 'completed');
  const rec = id
    ? records.find((r) => r.id === id)
    : completed[completed.length - 1];

  if (!rec) {
    throw new Error(
      id
        ? `get_download: no download with id "${id}"`
        : 'get_download: no completed download available (trigger the download first, then retry)',
    );
  }
  if (rec.state !== 'completed' || !rec.path) {
    throw new Error(`get_download: download "${rec.suggested_filename}" is ${rec.state}${rec.error ? ` (${rec.error})` : ''}`);
  }
  if (rec.size_bytes !== null && rec.size_bytes > EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES) {
    throw new Error(
      `get_download: "${rec.suggested_filename}" is ${rec.size_bytes} bytes, over the ${EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES}-byte inline limit`,
    );
  }
  const buf = await fs.readFile(rec.path);
  return {
    id: rec.id,
    filename: rec.suggested_filename,
    mime_type: rec.mime_type,
    size_bytes: buf.length,
    base64: buf.toString('base64'),
  };
}
