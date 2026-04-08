import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import { SessionState, StreamingMode } from '@browser-hitl/shared';
import { ApplicationEntity } from './entities/application.entity';
import { SessionEntity } from './entities/session.entity';
import { SessionBatonEntity } from './entities/session-baton.entity';
import { StateMachineService } from './state-machine.service';
import { PodManagerService } from './pod-manager.service';

/**
 * Reconcile Loop per spec section 9.3:
 * 1. Load desired sessions per app from applications.desired_session_count
 * 2. List current sessions and their states
 * 3. Create browser worker pods for missing sessions
 * 4. Terminate excess sessions (oldest first)
 * 5. Read health status written by workers
 * 6. Advance state transitions
 * 7. Generate NetworkPolicies for new pods
 * 8. Trigger HITL if any session enters LOGIN_NEEDED
 * 9. Persist state transitions and emit audit events
 */
@Injectable()
export class ReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReconcileService.name);
  private reconciling = false;
  private readonly intervalMs: number;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private readonly appCircuitPauseUntil = new Map<string, number>();
  private readonly tenantCircuitPauseUntil = new Map<string, number>();
  private readonly appCircuitFailureThreshold: number;
  private readonly tenantCircuitFailureThreshold: number;
  private readonly circuitWindowMs: number;
  private readonly circuitCooldownMs: number;

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(SessionBatonEntity)
    private readonly batonRepo: Repository<SessionBatonEntity>,
    private readonly stateMachine: StateMachineService,
    private readonly podManager: PodManagerService,
  ) {
    this.intervalMs = (parseInt(process.env.RECONCILE_INTERVAL_SECONDS || '15', 10)) * 1000;
    this.appCircuitFailureThreshold = this.readPositiveInt('CIRCUIT_BREAKER_APP_FAILURE_THRESHOLD', 5);
    this.tenantCircuitFailureThreshold = this.readPositiveInt('CIRCUIT_BREAKER_TENANT_FAILURE_THRESHOLD', 15);
    this.circuitWindowMs = this.readPositiveInt('CIRCUIT_BREAKER_WINDOW_SECONDS', 900) * 1000;
    this.circuitCooldownMs = this.readPositiveInt('CIRCUIT_BREAKER_COOLDOWN_SECONDS', 300) * 1000;
  }

  async onModuleInit() {
    this.logger.log(`Reconcile loop starting with interval ${this.intervalMs}ms`);
    // Run immediately on startup, then on interval
    await this.reconcile();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.intervalMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) {
      this.logger.debug('Reconcile already in progress, skipping');
      return;
    }

    this.reconciling = true;
    try {
      await this.doReconcile();
    } catch (error) {
      this.logger.error(`Reconcile error: ${error}`);
    } finally {
      this.reconciling = false;
    }
  }

  private async doReconcile(): Promise<void> {
    // Step 1: Load all apps with their desired session counts
    const apps = await this.appRepo.find();

    for (const app of apps) {
      await this.reconcileApp(app);
    }

    // Runtime drift self-healing: reconcile session records with pod reality.
    await this.reconcileRuntimeDrift();

    // Step 5-6: Evaluate state for all active sessions
    const activeSessions = await this.sessionRepo.find({
      where: [
        { state: SessionState.STARTING as any },
        { state: SessionState.HEALTHY as any },
        { state: SessionState.UNHEALTHY as any },
        { state: SessionState.LOGIN_NEEDED as any },
        { state: SessionState.LOGIN_IN_PROGRESS as any },
        { state: SessionState.FAILED as any },
      ],
    });

    for (const session of activeSessions) {
      await this.stateMachine.evaluateSession(session);
    }

    // Step 8: Check session recycling
    await this.checkRecycling();
  }

  private async reconcileApp(app: ApplicationEntity): Promise<void> {
    // Step 2: List current non-terminated sessions for this app
    const currentSessions = await this.sessionRepo.find({
      where: { app_id: app.id },
    });

    const activeSessions = currentSessions.filter(
      s => s.state !== SessionState.TERMINATED
    );

    const desired = app.desired_session_count;
    const actual = activeSessions.length;

    // Keep egress allowlist synced for all currently active runtime sessions.
    for (const session of activeSessions) {
      if (!session.pod_name) {
        continue;
      }
      try {
        await this.podManager.syncEgressAllowlist(session.id, app.target_urls);
      } catch (error) {
        this.logger.error(
          `Egress allowlist sync failed for session ${session.id}; terminating session fail-closed: ${error}`,
        );
        await this.terminateSession(session);
      }
    }

    // Step 3: Create missing sessions
    if (actual < desired) {
      const circuitOpen = await this.isProvisioningCircuitOpen(app);
      if (circuitOpen) {
        this.logger.warn(
          `App ${app.id}: circuit breaker open; skipping scale-up (desired=${desired}, actual=${actual})`,
        );
        return;
      }

      const toCreate = desired - actual;
      this.logger.log(`App ${app.id}: creating ${toCreate} sessions (desired=${desired}, actual=${actual})`);

      for (let i = 0; i < toCreate; i++) {
        await this.createSession(app);
      }
    }

    // Step 4: Terminate excess sessions (oldest first)
    if (actual > desired) {
      const toTerminate = actual - desired;
      const sorted = activeSessions.sort(
        (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
      );

      this.logger.log(`App ${app.id}: terminating ${toTerminate} excess sessions`);

      for (let i = 0; i < toTerminate; i++) {
        await this.terminateSession(sorted[i]);
      }
    }
  }

  private async createSession(app: ApplicationEntity): Promise<void> {
    // Create session record — inherit owner_user_id from app (per-user isolation)
    const session = this.sessionRepo.create({
      app_id: app.id,
      tenant_id: app.tenant_id,
      state: SessionState.STARTING,
      state_version: 0,
      retry_count: 0,
      intervention_count: 0,
      hitl_attempt_count: 0,
      owner_user_id: app.owner_user_id ?? null,
    });
    const savedSession = await this.sessionRepo.save(session);

    // Create baton record
    const baton = this.batonRepo.create({
      session_id: savedSession.id,
      baton_state: 'AUTOMATION_CONTROL',
      version: 0,
    });
    await this.batonRepo.save(baton);

    const streamingMode = this.podManager.resolveStreamingMode(app);
    let podName: string | null = null;
    try {
      // Create browser worker pod
      podName = await this.podManager.createWorkerPod(savedSession, app);
      await this.sessionRepo.update(savedSession.id, { pod_name: podName });

      // Create the appropriate streaming service based on mode
      if (streamingMode === StreamingMode.CDP) {
        await this.podManager.createCdpService(savedSession.id, podName);
      } else {
        await this.podManager.createNoVncService(savedSession.id, podName);
      }

      // Generate NetworkPolicy
      await this.podManager.createNetworkPolicy(savedSession.id, podName, app.target_urls, streamingMode);

      this.logger.log(`Created session ${savedSession.id} with pod ${podName} (mode=${streamingMode})`);
    } catch (error) {
      this.logger.error(
        `Failed to finish runtime provisioning for session ${savedSession.id}: ${error}`,
      );

      // Best-effort cleanup for partially created runtime resources.
      try {
        if (podName) {
          await this.podManager.deleteWorkerPod(podName);
          if (streamingMode === StreamingMode.CDP) {
            await this.podManager.deleteCdpService(savedSession.id, podName);
          } else {
            await this.podManager.deleteNoVncService(savedSession.id, podName);
          }
        } else {
          if (streamingMode === StreamingMode.CDP) {
            await this.podManager.deleteCdpService(savedSession.id);
          } else {
            await this.podManager.deleteNoVncService(savedSession.id);
          }
        }
        await this.podManager.deleteNetworkPolicy(savedSession.id);
      } catch (cleanupError) {
        this.logger.warn(`Provisioning cleanup failed for session ${savedSession.id}: ${cleanupError}`);
      }

      await this.sessionRepo.update(savedSession.id, {
        state: SessionState.FAILED as any,
        state_version: Number(savedSession.state_version) + 1,
        retry_count: savedSession.retry_count + 1,
      });
      throw error;
    }
  }

  private async terminateSession(session: SessionEntity): Promise<void> {
    // Transition to TERMINATED
    await this.stateMachine.transition(session, SessionState.TERMINATED);

    // Delete pod and NetworkPolicy
    if (session.pod_name) {
      await this.podManager.deleteWorkerPod(session.pod_name);
    }
    // Clean up both service types (only one will exist, the other is a no-op)
    await this.podManager.deleteNoVncService(session.id, session.pod_name || undefined);
    await this.podManager.deleteCdpService(session.id, session.pod_name || undefined);
    await this.podManager.deleteNetworkPolicy(session.id);

    this.logger.log(`Terminated session ${session.id}`);
  }

  /**
   * Check for sessions exceeding max age or memory watermark (FR-34)
   */
  private async checkRecycling(): Promise<void> {
    const maxAgeHours = parseInt(process.env.MAX_SESSION_AGE_HOURS || '24', 10);
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const now = Date.now();

    const healthySessions = await this.sessionRepo.find({
      where: { state: SessionState.HEALTHY as any },
    });

    const idleShutdownSeconds = parseInt(process.env.IDLE_SHUTDOWN_SECONDS || '0', 10);
    const idleShutdownMs = idleShutdownSeconds * 1000;

    for (const session of healthySessions) {
      const age = now - new Date(session.started_at).getTime();
      if (age >= maxAgeMs) {
        this.logger.log(`Recycling session ${session.id} (age: ${Math.round(age / 3600000)}h)`);
        // Terminate and let reconcile recreate it
        await this.terminateSession(session);
        continue;
      }

      // Idle shutdown: if session has owner_user_id (per-user) and hasn't been used
      if (idleShutdownMs > 0 && session.owner_user_id && session.last_credential_request_at) {
        const idleTime = now - new Date(session.last_credential_request_at).getTime();
        if (idleTime >= idleShutdownMs) {
          this.logger.log(
            `Idle shutdown: session ${session.id} owner=${session.owner_user_id} ` +
            `idle ${Math.round(idleTime / 60000)}min (threshold: ${idleShutdownSeconds}s)`,
          );
          // Set desired_session_count to 0 so it doesn't restart
          await this.appRepo.update(session.app_id, { desired_session_count: 0 });
          await this.terminateSession(session);
        }
      }
    }
  }

  private async reconcileRuntimeDrift(): Promise<void> {
    const sessions = await this.sessionRepo.find();
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));

    // Detect sessions that claim a pod but the pod no longer exists.
    for (const session of sessions) {
      if (!session.pod_name) {
        continue;
      }
      const exists = await this.podManager.podExists(session.pod_name);
      if (exists) {
        continue;
      }

      this.logger.warn(
        `Runtime drift detected: session ${session.id} references missing pod ${session.pod_name}`,
      );

      if (session.state !== SessionState.TERMINATED) {
        await this.stateMachine.transition(session, SessionState.TERMINATED);
      }
      await this.sessionRepo.update(session.id, { pod_name: null });

      // Best-effort cleanup of residual per-session resources (both service types).
      await this.podManager.deleteNoVncService(session.id, session.pod_name);
      await this.podManager.deleteCdpService(session.id, session.pod_name);
      await this.podManager.deleteNetworkPolicy(session.id);
    }

    // Sweep orphan worker pods with missing/terminated session ownership.
    const workerPods = await this.podManager.listWorkerPods();
    for (const workerPod of workerPods) {
      if (!workerPod.sessionId) {
        this.logger.warn(`Deleting unlabeled orphan worker pod ${workerPod.podName}`);
        await this.podManager.deleteWorkerPod(workerPod.podName);
        continue;
      }

      const session = sessionsById.get(workerPod.sessionId);
      if (!session || session.state === SessionState.TERMINATED) {
        this.logger.warn(
          `Deleting orphan worker pod ${workerPod.podName} (session=${workerPod.sessionId})`,
        );
        await this.podManager.deleteWorkerPod(workerPod.podName);
        await this.podManager.deleteNoVncService(workerPod.sessionId, workerPod.podName);
        await this.podManager.deleteCdpService(workerPod.sessionId, workerPod.podName);
        await this.podManager.deleteNetworkPolicy(workerPod.sessionId);
      }
    }
  }

  private async isProvisioningCircuitOpen(app: ApplicationEntity): Promise<boolean> {
    const now = Date.now();
    const appPauseUntil = this.appCircuitPauseUntil.get(app.id);
    if (typeof appPauseUntil === 'number' && appPauseUntil > now) {
      return true;
    }
    if (typeof appPauseUntil === 'number' && appPauseUntil <= now) {
      this.appCircuitPauseUntil.delete(app.id);
    }

    const tenantPauseUntil = this.tenantCircuitPauseUntil.get(app.tenant_id);
    if (typeof tenantPauseUntil === 'number' && tenantPauseUntil > now) {
      return true;
    }
    if (typeof tenantPauseUntil === 'number' && tenantPauseUntil <= now) {
      this.tenantCircuitPauseUntil.delete(app.tenant_id);
    }

    const windowStart = new Date(now - this.circuitWindowMs);
    const [appFailures, tenantFailures] = await Promise.all([
      this.sessionRepo.count({
        where: {
          app_id: app.id,
          state: SessionState.FAILED as any,
          started_at: MoreThan(windowStart),
        },
      }),
      this.sessionRepo.count({
        where: {
          tenant_id: app.tenant_id,
          state: SessionState.FAILED as any,
          started_at: MoreThan(windowStart),
        },
      }),
    ]);

    if (appFailures >= this.appCircuitFailureThreshold) {
      const pauseUntil = now + this.circuitCooldownMs;
      this.appCircuitPauseUntil.set(app.id, pauseUntil);
      this.logger.warn(
        `Circuit breaker tripped for app ${app.id}: ${appFailures} failures within ${Math.round(this.circuitWindowMs / 1000)}s`,
      );
      return true;
    }

    if (tenantFailures >= this.tenantCircuitFailureThreshold) {
      const pauseUntil = now + this.circuitCooldownMs;
      this.tenantCircuitPauseUntil.set(app.tenant_id, pauseUntil);
      this.logger.warn(
        `Circuit breaker tripped for tenant ${app.tenant_id}: ${tenantFailures} failures within ${Math.round(this.circuitWindowMs / 1000)}s`,
      );
      return true;
    }

    return false;
  }

  private readPositiveInt(name: string, fallback: number): number {
    const raw = (process.env[name] || '').trim();
    if (!raw) {
      return fallback;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }
}
