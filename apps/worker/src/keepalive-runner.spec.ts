import { KeepaliveRunner } from './keepalive-runner';
import { beginAgentCommand, endAgentCommand, resetAgentActivity } from './agent-activity';

// Drive runCycle() directly with mocked deps to assert the HEALTHY-gate on the
// 'activity' nudge: robotic mouse/scroll must not run once the session is on a
// login/expired page (health != PASS), or reCAPTCHA v3 scores it as a bot.
function build(healthSeq: string[]) {
  let i = 0;
  const execCalls: any[][] = [];
  const dslRunner = {
    execute: jest.fn(async (actions: any[]) => {
      execCalls.push(actions);
    }),
  };
  const healthRunner = {
    evaluate: jest.fn(async () => ({
      overall: healthSeq[Math.min(i++, healthSeq.length - 1)],
      checks: [],
    })),
    setKeepaliveConfig: jest.fn(),
  };
  const page = { waitForTimeout: jest.fn(async () => undefined) };
  const db = {
    loadAppConfig: jest.fn(async () => null), // keep the constructor's appConfig
    updateHealthResult: jest.fn(async () => undefined),
    getLastExportedAt: jest.fn(async () => new Date().toISOString()), // fresh → no extract
    updateLastExportedAt: jest.fn(async () => undefined),
  };
  const artifactExtractor = { extractAndUpload: jest.fn(async () => undefined) };
  const appConfig = {
    keepalive_config: { interval_seconds: 60, actions: [{ action: 'activity' }] },
    export_policy: { refresh_interval_seconds: 3600 },
  };
  const runner = new KeepaliveRunner(
    page as any,
    {} as any,
    dslRunner as any,
    healthRunner as any,
    artifactExtractor as any,
    db as any,
    appConfig,
    'app-1',
    'sess-1',
    { username: '', password: '' },
    false,
  );
  return { runner, execCalls, dslRunner, healthRunner };
}

describe('KeepaliveRunner activity HEALTHY-gate', () => {
  it('runs the activity nudge on the first cycle and while the session stays healthy', async () => {
    const { runner, execCalls } = build(['PASS', 'PASS']);
    await (runner as any).runCycle(); // lastHealth null → runs
    await (runner as any).runCycle(); // lastHealth PASS → runs
    expect(execCalls).toEqual([[{ action: 'activity' }], [{ action: 'activity' }]]);
  });

  it('stops the activity nudge once the session is no longer PASS (bounced to login)', async () => {
    const { runner, execCalls, dslRunner } = build(['AUTH_FAIL', 'AUTH_FAIL']);
    await (runner as any).runCycle(); // lastHealth null → runs once, then records AUTH_FAIL
    await (runner as any).runCycle(); // lastHealth AUTH_FAIL → 'activity' filtered → no execute
    expect(dslRunner.execute).toHaveBeenCalledTimes(1);
    expect(execCalls).toEqual([[{ action: 'activity' }]]);
  });

  it('resumes the nudge if the session returns to PASS', async () => {
    const { runner, dslRunner } = build(['AUTH_FAIL', 'PASS', 'PASS']);
    await (runner as any).runCycle(); // null → runs
    await (runner as any).runCycle(); // AUTH_FAIL → skips
    await (runner as any).runCycle(); // PASS → runs again
    expect(dslRunner.execute).toHaveBeenCalledTimes(2);
  });
});

describe('KeepaliveRunner activity gate is AUTH_FAIL-only', () => {
  it('keeps nudging through a TRANSIENT_FAIL', async () => {
    // A 5xx / probe timeout / egress blip does not mean the session is signed
    // out. Suppressing the nudge there lets the portal's own idle timer run out
    // and turns a recoverable blip into a real expiry — the outcome 'activity'
    // exists to prevent. Only a login page (AUTH_FAIL) should stop it.
    const { runner, dslRunner } = build(['TRANSIENT_FAIL', 'TRANSIENT_FAIL']);
    await (runner as any).runCycle();
    await (runner as any).runCycle();
    expect(dslRunner.execute).toHaveBeenCalledTimes(2);
  });
});

describe('KeepaliveRunner agent-driven gate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    resetAgentActivity();
  });
  afterEach(() => {
    resetAgentActivity();
    jest.useRealTimers();
  });

  it('skips keepalive actions when the agent touched the origin within the interval', async () => {
    // The agent's own click already reset the portal's idle timer, so the nudge
    // is redundant — and a synthetic scroll can misplace the agent's next click.
    const { runner, dslRunner } = build(['PASS']);
    beginAgentCommand(true);
    endAgentCommand(true);
    jest.advanceTimersByTime(1_000); // 1s < 60s interval

    await (runner as any).runCycle();

    expect(dslRunner.execute).not.toHaveBeenCalled();
  });

  it('runs keepalive actions once the agent has been idle longer than the interval', async () => {
    const { runner, execCalls } = build(['PASS']);
    beginAgentCommand(true);
    endAgentCommand(true);
    jest.advanceTimersByTime(61_000); // 61s > 60s interval

    await (runner as any).runCycle();

    expect(execCalls).toEqual([[{ action: 'activity' }]]);
  });

  it('does not treat read-only commands as activity (a screenshot is not a keepalive)', async () => {
    // Mirrors the platform rule that `screenshot` makes no request, so the
    // portal's idle timer keeps running and the session still needs the nudge.
    const { runner, execCalls } = build(['PASS']);
    beginAgentCommand(false);
    endAgentCommand(false);
    jest.advanceTimersByTime(1_000);

    await (runner as any).runCycle();

    expect(execCalls).toEqual([[{ action: 'activity' }]]);
  });

  it('skips the entire cycle, health included, while a command is in flight', async () => {
    // dom_check mid-navigation cannot find its selector and reports AUTH_FAIL,
    // which would push a working session to LOGIN_NEEDED and show a sign-in card.
    const { runner, dslRunner, healthRunner } = build(['PASS']);
    beginAgentCommand(true); // never ended → still in flight

    await (runner as any).runCycle();

    expect(dslRunner.execute).not.toHaveBeenCalled();
    expect(healthRunner.evaluate).not.toHaveBeenCalled();
  });

  it('evaluates health anyway after too many consecutive busy skips', async () => {
    // Health must not stall forever behind an agent that is always working.
    const { runner, dslRunner, healthRunner } = build(['PASS']);
    beginAgentCommand(true); // stays in flight for every cycle below

    for (let i = 0; i < 4; i++) await (runner as any).runCycle();

    expect(healthRunner.evaluate).toHaveBeenCalledTimes(1); // 3 skipped, 4th ran
    expect(dslRunner.execute).not.toHaveBeenCalled(); // but never any actions
  });
});
