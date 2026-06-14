import { Router } from 'express';
import * as sf from '../api/sfClient';

const router = Router();

router.get('/api/server/state', async (_req, res) => {
  try {
    res.json(await sf.queryServerState());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.get('/api/server/health', async (_req, res) => {
  try {
    res.json(await sf.healthCheck());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as serverStateRouter };
