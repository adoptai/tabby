#!/usr/bin/env node
/**
 * Mock HITL Auto-Responder
 *
 * Replaces the Slack bot for automated E2E testing.
 * Subscribes to NATS hitl.otp-requested.> events and writes OTP to Redis.
 *
 * Environment variables:
 *   NATS_URL          - NATS server URL (default: nats://localhost:4222)
 *   REDIS_URL         - Redis server URL (default: redis://localhost:6379)
 *   OTP_VALUE         - OTP code to inject (default: 123456)
 *   RESPONSE_DELAY_MS - Delay before injecting OTP (default: 0)
 *   FAILURE_MODE      - One of: none, timeout, wrong_otp, delayed_30s (default: none)
 *   LOG_FILE          - Optional file path for structured JSON log
 */

const { connect, StringCodec } = require('nats');
const Redis = require('ioredis');
const fs = require('fs');

const NATS_URL = process.env.NATS_URL || 'nats://localhost:4222';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const OTP_VALUE = process.env.OTP_VALUE || '123456';
const RESPONSE_DELAY_MS = parseInt(process.env.RESPONSE_DELAY_MS || '0', 10);
const FAILURE_MODE = process.env.FAILURE_MODE || 'none';
const LOG_FILE = process.env.LOG_FILE || '';
const OTP_TTL_SECONDS = 60;

function log(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  console.log(`[mock-hitl] ${line}`);
  if (LOG_FILE) {
    fs.appendFileSync(LOG_FILE, line + '\n');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  log({ event: 'starting', nats: NATS_URL, redis: REDIS_URL, failure_mode: FAILURE_MODE });

  const redis = new Redis(REDIS_URL);
  const nc = await connect({ servers: NATS_URL });
  const sc = StringCodec();

  log({ event: 'connected', nats: true, redis: true });

  // Subscribe to OTP-requested events (wildcard for all tenants/sessions)
  const otpSub = nc.subscribe('hitl.otp-requested.>');
  // Also subscribe to hitl.started for observability
  const startedSub = nc.subscribe('hitl.started.>');

  // Handle hitl.started events (log only)
  (async () => {
    for await (const msg of startedSub) {
      try {
        const event = JSON.parse(sc.decode(msg.data));
        log({
          event: 'hitl_started',
          session_id: event.payload?.session_id,
          reason: event.payload?.reason,
          subject: msg.subject,
        });
      } catch (err) {
        log({ event: 'parse_error', subject: msg.subject, error: err.message });
      }
    }
  })();

  // Handle OTP-requested events
  let otpCount = 0;
  for await (const msg of otpSub) {
    try {
      const event = JSON.parse(sc.decode(msg.data));
      const sessionId = event.payload?.session_id;
      if (!sessionId) {
        log({ event: 'skip', reason: 'no_session_id', subject: msg.subject });
        continue;
      }

      otpCount++;
      log({
        event: 'otp_requested',
        session_id: sessionId,
        tenant_id: event.payload?.tenant_id,
        app_name: event.payload?.app_name,
        count: otpCount,
      });

      // Apply failure mode
      if (FAILURE_MODE === 'timeout') {
        log({ event: 'otp_skipped', session_id: sessionId, reason: 'timeout_mode' });
        continue;
      }

      let otpToInject = OTP_VALUE;
      let delayMs = RESPONSE_DELAY_MS;

      if (FAILURE_MODE === 'wrong_otp') {
        otpToInject = '000000';
        log({ event: 'otp_wrong', session_id: sessionId, injecting: otpToInject });
      } else if (FAILURE_MODE === 'delayed_30s') {
        delayMs = 30000;
        log({ event: 'otp_delayed', session_id: sessionId, delay_ms: delayMs });
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }

      // Write OTP to Redis — key pattern: otp:{session_id}
      // Must match REDIS_KEYS.otp() from packages/shared/src/constants.ts:43
      const redisKey = `otp:${sessionId}`;
      await redis.set(redisKey, otpToInject, 'EX', OTP_TTL_SECONDS);

      log({
        event: 'otp_injected',
        session_id: sessionId,
        redis_key: redisKey,
        otp: otpToInject === OTP_VALUE ? '(correct)' : '(wrong)',
        delay_ms: delayMs,
      });
    } catch (err) {
      log({ event: 'error', subject: msg.subject, error: err.message });
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  log({ event: 'shutting_down', signal: 'SIGINT' });
  process.exit(0);
});
process.on('SIGTERM', () => {
  log({ event: 'shutting_down', signal: 'SIGTERM' });
  process.exit(0);
});

main().catch(err => {
  log({ event: 'fatal', error: err.message, stack: err.stack });
  process.exit(1);
});
