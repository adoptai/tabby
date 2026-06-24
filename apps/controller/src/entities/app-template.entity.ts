import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('app_templates')
export class AppTemplateEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'integer', nullable: true })
  idle_shutdown_seconds: number | null;
}
