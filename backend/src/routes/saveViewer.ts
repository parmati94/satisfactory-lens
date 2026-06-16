import { Router, Request, Response } from 'express';
import { config } from '../config';
import { getSave, getSaveStatus } from '../save/saveState';
import { loadFromApi, loadLatest, getSaveSourceMode } from '../save/loader';
import {
  addSseClient,
  removeSseClient,
  broadcastSaveReloaded,
  startWatching,
  getWatchedPath,
  checkForNewerSave,
} from '../save/watcher';
import { extractPlayers } from '../save/extractors/players';
import { extractBuildings } from '../save/extractors/buildings';
import { extractResources } from '../save/extractors/resources';
import { extractPower } from '../save/extractors/power';
import { extractResourceNodes } from '../save/extractors/resourceNodes';
import { extractMapPins } from '../save/extractors/mapPins';
import { extractStorage } from '../save/extractors/storage';
import { extractBuildingFootprints } from '../save/extractors/buildingFootprints';

const router = Router();

/** Full status payload: parser state + active mode + newer-save-available info. */
async function fullStatus() {
  return {
    ...getSaveStatus(),
    mode: getSaveSourceMode(),
    watchedPath: getWatchedPath(),
    pollIntervalSeconds: config.savePollIntervalSeconds,
    ...(await checkForNewerSave()),
  };
}

// GET /api/save/status
router.get('/api/save/status', async (_req, res) => {
  res.json(await fullStatus());
});

// POST /api/save/reload — reload from whichever source is active (mount, else API)
router.post('/api/save/reload', async (_req, res) => {
  await loadLatest();
  const status = getSaveStatus();
  if (status.loaded) {
    broadcastSaveReloaded({ sourceName: status.sourceName });
  }
  res.json(await fullStatus());
});

// POST /api/save/download — download a specific save by name from the SF API and parse it
router.post('/api/save/download', async (req, res) => {
  const { saveName, saveDateTime } = req.body as { saveName?: string; saveDateTime?: string };
  if (!saveName) {
    res.status(400).json({ error: 'saveName is required' });
    return;
  }
  await loadFromApi(saveName, saveDateTime ?? null);
  const status = getSaveStatus();
  if (status.loaded) {
    broadcastSaveReloaded({ sourceName: status.sourceName });
  }
  res.json(await fullStatus());
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
  fullStatus().then((status) => {
    res.write(`data: ${JSON.stringify({ event: 'connected', ...status })}\n\n`);
  });

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


// GET /api/save/resource-nodes
router.get('/api/save/resource-nodes', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractResourceNodes(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/storage
router.get('/api/save/storage', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json({ containers: extractStorage(save) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/map-pins — hub position + player-placed map stamps
router.get('/api/save/map-pins', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractMapPins(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/building-footprints — lean, map-specific building data (type
// table + flat parallel instance arrays) for the WebGL factory overlay.
// Deliberately not the same shape as /api/save/buildings (tab UI) — that one
// nests full instance arrays per type, which is the wrong shape and far too
// heavy a payload at tens of thousands of instances.
router.get('/api/save/building-footprints', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json(extractBuildingFootprints(save));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/debug/type-paths?filter=Resource — dev diagnostic, lists unique typePaths
router.get('/api/save/debug/type-paths', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  const filter = ((_req as any).query.filter as string ?? '').toLowerCase();
  const counts = new Map<string, number>();
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (filter && !obj.typePath.toLowerCase().includes(filter)) continue;
      counts.set(obj.typePath, (counts.get(obj.typePath) ?? 0) + 1);
    }
  }
  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([typePath, count]) => ({ typePath, count }));
  res.json(sorted);
});

// GET /api/save/debug/node-sample — inspect first BP_ResourceNode to find property layout
router.get('/api/save/debug/node-sample', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  for (const level of Object.values(save.levels)) {
    for (const obj of level.objects) {
      if (obj.typePath !== '/Game/FactoryGame/Resource/BP_ResourceNode.BP_ResourceNode_C') continue;
      res.json({
        typePath: obj.typePath,
        instanceName: obj.instanceName,
        objectType: (obj as any).type ?? (obj as any).saveType ?? 'unknown',
        hasTransform: !!(obj as any).transform,
        propertyKeys: Object.keys((obj as any).properties ?? {}),
        mResourceClass: (obj as any).properties?.['mResourceClass'],
        mPurity: (obj as any).properties?.['mPurity'],
      });
      return;
    }
  }
  res.json({ error: 'No BP_ResourceNode found' });
});

export { router as saveViewerRouter };
