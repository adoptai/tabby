import {
  Entity, Column, PrimaryColumn, ManyToOne, JoinColumn, UpdateDateColumn,
} from 'typeorm';
import { SessionEntity } from './session.entity';
import { UserEntity } from './user.entity';

@Entity('session_batons')
export class SessionBatonEntity {
  @PrimaryColumn({ type: 'uuid' })
  session_id: string;

  @ManyToOne(() => SessionEntity)
  @JoinColumn({ name: 'session_id' })
  session: SessionEntity;

  @Column({
    type: 'enum',
    enum: ['AUTOMATION_CONTROL', 'HUMAN_REQUESTED', 'HUMAN_CONTROL', 'HUMAN_RELEASED'],
    default: 'AUTOMATION_CONTROL',
  })
  baton_state: string;

  @Column({ type: 'uuid', nullable: true })
  owner_user_id: string | null;

  @ManyToOne(() => UserEntity, { nullable: true })
  @JoinColumn({ name: 'owner_user_id' })
  owner: UserEntity;

  @Column({ type: 'timestamptz', nullable: true })
  requested_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  acquired_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  expires_at: Date | null;

  @Column({ type: 'bigint', default: 0 })
  version: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at: Date;
}
