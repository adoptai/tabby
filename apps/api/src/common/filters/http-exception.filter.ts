import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response, Request } from 'express';
import * as Sentry from '@sentry/node';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;
        message = (obj.message as string) || exception.message;
        if (Array.isArray(obj.message)) {
          message = obj.message[0];
          details = { validation_errors: obj.message };
        }
      } else {
        message = String(body);
      }

      switch (status) {
        case 400: code = 'VALIDATION_ERROR'; break;
        case 401: code = 'UNAUTHORIZED'; break;
        case 403: code = 'FORBIDDEN'; break;
        case 404: code = 'NOT_FOUND'; break;
        case 409: code = 'CONFLICT'; break;
        case 429: code = 'RATE_LIMITED'; break;
        default: code = 'INTERNAL_ERROR';
      }
    }

    // Send 5xx errors to Sentry for alerting
    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.url', request.url);
        scope.setTag('http.status_code', String(status));
        scope.setExtra('body', request.body);
        Sentry.captureException(exception instanceof Error ? exception : new Error(message));
      });
      this.logger.error(`${request.method} ${request.url} → ${status}: ${message}`, exception instanceof Error ? exception.stack : undefined);
    }

    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
    });
  }
}
