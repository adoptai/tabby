import { HealthPredicateRunner } from './health-predicate-runner';
import { HealthResultType } from '@browser-hitl/shared';

/**
 * Page stub whose locator resolves waitFor() per requested state.
 *
 * `present` models whether the selector is in the DOM: Playwright resolves
 * `state: 'attached'` only when it is, and `state: 'detached'` only when it is
 * not. The runner deliberately asks about DOM presence rather than CSS
 * visibility — SPA portals render logged-in chrome that Playwright reports as
 * hidden, which made signed-in sessions fail.
 */
function makePage(present: boolean) {
  return {
    locator: jest.fn().mockReturnValue({
      // .first() is what the runner actually waits on — a bare locator throws a
      // strict-mode violation when the selector matches several nodes.
      first: jest.fn().mockReturnValue({
        waitFor: jest.fn(async ({ state }: { state?: string }) => {
          const wanted = state === 'detached' ? !present : present;
          if (!wanted) throw new Error('Timeout waiting for selector');
        }),
      }),
    }),
    url: jest.fn().mockReturnValue('https://app.test/dashboard'),
  } as any;
}

const CONTEXT = { request: {} } as any;

function runner(page: any, check: Record<string, unknown>) {
  return new HealthPredicateRunner(page, CONTEXT, { health_checks: [check], policy: 'all' });
}

/** Page + context stubs for url_check: page.url() is the LIVE browser URL; the
 *  APIRequestContext GET returns a fixed 200 (the SPA shell, served on every
 *  route regardless of auth). */
function makeUrlCheckPage(liveUrl: string) {
  const page = { url: jest.fn().mockReturnValue(liveUrl) } as any;
  const context = {
    request: {
      get: jest.fn(async () => ({ url: () => liveUrl, status: () => 200 })),
    },
  } as any;
  return { page, context };
}

describe('HealthPredicateRunner — url_check live-page detection', () => {
  const CHECK = {
    type: 'url_check',
    url: 'https://bank.test/credit-card',
    expect_status: 200,
    auth_redirect_pattern: '/login|/session-expire|/logout',
  };

  it('AUTH_FAIL when the live browser is on an auth/expiry URL, even though the HTTP probe 200s', async () => {
    // The ICICI case: SPA route-changed the browser to /session-expire client-
    // side, but the server still serves the shell with 200 on every route, so
    // the APIRequestContext GET alone would wrongly PASS.
    const { page, context } = makeUrlCheckPage('https://bank.test/session-expire');
    const r = new HealthPredicateRunner(page, context, { health_checks: [CHECK], policy: 'all' });
    const res = await r.evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
    expect(res.checks[0].detail).toMatch(/Live page is on an auth/);
  });

  it('PASS when the live page is on a normal authenticated route', async () => {
    const { page, context } = makeUrlCheckPage('https://bank.test/credit-card');
    const r = new HealthPredicateRunner(page, context, { health_checks: [CHECK], policy: 'all' });
    const res = await r.evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.PASS);
  });
});

describe('HealthPredicateRunner — dom_check', () => {
  it('passes when an expected selector is present', async () => {
    const res = await runner(makePage(true), {
      type: 'dom_check', selector: '#dashboard', exists: true,
    }).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.PASS);
  });

  it('fails when an expected selector is missing', async () => {
    const res = await runner(makePage(false), {
      type: 'dom_check', selector: '#dashboard', exists: true,
    }).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
  });

  // The regression this file exists for.
  //
  // `exists: false` asserts the selector is ABSENT — the way to say "the
  // logged-out marker is gone". The old implementation always waited for the
  // element to appear and mapped the resulting timeout to AUTH_FAIL, so the
  // passing condition reported failure and a negative check could never pass.
  // That left no way to detect "signed out" on an SPA portal, where every route
  // returns 200 whether or not anyone is authenticated.
  it('passes when a selector asserted absent really is absent', async () => {
    const res = await runner(makePage(false), {
      type: 'dom_check', selector: 'text=Please click the login button', exists: false,
    }).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.PASS);
  });

  it('fails when a selector asserted absent is present', async () => {
    const res = await runner(makePage(true), {
      type: 'dom_check', selector: 'text=Please click the login button', exists: false,
    }).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
    expect(res.checks[0].detail).toMatch(/still in DOM/);
  });

  // Regression: asking for 'visible' made a fully signed-in ICICI dashboard
  // report AUTH_FAIL — Playwright resolved its sidebar link to
  // "hidden <a class=\"mb-0\">Payment & Transfer</a>" 20 times in a row while the
  // user was looking at it on screen. The check is named `exists`; DOM presence
  // is what it must test.
  it('tests DOM presence, not CSS visibility', async () => {
    const page = makePage(true);
    await runner(page, { type: 'dom_check', selector: '#x', exists: true }).evaluate();
    expect(page.locator().first().waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'attached' }),
    );

    const page2 = makePage(false);
    await runner(page2, { type: 'dom_check', selector: '#x', exists: false }).evaluate();
    expect(page2.locator().first().waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'detached' }),
    );
  });
});
