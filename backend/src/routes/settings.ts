import { Router } from 'express';
import * as sf from '../api/sfClient';

const router = Router();

router.get('/api/settings/server', async (_req, res) => {
  try {
    res.json(await sf.getServerOptions());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.patch('/api/settings/server', async (req, res) => {
  try {
    res.json(await sf.setServerOptions(req.body as Record<string, string>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.get('/api/settings/advanced', async (_req, res) => {
  try {
    res.json(await sf.getAdvancedGameSettings());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.patch('/api/settings/advanced', async (req, res) => {
  try {
    res.json(await sf.applyAdvancedGameSettings(req.body as Record<string, string>));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as settingsRouter };
