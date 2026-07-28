import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity, ApplicationEntity } from '../../entities';
import { AppsModule } from '../apps/apps.module';
import { SessionsModule } from '../sessions/sessions.module';
import { StreamingModule } from '../streaming/streaming.module';
import { RecordingModule } from './recording.module';
import { RecordingProvisionController } from './recording-provision.controller';
import { RecordingPoolService } from './recording-pool.service';

/**
 * Recording-session provisioning ("agent generates a URL"). Separate from
 * RecordingModule to keep imports one-directional: StreamingModule imports
 * RecordingModule (for RecordingStore), and this module imports StreamingModule
 * (for VncStreamProvider) — no cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SessionEntity, ApplicationEntity]),
    AppsModule,
    SessionsModule,
    StreamingModule,
    RecordingModule,
  ],
  controllers: [RecordingProvisionController],
  providers: [RecordingPoolService],
})
export class RecordingProvisionModule {}
