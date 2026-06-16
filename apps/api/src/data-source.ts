import { DataSource, DataSourceOptions } from 'typeorm';
import { requireEnv } from '@browser-hitl/shared';
import * as entities from './entities';
import { InitialSchema1708300000000 } from './migrations/1708300000000-InitialSchema';
import { WorkerRLS1708300000001 } from './migrations/1708300000001-WorkerRLS';
import { AgentClients1708300000002 } from './migrations/1708300000002-AgentClients';
import { AuthRequests1708300000003 } from './migrations/1708300000003-AuthRequests';
import { LoginQueue1708300000004 } from './migrations/1708300000004-LoginQueue';
import { AccountLockout1708300000005 } from './migrations/1708300000005-AccountLockout';
import { ArtifactCascadeDelete1708300000006 } from './migrations/1708300000006-ArtifactCascadeDelete';
import { ServiceProfiles1708300000007 } from './migrations/1708300000007-ServiceProfiles';
import { ProfileAppLink1708300000008 } from './migrations/1708300000008-ProfileAppLink';
import { GenericHumanInput1708300000009 } from './migrations/1708300000009-GenericHumanInput';
import { AddIdentityProviders1708300000010 } from './migrations/1708300000010-AddIdentityProviders';
import { AddOwnerUserIds1708300000011 } from './migrations/1708300000011-AddOwnerUserIds';
import { AddAppTemplates1708300000012 } from './migrations/1708300000012-AddAppTemplates';
import { AddIdleShutdown1708300000013 } from './migrations/1708300000013-AddIdleShutdown';
import { AddAppOwnerUserId1708300000014 } from './migrations/1708300000014-AddAppOwnerUserId';
import { MultiTenantCloud1708300000015 } from './migrations/1708300000015-MultiTenantCloud';
import { GenericOAuth1708300000016 } from './migrations/1708300000016-GenericOAuth';
import { NullablePasswordHash1708300000017 } from './migrations/1708300000017-NullablePasswordHash';
import { GlobalIdp1708300000018 } from './migrations/1708300000018-GlobalIdp';
import { AddRestartRequested1708300000019 } from './migrations/1708300000019-AddRestartRequested';
import { AddTemplateLineage1708300000020 } from './migrations/1708300000020-AddTemplateLineage';
import { DropIdpSecrets1708300000021 } from './migrations/1708300000021-DropIdpSecrets';
import { AddExecuteEnabled1708300000022 } from './migrations/1708300000022-AddExecuteEnabled';
import { ControllerScaling1708300000023 } from './migrations/1708300000023-ControllerScaling';
import { AddTemplateExecuteEnabled1708300000024 } from './migrations/1708300000024-AddTemplateExecuteEnabled';
import { UnrestrictedProfiles1708300000025 } from './migrations/1708300000025-UnrestrictedProfiles';
import { AddExtraEgressAllowlist1708300000026 } from './migrations/1708300000026-AddExtraEgressAllowlist';

const poolSize = Number(process.env.DB_POOL_SIZE) || 20;

export const dataSourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: requireEnv('DATABASE_URL', {
    testDefault: 'postgresql://postgres:postgres@localhost:5432/browser_hitl',
  }),
  entities: Object.values(entities),
  migrations: [InitialSchema1708300000000, WorkerRLS1708300000001, AgentClients1708300000002, AuthRequests1708300000003, LoginQueue1708300000004, AccountLockout1708300000005, ArtifactCascadeDelete1708300000006, ServiceProfiles1708300000007, ProfileAppLink1708300000008, GenericHumanInput1708300000009, AddIdentityProviders1708300000010, AddOwnerUserIds1708300000011, AddAppTemplates1708300000012, AddIdleShutdown1708300000013, AddAppOwnerUserId1708300000014, MultiTenantCloud1708300000015, GenericOAuth1708300000016, NullablePasswordHash1708300000017, GlobalIdp1708300000018, AddRestartRequested1708300000019, AddTemplateLineage1708300000020, DropIdpSecrets1708300000021, AddExecuteEnabled1708300000022, ControllerScaling1708300000023, AddTemplateExecuteEnabled1708300000024, UnrestrictedProfiles1708300000025, AddExtraEgressAllowlist1708300000026],
  migrationsRun: true,
  synchronize: false,
  logging: process.env.NODE_ENV === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  extra: { max: poolSize },
};

// Standalone DataSource for CLI usage
export const AppDataSource = new DataSource(dataSourceOptions);
