import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { ApplicationEntity } from './application.entity';
import { SessionEntity } from './session.entity';

@Entity('browser_state_snapshots')
export class BrowserStateSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  app_id: string;

  @ManyToOne(() => ApplicationEntity)
  @JoinColumn({ name: 'app_id' })
  application: ApplicationEntity;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @Column({ type: 'varchar', nullable: true })
  owner_user_id: string | null;

  @Column({ type: 'varchar' })
  encrypted_payload_ref: string;

  @Column({ type: 'enum', enum: ['minio'], default: 'minio' })
  storage_backend: string;

  @Column({ type: 'bytea' })
  nonce: Buffer;

  @Column({ type: 'varchar' })
  key_version: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  saved_at: Date;

  @Column({ type: 'timestamptz' })
  expires_at: Date;

  @Column({ type: 'uuid', nullable: true })
  source_session_id: string | null;

  @ManyToOne(() => SessionEntity, { nullable: true })
  @JoinColumn({ name: 'source_session_id' })
  source_session: SessionEntity | null;

  @Column({ type: 'varchar', nullable: true })
  health_result: string | null;
}
