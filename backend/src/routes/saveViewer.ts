import { Router, Request, Response } from 'express';
import { getSave, getSaveStatus } from '../save/saveState';
import { loadFromDisk, loadFromApi } from '../save/loader';
import {
  addSseClient,
  removeSseClient,
  broadcastSaveReloaded,
  startWatching,
  getWatchedPath,
} from '../save/watcher';
import { extractPlayers } from '../save/extractors/players';
import { extractBuildings } from '../save/extractors/buildings';
import { extractResources } from '../save/extractors/resources';
import { extractPower } from '../save/extractors/power';

const router = Router();

// GET /api/save/status
router.get('/api/save/status', (_req, res) => {
  res.json({
    ...getSaveStatus(),
    watchedPath: getWatchedPath(),
  });
});

// POST /api/save/reload — reload from disk mount
router.post('/api/save/reload', async (_req, res) => {
  await loadFromDisk();
  const status = getSaveStatus();
  if (status.loaded) {
    broadcastSaveReloaded({ sourceName: status.sourceName });
  }
  res.json(getSaveStatus());
});

// POST /api/save/download — download from SF API and parse
router.post('/api/save/download', async (req, res) => {
  const { saveName } = req.body as { saveName?: string };
  if (!saveName) {
    res.status(400).json({ error: 'saveName is required' });
    return;
  }
  await loadFromApi(saveName);
  const status = getSaveStatus();
  if (status.loaded) {
    broadcastSaveReloaded({ sourceName: status.sourceName });
  }
  res.json(getSaveStatus());
});

// POST /api/save/watch — start/restart file watching
router.post('/api/save/watch', (_req, res) => {
  startWatching();
  res.json({ ok: true, watchedPath: getWatchedPath() });
});

// GET /api/save/events — SSE stream for save reload events
router.get('/api/save/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Initial status ping
  res.write(`data: ${JSON.stringify({ event: 'connected', ...getSaveStatus() })}\n\n`);

  const keepalive = setInterval(() => res.write(':\n\n'), 25000);

  addSseClient(res);

  req.on('close', () => {
    clearInterval(keepalive);
    removeSseClient(res);
  });
});

// GET /api/save/players
router.get('/api/save/players', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json({ players: extractPlayers(save) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/buildings
router.get('/api/save/buildings', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractBuildings(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/resources
router.get('/api/save/resources', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractResources(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/power
router.get('/api/save/power', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractPower(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});


export { router as saveViewerRouter };
