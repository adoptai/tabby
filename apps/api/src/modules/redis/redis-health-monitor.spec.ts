import { RedisHealthState, RedisFailureTier } from '@browser-hitl/shared';

// ---------------------------------------------------------------------------
// Mock ioredis
// ---------------------------------------------------------------------------
const mockRedis = {
  ping: jest.fn().mockResolvedValue('PONG'),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

import { RedisHealthMonitor } from './redis-health-monitor';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMonitor(): RedisHealthMonitor {
  return new RedisHealthMonitor();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedisHealthMonitor (ADR-011)', () => {
  let monitor: RedisHealthMonitor;

  beforeEach(() => {
    jest.clearAllMocks();
    monitor = createMonitor();
  });

  afterEach(async () => {
    await monitor.onModuleDestroy();
  });

  // =========================================================================
  // State Machine Transitions
  // =========================================================================

  describe('State Machine', () => {
    it('should start in HEALTHY state', () => {
      expect(monitor.getState()).toBe(RedisHealthState.HEALTHY);
      expect(monitor.isHealthy()).toBe(true);
      expect(monitor.isDegraded()).toBe(false);
      expect(monitor.isDown()).toBe(false);
    });

    it('should transition HEALTHY → DEGRADED on first failure', () => {
      monitor.recordFailure('Connection refused');

      expect(monitor.getState()).toBe(RedisHealthState.DEGRADED);
      expect(monitor.isDegraded()).toBe(true);
      expect(monitor.getLastError()).toBe('Connection refused');
    });

    it('should stay DEGRADED after second consecutive failure', () => {
      monitor.recordFailure('err1');
      monitor.recordFailure('err2');

      expect(monitor.getState()).toBe(RedisHealthState.DEGRADED);
    });

    it('should transition DEGRADED → DOWN after 3 consecutive failures', () => {
      monitor.recordFailure('err1'); // HEALTHY → DEGRADED
      monitor.recordFailure('err2'); // still DEGRADED
      monitor.recordFailure('err3'); // DEGRADED → DOWN (3 >= threshold)

      expect(monitor.getState()).toBe(RedisHealthState.DOWN);
      expect(monitor.isDown()).toBe(true);
    });

    it('should stay DOWN on continued failures', () => {
      // Drive to DOWN
      monitor.recordFailure('e1');
      monitor.recordFailure('e2');
      monitor.recordFailure('e3');
      expect(monitor.isDown()).toBe(true);

      // More failures: stay DOWN
      monitor.recordFailure('e4');
      monitor.recordFailure('e5');
      expect(monitor.isDown()).toBe(true);
    });

    it('should transition DOWN → DEGRADED on first success', () => {
      // Drive to DOWN
      monitor.recordFailure('e1');
      monitor.recordFailure('e2');
      monitor.recordFailure('e3');
      expect(monitor.isDown()).toBe(true);

      monitor.recordSuccess();

      expect(monitor.getState()).toBe(RedisHealthState.DEGRADED);
      expect(monitor.getLastError()).toBeNull();
    });

    it('should transition DEGRADED → HEALTHY after 2 consecutive successes', () => {
      // Drive to DEGRADED
      monitor.recordFailure('e1');
      expect(monitor.isDegraded()).toBe(true);

      monitor.recordSuccess(); // 1st success
      expect(monitor.isDegraded()).toBe(true); // still DEGRADED

      monitor.recordSuccess(); // 2nd success → HEALTHY
      expect(monitor.isHealthy()).toBe(true);
    });

    it('should require 2 fresh successes after DOWN → DEGRADED recovery', () => {
      // Drive to DOWN
      monitor.recordFailure('e1');
      monitor.recordFailure('e2');
      monitor.recordFailure('e3');

      // First success: DOWN → DEGRADED (counter reset to 1)
      monitor.recordSuccess();
      expect(monitor.isDegraded()).toBe(true);

      // Second success: DEGRADED → HEALTHY (2 >= threshold)
      monitor.recordSuccess();
      expect(monitor.isHealthy()).toBe(true);
    });

    it('should reset failure counter on success', () => {
      monitor.recordFailure('e1'); // HEALTHY → DEGRADED, failures=1
      monitor.recordSuccess();      // failures=0, successes=1
      monitor.recordFailure('e2'); // successes=0, failures=1 (DEGRADED again)

      // Only 1 failure since last success, still DEGRADED (not DOWN)
      expect(monitor.isDegraded()).toBe(true);
    });

    it('should reset success counter on failure', () => {
      monitor.recordFailure('e1'); // DEGRADED
      monitor.recordSuccess();      // 1 success
      monitor.recordFailure('e2'); // resets success counter

      // Need 2 fresh successes now
      monitor.recordSuccess(); // 1 success
      expect(monitor.isDegraded()).toBe(true);
      monitor.recordSuccess(); // 2 successes → HEALTHY
      expect(monitor.isHealthy()).toBe(true);
    });

    it('should handle full cycle: HEALTHY → DEGRADED → DOWN → DEGRADED → HEALTHY', () => {
      expect(monitor.isHealthy()).toBe(true);

      monitor.recordFailure('e1');
      expect(monitor.isDegraded()).toBe(true);

      monitor.recordFailure('e2');
      monitor.recordFailure('e3');
      expect(monitor.isDown()).toBe(true);

      monitor.recordSuccess();
      expect(monitor.isDegraded()).toBe(true);

      monitor.recordSuccess();
      expect(monitor.isHealthy()).toBe(true);
    });

    it('should not go beyond HEALTHY on continued successes', () => {
      monitor.recordSuccess();
      monitor.recordSuccess();
      monitor.recordSuccess();
      monitor.recordSuccess();
      expect(monitor.isHealthy()).toBe(true);
    });
  });

  // =========================================================================
  // Tier Evaluation
  // =========================================================================

  describe('Tier Evaluation', () => {
    describe('when HEALTHY', () => {
      it('should return proceed for SECURITY tier', () => {
        expect(monitor.evaluateTier(RedisFailureTier.SECURITY)).toBe('proceed');
      });

      it('should return proceed for CONSISTENCY tier', () => {
        expect(monitor.evaluateTier(RedisFailureTier.CONSISTENCY)).toBe('proceed');
      });

      it('should return proceed for AVAILABILITY tier', () => {
        expect(monitor.evaluateTier(RedisFailureTier.AVAILABILITY)).toBe('proceed');
      });
    });

    describe('when DEGRADED', () => {
      beforeEach(() => {
        monitor.recordFailure('degraded');
      });

      it('should return proceed for SECURITY tier', () => {
        expect(monitor.evaluateTier(RedisFailureTier.SECURITY)).toBe('proceed');
      });

      it('should return skip for CONSISTENCY tier (safe defaults per RT-09)', () => {
        expect(monitor.evaluateTier(RedisFailureTier.CONSISTENCY)).toBe('skip');
      });

      it('should return proceed for AVAILABILITY tier', () => {
        expect(monitor.evaluateTier(RedisFailureTier.AVAILABILITY)).toBe('proceed');
      });
    });

    describe('when DOWN', () => {
      beforeEach(() => {
        monitor.recordFailure('e1');
        monitor.recordFailure('e2');
        monitor.recordFailure('e3');
      });

      it('should return deny for SECURITY tier (fail-closed)', () => {
        expect(monitor.evaluateTier(RedisFailureTier.SECURITY)).toBe('deny');
      });

      it('should return skip for CONSISTENCY tier (safe defaults)', () => {
        expect(monitor.evaluateTier(RedisFailureTier.CONSISTENCY)).toBe('skip');
      });

      it('should return skip for AVAILABILITY tier (fail-open)', () => {
        expect(monitor.evaluateTier(RedisFailureTier.AVAILABILITY)).toBe('skip');
      });
    });
  });

  // =========================================================================
  // Probe Integration
  // =========================================================================

  describe('Probe', () => {
    it('should record success on successful ping', async () => {
      mockRedis.ping.mockResolvedValue('PONG');

      // Drive to DEGRADED first to verify recovery
      monitor.recordFailure('initial');
      expect(monitor.isDegraded()).toBe(true);

      await monitor.probe();

      expect(mockRedis.ping).toHaveBeenCalled();
      expect(monitor.getLastError()).toBeNull();
      expect(monitor.getLastProbeAt()).toBeInstanceOf(Date);
    });

    it('should record failure on ping error', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection refused'));

      await monitor.probe();

      expect(monitor.isDegraded()).toBe(true);
      expect(monitor.getLastError()).toBe('Connection refused');
    });

    it('should transition through states on repeated probe failures', async () => {
      mockRedis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

      await monitor.probe(); // HEALTHY → DEGRADED
      expect(monitor.isDegraded()).toBe(true);

      await monitor.probe(); // still DEGRADED
      expect(monitor.isDegraded()).toBe(true);

      await monitor.probe(); // DEGRADED → DOWN
      expect(monitor.isDown()).toBe(true);
    });

    it('should recover through states on probe successes after DOWN', async () => {
      // Drive to DOWN
      mockRedis.ping.mockRejectedValue(new Error('ECONNREFUSED'));
      await monitor.probe();
      await monitor.probe();
      await monitor.probe();
      expect(monitor.isDown()).toBe(true);

      // Recovery
      mockRedis.ping.mockResolvedValue('PONG');
      await monitor.probe(); // DOWN → DEGRADED
      expect(monitor.isDegraded()).toBe(true);

      await monitor.probe(); // DEGRADED → HEALTHY
      expect(monitor.isHealthy()).toBe(true);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('Edge cases', () => {
    it('should track last error message', () => {
      monitor.recordFailure('first error');
      expect(monitor.getLastError()).toBe('first error');

      monitor.recordFailure('second error');
      expect(monitor.getLastError()).toBe('second error');

      monitor.recordSuccess();
      expect(monitor.getLastError()).toBeNull();
    });

    it('should use default error message when none provided', () => {
      monitor.recordFailure();
      expect(monitor.getLastError()).toBe('unknown error');
    });

    it('should update lastProbeAt on each probe', async () => {
      const before = new Date();
      await monitor.probe();
      const after = new Date();

      const probeTime = monitor.getLastProbeAt();
      expect(probeTime).not.toBeNull();
      expect(probeTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(probeTime!.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });
});
