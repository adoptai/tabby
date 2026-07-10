import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response, Request } from 'express';
import * as Sentry from '@sentry/node';

const STREAMING_PATH_RE = /^\/(vnc|cdp)\//;

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) return;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'object' && body !== null) {
        const obj = body as Record<string, unknown>;

        if ((exception as any).domainCode) {
          code = (exception as any).domainCode;
          message = (obj.message as string) || exception.message;
          if (obj.details) details = obj.details as Record<string, unknown>;
        } else if (Array.isArray(obj.message)) {
          code = 'VALIDATION_ERROR';
          message = obj.message[0];
          details = { validation_errors: obj.message };
        } else {
          message = (obj.message as string) || exception.message;
          const { message: _m, statusCode: _s, error: _e, ...rest } = obj;
          if (Object.keys(rest).length > 0) details = rest;
        }
      } else {
        message = String(body);
      }

      if (!(exception as any).domainCode) {
        switch (status) {
          case 400: code = 'VALIDATION_ERROR'; break;
          case 401: code = 'UNAUTHORIZED'; break;
          case 403: code = 'FORBIDDEN'; break;
          case 404: code = 'NOT_FOUND'; break;
          case 409: code = 'CONFLICT'; break;
          case 429: code = 'RATE_LIMITED'; break;
          case 502: code = 'BAD_GATEWAY'; break;
          case 504: code = 'GATEWAY_TIMEOUT'; break;
          default: if (status >= 500) code = 'INTERNAL_ERROR';
        }
      }
    }

    const correlationId: string | undefined = (request as any).correlationId;

    if (status >= 500) {
      Sentry.withScope((scope) => {
        scope.setTag('http.method', request.method);
        scope.setTag('http.url', request.url);
        scope.setTag('http.status_code', String(status));
        if (correlationId) scope.setTag('correlation_id', correlationId);
        const user = (request as any).user;
        if (user?.tenant_id) scope.setTag('tenant_id', user.tenant_id);
        Sentry.captureException(exception instanceof Error ? exception : new Error(message));
      });
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${message}` +
        (correlationId ? ` [${correlationId}]` : ''),
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    if (status >= 400 && STREAMING_PATH_RE.test(request.path)) {
      const accept = request.headers.accept || '';
      if (accept.includes('text/html') && !accept.includes('application/json')) {
        response.status(status).send(renderHtmlError(status, message));
        return;
      }
    }

    const body: Record<string, unknown> = {
      error: { code, message, ...(details ? { details } : {}) },
    };
    if (status >= 500 && correlationId) {
      body.request_id = correlationId;
    }

    response.status(status).json(body);
  }
}

function renderHtmlError(status: number, message: string): string {
  const safe = message.replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Error ${status}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}
.box{text-align:center;max-width:400px;padding:2rem}.code{font-size:3rem;font-weight:700;color:#f87171}.msg{margin-top:1rem;color:#94a3b8}</style>
</head><body><div class="box"><div class="code">${status}</div><div class="msg">${safe}</div></div></body></html>`;
}
