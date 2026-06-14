import { Router } from 'express';
import { config } from '../config';
import * as sf from '../api/sfClient';

const router = Router();

// GET /api/sf/status — connection info (host, port, connected)
router.get('/api/sf/status', (_req, res) => {
  res.json(sf.getConnectionInfo());
});

// POST /api/sf/connect — connect (host/port/password from body, falls back to env)
router.post('/api/sf/connect', async (req, res) => {
  const { host, port, password } = req.body as {
    host?: string;
    port?: number;
    password?: string;
  };
  try {
    await sf.connectTo(
      host || config.sfHost,
      port || config.sfPort,
      password ?? config.sfPassword,
    );
    res.json({ ok: true, ...sf.getConnectionInfo() });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// POST /api/sf/disconnect — clear token
router.post('/api/sf/disconnect', (_req, res) => {
  sf.disconnect();
  res.json({ ok: true });
});

export { router as sfConnectRouter };
