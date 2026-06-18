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

// The Satisfactory dedicated-server API treats ApplyAdvancedGameSettings as a
// one-way ratchet: it enables settings but silently ignores any attempt to turn
// one back off (returns 204 either way). So we apply, immediately re-read the
// authoritative state, and report which requested keys the server refused —
// turning the silent no-op into an honest result the UI can surface. The only
// way to disable these on a live save is the in-game Esc → Advanced menu.
router.patch('/api/settings/advanced', async (req, res) => {
  try {
    const intended = req.body as Record<string, string>;
    await sf.applyAdvancedGameSettings(intended);
    const settings = (await sf.getAdvancedGameSettings()) as {
      creativeModeEnabled?: boolean;
      advancedGameSettings?: Record<string, string>;
    };
    const applied = settings.advancedGameSettings ?? {};
    const refused = Object.keys(intended).filter(
      (key) => String(applied[key]) !== String(intended[key]),
    );
    res.json({ settings, refused });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as settingsRouter };
