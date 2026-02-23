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
    const cookies = await this.context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    try {
      const response = await fetch(check.url, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === check.expect_status) {
        return { result: HealthResultType.PASS };
      }

      if (response.status === 401 || response.status === 403) {
        return { result: HealthResultType.AUTH_FAIL, detail: `HTTP ${response.status}` };
      }

      if (response.status >= 300 && response.status < 400) {
        // Redirect - could be auth redirect
        const location = response.headers.get('location') || '';
        if (location.includes('login') || location.includes('auth')) {
          return { result: HealthResultType.AUTH_FAIL, detail: `Redirect to ${location}` };
        }
        return { result: HealthResultType.TRANSIENT_FAIL, detail: `Redirect to ${location}` };
      }

      if (response.status >= 500) {
        return { result: HealthResultType.TRANSIENT_FAIL, detail: `HTTP ${response.status}` };
      }

      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Unexpected status ${response.status}` };
    } catch (error) {
      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Fetch error: ${error}` };
    }
  }

  /**
   * DOM check: verify selector exists on current page (spec section 9.9).
   */
  private async runDomCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    try {
      const locator = this.page.locator(check.selector);
      await locator.waitFor({ timeout: 5000 });

      const visible = await locator.isVisible();
      if (check.exists && visible) {
        return { result: HealthResultType.PASS };
      }
      if (!check.exists && !visible) {
        return { result: HealthResultType.PASS };
      }

      return { result: HealthResultType.AUTH_FAIL, detail: `Selector ${check.exists ? 'not found' : 'found'}` };
    } catch {
      // Timeout or page loading
      return { result: HealthResultType.AUTH_FAIL, detail: `Selector ${check.selector} not found` };
    }
  }

  /**
   * Network check: HTTP client with cookie injection and body matching.
   */
  private async runNetworkCheck(check: any): Promise<{ result: HealthResultType; detail?: string }> {
    const cookies = await this.context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    try {
      const response = await fetch(check.url, {
        headers: { 'Cookie': cookieHeader },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });

      if (response.status === 401 || response.status === 403) {
        return { result: HealthResultType.AUTH_FAIL, detail: `HTTP ${response.status}` };
      }

      if (response.status !== check.expect_status) {
        return { result: HealthResultType.TRANSIENT_FAIL, detail: `HTTP ${response.status}` };
      }

      if (check.body_contains) {
        const body = await response.text();
        if (!body.includes(check.body_contains)) {
          return { result: HealthResultType.AUTH_FAIL, detail: `Body missing: ${check.body_contains}` };
        }
      }

      return { result: HealthResultType.PASS };
    } catch (error) {
      return { result: HealthResultType.TRANSIENT_FAIL, detail: `Fetch error: ${error}` };
    }
  }
}
