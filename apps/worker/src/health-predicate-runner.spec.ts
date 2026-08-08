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

  // DOM presence is right for SPA portals, but it silently redefined `exists`
  // for every stored config: a portal that HIDES rather than unmounts its
  // logged-in chrome on sign-out keeps the marker attached on the login page, so
  // 'attached' reports PASS on a dead session and it never reaches LOGIN_NEEDED.
  // `match: 'visible'` is the opt-out for those.
  it('honors match:visible as an opt-out to strict CSS visibility', async () => {
    const page = makePage(true);
    await runner(page, {
      type: 'dom_check', selector: '#x', exists: true, match: 'visible',
    }).evaluate();
    expect(page.locator().first().waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'visible' }),
    );
  });

  // Under strict visibility, "the logged-out marker is gone" means Playwright's
  // 'hidden' (detached OR present-but-invisible) — which is what the comment at
  // the top of runDomCheck always claimed, while the code used 'detached'.
  it('uses hidden (not detached) for a negative check under match:visible', async () => {
    const page = makePage(false);
    await runner(page, {
      type: 'dom_check', selector: '#x', exists: false, match: 'visible',
    }).evaluate();
    expect(page.locator().first().waitFor).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'hidden' }),
    );
  });

  it('reports which mode failed so a false AUTH_FAIL is diagnosable', async () => {
    const res = await runner(makePage(false), {
      type: 'dom_check', selector: '#dashboard', exists: true, match: 'visible',
    }).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
    expect(res.checks[0].detail).toMatch(/not visible/);
  });
});

/**
 * A dom_check that could not be EVALUATED is not evidence about authentication.
 *
 * Every failure used to map to AUTH_FAIL, which is not a neutral verdict: it
 * drives the session to LOGIN_NEEDED, raises HITL and shows a human a sign-in
 * card. These three classes say nothing about whether anyone is signed in.
 */
describe('HealthPredicateRunner — dom_check cannot claim AUTH_FAIL on its own failure', () => {
  function pageThatThrows(message: string) {
    return {
      locator: jest.fn().mockReturnValue({
        first: jest.fn().mockReturnValue({
          waitFor: jest.fn(async () => {
            throw new Error(message);
          }),
        }),
      }),
      url: jest.fn().mockReturnValue('https://app.test/dashboard'),
    } as any;
  }

  it('reports TRANSIENT_FAIL when the page navigated out from under the locator', async () => {
    const res = await runner(
      pageThatThrows('Execution context was destroyed, most likely because of a navigation.'),
      { type: 'dom_check', selector: '#dashboard', exists: true },
    ).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
    expect(res.checks[0].detail).toMatch(/raced a navigation/);
  });

  it('reports TRANSIENT_FAIL when the page is closed (pod teardown)', async () => {
    // Otherwise the worker writes a final AUTH_FAIL on its way out and leaves
    // the session looking signed out to everyone downstream.
    const res = await runner(
      pageThatThrows('Target page, context or browser has been closed'),
      { type: 'dom_check', selector: '#dashboard', exists: true },
    ).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
  });

  it('reports TRANSIENT_FAIL when the configured selector is malformed', async () => {
    // The worst shape of this bug: one typo in an app's health_checks turned
    // every session for that app permanently "signed out", silently.
    const res = await runner(
      pageThatThrows('Unexpected token "=" while parsing selector "[data-test-id=value]"'),
      { type: 'dom_check', selector: '[data-test-id=value]', exists: true },
    ).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
    expect(res.checks[0].detail).toMatch(/fix the app's health_checks config/);
  });

  it('still reports AUTH_FAIL on a plain timeout — the marker really is gone', async () => {
    // The carve-outs above must not swallow the genuine signed-out verdict.
    const res = await runner(
      pageThatThrows('Timeout 5000ms exceeded waiting for locator("#dashboard")'),
      { type: 'dom_check', selector: '#dashboard', exists: true },
    ).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
  });

  it('applies the same classification to negative checks', async () => {
    const res = await runner(
      pageThatThrows('Execution context was destroyed, most likely because of a navigation.'),
      { type: 'dom_check', selector: 'text=Sign in', exists: false },
    ).evaluate();
    expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
  });
});

/**
 * A `dom_check` on `body` cannot report on authentication.
 *
 * Every rendered document has a body. If it cannot be found the document is
 * loading, navigating or blank — never "the session ended". Apps configure this
 * as a cheap liveness probe (the recording-shell app does exactly this), and on
 * a portal that replaces the document during sign-in it lands mid-navigation and
 * times out.
 *
 * Observed: a human signing in to ICICI inside a RECORDING session. Five health
 * cycles passed, one timed out on `body`, the controller flipped the session
 * HEALTHY -> UNHEALTHY, and the very next cycle 55 seconds later passed again.
 * One blip interrupted a human mid-sign-in for nothing.
 */
describe('HealthPredicateRunner — a universal selector cannot prove a session ended', () => {
  function pageThatTimesOut() {
    return {
      locator: jest.fn().mockReturnValue({
        first: jest.fn().mockReturnValue({
          waitFor: jest.fn(async () => {
            throw new Error('locator.waitFor: Timeout 5000ms exceeded.');
          }),
        }),
      }),
      url: jest.fn().mockReturnValue('https://retailnetbanking.icici.bank.in/login-page'),
    } as any;
  }

  it('reports TRANSIENT_FAIL when body times out, not AUTH_FAIL', async () => {
    const res = await runner(pageThatTimesOut(), {
      type: 'dom_check', selector: 'body', exists: true,
    }).evaluate();

    expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
    expect(res.checks[0].detail).toMatch(/matches any loaded page/);
  });

  it('treats html and :root the same way', async () => {
    for (const selector of ['html', ':root', 'BODY', ' body ']) {
      const res = await runner(pageThatTimesOut(), {
        type: 'dom_check', selector, exists: true,
      }).evaluate();
      expect(res.checks[0].result).toBe(HealthResultType.TRANSIENT_FAIL);
    }
  });

  it('still reports AUTH_FAIL when a REAL marker times out', async () => {
    // The carve-out must not swallow the genuine signed-out verdict: a missing
    // dashboard element is exactly what "signed out" looks like.
    const res = await runner(pageThatTimesOut(), {
      type: 'dom_check', selector: '#dashboard', exists: true,
    }).evaluate();

    expect(res.checks[0].result).toBe(HealthResultType.AUTH_FAIL);
  });
});
