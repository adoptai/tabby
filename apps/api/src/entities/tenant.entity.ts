import {
  Entity, PrimaryColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany,
} from 'typeorm';

@Entity('tenants')
export class TenantEntity {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id: string;

  @Column({ type: 'varchar', unique: true })
  name: string;

  @Column({ type: 'integer', default: 10 })
  max_sessions: number;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
