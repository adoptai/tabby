import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn,
} from 'typeorm';

@Entity('audit_anchors')
export class AuditAnchorEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'date', unique: true })
  anchor_date: string;

  @Column({ type: 'varchar', length: 64 })
  root_hash: string;

  @Column({ type: 'integer' })
  event_count: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
