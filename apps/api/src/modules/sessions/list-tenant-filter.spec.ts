import 'reflect-metadata';
import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListAppsQueryDto } from '../apps/apps.dto';
import { AppsController } from '../apps/apps.controller';
import { ListSessionsQueryDto, SessionsController } from './sessions.controller';

/**
 * An Admin can list ONE tenant's apps and sessions with `?tenant_id=`.
 *
 * AppsController always read tenant_id for Admin, but ListAppsQueryDto never
 * declared it, and the global ValidationPipe is forbidNonWhitelisted: the query
 * was a 400 before the controller ran. Sessions had no filter at all, so an
 * Admin caller (the Adopt console, for one) paged through every tenant's
 * sessions to find one org's.
 */

// The options main.ts installs globally.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const asQuery = (metatype: any): ArgumentMetadata => ({ type: 'query', metatype, data: '' });

describe('tenant_id on the list queries', () => {
  it.each([
    ['apps', ListAppsQueryDto],
    ['sessions', ListSessionsQueryDto],
  ])('%s: passes the ValidationPipe main.ts installs', async (_name, dto) => {
    const query = await pipe.transform({ tenant_id: 'org-1', limit: '200', offset: '0' }, asQuery(dto));
    expect(query).toMatchObject({ tenant_id: 'org-1', limit: 200, offset: 0 });
  });

  it.each([
    ['apps', ListAppsQueryDto],
    ['sessions', ListSessionsQueryDto],
  ])('%s: still refuses a parameter nobody declared', async (_name, dto) => {
    await expect(pipe.transform({ owner: 'x' }, asQuery(dto))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('SessionsController.findAll', () => {
  const service = { findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }) };
  const controller = new SessionsController(service as any);
  const list = (role: string, tenant_id?: string) =>
    controller.findAll(
      Object.assign(new ListSessionsQueryDto(), { tenant_id }),
      { user: { role, tenant_id: 'own-tenant', owner_user_id: 'me' } },
    );

  beforeEach(() => service.findAll.mockClear());

  it('lists one tenant for an Admin that asks for it', async () => {
    await list('Admin', 'org-1');
    expect(service.findAll).toHaveBeenCalledWith('org-1', 50, 0, null);
  });

  it('lists every tenant for an Admin that does not', async () => {
    await list('Admin');
    expect(service.findAll).toHaveBeenCalledWith(undefined, 50, 0, null);
  });

  it('pins every other role to its own tenant, whatever it asks for', async () => {
    await list('Editor', 'org-1');
    expect(service.findAll).toHaveBeenCalledWith('own-tenant', 50, 0, null);
    await list('Operator', 'org-1');
    expect(service.findAll).toHaveBeenLastCalledWith('own-tenant', 50, 0, 'me');
  });
});

describe('AppsController.findAll', () => {
  const service = { findAll: jest.fn().mockResolvedValue({ data: [], total: 0 }) };
  const controller = new AppsController(service as any);
  const list = (role: string, tenant_id?: string) =>
    controller.findAll(
      Object.assign(new ListAppsQueryDto(), { tenant_id }),
      { user: { role, tenant_id: 'own-tenant' } },
    );

  beforeEach(() => service.findAll.mockClear());

  it('lists one tenant for an Admin that asks for it', async () => {
    await list('Admin', 'org-1');
    expect(service.findAll).toHaveBeenCalledWith('org-1', 50, 0, undefined);
  });

  it('lists every tenant for an Admin that does not', async () => {
    await list('Admin');
    expect(service.findAll).toHaveBeenCalledWith(undefined, 50, 0, undefined);
  });

  it('pins every other role to its own tenant, whatever it asks for', async () => {
    await list('Editor', 'org-1');
    expect(service.findAll).toHaveBeenCalledWith('own-tenant', 50, 0, undefined);
  });
});
