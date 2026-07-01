import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const id = req.headers['x-request-id'] as string || randomUUID();
    (req as any).correlationId = id;
    _res.setHeader('X-Request-ID', id);
    next();
  }
}
