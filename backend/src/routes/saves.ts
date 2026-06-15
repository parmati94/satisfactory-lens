import { Router } from 'express';
import * as sf from '../api/sfClient';

const router = Router();

router.get('/api/saves', async (_req, res) => {
  try {
    res.json(await sf.enumerateSessions());
  } catch (err) {
    console.error('[saves] enumerateSessions failed:', (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

router.post('/api/saves/load', async (req, res) => {
  const { sessionName, saveName, enableAdvancedGameSettings } = req.body as {
    sessionName?: string;
    saveName?: string;
    enableAdvancedGameSettings?: boolean;
  };
  if (!sessionName || !saveName) {
    res.status(400).json({ error: 'sessionName and saveName are required' });
    return;
  }
  try {
    const result = await sf.loadGame(sessionName, saveName, enableAdvancedGameSettings ?? false);
    console.log(`[saves] LoadGame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    console.error('[saves] LoadGame failed:', (err as Error).message);
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
    const result = await sf.saveGame(saveName);
    console.log(`[saves] SaveGame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    console.error('[saves] SaveGame failed:', (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

router.delete('/api/saves/:saveName', async (req, res) => {
  const { saveName } = req.params;
  try {
    const result = await sf.deleteSavegame(saveName);
    console.log(`[saves] DeleteSavegame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    console.error('[saves] DeleteSavegame failed:', (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as savesRouter };
