import { REDIS_KEYS } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// OTP Relay tests.
//
// We test the OtpRelay class by mocking the Redis client. The class polls
// Redis at 1-second intervals for an OTP value, reads it, then deletes the
// key immediately.
// ---------------------------------------------------------------------------

// Mock ioredis before importing OtpRelay
const mockRedisGet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisQuit = jest.fn();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    del: mockRedisDel,
    quit: mockRedisQuit,
  }));
});

import { OtpRelay } from './otp-relay';

describe('OtpRelay', () => {
  let relay: OtpRelay;
  const sessionId = 'session-abc-123';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    relay = new OtpRelay(sessionId);
  });

  afterEach(async () => {
    jest.useRealTimers();
    await relay.disconnect();
  });

  // -----------------------------------------------------------------------
  // OTP value received within timeout
  // -----------------------------------------------------------------------
  describe('OTP received within timeout', () => {
    it('returns OTP value when available on first poll', async () => {
      const expectedKey = REDIS_KEYS.otp(sessionId);
      mockRedisGet.mockResolvedValue('123456');
      mockRedisDel.mockResolvedValue(1);

      // Use real timers for this specific test since OTP is immediately available
      jest.useRealTimers();

      const result = await relay.waitForOtp(5000);

      expect(result).toBe('123456');
      expect(mockRedisGet).toHaveBeenCalledWith(expectedKey);
      expect(mockRedisDel).toHaveBeenCalledWith(expectedKey);
    });

    it('returns OTP value after several polling iterations', async () => {
      const expectedKey = REDIS_KEYS.otp(sessionId);
      let callCount = 0;

      mockRedisGet.mockImplementation(async () => {
        callCount++;
        if (callCount >= 3) {
          return '654321';
        }
        return null;
      });
      mockRedisDel.mockResolvedValue(1);

      jest.useRealTimers();

      const result = await relay.waitForOtp(10000);

      expect(result).toBe('654321');
      expect(callCount).toBeGreaterThanOrEqual(3);
      expect(mockRedisDel).toHaveBeenCalledWith(expectedKey);
    });
  });

  // -----------------------------------------------------------------------
  // Timeout when no OTP provided
  // -----------------------------------------------------------------------
  describe('timeout when no OTP provided', () => {
    it('returns null when OTP is never written to Redis', async () => {
      mockRedisGet.mockResolvedValue(null);

      jest.useRealTimers();

      // Very short timeout for test speed
      const result = await relay.waitForOtp(2000);

      expect(result).toBeNull();
      expect(mockRedisDel).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Key deletion after read
  // -----------------------------------------------------------------------
  describe('key deletion after read', () => {
    it('deletes the Redis key immediately after reading OTP', async () => {
      const expectedKey = REDIS_KEYS.otp(sessionId);
      mockRedisGet.mockResolvedValue('999888');
      mockRedisDel.mockResolvedValue(1);

      jest.useRealTimers();

      await relay.waitForOtp(5000);

      expect(mockRedisDel).toHaveBeenCalledWith(expectedKey);
      expect(mockRedisDel).toHaveBeenCalledTimes(1);
    });

    it('uses correct Redis key pattern otp:{session_id}', () => {
      const key = REDIS_KEYS.otp(sessionId);
      expect(key).toBe(`otp:${sessionId}`);
    });
  });

  // -----------------------------------------------------------------------
  // Redis key pattern
  // -----------------------------------------------------------------------
  describe('Redis key', () => {
    it('uses the shared REDIS_KEYS.otp function', () => {
      const key = REDIS_KEYS.otp('sess-42');
      expect(key).toBe('otp:sess-42');
    });
  });

  // -----------------------------------------------------------------------
  // disconnect
  // -----------------------------------------------------------------------
  describe('disconnect', () => {
    it('calls redis.quit on disconnect', async () => {
      jest.useRealTimers();

      // Force redis instantiation by calling waitForOtp briefly
      mockRedisGet.mockResolvedValue('otp');
      mockRedisDel.mockResolvedValue(1);
      await relay.waitForOtp(1000);

      mockRedisQuit.mockResolvedValue('OK');
      await relay.disconnect();

      expect(mockRedisQuit).toHaveBeenCalled();
    });
  });
});
