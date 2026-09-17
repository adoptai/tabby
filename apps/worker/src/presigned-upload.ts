import { createHash } from 'crypto';
import { lookup as dnsLookupCb } from 'dns';
import { promisify } from 'util';
import { isIP } from 'net';
import { Readable } from 'stream';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';

const dnsLookup = promisify(dnsLookupCb);

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

/**
 * Is this address one the worker must never be aimed at?
 *
 * Mirrors the platform's own via:tabby target guard. Cloud metadata lives on a
 * link-local address, and internal services on private ranges — both are
 * reachable from the pod, and `upload_url` is caller-supplied.
 */
function isBlockedAddress(ip: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||            // link-local, incl. 169.254.169.254 metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
      a >= 224                               // multicast + reserved
    );
  }
  const v6 = ip.toLowerCase().split('%')[0];
  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd]/.test(v6)) return true;        // unique-local
  if (/^fe[89ab]/.test(v6)) return true;     // link-local
  // IPv4-mapped (::ffff:a.b.c.d) — unwrap and re-check rather than trusting the prefix.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  return mapped ? isBlockedAddress(mapped[1]) : false;
}

/**
 * Reject a URL we should not be PUTting to before any bytes are read.
 *
 * The PUT goes out through Node's fetch rather than the BrowserContext's request
 * API, because only the former can stream a body — `put_download` would have to
 * buffer a whole export to use the latter, which is the thing it exists to
 * avoid. That means it does NOT inherit the browser's proxy/egress allowlist, so
 * the host has to be checked here: every resolved address is tested, not just a
 * literal, so a name that resolves inward is refused too.
 */
export async function validateUploadUrl(uploadUrl: unknown, cmd: string): Promise<string> {
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
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!host) {
    throw new Error(`${cmd}: upload_url has no host`);
  }

  const candidates = new Set<string>([host]);
  try {
    for (const { address } of await dnsLookup(host, { all: true })) {
      candidates.add(address);
    }
  } catch {
    // A name we cannot resolve is left to the upload itself to fail. Failing closed
    // here would break a store whose DNS differs from the worker's resolver, and the
    // literal-address check above still applies.
  }
  for (const candidate of candidates) {
    if (isIP(candidate) && isBlockedAddress(candidate)) {
      throw new Error(
        `${cmd}: upload_url host "${host}" resolves to blocked address ${candidate} ` +
          '(private/loopback/link-local/reserved)',
      );
    }
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
        // Caller headers first so the computed ones win. A caller-supplied
        // Content-Length that disagrees with the body is how a short object gets
        // stored under a full-looking size, and Content-Type is what the store
        // hands back to whoever downloads it.
        ...(extraHeaders || {}),
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': String(sizeBytes),
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
    // The status is what a caller acts on (mint a fresh URL and retry). The body is
    // NOT returned: echoing an arbitrary host's response back to the caller turns
    // this into a read oracle for anything the pod can reach. Logged instead, so it
    // is still there for whoever is debugging a mis-signed URL.
    const detail = await resp.text().catch(() => '');
    if (detail) {
      console.error(`${cmd}: upload rejected (${resp.status}): ${detail.slice(0, 500)}`);
    }
    throw new Error(
      `${cmd}: object store rejected the upload with ${resp.status} ` +
        '(see worker logs for the store\'s response)',
    );
  }

  return { size_bytes: sizeBytes, sha256: hash.digest('hex'), upload_status: resp.status };
}
