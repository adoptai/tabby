import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ApplicationEntity,
  ArtifactBundleEntity,
  ArtifactConsumptionEntity,
  BrowserStateSnapshotEntity,
  InterventionEntity,
  SessionBatonEntity,
  SessionEntity,
} from '../../entities';
import { LifecycleRetentionService } from './lifecycle-retention.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ApplicationEntity,
      SessionEntity,
      SessionBatonEntity,
      InterventionEntity,
      ArtifactBundleEntity,
      ArtifactConsumptionEntity,
      BrowserStateSnapshotEntity,
    ]),
  ],
  providers: [LifecycleRetentionService],
})
export class LifecycleModule {}

