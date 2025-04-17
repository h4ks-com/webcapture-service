import { Request, Response, NextFunction } from 'express';

const AUTH_TOKEN = process.env.AUTH_TOKEN || null;

export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next();

  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || token !== AUTH_TOKEN) {
    return res.status(403).json({ error: 'Invalid or missing token' });
  }
  next();
}
