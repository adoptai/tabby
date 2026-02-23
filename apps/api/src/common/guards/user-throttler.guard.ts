import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (req?.user?.user_id) {
      return `user:${req.user.user_id}`;
    }

    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return `ip:${xff.split(',')[0].trim()}`;
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return `ip:${xff[0]}`;
    }

    return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
  }

  protected getRequestResponse(context: ExecutionContext): {
    req: Record<string, any>;
    res: Record<string, any>;
  } {
    const http = context.switchToHttp();
    return {
      req: http.getRequest(),
      res: http.getResponse(),
    };
  }
}
