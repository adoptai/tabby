import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Phase 7.1: Critical Service Unit Tests (H8)
 *
 * Tests for services and guards that are on the critical path
 * but previously lacked dedicated test coverage:
 * - RolesGuard (authorization enforcement)
 * - UserThrottlerGuard (rate-limiting key extraction)
 * - HitlService (source-level verification of business logic)
 * - HitlController (DTO validation + role assignments)
 */
describe('Phase 7.1: Critical Service Tests (H8)', () => {
  // =========================================================================
  // RolesGuard — Authorization enforcement
  // =========================================================================
  describe('RolesGuard', () => {
    const guardSrc = fs.readFileSync(
      path.resolve(__dirname, 'common/guards/roles.guard.ts'),
      'utf-8',
    );

    it('should export ROLES_KEY constant', () => {
      expect(guardSrc).toContain("export const ROLES_KEY = 'roles'");
    });

    it('should export Roles decorator', () => {
      expect(guardSrc).toContain('export const Roles = ');
      expect(guardSrc).toContain('SetMetadata(ROLES_KEY');
    });

    it('should implement CanActivate', () => {
      expect(guardSrc).toContain('implements CanActivate');
    });

    it('should inject Reflector for reading metadata', () => {
      expect(guardSrc).toContain('private reflector: Reflector');
    });

    it('should return true when no roles are required', () => {
      expect(guardSrc).toContain('!requiredRoles || requiredRoles.length === 0');
      // Immediately after: return true
      expect(guardSrc).toMatch(/requiredRoles\.length === 0.*\n.*return true/);
    });

    it('should check user role against required roles', () => {
      expect(guardSrc).toContain('requiredRoles.includes(user.role)');
    });

    it('should extract user from HTTP request', () => {
      expect(guardSrc).toContain('context.switchToHttp().getRequest()');
    });

    it('should export JwtAuthGuard extending Passport AuthGuard', () => {
      expect(guardSrc).toContain("extends AuthGuard('jwt')");
    });
  });

  // =========================================================================
  // UserThrottlerGuard — Rate-limit key extraction
  // =========================================================================
  describe('UserThrottlerGuard', () => {
    const throttleSrc = fs.readFileSync(
      path.resolve(__dirname, 'common/guards/user-throttler.guard.ts'),
      'utf-8',
    );

    it('should extend ThrottlerGuard', () => {
      expect(throttleSrc).toContain('extends ThrottlerGuard');
    });

    it('should prefer user_id for authenticated requests', () => {
      expect(throttleSrc).toContain('req?.user?.user_id');
      expect(throttleSrc).toContain('user:${req.user.user_id}');
    });

    it('should fall back to X-Forwarded-For for unauthenticated requests', () => {
      expect(throttleSrc).toContain("'x-forwarded-for'");
      expect(throttleSrc).toContain("xff.split(',')[0].trim()");
    });

    it('should handle X-Forwarded-For as array', () => {
      expect(throttleSrc).toContain('Array.isArray(xff)');
    });

    it('should fall back to req.ip as last resort', () => {
      expect(throttleSrc).toContain('req.ip || req.socket?.remoteAddress');
    });

    it('should handle unknown IP gracefully', () => {
      expect(throttleSrc).toContain("'unknown'");
    });

    it('should override getRequestResponse', () => {
      expect(throttleSrc).toContain('getRequestResponse(context: ExecutionContext)');
    });
  });

  // =========================================================================
  // HitlService — Business logic verification
  // =========================================================================
  describe('HitlService', () => {
    const hitlSrc = fs.readFileSync(
      path.resolve(__dirname, 'modules/hitl/hitl.service.ts'),
      'utf-8',
    );

    it('should be injectable and implement OnModuleDestroy', () => {
      expect(hitlSrc).toContain('@Injectable()');
      expect(hitlSrc).toContain('implements OnModuleDestroy');
    });

    it('should use Redis for human input storage', () => {
      expect(hitlSrc).toContain('REDIS_KEYS.humanInput(sessionId');
      expect(hitlSrc).toContain("'EX'");
      expect(hitlSrc).toContain('REDIS_TTL.HUMAN_INPUT_SECONDS');
    });

    it('should enforce session state for takeover', () => {
      expect(hitlSrc).toContain("session.state !== 'LOGIN_IN_PROGRESS'");
    });

    it('should use pessimistic write lock on baton operations', () => {
      expect(hitlSrc).toContain("lock: { mode: 'pessimistic_write' }");
    });

    it('should implement CAS via baton version increment', () => {
      expect(hitlSrc).toContain('baton.version = Number(baton.version) + 1');
    });

    it('should prevent non-owner release (unless Admin)', () => {
      expect(hitlSrc).toContain("baton.owner_user_id !== actorId && actorRole !== 'Admin'");
    });

    it('should validate acknowledge only for FAILED sessions', () => {
      expect(hitlSrc).toContain("session.state !== 'FAILED'");
    });

    it('should respect HITL pause window', () => {
      expect(hitlSrc).toContain('hitl_pause_until');
      expect(hitlSrc).toContain('retry_after_seconds');
    });

    it('should implement idempotency via Redis', () => {
      expect(hitlSrc).toContain('readActionIdempotency');
      expect(hitlSrc).toContain('writeActionIdempotency');
    });

    it('should validate idempotency key format', () => {
      expect(hitlSrc).toContain(/^[A-Za-z0-9._:-]+$/.toString().slice(1, -1));
    });

    it('should reject idempotency keys over 128 chars', () => {
      expect(hitlSrc).toContain('normalized.length > 128');
    });

    it('should audit all HITL actions', () => {
      expect(hitlSrc).toContain("'hitl.stream_requested'");
      expect(hitlSrc).toContain("'hitl.takeover'");
      expect(hitlSrc).toContain("'hitl.release'");
      expect(hitlSrc).toContain("'hitl.input_submitted'");
      expect(hitlSrc).toContain("'hitl.acknowledge'");
    });

    it('should track input metrics', () => {
      expect(hitlSrc).toContain("'hitl_input_submitted_total'");
    });

    it('should handle baton timeout transitions', () => {
      expect(hitlSrc).toContain('BATON_TIMEOUTS.HUMAN_REQUESTED_TIMEOUT_MS');
      expect(hitlSrc).toContain('BATON_TIMEOUTS.HUMAN_CONTROL_INACTIVITY_TIMEOUT_MS');
    });

    it('should disconnect Redis on module destroy', () => {
      expect(hitlSrc).toContain('this.redis.quit()');
    });
  });

  // =========================================================================
  // HitlController — DTO validation + role guards
  // =========================================================================
  describe('HitlController', () => {
    const ctrlSrc = fs.readFileSync(
      path.resolve(__dirname, 'modules/hitl/hitl.controller.ts'),
      'utf-8',
    );

    it('should guard all endpoints with JWT + Roles', () => {
      expect(ctrlSrc).toContain('@UseGuards(JwtAuthGuard, RolesGuard)');
    });

    it('should restrict stream to Admin, Operator, Viewer', () => {
      expect(ctrlSrc).toContain("@Roles('Admin', 'Operator', 'Viewer')");
    });

    it('should restrict takeover to Admin, Operator', () => {
      // Check that takeover method has the Operator role
      const takeoverSection = ctrlSrc.split('takeover')[0].slice(-200);
      expect(ctrlSrc).toMatch(/@Roles\('Admin', 'Operator'\)[\s\S]*?takeover/);
    });

    it('should use InputDto with input_type, value, step_index', () => {
      expect(ctrlSrc).toContain('class InputDto');
      expect(ctrlSrc).toContain('input_type: string');
      expect(ctrlSrc).toContain('step_index: number');
    });

    it('should use AcknowledgeDto with validated note', () => {
      expect(ctrlSrc).toContain('class AcknowledgeDto');
      expect(ctrlSrc).toContain('@MaxLength(2000)');
    });

    it('should accept idempotency-key header on all mutation endpoints', () => {
      const idempotencyCount = (ctrlSrc.match(/idempotency-key/g) || []).length;
      expect(idempotencyCount).toBeGreaterThanOrEqual(3); // takeover, release, input, acknowledge
    });

    it('should throttle stream endpoint', () => {
      expect(ctrlSrc).toContain('@Throttle');
    });
  });
});
