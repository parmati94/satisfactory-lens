import { Request, Response, NextFunction } from 'express';

// Minimal in-memory fixed-window rate limiter for the login route. The app runs
// as a single backend process, so an in-memory map is sufficient and reliable —
// and being dependency-free keeps the `tsx watch` dev loop hot-reloading with no
// rebuild. Purpose: stop a publicly-exposed login form from being brute-forced.
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 10;          // per window, per client IP

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

function keyFor(req: Request): string {
  // req.ip honours `trust proxy` (set in index.ts); falls back for safety. Behind
  // a single proxy this is the real client; if it can't be resolved, all callers
  // share one bucket, which still caps total attempts — fine for a self-host.
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = keyFor(req);
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > MAX_ATTEMPTS) {
    const retrySec = Math.ceil((b.resetAt - now) / 1000);
    res.set('Retry-After', String(retrySec));
    res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(retrySec / 60)} min.` });
    return;
  }
  next();
}

// Reset a client's bucket after a successful login so a legitimate user is never
// locked out by their own earlier typos.
export function clearLoginAttempts(req: Request): void {
  buckets.delete(keyFor(req));
}

// Opportunistic prune so the map can't grow unbounded over long uptimes.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}, WINDOW_MS).unref();
