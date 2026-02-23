import { HealthResultType } from './enums';
import { evaluateHealthPolicy, HealthCheckResult } from './health.types';

function makeResult(result: HealthResultType): HealthCheckResult {
  return {
    check: { type: 'url_check', url: 'https://x.com', expect_status: 200 },
    result,
    duration_ms: 100,
  };
}

describe('evaluateHealthPolicy', () => {
  describe('policy: all', () => {
    it('returns PASS when all checks pass', () => {
      const results = [makeResult(HealthResultType.PASS), makeResult(HealthResultType.PASS)];
      expect(evaluateHealthPolicy(results, 'all')).toBe(HealthResultType.PASS);
    });

    it('returns AUTH_FAIL when any check has AUTH_FAIL', () => {
      const results = [makeResult(HealthResultType.PASS), makeResult(HealthResultType.AUTH_FAIL)];
      expect(evaluateHealthPolicy(results, 'all')).toBe(HealthResultType.AUTH_FAIL);
    });

    it('returns TRANSIENT_FAIL when any check has TRANSIENT_FAIL (no AUTH_FAIL)', () => {
      const results = [makeResult(HealthResultType.PASS), makeResult(HealthResultType.TRANSIENT_FAIL)];
      expect(evaluateHealthPolicy(results, 'all')).toBe(HealthResultType.TRANSIENT_FAIL);
    });

    it('returns AUTH_FAIL over TRANSIENT_FAIL', () => {
      const results = [makeResult(HealthResultType.TRANSIENT_FAIL), makeResult(HealthResultType.AUTH_FAIL)];
      expect(evaluateHealthPolicy(results, 'all')).toBe(HealthResultType.AUTH_FAIL);
    });
  });

  describe('policy: any', () => {
    it('returns PASS if at least one check passes', () => {
      const results = [makeResult(HealthResultType.AUTH_FAIL), makeResult(HealthResultType.PASS)];
      expect(evaluateHealthPolicy(results, 'any')).toBe(HealthResultType.PASS);
    });

    it('returns AUTH_FAIL if no check passes and one is AUTH_FAIL', () => {
      const results = [makeResult(HealthResultType.AUTH_FAIL), makeResult(HealthResultType.TRANSIENT_FAIL)];
      expect(evaluateHealthPolicy(results, 'any')).toBe(HealthResultType.AUTH_FAIL);
    });

    it('returns TRANSIENT_FAIL if all are TRANSIENT_FAIL', () => {
      const results = [makeResult(HealthResultType.TRANSIENT_FAIL), makeResult(HealthResultType.TRANSIENT_FAIL)];
      expect(evaluateHealthPolicy(results, 'any')).toBe(HealthResultType.TRANSIENT_FAIL);
    });
  });

  describe('policy: quorum', () => {
    it('returns PASS when quorum met', () => {
      const results = [
        makeResult(HealthResultType.PASS),
        makeResult(HealthResultType.PASS),
        makeResult(HealthResultType.AUTH_FAIL),
      ];
      expect(evaluateHealthPolicy(results, 'quorum', 2)).toBe(HealthResultType.PASS);
    });

    it('returns AUTH_FAIL when quorum not met and AUTH_FAIL present', () => {
      const results = [
        makeResult(HealthResultType.PASS),
        makeResult(HealthResultType.AUTH_FAIL),
        makeResult(HealthResultType.AUTH_FAIL),
      ];
      expect(evaluateHealthPolicy(results, 'quorum', 2)).toBe(HealthResultType.AUTH_FAIL);
    });

    it('uses default quorum of ceil(n/2) when quorum_n not specified', () => {
      const results = [
        makeResult(HealthResultType.PASS),
        makeResult(HealthResultType.PASS),
        makeResult(HealthResultType.TRANSIENT_FAIL),
      ];
      // Default quorum = ceil(3/2) = 2, 2 pass -> PASS
      expect(evaluateHealthPolicy(results, 'quorum')).toBe(HealthResultType.PASS);
    });
  });

  it('returns PASS for empty results', () => {
    expect(evaluateHealthPolicy([], 'all')).toBe(HealthResultType.PASS);
  });
});
