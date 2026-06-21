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
import { extractPower } from '../save/extractors/power';
import { extractResourceNodes } from '../save/extractors/resourceNodes';
import { extractMapPins } from '../save/extractors/mapPins';
import { extractStorage, extractCentralStorage } from '../save/extractors/storage';
import { extractBuildingFootprints } from '../save/extractors/buildingFootprints';
import { extractMachineInstances } from '../save/extractors/machines';
import { getFogPng } from '../save/extractors/fogOfWar';
import { persistEdits, type SaveEdit } from '../save/editor';
import { groundZ } from '../save/worldHeight';
import { extractPurchasedSchematics } from '../save/extractors/schematics';
import { extractGamePhase } from '../save/extractors/gamePhase';
import { readFileSync } from 'fs';
import { join } from 'path';

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


// GET /api/save/machine-instances?class=Build_ConstructorMk1
// On-demand per-type machine detail (recipe/clock/boost/rate + buffer contents)
// for the Buildings tab's per-instance rows — never shipped in bulk.
router.get('/api/save/machine-instances', (req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  const buildClass = (req.query.class as string ?? '').trim();
  if (!buildClass) { res.status(400).json({ error: 'Missing class query param' }); return; }
  try {
    res.json(extractMachineInstances(save, buildClass));
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
    res.json({ containers: extractStorage(save), depot: extractCentralStorage(save) });
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

// GET /api/save/fog.png — the player's discovered-area mask as a transparent
// PNG (opaque black where never explored). 512×512; Leaflet scales it up over
// the map bounds. 404 when the save carries no fog-of-war data. Cache-busted by
// the caller via a ?v= query param, so it's fine to mark immutable.
router.get('/api/save/fog.png', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    const png = getFogPng(save);
    if (!png) { res.status(404).json({ error: 'No fog-of-war data in save' }); return; }
    res.type('png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(png);
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

// GET /api/world/ground-height?x=&y= — terrain surface Z (cm) at a world point,
// for the teleport "snap to ground" helper. Static (not save-dependent).
router.get('/api/world/ground-height', (req, res) => {
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).json({ error: 'x and y are required' });
    return;
  }
  const z = groundZ(x, y);
  if (z === null) { res.status(404).json({ error: 'Outside world bounds' }); return; }
  res.json({ z: Math.round(z) });
});

// GET /api/items — static item catalog (class → { path, name, stack }) for the
// inventory editor's item picker. Loaded once and cached for the process.
let _itemCatalog: unknown = null;
router.get('/api/items', (_req, res) => {
  if (!_itemCatalog) {
    try {
      _itemCatalog = JSON.parse(readFileSync(join(__dirname, '../../data/items.json'), 'utf-8'));
    } catch {
      _itemCatalog = {};
    }
  }
  res.json(_itemCatalog);
});

// GET /api/schematics — static schematic catalog (progression tree) for the editor.
let _schematicCatalog: unknown = null;
router.get('/api/schematics', (_req, res) => {
  if (!_schematicCatalog) {
    try {
      _schematicCatalog = JSON.parse(readFileSync(join(__dirname, '../../data/schematics.json'), 'utf-8'));
    } catch {
      _schematicCatalog = [];
    }
  }
  res.json(_schematicCatalog);
});

// GET /api/save/schematics — which schematics are purchased (unlocked) in the loaded save.
router.get('/api/save/schematics', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json({ purchased: extractPurchasedSchematics(save) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/save/game-phase — current Project Assembly phase + edit target.
router.get('/api/save/game-phase', (_req, res) => {
  const save = getSave();
  if (!save) { res.status(404).json({ error: 'No save loaded' }); return; }
  try {
    res.json({ phase: extractGamePhase(save) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/save/edit/persist — apply staged edits to the in-memory save and
// persist (upload to the server, optionally loading live; or write to the mount).
router.post('/api/save/edit/persist', async (req, res) => {
  const { saveName, mode, edits } = req.body as {
    saveName?: string;
    mode?: string;
    edits?: SaveEdit[];
  };
  if (!saveName) { res.status(400).json({ error: 'saveName is required' }); return; }
  if (mode !== 'copy' && mode !== 'load') { res.status(400).json({ error: 'mode must be "copy" or "load"' }); return; }
  if (!Array.isArray(edits) || edits.length === 0) { res.status(400).json({ error: 'No edits provided' }); return; }

  try {
    const result = await persistEdits({ saveName, mode, edits });
    // If we loaded the edited save live (or overwrote the loaded one), the
    // viewer's active save changed — let other clients refresh too.
    if (mode === 'load') {
      broadcastSaveReloaded({ sourceName: getSaveStatus().sourceName });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    // persistEdits never mutates the loaded save in place, so nothing to roll back.
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
