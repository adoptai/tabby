import { SessionsService } from './sessions.service';

const APP_ID = 'app-1';
const APP_TENANT = 'tenant-of-the-app';

/**
 * A session belongs to the APP it runs for, whoever asked for it.
 *
 * An Admin may scale any app across tenants, which the controller expresses by
 * passing `tenantId: undefined` — "do not scope this lookup to my tenant". That
 * undefined was written straight into the session row, so every Admin scale-up
 * died on `null value in column "tenant_id" violates not-null constraint` and
 * no session was ever created. The app carries the tenant the session needs.
 */
function makeService() {
  const app = {
    id: APP_ID,
    tenant_id: APP_TENANT,
    desired_session_count: 0,
    owner_user_id: 'owner-1',
    pending_traceparent: null,
  };
  const appRepo = {
    findOne: jest.fn().mockResolvedValue(app),
    save: jest.fn().mockImplementation(async (a: any) => a),
  };
  const created: any[] = [];
  const sessionRepo = {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockImplementation((row: any) => row),
    save: jest.fn().mockImplementation(async (row: any) => {
      created.push(row);
      return { ...row, id: `sess-${created.length}` };
    }),
  };
  const batonRepo = {
    create: jest.fn().mockImplementation((row: any) => row),
    save: jest.fn().mockResolvedValue({}),
  };
  const tenantRepo = {
    findOne: jest.fn().mockResolvedValue({ id: APP_TENANT, max_sessions: 10 }),
  };
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };

  const interventionRepo = { findOne: jest.fn() };
  const service = new SessionsService(
    sessionRepo as any,
    appRepo as any,
    tenantRepo as any,
    interventionRepo as any,
    batonRepo as any,
    auditService as any,
  );
  return { service, created, sessionRepo, appRepo, tenantRepo };
}

describe('SessionsService.scale', () => {
  it("stamps the APP's tenant when an Admin scales across tenants", async () => {
    const { service, created } = makeService();

    // undefined = the Admin path: do not scope the lookup to the caller's tenant.
    await service.scale(APP_ID, 1, undefined, 'admin-1');

    expect(created).toHaveLength(1);
    expect(created[0].tenant_id).toBe(APP_TENANT);
  });

  it('stamps the same tenant for a tenant-scoped caller', async () => {
    const { service, created } = makeService();

    await service.scale(APP_ID, 1, APP_TENANT, 'operator-1');

    expect(created[0].tenant_id).toBe(APP_TENANT);
  });

  it('never creates a session with no tenant', async () => {
    const { service, created } = makeService();

    await service.scale(APP_ID, 2, undefined, 'admin-1');

    expect(created).toHaveLength(2);
    for (const row of created) {
      expect(row.tenant_id).toBeTruthy();
    }
  });
});
