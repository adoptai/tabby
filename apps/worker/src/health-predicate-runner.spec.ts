import { HealthPredicateRunner } from './health-predicate-runner';
import { HealthResultType } from '@browser-hitl/shared';

// Minimal Playwright BrowserContext stub: only context.request.get is used by
// runNetworkCheck. Each test wires the response it wants back.
function makeContext(resp: { status: number; body: string }) {
  return {
    request: {
      get: jest.fn(async () => ({
        status: () => resp.status,
        url: () => 'https://www1.secure.hsbcnet.com/pims/dtc/accounts/balances',
        text: async () => resp.body,
      })),
    },
  } as any;
}

const PAGE = {} as any;

function runnerFor(resp: { status: number; body: string }, check: any) {
  const ctx = makeContext(resp);
  const runner = new HealthPredicateRunner(PAGE, ctx, {
    interval_seconds: 60,
    actions: [],
    health_checks: [check],
  });
  return runner;
}

describe('network_check body_not_contains (signed-out marker in a 200)', () => {
  const HSBC_CHECK = {
    type: 'network_check',
    url: 'https://www1.secure.hsbcnet.com/pims/dtc/accounts/balances',
    expect_status: 200,
    body_not_contains: 'PCS9500',
  };

  it('AUTH_FAILs when the signed-out marker is present in an otherwise-OK 200', async () => {
    const body = JSON.stringify({
      status: { code: 12 },
      response: { statusMessages: { data: [{ errorCode: 'PCS9500', messageId: 'GENERIC_EXCEPTION' }] } },
    });
    const res = await runnerFor({ status: 200, body }, HSBC_CHECK).evaluate();
    expect(res.overall).toBe(HealthResultType.AUTH_FAIL);
    expect(res.checks[0].detail).toContain('PCS9500');
  });

  it('PASSes when the signed-out marker is absent (real account data)', async () => {
    const body = JSON.stringify({ accounts: [{ id: 'acct-1', balance: 100 }] });
    const res = await runnerFor({ status: 200, body }, HSBC_CHECK).evaluate();
    expect(res.overall).toBe(HealthResultType.PASS);
  });

  it('still enforces body_contains (positive marker) alongside', async () => {
    const check = { ...HSBC_CHECK, body_contains: 'accounts', body_not_contains: undefined };
    const res = await runnerFor({ status: 200, body: '{"nope":1}' }, check).evaluate();
    expect(res.overall).toBe(HealthResultType.AUTH_FAIL);
  });
});
