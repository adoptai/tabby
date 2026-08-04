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

    for (const check of checks) {
      const start = Date.now();
      let result: HealthResultType;
      let detail: string | undefined;

      try {
        switch (check.type) {
          case 'url_check':
            ({ result, detail } = await this.runUrlCheck(check));
            break;
          case 'dom_check':
            ({ result, detail } = await this.runDomCheck(check));
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
    }

    const overall = evaluateHealthPolicy(results, policy, quorumN);

    return {
      overall,
      checks: results,
      policy,
      evaluated_at: new Date().toISOString(),
    };
  }

  /**
   * URL check via HTTP client with session cookies (spec section 9.9).
   * Uses direct fetch, NOT browser navigation.
   */
  private async runUrlCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    const timeoutMs = check.timeout_ms ?? 15000;

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

    if (check.exists) {
      try {
        await first.waitFor({ state: 'visible', timeout });
        return { result: HealthResultType.PASS };
      } catch (error) {
        return {
          result: HealthResultType.AUTH_FAIL,
          detail: `Selector ${check.selector} not visible: ${error}`,
        };
      }
    }

    try {
      await first.waitFor({ state: 'hidden', timeout });
      return { result: HealthResultType.PASS };
    } catch (error) {
      // Report WHY. A bare "found" hid the difference between the marker really
      // being on the page and the check itself misfiring.
      return {
        result: HealthResultType.AUTH_FAIL,
        detail: `Selector ${check.selector} still visible: ${error}`,
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
