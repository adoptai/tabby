import { RECORDING_POOL } from '@browser-hitl/shared';
import { RecordingPoolService } from './recording-pool.service';

/**
 * Build a service with a given env config + mocked deps. The constructor reads
 * RECORDING_POOL_SIZE / RECORDING_POOL_TENANTS from process.env, so we set them
 * before instantiating.
 */
function makeService(
  env: { size?: string; residentialSize?: string; tenants?: string },
  deps: {
    appRepoFindOne?: jest.Mock;
    managerQuery?: jest.Mock;
    findOne?: jest.Mock;
    sessionCount?: jest.Mock;
  } = {},
) {
  const prevSize = process.env.RECORDING_POOL_SIZE;
  const prevResidentialSize = process.env.RECORDING_POOL_RESIDENTIAL_SIZE;
  const prevTenants = process.env.RECORDING_POOL_TENANTS;
  if (env.size === undefined) delete process.env.RECORDING_POOL_SIZE;
  else process.env.RECORDING_POOL_SIZE = env.size;
  if (env.residentialSize === undefined) delete process.env.RECORDING_POOL_RESIDENTIAL_SIZE;
  else process.env.RECORDING_POOL_RESIDENTIAL_SIZE = env.residentialSize;
  if (env.tenants === undefined) delete process.env.RECORDING_POOL_TENANTS;
  else process.env.RECORDING_POOL_TENANTS = env.tenants;

  const appRepo = { findOne: deps.appRepoFindOne ?? jest.fn(), update: jest.fn() } as any;
  // countWarmingSpares() reads sessionRepo.count(); default to 0 (nothing warming).
  const sessionCount = deps.sessionCount ?? jest.fn().mockResolvedValue(0);
  const sessionRepo = { count: sessionCount } as any;
  // claimWarmSession runs inside dataSource.transaction(cb): the callback gets a
  // manager exposing query() (SELECT ... FOR UPDATE SKIP LOCKED, then UPDATE) and
  // getRepository().findOne() to return the claimed entity.
  const managerQuery = deps.managerQuery ?? jest.fn();
  const findOne = deps.findOne ?? jest.fn();
  const manager = { query: managerQuery, getRepository: () => ({ findOne }) };
  const dataSource = {
    transaction: jest.fn(async (cb: any) => cb(manager)),
  } as any;
  const appsService = { create: jest.fn() } as any;

  const svc = new RecordingPoolService(appsService, appRepo, sessionRepo, dataSource);

  // Restore env so tests don't leak.
  if (prevSize === undefined) delete process.env.RECORDING_POOL_SIZE;
  else process.env.RECORDING_POOL_SIZE = prevSize;
  if (prevResidentialSize === undefined) delete process.env.RECORDING_POOL_RESIDENTIAL_SIZE;
  else process.env.RECORDING_POOL_RESIDENTIAL_SIZE = prevResidentialSize;
  if (prevTenants === undefined) delete process.env.RECORDING_POOL_TENANTS;
  else process.env.RECORDING_POOL_TENANTS = prevTenants;

  return { svc, appRepo, dataSource, managerQuery, findOne, sessionCount };
}

describe('RecordingPoolService.isEnabledForTenant', () => {
  it('is disabled when size is 0 / unset regardless of tenants', () => {
    expect(makeService({ tenants: '*' }).svc.isEnabledForTenant('t1')).toBe(false);
    expect(makeService({ size: '0', tenants: 't1' }).svc.isEnabledForTenant('t1')).toBe(false);
  });

  it('is disabled when size > 0 but no tenants opted in', () => {
    expect(makeService({ size: '3' }).svc.isEnabledForTenant('t1')).toBe(false);
    expect(makeService({ size: '3', tenants: '' }).svc.isEnabledForTenant('t1')).toBe(false);
  });

  it('enables all tenants with wildcard', () => {
    const { svc } = makeService({ size: '3', tenants: '*' });
    expect(svc.isEnabledForTenant('t1')).toBe(true);
    expect(svc.isEnabledForTenant('anything')).toBe(true);
  });

  it('enables only explicitly-listed tenants', () => {
    const { svc } = makeService({ size: '2', tenants: 't1, t2 ' });
    expect(svc.isEnabledForTenant('t1')).toBe(true);
    expect(svc.isEnabledForTenant('t2')).toBe(true);
    expect(svc.isEnabledForTenant('t3')).toBe(false);
  });

  it('gates the residential flavor on RECORDING_POOL_RESIDENTIAL_SIZE independently', () => {
    // Non-residential pool on, residential pool off.
    const nonResiOnly = makeService({ size: '2', tenants: '*' }).svc;
    expect(nonResiOnly.isEnabledForTenant('t1', false)).toBe(true);
    expect(nonResiOnly.isEnabledForTenant('t1', true)).toBe(false);

    // Residential pool on, non-residential pool off.
    const resiOnly = makeService({ residentialSize: '2', tenants: '*' }).svc;
    expect(resiOnly.isEnabledForTenant('t1', false)).toBe(false);
    expect(resiOnly.isEnabledForTenant('t1', true)).toBe(true);

    // Both flavors sized (the 2+2 config).
    const both = makeService({ size: '2', residentialSize: '2', tenants: 't1' }).svc;
    expect(both.isEnabledForTenant('t1', false)).toBe(true);
    expect(both.isEnabledForTenant('t1', true)).toBe(true);
    expect(both.isEnabledForTenant('t2', true)).toBe(false);
  });
});

describe('RecordingPoolService.claimWarmSession', () => {
  it('returns null when the tenant has no pool app', async () => {
    const { svc, dataSource } = makeService(
      { size: '2', tenants: '*' },
      { appRepoFindOne: jest.fn().mockResolvedValue(null) },
    );
    expect(await svc.claimWarmSession('t1', 'shell-app', 'user-1')).toBeNull();
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('returns null when no warm spare is available', async () => {
    const { svc } = makeService(
      { size: '2', tenants: '*' },
      {
        appRepoFindOne: jest.fn().mockResolvedValue({ id: 'pool-app' }),
        managerQuery: jest.fn().mockResolvedValue([]), // SELECT finds no spare
      },
    );
    expect(await svc.claimWarmSession('t1', 'shell-app', 'user-1')).toBeNull();
  });

  it('atomically reassigns a warm spare with the right claim params', async () => {
    const claimedEntity = { id: 'sess-1', pod_name: 'worker-abc', app_id: 'shell-app' };
    // manager.query order: SELECT (picked id), UPDATE sessions, UPDATE applications.
    const managerQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'sess-1' }])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const findOne = jest.fn().mockResolvedValue(claimedEntity);
    const { svc } = makeService(
      { size: '2', tenants: '*' },
      { appRepoFindOne: jest.fn().mockResolvedValue({ id: 'pool-app' }), managerQuery, findOne },
    );

    const result = await svc.claimWarmSession('t1', 'shell-app', 'user-1');

    expect(result).toEqual(claimedEntity);
    // SELECT filters pool-app / tenant / WARM.
    expect(managerQuery.mock.calls[0][1]).toEqual(['pool-app', 't1', RECORDING_POOL.WARM]);
    // UPDATE sets shell app_id, owner, CLAIMED for the picked id.
    expect(managerQuery.mock.calls[1][1]).toEqual([
      'shell-app',
      'user-1',
      RECORDING_POOL.CLAIMED,
      'sess-1',
    ]);
    // Third UPDATE retains the spare by setting the shell app desired=1 in the
    // SAME transaction (prevents the reconcile scale-down race that would
    // otherwise terminate the just-claimed spare as "excess").
    expect(managerQuery.mock.calls[2][0]).toMatch(
      /UPDATE applications SET desired_session_count = 1/,
    );
    expect(managerQuery.mock.calls[2][1]).toEqual(['shell-app']);
    expect(findOne).toHaveBeenCalledWith({ where: { id: 'sess-1' } });
  });

  it('claims from the non-residential pool app by default', async () => {
    const appRepoFindOne = jest.fn().mockResolvedValue(null);
    const { svc } = makeService(
      { size: '2', residentialSize: '2', tenants: '*' },
      { appRepoFindOne },
    );
    await svc.claimWarmSession('t1', 'shell-app', 'user-1');
    expect(appRepoFindOne).toHaveBeenCalledWith({
      where: { tenant_id: 't1', name: RECORDING_POOL.APP_NAME },
    });
  });

  it('claims from the residential pool app when residential=true', async () => {
    const appRepoFindOne = jest.fn().mockResolvedValue(null);
    const { svc } = makeService(
      { size: '2', residentialSize: '2', tenants: '*' },
      { appRepoFindOne },
    );
    await svc.claimWarmSession('t1', 'shell-app', 'user-1', true);
    expect(appRepoFindOne).toHaveBeenCalledWith({
      where: { tenant_id: 't1', name: RECORDING_POOL.RESIDENTIAL_APP_NAME },
    });
  });
});

describe('RecordingPoolService.claimWarmSessionWithWait', () => {
  it('returns a spare immediately on a hit, without checking for warming spares', async () => {
    const managerQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'sess-1' }]) // SELECT (hit)
      .mockResolvedValueOnce(undefined) // UPDATE sessions
      .mockResolvedValueOnce(undefined); // UPDATE applications
    const findOne = jest.fn().mockResolvedValue({ id: 'sess-1', pod_name: 'worker-abc' });
    const sessionCount = jest.fn().mockResolvedValue(3);
    const { svc } = makeService(
      { size: '2', tenants: '*' },
      { appRepoFindOne: jest.fn().mockResolvedValue({ id: 'pool-app' }), managerQuery, findOne, sessionCount },
    );

    const result = await svc.claimWarmSessionWithWait('t1', 'shell-app', 'user-1');

    expect(result).toEqual({ id: 'sess-1', pod_name: 'worker-abc' });
    // A hit never needs the warming-spare probe.
    expect(sessionCount).not.toHaveBeenCalled();
  });

  it('does NOT wait when nothing is warming — cold-starts immediately', async () => {
    const managerQuery = jest.fn().mockResolvedValue([]); // SELECT always misses
    const sessionCount = jest.fn().mockResolvedValue(0); // no warming spare
    const { svc } = makeService(
      { size: '2', tenants: '*' },
      { appRepoFindOne: jest.fn().mockResolvedValue({ id: 'pool-app' }), managerQuery, sessionCount },
    );

    const started = Date.now();
    const result = await svc.claimWarmSessionWithWait('t1', 'shell-app', 'user-1');

    expect(result).toBeNull();
    expect(sessionCount).toHaveBeenCalledTimes(1);
    // Only the single immediate claim attempt ran — no poll loop.
    expect(managerQuery).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits for a warming spare and claims it once it becomes HEALTHY', async () => {
    // First claim misses; a spare is warming (count=1); the poll retry hits.
    const managerQuery = jest.fn()
      .mockResolvedValueOnce([]) // immediate SELECT (miss)
      .mockResolvedValueOnce([{ id: 'sess-2' }]) // poll SELECT (hit)
      .mockResolvedValueOnce(undefined) // UPDATE sessions
      .mockResolvedValueOnce(undefined); // UPDATE applications
    const findOne = jest.fn().mockResolvedValue({ id: 'sess-2', pod_name: 'worker-xyz' });
    const sessionCount = jest.fn().mockResolvedValue(1);
    const { svc } = makeService(
      { size: '2', tenants: '*' },
      { appRepoFindOne: jest.fn().mockResolvedValue({ id: 'pool-app' }), managerQuery, findOne, sessionCount },
    );

    const result = await svc.claimWarmSessionWithWait('t1', 'shell-app', 'user-1');

    expect(result).toEqual({ id: 'sess-2', pod_name: 'worker-xyz' });
    expect(sessionCount).toHaveBeenCalledTimes(1);
  }, 10_000);
});
