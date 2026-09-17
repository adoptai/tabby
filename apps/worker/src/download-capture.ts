import { BrowserContext, Download, Page } from 'playwright';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import { uploadToPresignedUrl, validateUploadUrl } from './presigned-upload';

/**
 * Server-side download capture via Playwright `download` events.
 *
 * By default the worker cancels every download (browser_policy.downloads=false
 * in main.ts). When an app opts in (browser_policy.downloads=true), the context
 * is created with acceptDownloads and this module saves each download to a temp
 * file and keeps a small in-memory index. The `/execute/browser` commands
 * `list_downloads` and `get_download` expose them — `get_download` returns the
 * bytes as base64 (mirroring `screenshot`) so the harness can write the file to
 * its OUTPUTS. Bounded to EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES.
 *
 * `put_download` is the out-of-band path for anything larger: it streams the
 * saved file straight to a caller-supplied presigned PUT URL and returns only
 * metadata. Nothing is buffered, so worker memory is the same for a 2MB file and
 * a 200MB one, and the bytes never enter a JSON response — the base64 route
 * cannot carry those sizes at all (267MB of base64 for a 200MB file, parsed and
 * re-serialised by a 1Gi API pod on the way through).
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
  /** Set once put_download has streamed this file out successfully. The local
   *  copy is unlinked at that point, so `path` is null while `size_bytes` still
   *  reports what was uploaded. */
  uploaded_at?: string;
}

/** Public (path-free) view returned by list_downloads. */
export type DownloadMeta = Omit<DownloadRecord, 'path'>;

const downloadsByContext = new WeakMap<BrowserContext, DownloadRecord[]>();
const MAX_DOWNLOADS = 20; // keep only the most recent N per context
/**
 * Total bytes of captured files kept on disk per context.
 *
 * MAX_DOWNLOADS alone bounds the COUNT, which was sufficient while `get_download`
 * refused anything over 5MB. `put_download` has no size ceiling, so 20 retained
 * exports of a few hundred MB each is several GB of the pod's ephemeral disk —
 * and an ephemeral-storage overrun is answered by the kubelet evicting the pod,
 * not by an error the caller can see. Evict on bytes as well as count.
 */
const MAX_DOWNLOAD_BYTES_TOTAL = 1_073_741_824; // 1GB

/** Drop oldest completed files until the retained bytes fit the budget. */
function evictOverBudget(records: DownloadRecord[], keepId: string): void {
  let total = records.reduce((n, r) => n + (r.path ? r.size_bytes ?? 0 : 0), 0);
  for (const rec of records) {
    if (total <= MAX_DOWNLOAD_BYTES_TOTAL) return;
    if (rec.id === keepId || !rec.path) continue;
    total -= rec.size_bytes ?? 0;
    fs.unlink(rec.path).catch(() => undefined);
    rec.path = null;
    rec.state = 'failed';
    rec.error = 'evicted: download directory over its size budget';
  }
}
// Every captured file is saved under this dir; get_download reads only from here.
const DOWNLOADS_DIR = path.join(os.tmpdir(), 'tabby-downloads');
// Monotonic so ids stay unique once the index caps: `records.length` is read
// BEFORE the push, so past MAX_DOWNLOADS it is always the cap and two downloads
// in the same millisecond collided — get_download(id) then returned whichever
// find() hit first.
let downloadSeq = 0;

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
/**
 * Contexts this module is capturing for. Membership is the honest signal that
 * the context was created with `acceptDownloads` -- Playwright exposes no way
 * to read that back off a BrowserContext, so the only way to know is to record
 * it where it is decided.
 */
const captureEnabled = new WeakSet<BrowserContext>();

/**
 * Contexts whose app carries NO browser_policy at all, as opposed to one that
 * says downloads are off.
 *
 * main.ts falls back to `{ downloads: false, ... }` when `browser_policy` is
 * null, so the two cases produce identical behaviour and, until now, identical
 * reporting. They call for opposite responses: a deliberate `false` is a policy
 * decision to respect, while a missing policy means the app was never
 * configured -- which is what an app orphaned from its template looks like, and
 * what nobody could see while a whole run was spent on it.
 */
const policyAbsent = new WeakSet<BrowserContext>();

/** Record that this context's app had no browser_policy to read. */
export function markBrowserPolicyAbsent(context: BrowserContext): void {
  policyAbsent.add(context);
}

export function enableDownloadCapture(context: BrowserContext): void {
  captureEnabled.add(context);
  if (downloadsByContext.has(context)) {
    return;
  }
  const records: DownloadRecord[] = [];
  downloadsByContext.set(context, records);
  const dir = DOWNLOADS_DIR;

  const attach = (page: Page) => {
    page.on('download', async (download: Download) => {
      const suggested = download.suggestedFilename() || 'download';
      const rec: DownloadRecord = {
        id: `dl-${Date.now()}-${++downloadSeq}`,
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
        // Delete the evicted files too. Dropping only the index entry leaked the
        // bytes: nothing else unlinks them, so a long-lived worker with downloads
        // enabled accumulated every export on the pod's ephemeral disk until the
        // kubelet evicted it.
        for (const dropped of records.splice(0, records.length - MAX_DOWNLOADS)) {
          if (dropped.path) {
            fs.unlink(dropped.path).catch(() => undefined);
          }
        }
      }
      try {
        await fs.mkdir(dir, { recursive: true });
        const dest = path.join(dir, `${rec.id}-${sanitize(suggested)}`);
        await download.saveAs(dest);
        const stat = await fs.stat(dest);
        rec.path = dest;
        rec.size_bytes = stat.size;
        rec.state = 'completed';
        // Only now is the size known, so the byte budget can only be applied here
        // — the push-time eviction above has nothing to weigh.
        evictOverBudget(records, rec.id);
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

/**
 * Metadata for every captured download on this page's context (newest last).
 *
 * `disabled_by_policy` says the context was built WITHOUT acceptDownloads, so
 * main.ts is cancelling every download as it starts. The list is then
 * permanently empty however many times a caller clicks, and an empty list on
 * its own is indistinguishable from "the click did nothing" -- which is how a
 * replay reported "no file arrived" for a step that worked, and a member was
 * asked to waive the one operation they came for.
 */
export function listDownloads(page: Page): {
  downloads: DownloadMeta[];
  disabled_by_policy?: boolean;
  policy_absent?: boolean;
} {
  const context = page.context();
  const records = downloadsByContext.get(context) || [];
  const downloads = records.map(({ path: _p, ...meta }) => meta);
  if (captureEnabled.has(context)) {
    return { downloads };
  }
  // `policy_absent` separates "this app has no browser_policy" from "its policy
  // says no". Both cancel downloads; only one is a configuration fault, and the
  // caller cannot tell them apart from the outcome.
  return policyAbsent.has(context)
    ? { downloads, disabled_by_policy: true, policy_absent: true }
    : { downloads, disabled_by_policy: true };
}

/**
 * Return a captured download's bytes as base64. Without `id`, returns the most
 * recent COMPLETED download. Throws if none, if the target is not completed, or
 * if it exceeds the inline size cap.
 */
/**
 * Resolve the record a download command is addressing and confirm its file is
 * readable. Shared so `get_download` and `put_download` cannot disagree about
 * which download "the last one" is, or about path containment.
 */
function resolveDownload(page: Page, cmd: string, id?: string): DownloadRecord & { path: string } {
  const records = downloadsByContext.get(page.context()) || [];
  const completed = records.filter((r) => r.state === 'completed');
  const rec = id
    ? records.find((r) => r.id === id)
    : completed[completed.length - 1];

  if (!rec) {
    throw new Error(
      id
        ? `${cmd}: no download with id "${id}"`
        : `${cmd}: no completed download available (trigger the download first, then retry)`,
    );
  }
  // An uploaded record keeps its metadata but not its bytes, so say that rather
  // than reporting it as "completed" with a missing file.
  if (rec.uploaded_at && !rec.path) {
    throw new Error(
      `${cmd}: "${rec.suggested_filename}" was already uploaded at ${rec.uploaded_at} and its local copy released`,
    );
  }
  if (rec.state !== 'completed' || !rec.path) {
    throw new Error(`${cmd}: download "${rec.suggested_filename}" is ${rec.state}${rec.error ? ` (${rec.error})` : ''}`);
  }
  // Defense-in-depth: rec.path is always a saveAs() destination we built under
  // DOWNLOADS_DIR from a generated id + sanitize()-d name, but confirm it stays
  // inside that dir before reading (path-traversal containment).
  const rel = path.relative(DOWNLOADS_DIR, rec.path);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${cmd}: refusing to read a path outside the download directory`);
  }
  return rec as DownloadRecord & { path: string };
}

export async function getDownload(
  page: Page,
  id?: string,
): Promise<{ id: string; filename: string; mime_type: string; size_bytes: number; base64: string }> {
  const rec = resolveDownload(page, 'get_download', id);
  if (rec.size_bytes !== null && rec.size_bytes > EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES) {
    throw new Error(
      `get_download: "${rec.suggested_filename}" is ${rec.size_bytes} bytes, over the ${EXECUTE_LIMITS.MAX_RESPONSE_BODY_BYTES}-byte inline limit — use put_download to stream it to an object store instead`,
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

/**
 * Stream a captured download to a presigned PUT URL and return metadata only.
 *
 * The caller (the WDL step) owns the object store and mints the URL, so the
 * worker needs no credentials, no bucket config and no second artifact store —
 * a presigned PUT is scoped to one key, one method and one expiry. Bytes go
 * disk -> HTTP without being buffered, so memory does not scale with file size.
 *
 * On success the local copy is released; on failure it is kept, so a caller
 * whose URL expired mid-flight can mint a fresh one and retry the same id.
 */
export async function putDownload(
  page: Page,
  opts: { id?: string; upload_url: string; headers?: Record<string, string> },
): Promise<{
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  upload_status: number;
}> {
  const uploadUrl = await validateUploadUrl(opts.upload_url, 'put_download');

  const rec = resolveDownload(page, 'put_download', opts.id);
  // A presigned PUT is signed for a specific Content-Length, so the size has to
  // be read from disk now rather than inferred from the download event.
  const stat = await fs.stat(rec.path);

  // On any failure below the local copy is deliberately left in place: the usual
  // cause is an expired presigned URL, and a caller that mints a fresh one can
  // retry the same id rather than re-driving the whole export.
  const uploaded = await uploadToPresignedUrl(
    uploadUrl,
    createReadStream(rec.path),
    stat.size,
    rec.mime_type,
    'put_download',
    opts.headers,
  );

  const uploadedPath = rec.path;
  const stored: DownloadRecord = rec;
  stored.uploaded_at = new Date().toISOString();
  stored.path = null;
  await fs.unlink(uploadedPath).catch(() => undefined);

  return {
    id: rec.id,
    filename: rec.suggested_filename,
    mime_type: rec.mime_type,
    ...uploaded,
  };
}
