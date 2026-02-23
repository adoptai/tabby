import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DEFAULTS } from '@browser-hitl/shared';
import { LoginQueueEntity } from '../../entities/login-queue.entity';
import { AuthRequestEntity } from '../../entities/auth-request.entity';

/**
 * Result of an enqueue attempt.
 */
export type EnqueueResult =
  | { enqueued: true; queueEntry: LoginQueueEntity }
  | { enqueued: false; reason: string };

/**
 * Callback invoked when a queue entry is ready to start.
 * The consumer (e.g., Controller reconcile loop) provides this
 * to trigger the actual worker login.
 */
export type LoginTriggerFn = (entry: LoginQueueEntity) => Promise<void>;

/**
 * Global Login Coordinator (ADR-015).
 *
 * Enforces system-wide and per-target-domain login rate limits
 * via a PostgreSQL-backed queue (survives Redis outages).
 *
 * Three rate limits:
 *   LIMIT 1: Max concurrent logins system-wide (default: 5)
 *   LIMIT 2: Max concurrent logins per target domain (default: 3, RT-06)
 *   LIMIT 3: Min interval per credential set (60s, enforced by ADR-012 Barrier 3)
 *
 * Queue processing is event-driven via PG LISTEN/NOTIFY (RT-12 amendment)
 * with a fallback polling interval.
 */
@Injectable()
export class LoginCoordinatorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoginCoordinatorService.name);
  private processTimer: NodeJS.Timeout | null = null;
  private readonly processIntervalMs: number;
  private readonly startupStaggerMs: number;
  private readonly globalMaxConcurrent: number;
  private readonly defaultMaxPerDomain: number;
  private processing = false;
  private started = false;
  private pgListenerConnection: any = null;
  private loginTrigger: LoginTriggerFn | null = null;

  constructor(
    @InjectRepository(LoginQueueEntity)
    private readonly queueRepo: Repository<LoginQueueEntity>,
    @InjectRepository(AuthRequestEntity)
    private readonly authRequestRepo: Repository<AuthRequestEntity>,
    private readonly dataSource: DataSource,
  ) {
    this.processIntervalMs = DEFAULTS.QUEUE_PROCESS_INTERVAL_MS;
    this.startupStaggerMs = DEFAULTS.STARTUP_STAGGER_MS;
    this.globalMaxConcurrent = DEFAULTS.GLOBAL_MAX_CONCURRENT_LOGINS;
    this.defaultMaxPerDomain = DEFAULTS.MAX_CONCURRENT_PER_DOMAIN;
  }

  // ---------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------

  async onModuleInit(): Promise<void> {
    this.logger.log(
      `Login coordinator starting (stagger=${this.startupStaggerMs}ms, ` +
      `global_max=${this.globalMaxConcurrent}, per_domain=${this.defaultMaxPerDomain})`,
    );

    // Startup stagger: delay queue processing to prevent thundering herd after pod restart
    setTimeout(() => {
      this.started = true;
      this.logger.log('Startup stagger complete — queue processing enabled');

      // Start LISTEN/NOTIFY subscription
      void this.setupPgListener();

      // Fallback polling interval
      this.processTimer = setInterval(() => {
        void this.processQueue();
      }, this.processIntervalMs);

      // Initial processing after stagger
      void this.processQueue();
    }, this.startupStaggerMs);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.processTimer) {
      clearInterval(this.processTimer);
      this.processTimer = null;
    }
    if (this.pgListenerConnection) {
      try {
        await this.pgListenerConnection.query('UNLISTEN login_queue_ready');
        await this.pgListenerConnection.release();
      } catch {
        // Best-effort cleanup
      }
      this.pgListenerConnection = null;
    }
  }

  /**
   * Register the login trigger callback.
   * Called by the Controller/reconcile integration to provide
   * the function that actually starts a worker login.
   */
  registerLoginTrigger(trigger: LoginTriggerFn): void {
    this.loginTrigger = trigger;
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  /**
   * Enqueue a login request for coordinated processing.
   *
   * The entry will be processed when rate limits allow, in FIFO order
   * within the target domain.
   */
  async enqueue(params: {
    authRequestId: string;
    tenantId: string;
    appId: string;
    targetDomain: string;
    priority?: number;
  }): Promise<EnqueueResult> {
    const { authRequestId, tenantId, appId, targetDomain, priority = 0 } = params;

    // Normalize domain to root (strip subdomains like "login.", "auth.", "sso.")
    const normalizedDomain = this.normalizeDomain(targetDomain);

    try {
      const entry = this.queueRepo.create({
        auth_request_id: authRequestId,
        tenant_id: tenantId,
        app_id: appId,
        target_domain: normalizedDomain,
        priority,
        state: 'QUEUED',
      });
      const saved = await this.queueRepo.save(entry);

      this.logger.log(
        `Login enqueued: id=${saved.id} domain=${normalizedDomain} ` +
        `tenant=${tenantId} app=${appId} auth_request=${authRequestId}`,
      );

      return { enqueued: true, queueEntry: saved };
    } catch (err) {
      this.logger.error(`Failed to enqueue login: ${(err as Error).message}`);
      return { enqueued: false, reason: (err as Error).message };
    }
  }

  /**
   * Mark a queue entry as completed.
   */
  async complete(queueEntryId: string): Promise<void> {
    await this.queueRepo.update(queueEntryId, {
      state: 'DONE',
      completed_at: new Date(),
    });
    this.logger.log(`Queue entry completed: ${queueEntryId}`);
  }

  /**
   * Mark a queue entry as failed.
   */
  async fail(queueEntryId: string, reason: string): Promise<void> {
    await this.queueRepo.update(queueEntryId, {
      state: 'FAILED',
      completed_at: new Date(),
      failure_reason: reason,
    });
    this.logger.warn(`Queue entry failed: ${queueEntryId} reason=${reason}`);
  }

  /**
   * Get current queue depth (QUEUED entries).
   */
  async getQueueDepth(): Promise<number> {
    return this.queueRepo.count({ where: { state: 'QUEUED' } });
  }

  /**
   * Get count of currently RUNNING logins.
   */
  async getRunningCount(): Promise<number> {
    return this.queueRepo.count({ where: { state: 'RUNNING' } });
  }

  /**
   * Get count of currently RUNNING logins for a specific domain.
   */
  async getRunningCountByDomain(targetDomain: string): Promise<number> {
    const normalized = this.normalizeDomain(targetDomain);
    return this.queueRepo.count({
      where: { state: 'RUNNING', target_domain: normalized },
    });
  }

  // ---------------------------------------------------------------
  // Queue Processing (ADR-015 core logic)
  // ---------------------------------------------------------------

  /**
   * Process the queue: dequeue eligible entries respecting all rate limits.
   *
   * Called on:
   *   1. PG NOTIFY event (immediate, ~0ms latency per RT-12)
   *   2. Fallback polling interval (catches missed notifications)
   */
  async processQueue(): Promise<number> {
    if (!this.started) {
      return 0;
    }

    if (this.processing) {
      return 0;
    }

    this.processing = true;
    let dequeued = 0;

    try {
      // Get current system-wide RUNNING count
      const globalRunning = await this.queueRepo.count({
        where: { state: 'RUNNING' },
      });

      if (globalRunning >= this.globalMaxConcurrent) {
        this.logger.debug(
          `Global limit reached (${globalRunning}/${this.globalMaxConcurrent}) — skipping`,
        );
        return 0;
      }

      // Get QUEUED entries ordered by priority (desc) then requested_at (asc) = FIFO
      const candidates = await this.queueRepo
        .createQueryBuilder('q')
        .where('q.state = :state', { state: 'QUEUED' })
        .orderBy('q.priority', 'DESC')
        .addOrderBy('q.requested_at', 'ASC')
        .getMany();

      if (candidates.length === 0) {
        return 0;
      }

      // Track running counts per domain for this processing pass
      const domainRunning = new Map<string, number>();

      // Pre-load current RUNNING counts per domain
      const runningByDomain: { target_domain: string; count: string }[] =
        await this.queueRepo
          .createQueryBuilder('q')
          .select('q.target_domain', 'target_domain')
          .addSelect('COUNT(*)', 'count')
          .where('q.state = :state', { state: 'RUNNING' })
          .groupBy('q.target_domain')
          .getRawMany();

      for (const row of runningByDomain) {
        domainRunning.set(row.target_domain, parseInt(row.count, 10));
      }

      let currentGlobalRunning = globalRunning;

      for (const candidate of candidates) {
        // LIMIT 1: Check system-wide cap
        if (currentGlobalRunning >= this.globalMaxConcurrent) {
          break;
        }

        // LIMIT 2: Check per-domain cap
        const domainCount = domainRunning.get(candidate.target_domain) || 0;
        if (domainCount >= this.defaultMaxPerDomain) {
          continue; // Skip this domain, try next candidate
        }

        // All limits pass — transition to RUNNING
        const now = new Date();
        await this.queueRepo.update(candidate.id, {
          state: 'RUNNING',
          started_at: now,
        });

        currentGlobalRunning++;
        domainRunning.set(
          candidate.target_domain,
          domainCount + 1,
        );
        dequeued++;

        this.logger.log(
          `Login dequeued: id=${candidate.id} domain=${candidate.target_domain} ` +
          `(global=${currentGlobalRunning}/${this.globalMaxConcurrent}, ` +
          `domain=${domainCount + 1}/${this.defaultMaxPerDomain})`,
        );

        // Trigger the actual login if a callback is registered
        if (this.loginTrigger) {
          // Re-read the entry with updated state
          const updated = await this.queueRepo.findOne({ where: { id: candidate.id } });
          if (updated) {
            void this.loginTrigger(updated).catch((err) => {
              this.logger.error(
                `Login trigger failed for queue entry ${candidate.id}: ${(err as Error).message}`,
              );
              void this.fail(candidate.id, (err as Error).message);
            });
          }
        }
      }

      if (dequeued > 0) {
        this.logger.log(`Queue processed: ${dequeued} entries dequeued`);
      }
    } catch (err) {
      this.logger.error(`Queue processing error: ${(err as Error).message}`);
    } finally {
      this.processing = false;
    }

    return dequeued;
  }

  /**
   * Sweep stale RUNNING entries that have been stuck for too long.
   * Called alongside LoginSerializationService.sweepStaleRequests().
   */
  async sweepStaleEntries(staleThresholdMs: number = DEFAULTS.AUTH_REQUEST_STALE_MS): Promise<number> {
    const cutoff = new Date(Date.now() - staleThresholdMs);

    const staleEntries = await this.queueRepo
      .createQueryBuilder('q')
      .where('q.state = :state', { state: 'RUNNING' })
      .andWhere('q.started_at < :cutoff', { cutoff })
      .getMany();

    if (staleEntries.length === 0) {
      return 0;
    }

    for (const entry of staleEntries) {
      await this.queueRepo.update(entry.id, {
        state: 'FAILED',
        completed_at: new Date(),
        failure_reason: `Stale: RUNNING for >${staleThresholdMs}ms`,
      });

      this.logger.warn(
        `Expired stale queue entry: id=${entry.id} domain=${entry.target_domain} ` +
        `age=${Date.now() - entry.started_at!.getTime()}ms`,
      );
    }

    return staleEntries.length;
  }

  // ---------------------------------------------------------------
  // PG LISTEN/NOTIFY (ADR-015 RT-12 amendment)
  // ---------------------------------------------------------------

  private async setupPgListener(): Promise<void> {
    try {
      // Get a raw PG connection from the pool for LISTEN
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      this.pgListenerConnection = queryRunner;

      await queryRunner.query('LISTEN login_queue_ready');

      // Access the underlying pg driver connection for notification events.
      // TypeORM doesn't expose a typed API for LISTEN/NOTIFY — use the
      // underlying driver connection which is a pg.Client instance.
      const pgConnection = (queryRunner as any).databaseConnection;
      if (pgConnection && typeof pgConnection.on === 'function') {
        pgConnection.on('notification', (msg: { channel: string; payload?: string }) => {
          if (msg.channel === 'login_queue_ready') {
            this.logger.debug(`PG NOTIFY received: ${msg.payload}`);
            void this.processQueue();
          }
        });
      }

      this.logger.log('PG LISTEN/NOTIFY subscription active on login_queue_ready');
    } catch (err) {
      this.logger.error(
        `Failed to set up PG LISTEN/NOTIFY (falling back to polling): ${(err as Error).message}`,
      );
    }
  }

  // ---------------------------------------------------------------
  // Domain normalization
  // ---------------------------------------------------------------

  /**
   * Normalize a URL or hostname to its root domain.
   * Strips common auth-related subdomains: login., auth., sso., accounts., id.
   * Handles full URLs and bare hostnames.
   *
   * Examples:
   *   "https://login.salesforce.com/path" → "salesforce.com"
   *   "auth.example.com"                 → "example.com"
   *   "my-app.internal.corp.net"         → "my-app.internal.corp.net"
   */
  normalizeDomain(input: string): string {
    let hostname = input;

    // Extract hostname from URL if needed
    try {
      if (input.includes('://')) {
        hostname = new URL(input).hostname;
      }
    } catch {
      // Not a valid URL, treat as hostname
    }

    hostname = hostname.toLowerCase().replace(/\.$/, '');

    // Strip well-known auth subdomains
    const authPrefixes = ['login.', 'auth.', 'sso.', 'accounts.', 'id.', 'signin.'];
    for (const prefix of authPrefixes) {
      if (hostname.startsWith(prefix)) {
        const stripped = hostname.slice(prefix.length);
        // Only strip if what remains has at least one dot (is a valid domain)
        if (stripped.includes('.')) {
          hostname = stripped;
          break; // Only strip one level
        }
      }
    }

    return hostname;
  }
}
