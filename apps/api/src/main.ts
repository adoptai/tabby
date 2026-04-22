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

  // OpenAPI / Swagger docs at /api/docs. Toggle via API_DOCS_ENABLED (default: enabled).
  if (process.env.API_DOCS_ENABLED !== 'false') {
    const config = new DocumentBuilder()
      .setTitle('Browser HITL API')
      .setDescription(
        'Human-in-the-Loop browser session management API.\n\n' +
        'Tabby manages Playwright/Chromium browser sessions that execute Login DSL scripts. ' +
        'When automation encounters OTP, CAPTCHA, or MFA challenges, human operators intervene via Slack or VNC. ' +
        'Extracted credentials (cookies, headers, CSRF tokens, localStorage) are encrypted and served to downstream agents.\n\n' +
        '## Authentication\n' +
        '- **Human users**: `POST /login` with email/password → JWT token\n' +
        '- **Service bots**: `POST /auth/service-token` with client_id/secret → JWT token\n' +
        '- **AI agents**: `POST /auth/agent-token` with OAuth 2.0 Client Credentials → scoped JWT token\n\n' +
        '## Key Flows\n' +
        '1. Create an App with login config and health checks\n' +
        '2. Scale sessions to spin up worker pods\n' +
        '3. Workers execute login DSL and extract credentials\n' +
        '4. Retrieve credentials via `POST /credentials/request`\n',
      )
      .setVersion(process.env.CHART_VERSION || '0.1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT token from /login, /auth/service-token, or /auth/agent-token' },
        'bearer',
      )
      .addTag('Authentication', 'Login, service tokens, agent tokens, and client management')
      .addTag('Sessions', 'Session lifecycle, scaling, and intervention history')
      .addTag('HITL', 'Human-in-the-loop: VNC streaming, baton takeover/release, OTP submission')
      .addTag('Applications', 'Application CRUD — defines target URLs, login DSL, health checks, and export policy')
      .addTag('Credentials', 'Retrieve extracted credentials (cookies, headers, CSRF, storage)')
      .addTag('Profiles', 'Service profile versioning: staging → canary → active → retired')
      .addTag('Artifacts', 'Encrypted artifact bundle access and download')
      .addTag('Tenants', 'Multi-tenant management')
      .addTag('Users', 'User account management')
      .addTag('Agent', 'High-level agent endpoint for one-shot URL login')
      .addTag('Health', 'Liveness and readiness probes')
      .addTag('Metrics', 'Prometheus-compatible metrics endpoint')
      .addTag('Streaming', 'VNC viewer and noVNC asset serving')
      .addTag('Streaming - CDP', 'Chrome DevTools Protocol streaming viewer')
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
