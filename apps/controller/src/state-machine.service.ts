import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, IsNull } from 'typeorm';
import {
  SessionState, HealthResultType, InterventionType,
  isValidSessionTransition, SESSION_TIMEOUTS, RETRY_MATRIX, BACKOFF_DEFAULTS,
} from '@browser-hitl/shared';
import type { InputRequest } from '@browser-hitl/shared';
import { SessionEntity } from './entities/session.entity';
import { SessionBatonEntity } from './entities/session-baton.entity';
import { InterventionEntity } from './entities/intervention.entity';
import { ApplicationEntity } from './entities/application.entity';
import { NatsPublisherService } from './nats-publisher.service';

/**
 * Session State Machine Service
 * Implements all 11 transitions from spec section 9.1
 * Controller is the SOLE writer of sessions.state
 */
@Injectable()
export class StateMachineService {
  private readonly logger = new Logger(StateMachineService.name);
  private readonly unhealthySinceMs = new Map<string, number>();

  constructor(
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(SessionBatonEntity)
    private readonly batonRepo: Repository<SessionBatonEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    private readonly dataSource: DataSource,
    private readonly natsPublisher: NatsPublisherService,
  ) {}

  /**
   * Transition a session's state with optimistic locking (CAS on state_version).
   * Returns true if transition succeeded, false if version conflict.
   */
  async transition(
    session: SessionEntity,
    newState: SessionState,
  ): Promise<boolean> {
    const oldState = session.state as SessionState;

    if (!isValidSessionTransition(oldState, newState)) {
      this.logger.warn(
        `Invalid transition: ${oldState} -> ${newState} for session ${session.id}`
      );
      return false;
    }

    // Optimistic locking: CAS on state_version
    const result = await this.sessionRepo.query(
      `UPDATE sessions
       SET state = $1, state_version = state_version + 1
       WHERE id = $2 AND state_version = $3`,
      [newState, session.id, session.state_version],
    );

    if (result[1] === 0) {
      this.logger.warn(`Version conflict for session ${session.id}, reloading`);
      return false;
    }

    this.logger.log(`Session ${session.id}: ${oldState} -> ${newState}`);

    if (newState === SessionState.UNHEALTHY) {
      this.unhealthySinceMs.set(session.id, Date.now());
    } else if (oldState === SessionState.UNHEALTHY) {
      this.unhealthySinceMs.delete(session.id);
    }

    // Publish state change event
    await this.natsPublisher.publishStateChange(
      session.tenant_id,
      session.id,
      session.app_id,
      oldState,
      newState,
    );

    return true;
  }

  /**
   * Evaluate session state based on health results and timeouts.
   * Called during each reconcile cycle per spec section 9.3.
   */
  async evaluateSession(session: SessionEntity): Promise<void> {
    const state = session.state as SessionState;
    const healthResult = session.health_result_type as HealthResultType | null;

    switch (state) {
      case SessionState.STARTING:
        await this.handleStarting(session, healthResult);
        break;

      case SessionState.HEALTHY:
        await this.handleHealthy(session, healthResult);
        break;

      case SessionState.UNHEALTHY:
        await this.handleUnhealthy(session, healthResult);
        break;

      case SessionState.LOGIN_NEEDED:
        await this.handleLoginNeeded(session);
        break;

      case SessionState.LOGIN_IN_PROGRESS:
        await this.handleLoginInProgress(session, healthResult);
        break;

      case SessionState.FAILED:
        // FAILED requires operator acknowledgement - no automatic transitions
        break;

      case SessionState.TERMINATED:
        // Terminal state - no transitions
        break;
    }
  }

  private async handleStarting(
    session: SessionEntity,
    healthResult: HealthResultType | null,
  ): Promise<void> {
    if (healthResult === HealthResultType.PASS) {
      // Successful login + health passes
      await this.transitionToHealthy(session);
      return;
    }

    if (healthResult === HealthResultType.AUTH_FAIL) {
      // Login DSL reached OTP/CAPTCHA requiring HITL
      await this.transition(session, SessionState.LOGIN_NEEDED);
      return;
    }

    // Check retry exhaustion (3 attempts)
    if (session.retry_count >= RETRY_MATRIX.STARTING.maxAttempts) {
      await this.transition(session, SessionState.FAILED);
    }
  }

  private async handleHealthy(
    session: SessionEntity,
    healthResult: HealthResultType | null,
  ): Promise<void> {
    if (!healthResult || healthResult === HealthResultType.PASS) {
      return; // Still healthy
    }

    // 2 consecutive failures -> UNHEALTHY (tracked by worker incrementing a counter)
    // For now, any non-PASS transitions to UNHEALTHY
    if (
      healthResult === HealthResultType.TRANSIENT_FAIL ||
      healthResult === HealthResultType.AUTH_FAIL
    ) {
      await this.transition(session, SessionState.UNHEALTHY);
    }
  }

  private async handleUnhealthy(
    session: SessionEntity,
    healthResult: HealthResultType | null,
  ): Promise<void> {
    if (healthResult === HealthResultType.PASS) {
      // Transient recovery
      await this.transitionToHealthy(session);
      return;
    }

    if (healthResult === HealthResultType.AUTH_FAIL) {
      // Escalate from UNHEALTHY only after the configured delay.
      const now = Date.now();
      const unhealthySince = this.unhealthySinceMs.get(session.id) ?? now;
      if (!this.unhealthySinceMs.has(session.id)) {
        this.unhealthySinceMs.set(session.id, unhealthySince);
      }
      const elapsed = now - unhealthySince;

      if (elapsed >= SESSION_TIMEOUTS.UNHEALTHY_ESCALATION_DELAY_MS) {
        await this.transition(session, SessionState.LOGIN_NEEDED);
      }
    }
  }

  private async handleLoginNeeded(session: SessionEntity): Promise<void> {
    // Check HITL escalation algorithm (spec section 9.10)
    const now = Date.now();

    if (session.hitl_pause_until && new Date(session.hitl_pause_until).getTime() > now) {
      // Pause is active, transition to FAILED
      await this.transition(session, SessionState.FAILED);
      return;
    }

    // Increment hitl_attempt_count
    const newCount = session.hitl_attempt_count + 1;
    await this.sessionRepo.update(session.id, { hitl_attempt_count: newCount });

    if (newCount >= SESSION_TIMEOUTS.HITL_MAX_ATTEMPTS_BEFORE_PAUSE) {
      // Set pause and transition to FAILED
      const pauseUntil = new Date(now + SESSION_TIMEOUTS.HITL_PAUSE_DURATION_MS);
      await this.sessionRepo.update(session.id, { hitl_pause_until: pauseUntil });
      await this.transition(session, SessionState.FAILED);
      return;
    }

    // Read pending input request from session (written by worker)
    const inputRequest = session.pending_input_request as InputRequest | null;
    const interventionType = this.mapInterventionType(inputRequest);

    // Create intervention record
    const intervention = this.interventionRepo.create({
      session_id: session.id,
      tenant_id: session.tenant_id,
      app_id: session.app_id,
      type: interventionType,
      input_request_metadata: inputRequest as unknown as Record<string, unknown> ?? null,
    });
    const savedIntervention = await this.interventionRepo.save(intervention);

    // Create baton record
    const existingBaton = await this.batonRepo.findOne({ where: { session_id: session.id } });
    if (!existingBaton) {
      const baton = this.batonRepo.create({
        session_id: session.id,
        baton_state: 'HUMAN_REQUESTED',
        requested_at: new Date(),
      });
      await this.batonRepo.save(baton);
    } else {
      await this.batonRepo.update(session.id, {
        baton_state: 'HUMAN_REQUESTED',
        requested_at: new Date(),
        owner_user_id: null,
      });
    }

    // Mark the beginning of the active login-intervention window explicitly.
    await this.sessionRepo.update(session.id, { last_login_at: new Date() });

    // Transition to LOGIN_IN_PROGRESS
    const transitioned = await this.transition(session, SessionState.LOGIN_IN_PROGRESS);
    if (!transitioned) {
      return;
    }

    const appName = await this.resolveAppName(session.app_id, session.tenant_id);

    // Publish HITL started event (includes intervention metadata)
    await this.natsPublisher.publishHitlStarted(
      session.tenant_id,
      session.id,
      session.app_id,
      savedIntervention.id,
      appName,
      interventionType,
      inputRequest ?? undefined,
    );

    // Clear pending_input_request after publishing
    await this.sessionRepo.update(session.id, { pending_input_request: null });
  }

  private async handleLoginInProgress(
    session: SessionEntity,
    healthResult: HealthResultType | null,
  ): Promise<void> {
    if (healthResult === HealthResultType.PASS) {
      // Successful login
      const transitioned = await this.transitionToHealthy(session);
      if (transitioned) {
        const completed = await this.completeActiveIntervention(session, 'SUCCESS');
        if (completed) {
          await this.natsPublisher.publishHitlCompleted(
            session.tenant_id,
            session.id,
            session.app_id,
            completed.id,
            'SUCCESS',
          );
        }
      }

      return;
    }

    // Check if worker is requesting new human input (sequential input requests)
    if (session.pending_input_request && healthResult === HealthResultType.AUTH_FAIL) {
      const inputRequest = session.pending_input_request as any;
      const appName = await this.resolveAppName(session.app_id, session.tenant_id);
      const interventionType = this.mapInterventionType(inputRequest);

      this.logger.log(
        `Session ${session.id}: new input requested (type=${inputRequest?.input_type}, step=${inputRequest?.step_index})`,
      );

      // Create a new intervention for each sequential input request
      // so session-status endpoint can return the latest step_index
      const intervention = this.interventionRepo.create({
        session_id: session.id,
        tenant_id: session.tenant_id,
        app_id: session.app_id,
        type: interventionType,
        input_request_metadata: inputRequest as unknown as Record<string, unknown> ?? null,
      });
      const savedIntervention = await this.interventionRepo.save(intervention);

      await this.natsPublisher.publishHitlStarted(
        session.tenant_id,
        session.id,
        session.app_id,
        savedIntervention.id,
        appName,
        interventionType,
        inputRequest,
      );

      // Clear so we don't re-publish on next reconcile
      await this.sessionRepo.update(session.id, { pending_input_request: null });

      // Reset the login timeout since we're actively in a new input step
      await this.sessionRepo.update(session.id, { last_login_at: new Date() });
      return;
    }

    // Check 10-minute timeout
    const loginStarted = session.last_login_at
      ? new Date(session.last_login_at).getTime()
      : session.started_at
        ? new Date(session.started_at).getTime()
        : Date.now();
    const elapsed = Date.now() - loginStarted;

    if (elapsed >= SESSION_TIMEOUTS.LOGIN_IN_PROGRESS_TIMEOUT_MS) {
      const transitioned = await this.transition(session, SessionState.FAILED);

      if (transitioned) {
        // Complete intervention as timeout and publish deterministic closure.
        const completed = await this.completeActiveIntervention(session, 'TIMEOUT');
        if (completed) {
          await this.natsPublisher.publishHitlCompleted(
            session.tenant_id,
            session.id,
            session.app_id,
            completed.id,
            'TIMEOUT',
          );
        }
      }
    }
  }

  private async transitionToHealthy(session: SessionEntity): Promise<boolean> {
    const success = await this.transition(session, SessionState.HEALTHY);
    if (success) {
      // Reset HITL counters on successful HEALTHY transition
      await this.sessionRepo.update(session.id, {
        hitl_attempt_count: 0,
        hitl_pause_until: null,
      });
    }
    return success;
  }

  private async resolveAppName(appId: string, tenantId: string): Promise<string> {
    try {
      const app = await this.appRepo.findOne({
        where: { id: appId, tenant_id: tenantId },
      });
      return app?.name || appId;
    } catch (error) {
      this.logger.warn(`Failed to resolve app name for ${appId}: ${(error as Error).message}`);
      return appId;
    }
  }

  private async completeActiveIntervention(
    session: SessionEntity,
    outcome: 'SUCCESS' | 'TIMEOUT' | 'FAIL',
  ): Promise<{ id: string } | null> {
    const intervention = await this.interventionRepo.findOne({
      where: {
        session_id: session.id,
        tenant_id: session.tenant_id,
        completed_at: IsNull(),
      },
      order: { started_at: 'DESC' },
    });
    if (!intervention) {
      return null;
    }

    await this.interventionRepo.update(intervention.id, {
      completed_at: new Date(),
      outcome,
    });
    return { id: intervention.id };
  }

  private mapInterventionType(inputRequest: InputRequest | null): string {
    if (!inputRequest) return InterventionType.MANUAL;
    switch (inputRequest.input_type) {
      case 'otp':
      case 'verification_code':
        return InterventionType.OTP;
      case 'captcha':
        return InterventionType.CAPTCHA;
      default:
        return InterventionType.INPUT_NEEDED;
    }
  }

  /**
   * Calculate backoff delay for retry (spec section 9.5)
   */
  calculateBackoffDelay(retryCount: number): number {
    const delay = BACKOFF_DEFAULTS.BASE_DELAY_MS * Math.pow(BACKOFF_DEFAULTS.MULTIPLIER, retryCount);
    return Math.min(delay, BACKOFF_DEFAULTS.MAX_DELAY_MS);
  }
}
