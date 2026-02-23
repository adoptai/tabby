import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PORTS } from '@browser-hitl/shared';
import { VncWsProxyService } from './modules/streaming/vnc-ws-proxy.service';
import { PermissiveWsAdapter } from './common/adapters/permissive-ws.adapter';
import { JsonLoggerService } from './common/logger/json-logger.service';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLoggerService(),
  });

  // OpenAPI / Swagger documentation (H9 remediation)
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('Browser HITL API')
      .setDescription('Human-in-the-Loop browser session management API')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // Security headers (H2 remediation)
  app.use(helmet({
    contentSecurityPolicy: false, // Disabled — noVNC viewer needs inline scripts
    hsts: process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));

  // CORS (M1 remediation)
  app.enableCors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  // Trust proxy for correct client IP behind load balancer (M5 remediation)
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  app.useWebSocketAdapter(new PermissiveWsAdapter(app));
  app.get(VncWsProxyService);

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

  await app.listen(PORTS.API);
  console.log(`API service listening on port ${PORTS.API}`);
}

bootstrap();
