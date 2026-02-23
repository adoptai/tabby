import { Global, Module } from '@nestjs/common';
import { RedisHealthMonitor } from './redis-health-monitor';

@Global()
@Module({
  providers: [RedisHealthMonitor],
  exports: [RedisHealthMonitor],
})
export class RedisModule {}
