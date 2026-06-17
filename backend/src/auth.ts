import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';

const COOKIE_NAME = 'sf_lens_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function createSessionToken(username: string): string {
  return jwt.sign({ username }, config.sessionSecret, { expiresIn: '7d' });
}

export function setSessionCookie(res: Response, token: string): void {
  // httpOnly (no JS access) + sameSite=strict (CSRF) are the protections that
  // matter here. The Secure flag is intentionally omitted: it would break login
  // over plain-HTTP local/self-host, and adds nothing when served over HTTPS+HSTS
  // at the edge (the cookie never traverses plaintext anyway).
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME);
}

export function getSessionUser(req: Request): string | null {
  const token: string | undefined = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.sessionSecret) as { username: string };
    return payload.username;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.enableLogin) { next(); return; }
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  next();
}
