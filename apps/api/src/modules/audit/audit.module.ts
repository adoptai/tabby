import { Module, Global } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEventEntity, AuditAnchorEntity, TenantEntity } from '../../entities';
import { AuditService } from './audit.service';
import { AuditAnchorService } from './audit-anchor.service';
import { AuditVerifierService } from './audit-verifier.service';
import { AuditRetentionService } from './audit-retention.service';

@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([AuditEventEntity, AuditAnchorEntity, TenantEntity]),
  ],
  providers: [
    AuditService,
    AuditAnchorService,
    AuditVerifierService,
    AuditRetentionService,
  ],
  exports: [
    AuditService,
    AuditAnchorService,
    AuditVerifierService,
    AuditRetentionService,
  ],
})
export class AuditModule {}
