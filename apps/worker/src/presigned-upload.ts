import { createHash } from 'crypto';
import { Readable } from 'stream';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';

/**
 * PUT bytes to a caller-minted presigned URL.
 *
 * Both sinks — `/execute/fetch`'s `upload_url` and `/execute/browser`'s
 * `put_download` — go through here so they cannot drift in how they validate a
 * URL, set Content-Length, or report a rejection. (A predicate duplicated across
 * two call sites in this same file is exactly what let the OOXML content-type bug
 * survive; one exported helper is the fix that stuck.)
 *
 * The worker never holds object-store credentials: a presigned PUT is scoped to
 * one key, one method and one expiry, and is minted by the caller that owns the
 * bucket.
 */

export interface PresignedUploadResult {
  size_bytes: number;
  sha256: string;
  upload_status: number;
}

/** Reject a URL we should not be PUTting to before any bytes are read. */
export function validateUploadUrl(uploadUrl: unknown, cmd: string): string {
  if (typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new Error(`${cmd}: "upload_url" is required (a presigned PUT URL)`);
  }
  let parsed: URL;
  try {
    parsed = new URL(uploadUrl);
  } catch {
    throw new Error(`${cmd}: invalid upload_url: ${uploadUrl}`);
  }
  if (!EXECUTE_LIMITS.ALLOWED_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`${cmd}: upload_url scheme "${parsed.protocol}" not allowed. Use http: or https:`);
  }
  return uploadUrl;
}

/**
 * Send `source` to `uploadUrl`, hashing as the bytes go past.
 *
 * `source` is either a Buffer (the /execute/fetch path, where Playwright's
 * APIResponse has already materialised the body) or a Readable (the download
 * path, which never materialises it at all). `sizeBytes` must be the exact byte
 * count: a presigned PUT is signed for a specific Content-Length, and S3 rejects
 * a mismatch rather than storing a short object.
 */
export async function uploadToPresignedUrl(
  uploadUrl: string,
  source: Buffer | Readable,
  sizeBytes: number,
  contentType: string,
  cmd: string,
  extraHeaders?: Record<string, string>,
): Promise<PresignedUploadResult> {
  const hash = createHash('sha256');
  let body: BodyInit;
  if (Buffer.isBuffer(source)) {
    hash.update(source);
    body = new Uint8Array(source);
  } else {
    source.on('data', (chunk) => hash.update(chunk));
    body = Readable.toWeb(source) as ReadableStream;
  }

  let resp: Response;
  try {
    resp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(sizeBytes),
        ...(extraHeaders || {}),
      },
      body,
      // Node streams a request body only when told the body may still be
      // arriving after the headers; without this, fetch rejects a stream body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  } catch (err) {
    if (!Buffer.isBuffer(source)) source.destroy();
    throw new Error(
      `${cmd}: upload of ${sizeBytes} bytes failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!resp.ok) {
    // Surface the store's own words. The usual cause is an expired or mis-signed
    // URL, and a caller that can read that can mint a new one and retry.
    const detail = await resp.text().catch(() => '');
    throw new Error(
      `${cmd}: object store rejected the upload with ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ''}`,
    );
  }

  return { size_bytes: sizeBytes, sha256: hash.digest('hex'), upload_status: resp.status };
}
