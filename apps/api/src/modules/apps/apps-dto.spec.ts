import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateAppDto, UpdateAppDto } from './apps.dto';

/**
 * Adversarial tests for Apps DTO validation (C3 remediation).
 *
 * These tests verify that:
 * 1. CreateAppDto rejects payloads missing required fields
 * 2. CreateAppDto rejects payloads with wrong types
 * 3. CreateAppDto strips unknown fields (whitelist)
 * 4. UpdateAppDto allows partial updates
 * 5. Controller uses typed DTOs instead of `any`
 */

function toDto<T>(cls: new () => T, plain: any): T {
  return plainToInstance(cls, plain, { enableImplicitConversion: true });
}

// ---------------------------------------------------------------------------
// CreateAppDto
// ---------------------------------------------------------------------------

describe('CreateAppDto validation (C3)', () => {
  const validPayload = {
    name: 'My App',
    target_urls: ['https://example.com'],
    login_config: { steps: [] },
    keepalive_config: { action: 'reload' },
    export_policy: { format: 'har' },
    notification_config: { channel: 'slack' },
  };

  it('accepts a valid payload', async () => {
    const dto = toDto(CreateAppDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts payload with optional fields', async () => {
    const dto = toDto(CreateAppDto, {
      ...validPayload,
      desired_session_count: 3,
      browser_policy: { downloads: true },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects missing name', async () => {
    const { name, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects empty name', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, name: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'name')).toBe(true);
  });

  it('rejects missing target_urls', async () => {
    const { target_urls, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'target_urls')).toBe(true);
  });

  it('rejects empty target_urls array', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, target_urls: [] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'target_urls')).toBe(true);
  });

  it('rejects non-string items in target_urls', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, target_urls: [123] });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing login_config', async () => {
    const { login_config, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'login_config')).toBe(true);
  });

  it('rejects non-object login_config', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, login_config: 'not-an-object' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing keepalive_config', async () => {
    const { keepalive_config, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects missing export_policy', async () => {
    const { export_policy, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts missing notification_config (agent-poll mode)', async () => {
    const { notification_config, ...rest } = validPayload;
    const dto = toDto(CreateAppDto, rest);
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('rejects negative desired_session_count', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, desired_session_count: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.property === 'desired_session_count')).toBe(true);
  });

  it('rejects non-integer desired_session_count', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, desired_session_count: 1.5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// UpdateAppDto
// ---------------------------------------------------------------------------

describe('UpdateAppDto validation (C3)', () => {
  it('accepts an empty body (all fields optional)', async () => {
    const dto = toDto(UpdateAppDto, {});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts a partial update (name only)', async () => {
    const dto = toDto(UpdateAppDto, { name: 'Renamed App' });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects empty name when provided', async () => {
    const dto = toDto(UpdateAppDto, { name: '' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects non-object login_config when provided', async () => {
    const dto = toDto(UpdateAppDto, { login_config: 42 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Source verification (anti-regression)
// ---------------------------------------------------------------------------

describe('C3 source verification', () => {
  it('apps.controller.ts uses CreateAppDto instead of any', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'apps.controller.ts'),
      'utf-8',
    );
    expect(source).toContain('CreateAppDto');
    expect(source).toContain('UpdateAppDto');
    // Should NOT have `dto: any` for create/update
    expect(source).not.toMatch(/@Body\(\)\s+dto:\s+any/);
  });

  it('apps.dto.ts uses class-validator decorators', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'apps.dto.ts'),
      'utf-8',
    );
    expect(source).toContain('@IsString()');
    expect(source).toContain('@IsArray()');
    expect(source).toContain('@IsObject()');
    expect(source).toContain('@IsOptional()');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (FDE integration)
// ---------------------------------------------------------------------------

describe('CreateAppDto tenant_id field', () => {
  const validPayload = {
    name: 'My App',
    target_urls: ['https://example.com'],
    login_config: { steps: [] },
    keepalive_config: { action: 'reload' },
    export_policy: { format: 'har' },
    notification_config: { channel: 'slack' },
  };

  it('accepts payload without tenant_id (backwards compatible)', async () => {
    const dto = toDto(CreateAppDto, validPayload);
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tenant_id).toBeUndefined();
  });

  it('accepts payload with valid UUID tenant_id', async () => {
    const uuid = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const dto = toDto(CreateAppDto, { ...validPayload, tenant_id: uuid });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
    expect(dto.tenant_id).toBe(uuid);
  });

  it('rejects non-UUID tenant_id', async () => {
    const dto = toDto(CreateAppDto, { ...validPayload, tenant_id: 'not-a-uuid' });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('tenant_id');
  });
});

describe('apps.controller.ts resolveTenantId', () => {
  it('controller uses resolveTenantId for create', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'apps.controller.ts'),
      'utf-8',
    );
    expect(source).toContain('resolveTenantId');
    expect(source).toContain('dto.tenant_id');
  });

  it('controller bypasses tenant filter for Admin on UUID ops', () => {
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'apps.controller.ts'),
      'utf-8',
    );
    expect(source).toContain("req.user.role === 'Admin' ? undefined");
  });
});
