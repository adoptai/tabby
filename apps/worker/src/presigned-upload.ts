import { createHash } from 'crypto';
import { lookup as dnsLookupCb } from 'dns';
import { promisify } from 'util';
import { isIP } from 'net';
import { Readable, Transform } from 'stream';
import ipaddr from 'ipaddr.js';
import { ProxyAgent, type Dispatcher } from 'undici';
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
 * Range classification is delegated to `ipaddr.js` rather than spelled out here.
 * The hand-rolled version this replaces unwrapped IPv4-mapped IPv6 with a regex
 * that only matched the dotted form, but Node normalises `[::ffff:127.0.0.1]`
 * to the hex form `::ffff:7f00:1` in `URL.hostname` — so the unwrap never fired
 * and `::ffff:a9fe:a9fe` (169.254.169.254, the metadata endpoint) was ALLOWED.
 * On a dual-stack pod that connect reaches the IPv4 target.
 *
 * The rule is an allowlist, not a blocklist: anything `ipaddr.js` does not
 * classify as ordinary public `unicast` is refused. That covers the transitional
 * IPv6 encodings which each embed an IPv4 address and are each their own range —
 * `ipv4Mapped`, `rfc6052` (the 64:ff9b::/96 NAT64 prefix), `rfc6145`, `6to4`,
 * `teredo` — without needing a case for every one. A blocklist of "bad" ranges
 * is the shape that let the first two bypasses through.
 */
export function isBlockedAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    // Not a parseable literal. Callers only pass values isIP() accepted, so this
    // is unreachable in practice; refusing is the safe answer if it ever is not.
    return true;
  }
  // Check the embedded IPv4 too, not just the wrapper's own range: a mapped
  // address is blocked either way, but this keeps the decision about the address
  // traffic actually reaches.
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress() && (v6.toIPv4Address().range() !== 'unicast')) return true;
  }
  return addr.range() !== 'unicast';
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
 *
 * Accepted residual: this resolves once and the PUT resolves again when it
 * connects, so a record with a low enough TTL could answer safe here and inward
 * there (DNS rebinding). Closing it needs the connection pinned to the address
 * that was checked, which Node's fetch does not expose.
 *
 * An earlier version of this comment named a worker NetworkPolicy as the boundary
 * that does not depend on resolver timing. There is no such policy — the chart
 * defines them for api, controller, postgres, redis and nats only. What actually
 * bounds this is the egress proxy the PUT now goes out through (see
 * egressDispatcher), which decides by hostname against the session allowlist and
 * so is not fooled by a second resolution. This check stays in front of it as
 * defence in depth, and as the only guard when no proxy is configured.
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

  // An IP literal has nothing to resolve: check it and stop. Handing a literal to
  // the resolver only invites it to answer something other than what will be
  // connected to.
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new Error(
        `${cmd}: upload_url host "${host}" is a blocked address ` +
          '(private/loopback/link-local/reserved)',
      );
    }
    return uploadUrl;
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
 * The dispatcher the PUT goes out on, so it leaves the pod the same way the
 * browser's traffic does.
 *
 * The worker launches Chromium behind `EGRESS_PROXY_URL` (main.ts) and that proxy
 * enforces the per-session host allowlist. Node's global `fetch` ignores it, so a
 * PUT issued here would be the one path out of the pod that no allowlist applies
 * to. There is no NetworkPolicy selecting the worker component to fall back on —
 * `charts/browser-hitl/templates/network-policies.yaml` covers api, controller,
 * postgres, redis and nats only — so the egress proxy IS the boundary, and this
 * routes through it rather than around it.
 *
 * Consequence worth knowing when a PUT fails with a proxy refusal rather than a
 * store error: the bucket's host must be in the session's allowlist (or the
 * default one). A presigned URL is not self-authorising as far as egress is
 * concerned.
 *
 * Unset EGRESS_PROXY_URL (local dev, and any deployment not fronted by the proxy)
 * means direct egress, exactly as before.
 */
let cachedProxyAgent: { url: string; agent: ProxyAgent } | undefined;
export function egressDispatcher(): Dispatcher | undefined {
  const egressProxyUrl = (process.env.EGRESS_PROXY_URL || '').trim();
  if (!egressProxyUrl) return undefined;
  if (cachedProxyAgent?.url === egressProxyUrl) return cachedProxyAgent.agent;
  let parsed: URL;
  try {
    parsed = new URL(egressProxyUrl);
  } catch {
    // main.ts tolerates an unparseable value by handing it to Chromium as-is. Here
    // there is no such fallback, and silently going direct would defeat the point
    // of routing through the proxy at all.
    throw new Error(`EGRESS_PROXY_URL is not a valid URL: ${egressProxyUrl}`);
  }
  // Credentials belong in the CONNECT's Proxy-Authorization header, not in the
  // origin URL — the proxy identifies the session by it.
  const token =
    parsed.username || parsed.password
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
        ).toString('base64')}`
      : undefined;
  const agent = new ProxyAgent({ uri: `${parsed.protocol}//${parsed.host}`, token });
  cachedProxyAgent = { url: egressProxyUrl, agent };
  return agent;
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
    // Hash INSIDE the pipeline rather than from a 'data' listener. A listener puts
    // the stream into flowing mode before the web-stream adapter takes it over, so
    // what the hash sees and what the upload sends are only incidentally the same
    // bytes. Through a Transform they are the same bytes by construction: every
    // chunk is hashed exactly once, in order, on its way past.
    const hashing = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    source.on('error', (err) => hashing.destroy(err));
    body = Readable.toWeb(source.pipe(hashing)) as ReadableStream;
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
      // Do NOT follow redirects. validateUploadUrl checked the addresses THIS host
      // resolves to; a 307/308 to 169.254.169.254 would re-issue the PUT at an
      // address that was never checked, which is the whole guard bypassed by a
      // header. Nothing legitimate is lost: a redirect cannot be followed with a
      // stream body anyway (it is not replayable), so the alternative to refusing
      // is failing later and less clearly.
      redirect: 'manual',
      // Node streams a request body only when told the body may still be
      // arriving after the headers; without this, fetch rejects a stream body.
      duplex: 'half',
      // Out through the browser's egress proxy when there is one, so this PUT is
      // subject to the same host allowlist as everything else the pod sends.
      dispatcher: egressDispatcher(),
    } as RequestInit & { duplex: 'half'; dispatcher?: Dispatcher });
  } catch (err) {
    if (!Buffer.isBuffer(source)) source.destroy();
    throw new Error(
      `${cmd}: upload of ${sizeBytes} bytes failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A redirect is not a rejection the caller can retry by re-minting, and its
  // Location is an unvalidated target — report it as the misconfiguration it is
  // rather than letting it fall through as a generic store rejection.
  if (resp.status >= 300 && resp.status < 400) {
    if (!Buffer.isBuffer(source)) source.destroy();
    throw new Error(
      `${cmd}: upload_url redirected (${resp.status}); refusing to follow it. Mint the ` +
        "presigned URL against the bucket's own regional endpoint.",
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
