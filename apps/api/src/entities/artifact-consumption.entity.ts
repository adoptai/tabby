import {
  Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn,
} from 'typeorm';
import { ArtifactBundleEntity } from './artifact-bundle.entity';

@Entity('artifact_consumptions')
export class ArtifactConsumptionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  artifact_id: string;

  @ManyToOne(() => ArtifactBundleEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artifact_id' })
  artifact: ArtifactBundleEntity;

  @Column({ type: 'varchar' })
  consumer_id: string;

  @Column({ type: 'varchar' })
  token_id: string;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  consumed_at: Date;

  @Column({ type: 'enum', enum: ['presigned_url', 'nats', 'api_envelope'] })
  access_method: string;
}
