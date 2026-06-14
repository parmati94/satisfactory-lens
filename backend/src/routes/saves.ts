import { Router } from 'express';
import * as sf from '../api/sfClient';

const router = Router();

router.get('/api/saves', async (_req, res) => {
  try {
    res.json(await sf.enumerateSessions());
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.post('/api/saves/load', async (req, res) => {
  const { sessionName, saveName } = req.body as {
    sessionName?: string;
    saveName?: string;
  };
  if (!sessionName || !saveName) {
    res.status(400).json({ error: 'sessionName and saveName are required' });
    return;
  }
  try {
    res.json(await sf.loadGame(sessionName, saveName));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

router.post('/api/saves/save', async (req, res) => {
  const { saveName } = req.body as { saveName?: string };
  if (!saveName) {
    res.status(400).json({ error: 'saveName is required' });
    return;
  }
  try {
    res.json(await sf.saveGame(saveName));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as savesRouter };
