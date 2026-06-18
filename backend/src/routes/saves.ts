import { Router } from 'express';
import * as sf from '../api/sfClient';
import { childLogger } from '../log';

const router = Router();
const log = childLogger('saves');

router.get('/api/saves', async (_req, res) => {
  try {
    res.json(await sf.enumerateSessions());
  } catch (err) {
    log.error(`enumerateSessions failed: ${(err as Error).message}`);
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
    log.info(`LoadGame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    log.error(`LoadGame failed: ${(err as Error).message}`);
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
    log.info(`SaveGame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    log.error(`SaveGame failed: ${(err as Error).message}`);
    res.status(502).json({ error: (err as Error).message });
  }
});

router.delete('/api/saves/:saveName', async (req, res) => {
  const { saveName } = req.params;
  try {
    const result = await sf.deleteSavegame(saveName);
    log.info(`DeleteSavegame "${saveName}" accepted`);
    res.json(result);
  } catch (err) {
    log.error(`DeleteSavegame failed: ${(err as Error).message}`);
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as savesRouter };
