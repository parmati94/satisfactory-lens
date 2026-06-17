import { Router } from 'express';
import { config } from '../config';
import { createSessionToken, setSessionCookie, clearSessionCookie, getSessionUser } from '../auth';
import { loginRateLimit, clearLoginAttempts } from '../loginRateLimit';

const router = Router();

router.post('/api/auth/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password || username !== config.username || password !== config.password) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  clearLoginAttempts(req);
  const token = createSessionToken(username);
  setSessionCookie(res, token);
  res.json({ ok: true });
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
  });
});

export { router as appAuthRouter };
