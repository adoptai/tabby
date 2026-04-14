import {
  Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { UserEntity } from './user.entity';
import { TenantEntity } from './tenant.entity';

@Entity('user_identities')
export class UserIdentityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  user_id: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;

  @Column({ type: 'varchar' })
  tenant_id: string;

  @ManyToOne(() => TenantEntity)
  @JoinColumn({ name: 'tenant_id' })
  tenant: TenantEntity;

  @Column({ type: 'enum', enum: ['slack', 'teams', 'oidc', 'saml'] })
  provider: string;

  @Column({ type: 'varchar' })
  external_id: string;

  @Column({ type: 'varchar', nullable: true })
  workspace_id: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at: Date;
}
