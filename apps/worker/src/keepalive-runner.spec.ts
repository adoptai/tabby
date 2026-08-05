import { KeepaliveRunner } from './keepalive-runner';

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
  return { runner, execCalls, dslRunner };
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
