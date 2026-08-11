import { Page, BrowserContext } from 'playwright';
import {
  HealthResultType,
  HealthCheck, HealthCheckResult, HealthEvaluationResult,
  evaluateHealthPolicy, HealthPolicy,
} from '@browser-hitl/shared';

/**
 * Health Predicate Runner per spec section 9.9 and 10.4.
 *
 * Evaluation types:
 * - url_check: HTTP client with session cookies (not browser navigation)
 * - dom_check: page.waitForSelector on current page
 * - network_check: HTTP client with cookie injection
 *
 * Returns PASS/TRANSIENT_FAIL/AUTH_FAIL per check.
 */
/**
 * Pages that mean "this session is over", when a profile names none itself.
 *
 * Narrow on purpose. "auth" is absent because ICICI serves its statement portal
 * from AuthenticationController, and matching that would fail a healthy session
 * in the middle of the workflow it is meant to protect.
 */
export const DEFAULT_AUTH_REDIRECT_PATTERN =
  '(session[-_]?expire|session[-_]?timeout|logged[-_]?out|/logout|/login|/signin|/sign-in)' +
  // Not followed by more word characters: /accounts/logins-history is an
  // ordinary page and matched "/login" without this. /login-page still does,
  // because a hyphen ends the word.
  '(?![a-z0-9])';

export class HealthPredicateRunner {
  constructor(
    private readonly page: Page,
    private readonly context: BrowserContext,
    private keepaliveConfig: any,
  ) {}

  setKeepaliveConfig(keepaliveConfig: any): void {
    this.keepaliveConfig = keepaliveConfig || {};
  }

  async evaluate(): Promise<HealthEvaluationResult> {
    const checks: HealthCheck[] = this.keepaliveConfig?.health_checks || [];
    const policy: HealthPolicy = this.keepaliveConfig?.policy || 'all';
    const quorumN = this.keepaliveConfig?.quorum_n;

    const results: HealthCheckResult[] = [];
    // A check that could not be ASKED is not a check that failed. Tracked apart
    // so the caller can decline to record a verdict rather than inventing one.
    const unevaluableOnly: HealthCheck[] = [];
    const realVerdicts: HealthCheck[] = [];

    for (const check of checks) {
      const start = Date.now();
      let result: HealthResultType;
      let detail: string | undefined;
      let unevaluable = false;

      try {
        switch (check.type) {
          case 'url_check':
            ({ result, detail } = await this.runUrlCheck(check));
            break;
          case 'dom_check':
            ({ result, detail, unevaluable = false } = await this.runDomCheck(check) as any);
            break;
          case 'network_check':
            ({ result, detail } = await this.runNetworkCheck(check));
            break;
          default:
            result = HealthResultType.TRANSIENT_FAIL;
            detail = `Unknown check type: ${(check as any).type}`;
        }
      } catch (error) {
        result = HealthResultType.TRANSIENT_FAIL;
        detail = `Error: ${error}`;
      }

      results.push({
        check,
        result,
        detail,
        duration_ms: Date.now() - start,
      });

      // A failing health check drives the whole session lifecycle (AUTH_FAIL ->
      // LOGIN_NEEDED, and every consumer that reads session health), so the reason
      // must be visible in the pod log. Debugging a wrong verdict without it means
      // guessing at the selector.
      if (result !== HealthResultType.PASS) {
        console.log(`[Health] ${check.type} -> ${result}${detail ? `: ${detail}` : ''}`);
      }
      if (result !== HealthResultType.PASS && unevaluable) unevaluableOnly.push(check);
      else if (result !== HealthResultType.PASS) realVerdicts.push(check);
    }

    const overall = evaluateHealthPolicy(results, policy, quorumN);

    return {
      overall,
      checks: results,
      policy,
      evaluated_at: new Date().toISOString(),
      // Nothing here is a measurement: every non-PASS was a check that could
      // not be asked (the page was mid-navigation), and no check produced a
      // real verdict. Recording TRANSIENT_FAIL for that drives the session to
      // UNHEALTHY, execute/browser then refuses, and a replay dies on a session
      // that was never unwell.
      unevaluable: unevaluableOnly.length > 0 && realVerdicts.length === 0,
    } as HealthEvaluationResult & { unevaluable: boolean };
  }

  /**
   * URL check via HTTP client with session cookies (spec section 9.9).
   * Uses direct fetch, NOT browser navigation.
   */
  private async runUrlCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    const timeoutMs = check.timeout_ms ?? 15000;

    // Where the LIVE browser actually is, checked FIRST. An SPA enforces session
    // expiry client-side: the JS detects a dead session and route-changes to a
    // /session-expire page, but the server still serves the app shell with HTTP
    // 200 on every route. So the APIRequestContext GET below can't see it — it
    // gets 200 and PASSes while the user is staring at "Your session has
    // expired" (observed on ICICI: HEALTHY/PASS on /session-expire). If the
    // browser page itself is already sitting on an auth/expiry URL, that is
    // ground truth the HTTP probe cannot override.
    // A DEFAULT when the profile configures none. This detection existed and
    // never ran on ICICI, whose profile sets no auth_redirect_pattern -- so the
    // session reported HEALTHY/PASS while the browser sat on /session-expire,
    // and every downstream failure looked like a mystery instead of an expiry.
    //
    // Deliberately narrow: no bare "auth", because this bank serves its
    // statement portal from a controller named AuthenticationController and
    // flagging that would kill healthy sessions mid-workflow.
    const authPattern = check.auth_redirect_pattern || DEFAULT_AUTH_REDIRECT_PATTERN;
    if (authPattern) {
      try {
        const liveUrl = this.page.url();
        if (new RegExp(authPattern, 'i').test(liveUrl)) {
          return {
            result: HealthResultType.AUTH_FAIL,
            detail: `Live page is on an auth/expiry URL: ${liveUrl}`,
          };
        }
      } catch {
        // page.url() should never throw, but never let it break the check.
      }
    }

    try {
      // Use Playwright's APIRequestContext — it inherits the browser's proxy
      // and cookies, so it can reach external URLs through the egress proxy.
      const response = await this.context.request.get(check.url, {
        timeout: timeoutMs,
        maxRedirects: 5,
      });

      const finalUrl = response.url();
      const isAuthRedirect = check.auth_redirect_pattern
        ? new RegExp(check.auth_redirect_pattern, 'i').test(finalUrl)
        : finalUrl !== check.url && this.looksLikeAuthUrl(finalUrl);

      if (isAuthRedirect) {
        return { result: HealthResultType.AUTH_FAIL, detail: `Redirected to auth: ${finalUrl}` };
      }

      if (response.status() === check.expect_status) {
        return { result: HealthResultType.PASS };
      }

      if (response.status() === 401 || response.status() === 403) {
        return { result: HealthResultType.AUTH_FAIL, detail: `HTTP ${response.status()}` };
      }

      if (response.status() >= 500) {
        return { result: HealthResultType.TRANSIENT_FAIL, detail: `HTTP ${response.status()}` };
      }

      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Unexpected status ${response.status()} (url: ${finalUrl})` };
    } catch (error) {
      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Request error: ${error}` };
    }
  }

  /**
   * Heuristic: does the URL look like an auth/login page?
   * Checks both path segments and hostname parts (e.g. "identity.workday.com",
   * "authgwy-impl.workday.com"). Only triggers on word-boundary matches to avoid
   * false positives like "/authorization-settings" or "/login-history".
   */
  private looksLikeAuthUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostAndPath = parsed.hostname + parsed.pathname;
      return /\b(login|signin|sign-in|sso|oauth|saml|authgw[y]?|identity)\b/i.test(hostAndPath);
    } catch {
      return false;
    }
  }

  /**
   * DOM check: verify selector exists on current page (spec section 9.9).
   *
   * Note the failure classification below (`classifyDomCheckError`): a dom_check
   * that could not be *evaluated* is not evidence about authentication.
   */
  private async runDomCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    const locator = this.page.locator(check.selector);
    const timeout = check.timeout_ms ?? 5000;

    // `exists: false` asserts the selector is ABSENT — which is the whole point of
    // a negative check: assert the logged-out marker (a login form, an auth error
    // page) is gone. The previous implementation always waited for the element to
    // appear and treated the resulting timeout as AUTH_FAIL, so an absent selector
    // — the passing condition — reported failure. A negative check could therefore
    // never pass, and the only way to detect "signed out" on an SPA portal was
    // unavailable.
    //
    // Wait for the state each mode actually wants. Playwright's 'hidden' resolves
    // when the element is detached OR present-but-invisible, which is what "not
    // showing the logged-out marker" means in practice.
    // .first() throughout: a selector matching several nodes (very easy with a
    // text= selector on a rich page) makes a bare locator.waitFor throw a strict-mode
    // violation, and the catch below cannot tell that apart from the element genuinely
    // being there — so a logged-IN page reported AUTH_FAIL. Matching the first node is
    // the right semantics for a presence check anyway.
    const first = locator.first();

    // What `exists` means is selectable via `match`, defaulting to DOM presence:
    //
    //   'attached' (default) — the marker is in the DOM at all. CSS visibility is
    //     a different question that SPA portals answer badly: Playwright reports
    //     the sidebar link of a fully logged-in ICICI dashboard as hidden
    //     (`20 x locator resolved to hidden <a class="mb-0">Payment & Transfer</a>`),
    //     so a signed-in session reported AUTH_FAIL. Salesforce Lightning and
    //     Workday do the same (see the gotchas in CLAUDE.md); it is the single
    //     most common cause of a false AUTH_FAIL on this platform.
    //
    //   'visible' — opt back in to strict CSS visibility. Needed by portals that
    //     HIDE rather than unmount their logged-in chrome on sign-out: there the
    //     marker stays attached on the login page, so 'attached' would report
    //     PASS on a dead session and it would never transition to LOGIN_NEEDED.
    //     Opt-in rather than default, because defaulting to it reintroduces the
    //     dominant false-AUTH_FAIL above for every SPA app.
    const strictVisibility = check.match === 'visible';

    if (check.exists) {
      try {
        await first.waitFor({ state: strictVisibility ? 'visible' : 'attached', timeout });
        return { result: HealthResultType.PASS };
      } catch (error) {
        const unevaluable = classifyDomCheckError(error);
        if (unevaluable) return unevaluable;
        if (isUniversalSelector(check.selector)) {
          // See UNIVERSAL_SELECTORS: an absent `body` means the document is not
          // there, which is a transient state on any portal that navigates.
          // Calling it AUTH_FAIL drives the session to LOGIN_NEEDED and, on a
          // recording session, interrupts a human mid-sign-in for nothing.
          return {
            result: HealthResultType.TRANSIENT_FAIL,
            detail: `Selector ${check.selector} matches any loaded page, so its absence means the document was not ready, not that the session ended: ${error}`,
          };
        }
        return {
          result: HealthResultType.AUTH_FAIL,
          detail: strictVisibility
            ? `Selector ${check.selector} not visible: ${error}`
            : `Selector ${check.selector} not in DOM: ${error}`,
        };
      }
    }

    // Negative check: assert the logged-OUT marker is gone. Mirror the mode —
    // under strict visibility "gone" means Playwright's 'hidden' (detached OR
    // present-but-invisible), which is what "not showing the marker" means to a
    // user; under DOM presence it means fully detached.
    try {
      await first.waitFor({ state: strictVisibility ? 'hidden' : 'detached', timeout });
      return { result: HealthResultType.PASS };
    } catch (error) {
      const unevaluable = classifyDomCheckError(error);
      if (unevaluable) return unevaluable;
      // Report WHY. A bare "found" hid the difference between the marker really
      // being on the page and the check itself misfiring.
      return {
        result: HealthResultType.AUTH_FAIL,
        detail: strictVisibility
          ? `Selector ${check.selector} still showing: ${error}`
          : `Selector ${check.selector} still in DOM: ${error}`,
      };
    }
  }

  /**
   * Network check: HTTP client with cookie injection and body matching.
   */
  private async runNetworkCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    const timeoutMs = check.timeout_ms ?? 15000;

    try {
      const response = await this.context.request.get(check.url, {
        timeout: timeoutMs,
        maxRedirects: 0,
      });

      if (response.status() === 401 || response.status() === 403) {
        return { result: HealthResultType.AUTH_FAIL, detail: `HTTP ${response.status()}` };
      }

      if (response.status() !== check.expect_status) {
        return { result: HealthResultType.TRANSIENT_FAIL, detail: `HTTP ${response.status()}` };
      }

      if (check.body_contains) {
        const body = await response.text();
        if (!body.includes(check.body_contains)) {
          return { result: HealthResultType.AUTH_FAIL, detail: `Body missing: ${check.body_contains}` };
        }
      }

      return { result: HealthResultType.PASS };
    } catch (error) {
      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Request error: ${error}` };
    }
  }
}

/**
 * Separate "the marker is not there" from "the check could not be run".
 *
 * Every failure inside runDomCheck used to map to AUTH_FAIL, which conflates a
 * genuine timeout (the logged-in marker really is gone — signed out, the verdict
 * we want) with failures that say nothing at all about authentication:
 *
 *   - the page navigated while the locator was resolving, so the execution
 *     context was destroyed under it. Common on any portal that redirects or
 *     re-renders on a timer, and on every SPA route change.
 *   - the page/context/browser closed, i.e. the pod is shutting down. This wrote
 *     a final AUTH_FAIL on the way out and left the session looking signed out.
 *   - the selector itself is malformed. A typo in a profile's health_checks
 *     turned every session for that app permanently "signed out" — the worst
 *     shape of this bug, because it is silent, total, and looks like a real auth
 *     failure to everyone downstream.
 *
 * AUTH_FAIL is not a neutral verdict: it drives the session to LOGIN_NEEDED,
 * raises HITL, and shows a human a sign-in card. Claiming it on no evidence is
 * strictly worse than admitting the check did not run, which is what
 * TRANSIENT_FAIL means and which the caller already handles.
 *
 * Returns null when the error is NOT one of these — so an unrecognised error
 * keeps the previous AUTH_FAIL behaviour rather than silently becoming
 * TRANSIENT_FAIL. A plain Playwright timeout is the overwhelmingly common case
 * and must stay AUTH_FAIL; this only carves out the classes we can positively
 * identify as uninformative.
 */
/**
 * Selectors that exist in every rendered HTML document.
 *
 * A timeout on one of these is never evidence about authentication. Every page
 * has a body; if it cannot be found the document is loading, navigating or
 * blank — not signed out. Apps configure `dom_check` on `body` as a cheap
 * liveness probe (the recording-shell app does exactly this), and on a portal
 * that replaces the document during login the check lands mid-navigation and
 * times out. Reported as AUTH_FAIL that flipped a perfectly healthy recording
 * session to UNHEALTHY while the human was signing in; it passed again on the
 * next cycle 55 seconds later.
 */
const UNIVERSAL_SELECTORS = new Set(['body', 'html', ':root', 'body *', 'html body']);

/** Would this selector match on any loaded page, regardless of auth state? */
export function isUniversalSelector(selector: unknown): boolean {
  return UNIVERSAL_SELECTORS.has(String(selector ?? '').trim().toLowerCase());
}

export function classifyDomCheckError(
  error: unknown,
): { result: HealthResultType; detail: string; unevaluable: true } | null {
  const message = error instanceof Error ? error.message : String(error);

  // Page moved (navigation / SPA re-render) while the locator was resolving.
  //
  // "navigation to finish" is the case that bit: a cross-origin hop completes
  // asynchronously AFTER the command that caused it returns, so a health cycle
  // landing in that window waits on a navigation nobody is failing. Observed on
  // ICICI: dom_check on `body` timed out after 5s waiting for the statement
  // portal, reported a fault on a healthy session, and stopped a replay one
  // operation from the end -- the next cycle passed. With a non-universal
  // selector the same race returns AUTH_FAIL, which shows a member a sign-in
  // card in the middle of a working task.
  if (
    /execution context was destroyed|because of a navigation|frame (was |got )?detached|navigation to finish/i.test(
      message,
    )
  ) {
    return {
      result: HealthResultType.TRANSIENT_FAIL,
      detail: `dom_check raced a navigation, no auth signal: ${message}`,
      unevaluable: true as const,
    };
  }

  // Pod teardown, or the browser died.
  if (/target (page, context or browser )?(has been )?closed|browser has been closed|page has been closed|target closed/i.test(message)) {
    return {
      result: HealthResultType.TRANSIENT_FAIL,
      detail: `dom_check ran against a closed page, no auth signal: ${message}`,
      unevaluable: true as const,
    };
  }

  // Malformed selector in the app's health_checks config.
  if (/not a valid selector|while parsing selector|failed to parse selector|unknown engine/i.test(message)) {
    return {
      result: HealthResultType.TRANSIENT_FAIL,
      detail: `dom_check selector is invalid — fix the app's health_checks config: ${message}`,
      unevaluable: true as const,
    };
  }

  return null;
}
