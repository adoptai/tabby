import 'reflect-metadata';
import { ValidationPipe, BadRequestException } from '@nestjs/common';
import { EXECUTE_LIMITS } from '@browser-hitl/shared';
import { ExecuteFetchDto } from './execute.controller';

/**
 * The API mounts a global ValidationPipe with whitelist + forbidNonWhitelisted
 * (see main.ts), so any field the DTO does not declare is rejected with a 400
 * before the handler runs. The presigned-sink fields (upload_url / upload_headers
 * / upload_always) are honoured by the service and worker, but were absent from
 * ExecuteFetchDto — so /execute/fetch rejected them and the S3 download sink could
 * never be reached through the API. These tests pin that they now pass the pipe.
 */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const meta = { type: 'body' as const, metatype: ExecuteFetchDto, data: '' };

describe('ExecuteFetchDto — presigned upload fields', () => {
  it('accepts a fetch-to-sink payload and preserves the upload fields', async () => {
    const out = await pipe.transform(
      {
        profile_id: 'workday-aa-staging-adopt',
        url: 'https://wd5-impl.workday.com/doc?download=true',
        method: 'GET',
        upload_url: 'https://s3.example/key?sig=1',
        upload_headers: { 'x-amz-meta-run': 'abc' },
        upload_always: true,
      },
      meta,
    );
    expect(out.upload_url).toBe('https://s3.example/key?sig=1');
    expect(out.upload_headers).toEqual({ 'x-amz-meta-run': 'abc' });
    expect(out.upload_always).toBe(true);
  });

  it('still accepts a plain fetch with no upload fields', async () => {
    const out = await pipe.transform(
      { profile_id: 'p', url: 'https://x.test', method: 'GET' },
      meta,
    );
    expect(out.upload_url).toBeUndefined();
  });

  it('rejects a genuinely unknown field (whitelist still enforced)', async () => {
    await expect(
      pipe.transform({ profile_id: 'p', url: 'https://x.test', not_a_field: 1 }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-string upload_url', async () => {
    await expect(
      pipe.transform({ profile_id: 'p', url: 'https://x.test', upload_url: 42 }, meta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // The executor sends the sink budget (MAX_SINK_TIMEOUT_MS) on a fetch-to-sink call.
  // With the DTO capped at MAX_TIMEOUT_MS that body was a 400 before the handler ran,
  // so the sink was unreachable end to end even though the service and worker both
  // honour the larger ceiling.
  it('accepts a sink payload that asks for the sink timeout ceiling', async () => {
    const out = await pipe.transform(
      {
        profile_id: 'p',
        url: 'https://x.test/doc',
        upload_url: 'https://s3.example/key?sig=1',
        timeout_ms: EXECUTE_LIMITS.MAX_SINK_TIMEOUT_MS,
      },
      meta,
    );
    expect(out.timeout_ms).toBe(EXECUTE_LIMITS.MAX_SINK_TIMEOUT_MS);
  });

  it('still rejects a timeout above the sink ceiling', async () => {
    await expect(
      pipe.transform(
        { profile_id: 'p', url: 'https://x.test', timeout_ms: EXECUTE_LIMITS.MAX_SINK_TIMEOUT_MS + 1 },
        meta,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // A plain fetch may now pass the pipe with a sink-sized timeout; the service
  // clamps it back to MAX_TIMEOUT_MS (execute.service.spec covers that), so the
  // DTO widening changes nothing for an ordinary API call.
  it('passes a plain fetch with a large timeout through to the service clamp', async () => {
    const out = await pipe.transform(
      { profile_id: 'p', url: 'https://x.test', timeout_ms: EXECUTE_LIMITS.MAX_SINK_TIMEOUT_MS },
      meta,
    );
    expect(out.upload_url).toBeUndefined();
    expect(out.timeout_ms).toBe(EXECUTE_LIMITS.MAX_SINK_TIMEOUT_MS);
  });
});
