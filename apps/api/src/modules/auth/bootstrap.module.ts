import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantEntity, UserEntity } from '../../entities';
import { BootstrapService } from './bootstrap.service';
import { AuthModule } from './auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TenantEntity, UserEntity]),
    AuthModule,
  ],
  providers: [BootstrapService],
})
export class BootstrapModule {}
