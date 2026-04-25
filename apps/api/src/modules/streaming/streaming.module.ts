import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StreamTokenService } from './stream-token.service';
import { VncStreamProvider } from './vnc-stream.provider';
import { CdpStreamProvider } from './cdp-stream.provider';
import { CdpWsProxyService } from './cdp-ws-proxy.service';
import { StreamProviderFactory } from './stream-provider.factory';
import { SessionEntity, ApplicationEntity, InterventionEntity } from '../../entities';
import { StreamingController, CdpStreamingController } from './streaming.controller';
import { VncWsProxyService } from './vnc-ws-proxy.service';
import { resolveJwtSigningKey } from '../auth/jwt-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([SessionEntity, ApplicationEntity, InterventionEntity]),
    JwtModule.register({
      secret: resolveJwtSigningKey(),
      signOptions: { expiresIn: '10m' },
    }),
  ],
  controllers: [StreamingController, CdpStreamingController],
  providers: [
    StreamTokenService,
    VncStreamProvider,
    CdpStreamProvider,
    VncWsProxyService,
    CdpWsProxyService,
    StreamProviderFactory,
  ],
  exports: [StreamTokenService, VncStreamProvider, CdpStreamProvider, StreamProviderFactory],
})
export class StreamingModule {}
