import type { RecordingHar } from '@browser-hitl/shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Reduce a HAR to metadata for `workflow` recordings.
 *
 * A browser skill's contract is the DOM and the route, not the wire. It never
 * replays a request, so request/response bodies, headers and query strings are
 * pure cost — and on a bank portal they are a serious liability: balances,
 * account numbers, statement contents and live auth tokens, sitting in the
 * recording bundle in S3.
 *
 * What survives is what a browser skill can actually use:
 *  - WHEN a click caused traffic, and when that traffic finished, which is how
 *    the compiler emits a real wait condition instead of a guessed sleep
 *  - WHETHER a click did anything at all, which distinguishes a state
 *    transition from a no-op click on a wrapper div
 *
 * The HAR 1.2 SHAPE is preserved rather than replaced with a leaner structure,
 * deliberately: anything already reading `har.log.entries[].request.url` keeps
 * working, and the reduction cannot break a consumer we have not audited. The
 * fields are emptied, not deleted, for the same reason.
 *
 * Never applied to `login` recordings — there the HAR *is* the contract, and it
 * is what the HAR-replay compiler consumes.
 */
export function stripHarPayloads(har: RecordingHar): RecordingHar {
  const entries = (har?.log?.entries || []) as any[];

  const stripped = entries.map((e: any) => {
    const req = e?.request || {};
    const res = e?.response || {};
    return {
      // Timing is the whole point of keeping this at all.
      startedDateTime: e?.startedDateTime,
      time: e?.time,
      request: {
        method: req.method,
        // The path identifies the endpoint; the query string is where the
        // account numbers and session ids live, so it does not survive.
        url: stripQuery(req.url),
        headers: [],
        queryString: [],
        postData: bodyShape(req.postData),
      },
      response: {
        status: res.status,
        statusText: res.statusText,
        headers: [],
        // Keep the type — "this click fetched JSON" vs "this click fetched an
        // image" is a real signal — but never the bytes.
        content: { mimeType: res?.content?.mimeType || '', text: '' },
      },
    };
  });

  return {
    log: {
      version: har?.log?.version || '1.2',
      creator: har?.log?.creator || { name: 'tabby-recording', version: '1.0' },
      entries: stripped,
    },
  };
}

/** Cap so a pathological body cannot bloat the bundle. */
const MAX_BODY_KEYS = 24;
const MAX_KEY_LEN = 48;

/**
 * The SHAPE of a request body, with none of its content.
 *
 * This exists for one specific downstream consumer: noui's `detect_unreplayable`,
 * which decides whether an app can be compiled as a HAR-replay skill at all or
 * must be driven through the browser. Its fingerprint is an app that encrypts
 * every request body in page JavaScript — bodies that are opaque `{data, key}`
 * envelopes, alongside a key-fetch endpoint. ICICI is the canonical case: replay
 * compiles 40 operations that all 403.
 *
 * That detector needs exactly two facts, and neither is content:
 *   - the top-level JSON field NAMES, to test them against the envelope key set
 *   - whether any top-level value is a long string, i.e. looks like ciphertext
 *
 * Field names are schema; values are the customer's data. Emitting names keeps
 * the browser-vs-replay decision automatic while balances, PANs and tokens still
 * never leave the pod. Dropping the body entirely — which an earlier cut of this
 * function did — silently removed the ability to make that decision at all.
 */
function bodyShape(postData: unknown): Record<string, unknown> {
  const pd = (postData || {}) as any;
  const text = typeof pd.text === 'string' ? pd.text : '';
  const shape: Record<string, unknown> = { mimeType: pd.mimeType || '' };
  if (!text) return shape;

  shape.size = text.length;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const keys = Object.keys(parsed).slice(0, MAX_BODY_KEYS);
      shape.keys = keys.map((k) => String(k).slice(0, MAX_KEY_LEN));
      // "Does this look like ciphertext" is a length question, not a content one.
      shape.long_values = keys.some((k) => {
        const v = (parsed as any)[k];
        return typeof v === 'string' && v.length >= 16;
      });
    }
  } catch {
    // Not JSON (form-encoded, binary, multipart). Its size and mime type are
    // still recorded; the envelope test simply does not apply to it.
  }
  return shape;
}

function stripQuery(url: unknown): string {
  const raw = String(url || '');
  if (!raw) return '';
  const cut = raw.indexOf('?');
  const noQuery = cut === -1 ? raw : raw.slice(0, cut);
  const hash = noQuery.indexOf('#');
  return hash === -1 ? noQuery : noQuery.slice(0, hash);
}
