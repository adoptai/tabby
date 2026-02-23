import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ControllerModule } from './controller.module';
import { PORTS } from '@browser-hitl/shared';

async function bootstrap() {
  const app = await NestFactory.create(ControllerModule);
  app.enableShutdownHooks();

  // Graceful shutdown with timeout (M2 remediation)
  const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '10000', 10);
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, starting graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)...`);
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      await app.close();
      console.log('Graceful shutdown completed');
    } catch (error) {
      console.error(`Shutdown error: ${error}`);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(PORTS.CONTROLLER_HEALTH);
  console.log(`Session controller listening on port ${PORTS.CONTROLLER_HEALTH}`);
}

bootstrap();
