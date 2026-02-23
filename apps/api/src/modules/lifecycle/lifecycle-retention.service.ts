import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  ApplicationEntity,
  ArtifactBundleEntity,
  ArtifactConsumptionEntity,
  InterventionEntity,
  SessionBatonEntity,
  SessionEntity,
} from '../../entities';

@Injectable()
export class LifecycleRetentionService {
  private readonly logger = new Logger(LifecycleRetentionService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(SessionBatonEntity)
    private readonly batonRepo: Repository<SessionBatonEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    @InjectRepository(ArtifactBundleEntity)
    private readonly artifactRepo: Repository<ArtifactBundleEntity>,
    @InjectRepository(ArtifactConsumptionEntity)
    private readonly consumptionRepo: Repository<ArtifactConsumptionEntity>,
    private readonly dataSource: DataSource,
  ) {}

  @Cron('15 3 * * *')
  async handleLifecycleRetention(): Promise<void> {
    try {
      const summary = await this.cleanupExpiredLifecycleData();
      this.logger.log(`Lifecycle retention cleanup completed: ${JSON.stringify(summary)}`);
    } catch (error) {
      this.logger.error(
        'Failed to run lifecycle retention cleanup',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async cleanupExpiredLifecycleData(): Promise<{
    consumptionsDeleted: number;
    artifactsDeleted: number;
    interventionsDeleted: number;
    batonsDeleted: number;
    sessionsDeleted: number;
    appsDeleted: number;
  }> {
    const artifactCutoff = this.computeCutoffDate(this.getRetentionDays('LIFECYCLE_ARTIFACT_RETENTION_DAYS', 7));
    const interventionCutoff = this.computeCutoffDate(this.getRetentionDays('LIFECYCLE_INTERVENTION_RETENTION_DAYS', 30));
    const sessionCutoff = this.computeCutoffDate(this.getRetentionDays('LIFECYCLE_SESSION_RETENTION_DAYS', 14));
    const appCutoff = this.computeCutoffDate(this.getRetentionDays('LIFECYCLE_APP_RETENTION_DAYS', 30));

    return this.dataSource.transaction(async (manager) => {
      const consumptionsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(ArtifactConsumptionEntity)
          .where(
            `artifact_id IN (SELECT ab.id FROM artifact_bundles ab WHERE ab.expires_at < :artifactCutoff)`,
            { artifactCutoff },
          )
          .execute()
      ).affected || 0;

      const artifactsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(ArtifactBundleEntity)
          .where('expires_at < :artifactCutoff', { artifactCutoff })
          .execute()
      ).affected || 0;

      const interventionsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(InterventionEntity)
          .where('completed_at IS NOT NULL')
          .andWhere('completed_at < :interventionCutoff', { interventionCutoff })
          .andWhere(
            `session_id IN (
              SELECT s.id
              FROM sessions s
              WHERE s.state = :terminatedState
            )`,
            { terminatedState: 'TERMINATED' },
          )
          .execute()
      ).affected || 0;

      const eligibleSessionSubquery = `
        SELECT s.id
        FROM sessions s
        WHERE s.state = :terminatedState
          AND s.started_at < :sessionCutoff
          AND NOT EXISTS (SELECT 1 FROM interventions i WHERE i.session_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM artifact_bundles ab WHERE ab.session_id = s.id)
      `;

      const batonsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(SessionBatonEntity)
          .where(`session_id IN (${eligibleSessionSubquery})`, {
            terminatedState: 'TERMINATED',
            sessionCutoff,
          })
          .execute()
      ).affected || 0;

      const sessionsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(SessionEntity)
          .where(`id IN (${eligibleSessionSubquery})`, {
            terminatedState: 'TERMINATED',
            sessionCutoff,
          })
          .execute()
      ).affected || 0;

      const appsDeleted = (
        await manager
          .createQueryBuilder()
          .delete()
          .from(ApplicationEntity)
          .where('desired_session_count = 0')
          .andWhere('updated_at < :appCutoff', { appCutoff })
          .andWhere(
            `id IN (
              SELECT a.id
              FROM applications a
              WHERE NOT EXISTS (
                SELECT 1
                FROM sessions s
                WHERE s.app_id = a.id
              )
            )`,
          )
          .execute()
      ).affected || 0;

      return {
        consumptionsDeleted,
        artifactsDeleted,
        interventionsDeleted,
        batonsDeleted,
        sessionsDeleted,
        appsDeleted,
      };
    });
  }

  private getRetentionDays(envName: string, fallbackDays: number): number {
    const raw = (process.env[envName] || '').trim();
    if (!raw) {
      return fallbackDays;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallbackDays;
    }
    return parsed;
  }

  private computeCutoffDate(days: number): Date {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);
    return cutoff;
  }
}

