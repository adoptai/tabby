import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { SessionEntity } from './session.entity';
import { ApplicationEntity } from './application.entity';
import { TenantEntity } from './tenant.entity';

@Entity('artifact_bundles')
export class ArtifactBundleEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  session_id: string;

  @ManyToOne(() => SessionEntity)
  @JoinColumn({ name: 'session_id' })
  session: SessionEntity;

  @Column({ type: 'uuid' })
  app_id: string;

  @ManyToOne(() => ApplicationEntity)
  @JoinColumn({ name: 'app_id' })
  application: ApplicationEntity;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'varchar' })
  encrypted_payload_ref: string;

  @Column({ type: 'enum', enum: ['minio'], default: 'minio' })
  storage_backend: string;

  @Column({ type: 'bytea' })
  nonce: Buffer;

  @Column({ type: 'varchar' })
  key_version: string;

  @Column({ type: 'timestamptz' })
  exported_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;
}
