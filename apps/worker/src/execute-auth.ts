import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';

const signingKey = (process.env.JWT_SIGNING_KEY || '').trim();

export function executeAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!signingKey) {
    res.status(500).json({ error: 'Worker JWT_SIGNING_KEY not configured' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    jwt.verify(token, signingKey, { algorithms: ['HS256'] });
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
