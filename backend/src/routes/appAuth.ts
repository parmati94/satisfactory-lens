import { Router } from 'express';
import { config } from '../config';
import { createSessionToken, setSessionCookie, clearSessionCookie, getSessionUser, getSessionRole, Role } from '../auth';
import { loginRateLimit, clearLoginAttempts } from '../loginRateLimit';

const router = Router();

router.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  // Username must match; the password then decides the role — the admin PASSWORD
  // grants full access, the optional VIEWER_PASSWORD grants a read-only session.
  let role: Role | null = null;
  if (username === config.username && password) {
    if (password === config.password) role = 'admin';
    else if (config.viewerPassword && password === config.viewerPassword) role = 'viewer';
  }
  if (!role) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  clearLoginAttempts(req);
  const token = createSessionToken(username!, role);
  setSessionCookie(res, token);
  res.json({ ok: true, role });
});

router.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/auth/status', (req, res) => {
  const user = getSessionUser(req);
  res.json({
    loginEnabled: config.enableLogin,
    authenticated: !config.enableLogin || user !== null,
    // 'admin' when login is off; the session's role when on; null if unauthenticated.
    role: getSessionRole(req),
    // Whether read-only sharing is configured — lets the UI hint that a viewer
    // password exists (it never exposes the value).
    viewerEnabled: !!config.viewerPassword,
  });
});

export { router as appAuthRouter };
