import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SessionEntity } from '../../entities';
import { TenantsModule } from '../tenants/tenants.module';
import { RecordingStore } from './recording.store';
import { RecordingController } from './recording.controller';

/**
 * VNC recording: persist/retrieve drained bundles and drain them from worker
 * pods. The stream-token-authed stop + token-refresh endpoints live in the
 * StreamingController (they are VNC endpoints); it injects RecordingStore,
 * which is why StreamingModule imports this module.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SessionEntity]), TenantsModule],
  providers: [RecordingStore],
  controllers: [RecordingController],
  exports: [RecordingStore],
})
export class RecordingModule {}
