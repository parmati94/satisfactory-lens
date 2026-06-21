import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config';

const COOKIE_NAME = 'sf_lens_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type Role = 'admin' | 'viewer';

interface SessionPayload { username: string; role?: Role; }

export function createSessionToken(username: string, role: Role): string {
  return jwt.sign({ username, role }, config.sessionSecret, { expiresIn: '7d' });
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

function verifySession(req: Request): SessionPayload | null {
  const token: string | undefined = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, config.sessionSecret) as SessionPayload;
  } catch {
    return null;
  }
}

export function getSessionUser(req: Request): string | null {
  return verifySession(req)?.username ?? null;
}

// Effective role for the request:
//  - login disabled → 'admin' (single-user local/dev keeps full access)
//  - valid token → its role, defaulting to 'admin' for tokens minted before roles
//    existed (back then every authenticated user was effectively the owner)
//  - no/invalid token → null
export function getSessionRole(req: Request): Role | null {
  if (!config.enableLogin) return 'admin';
  const session = verifySession(req);
  if (!session) return null;
  return session.role ?? 'admin';
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.enableLogin) { next(); return; }
  const user = getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
  next();
}

// Gate for the write surface. Runs after requireAuth (so the request is already
// authenticated when login is on); rejects anyone who isn't an admin. This is the
// real read-only boundary — the frontend only hides buttons.
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (getSessionRole(req) === 'admin') { next(); return; }
  res.status(403).json({ error: 'Read-only access — admin required for this action.' });
}
