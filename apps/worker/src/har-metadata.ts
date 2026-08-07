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
        postData: {},
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

function stripQuery(url: unknown): string {
  const raw = String(url || '');
  if (!raw) return '';
  const cut = raw.indexOf('?');
  const noQuery = cut === -1 ? raw : raw.slice(0, cut);
  const hash = noQuery.indexOf('#');
  return hash === -1 ? noQuery : noQuery.slice(0, hash);
}
