import { Module } from '@nestjs/common';
import { NatsAclService } from './nats-acl.service';

@Module({
  providers: [NatsAclService],
  exports: [NatsAclService],
})
export class NatsAclModule {}
