import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

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

    response.status(status).json({
      error: { code, message, ...(details ? { details } : {}) },
    });
  }
}
