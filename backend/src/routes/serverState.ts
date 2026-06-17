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

// Liveness + measured Lens→SF round-trip latency (ms). The HealthCheck call is
// the cheapest authenticated-free ping, so timing it gives the server latency
// shown in the Server panel's Overview tab.
router.get('/api/server/health', async (_req, res) => {
  try {
    const started = Date.now();
    const health = (await sf.healthCheck()) as Record<string, unknown>;
    const latencyMs = Date.now() - started;
    res.json({ ...health, latencyMs });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export { router as serverStateRouter };
